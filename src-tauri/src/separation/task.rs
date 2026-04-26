use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering, AtomicU32};
use std::path::PathBuf;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{Emitter, WebviewWindow, Manager};
use tokio::sync::oneshot;

use crate::vocal_remover::{InferenceEngine, WaveformRemover};
use crate::model_manager::{ModelManager, ModelSpec};
use crate::youtube::YoutubeManager;
use crate::audio_player::sys_log;
use super::{SeparationProgress, ROFORMER_ENGINE, AI_QUEUE_LOCK, ACTIVE_SEPARATIONS, MODEL_INIT_LOCK, MODEL_INIT_COOLDOWN_UNTIL};

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
        let norm_p = path.replace("\\", "/");
        
        // If a cancel was already requested before the task reached this point, abort immediately.
        if crate::audio_player::CANCEL_REQUESTS.lock().remove(&norm_p) {
            window.emit("separation-progress", SeparationProgress {
                path: path.clone(),
                percentage: 0.0,
                status: "Cancelled".into(),
                provider: "SYSTEM".into(),
                model: Self::get_configured_model_name(),
            }).ok();
            return;
        }
        
        let cancel_flag = Arc::new(AtomicBool::new(false));
        {
            let mut active = ACTIVE_SEPARATIONS.lock();
            active.insert(norm_p.clone(), (path.clone(), cancel_flag.clone()));
        }

        // 2. Initial status: Queued (Waiting for Lock)
        let default_model = Self::get_configured_model_name();
        window.emit("separation-progress", SeparationProgress {
            path: path.clone(),
            percentage: 0.0,
            status: "Queued".into(),
            provider: "SYSTEM".into(),
            model: default_model.clone(),
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
            model: engine.get_model_name(),
        }).ok();

        // 7. Execute core separation logic in a dedicated thread
        Self::execute_separation(window, path, source_path, cache_dir, engine, cancel_flag, norm_p).await;
    }

    fn now_secs() -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0)
    }

    fn read_active_model_id() -> String {
        let db = crate::state::DB.lock();
        db.query_row("SELECT value FROM Settings WHERE key = 'active_model_id'", [], |row| row.get::<_, String>(0))
            .unwrap_or_else(|_| "kim".to_string())
    }

    async fn ensure_engine(window: &WebviewWindow, path: &str) -> Result<Arc<dyn InferenceEngine>, String> {
        {
            let engine_guard = ROFORMER_ENGINE.lock();
            if let Some(engine) = engine_guard.as_ref() {
                return Ok(engine.clone());
            }
        }

        // Single-flight model init: one initializer at a time across all tasks.
        let _init_guard = MODEL_INIT_LOCK.lock().await;

        // Re-check after waiting for lock in case another task initialized it.
        {
            let engine_guard = ROFORMER_ENGINE.lock();
            if let Some(engine) = engine_guard.as_ref() {
                return Ok(engine.clone());
            }
        }

        let now = Self::now_secs();
        let cooldown_until = MODEL_INIT_COOLDOWN_UNTIL.load(Ordering::Relaxed);
        if cooldown_until > now {
            let wait_sec = cooldown_until - now;
            let err = format!("Error: 모델 초기화 재시도 대기 중 ({}초 후 가능)", wait_sec);
            Self::emit_error(window, path, &err, "SYSTEM", &Self::get_configured_model_name());
            return Err(err);
        }

        window.emit("separation-progress", SeparationProgress {
            path: path.to_string(),
            percentage: 0.0,
            status: "AI 모델 로딩 중...".into(),
            provider: "SYSTEM".into(),
            model: Self::get_configured_model_name(),
        }).ok();

        let app = window.app_handle();
        let manager = ModelManager::new(app);
        let primary_model_id = Self::read_active_model_id();
        let mut attempt_specs: Vec<ModelSpec> = Vec::new();
        if let Ok(primary_spec) = ModelManager::spec_from_id(&primary_model_id) {
            attempt_specs.push(primary_spec);
        }
        if let Some(fallback_spec) = ModelManager::fallback_spec(&primary_model_id) {
            if attempt_specs.iter().all(|s| s.id != fallback_spec.id) {
                attempt_specs.push(fallback_spec);
            }
        }

        let mut last_error = String::new();
        for (idx, spec) in attempt_specs.iter().enumerate() {
            if idx > 0 {
                window.emit("separation-progress", SeparationProgress {
                    path: path.to_string(),
                    percentage: 0.0,
                    status: format!("Fallback 모델 시도 중... ({})", spec.name),
                    provider: "SYSTEM".into(),
                    model: spec.name.clone(),
                }).ok();
            }

            match manager.ensure_model_by_id(app, &spec.id).await {
                Ok(resolution) => {
                    let file_size = resolution.path.metadata().map(|m| m.len()).unwrap_or(0);
                    sys_log(&format!(
                        "[AI-ENGINE] Init start: id={}, source={}, path={:?}, size={} bytes",
                        resolution.spec.id,
                        resolution.source,
                        resolution.path,
                        file_size
                    ));

                    let model_path_for_spawn = resolution.path.clone();
                    let model_id_for_spawn = resolution.spec.id.clone();
                    let init_started = std::time::Instant::now();
                    let init_result = tokio::time::timeout(Duration::from_secs(90), tokio::task::spawn_blocking(move || {
                        WaveformRemover::new(&model_path_for_spawn, Some(&model_id_for_spawn))
                    })).await;

                    match init_result {
                        Ok(join_res) => match join_res {
                            Ok(Ok(remover)) => {
                                sys_log(&format!(
                                    "[AI-ENGINE] Init success: id={}, elapsed_ms={}",
                                    resolution.spec.id,
                                    init_started.elapsed().as_millis()
                                ));
                                let engine_arc = Arc::new(remover);
                                let mut guard = ROFORMER_ENGINE.lock();
                                *guard = Some(engine_arc.clone());
                                MODEL_INIT_COOLDOWN_UNTIL.store(0, Ordering::Relaxed);
                                return Ok(engine_arc);
                            }
                            Ok(Err(e)) => {
                                last_error = format!("모델 초기화 실패 ({}): {}", resolution.spec.name, e);
                                sys_log(&format!("[AI-ENGINE] {}", last_error));
                            }
                            Err(e) => {
                                last_error = format!("모델 로딩 스레드 실패 ({}): {}", resolution.spec.name, e);
                                sys_log(&format!("[AI-ENGINE] {}", last_error));
                            }
                        },
                        Err(_) => {
                            last_error = format!("모델 로딩 시간 초과 ({}): {}초", resolution.spec.name, 90);
                            sys_log(&format!("[AI-ENGINE] {}", last_error));
                            // Throttle next attempts for a short period to avoid piling blocked inits.
                            MODEL_INIT_COOLDOWN_UNTIL.store(Self::now_secs() + 120, Ordering::Relaxed);
                        }
                    }
                }
                Err(e) => {
                    last_error = format!("모델 준비 실패 ({}): {}", spec.name, e);
                    sys_log(&format!("[AI-ENGINE] {}", last_error));
                }
            }
        }

        let err = format!("Error: {}", if last_error.is_empty() { "모델 초기화 실패" } else { &last_error });
        Self::emit_error(window, path, &err, "SYSTEM", &Self::get_configured_model_name());
        Err(err)
    }

    async fn prepare_source(window: &WebviewWindow, path: &str) -> Result<PathBuf, String> {
        if !path.starts_with("http") {
            let p = PathBuf::from(path);
            if !p.exists() {
                let err = "Error: 소스 파일 없음".to_string();
                Self::emit_error(window, path, &err, "SYSTEM", &Self::get_configured_model_name());
                return Err(err);
            }
            return Ok(p);
        }

        // YouTube Handling
        window.emit("separation-progress", SeparationProgress {
            path: path.to_string(),
            percentage: 0.0,
            status: "다운로드 중... (준비 중)".into(),
            provider: "NETWORK".into(),
            model: Self::get_configured_model_name(),
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
                        Self::emit_error(window, path, &format!("YT Error: {}", e), "NETWORK", &Self::get_configured_model_name());
                        Err(e)
                    }
                }
            },
            Err(e) => {
                Self::emit_error(window, path, &format!("YT Metadata Error: {}", e), "NETWORK", &Self::get_configured_model_name());
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
        let engine_model = engine.get_model_name();
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
            let model = engine_model;

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
                            model: model.clone(),
                        });
                    }
                })
            ).map_err(|e| e.to_string());
            
            // Clean up from active map
            {
                let mut active = ACTIVE_SEPARATIONS.lock();
                let norm_p = p_for_cleanup.replace("\\", "/");
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
                    model: engine.get_model_name(),
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
                    model: engine.get_model_name(),
                }).ok();
            }
            Err(_) => {
                let _ = std::fs::remove_dir_all(&cache_dir);
                Self::emit_error(&window, &path, "Process panicked", "SYSTEM", &Self::get_configured_model_name());
            }
        }
    }

    fn emit_error(window: &WebviewWindow, path: &str, message: &str, provider: &str, model: &str) {
        window.emit("separation-progress", SeparationProgress {
            path: path.to_string(),
            percentage: 0.0,
            status: message.to_string(),
            provider: provider.to_string(),
            model: model.to_string(),
        }).ok();
    }

    fn get_configured_model_name() -> String {
        let db = crate::state::DB.lock();
        let model_id = db.query_row("SELECT value FROM Settings WHERE key = 'active_model_id'", [], |row| row.get::<_, String>(0)).unwrap_or_else(|_| "kim".to_string());
        
        let (_, model_filename, _) = crate::state::MODELS.iter()
            .find(|(id, _, _)| *id == model_id)
            .unwrap_or(&crate::state::MODELS[0]);
            
        model_filename.to_string()
    }
}
