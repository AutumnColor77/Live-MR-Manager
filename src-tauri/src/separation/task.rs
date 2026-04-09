use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering, AtomicU32};
use std::path::PathBuf;
use tauri::{Emitter, WebviewWindow, Manager};
use tokio::sync::oneshot;

use crate::vocal_remover::{InferenceEngine, WaveformRemover};
use crate::youtube::YoutubeManager;
use crate::audio_player::sys_log;
use super::{SeparationProgress, ROFORMER_ENGINE, AI_QUEUE_LOCK, ACTIVE_SEPARATIONS};

pub struct SeparationTask {
    window: WebviewWindow,
    path: String,
    cache_dir: PathBuf,
}

impl SeparationTask {
    pub fn new(window: WebviewWindow, path: String, cache_dir: PathBuf) -> Self {
        Self { window, path, cache_dir }
    }

    /// Orchestrates the entire separation process.
    pub async fn run(self) {
        let window = self.window;
        let path = self.path;
        let cache_dir = self.cache_dir;

        // 1. Normalize path and register in active map immediately to prevent duplicates
        let norm_p = path.replace("\\", "/").to_lowercase();
        let cancel_flag = Arc::new(AtomicBool::new(false));
        {
            let mut active = ACTIVE_SEPARATIONS.lock();
            // Optional: If already being processed, we can exit or just let it queue.
            // But since the frontend might have already sent the command, the safest is to check in lib.rs.
            // Still, registering here ensures it's tracked even while waiting for lock.
            active.insert(norm_p.clone(), (path.clone(), cancel_flag.clone()));
        }

        // 2. Initial status: Queued (Waiting for Lock)
        window.emit("separation-progress", SeparationProgress {
            path: path.clone(),
            percentage: 0.0,
            status: "Queued".into(),
            provider: "SYSTEM".into(),
        }).ok();

        // 3. Wait for Global AI Queue Lock (One task at a time)
        let _permit = AI_QUEUE_LOCK.lock().await;

        // 3.1. Check if cancelled while waiting
        if cancel_flag.load(Ordering::Relaxed) {
            return; // Already removed from map by cancel_separation
        }

        // 4. Ensure AI Engine is loaded
        let engine = match Self::ensure_engine(&window, &path).await {
            Ok(e) => e,
            Err(_) => {
                let mut active = ACTIVE_SEPARATIONS.lock();
                active.remove(&norm_p);
                return;
            }
        };

        // 5. Prepare Source Audio File (Download if YouTube)
        let source_path = match Self::prepare_source(&window, &path).await {
            Ok(p) => p,
            Err(_) => {
                let mut active = ACTIVE_SEPARATIONS.lock();
                active.remove(&norm_p);
                return;
            }
        };

        // 6. Update status to Starting
        window.emit("separation-progress", SeparationProgress {
            path: path.clone(),
            percentage: 0.0,
            status: "Starting".into(),
            provider: engine.get_provider(),
        }).ok();

        // 7. Execute core separation logic in a dedicated thread
        Self::execute_separation(window, path, source_path, cache_dir, engine, cancel_flag, norm_p).await;
    }

    async fn ensure_engine(window: &WebviewWindow, path: &str) -> Result<Arc<dyn InferenceEngine>, String> {
        let engine_guard = ROFORMER_ENGINE.lock();
        if let Some(engine) = engine_guard.as_ref() {
            return Ok(engine.clone());
        }
        drop(engine_guard);

        // Initialization needed
        window.emit("separation-progress", SeparationProgress {
            path: path.to_string(),
            percentage: 0.0,
            status: "AI 모델 로딩 중...".into(),
            provider: "SYSTEM".into(),
        }).ok();

        let paths = window.state::<crate::state::AppPaths>();
        let model_path = paths.models.join("Kim_Vocal_2.onnx");

        if !model_path.exists() {
            let err = "Error: 모델 파일 없음".to_string();
            Self::emit_error(window, path, &err, "SYSTEM");
            return Err(err);
        }

        match WaveformRemover::new(&model_path) {
            Ok(remover) => {
                let engine_arc = Arc::new(remover);
                let mut guard = ROFORMER_ENGINE.lock();
                *guard = Some(engine_arc.clone());
                Ok(engine_arc)
            }
            Err(e) => {
                let err = format!("Error: 모델 초기화 실패 ({})", e);
                sys_log(&format!("Model init error: {}", e));
                Self::emit_error(window, path, &err, "SYSTEM");
                Err(err)
            }
        }
    }

    async fn prepare_source(window: &WebviewWindow, path: &str) -> Result<PathBuf, String> {
        if !path.starts_with("http") {
            let p = PathBuf::from(path);
            if !p.exists() {
                let err = "Error: 소스 파일 없음".to_string();
                Self::emit_error(window, path, &err, "SYSTEM");
                return Err(err);
            }
            return Ok(p);
        }

        // YouTube Handling
        window.emit("separation-progress", SeparationProgress {
            path: path.to_string(),
            percentage: 0.0,
            status: "Downloading... (Preparing)".into(),
            provider: "NETWORK".into(),
        }).ok();

        match YoutubeManager::get_video_metadata(path).await {
            Ok(metadata) => {
                let paths = window.state::<crate::state::AppPaths>();
                let temp_dir = paths.temp.clone();
                let final_path = temp_dir.join(format!("yt_{}.m4a", metadata.id.unwrap_or_else(|| "unknown".into())));
                
                if final_path.exists() {
                    return Ok(final_path);
                }

                match YoutubeManager::download_audio(window, path, final_path.clone(), true).await {
                    Ok(_) => Ok(final_path),
                    Err(e) => {
                        Self::emit_error(window, path, &format!("YT Error: {}", e), "NETWORK");
                        Err(e)
                    }
                }
            },
            Err(e) => {
                Self::emit_error(window, path, &format!("YT Metadata Error: {}", e), "NETWORK");
                Err(e)
            }
        }
    }

    async fn execute_separation(
        window: WebviewWindow, 
        path: String, 
        source_path: PathBuf, 
        cache_dir: PathBuf, 
        engine: Arc<dyn InferenceEngine>,
        cancel_flag: Arc<AtomicBool>,
        norm_p: String
    ) {
        let window_clone = window.clone();
        let path_clone = path.clone();
        let cache_dir_clone = cache_dir.clone();
        let engine_info = engine.get_provider();
        let engine_for_spawn = engine.clone();

        let (tx, rx) = oneshot::channel::<Result<(), String>>();
        // We already have cancel_flag passed in
        let cancel_flag_for_separate = cancel_flag.clone();
        let cancel_flag_for_progress = cancel_flag.clone();

        // High-performance separation thread
        std::thread::spawn(move || {
            let w = window_clone;
            let p_for_progress = path_clone.clone();
            let p_for_cleanup = norm_p; // Use the normalized path passed in
            let info = engine_info;

            let last_percentage = Arc::new(AtomicU32::new(f32::to_bits(-1.0)));
            let last_p_progress = last_percentage.clone();

            let separation_result = engine_for_spawn.separate(
                &source_path,
                &cache_dir_clone,
                cancel_flag_for_separate,
                Box::new(move |percentage| {
                    if cancel_flag_for_progress.load(Ordering::Relaxed) { return; }
                    
                    let last = f32::from_bits(last_p_progress.load(Ordering::Relaxed));
                    if (percentage - last).abs() >= 0.5 || percentage >= 100.0 || percentage <= 0.0 {
                        last_p_progress.store(f32::to_bits(percentage), Ordering::Relaxed);
                        let _ = w.emit("separation-progress", SeparationProgress {
                            path: p_for_progress.clone(),
                            percentage,
                            status: "Processing".into(),
                            provider: info.clone(),
                        });
                    }
                })
            ).map_err(|e| e.to_string());
            
            // Clean up from active map
            {
                let mut active = ACTIVE_SEPARATIONS.lock();
                let norm_p = p_for_cleanup.replace("\\", "/").to_lowercase();
                active.remove(&norm_p);
            }
            
            let _ = tx.send(separation_result.map(|_| ()));
        });

        // Await thread result
        match rx.await {
            Ok(Ok(_)) => {
                window.emit("separation-progress", SeparationProgress {
                    path: path.clone(),
                    percentage: 100.0,
                    status: "Finished".into(),
                    provider: engine.get_provider(),
                }).ok();
            }
            Ok(Err(e)) => {
                let _ = std::fs::remove_dir_all(&cache_dir);
                let status = if e.contains("Cancelled") { "Cancelled" } else { "Error" };
                window.emit("separation-progress", SeparationProgress {
                    path: path.clone(),
                    percentage: 0.0,
                    status: status.into(),
                    provider: engine.get_provider(),
                }).ok();
            }
            Err(_) => {
                let _ = std::fs::remove_dir_all(&cache_dir);
                Self::emit_error(&window, &path, "Process panicked", "SYSTEM");
            }
        }
    }

    fn emit_error(window: &WebviewWindow, path: &str, message: &str, provider: &str) {
        window.emit("separation-progress", SeparationProgress {
            path: path.to_string(),
            percentage: 0.0,
            status: message.to_string(),
            provider: provider.to_string(),
        }).ok();
    }
}
