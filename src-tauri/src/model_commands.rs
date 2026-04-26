use tauri::{Emitter, AppHandle, Manager, WebviewWindow};
use std::sync::atomic::Ordering;
use ort::execution_providers::{CUDAExecutionProvider, CPUExecutionProvider};
#[cfg(target_os = "windows")]
use ort::execution_providers::DirectMLExecutionProvider;
#[cfg(target_os = "macos")]
use ort::execution_providers::CoreMLExecutionProvider;
use crate::model_manager::ModelManager;
use crate::types::{Status, PlaybackStatus, SongMetadata};
use crate::audio_player::sys_log;
use crate::youtube::YoutubeManager;
use ort::ep::ExecutionProvider;

fn normalize_cache_key(path: &str) -> String {
    path.replace("\\", "/")
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GpuStatus { pub has_nvidia: bool, pub is_cuda_available: bool, pub is_directml_available: bool, pub recommend_cuda: bool }

#[cfg(target_os = "windows")]
fn dml_or_coreml_available() -> bool {
    DirectMLExecutionProvider::default().is_available().unwrap_or(false)
}

#[cfg(target_os = "macos")]
fn dml_or_coreml_available() -> bool {
    CoreMLExecutionProvider::default().is_available().unwrap_or(false)
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
fn dml_or_coreml_available() -> bool {
    false
}

#[tauri::command]
pub async fn check_ai_runtime() -> Result<Vec<String>, String> {
    let mut providers = Vec::new();
    if CUDAExecutionProvider::default().is_available().unwrap_or(false) { providers.push("CUDA".to_string()); }
    if dml_or_coreml_available() {
        #[cfg(target_os = "windows")]
        providers.push("DirectML".to_string());
        #[cfg(target_os = "macos")]
        providers.push("CoreML".to_string());
    }
    if CPUExecutionProvider::default().is_available().unwrap_or(false) { providers.push("CPU".to_string()); }
    Ok(providers)
}

#[tauri::command]
pub async fn get_gpu_recommendation() -> Result<GpuStatus, String> {
    #[cfg(target_os = "windows")]
    let mut has_nvidia = false;
    #[cfg(not(target_os = "windows"))]
    let has_nvidia = false;
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        let mut cmd = std::process::Command::new("wmic");
        cmd.creation_flags(0x08000000); // NO_WINDOW
        if let Ok(output) = cmd.args(["path", "win32_VideoController", "get", "name"]).output() {
            if String::from_utf8_lossy(&output.stdout).to_uppercase().contains("NVIDIA") { has_nvidia = true; }
        }
    }
    let cuda = CUDAExecutionProvider::default().is_available().unwrap_or(false);
    let dml = dml_or_coreml_available();
    Ok(GpuStatus { has_nvidia, is_cuda_available: cuda, is_directml_available: dml, recommend_cuda: has_nvidia && !cuda && !dml })
}

#[tauri::command]
pub async fn check_model_ready(handle: AppHandle, model_id: String) -> bool {
    if let Some((_, name, _)) = crate::state::MODELS.iter().find(|(id, _, _)| *id == model_id) {
        ModelManager::new(&handle).get_model_path(name).exists()
    } else {
        false
    }
}

#[tauri::command]
pub async fn download_ai_model(window: WebviewWindow, model_id: String) -> Result<(), String> {
    let app = window.app_handle();
    let manager = ModelManager::new(app);
    
    let (_, name, url) = crate::state::MODELS.iter()
        .find(|(id, _, _)| *id == model_id)
        .ok_or_else(|| format!("Unknown model ID: {}", model_id))?;

    window.emit("playback-status", PlaybackStatus { status: Status::Downloading, message: format!("{} 모델 다운로드...", name) }).ok();
    
    match manager.ensure_model(app, name, url).await {
        Ok(_) => {
            window.emit("playback-status", PlaybackStatus { status: Status::Finished, message: format!("{} 모델 준비됨", name) }).ok();
            Ok(())
        }
        Err(e) => {
            let _ = sys_log(&format!("[Command] [Error] download_ai_model failed: {}", e));
            Err(e)
        }
    }
}

#[tauri::command]
pub async fn delete_ai_model(window: WebviewWindow, model_id: String) -> Result<(), String> {
    let manager = ModelManager::new(window.app_handle());
    let (_, name, _) = crate::state::MODELS.iter()
        .find(|(id, _, _)| *id == model_id)
        .ok_or_else(|| format!("Unknown model ID: {}", model_id))?;
        
    let path = manager.get_model_path(name);
    if path.exists() {
        std::fs::remove_file(path).ok();
        let mut engine = crate::separation::ROFORMER_ENGINE.lock();
        *engine = None;
    }
    Ok(())
}

#[tauri::command]
pub async fn set_broadcast_mode(enabled: bool) -> Result<(), String> {
    crate::separation::BROADCAST_MODE.store(enabled, Ordering::Relaxed);
    sys_log(&format!("Broadcast Mode set to: {}", enabled));
    Ok(())
}

#[tauri::command]
pub fn get_active_separations() -> Vec<String> {
    crate::separation::ACTIVE_SEPARATIONS.lock()
        .values()
        .map(|(original_path, _)| original_path.clone())
        .collect()
}

#[tauri::command]
pub async fn start_mr_separation(window: WebviewWindow, path: String) -> Result<(), String> {
    let norm = normalize_cache_key(&path);
    if crate::separation::ACTIVE_SEPARATIONS.lock().contains_key(&norm) {
        let _ = sys_log(&format!("[Command] [Error] start_mr_separation failed: ALREADY_PROCESSING for {}", path));
        return Err("ALREADY_PROCESSING".into()); 
    }
    
    let cache = window.state::<crate::state::AppPaths>().separated.join(urlencoding::encode(&norm).to_string());
    let task = crate::separation::task::SeparationTask::new(window, path, cache);
    tauri::async_runtime::spawn(async move { task.run().await; });
    Ok(())
}

#[tauri::command]
pub fn cancel_separation(path: String) -> Result<(), String> {
    let norm = normalize_cache_key(&path);
    if let Some((_, flag)) = crate::separation::ACTIVE_SEPARATIONS.lock().remove(&norm) {
        flag.store(true, Ordering::Relaxed);
    }
    crate::audio_player::CANCEL_REQUESTS.lock().insert(norm);
    Ok(())
}

#[tauri::command]
pub async fn youtube_metadata_fetcher(url: String) -> Result<SongMetadata, String> {
    let metadata_res = YoutubeManager::get_video_metadata(&url).await;
    match metadata_res {
        Ok(m) => {
            let secs = m.duration.unwrap_or(0.0) as u64;
            let duration = format!("{}:{:02}", secs / 60, secs % 60);
            Ok(SongMetadata {
                id: None, title: m.title.unwrap_or_else(|| "Unknown Video".into()), 
                thumbnail: m.thumbnail.unwrap_or_default(), duration,
                source: "youtube".into(), path: url, pitch: Some(0.0), tempo: Some(1.0), volume: Some(100.0),
                artist: m.uploader, tags: None, genre: None, categories: None,
                play_count: Some(0), 
                date_added: Some(std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs()),
                is_mr: Some(false), is_separated: Some(false),
                has_lyrics: Some(false),
                original_title: None, translated_title: None, curation_category: None,
            })
        },
        Err(e) => {
            sys_log(&format!("[Youtube] Fetch failed for {}: {}", url, e));
            Err(e)
        }
    }
}

#[tauri::command]
pub fn check_mr_separated(window: WebviewWindow, path: String) -> bool {
    let norm = normalize_cache_key(&path);
    let cache = window.state::<crate::state::AppPaths>().separated.join(urlencoding::encode(&norm).to_string());
    cache.join("vocal.wav").exists() && cache.join("inst.wav").exists()
}

#[tauri::command]
pub fn delete_mr(window: WebviewWindow, path: String) -> Result<(), String> {
    let norm = normalize_cache_key(&path);
    let cache = window.state::<crate::state::AppPaths>().separated.join(urlencoding::encode(&norm).to_string());
    if cache.exists() {
        std::fs::remove_dir_all(cache).map_err(|e| e.to_string())?;
    }
    Ok(())
}
