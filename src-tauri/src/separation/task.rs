use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering, AtomicU32, AtomicU64};
use std::path::PathBuf;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{Emitter, WebviewWindow, Manager};
use tokio::sync::oneshot;

use crate::vocal_remover::{InferenceEngine, WaveformRemover};
use crate::model_manager::{ModelManager, ModelSpec};
use crate::youtube::YoutubeManager;
use crate::audio_player::sys_log;
use crate::youtube_url::normalize_cache_key;
use super::{SeparationProgress, ROFORMER_ENGINE, ENGINE_MODEL_ID, AI_QUEUE_LOCK, ACTIVE_SEPARATIONS, MODEL_INIT_LOCK, MODEL_INIT_COOLDOWN_UNTIL};

static MODEL_INIT_ATTEMPT_SEQ: AtomicU64 = AtomicU64::new(1);
static MODEL_INIT_INFLIGHT: AtomicU32 = AtomicU32::new(0);
static MODEL_INIT_TIMEOUT_STREAK: AtomicU32 = AtomicU32::new(0);

pub struct SeparationTask {
    window: WebviewWindow,
    path: String,
    cache_dir: PathBuf,
    /// Per-request model choice (e.g. "빠른 분리" vs "고품질 분리" from the
    /// separation-method picker). None falls back to the global
    /// `active_model_id` setting. Captured at enqueue time so later changes
    /// to the global setting don't retroactively affect queued tasks.
    model_override: Option<String>,
}

impl SeparationTask {
    fn model_init_timeout_secs() -> u64 {
        90
    }

    fn allow_fallback_after_timeout() -> bool {
        true
    }

    fn model_init_cooldown_secs() -> u64 {
        120
    }

    fn model_init_timeout_streak_threshold() -> u32 {
        u32::MAX
    }

    fn model_init_circuit_breaker_secs() -> u64 {
        0
    }

    pub fn new(window: WebviewWindow, path: String, cache_dir: PathBuf, model_override: Option<String>) -> Self {
        Self { window, path, cache_dir, model_override }
    }

    /// Orchestrates the entire separation process.
    pub async fn run(self) {
        let window = self.window;
        let path = self.path;
        let cache_dir = self.cache_dir;
        // Resolve the model for this task once, up front: explicit override
        // (per-request 속도/품질 choice) wins, else the global setting.
        let task_model_id = self.model_override.unwrap_or_else(Self::read_active_model_id);
        let task_model_name = Self::model_name_for(&task_model_id);

        // 1. Normalize path and register in active map immediately to prevent duplicates.
        // Must match the exact same normalization `cancel_separation`/`start_mr_separation`
        // use (model_commands.rs), or a cancel request for a queued-but-not-yet-started
        // task silently misses its `ACTIVE_SEPARATIONS`/`CANCEL_REQUESTS` entry (this was
        // previously a bare backslash replace, which diverges from `normalize_cache_key`
        // for YouTube URLs — e.g. `youtu.be/...` short links or `watch?v=...&list=...`
        // links — letting a "cancelled" queued job start anyway once its turn came up).
        let norm_p = normalize_cache_key(&path);

        // If a cancel was already requested before the task reached this point, abort immediately.
        if crate::audio_player::CANCEL_REQUESTS.lock().remove(&norm_p) {
            window.emit("separation-progress", SeparationProgress {
                path: path.clone(),
                percentage: 0.0,
                status: "Cancelled".into(),
                provider: "SYSTEM".into(),
                model: task_model_name.clone(),
            }).ok();
            return;
        }

        let cancel_flag = Arc::new(AtomicBool::new(false));
        {
            let mut active = ACTIVE_SEPARATIONS.lock();
            active.insert(norm_p.clone(), (path.clone(), cancel_flag.clone()));
        }

        // 2. Initial status: Queued (Waiting for Lock)
        let default_model = task_model_name.clone();
        window.emit("separation-progress", SeparationProgress {
            path: path.clone(),
            percentage: 0.0,
            status: "Queued".into(),
            provider: "SYSTEM".into(),
            model: default_model.clone(),
        }).ok();

        // 3. Wait for Global AI Queue Lock (One task at a time)
        let queue_wait_started = std::time::Instant::now();
        let _permit = AI_QUEUE_LOCK.lock().await;
        sys_log(&format!(
            "[AI-QUEUE] lock acquired: wait_ms={}, active_separations={}",
            queue_wait_started.elapsed().as_millis(),
            ACTIVE_SEPARATIONS.lock().len()
        ));

        // 3.1. Check if cancelled while waiting
        if cancel_flag.load(Ordering::Relaxed) {
            return; // Already removed from map by cancel_separation
        }

        // 4. Ensure AI Engine is loaded
        let engine = match Self::ensure_engine(&window, &path, &task_model_id).await {
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
        Self::execute_separation(window, path, source_path, cache_dir, engine, cancel_flag, norm_p, task_model_id).await;
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

    fn model_name_for(model_id: &str) -> String {
        crate::model_manager::ModelManager::spec_from_id(model_id)
            .map(|spec| spec.name)
            .unwrap_or_else(|_| crate::state::MODELS[0].1.to_string())
    }

    /// Returns the cached engine only if it was built with `wanted_model_id`;
    /// a per-task model override can differ from whatever the cache holds, in
    /// which case the stale engine is dropped so it gets rebuilt below.
    fn cached_engine_for(wanted_model_id: &str) -> Option<Arc<dyn InferenceEngine>> {
        let engine_guard = ROFORMER_ENGINE.lock();
        let engine = engine_guard.as_ref()?;
        let id_guard = ENGINE_MODEL_ID.lock();
        match id_guard.as_deref() {
            Some(cached_id) if cached_id == wanted_model_id => Some(engine.clone()),
            _ => None,
        }
    }

    async fn ensure_engine(window: &WebviewWindow, path: &str, wanted_model_id: &str) -> Result<Arc<dyn InferenceEngine>, String> {
        if let Some(engine) = Self::cached_engine_for(wanted_model_id) {
            return Ok(engine);
        }

        // Single-flight model init: one initializer at a time across all tasks.
        let init_lock_wait_started = std::time::Instant::now();
        let _init_guard = MODEL_INIT_LOCK.lock().await;
        sys_log(&format!(
            "[AI-ENGINE] model-init lock acquired: wait_ms={}, inflight_init_tasks={}",
            init_lock_wait_started.elapsed().as_millis(),
            MODEL_INIT_INFLIGHT.load(Ordering::Relaxed)
        ));

        // Re-check after waiting for lock in case another task initialized it
        // (only usable if it was built with the model this task wants).
        if let Some(engine) = Self::cached_engine_for(wanted_model_id) {
            return Ok(engine);
        }

        let now = Self::now_secs();
        let cooldown_until = MODEL_INIT_COOLDOWN_UNTIL.load(Ordering::Relaxed);
        if cooldown_until > now {
            let wait_sec = cooldown_until - now;
            let err = format!(
                "Error: 모델 초기화 재시도 대기 중 ({}초 후 가능). 앱 재시작 또는 모델 재다운로드를 권장합니다.",
                wait_sec
            );
            Self::emit_error(window, path, &err, "SYSTEM", &Self::model_name_for(wanted_model_id));
            return Err(err);
        }

        window.emit("separation-progress", SeparationProgress {
            path: path.to_string(),
            percentage: 0.0,
            status: "AI 모델 로딩 중...".into(),
            provider: "SYSTEM".into(),
            model: Self::model_name_for(wanted_model_id),
        }).ok();

        let app = window.app_handle();
        let manager = ModelManager::new(app);
        let primary_model_id = wanted_model_id.to_string();
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
                    let attempt_id = MODEL_INIT_ATTEMPT_SEQ.fetch_add(1, Ordering::Relaxed);
                    let file_size = resolution.path.metadata().map(|m| m.len()).unwrap_or(0);
                    sys_log(&format!(
                        "[AI-ENGINE] Init start: attempt={}, id={}, source={}, path={:?}, size={} bytes",
                        attempt_id,
                        resolution.spec.id,
                        resolution.source,
                        resolution.path,
                        file_size
                    ));

                    let model_path_for_spawn = resolution.path.clone();
                    let model_id_for_spawn = resolution.spec.id.clone();
                    let model_params_for_spawn = resolution.spec.params.clone();
                    let init_started = std::time::Instant::now();
                    // Large raw-waveform models (Mel-Band RoFormer, ~1GB) can
                    // take far longer than 90s to load onto the GPU.
                    let timeout_secs = if resolution.spec.params.as_ref()
                        .map_or(false, |p| p.engine == crate::vocal_remover::EngineKind::RawWaveform)
                    {
                        300
                    } else {
                        Self::model_init_timeout_secs()
                    };
                    let spawn_wait_started = std::time::Instant::now();
                    MODEL_INIT_INFLIGHT.fetch_add(1, Ordering::Relaxed);
                    sys_log(&format!(
                        "[AI-ENGINE] Init spawn: attempt={}, timeout_secs={}, inflight_now={}",
                        attempt_id,
                        timeout_secs,
                        MODEL_INIT_INFLIGHT.load(Ordering::Relaxed)
                    ));
                    let init_result = tokio::time::timeout(
                        Duration::from_secs(timeout_secs),
                        tokio::task::spawn_blocking(move || {
                            WaveformRemover::new_with_params(&model_path_for_spawn, Some(&model_id_for_spawn), model_params_for_spawn)
                        })
                    ).await;
                    let inflight_after_wait = MODEL_INIT_INFLIGHT.fetch_sub(1, Ordering::Relaxed).saturating_sub(1);
                    sys_log(&format!(
                        "[AI-ENGINE] Init wait done: attempt={}, wait_ms={}, inflight_now={}",
                        attempt_id,
                        spawn_wait_started.elapsed().as_millis(),
                        inflight_after_wait
                    ));

                    match init_result {
                        Ok(join_res) => match join_res {
                            Ok(Ok(remover)) => {
                                MODEL_INIT_TIMEOUT_STREAK.store(0, Ordering::Relaxed);
                                sys_log(&format!(
                                    "[AI-ENGINE] Init success: attempt={}, id={}, elapsed_ms={}",
                                    attempt_id,
                                    resolution.spec.id,
                                    init_started.elapsed().as_millis()
                                ));
                                let engine_arc = Arc::new(remover);
                                let mut guard = ROFORMER_ENGINE.lock();
                                *guard = Some(engine_arc.clone());
                                *ENGINE_MODEL_ID.lock() = Some(resolution.spec.id.clone());
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
                            last_error = format!("모델 로딩 시간 초과 ({}): {}초", resolution.spec.name, timeout_secs);
                            sys_log(&format!("[AI-ENGINE] {}", last_error));
                            let streak = MODEL_INIT_TIMEOUT_STREAK.fetch_add(1, Ordering::Relaxed) + 1;
                            // Throttle next attempts for a short period to avoid piling blocked inits.
                            let mut cooldown_secs = Self::model_init_cooldown_secs();
                            if streak >= Self::model_init_timeout_streak_threshold() {
                                let breaker = Self::model_init_circuit_breaker_secs();
                                if breaker > cooldown_secs {
                                    cooldown_secs = breaker;
                                }
                                sys_log(&format!(
                                    "[AI-ENGINE] Circuit breaker activated: streak={}, cooldown_secs={}",
                                    streak, cooldown_secs
                                ));
                            }
                            MODEL_INIT_COOLDOWN_UNTIL.store(Self::now_secs() + cooldown_secs, Ordering::Relaxed);
                            if !Self::allow_fallback_after_timeout() {
                                break;
                            }
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
        norm_p: String,
        task_model_id: String,
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

            let w_first = w.clone();
            let path_first = p_for_progress.clone();
            let info_first = info.clone();
            let model_first = model.clone();
            let cancel_first = cancel_flag_for_progress.clone();
            let cancel_separate_first = cancel_flag_for_separate.clone();
            sys_log("[AI-ENGINE] Separation start");
            let separation_result = engine_for_spawn.separate(
                &source_path,
                &cache_dir_clone,
                cancel_separate_first,
                Box::new(move |percentage| {
                    if cancel_first.load(Ordering::Relaxed) { return; }
                    
                    let last = f32::from_bits(last_p_progress.load(Ordering::Relaxed));
                    if (percentage - last).abs() >= 0.5 || percentage >= 100.0 || percentage <= 0.0 {
                        last_p_progress.store(f32::to_bits(percentage), Ordering::Relaxed);
                        let _ = w_first.emit("separation-progress", SeparationProgress {
                            path: path_first.clone(),
                            percentage,
                            status: "Processing".into(),
                            provider: info_first.clone(),
                            model: model_first.clone(),
                        });
                    }
                })
            ).map_err(|e| e.to_string());

            if let Err(e) = &separation_result {
                sys_log(&format!("[AI-ENGINE] Separation failed: {}", e));
            }

            // Clean up from active map (already normalized by `normalize_cache_key`
            // when this task registered itself; no need to re-normalize here).
            {
                let mut active = ACTIVE_SEPARATIONS.lock();
                active.remove(&p_for_cleanup);
            }
            
            let _ = tx.send(separation_result.map(|_| ()));
        });

        // Await thread result
        match rx.await {
            Ok(Ok(_)) => {
                // 어떤 모델로 분리했는지 곡별로 기록 — 분리 산출물 옆에 저장해서
                // MR 캐시 삭제/재분리 시 자연스럽게 함께 갱신·폐기되게 한다.
                Self::write_separation_info(&cache_dir, &task_model_id, &engine.get_model_name(), &engine.get_provider());
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
                let status = if e.contains("Cancelled") {
                    "Cancelled".to_string()
                } else if Self::is_gpu_device_removed_error(&e) {
                    // The D3D/DXGI device behind this session is permanently gone.
                    // Evict the cached engine so the next attempt builds a fresh
                    // session (picking up any provider-order fix, e.g. skipping
                    // DirectML for heavy RawWaveform models).
                    sys_log(&format!("[AI-ENGINE] GPU device removed, evicting cached engine: {}", e));
                    *ROFORMER_ENGINE.lock() = None;
                    *ENGINE_MODEL_ID.lock() = None;
                    "Error: GPU 처리 중 그래픽 드라이버가 응답하지 않아 중단되었습니다. 다시 시도해주세요 (자동으로 다른 처리 방식으로 전환됩니다).".to_string()
                } else {
                    sys_log(&format!("[AI-ENGINE] Separation failed: {}", e));
                    format!("Error: {}", e)
                };
                window.emit("separation-progress", SeparationProgress {
                    path: path.clone(),
                    percentage: 0.0,
                    status,
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

    /// Persists which model produced this song's separated stems, next to the
    /// stems themselves (`separation_info.json` in the cache dir). Failure is
    /// non-fatal — this is informational metadata only.
    fn write_separation_info(cache_dir: &PathBuf, model_id: &str, model_name: &str, provider: &str) {
        let completed_at = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let info = serde_json::json!({
            "modelId": model_id,
            "modelName": model_name,
            "provider": provider,
            "completedAt": completed_at,
        });
        let path = cache_dir.join("separation_info.json");
        if let Err(e) = std::fs::write(&path, info.to_string()) {
            sys_log(&format!("[AI-ENGINE] Failed to write separation info: {}", e));
        }
    }

    /// Detects the DXGI/D3D "device removed" family of errors that ONNX
    /// Runtime's DirectML EP surfaces when the Windows TDR watchdog kills a
    /// GPU dispatch that ran too long. HRESULT 887A0005 is
    /// DXGI_ERROR_DEVICE_REMOVED; the accompanying message may be mangled by
    /// console codepage translation, so match on the stable hex code instead
    /// of the localized text.
    fn is_gpu_device_removed_error(e: &str) -> bool {
        e.contains("887A0005")
            || e.contains("DXGI_ERROR_DEVICE_REMOVED")
            || e.contains("DXGI_ERROR_DEVICE_HUNG")
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
        let model_id = {
            let db = crate::state::DB.lock();
            db.query_row("SELECT value FROM Settings WHERE key = 'active_model_id'", [], |row| row.get::<_, String>(0)).unwrap_or_else(|_| "kim".to_string())
        };

        crate::model_manager::ModelManager::spec_from_id(&model_id)
            .map(|spec| spec.name)
            .unwrap_or_else(|_| crate::state::MODELS[0].1.to_string())
    }
}
