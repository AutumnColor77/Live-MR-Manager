use once_cell::sync::Lazy;
use parking_lot::Mutex;
use rodio::{Decoder, Source};
use rodio::source::UniformSourceIterator;
use serde::{Deserialize, Serialize};
use cpal::traits::{HostTrait, DeviceTrait};
use std::fs::File;
use std::io::BufReader;
use std::num::{NonZeroU16, NonZeroU32};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tauri::{async_runtime, Emitter, Manager, WebviewWindow, AppHandle};
use tauri::path::BaseDirectory;
use std::process::Command;

mod youtube;
mod model_manager;
pub mod vocal_remover;
pub mod audio_player;

use crate::youtube::YoutubeManager;
use crate::model_manager::ModelManager;
pub use crate::vocal_remover::{InferenceEngine, WaveformRemover};
use urlencoding;
use crate::audio_player::{
    AUDIO_HANDLER, Status, PlaybackStatus, PlaybackProgress,
    AppState, StreamingReader, StretchedSource, DynamicVolumeSource,
    CANCEL_REQUESTS, sys_log, MAIN_WINDOW
};
use ort::execution_providers::{ExecutionProvider, CUDAExecutionProvider, CPUExecutionProvider, DirectMLExecutionProvider};
use symphonia::core::formats::FormatOptions;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::io::MediaSourceStream;
use symphonia::core::probe::Hint;


// --- AI Engine ---
static ROFORMER_ENGINE: Lazy<Mutex<Option<Arc<dyn InferenceEngine>>>> = Lazy::new(|| Mutex::new(None));
static AI_QUEUE_LOCK: Lazy<tokio::sync::Mutex<()>> = Lazy::new(|| tokio::sync::Mutex::new(()));
static PLAYBACK_VERSION: AtomicU64 = AtomicU64::new(0);


// --- Streaming Support ---
// Audio processing types and handlers have been moved to audio_player.rs

// AppState, Status, PlaybackStatus, etc. are now imported from audio_player.rs
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SongMetadata {
    pub title: String,
    pub thumbnail: String,
    pub duration: String,
    pub source: String,
    pub path: String,
    pub pitch: Option<f32>,
    pub tempo: Option<f32>,
    pub volume: Option<f32>,
    pub artist: Option<String>,
    pub tags: Option<Vec<String>>,
    pub category: Option<String>,
    pub play_count: Option<u32>,
    pub date_added: Option<u64>,
    pub is_mr: Option<bool>,
}

#[tauri::command]
async fn play_track(window: WebviewWindow, path: String, duration_ms: Option<u64>) -> Result<(), String> {
    let res = play_track_internal(window.clone(), path, duration_ms, None).await;
    if let Err(ref e) = res {
        let _ = window.emit("playback-status", PlaybackStatus { status: Status::Error, message: e.clone() });
    }
    res
}

async fn play_track_internal(window: WebviewWindow, path: String, duration_ms_hint: Option<u64>, start_pos_ms: Option<u64>) -> Result<(), String> {
    let handler = match &*AUDIO_HANDLER {
        Ok(h) => h.clone(),
        Err(e) => return Err(e.clone()),
    };
    
    let target_version = PLAYBACK_VERSION.fetch_add(1, Ordering::SeqCst) + 1;
    sys_log(&format!("[DEBUG] play_track_internal Start: version={}, path={}, start_pos={:?}ms", target_version, path, start_pos_ms));
    
    struct PlaybackPreparationGuard;
    impl Drop for PlaybackPreparationGuard {
        fn drop(&mut self) {
            crate::audio_player::IS_PREPARING_PLAYBACK.store(false, Ordering::SeqCst);
        }
    }
    let _prep_guard = PlaybackPreparationGuard;
    crate::audio_player::IS_PREPARING_PLAYBACK.store(true, Ordering::SeqCst);
    
    // 1. Initial status - Only if not a seek (Silent Seek)
    if start_pos_ms.is_none() {
        window.emit("playback-status", PlaybackStatus { status: Status::Pending, message: "Preparing...".into() }).unwrap();
    }

    // 1. Immediate stop and reset
    {
        let controller = handler.controller.lock();
        controller.clear();
        sys_log("[DEBUG] Step 0: Controller cleared");
    }
    
    let rate = handler.track_sample_rate.load(Ordering::Relaxed) as f64;
    let start_samples = if let Some(ms) = start_pos_ms {
        (ms as f64 * rate / 1000.0) as u64
    } else {
        0
    };
    handler.current_pos_samples.store(start_samples, Ordering::Relaxed);
    
    // Set initial duration from hint immediately to avoid zero-flicker and fix FLAC/VBR finished detection
    if let Some(d) = duration_ms_hint {
        handler.total_duration_ms.store(d, Ordering::Relaxed);
    } else {
        handler.total_duration_ms.store(0, Ordering::Relaxed);
    }
    
    // 2. Metadata and path setup
    let app_dir = window.app_handle().path().app_local_data_dir().expect("Failed app dir");
    let cache_key = urlencoding::encode(&path).to_string();
    let cache_dir = app_dir.join("cache").join("separated").join(&cache_key);
    let vocal_path = cache_dir.join("vocal.wav");
    let inst_path = cache_dir.join("inst.wav");
    
    // Setup pipeline basic info for skip-path and fallback-path
    let target_rate = handler.active_sample_rate;
    let target_channels = handler.active_channels;
    let target_rate_nz = NonZeroU32::new(target_rate).expect("Invalid sample rate");
    let target_channels_nz = NonZeroU16::new(target_channels).expect("Invalid channels");

    // NEW LOGIC: Check for separated MR files first to avoid unnecessary network/file checks
    if vocal_path.exists() && inst_path.exists() {
        sys_log(&format!("Playing (Cached): {} (Device: {}Hz, {}ch)", path, target_rate, target_channels));
        
        // Separated paths - PLAY IMMEDIATELY
        let v_file = File::open(vocal_path).map_err(|e| e.to_string())?;
        let i_file = File::open(inst_path).map_err(|e| e.to_string())?;
        
        let mut v_decoder = Decoder::new(BufReader::new(v_file)).map_err(|e| e.to_string())?;
        let mut i_decoder = Decoder::new(BufReader::new(i_file)).map_err(|e| e.to_string())?;
        
        handler.track_sample_rate.store(v_decoder.sample_rate().into(), Ordering::Relaxed);

        if let Some(ms) = start_pos_ms {
            let _ = v_decoder.try_seek(Duration::from_millis(ms));
            let _ = i_decoder.try_seek(Duration::from_millis(ms));
        }
        
        if let Some(d) = i_decoder.total_duration() {
            handler.total_duration_ms.store(d.as_millis() as u64, Ordering::Relaxed);
        }

        let stretched_v = StretchedSource::new(v_decoder, handler.active_pitch.clone(), handler.active_tempo.clone(), Arc::new(AtomicU64::new(0)));
        let stretched_i = StretchedSource::new(i_decoder, handler.active_pitch.clone(), handler.active_tempo.clone(), handler.current_pos_samples.clone());
        
        let resampled_v = UniformSourceIterator::new(DynamicVolumeSource { input: stretched_v, volume: handler.vocal_volume.clone() }, target_channels_nz, target_rate_nz);
        let resampled_i = UniformSourceIterator::new(DynamicVolumeSource { input: stretched_i, volume: handler.instrumental_volume.clone() }, target_channels_nz, target_rate_nz);

        let mixed = resampled_i.mix(resampled_v);
        
        let final_v = PLAYBACK_VERSION.load(Ordering::SeqCst);
        if final_v != target_version { return Ok(()); }
        
        {
            let controller = handler.controller.lock();
            controller.append(mixed);
            controller.play();
        }

        {
            let mut state = handler.state.lock();
            state.current_track = Some(path.clone());
            state.is_playing = true;
        }
        
        window.emit("playback-status", PlaybackStatus { status: Status::Playing, message: "Playing".into() }).unwrap();
        sys_log("[DEBUG] Starting instantaneous playback from local MR cache.");
        return Ok(());
    }

    // [FALLBACK] If MR doesn't exist, resolve the play_path (YouTube or Local)
    let play_path = if path.starts_with("http") {
        if start_pos_ms.is_none() {
            window.emit("playback-status", PlaybackStatus { 
                status: Status::Downloading, 
                message: "유튜브 오디오 다운로드 중...".to_string() 
            }).ok();
        }
        
        let metadata = YoutubeManager::get_video_metadata(&path).await?;
        let temp_dir = std::env::temp_dir();
        let final_path = temp_dir.join(format!("yt_{}.m4a", metadata.id.unwrap_or_else(|| "unknown".into())));
        
        if !final_path.exists() {
            YoutubeManager::download_audio(&window, &path, final_path.clone()).await?;
        }
        final_path
    } else {
        if start_pos_ms.is_none() {
            window.emit("playback-status", PlaybackStatus { 
                status: Status::Decoding, 
                message: "파일 읽기 및 디코딩 중...".to_string() 
            }).ok();
        }
        std::path::PathBuf::from(&path)
    };

    if !play_path.exists() && !path.starts_with("http") {
        return Err("File not found".into());
    }

    sys_log(&format!("Playing original/mono: {} (Device: {}Hz, {}ch)", path, target_rate, target_channels));

    let is_yt = path.starts_with("http");
    let reader = StreamingReader::new(play_path.clone(), is_yt).map_err(|e: std::io::Error| format!("Failed to open stream: {}", e))?;
    let mut decoder = rodio::Decoder::new(std::io::BufReader::new(reader)).map_err(|e: rodio::decoder::DecoderError| e.to_string())?;
    
    handler.track_sample_rate.store(decoder.sample_rate().into(), Ordering::Relaxed);
    
    if let Some(ms) = start_pos_ms {
        let _ = decoder.try_seek(Duration::from_millis(ms));
    }
    
    if let Some(d) = decoder.total_duration() {
        handler.total_duration_ms.store(d.as_millis() as u64, Ordering::Relaxed);
    }

    let stretched = StretchedSource::new(decoder, handler.active_pitch.clone(), handler.active_tempo.clone(), handler.current_pos_samples.clone());
    let dyn_vol = DynamicVolumeSource { input: stretched, volume: handler.instrumental_volume.clone() };
    let resampled = UniformSourceIterator::new(dyn_vol, target_channels_nz, target_rate_nz);
    
    let final_v = PLAYBACK_VERSION.load(Ordering::SeqCst);
    if final_v != target_version { return Ok(()); }
    
    {
        let controller = handler.controller.lock();
        controller.append(resampled);
        controller.play();
    }
    
    {
        let mut state = handler.state.lock();
        state.current_track = Some(path.clone());
        state.is_playing = true;
    }
    
    window.emit("playback-status", PlaybackStatus { status: Status::Playing, message: "Playing".into() }).unwrap();
    sys_log("[DEBUG] Starting playback (Original/Mono)");
    Ok(())
}

#[tauri::command]
fn set_master_volume(volume: f32) -> Result<(), String> {
    if let Ok(handler) = &*AUDIO_HANDLER {
        let controller = handler.controller.lock();
        controller.set_volume(volume / 100.0);
    }
    Ok(())
}

#[tauri::command]
async fn toggle_playback() -> Result<bool, String> {
    let handler = AUDIO_HANDLER.as_ref().map_err(|e| e.clone())?.clone();
    let is_playing = {
        let controller = handler.controller.lock();
        if controller.is_paused() {
            controller.play();
            true
        } else {
            controller.pause();
            false
        }
    };
    Ok(is_playing)
}

#[tauri::command]
async fn set_volume(volume: f64) -> Result<(), String> {
    let handler = AUDIO_HANDLER.as_ref().map_err(|e| e.clone())?.clone();
    let v_enabled = {
        let state = handler.state.lock();
        state.vocal_enabled
    };
    
    let v_vol = if v_enabled { volume as f32 } else { 0.0 };
    handler.vocal_volume.store(v_vol.to_bits(), Ordering::Relaxed);
    handler.instrumental_volume.store((volume as f32).to_bits(), Ordering::Relaxed);
    Ok(())
}

#[tauri::command]
async fn set_vocal_balance(balance: f64) -> Result<(), String> {
    let handler = AUDIO_HANDLER.as_ref().map_err(|e| e.clone())?.clone();
    // balance: 0 (inst only) to 100 (vocal only)
    let b = balance as f32;
    let v_vol = b;
    let i_vol = 100.0 - b;
    handler.vocal_volume.store(v_vol.to_bits(), Ordering::Relaxed);
    handler.instrumental_volume.store(i_vol.to_bits(), Ordering::Relaxed);
    Ok(())
}

#[tauri::command]
async fn set_pitch(semitones: f64) -> Result<(), String> {
    let handler = AUDIO_HANDLER.as_ref().map_err(|e| e.clone())?.clone();
    handler.active_pitch.store((semitones as f32).to_bits(), Ordering::Relaxed);
    Ok(())
}

#[tauri::command]
async fn set_tempo(ratio: f64) -> Result<(), String> {
    let handler = AUDIO_HANDLER.as_ref().map_err(|e| e.clone())?.clone();
    handler.active_tempo.store((ratio as f32).to_bits(), Ordering::Relaxed);
    Ok(())
}

#[tauri::command]
async fn seek_to(position_ms: u64) -> Result<(), String> {
    let handler = AUDIO_HANDLER.as_ref().map_err(|e| e.clone())?.clone();
    
    // Get current track path and duration hint to recreate the pipeline
    let (path, duration_ms) = {
        let state = handler.state.lock();
        let path = state.current_track.clone();
        let duration = handler.total_duration_ms.load(Ordering::Relaxed);
        (path, duration)
    };

    if let Some(p) = path {
        let window_opt = { MAIN_WINDOW.lock().clone() };
        
        if let Some(window) = window_opt {
            sys_log(&format!("[AUDIO] Seek request received: {}ms for {}", position_ms, p));
            // Re-run play_track_internal from the new start position
            let p_clone = p.clone();
            
            // Execute directly and await to ensure completion
            // The lock is already dropped here, so it's safe to await
            let res = play_track_internal(window, p_clone, Some(duration_ms), Some(position_ms)).await;
            if let Err(e) = res {
                sys_log(&format!("[DEBUG] play_track_internal failed during seek: {}", e));
            }
            
            sys_log(&format!("[AUDIO] Seek completed: {}ms", position_ms));
        } else {
             sys_log("[DEBUG] Seek failed: MAIN_WINDOW is None");
        }
    } else {
        sys_log("[DEBUG] Seek failed: No current track path available");
    }
    
    Ok(())
}

#[tauri::command]
async fn toggle_ai_feature(feature: String, enabled: bool) -> Result<(), String> {
    if let Ok(handler) = &*AUDIO_HANDLER {
        let mut state = handler.state.lock();
        match feature.as_str() {
            "vocal" => {
                state.vocal_enabled = enabled;
                let current_vol = f32::from_bits(handler.instrumental_volume.load(Ordering::Relaxed));
                let target_v_vol = if enabled { current_vol } else { 0.0 };
                handler.vocal_volume.store(target_v_vol.to_bits(), Ordering::Relaxed);
            },
            "lyric" => state.lyric_enabled = enabled,
            _ => {}
        }
    }
    Ok(())
}

#[tauri::command]
async fn check_mr_separated(window: WebviewWindow, path: String) -> Result<bool, String> {
    let app_dir = window.app_handle().path().app_local_data_dir().expect("Failed app dir");
    let cache_key = urlencoding::encode(&path).to_string();
    let cache_dir = app_dir.join("cache").join("separated").join(&cache_key);
    let vocal_path = cache_dir.join("vocal.wav");
    let inst_path = cache_dir.join("inst.wav");
    Ok(vocal_path.exists() && inst_path.exists())
}

#[tauri::command]
async fn delete_mr(window: WebviewWindow, path: String) -> Result<(), String> {
    let app_dir = window.app_handle().path().app_local_data_dir().expect("Failed app dir");
    let cache_key = urlencoding::encode(&path).to_string();
    let cache_dir = app_dir.join("cache").join("separated").join(&cache_key);
    if cache_dir.exists() {
        std::fs::remove_dir_all(cache_dir).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
async fn get_youtube_metadata(url: String) -> Result<SongMetadata, String> {
    let metadata_res = YoutubeManager::get_video_metadata(&url).await;
    let (title, thumbnail, duration, artist) = match metadata_res {
        Ok(m) => {
            let d = {
                let secs = m.duration.unwrap_or(0.0) as u64;
                format!("{}:{:02}", secs / 60, secs % 60)
            };
            (m.title.unwrap_or_else(|| "Unknown YouTube Video".into()), m.thumbnail.unwrap_or_default(), d, m.uploader)
        },
        Err(e) => {
            println!("DEBUG: [Youtube] Metadata fetch failed for {}: {}", url, e);
            ("Unknown YouTube Video".into(), "".into(), "0:00".into(), None)
        }
    };

    Ok(SongMetadata {
        title,
        thumbnail,
        duration,
        source: "youtube".into(),
        path: url,
        pitch: Some(0.0),
        tempo: Some(1.0),
        volume: Some(80.0),
        artist,
        tags: None,
        category: None,
        play_count: Some(0),
        date_added: Some(std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs()),
        is_mr: Some(false),
    })
}

#[tauri::command]
async fn get_audio_metadata(path: String) -> Result<SongMetadata, String> {
    if path.starts_with("http") {
        let metadata_res = YoutubeManager::get_video_metadata(&path).await;
        let (title, thumbnail, duration, artist) = match metadata_res {
            Ok(m) => {
                let d = {
                    let secs = m.duration.unwrap_or(0.0) as u64;
                    format!("{}:{:02}", secs / 60, secs % 60)
                };
                (m.title.unwrap_or_else(|| "Unknown YouTube Video".into()), m.thumbnail.unwrap_or_default(), d, Some(m.id.unwrap_or_default()))
            },
            Err(_) => ("Unknown YouTube Video".into(), "".into(), "0:00".into(), Some("unknown".into()))
        };

        return Ok(SongMetadata {
            title,
            thumbnail,
            duration,
            source: "youtube".into(),
            path: path.clone(),
            pitch: Some(0.0),
            tempo: Some(1.0),
            volume: Some(80.0),
            artist,
            tags: None,
            category: None,
            play_count: Some(0),
            date_added: Some(std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs()),
            is_mr: Some(false),
        });
    }

    let file_path = std::path::Path::new(&path);
    let file_name = file_path.file_name().unwrap_or_default().to_string_lossy().to_string();
    
    // Improved duration extraction using symphonia (handles MP3 VBR etc better)
    let duration_str = match probe_audio_duration(&path) {
        Some(d) => d,
        None => "0:00".into(),
    };
    
    Ok(SongMetadata {
        title: file_name,
        thumbnail: "".into(),
        duration: duration_str,
        source: "local".into(),
        path: path.clone(),
        pitch: Some(0.0),
        tempo: Some(1.0),
        volume: Some(80.0),
        artist: None,
        tags: None,
        category: None,
        play_count: Some(0),
        date_added: Some(std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs()),
        is_mr: Some(false),
    })
}


#[tauri::command]
async fn stop_playback() -> Result<(), String> {
    if let Ok(handler) = &*AUDIO_HANDLER {
        let controller = handler.controller.lock();
        controller.clear();
        let mut state = handler.state.lock();
        state.is_playing = false;
        state.current_track = None;
    }
    Ok(())
}

#[tauri::command]
async fn get_playback_state() -> Result<AppState, String> {
    if let Ok(handler) = &*AUDIO_HANDLER {
        Ok(handler.state.lock().clone())
    } else {
        Ok(AppState::default())
    }
}

#[tauri::command]
async fn check_ai_runtime() -> Result<Vec<String>, String> {
    let mut providers = Vec::new();
    if CUDAExecutionProvider::default().is_available().unwrap_or(false) {
        providers.push("CUDA".to_string());
    }
    if CPUExecutionProvider::default().is_available().unwrap_or(false) {
        providers.push("CPU".to_string());
    }
    Ok(providers)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GpuStatus {
    pub has_nvidia: bool,
    pub is_cuda_available: bool,
    pub is_directml_available: bool,
    pub recommend_cuda: bool,
}

#[tauri::command]
async fn get_gpu_recommendation() -> Result<GpuStatus, String> {
    let mut has_nvidia = false;
    
    // 1. Detect Hardware (NVIDIA) - Windows implementation
    #[cfg(target_os = "windows")]
    {
        if let Ok(output) = Command::new("wmic")
            .args(["path", "win32_VideoController", "get", "name"])
            .output() {
            let stdout = String::from_utf8_lossy(&output.stdout).to_uppercase();
            if stdout.contains("NVIDIA") {
                has_nvidia = true;
            }
            sys_log(&format!("[GPU-CHECK] Detected Hardware Output: {}", stdout.trim()));
        }
    }

    // 2. Check Execution Providers
    let is_cuda_available = CUDAExecutionProvider::default().is_available().unwrap_or(false);
    let is_directml_available = DirectMLExecutionProvider::default().is_available().unwrap_or(false);

    sys_log(&format!("[GPU-CHECK] has_nvidia: {}, cuda_available: {}, directml_available: {}", 
        has_nvidia, is_cuda_available, is_directml_available));

    // 3. Recommendation logic
    let recommend_cuda = has_nvidia && !is_cuda_available;
    
    if recommend_cuda {
        sys_log("[GPU-CHECK] RESULT: RECOMMENDATION BANNER SHOULD BE VISIBLE.");
    } else {
        sys_log("[GPU-CHECK] RESULT: BANNER HIDDEN (Either no NVIDIA or CUDA is already OK).");
    }

    Ok(GpuStatus {
        has_nvidia,
        is_cuda_available,
        is_directml_available,
        recommend_cuda,
    })
}

#[tauri::command]
async fn check_model_ready(handle: AppHandle) -> bool {
    let manager = ModelManager::new(&handle);
    if let Ok(res_path) = handle.path().resolve("resources/Kim_Vocal_2.onnx", BaseDirectory::Resource) {
        if res_path.exists() { return true; }
    }
    manager.get_model_path("Kim_Vocal_2.onnx").exists()
}

#[tauri::command]
async fn download_ai_model(window: WebviewWindow) -> Result<(), String> {
    let app_handle = window.app_handle();
    let manager = ModelManager::new(app_handle);
    window.emit("playback-status", PlaybackStatus { status: Status::Downloading, message: "AI 모델 다운로드 시작...".into() }).unwrap();
    let model_url = "https://huggingface.co/seanghay/uvr_models/resolve/main/Kim_Vocal_2.onnx";
    let _model_path = manager.ensure_model(app_handle, "Kim_Vocal_2.onnx", model_url).await?;
    window.emit("playback-status", PlaybackStatus { status: Status::Finished, message: "AI 모델 다운로드 완료".into() }).unwrap();
    Ok(())
}

#[tauri::command]
async fn delete_ai_model(window: WebviewWindow) -> Result<(), String> {
    let app_handle = window.app_handle();
    let manager = ModelManager::new(app_handle);
    let path = manager.get_model_path("Kim_Vocal_2.onnx");
    
    if path.exists() {
        std::fs::remove_file(path).map_err(|e| format!("모델 파일 삭제 실패: {}", e))?;
        
        // Reset loaded engine
        let mut engine_guard = ROFORMER_ENGINE.lock();
        *engine_guard = None;
        
        sys_log("[AI-ENGINE] Model deleted and engine reset.");
    }
    
    Ok(())
}

#[tauri::command]
async fn get_audio_devices() -> Result<Vec<String>, String> {
    let host = cpal::default_host();
    let devices = host.output_devices().map_err(|e| e.to_string())?;
    let mut names = Vec::new();
    for d in devices {
        if let Ok(desc) = d.description() {
            let config = d.default_output_config()
                .map(|c| format!("{}Hz, {}ch", u32::from(c.sample_rate()), c.channels()))
                .unwrap_or_else(|_| "Unknown Config".into());
            names.push(format!("{} ({})", desc.name(), config));
        }
    }
    Ok(names)
}

#[tauri::command]
async fn open_cache_folder(window: WebviewWindow) -> Result<(), String> {
    let app_dir = window.app_handle().path().app_local_data_dir().map_err(|e| e.to_string())?;
    let path = app_dir.join("cache").join("separated");
    if !path.exists() {
        std::fs::create_dir_all(&path).map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "windows")]
    {
        use std::process::Command;
        Command::new("explorer")
            .arg(path.to_string_lossy().to_string())
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SeparationProgress {
    path: String,
    percentage: f32,
    status: String,
    provider: String,
}

#[tauri::command]
async fn start_mr_separation(window: WebviewWindow, path: String) -> Result<(), String> {
    // 0. Ensure cancel state is clean for this path
    let normalized_path = path.replace("\\", "/").to_lowercase();
    CANCEL_REQUESTS.lock().remove(&normalized_path);

    let app_dir = window.app_handle().path().app_local_data_dir().expect("Failed app dir");
    let cache_key = urlencoding::encode(&path).to_string();
    let cache_dir = app_dir.join("cache").join("separated").join(&cache_key);

    let window_for_task = window.clone();
    let path_for_task = path.clone();

    // Return early and handle everything in a background task
    tauri::async_runtime::spawn(async move {
        // Step A: Load/Initialize Engine
        let engine = {
            let mut engine_guard = ROFORMER_ENGINE.lock();
            if engine_guard.is_none() {
                let model_path = {
                    let app_handle = window_for_task.app_handle();
                    let app_dir = app_handle.path().app_local_data_dir().expect("Failed app dir");
                    let p1 = app_dir.join("models").join("Kim_Vocal_2.onnx");
                    if p1.exists() { Some(p1) } else { None }
                };

                match model_path {
                    Some(p) => {
                        window_for_task.emit("playback-status", PlaybackStatus { status: Status::Downloading, message: "AI 모델 로딩 중...".into() }).ok();
                        match WaveformRemover::new(&p) {
                            Ok(remover) => {
                                *engine_guard = Some(Arc::new(remover));
                            }
                            Err(e) => {
                                sys_log(&format!("Model init error: {}", e));
                                window_for_task.emit("separation-progress", SeparationProgress {
                                    path: path_for_task.clone(),
                                    percentage: 0.0,
                                    status: "Error: 모델 초기화 실패".into(),
                                    provider: "SYSTEM".into(),
                                }).ok();
                                return;
                            }
                        }
                    },
                    None => {
                        window_for_task.emit("separation-progress", SeparationProgress {
                            path: path_for_task.clone(),
                            percentage: 0.0,
                            status: "Error: 모델 파일 없음".into(),
                            provider: "SYSTEM".into(),
                        }).ok();
                        return;
                    }
                }
            }
            engine_guard.as_ref().unwrap().clone()
        };

        // Step B: YouTube Download (if needed)
        let source_path_res = if path_for_task.starts_with("http") {
            window_for_task.emit("separation-progress", SeparationProgress {
                path: path_for_task.clone(),
                percentage: 0.0,
                status: "Downloading YouTube Audio...".into(),
                provider: "NETWORK".into(),
            }).ok();
            
            match YoutubeManager::get_video_metadata(&path_for_task).await {
                Ok(metadata) => {
                    let temp_dir = std::env::temp_dir();
                    let final_path = temp_dir.join(format!("yt_{}.m4a", metadata.id.unwrap_or_else(|| "unknown".into())));
                    
                    if !final_path.exists() {
                        match YoutubeManager::download_audio(&window_for_task, &path_for_task, final_path.clone()).await {
                            Ok(_) => Ok(final_path),
                            Err(e) => Err(e.to_string()),
                        }
                    } else {
                        Ok(final_path)
                    }
                },
                Err(e) => Err(e.to_string()),
            }
        } else {
            Ok(std::path::PathBuf::from(&path_for_task))
        };

        let source_path = match source_path_res {
            Ok(p) => {
                if !p.exists() {
                    window_for_task.emit("separation-progress", SeparationProgress {
                        path: path_for_task.clone(),
                        percentage: 0.0,
                        status: "Error: 소스 없음".into(),
                        provider: "SYSTEM".into(),
                    }).ok();
                    return;
                }
                p
            },
            Err(e) => {
                window_for_task.emit("separation-progress", SeparationProgress {
                    path: path_for_task.clone(),
                    percentage: 0.0,
                    status: format!("Error: {}", e).into(),
                    provider: "SYSTEM".into(),
                }).ok();
                return;
            }
        };

        // Step C: Queue the task and wait for lock (Sequential Processing)
        window_for_task.emit("separation-progress", SeparationProgress {
            path: path_for_task.clone(),
            percentage: 0.0,
            status: "Queued".into(),
            provider: engine.get_provider(),
        }).ok();

        // 3. Wait for Queue Lock (Only one separation at a time)
        let _permit = AI_QUEUE_LOCK.lock().await;

        // Task Start Emission (Now that we have the lock)
        window_for_task.emit("separation-progress", SeparationProgress {
            path: path_for_task.clone(),
            percentage: 0.0,
            status: "Starting".into(),
            provider: engine.get_provider(),
        }).ok();

        let window_clone = window_for_task.clone();
        let path_clone = path_for_task.clone();
        let cache_dir_for_move = cache_dir.clone();
        let engine_info = engine.get_provider();
        let engine_for_spawn = engine.clone();

        let result = async_runtime::spawn_blocking(move || -> Result<(), String> {
            let w = window_clone.clone();
            let p = path_clone.clone();
            let info = engine_info.clone();
            engine_for_spawn.separate(&source_path, &cache_dir_for_move, Box::new(move |percentage| {
                // Check for cancellation
                let normalized_p = p.replace("\\", "/").to_lowercase();
                if CANCEL_REQUESTS.lock().contains(&normalized_p) {
                    CANCEL_REQUESTS.lock().remove(&normalized_p);
                    return; 
                }
                let _ = w.emit("separation-progress", SeparationProgress {
                    path: p.clone(),
                    percentage,
                    status: "Processing".into(),
                    provider: info.clone(),
                });
            })).map_err(|e| e.to_string())?;
            Ok(())
        }).await;
        
        // Handle result
        match result {
            Ok(Ok(_)) => {
                window_for_task.emit("separation-progress", SeparationProgress {
                    path: path_for_task.clone(),
                    percentage: 100.0,
                    status: "Finished".into(),
                    provider: engine.get_provider(),
                }).ok();
                window_for_task.emit("playback-status", PlaybackStatus { status: Status::Finished, message: "Separation complete".into() }).ok();
            }
            Ok(Err(e)) => {
                let _ = std::fs::remove_dir_all(&cache_dir);
                if e.contains("Cancelled") {
                    window_for_task.emit("separation-progress", SeparationProgress {
                        path: path_for_task.clone(),
                        percentage: 0.0,
                        status: "Cancelled".into(),
                        provider: engine.get_provider(),
                    }).ok();
                } else {
                    window_for_task.emit("separation-progress", SeparationProgress {
                        path: path_for_task.clone(),
                        percentage: 0.0,
                        status: "Error".into(),
                        provider: engine.get_provider(),
                    }).ok();
                }
            }
            Err(e) => {
                let _ = std::fs::remove_dir_all(&cache_dir);
                window_for_task.emit("separation-progress", SeparationProgress {
                    path: path_for_task.clone(),
                    percentage: 0.0,
                    status: "Error".into(),
                    provider: engine.get_provider(),
                }).ok();
                sys_log(&format!("Task panic: {}", e));
            }
        }
    });

    Ok(())
}

#[tauri::command]
fn cancel_separation(path: String) {
    let normalized = path.replace("\\", "/").to_lowercase();
    sys_log(&format!("AI 분리 작업 취소 요청 (정규화): {}", normalized));
    CANCEL_REQUESTS.lock().insert(normalized);
}

#[tauri::command]
fn save_library(app: AppHandle, songs: Vec<SongMetadata>) -> Result<(), String> {
    let path = app.path().app_local_data_dir().map_err(|e| e.to_string())?.join("library.json");
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(&songs).map_err(|e| e.to_string())?;
    std::fs::write(path, json).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn load_library(app: AppHandle) -> Result<Vec<SongMetadata>, String> {
    let path = app.path().app_local_data_dir().map_err(|e| e.to_string())?.join("library.json");
    if !path.exists() {
        return Ok(Vec::new());
    }
    let json = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
    let songs = serde_json::from_str(&json).map_err(|e| e.to_string())?;
    Ok(songs)
}

fn probe_audio_duration(path: &str) -> Option<String> {
    let file = File::open(path).ok()?;
    let mss = MediaSourceStream::new(Box::new(file), Default::default());
    let mut hint = Hint::new();
    if path.to_lowercase().ends_with(".mp3") { hint.with_extension("mp3"); }

    let format_opts = FormatOptions { enable_gapless: true, ..Default::default() };
    let meta_opts = MetadataOptions::default();

    let probed = symphonia::default::get_probe().format(&hint, mss, &format_opts, &meta_opts).ok()?;
    let format = probed.format;

    // Try default track first
    let track = format.default_track().or_else(|| format.tracks().first())?;
    let params = &track.codec_params;

    if let Some(n_frames) = params.n_frames {
        if let Some(rate) = params.sample_rate {
            let total_secs = n_frames / (rate as u64);
            return Some(format!("{}:{:02}", total_secs / 60, total_secs % 60));
        }
    }

    // Fallback: Check metadata for duration tags or rodio decoder if n_frames is missing
    // Sometimes MP3 duration is found in metadata tags (TLEN etc)
    // Here we'll try rodio as secondary fallback
    let f2 = File::open(path).ok()?;
        if let Ok(decoder) = Decoder::new(BufReader::new(f2)) {
            let opt_d: Option<Duration> = decoder.total_duration();
            if let Some(d) = opt_d {
                let s = d.as_secs();
                return Some(format!("{}:{:02}", s / 60, s % 60));
            }
        }

    None
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let window = app.get_webview_window("main");
            if let Some(w) = window {
                *MAIN_WINDOW.lock() = Some(w.clone());
                
                let w_clone = w.clone();
                std::thread::spawn(move || {
                    loop {
                        std::thread::sleep(Duration::from_millis(200));
                        if let Ok(handler) = &*AUDIO_HANDLER {
                            let (samples, duration_ms, rate, track_rate, is_empty) = {
                                let controller = handler.controller.lock();
                                (
                                    handler.current_pos_samples.load(Ordering::Relaxed),
                                    handler.total_duration_ms.load(Ordering::Relaxed),
                                    handler.active_sample_rate,
                                    handler.track_sample_rate.load(Ordering::Relaxed),
                                    controller.empty()
                                )
                            };

                            let pos_ms = if track_rate > 0 { (samples as f64 / track_rate as f64 * 1000.0) as u64 } else { 0 };

                            // Detection of finished playback: sink is empty OR time exceeded duration (safety fallback for FLAC/VBR)
                            let is_finished_fallback = duration_ms > 0 && pos_ms >= duration_ms + 1000;
                            
                            // CRITICAL: Verify if we are currently in the middle of a seek/re-init
                            let is_locked_for_init = crate::audio_player::IS_PREPARING_PLAYBACK.load(Ordering::SeqCst);

                            if (is_empty || is_finished_fallback) && duration_ms > 0 && !is_locked_for_init {
                                let mut state = handler.state.lock();
                                if state.is_playing {
                                    state.is_playing = false;
                                    
                                    // Ensure sink is cleared to stop trailing audio
                                    handler.controller.lock().clear();
                                    
                                    // Reset position samples when finished
                                    handler.current_pos_samples.store(0, Ordering::Relaxed);
                                    
                                    let _ = w_clone.emit("playback-status", PlaybackStatus { 
                                        status: Status::Finished, 
                                        message: "Finished".into() 
                                    });
                                }
                            }

                            if rate > 0 {
                                // If already finished, emit 0ms to reset UI time
                                let is_really_finished = is_empty || is_finished_fallback;
                                let pos_to_emit_ms = if is_really_finished { 0 } else { pos_ms };
                                
                                let _ = w_clone.emit("playback-progress", PlaybackProgress {
                                    position_ms: pos_to_emit_ms,
                                    duration_ms,
                                });
                            }
                        }
                    }
                });
            }
            Ok(())
        })
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            play_track,
            toggle_playback,
            stop_playback,
            seek_to,
            set_pitch,
            set_tempo,
            set_volume,
            set_master_volume,
            set_vocal_balance,
            toggle_ai_feature,
            check_mr_separated,
            delete_mr,
            start_mr_separation,
            get_youtube_metadata,
            get_audio_metadata,
            get_playback_state,
            check_ai_runtime,
            check_model_ready,
            download_ai_model,
            save_library,
            load_library,
            cancel_separation,
            get_audio_devices,
            open_cache_folder,
            delete_ai_model,
            get_gpu_recommendation
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}


