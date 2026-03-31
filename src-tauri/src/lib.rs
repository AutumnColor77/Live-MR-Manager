use once_cell::sync::Lazy;
use parking_lot::{Condvar, Mutex};
use rodio::{Decoder, DeviceSinkBuilder, MixerDeviceSink, Player, Source};
use rodio::source::UniformSourceIterator;
use serde::{Deserialize, Serialize};
use std::collections::{VecDeque, HashSet};
use std::fs::File;
use std::io::BufReader;
use std::num::{NonZeroU16, NonZeroU32};
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tauri::{async_runtime, Emitter, Manager, WebviewWindow, AppHandle};
use tauri::path::BaseDirectory;
use cpal::traits::{DeviceTrait, HostTrait};

mod youtube;
mod model_manager;
mod vocal_remover;
use crate::youtube::YoutubeManager;
use crate::model_manager::ModelManager;
use crate::vocal_remover::{InferenceEngine, WaveformRemover};
use ort::execution_providers::{ExecutionProvider, CUDAExecutionProvider, CPUExecutionProvider};

// Rodio 0.22.2 aliases for clarity:
pub type OSStream = MixerDeviceSink;
pub type PlaybackController = Player;

#[derive(Debug, Serialize, Deserialize)]
pub struct SeekToArgs {
    pub position_ms: u64,
}

static MAIN_WINDOW: Lazy<Mutex<Option<WebviewWindow>>> = Lazy::new(|| Mutex::new(None));
static ROFORMER_ENGINE: Lazy<Arc<Mutex<Option<Arc<dyn InferenceEngine>>>>> = Lazy::new(|| Arc::new(Mutex::new(None)));
pub(crate) static CANCEL_REQUESTS: Lazy<Mutex<HashSet<String>>> = Lazy::new(|| Mutex::new(HashSet::new()));

fn sys_log(message: &str) {
    println!("{}", message);
    if let Some(window) = MAIN_WINDOW.lock().as_ref() {
        let _ = window.emit("sys-log", message.to_string());
    }
}

#[derive(Debug, Clone, Serialize)]
#[allow(dead_code)]
enum Status {
    Pending,
    Downloading,
    Decoding,
    Playing,
    Error,
    Finished,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PlaybackStatus {
    status: Status,
    message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PlaybackProgress {
    position_ms: u64,
    duration_ms: u64,
}

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

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AppState {
    pub current_track: Option<String>,
    pub pitch: f32,
    pub tempo: f32,
    pub volume: f32,
    pub vocal_enabled: bool,
    pub lyric_enabled: bool,
    pub is_playing: bool,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            current_track: None,
            pitch: 0.0,
            tempo: 1.0,
            volume: 80.0,
            vocal_enabled: true,
            lyric_enabled: false,
            is_playing: false,
        }
    }
}

pub struct AudioHandler {
    _stream: OSStream,
    controller: Mutex<PlaybackController>,
    pub state: Mutex<AppState>,
    pub active_pitch: Arc<AtomicU32>, // bits of f32
    pub active_tempo: Arc<AtomicU32>, // bits of f32
    pub current_pos_samples: Arc<AtomicU64>,
    pub total_duration_ms: Arc<AtomicU64>,
    pub active_sample_rate: u32,
    pub active_channels: u16,
    pub vocal_volume: Arc<AtomicU32>, // 0-100
    pub instrumental_volume: Arc<AtomicU32>,
    pub playback_cv: Condvar,
}

static AUDIO_HANDLER: Lazy<Result<Arc<AudioHandler>, String>> = Lazy::new(|| {
    let stream_result = DeviceSinkBuilder::open_default_sink();
    let stream = match stream_result {
        Ok(s) => s,
        Err(e) => {
            let err_msg = format!("무료 오디오 출력을 열지 못했습니다: {}", e);
            sys_log(&format!("[AUDIO] CRITICAL ERROR: {}", err_msg));
            return Err(err_msg);
        }
    };
    
    // Detect system device config once:
    let host = cpal::default_host();
    let device = host.default_output_device();
    let device_name = device.as_ref().and_then(|d| d.name().ok()).unwrap_or_else(|| "Unknown Device".into());
    
    let (mut device_rate, mut device_channels) = if let Some(ref d) = device {
        if let Ok(config) = d.default_output_config() {
            (config.sample_rate().into(), config.channels())
        } else { (44100, 2) }
    } else { (44100, 2) };

    // Safety: some virtual drivers or misconfigured devices report 0 Hz.
    if device_rate == 0 {
        sys_log("[AUDIO] Warning: System reported 0Hz. Falling back to 44100Hz.");
        device_rate = 44100;
    }
    if device_channels == 0 {
        device_channels = 2;
    }

    sys_log(&format!("[AUDIO] Device Initialized: {} ({}Hz, {}ch)", device_name, device_rate, device_channels));
    
    let controller = Player::connect_new(&stream.mixer());
    Ok(Arc::new(AudioHandler {
        _stream: stream,
        controller: Mutex::new(controller),
        state: Mutex::new(AppState::default()),
        active_pitch: Arc::new(AtomicU32::new(0f32.to_bits())),
        active_tempo: Arc::new(AtomicU32::new(1.0f32.to_bits())),
        current_pos_samples: Arc::new(AtomicU64::new(0)),
        total_duration_ms: Arc::new(AtomicU64::new(0)),
        active_sample_rate: device_rate,
        active_channels: device_channels,
        vocal_volume: Arc::new(AtomicU32::new(100)),
        instrumental_volume: Arc::new(AtomicU32::new(100)),
        playback_cv: Condvar::new(),
    }))
});

struct DynamicVolumeSource<S> where S: Source<Item = f32> {
    input: S,
    volume: Arc<AtomicU32>,
}

impl<S> Iterator for DynamicVolumeSource<S> where S: Source<Item = f32> {
    type Item = f32;
    fn next(&mut self) -> Option<Self::Item> {
        let s = self.input.next()?;
        let vol = self.volume.load(Ordering::Relaxed) as f32 / 100.0;
        Some(s * vol)
    }
}

impl<S> Source for DynamicVolumeSource<S> where S: Source<Item = f32> {
    fn current_span_len(&self) -> Option<usize> { self.input.current_span_len() }
    fn channels(&self) -> NonZeroU16 { self.input.channels() }
    fn sample_rate(&self) -> NonZeroU32 { self.input.sample_rate() }
    fn total_duration(&self) -> Option<Duration> { self.input.total_duration() }
    fn try_seek(&mut self, pos: Duration) -> Result<(), rodio::source::SeekError> {
        self.input.try_seek(pos)
    }
}

struct StretchedSource<S> where S: Source<Item = f32> {
    input: S,
    stretcher: signalsmith_stretch::Stretch, // Will be replaced/recreated if rate changes, but we use fixed rate
    pitch: Arc<AtomicU32>,
    tempo: Arc<AtomicU32>,
    pos: Arc<AtomicU64>,
    buffer: VecDeque<f32>,
    input_channels: usize,
}

impl<S> StretchedSource<S> where S: Source<Item = f32> {
    fn new(input: S, pitch: Arc<AtomicU32>, tempo: Arc<AtomicU32>, pos: Arc<AtomicU64>) -> Self {
        let channels = input.channels().get() as u32;
        let rate = input.sample_rate().get();
        Self {
            input,
            stretcher: signalsmith_stretch::Stretch::preset_default(channels, rate),
            pitch,
            tempo,
            pos,
            buffer: VecDeque::new(),
            input_channels: channels as usize,
        }
    }
}

impl<S> Iterator for StretchedSource<S> where S: Source<Item = f32> {
    type Item = f32;
    fn next(&mut self) -> Option<Self::Item> {
        if let Some(s) = self.buffer.pop_front() {
            // Only increment frame counter once per frame (after all channels of that frame are popped)
            if self.buffer.len() % self.input_channels == 0 {
                self.pos.fetch_add(1, Ordering::Relaxed);
            }
            return Some(s);
        }

        let pitch_semitones = f32::from_bits(self.pitch.load(Ordering::Relaxed));
        let tempo_scale = f32::from_bits(self.tempo.load(Ordering::Relaxed));
        
        let pitch_factor = 2.0f32.powf(pitch_semitones / 12.0);
        self.stretcher.set_transpose_factor(pitch_factor, None);

        // signalsmith-stretch 0.1.3 expects interleaved &[f32] for inputs/outputs
        let block_size = 1024;
        let mut input_interleaved: Vec<f32> = Vec::with_capacity(block_size * self.input_channels);
        for _ in 0..block_size {
            for _ in 0..self.input_channels {
                if let Some(s) = self.input.next() {
                    input_interleaved.push(s);
                }
            }
        }

        let frames_read = input_interleaved.len() / self.input_channels;
        if frames_read == 0 { return None; }

        // Calculate output buffer size based on tempo. 
        // 0.1.3 doesn't have output_frames_required; we use a safe estimate.
        let output_frames_est = (frames_read as f32 / tempo_scale).ceil() as usize + 64; 
        let mut output_interleaved = vec![0.0; output_frames_est * self.input_channels];
        
        // Use flat slices for 0.1.3 process method
        self.stretcher.process(&input_interleaved, &mut output_interleaved);
        
        // Collect results into our dequeue for popping
        for s in output_interleaved {
            self.buffer.push_back(s);
        }

        self.buffer.pop_front().map(|s| {
            if self.buffer.len() % self.input_channels == 0 {
                self.pos.fetch_add(1, Ordering::Relaxed);
            }
            s
        })
    }
}

impl<S> Source for StretchedSource<S> where S: Source<Item = f32> {
    fn current_span_len(&self) -> Option<usize> { None }
    fn channels(&self) -> NonZeroU16 { NonZeroU16::new(self.input_channels as u16).unwrap() }
    fn sample_rate(&self) -> NonZeroU32 { self.input.sample_rate() }
    fn total_duration(&self) -> Option<Duration> { self.input.total_duration() }
    fn try_seek(&mut self, pos: Duration) -> Result<(), rodio::source::SeekError> {
        self.input.try_seek(pos)?;
        self.buffer.clear();
        self.stretcher.reset();
        Ok(())
    }
}

#[tauri::command]
async fn play_track(window: WebviewWindow, path: String) -> Result<(), String> {
    let res = play_track_internal(window.clone(), path).await;
    if let Err(ref e) = res {
        let _ = window.emit("playback-status", PlaybackStatus { status: Status::Error, message: e.clone() });
    }
    res
}

async fn play_track_internal(window: WebviewWindow, path: String) -> Result<(), String> {
    let handler = match &*AUDIO_HANDLER {
        Ok(h) => h.clone(),
        Err(e) => return Err(e.clone()),
    };
    
    // 1. Initial status
    window.emit("playback-status", PlaybackStatus { status: Status::Pending, message: "Preparing...".into() }).unwrap();

    // 1. Immediate stop and reset
    {
        let controller = handler.controller.lock();
        controller.clear();
    }
    handler.current_pos_samples.store(0, Ordering::Relaxed);
    handler.total_duration_ms.store(0, Ordering::Relaxed);

    // 2. Metadata and path setup
    let app_dir = window.app_handle().path().app_local_data_dir().expect("Failed app dir");
    let cache_key = urlencoding::encode(&path).to_string();
    let cache_dir = app_dir.join("cache").join("separated").join(&cache_key);
    let vocal_path = cache_dir.join("vocal.wav");
    let inst_path = cache_dir.join("inst.wav");
    
    let play_path = if path.starts_with("http") {
        window.emit("playback-status", PlaybackStatus { status: Status::Downloading, message: "Downloading...".into() }).unwrap();
        let metadata = YoutubeManager::get_video_metadata(&path).await?;
        let temp_dir = std::env::temp_dir();
        let final_path = temp_dir.join(format!("yt_{}.m4a", metadata.id.unwrap_or_else(|| "unknown".into())));
        if !final_path.exists() {
            YoutubeManager::download_audio(&window, &path, final_path.clone()).await?;
        }
        final_path
    } else {
        std::path::PathBuf::from(&path)
    };

    if !play_path.exists() {
        return Err("File not found".into());
    }

    // 3. Setup pipeline
    let target_rate = handler.active_sample_rate;
    let target_channels = handler.active_channels;
    let target_rate_nz = NonZeroU32::new(target_rate).expect("Invalid sample rate");
    let target_channels_nz = NonZeroU16::new(target_channels).expect("Invalid channels");

    sys_log(&format!("Playing: {} (Device: {}Hz, {}ch)", path, target_rate, target_channels));

    if vocal_path.exists() && inst_path.exists() {
        // Separated paths
        let v_file = File::open(vocal_path).map_err(|e| e.to_string())?;
        let i_file = File::open(inst_path).map_err(|e| e.to_string())?;
        
        let v_decoder = Decoder::new(BufReader::new(v_file)).map_err(|e| e.to_string())?;
        let i_decoder = Decoder::new(BufReader::new(i_file)).map_err(|e| e.to_string())?;
        
        // Capture duration from one of them
        if let Some(d) = i_decoder.total_duration() {
            handler.total_duration_ms.store(d.as_millis() as u64, Ordering::Relaxed);
        }

        let stretched_v = StretchedSource::new(v_decoder, handler.active_pitch.clone(), handler.active_tempo.clone(), Arc::new(AtomicU64::new(0)));
        let stretched_i = StretchedSource::new(i_decoder, handler.active_pitch.clone(), handler.active_tempo.clone(), handler.current_pos_samples.clone());
        
        let resampled_v = UniformSourceIterator::new(DynamicVolumeSource { input: stretched_v, volume: handler.vocal_volume.clone() }, target_channels_nz, target_rate_nz);
        let resampled_i = UniformSourceIterator::new(stretched_i, target_channels_nz, target_rate_nz);

        let mixed = resampled_i.mix(resampled_v);
        let controller = handler.controller.lock();
        controller.append(mixed);
        controller.play();
    } else {
        // Mono source
        let file = File::open(&play_path).map_err(|e| e.to_string())?;
        let decoder = Decoder::new(BufReader::new(file)).map_err(|e| e.to_string())?;
        
        if let Some(d) = decoder.total_duration() {
            handler.total_duration_ms.store(d.as_millis() as u64, Ordering::Relaxed);
        }

        let stretched = StretchedSource::new(decoder, handler.active_pitch.clone(), handler.active_tempo.clone(), handler.current_pos_samples.clone());
        let resampled = UniformSourceIterator::new(stretched, target_channels_nz, target_rate_nz);
        
        let controller = handler.controller.lock();
        controller.append(resampled);
        controller.play();
    }

    let mut state = handler.state.lock();
    state.current_track = Some(path.clone());
    state.is_playing = true;
    
    window.emit("playback-status", PlaybackStatus { status: Status::Playing, message: "Playing".into() }).unwrap();
    Ok(())
}

#[tauri::command]
async fn set_pitch(semitones: f32) -> Result<(), String> {
    if let Ok(handler) = &*AUDIO_HANDLER {
        handler.active_pitch.store(semitones.to_bits(), Ordering::Relaxed);
    }
    Ok(())
}

#[tauri::command]
async fn set_vocal_volume(volume: f32) -> Result<(), String> {
    if let Ok(handler) = &*AUDIO_HANDLER {
        handler.vocal_volume.store(volume as u32, Ordering::Relaxed);
    }
    Ok(())
}

#[tauri::command]
async fn set_tempo(ratio: f32) -> Result<(), String> {
    if let Ok(handler) = &*AUDIO_HANDLER {
        handler.active_tempo.store(ratio.to_bits(), Ordering::Relaxed);
    }
    Ok(())
}

#[tauri::command]
async fn set_volume(volume: f32) -> Result<(), String> {
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
async fn seek_to(position_ms: u64) -> Result<(), String> {
    let handler = AUDIO_HANDLER.as_ref().map_err(|e| e.clone())?.clone();
    let controller = handler.controller.lock();
    let _ = controller.try_seek(Duration::from_millis(position_ms));
    handler.current_pos_samples.store(0, Ordering::Relaxed);
    Ok(())
}

#[tauri::command]
async fn toggle_ai_feature(feature: String, enabled: bool) -> Result<(), String> {
    if let Ok(handler) = &*AUDIO_HANDLER {
        let mut state = handler.state.lock();
        match feature.as_str() {
            "vocal" => {
                state.vocal_enabled = enabled;
                handler.vocal_volume.store(if enabled { 100 } else { 0 }, Ordering::Relaxed);
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
    
    let duration_str = match std::fs::File::open(&path) {
        Ok(file) => {
            match Decoder::new(std::io::BufReader::new(file)) {
                Ok(decoder) => {
                    if let Some(d) = decoder.total_duration() {
                        let secs = d.as_secs();
                        format!("{}:{:02}", secs / 60, secs % 60)
                    } else {
                        "0:00".into()
                    }
                },
                Err(_) => "0:00".into(),
            }
        },
        Err(_) => "0:00".into(),
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
async fn start_mr_separation(window: WebviewWindow, path: String) -> Result<(), String> {
    run_separation(window, path).await
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

#[tauri::command]
async fn check_model_ready(handle: AppHandle) -> bool {
    let manager = ModelManager::new(&handle);
    if let Ok(res_path) = handle.path().resolve("resources/bs_roformer.onnx", BaseDirectory::Resource) {
        if res_path.exists() { return true; }
    }
    manager.get_model_path("bs_roformer.onnx").exists()
}

#[tauri::command]
async fn download_ai_model(window: WebviewWindow) -> Result<(), String> {
    let app_handle = window.app_handle();
    let manager = ModelManager::new(app_handle);
    window.emit("playback-status", PlaybackStatus { status: Status::Downloading, message: "AI 모델 다운로드 시작...".into() }).unwrap();
    let model_url = "https://huggingface.co/safescribeai/bs-roformer-onnx-fp16/resolve/main/bs_roformer_fp16.onnx";
    let _model_path = manager.ensure_model(app_handle, "bs_roformer.onnx", model_url).await?;
    window.emit("playback-status", PlaybackStatus { status: Status::Finished, message: "AI 모델 다운로드 완료".into() }).unwrap();
    Ok(())
}

#[tauri::command]
async fn get_audio_devices() -> Result<Vec<String>, String> {
    let host = cpal::default_host();
    let devices = host.output_devices().map_err(|e| e.to_string())?;
    let mut names = Vec::new();
    for d in devices {
        if let Ok(name) = d.name() {
            let config = d.default_output_config().map(|c| format!("{}Hz, {}ch", u32::from(c.sample_rate()), c.channels())).unwrap_or_else(|_| "Unknown Config".into());
            names.push(format!("{} ({})", name, config));
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
}

#[tauri::command]
async fn run_separation(window: WebviewWindow, path: String) -> Result<(), String> {
    // 0. Ensure cancel state is clean for this path
    CANCEL_REQUESTS.lock().remove(&path);

    let engine = {
        let mut engine_guard = ROFORMER_ENGINE.lock();
        if engine_guard.is_none() {
            let app_handle = window.app_handle();
            let manager = ModelManager::new(app_handle);
            
            // Check if model exists somewhere
            let mut model_path = None;
            if let Ok(res_path) = app_handle.path().resolve("resources/bs_roformer.onnx", BaseDirectory::Resource) {
                if res_path.exists() { model_path = Some(res_path); }
            }
            if model_path.is_none() {
                let app_path = manager.get_model_path("bs_roformer.onnx");
                if app_path.exists() { model_path = Some(app_path); }
            }

            match model_path {
                Some(path) => {
                    window.emit("playback-status", PlaybackStatus { status: Status::Downloading, message: "AI 모델 로드 중...".into() }).unwrap();
                    *engine_guard = Some(Arc::new(WaveformRemover::new(&path)?));
                },
                None => {
                    return Err("AI 모델이 설치되지 않았습니다. 설정에서 다운로드해주세요.".into());
                }
            }
        }
        engine_guard.as_ref().unwrap().clone()
    };

    let app_dir = window.app_handle().path().app_local_data_dir().expect("Failed app dir");
    let cache_key = urlencoding::encode(&path).to_string();
    let cache_dir = app_dir.join("cache").join("separated").join(&cache_key);
    
    let source_path = if path.starts_with("http") {
        let temp_dir = std::env::temp_dir();
        let metadata = YoutubeManager::get_video_metadata(&path).await?;
        temp_dir.join(format!("yt_{}.m4a", metadata.id.unwrap_or_else(|| "unknown".into())))
    } else {
        std::path::PathBuf::from(&path)
    };

    if !source_path.exists() {
        return Err("Source file not found.".into());
    }

    // Task Start Emission
    window.emit("separation-progress", SeparationProgress {
        path: path.clone(),
        percentage: 0.0,
        status: "Starting".into(),
    }).unwrap();

    let window_clone = window.clone();
    let path_clone = path.clone();

    let result = async_runtime::spawn_blocking(move || {
        let w = window_clone.clone();
        let p = path_clone.clone();
        engine.separate(&source_path, &cache_dir, Box::new(move |percentage| {
            // Check for cancellation
            if CANCEL_REQUESTS.lock().contains(&p) {
                return; // Logic for "stop" is handled inside separate loop
            }
            let _ = w.emit("separation-progress", SeparationProgress {
                path: p.clone(),
                percentage,
                status: "Processing".into(),
            });
        }))
    }).await.map_err(|e| format!("처리 중 오류(Panic)가 발생했습니다: {}", e));
    
    // Check if what we got back is an error
    if let Ok(Err(ref e)) = result {
        if e.contains("Cancelled by user") {
            let _ = window.emit("separation-progress", SeparationProgress {
                path: path.clone(),
                percentage: 0.0,
                status: "Cancelled".into(),
            });
        } else {
            // General Error Emission
            let _ = window.emit("separation-progress", SeparationProgress {
                path: path.clone(),
                percentage: 0.0,
                status: "Error".into(),
            });
        }
    }

    result??;
    
    // Task Final Emission (Finished)
    window.emit("separation-progress", SeparationProgress {
        path: path.clone(),
        percentage: 100.0,
        status: "Finished".into(),
    }).unwrap();

    window.emit("playback-status", PlaybackStatus { status: Status::Finished, message: "Separation complete".into() }).unwrap();
    Ok(())
}

#[tauri::command]
fn cancel_separation(path: String) {
    sys_log(&format!("AI 분리 작업 취소 요청: {}", path));
    CANCEL_REQUESTS.lock().insert(path);
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
                        std::thread::sleep(Duration::from_millis(100));
                        if let Ok(handler) = &*AUDIO_HANDLER {
                                let samples = handler.current_pos_samples.load(Ordering::Relaxed);
                                let duration_ms = handler.total_duration_ms.load(Ordering::Relaxed);
                                let rate = handler.active_sample_rate;
                                if rate > 0 {
                                    let pos_ms = (samples as f64 / rate as f64 * 1000.0) as u64;
                                    let _ = w_clone.emit("playback-progress", PlaybackProgress {
                                        position_ms: pos_ms,
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
            set_vocal_volume,
            toggle_ai_feature,
            check_mr_separated,
            start_mr_separation,
            get_youtube_metadata,
            get_audio_metadata,
            get_playback_state,
            check_ai_runtime,
            run_separation,
            check_model_ready,
            download_ai_model,
            save_library,
            load_library,
            cancel_separation,
            get_audio_devices,
            open_cache_folder
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
