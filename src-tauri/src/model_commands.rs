use tauri::{Emitter, AppHandle, Manager, WebviewWindow};
use std::sync::atomic::Ordering;
use ort::execution_providers::{CUDAExecutionProvider, CPUExecutionProvider};
use ort::execution_providers::DirectMLExecutionProvider;
use crate::model_manager::ModelManager;
use crate::types::{Status, PlaybackStatus, SongMetadata};
use crate::audio_player::sys_log;
use crate::youtube::{YoutubeManager, YoutubeSearchResult};
use ort::ep::ExecutionProvider;

use crate::youtube_url::{cache_key_variants, normalize_cache_key};

pub(crate) fn mr_separated_files_exist(paths: &crate::state::AppPaths, path: &str) -> bool {
    cache_key_variants(path).iter().any(|key| {
        let cache = paths.separated.join(urlencoding::encode(key).to_string());
        crate::mr_cache::mr_pair_exists(&cache)
    })
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GpuStatus { pub has_nvidia: bool, pub is_cuda_available: bool, pub is_directml_available: bool, pub recommend_cuda: bool }

fn directml_available() -> bool {
    DirectMLExecutionProvider::default().is_available().unwrap_or(false)
}

#[tauri::command]
pub async fn check_ai_runtime() -> Result<Vec<String>, String> {
    let mut providers = Vec::new();
    if CUDAExecutionProvider::default().is_available().unwrap_or(false) { providers.push("CUDA".to_string()); }
    if directml_available() {
        providers.push("DirectML".to_string());
    }
    if CPUExecutionProvider::default().is_available().unwrap_or(false) { providers.push("CPU".to_string()); }
    Ok(providers)
}

#[tauri::command]
pub async fn get_gpu_recommendation() -> Result<GpuStatus, String> {
    let mut has_nvidia = false;
    {
        use std::os::windows::process::CommandExt;
        let mut cmd = std::process::Command::new("wmic");
        cmd.creation_flags(0x08000000); // NO_WINDOW
        if let Ok(output) = cmd.args(["path", "win32_VideoController", "get", "name"]).output() {
            if String::from_utf8_lossy(&output.stdout).to_uppercase().contains("NVIDIA") { has_nvidia = true; }
        }
    }
    let cuda = CUDAExecutionProvider::default().is_available().unwrap_or(false);
    let dml = directml_available();
    Ok(GpuStatus { has_nvidia, is_cuda_available: cuda, is_directml_available: dml, recommend_cuda: has_nvidia && !cuda && !dml })
}

#[tauri::command]
pub async fn check_model_ready(handle: AppHandle, model_id: String) -> bool {
    let manager = ModelManager::new(&handle);
    let spec = match ModelManager::spec_from_id(&model_id) {
        Ok(spec) => spec,
        Err(_) => return false,
    };
    manager.resolve_model_path(&handle, &spec).is_some()
}

#[tauri::command]
pub async fn download_ai_model(window: WebviewWindow, model_id: String) -> Result<(), String> {
    let app = window.app_handle();
    let manager = ModelManager::new(app);
    let spec = ModelManager::spec_from_id(&model_id)?;

    window.emit("playback-status", PlaybackStatus { status: Status::Downloading, message: format!("{} 모델 다운로드...", spec.name) }).ok();
    
    match manager.ensure_model(app, &spec.name, &spec.url).await {
        Ok(path) => {
            let _ = sys_log(&format!("[Model] Ready: id={}, path={:?}", spec.id, path));
            window.emit("playback-status", PlaybackStatus { status: Status::Finished, message: format!("{} 모델 준비됨", spec.name) }).ok();
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
    let spec = ModelManager::spec_from_id(&model_id)?;

    let path = manager.get_model_path(&spec.name);
    if path.exists() {
        std::fs::remove_file(path).ok();
        let mut engine = crate::separation::ROFORMER_ENGINE.lock();
        *engine = None;
        *crate::separation::ENGINE_MODEL_ID.lock() = None;
    }
    Ok(())
}

fn active_model_filename() -> String {
    let model_id = {
        let db = crate::state::DB.lock();
        db.query_row("SELECT value FROM Settings WHERE key = 'active_model_id'", [], |row| row.get::<_, String>(0)).unwrap_or_else(|_| "kim".to_string())
    };
    ModelManager::spec_from_id(&model_id)
        .map(|spec| spec.name)
        .unwrap_or_else(|_| crate::state::MODELS[0].1.to_string())
}

/// List architecture presets available for custom models.
#[tauri::command]
pub fn list_model_presets() -> Vec<crate::custom_models::ArchPreset> {
    crate::custom_models::PRESETS.to_vec()
}

/// Combined list of built-in and custom models for the model selector.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelListEntry {
    pub id: String,
    pub name: String,
    pub is_custom: bool,
    pub preset_key: Option<String>,
}

#[tauri::command]
pub fn list_all_models() -> Vec<ModelListEntry> {
        let mut out: Vec<ModelListEntry> = crate::state::MODELS.iter()
        .map(|(id, name, _, _)| ModelListEntry {
            id: id.to_string(),
            name: name.to_string(),
            is_custom: false,
            preset_key: None,
        })
        .collect();

    for c in crate::custom_models::list() {
        out.push(ModelListEntry {
            id: c.id,
            name: c.name,
            is_custom: true,
            preset_key: Some(c.preset_key),
        });
    }
    out
}

#[tauri::command]
pub fn list_custom_models() -> Vec<crate::custom_models::CustomModel> {
    crate::custom_models::list()
}

/// Hard cap for a single custom-model HTTPS download (2 GiB). Separation
/// ONNX weights are large; anything beyond this is rejected before/during stream.
const CUSTOM_MODEL_MAX_BYTES: u64 = 2 * 1024 * 1024 * 1024;

fn normalize_sha256_hex(raw: &str) -> Result<String, String> {
    let hex = raw.trim().to_ascii_lowercase();
    if hex.len() != 64 || !hex.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err("SHA-256은 64자리 16진수여야 합니다.".into());
    }
    Ok(hex)
}

fn verify_file_sha256(path: &std::path::Path, expected_hex: &str) -> Result<(), String> {
    use sha2::{Digest, Sha256};
    use std::io::Read;
    let mut file = std::fs::File::open(path).map_err(|e| format!("검증을 위한 파일 열기 실패: {}", e))?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 64 * 1024];
    loop {
        let n = file.read(&mut buf).map_err(|e| format!("파일 읽기 실패: {}", e))?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    let actual: String = hasher.finalize().iter().map(|b| format!("{:02x}", b)).collect();
    if actual != expected_hex {
        return Err(format!("SHA-256 불일치 (expected {}, actual {})", expected_hex, actual));
    }
    Ok(())
}

fn move_into_place(temp: &std::path::Path, dest: &std::path::Path) -> Result<(), String> {
    if std::fs::rename(temp, dest).is_err() {
        std::fs::copy(temp, dest).map_err(|e| format!("파일 이동 실패: {}", e))?;
        let _ = std::fs::remove_file(temp);
    }
    Ok(())
}

/// HTTPS-only streaming download with Content-Length / body size cap and
/// mandatory SHA-256 check. On any failure the temp file is deleted.
async fn download_custom_model_https(
    window: &WebviewWindow,
    url: &str,
    expected_sha256: &str,
    dest_temp: &std::path::Path,
) -> Result<(), String> {
    use futures_util::StreamExt;
    use std::io::Write;

    if !url.starts_with("https://") {
        return Err(format!("HTTPS URL만 허용됩니다: {}", url));
    }
    let url = crate::ipc_validate::validate_public_https_url(url)?;

    let client = reqwest::Client::builder()
        .user_agent("Live-MR-Manager/custom-model")
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            let denied = || {
                std::io::Error::new(std::io::ErrorKind::PermissionDenied, "redirect blocked")
            };
            if attempt.previous().len() >= 5 {
                return attempt.error(denied());
            }
            if attempt.url().scheme() != "https" {
                return attempt.error(denied());
            }
            match attempt.url().host_str() {
                Some(host) if crate::ipc_validate::is_blocked_download_host(host) => {
                    attempt.error(denied())
                }
                Some(_) => attempt.follow(),
                None => attempt.error(denied()),
            }
        }))
        .build()
        .map_err(|e| format!("HTTP 클라이언트 생성 실패: {}", e))?;

    let response = client.get(&url).send().await.map_err(|e| format!("요청 실패: {}", e))?;
    if !response.status().is_success() {
        return Err(format!("다운로드 실패: HTTP {}", response.status()));
    }
    if let Some(len) = response.content_length() {
        if len > CUSTOM_MODEL_MAX_BYTES {
            return Err(format!(
                "서버가 보고한 파일 크기({} bytes)가 허용 상한({} bytes)을 초과합니다.",
                len, CUSTOM_MODEL_MAX_BYTES
            ));
        }
    }
    let total_for_progress = response.content_length().unwrap_or(CUSTOM_MODEL_MAX_BYTES).max(1);

    if let Some(parent) = dest_temp.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("임시 폴더 생성 실패: {}", e))?;
    }
    let _ = std::fs::remove_file(dest_temp);
    let mut file = std::fs::File::create(dest_temp).map_err(|e| format!("임시 파일 생성 실패: {}", e))?;
    let mut stream = response.bytes_stream();
    let mut downloaded: u64 = 0;

    while let Some(item) = stream.next().await {
        let chunk = item.map_err(|e| {
            let _ = std::fs::remove_file(dest_temp);
            e.to_string()
        })?;
        downloaded = downloaded.saturating_add(chunk.len() as u64);
        if downloaded > CUSTOM_MODEL_MAX_BYTES {
            drop(file);
            let _ = std::fs::remove_file(dest_temp);
            return Err(format!(
                "다운로드 용량이 허용 상한({} bytes)을 초과했습니다.",
                CUSTOM_MODEL_MAX_BYTES
            ));
        }
        if let Err(e) = file.write_all(&chunk) {
            drop(file);
            let _ = std::fs::remove_file(dest_temp);
            return Err(e.to_string());
        }
        let pct = ((downloaded as f64 / total_for_progress as f64) * 100.0).min(99.0);
        let _ = window.emit(
            "custom-model-download-progress",
            serde_json::json!({ "percentage": pct }),
        );
    }
    drop(file);

    if let Err(e) = verify_file_sha256(dest_temp, expected_sha256) {
        let _ = std::fs::remove_file(dest_temp);
        return Err(format!("무결성 검증에 실패했습니다({}).", e));
    }
    let _ = window.emit(
        "custom-model-download-progress",
        serde_json::json!({ "percentage": 100.0 }),
    );
    Ok(())
}

async fn validate_onnx_rank_against_preset(
    dest: &std::path::Path,
    expected_rank: usize,
) -> Result<(), String> {
    let dest_for_check = dest.to_path_buf();
    let rank_res = tokio::task::spawn_blocking(move || -> Result<usize, String> {
        let session = ort::session::Session::builder()
            .map_err(|e| e.to_string())?
            .with_optimization_level(ort::session::builder::GraphOptimizationLevel::Disable)
            .map_err(|e| e.to_string())?
            .commit_from_file(&dest_for_check)
            .map_err(|e| format!("유효한 ONNX 파일이 아닙니다: {}", e))?;
        match session.inputs()[0].dtype() {
            ort::value::ValueType::Tensor { shape, .. } => Ok(shape.len()),
            _ => Ok(0),
        }
    })
    .await
    .map_err(|e| e.to_string())?;

    match rank_res {
        Ok(rank) if rank == expected_rank => Ok(()),
        Ok(rank) => Err(format!(
            "모델 입력 형식이 프리셋과 맞지 않습니다 (입력 rank {}, 기대 rank {}). 아키텍처 프리셋을 다시 확인해주세요.",
            rank, expected_rank
        )),
        Err(e) => Err(e),
    }
}

/// Register a custom model from a local ONNX file (`source_kind = "file"`) or
/// an HTTPS URL (`source_kind = "url"`). URL mode requires `expected_sha256`,
/// enforces a 2 GiB size cap, streams to a temp file, verifies the hash, then
/// atomically moves into the models directory before ONNX rank checks.
#[tauri::command]
pub async fn add_custom_model(
    window: WebviewWindow,
    name: String,
    source_kind: String,
    source: String,
    preset_key: String,
    expected_sha256: Option<String>,
) -> Result<crate::custom_models::CustomModel, String> {
    if source_kind != "file" && source_kind != "url" {
        return Err(format!("알 수 없는 소스 종류: {}", source_kind));
    }
    if name.trim().is_empty() {
        return Err("모델 이름을 입력해주세요.".into());
    }
    let preset = crate::custom_models::preset_by_key(&preset_key)
        .ok_or_else(|| format!("알 수 없는 아키텍처 프리셋: {}", preset_key))?;

    let id = format!(
        "custom_{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0)
    );
    let filename = format!("{}.onnx", id);

    // Clone paths before any `.await` so we don't hold the `State` guard
    // across a suspension point (which would make the future non-Send).
    let models_dir = window.state::<crate::state::AppPaths>().models.clone();
    let dest = models_dir.join(&filename);
    let stored_url;

    if source_kind == "file" {
        let picked = rfd::AsyncFileDialog::new()
            .add_filter("ONNX Model", &["onnx"])
            .pick_file()
            .await
            .ok_or_else(|| "CANCELLED".to_string())?;
        let src = picked.path().to_path_buf();
        std::fs::copy(&src, &dest).map_err(|e| format!("모델 파일 복사 실패: {}", e))?;
        stored_url = String::new();
        let _ = source;
        let _ = expected_sha256;
    } else {
        let url = source.trim();
        if url.is_empty() {
            return Err("다운로드 URL을 입력해주세요.".into());
        }
        crate::ipc_validate::require_max_len(url, crate::ipc_validate::MAX_URL_LEN, "다운로드 URL")?;
        let url = crate::ipc_validate::validate_public_https_url(url)?;
        let sha = normalize_sha256_hex(
            expected_sha256
                .as_deref()
                .ok_or_else(|| "URL 등록에는 SHA-256 해시가 필요합니다.".to_string())?,
        )?;
        let temp = models_dir.join(format!("{}.part", filename));
        if let Err(e) = download_custom_model_https(&window, &url, &sha, &temp).await {
            let _ = std::fs::remove_file(&temp);
            return Err(e);
        }
        if let Err(e) = move_into_place(&temp, &dest) {
            let _ = std::fs::remove_file(&temp);
            let _ = std::fs::remove_file(&dest);
            return Err(e);
        }
        stored_url = url.to_string();
    }

    // Validate the ONNX input signature against the chosen preset. RawWaveform
    // models take a rank-3 waveform input [1, 2, N]; spectrogram models take
    // rank 4.
    let expected_rank: usize = match preset.engine {
        crate::vocal_remover::EngineKind::RawWaveform => 3,
        crate::vocal_remover::EngineKind::Spectrogram => 4,
    };

    if let Err(e) = validate_onnx_rank_against_preset(&dest, expected_rank).await {
        let _ = std::fs::remove_file(&dest);
        return Err(e);
    }

    let model = crate::custom_models::CustomModel {
        id,
        name: name.trim().to_string(),
        filename,
        url: stored_url,
        preset_key,
    };
    crate::custom_models::insert(&model)?;
    let _ = sys_log(&format!(
        "[Model] Custom model added: id={}, preset={}, via={}",
        model.id,
        model.preset_key,
        if model.url.is_empty() { "file" } else { "url" }
    ));
    Ok(model)
}

#[tauri::command]
pub async fn remove_custom_model(window: WebviewWindow, model_id: String) -> Result<(), String> {
    let custom = crate::custom_models::get(&model_id)
        .ok_or_else(|| format!("Unknown custom model: {}", model_id))?;

    // Remove the model file from disk.
    let paths = window.state::<crate::state::AppPaths>();
    let file = paths.models.join(&custom.filename);
    if file.exists() {
        std::fs::remove_file(&file).ok();
    }

    crate::custom_models::delete(&model_id)?;

    // If this was the active model, revert to the default built-in one and drop
    // any loaded engine so the next separation reloads.
    {
        let db = crate::state::DB.lock();
        let active: String = db.query_row("SELECT value FROM Settings WHERE key = 'active_model_id'", [], |row| row.get(0)).unwrap_or_default();
        if active == model_id {
            db.execute("INSERT OR REPLACE INTO Settings (key, value) VALUES ('active_model_id', 'kim')", []).ok();
            let mut engine = crate::separation::ROFORMER_ENGINE.lock();
            *engine = None;
            *crate::separation::ENGINE_MODEL_ID.lock() = None;
        }
    }
    Ok(())
}

#[tauri::command]
pub fn get_mr_cache_format() -> String {
    crate::mr_cache::current_format().as_str().to_string()
}

#[tauri::command]
pub fn set_mr_cache_format(format: String) -> Result<(), String> {
    crate::mr_cache::set_format(&format)?;
    sys_log(&format!(
        "MR cache format set to: {}",
        crate::mr_cache::current_format().as_str()
    ));
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
pub async fn start_mr_separation(window: WebviewWindow, path: String, model_id: Option<String>) -> Result<(), String> {
    let path = crate::ipc_validate::validate_audio_source(&path)?;
    let norm = normalize_cache_key(&path);
    if crate::separation::ACTIVE_SEPARATIONS.lock().contains_key(&norm) {
        let _ = sys_log(&format!("[Command] [Error] start_mr_separation failed: ALREADY_PROCESSING for {}", path));
        return Err("ALREADY_PROCESSING".into()); 
    }

    // Per-request model choice (속도/품질 선택 모달). Validate up front so a
    // bad id fails the request instead of surfacing mid-queue as a task error.
    if let Some(ref id) = model_id {
        ModelManager::spec_from_id(id).map_err(|_| format!("알 수 없는 분리 모델: {}", id))?;
    }

    let cache = window.state::<crate::state::AppPaths>().separated.join(urlencoding::encode(&norm).to_string());
    let task = crate::separation::task::SeparationTask::new(window, path, cache, model_id);
    tauri::async_runtime::spawn(async move { task.run().await; });
    Ok(())
}

#[tauri::command]
pub fn cancel_separation(window: WebviewWindow, path: String) -> Result<(), String> {
    let norm = normalize_cache_key(&path);
    let removed = if let Some((original_path, flag)) = crate::separation::ACTIVE_SEPARATIONS.lock().remove(&norm) {
        flag.store(true, Ordering::Relaxed);
        window.emit("separation-progress", crate::separation::SeparationProgress {
            path: original_path,
            percentage: 0.0,
            status: "Cancelled".into(),
            provider: "SYSTEM".into(),
            model: active_model_filename(),
        }).ok();
        true
    } else {
        false
    };
    crate::audio_player::CANCEL_REQUESTS.lock().insert(norm);
    if !removed {
        window.emit("separation-progress", crate::separation::SeparationProgress {
            path,
            percentage: 0.0,
            status: "Cancelled".into(),
            provider: "SYSTEM".into(),
            model: active_model_filename(),
        }).ok();
    }
    Ok(())
}

#[tauri::command]
pub async fn youtube_metadata_fetcher(url: String) -> Result<SongMetadata, String> {
    let url = crate::ipc_validate::validate_youtube_or_http_url(&url)?;
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
                ..Default::default()
            })
        },
        Err(e) => {
            sys_log(&format!("[Youtube] Fetch failed for {}: {}", url, e));
            Err(e)
        }
    }
}

#[tauri::command]
pub async fn search_youtube(
    query: String,
    limit: Option<usize>,
) -> Result<Vec<YoutubeSearchResult>, String> {
    let query = crate::ipc_validate::validate_search_query(&query)?;
    let limit = limit.unwrap_or(10).clamp(1, 25);
    let results = YoutubeManager::search_videos(&query, limit).await?;
    if let Err(err) = serde_json::to_vec(&results) {
        crate::audio_player::sys_log(&format!("[Youtube] search serialize failed: {err}"));
        return Err("검색 결과를 화면에 전달하지 못했습니다.".into());
    }
    Ok(results)
}

#[tauri::command]
pub fn check_mr_separated(window: WebviewWindow, path: String) -> bool {
    let paths = window.state::<crate::state::AppPaths>();
    mr_separated_files_exist(paths.inner(), &path)
}

/// 곡별 MR 분리 기록 조회 — 분리 완료 시 캐시 폴더에 함께 저장되는
/// `separation_info.json`({modelId, modelName, provider, completedAt})을
/// 읽어 반환한다. 기록이 없으면(구버전에서 분리했거나 미분리) None.
#[tauri::command]
pub fn get_separation_info(window: WebviewWindow, path: String) -> Option<serde_json::Value> {
    let separated_root = window.state::<crate::state::AppPaths>().separated.clone();
    for key in cache_key_variants(&path) {
        let info_path = separated_root
            .join(urlencoding::encode(&key).to_string())
            .join("separation_info.json");
        if let Ok(content) = std::fs::read_to_string(&info_path) {
            if let Ok(value) = serde_json::from_str::<serde_json::Value>(&content) {
                return Some(value);
            }
        }
    }
    None
}

#[tauri::command]
pub fn delete_mr(window: WebviewWindow, path: String) -> Result<(), String> {
    let separated_root = window.state::<crate::state::AppPaths>().separated.clone();
    for key in cache_key_variants(&path) {
        let cache = separated_root.join(urlencoding::encode(&key).to_string());
        if cache.exists() {
            crate::mr_cache::delete_mr_stems(&cache).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}
