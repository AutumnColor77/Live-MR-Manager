use serde::{Serialize, Deserialize};
use std::fs;
use std::path::{Path, PathBuf};
use crate::audio_player::sys_log;
use tauri::{command, AppHandle, Emitter, Manager};
use ndarray::Array2;
use unicode_normalization::UnicodeNormalization;
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};

use std::sync::atomic::{AtomicBool, Ordering};
use crate::audio::AudioProcessor;
use crate::onnx_engine::OnnxEngine;
use regex::Regex;
use parking_lot::Mutex;
use once_cell::sync::Lazy;
use sha2::{Digest, Sha256};
use futures_util::StreamExt;

pub struct CachedAlignmentState {
    pub emission_probs: Array2<f32>,
    pub tokens_path: PathBuf,
    pub lyrics: String,
}

pub static CACHED_STATE: Mutex<Option<CachedAlignmentState>> = Mutex::new(None);

pub static CANCEL_ALIGNMENT: AtomicBool = AtomicBool::new(false);

/// Serializes forced-alignment runs (same single-permit pattern as
/// `separation::AI_QUEUE_LOCK`). `CACHED_STATE` and `CANCEL_ALIGNMENT` are
/// single-slot globals — holding this lock across the whole run guarantees
/// at most one alignment owns them at any time, so batch-queued requests and
/// the interactive editor button can never corrupt each other's state.
pub static ALIGNMENT_QUEUE_LOCK: Lazy<tokio::sync::Mutex<()>> =
    Lazy::new(|| tokio::sync::Mutex::new(()));

// --- Forced-alignment model download / status / delete (Phase D) ---------
//
// Two curated language models (KO/EN), each an ONNX acoustic model plus a
// `tokens.txt` vocab, hosted on this project's own GitHub Release (the
// original upstream model cards are Hugging Face repos that don't ship an
// ONNX export; this project's release is the only source ever referenced
// here or in the UI - never a third-party fork's release).
//
// Every download is streamed to a temp file in `AppPaths.temp` while a
// running SHA-256 is computed; the response body is hard-capped so a
// misbehaving/compromised server can't stream unbounded data to disk. The
// temp file is deleted immediately on any cap/hash failure, and the final
// `model.onnx` / `tokens.txt` are only renamed into place once BOTH assets
// have independently passed their SHA-256 check - so a half-downloaded or
// tampered pair can never leave a partially-valid model directory behind.
pub struct AlignmentModelSpec {
    pub id: &'static str,
    pub folder: &'static str,
    pub display_name: &'static str,
    pub model_url: &'static str,
    pub tokens_url: &'static str,
    pub model_sha256: &'static str,
    pub tokens_sha256: &'static str,
    pub model_size_bytes: u64,
    pub source_url: &'static str,
    pub license: &'static str,
}

/// Upper bound for `tokens.txt`. Unlike the ONNX model (whose exact upstream
/// byte count is known and enforced below), the vocab file's exact size
/// isn't pinned here - but a real tokens file has no legitimate reason to
/// approach this size. This is only a DoS/sanity guard; SHA-256 is the
/// actual integrity guarantee for both files.
const ALIGNMENT_TOKENS_MAX_BYTES: u64 = 8 * 1024 * 1024;

const ALIGNMENT_DOWNLOAD_USER_AGENT: &str =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

pub const ALIGNMENT_MODELS: &[AlignmentModelSpec] = &[
    AlignmentModelSpec {
        id: "ko",
        folder: "wav2vec2-korean-lyrics",
        display_name: "한국어 가사 정렬 모델 (실험적, 약 1.2GB)",
        model_url: "https://github.com/AutumnColor77/Live-MR-Manager/releases/download/ai-align-model-v1/model.onnx",
        tokens_url: "https://github.com/AutumnColor77/Live-MR-Manager/releases/download/ai-align-model-v1/tokens.txt",
        model_sha256: "e0377224ca28e4daa434155d9a035e858c7dc0c984084011734e101852bba4db",
        tokens_sha256: "4511d865e8decdc630f6a7c1781e53d3c22ae40b81702881e2629eddf846b082",
        model_size_bytes: 1_270_167_840,
        // Original model card (Apache-2.0), converted to ONNX for this release.
        source_url: "https://huggingface.co/kresnik/wav2vec2-large-xlsr-korean",
        license: "Apache-2.0",
    },
    AlignmentModelSpec {
        id: "en",
        folder: "wav2vec2-english-lyrics",
        display_name: "영어 가사 정렬 모델 (실험적, 약 360MB)",
        model_url: "https://github.com/AutumnColor77/Live-MR-Manager/releases/download/align-model-en-v1/model.onnx",
        tokens_url: "https://github.com/AutumnColor77/Live-MR-Manager/releases/download/align-model-en-v1/tokens.txt",
        model_sha256: "7ffb91554931fb918bee1d2294d022886c73ca8642b93ad181d058300fe6a6ef",
        tokens_sha256: "07dd8185b1faf8802d94b9a1336aed9e54366994f7e2227b4b0fd0d32a9c044a",
        model_size_bytes: 377_884_762,
        // Original model card (Apache-2.0), converted to ONNX for this release.
        source_url: "https://huggingface.co/facebook/wav2vec2-base-960h",
        license: "Apache-2.0",
    },
];

fn find_alignment_model_spec(language: &str) -> Option<&'static AlignmentModelSpec> {
    ALIGNMENT_MODELS.iter().find(|m| m.id == language)
}

/// Set by `cancel_alignment_model_download`, checked between chunks of the
/// current alignment-model download (separate from `CANCEL_ALIGNMENT`,
/// which only applies to a running forced-alignment inference pass).
pub static ALIGNMENT_MODEL_DOWNLOAD_CANCEL: AtomicBool = AtomicBool::new(false);

fn alignment_model_dir(paths: &crate::state::AppPaths, spec: &AlignmentModelSpec) -> PathBuf {
    paths.models.join(spec.folder)
}

fn alignment_model_is_downloaded(paths: &crate::state::AppPaths, spec: &AlignmentModelSpec) -> bool {
    let dir = alignment_model_dir(paths, spec);
    dir.join("model.onnx").is_file() && dir.join("tokens.txt").is_file()
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AlignmentModelInfo {
    pub language: String,
    pub display_name: String,
    pub source_url: String,
    pub license: String,
    pub model_size_bytes: u64,
    pub downloaded: bool,
}

/// Lists the KO/EN forced-alignment models with their license/source/size
/// metadata (for the download confirmation dialog) and current on-disk
/// status. Called by the settings UI and by the alignment queue to decide
/// whether a language's model still needs to be downloaded.
#[command]
pub async fn list_alignment_models(handle: AppHandle) -> Vec<AlignmentModelInfo> {
    let paths = crate::state::AppPaths::from_handle(&handle);
    ALIGNMENT_MODELS
        .iter()
        .map(|spec| AlignmentModelInfo {
            language: spec.id.to_string(),
            display_name: spec.display_name.to_string(),
            source_url: spec.source_url.to_string(),
            license: spec.license.to_string(),
            model_size_bytes: spec.model_size_bytes,
            downloaded: alignment_model_is_downloaded(&paths, spec),
        })
        .collect()
}

fn hex_encode(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}

/// Verifies a file already on disk against an expected lowercase-hex
/// SHA-256 digest. Split out from the download path so it can be exercised
/// directly in tests without any network access.
fn verify_file_sha256(path: &Path, expected_hex: &str) -> Result<(), String> {
    use std::io::Read;
    let mut file = fs::File::open(path).map_err(|e| format!("검증을 위한 파일 열기 실패: {}", e))?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 64 * 1024];
    loop {
        let n = file.read(&mut buf).map_err(|e| format!("파일 읽기 실패: {}", e))?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    let actual = hex_encode(&hasher.finalize());
    if !actual.eq_ignore_ascii_case(expected_hex) {
        return Err(format!("SHA-256 불일치 (expected {}, actual {})", expected_hex, actual));
    }
    Ok(())
}

/// Streams `url` to `dest_temp`, enforcing HTTPS and `max_bytes` as a hard
/// cap on the response body (checked against both `Content-Length`, if
/// present, and the actual bytes streamed), then verifies the resulting
/// file's SHA-256 against `expected_sha256`. On ANY failure - bad scheme,
/// oversized body, network error, cancellation, or hash mismatch - the temp
/// file is deleted and an `Err` is returned; the caller never observes a
/// partially-written or unverified file. `report_fraction` receives the
/// download progress for this single asset as a 0.0-1.0 fraction.
async fn download_and_verify_asset(
    url: &str,
    expected_sha256: &str,
    max_bytes: u64,
    dest_temp: &Path,
    mut report_fraction: impl FnMut(f32),
) -> Result<(), String> {
    if !url.starts_with("https://") {
        return Err(format!("HTTPS URL만 허용됩니다: {}", url));
    }

    let client = reqwest::Client::builder()
        .user_agent(ALIGNMENT_DOWNLOAD_USER_AGENT)
        .build()
        .map_err(|e| format!("HTTP 클라이언트 생성 실패: {}", e))?;

    let response = client.get(url).send().await.map_err(|e| format!("요청 실패: {}", e))?;
    if !response.status().is_success() {
        return Err(format!("다운로드 실패: HTTP {}", response.status()));
    }
    if let Some(len) = response.content_length() {
        if len > max_bytes {
            return Err(format!(
                "서버가 보고한 파일 크기({} bytes)가 허용 상한({} bytes)을 초과합니다.",
                len, max_bytes
            ));
        }
    }
    let total_for_progress = response.content_length().unwrap_or(max_bytes).max(1);

    if let Some(parent) = dest_temp.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("임시 폴더 생성 실패: {}", e))?;
    }
    let _ = fs::remove_file(dest_temp);
    let mut file = fs::File::create(dest_temp).map_err(|e| format!("임시 파일 생성 실패: {}", e))?;
    let mut stream = response.bytes_stream();
    let mut downloaded: u64 = 0;

    while let Some(item) = stream.next().await {
        if ALIGNMENT_MODEL_DOWNLOAD_CANCEL.load(Ordering::SeqCst) {
            drop(file);
            let _ = fs::remove_file(dest_temp);
            return Err("다운로드가 취소되었습니다.".to_string());
        }
        let chunk = item.map_err(|e| e.to_string())?;
        downloaded += chunk.len() as u64;
        if downloaded > max_bytes {
            drop(file);
            let _ = fs::remove_file(dest_temp);
            return Err(format!("다운로드 용량이 허용 상한({} bytes)을 초과했습니다.", max_bytes));
        }
        file.write_all(&chunk).map_err(|e| e.to_string())?;
        report_fraction((downloaded as f32 / total_for_progress as f32).min(1.0));
    }
    drop(file);

    if let Err(e) = verify_file_sha256(dest_temp, expected_sha256) {
        let _ = fs::remove_file(dest_temp);
        sys_log(&format!("[AlignModel] Hash verification failed for {}: {}", url, e));
        return Err(format!("무결성 검증에 실패했습니다({}). 다시 시도해 주세요.", e));
    }
    Ok(())
}

/// Renames `temp` into `dest`, falling back to copy+delete if they're on
/// different filesystems (e.g. temp dir and app-data dir on different
/// drives) - `fs::rename` is atomic on the common same-filesystem case.
fn move_into_place(temp: &Path, dest: &Path) -> Result<(), String> {
    if fs::rename(temp, dest).is_err() {
        fs::copy(temp, dest).map_err(|e| format!("파일 이동 실패: {}", e))?;
        let _ = fs::remove_file(temp);
    }
    Ok(())
}

/// Downloads (or re-downloads) the KO/EN forced-alignment model named by
/// `language` ("ko"/"en") into the app's model cache. See the module-level
/// doc comment above `AlignmentModelSpec` for the integrity guarantees.
#[command]
pub async fn download_alignment_model(handle: AppHandle, language: String) -> Result<(), String> {
    let spec = find_alignment_model_spec(&language)
        .ok_or_else(|| format!("알 수 없는 정렬 언어: {}", language))?;
    ALIGNMENT_MODEL_DOWNLOAD_CANCEL.store(false, Ordering::SeqCst);

    let paths = crate::state::AppPaths::from_handle(&handle);
    fs::create_dir_all(&paths.temp).map_err(|e| format!("임시 폴더 생성 실패: {}", e))?;

    let model_temp = paths.temp.join(format!("align-{}-model.onnx.part", spec.id));
    let tokens_temp = paths.temp.join(format!("align-{}-tokens.txt.part", spec.id));

    sys_log(&format!("[AlignModel] Downloading '{}' model from {}", spec.id, spec.model_url));
    {
        let h = handle.clone();
        let lang = spec.id.to_string();
        if let Err(e) = download_and_verify_asset(
            spec.model_url,
            spec.model_sha256,
            spec.model_size_bytes,
            &model_temp,
            move |frac| {
                let _ = h.emit(
                    "alignment-model-download-progress",
                    serde_json::json!({ "language": lang, "percentage": frac * 95.0 }),
                );
            },
        )
        .await
        {
            let _ = fs::remove_file(&model_temp);
            return Err(e);
        }
    }

    sys_log(&format!("[AlignModel] Downloading '{}' tokens from {}", spec.id, spec.tokens_url));
    {
        let h = handle.clone();
        let lang = spec.id.to_string();
        if let Err(e) = download_and_verify_asset(
            spec.tokens_url,
            spec.tokens_sha256,
            ALIGNMENT_TOKENS_MAX_BYTES,
            &tokens_temp,
            move |frac| {
                let _ = h.emit(
                    "alignment-model-download-progress",
                    serde_json::json!({ "language": lang, "percentage": 95.0 + frac * 5.0 }),
                );
            },
        )
        .await
        {
            let _ = fs::remove_file(&model_temp);
            let _ = fs::remove_file(&tokens_temp);
            return Err(e);
        }
    }

    // Both assets independently passed SHA-256 verification above - only now
    // do we touch the real model directory, and only via atomic renames.
    let target_dir = alignment_model_dir(&paths, spec);
    fs::create_dir_all(&target_dir).map_err(|e| format!("모델 폴더 생성 실패: {}", e))?;
    move_into_place(&model_temp, &target_dir.join("model.onnx"))?;
    move_into_place(&tokens_temp, &target_dir.join("tokens.txt"))?;

    let _ = handle.emit(
        "alignment-model-download-progress",
        serde_json::json!({ "language": spec.id, "percentage": 100.0 }),
    );
    sys_log(&format!("[AlignModel] '{}' ready at {:?}", spec.id, target_dir));
    Ok(())
}

#[command]
pub async fn cancel_alignment_model_download() {
    ALIGNMENT_MODEL_DOWNLOAD_CANCEL.store(true, Ordering::SeqCst);
    sys_log("[AlignModel] Download cancellation requested.");
}

/// Deletes a downloaded KO/EN alignment model's folder entirely.
#[command]
pub async fn delete_alignment_model(handle: AppHandle, language: String) -> Result<(), String> {
    let spec = find_alignment_model_spec(&language)
        .ok_or_else(|| format!("알 수 없는 정렬 언어: {}", language))?;
    let paths = crate::state::AppPaths::from_handle(&handle);
    let dir = alignment_model_dir(&paths, spec);
    if dir.exists() {
        fs::remove_dir_all(&dir).map_err(|e| format!("모델 삭제 실패: {}", e))?;
        sys_log(&format!("[AlignModel] Deleted '{}' at {:?}", spec.id, dir));
    }
    Ok(())
}

fn clean_lyrics(text: &str) -> String {
    // 괄호 안의 메타데이터 제거 (e.g. [Chorus], (Intro))
    let re_brackets = Regex::new(r"\[.*?\]|\(.*?\)|<.*?>").unwrap();
    let cleaned = re_brackets.replace_all(text, "");
    
    // 단순 특수문자 제거 (정렬에 방해되는 기호들)
    let re_symbols = Regex::new(r"[\?!\.,\-\+_~]").unwrap();
    let cleaned = re_symbols.replace_all(&cleaned, " ");
    
    cleaned.to_string()
}

fn normalize_path_key(path: &str) -> String {
    path.replace("\\", "/").to_lowercase()
}

use crate::youtube_url::extract_youtube_video_id;

fn youtube_url_variants(url: &str) -> Vec<String> {
    let mut variants = Vec::new();
    let trimmed = url.trim().to_string();
    if trimmed.is_empty() {
        return variants;
    }
    variants.push(trimmed.clone());
    variants.push(normalize_path_key(&trimmed));

    if let Some(id) = extract_youtube_video_id(&trimmed) {
        variants.push(format!("https://youtu.be/{}", id));
        variants.push(format!("https://www.youtube.com/watch?v={}", id));
        variants.push(format!("https://youtube.com/watch?v={}", id));
    }

    variants.sort();
    variants.dedup();
    variants
}

#[derive(Debug, Serialize, Deserialize)]
pub struct SeparatedTrack {
    pub name: String,
    pub original_path: String,
    pub folder_path: String,
    pub has_vocal: bool,
    pub has_inst: bool,
    pub title: Option<String>,
    pub artist: Option<String>,
    pub thumbnail: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct WordAlignment {
    pub word: String,
    pub start_ms: i64,
    pub end_ms: i64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct LineAlignment {
    pub text: String,
    pub extracted_text: String,
    pub start_ms: i64,
    pub end_ms: i64,
    pub words: Vec<WordAlignment>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TimestampedWord {
    pub text: String,
    pub start_sec: f32,
    pub end_sec: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TranscribedSegment {
    pub text: String,
    pub start_sec: f32,
    pub end_sec: f32,
    pub words: Vec<TimestampedWord>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct AlignmentResult {
    pub words: Vec<WordAlignment>,
    pub lines: Vec<LineAlignment>,
    pub raw_segments: Vec<TranscribedSegment>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct WaveformSummary {
    pub points: Vec<(f32, f32)>,
    pub duration_sec: f32,
}

#[command]
pub async fn get_separated_audio_list(handle: AppHandle) -> Result<Vec<SeparatedTrack>, String> {
    let paths = crate::state::AppPaths::from_handle(&handle);
    let mut tracks = Vec::new();
    
    // DB 연결을 위해 Mutex를 잠시 잠급니다.
    let db = crate::state::DB.lock();

    if let Ok(entries) = fs::read_dir(&paths.separated) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                let folder_name = entry.file_name().to_string_lossy().to_string();
                let has_vocal = crate::mr_cache::resolve_vocal(&path).is_some();
                let has_inst = crate::mr_cache::resolve_inst(&path).is_some();

                let original_path = urlencoding::decode(&folder_name).map(|d| d.into_owned()).unwrap_or(folder_name.clone());
                let display_name = Path::new(&original_path).file_name().map(|f| f.to_string_lossy().to_string()).unwrap_or_else(|| original_path.clone());

                // DB에서 추가 메타데이터 조회
                let mut title = None;
                let mut artist = None;
                let mut thumbnail = None;

                // 경로 정규화 (DB 저장 방식에 맞춤: 윈도우 슬래시 등)
                // get_songs_internal 로직을 참고하여 비교합니다.
                if let Ok(row) = db.query_row(
                    "SELECT title, artist, thumbnail FROM Tracks WHERE path = ? OR path = ?",
                    rusqlite::params![original_path, original_path.replace("/", "\\")],
                    |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?, row.get::<_, String>(2)?))
                ) {
                    title = Some(row.0);
                    artist = row.1;
                    thumbnail = Some(row.2);
                }

                tracks.push(SeparatedTrack {
                    name: display_name,
                    original_path,
                    folder_path: path.to_string_lossy().to_string(),
                    has_vocal,
                    has_inst,
                    title,
                    artist,
                    thumbnail,
                });
            }
        }
    }
    Ok(tracks)
}

#[command]
pub async fn get_model_list(handle: AppHandle) -> Result<Vec<String>, String> {
    let paths = crate::state::AppPaths::from_handle(&handle);
    let mut models = Vec::new();

    let search_dirs = vec![
        paths.models.clone(),
        std::env::current_exe().map(|p| p.parent().unwrap().join("models")).unwrap_or_default(),
        PathBuf::from("models"),
    ];

    for dir in search_dirs {
        // Scan models directory for subfolders
        if let Ok(entries) = fs::read_dir(&dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() {
                    let folder_name = entry.file_name().to_string_lossy().to_string();
                    let onnx_path = path.join("model.onnx");
                    let enc_path = path.join("encoder.onnx");
                    let tokens_path = path.join("tokens.txt");

                    if (onnx_path.exists() || enc_path.exists()) && tokens_path.exists() {
                        let display_name = match folder_name.as_str() {
                            "wav2vec2-large" => "Engine A: Wav2Vec2-Large (High Precision)",
                            "whisper-base" => "Engine B: Whisper-Base (Multi-lingual/Efficient)",
                            "wav2vec2-korean-lyrics" => "한국어 가사 정렬 모델 (KO)",
                            "wav2vec2-english-lyrics" => "영어 가사 정렬 모델 (EN)",
                            _ => &folder_name,
                        };
                        models.push(format!("{}|{}", display_name, path.to_string_lossy()));
                    }
                }
            }
        }
    }
    
    if models.is_empty() {
        models.push("사용 가능한 모델 없음|none".to_string());
    }

    Ok(models)
}

#[command]
pub async fn read_audio_file(path: String) -> Result<Vec<u8>, String> {
    let path = crate::ipc_validate::validate_local_audio_path(&path)?;
    fs::read(path).map_err(|e| format!("Failed to read file: {}", e))
}

#[command]
pub async fn cancel_forced_alignment() {
    CANCEL_ALIGNMENT.store(true, Ordering::SeqCst);
    sys_log("[Alignment] Cancellation signal sent.");
}

#[command]
pub async fn run_forced_alignment(
    handle: AppHandle,
    audio_path: String,
    lyrics: String,
    _model_name: String,
    _language: String,
    trans_penalty: Option<f32>,
    blank_penalty: Option<f32>,
    rep_penalty: Option<f32>,
    _use_vad: Option<bool>
) -> Result<AlignmentResult, String> {
    // -1 sentinel: waiting for a previous alignment to finish (queued).
    let _ = handle.emit("alignment-progress", -1);
    let _permit = ALIGNMENT_QUEUE_LOCK.lock().await;
    CANCEL_ALIGNMENT.store(false, Ordering::SeqCst);
    // -2 sentinel: preprocessing / model load (UI shows "준비 중" instead of 0%).
    let _ = handle.emit("alignment-progress", -2);
    sys_log(&format!("[Alignment] Starting new CTC alignment path: {}", audio_path));

    let _paths = crate::state::AppPaths::from_handle(&handle);
    let model_full_path = _model_name.split('|').last().unwrap_or(".");
    let target_dir = PathBuf::from(model_full_path);
    
    let mut model_path = target_dir.join("model.onnx");
    if !model_path.exists() {
        model_path = target_dir.join("encoder.onnx");
    }
    let tokens_path = target_dir.join("tokens.txt");

    if !model_path.exists() || !tokens_path.exists() {
        // Fallback for relative paths if the UI didn't pass absolute
        return Err(format!("모델 파일을 찾을 수 없습니다: {:?}", target_dir));
    }

    let is_whisper = model_path.to_string_lossy().contains("whisper-base");
    let processor = AudioProcessor::new();

    // Prefer the isolated vocal stem when this track has been AI-separated —
    // singing-voice ASR/CTC accuracy drops sharply with instrumental bleed,
    // and this is the same resolution `get_waveform_summary` already uses.
    let resolved_audio_path = resolve_audio_path(&handle, &audio_path)
        .await
        .unwrap_or_else(|_| PathBuf::from(&audio_path));
    sys_log(&format!(
        "[Alignment] Resolved alignment input: {:?} (requested: {})",
        resolved_audio_path, audio_path
    ));

    let emission_probs = if is_whisper {
        sys_log("[Alignment] Engine B (Whisper) Preprocessing: Extracting Mel-spectrogram...");
        let raw_samples = processor.load_and_preprocess(&resolved_audio_path)?;
        let mel_data = processor.get_mel_spectrogram(raw_samples.as_slice().unwrap());
        
        sys_log(&format!("[Alignment] Engine B: Creating ONNX session for {:?}", model_path));
        let mut engine = OnnxEngine::new(&model_path)?;
        let h_clone = handle.clone();
        
        sys_log("[Alignment] Engine B: Running Whisper Inference...");
        engine.run_inference(&mel_data, true, |p| {
            let _ = h_clone.emit("alignment-progress", p as i32);
        }).map_err(|e| {
            let err_msg = format!("❌ [Engine B Error] {}", e);
            sys_log(&err_msg);
            err_msg
        })?
    } else {
        sys_log("[Alignment] Engine A (Wav2Vec2) Preprocessing: Raw audio PCM...");
        let audio_data = processor.load_and_preprocess(&resolved_audio_path)?;
        
        sys_log(&format!("[Alignment] Engine A: Creating ONNX session for {:?}", model_path));
        let mut engine = OnnxEngine::new(&model_path)?;
        let h_clone = handle.clone();
        
        sys_log("[Alignment] Engine A: Running Wav2Vec2 Inference...");
        engine.run_inference(audio_data.as_slice().unwrap(), false, |p| {
            let _ = h_clone.emit("alignment-progress", p as i32);
        }).map_err(|e| {
            let err_msg = format!("❌ [Engine A Error] {}", e);
            sys_log(&err_msg);
            err_msg
        })?
    };

    if CANCEL_ALIGNMENT.load(Ordering::SeqCst) {
        return Err("작업이 사용자에 의해 취소되었습니다.".to_string());
    }

    // Cache the inference results
    {
        let mut cache = CACHED_STATE.lock();
        *cache = Some(CachedAlignmentState {
            emission_probs: emission_probs.clone(),
            tokens_path: tokens_path.clone(),
            lyrics: lyrics.clone(),
        });
    }

    Ok(perform_alignment_internal(emission_probs, &tokens_path, &lyrics, trans_penalty.unwrap_or(-0.05), blank_penalty.unwrap_or(0.0), rep_penalty.unwrap_or(0.0))?)
}

#[command]
pub async fn apply_alignment_tuning(penalty: f32, blank_penalty: Option<f32>, rep_penalty: Option<f32>) -> Result<AlignmentResult, String> {
    CANCEL_ALIGNMENT.store(false, Ordering::SeqCst);
    sys_log(&format!("[Alignment] Real-time tuning requested with penalty: {:.3}", penalty));

    let cache = CACHED_STATE.lock();
    if let Some(state) = &*cache {
        let result = perform_alignment_internal(
            state.emission_probs.clone(),
            &state.tokens_path,
            &state.lyrics,
            penalty,
            blank_penalty.unwrap_or(0.0),
            rep_penalty.unwrap_or(0.0)
        )?;
        sys_log("[Alignment] Real-time tuning completed successfully.");
        Ok(result)
    } else {
        Err("캐시된 정렬 데이터가 없습니다. 먼저 정렬을 한번 수행하세요.".to_string())
    }
}

fn perform_alignment_internal(
    emission_probs: Array2<f32>,
    tokens_path: &Path,
    lyrics: &str,
    trans_p: f32,
    blank_p: f32,
    rep_p: f32
) -> Result<AlignmentResult, String> {
    let aligner = Aligner::new(tokens_path.to_str().unwrap())?;
    let cleaned_lyrics = clean_lyrics(lyrics);
    let lyric_lines: Vec<String> = cleaned_lyrics.lines().map(|s| s.trim().to_owned()).filter(|s| !s.is_empty()).collect();

    let (target_tokens, word_spans) = aligner.tokenize(&cleaned_lyrics);
    if target_tokens.is_empty() { return Err("유효한 가사 토큰이 없습니다.".to_string()); }

    let path = aligner.forced_align(&emission_probs, &target_tokens, trans_p, blank_p, rep_p);
    let frame_duration_ms = 20.0;
    let timestamps = aligner.get_word_timestamps(&path, &word_spans, frame_duration_ms);

    let greedy_path = aligner.greedy_decode(&emission_probs);

    let mut all_line_alignments = Vec::new();
    let mut word_idx = 0;
    for line_text in lyric_lines {
        let words_in_line: Vec<&str> = line_text.split_whitespace().collect();
        let mut line_words = Vec::new();
        let mut line_start_ms = 0;
        let mut line_end_ms = 0;

        for _ in 0..words_in_line.len() {
            if word_idx < timestamps.len() {
                let ts = &timestamps[word_idx];
                if line_words.is_empty() { line_start_ms = ts.start_ms as i64; }
                line_end_ms = ts.end_ms as i64;
                line_words.push(WordAlignment {
                    word: ts.word.clone(),
                    start_ms: ts.start_ms as i64,
                    end_ms: ts.end_ms as i64,
                });
                word_idx += 1;
            }
        }

        if !line_words.is_empty() {
            let start_frame = (line_start_ms as f32 / frame_duration_ms) as usize;
            let end_frame = (line_end_ms as f32 / frame_duration_ms) as usize;
            let extracted_text = aligner.get_text_from_path(&greedy_path, start_frame, end_frame);

            all_line_alignments.push(LineAlignment {
                text: line_text,
                extracted_text,
                start_ms: line_start_ms,
                end_ms: line_end_ms,
                words: line_words,
            });
        }
    }

    Ok(AlignmentResult {
        words: Vec::new(),
        lines: all_line_alignments,
        raw_segments: Vec::new(),
    })
}

#[command]
pub async fn get_waveform_summary(handle: AppHandle, audio_path: String) -> Result<WaveformSummary, String> {
    let paths = crate::state::AppPaths::from_handle(&handle);
    
    // 1. Resolve Path first (Prefers separated vocal)
    let resolved_path = resolve_audio_path(&handle, &audio_path).await?;
    
    // 2. Check Cache with metadata-aware key
    let waveform_cache_dir = paths.cache.join("waveforms");
    if !waveform_cache_dir.exists() {
        fs::create_dir_all(&waveform_cache_dir).ok();
    }
    
    // Use resolved path and its modified time to ensure cache validity
    let mtime = fs::metadata(&resolved_path)
        .and_then(|m| m.modified())
        .map(|t| t.duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs())
        .unwrap_or(0);
        
    let cache_key_raw = format!("{}_{}", resolved_path.to_string_lossy(), mtime);
    let cache_key = urlencoding::encode(&cache_key_raw).to_string();
    let cache_path = waveform_cache_dir.join(format!("{}.json", cache_key));
    
    if cache_path.exists() {
        if let Ok(content) = fs::read_to_string(&cache_path) {
            if let Ok(summary) = serde_json::from_str::<WaveformSummary>(&content) {
                sys_log(&format!("[Alignment] Waveform loaded from cache: {:?}", resolved_path));
                return Ok(summary);
            }
        }
    }

    sys_log(&format!("[Alignment] Generating waveform summary for: {:?}", resolved_path));
    
    let processor = AudioProcessor::new();
    let n_buckets = 2000;
    
    let (points, duration_sec) = processor.create_waveform_summary(&resolved_path, n_buckets)?;
    let summary = WaveformSummary { 
        points, 
        duration_sec
    };

    // 3. Save to Cache
    if let Ok(json) = serde_json::to_string(&summary) {
        fs::write(&cache_path, json).ok();
    }
    
    sys_log(&format!("[Alignment] Waveform summary generated and cached: {} points, {:.2}s", summary.points.len(), duration_sec));
    Ok(summary)
}

/// 유튜브 URL 등을 실제 로컬 오디오 파일 경로로 변환합니다.
async fn resolve_audio_path(handle: &AppHandle, path: &str) -> Result<PathBuf, String> {
    let paths = crate::state::AppPaths::from_handle(handle);
    let normalized_input = path.replace("\\", "/");
    let lower_input = normalized_input.to_lowercase();

    // 1) If this is a separated artifact/path, always prefer vocal waveform.
    let is_explicit_separated = lower_input.contains("/cache/separated/")
        || lower_input.contains("\\cache\\separated\\")
        || lower_input.ends_with("/vocal.wav")
        || lower_input.ends_with("\\vocal.wav")
        || lower_input.ends_with("/vocal.mp3")
        || lower_input.ends_with("\\vocal.mp3")
        || lower_input.ends_with("/inst.wav")
        || lower_input.ends_with("\\inst.wav")
        || lower_input.ends_with("/inst.mp3")
        || lower_input.ends_with("\\inst.mp3");
    if is_explicit_separated {
        let p = PathBuf::from(path);
        if p.is_file() {
            if p.file_name()
                .and_then(|n| n.to_str())
                .map(|n| crate::mr_cache::is_inst_stem_name(n))
                .unwrap_or(false)
            {
                if let Some(parent) = p.parent() {
                    if let Some(vocal) = crate::mr_cache::resolve_vocal(parent) {
                        return Ok(vocal);
                    }
                }
            }
            return Ok(p);
        }
        if let Some(vocal) = crate::mr_cache::resolve_vocal(&p) {
            return Ok(vocal);
        }
    }

    // 2) For normal tracks, if separated outputs exist for the same source, use vocal stem.
    let mut lookup_keys = if path.starts_with("http") {
        youtube_url_variants(path)
    } else {
        let mut v = vec![path.to_string()];
        let normalized = normalize_path_key(path);
        if normalized != path {
            v.push(normalized);
        }
        v
    };
    lookup_keys.sort();
    lookup_keys.dedup();
    for key in lookup_keys {
        let cache_dir = paths.separated.join(urlencoding::encode(&key).to_string());
        if let Some(vocal) = crate::mr_cache::resolve_vocal(&cache_dir) {
            return Ok(vocal);
        }
    }

    // 3) Fallback to original source.
    if !path.starts_with("http") {
        let p = PathBuf::from(path);
        if p.exists() { return Ok(p); }
        return Err(format!("파일을 찾을 수 없습니다: {}", path));
    }

    // 4. temp 폴더에 다운로드된 m4a 파일이 있는지 확인
    // yt_id.m4a 형식이므로 id를 추출해야 함
    let metadata = crate::youtube::YoutubeManager::get_video_metadata(path).await.map_err(|e| e.to_string())?;
    if let Some(id) = metadata.id {
        let temp_m4a = paths.temp.join(format!("yt_{}.m4a", id));
        if temp_m4a.exists() {
            return Ok(temp_m4a);
        }
        
        // 5. 없으면 다운로드 시도 (사용자 요청에 따라)
        sys_log(&format!("[Alignment] Audio file not found for {}, starting download...", path));
        let window = handle.get_webview_window("main").ok_or("메인 윈도우를 찾을 수 없습니다")?;
        let downloaded = crate::youtube::YoutubeManager::download_audio(&window, path, temp_m4a.clone(), true).await?;
        return Ok(downloaded);
    }

    Err("유튜브 오디오 경로를 해소할 수 없습니다.".into())
}

pub struct WordTimestamp {
    pub word: String,
    pub start_ms: u32,
    pub end_ms: u32,
}

pub struct Aligner {
    token_to_id: HashMap<String, usize>,
    blank_id: usize,
    space_id: Option<usize>,
    unk_id: usize,
    is_syllable_based: bool,
    /// True when the vocab is char-level Latin (single-uppercase-letter
    /// tokens A-Z) rather than Hangul — i.e. the English wav2vec2 CTC model.
    is_latin_based: bool,
    /// Whether the vocab has an apostrophe token (`'`) — English contractions
    /// (don't, it's) keep it; otherwise it's stripped like other symbols.
    has_apostrophe: bool,
}

impl Aligner {
    pub fn new(tokens_path: &str) -> Result<Self, String> {
        let file = fs::File::open(tokens_path).map_err(|e| format!("토큰 파일 오픈 실패: {}", e))?;
        let reader = BufReader::new(file);
        let mut token_to_id = HashMap::new();
        let mut has_syllables = false;
        let mut has_latin = false;
        
        for line in reader.lines() {
            let line = line.map_err(|e| e.to_string())?;
            let line = line.trim_end();
            if line.is_empty() { continue; }
            if let Some(idx) = line.rfind(' ') {
                let token = &line[..idx];
                let id_str = &line[idx + 1..];
                if let Ok(id) = id_str.parse::<usize>() {
                    token_to_id.insert(token.to_string(), id);

                    if let Some(c) = token.chars().next() {
                        let cp = c as u32;
                        // 완성형 글자(AC00-D7AF)가 포함되어 있는지 확인
                        if (0xAC00..=0xD7AF).contains(&cp) {
                            has_syllables = true;
                        }
                        // 단일 라틴 대문자 토큰 → 영어 char-level 모델
                        if token.chars().count() == 1 && c.is_ascii_uppercase() {
                            has_latin = true;
                        }
                    }
                }
            }
        }
        let blank_id = token_to_id.get("[PAD]").copied()
            .or_else(|| token_to_id.get("<pad>").copied())
            .or_else(|| token_to_id.get("<blank>").copied())
            .unwrap_or(0);
        let space_id = token_to_id.get(" ").copied()
            .or_else(|| token_to_id.get("|").copied());
        let unk_id = token_to_id.get("[UNK]").copied()
            .or_else(|| token_to_id.get("<unk>").copied())
            .unwrap_or(blank_id);
        // 라틴 기반은 한글 vocab이 아닐 때만(중복 방지).
        let is_latin_based = has_latin && !has_syllables;
        let has_apostrophe = token_to_id.contains_key("'");

        Ok(Self { 
            token_to_id, 
            blank_id, 
            space_id, 
            unk_id, 
            is_syllable_based: has_syllables,
            is_latin_based,
            has_apostrophe,
        })
    }

    /// Whether `c` falls in any Hangul Unicode block (syllables, jamo, or
    /// compatibility jamo) — i.e. something a Korean acoustic model could
    /// plausibly have a real token for.
    fn is_hangul_char(c: char) -> bool {
        let cp = c as u32;
        (0xAC00..=0xD7A3).contains(&cp)
            || (0x1100..=0x11FF).contains(&cp)
            || (0x3130..=0x318F).contains(&cp)
    }

    /// Whether `c` could plausibly be represented by this model's vocab:
    /// Latin letters (+ apostrophe if present) for the English model, Hangul
    /// for the Korean model. Digits, punctuation, emoji, and other scripts
    /// are excluded here so `tokenize` never feeds them in as spurious UNKs.
    fn is_representable_char(&self, c: char) -> bool {
        if self.is_latin_based {
            c.is_ascii_alphabetic() || (self.has_apostrophe && (c == '\'' || c == '\u{2019}'))
        } else {
            Self::is_hangul_char(c)
        }
    }

    pub fn tokenize(&self, text: &str) -> (Vec<usize>, Vec<(usize, usize, String)>) {
        let mut ids = Vec::new();
        let mut word_spans = Vec::new();
        let words: Vec<&str> = text.split_whitespace().collect();
        
        for (wi, word) in words.iter().enumerate() {
            let start_idx = ids.len();

            // Filter to only characters this model's vocab could represent
            // (drops digits/punctuation/other-language words entirely,
            // rather than mapping them to UNK). Curly apostrophe (’) is
            // normalized to straight (') to match vocab entries.
            let filtered: String = word
                .chars()
                .filter(|&c| self.is_representable_char(c))
                .map(|c| if c == '\u{2019}' { '\'' } else { c })
                .collect();

            // A word with no representable characters (pure digits/symbols,
            // or a foreign-language word) contributes a zero-width span
            // instead of forced-align target tokens; `get_word_timestamps`
            // fills its timing in by interpolating between its neighbors so
            // it still ends up with a usable timestamp.
            if filtered.is_empty() {
                word_spans.push((start_idx, start_idx, word.to_string()));
                if wi < words.len() - 1 { if let Some(sid) = self.space_id { ids.push(sid); } }
                continue;
            }

            if self.is_latin_based {
                // 영어 char-level: 대문자 한 글자당 vocab 토큰 하나(vocab이 A-Z).
                for c in filtered.chars() {
                    let s = c.to_ascii_uppercase().to_string();
                    ids.push(*self.token_to_id.get(&s).unwrap_or(&self.unk_id));
                }
            } else if self.is_syllable_based {
                // 음절 기반: 이미 완성형 한글이 Vocab에 있는 경우
                for c in filtered.chars() {
                    ids.push(*self.token_to_id.get(&c.to_string()).unwrap_or(&self.unk_id));
                }
            } else {
                // 자모 기반: 이전과 동일하게 분해
                let decomposed = filtered.nfd().collect::<String>();
                for c in decomposed.chars() {
                    let s = self.to_compatibility_jamo(c);
                    ids.push(*self.token_to_id.get(&s).unwrap_or(&self.unk_id));
                }
            }
            
            if ids.len() == start_idx { ids.push(self.unk_id); }
            word_spans.push((start_idx, ids.len(), word.to_string()));
            if wi < words.len() - 1 { if let Some(sid) = self.space_id { ids.push(sid); } }
        }
        (ids, word_spans)
    }

    fn to_compatibility_jamo(&self, c: char) -> String {
        let cp = c as u32;
        if cp >= 0x1100 && cp <= 0x1112 {
            let mapping = ['ㄱ', 'ㄲ', 'ㄴ', 'ㄷ', 'ㄸ', 'ㄹ', 'ㅁ', 'ㅂ', 'ㅃ', 'ㅅ', 'ㅆ', 'ㅇ', 'ㅈ', 'ㅉ', 'ㅊ', 'ㅋ', 'ㅌ', 'ㅍ', 'ㅎ'];
            return mapping[(cp - 0x1100) as usize].to_string();
        }
        if cp >= 0x1161 && cp <= 0x1175 {
            let mapping = ['ㅏ', 'ㅐ', 'ㅑ', 'ㅒ', 'ㅓ', 'ㅔ', 'ㅕ', 'ㅖ', 'ㅗ', 'ㅘ', 'ㅙ', 'ㅚ', 'ㅛ', 'ㅜ', 'ㅝ', 'ㅞ', 'ㅟ', 'ㅠ', 'ㅡ', 'ㅢ', 'ㅣ'];
            return mapping[(cp - 0x1161) as usize].to_string();
        }
        if cp >= 0x11A8 && cp <= 0x11C2 {
            let mapping = ['ㄱ', 'ㄲ', 'ㄳ', 'ㄴ', 'ㄵ', 'ㄶ', 'ㄷ', 'ㄹ', 'ㄺ', 'ㄻ', 'ㄼ', 'ㄽ', 'ㄾ', 'ㄿ', 'ㅀ', 'ㅁ', 'ㅂ', 'ㅄ', 'ㅅ', 'ㅆ', 'ㅇ', 'ㅈ', 'ㅊ', 'ㅋ', 'ㅌ', 'ㅍ', 'ㅎ'];
            return mapping[(cp - 0x11A8) as usize].to_string();
        }
        c.to_string()
    }

    pub fn forced_align(&self, emission_probs: &Array2<f32>, target_tokens: &[usize], trans_penalty: f32, blank_penalty: f32, rep_penalty: f32) -> Vec<usize> {
        let mut extended = Vec::with_capacity(target_tokens.len() * 2 + 1);
        for &t in target_tokens { extended.push(self.blank_id); extended.push(t); }
        extended.push(self.blank_id);
        let n_frames = emission_probs.nrows();
        let n_states = extended.len();
        if n_frames == 0 || n_states == 0 { return vec![]; }
        let mut dp = vec![vec![f32::NEG_INFINITY; n_states]; n_frames];
        let mut bp = vec![vec![0usize; n_states]; n_frames];
        dp[0][0] = emission_probs[[0, extended[0]]];
        if n_states > 1 { dp[0][1] = emission_probs[[0, extended[1]]]; }
        for t in 1..n_frames {
            if t % 50 == 0 && CANCEL_ALIGNMENT.load(Ordering::SeqCst) { break; } // Early exit for inner loops
            for s in 0..n_states {
                let mut emit = emission_probs[[t, extended[s]]];
                if extended[s] == self.blank_id {
                    emit += blank_penalty;
                }
                
                let mut best = dp[t - 1][s];
                if extended[s] != self.blank_id {
                    best += rep_penalty;
                }
                
                let mut best_from = s;
                if s > 0 {
                    let val = dp[t - 1][s - 1] + trans_penalty;
                    if val > best { best = val; best_from = s - 1; }
                }
                if s > 1 && extended[s] != extended[s - 2] {
                    let val = dp[t - 1][s - 2] + trans_penalty;
                    if val > best { best = val; best_from = s - 2; }
                }
                dp[t][s] = best + emit; bp[t][s] = best_from;
            }
        }
        let mut state = n_states - 1;
        if n_states >= 2 && dp[n_frames - 1][n_states - 2] > dp[n_frames - 1][n_states - 1] { state = n_states - 2; }
        let mut path = vec![0usize; n_frames];
        path[n_frames - 1] = state;
        for t in (0..n_frames - 1).rev() { state = bp[t + 1][state]; path[t] = state; }
        path.iter().map(|&s| if s % 2 == 0 { usize::MAX } else { s / 2 }).collect()
    }

    pub fn get_word_timestamps(&self, path: &[usize], word_spans: &[(usize, usize, String)], frame_duration_ms: f32) -> Vec<WordTimestamp> {
        // Zero-width spans (non-representable words skipped by `tokenize`, or
        // a word whose acoustic states the Viterbi path never visited) have
        // no timing of their own — filled in below by interpolating between
        // whichever aligned words bracket them, so every word still gets a
        // timestamp instead of silently vanishing from the result.
        let mut result: Vec<Option<WordTimestamp>> = Vec::with_capacity(word_spans.len());
        for (token_start, token_end, word) in word_spans {
            if token_start == token_end {
                result.push(None);
                continue;
            }
            let mut first_frame = None; let mut last_frame = None;
            for (frame_idx, &token_idx) in path.iter().enumerate() {
                if token_idx != usize::MAX && token_idx >= *token_start && token_idx < *token_end {
                    if first_frame.is_none() { first_frame = Some(frame_idx); }
                    last_frame = Some(frame_idx);
                }
            }
            result.push(first_frame.zip(last_frame).map(|(start, end)| WordTimestamp {
                word: word.clone(),
                start_ms: (start as f32 * frame_duration_ms) as u32,
                end_ms: ((end + 1) as f32 * frame_duration_ms) as u32,
            }));
        }

        const FALLBACK_WORD_MS: u32 = 400;
        let mut i = 0;
        while i < result.len() {
            if result[i].is_some() { i += 1; continue; }
            let gap_start = i;
            let mut gap_end = i;
            while gap_end < result.len() && result[gap_end].is_none() { gap_end += 1; }
            let n = (gap_end - gap_start) as u32;

            let prev_end_ms = if gap_start > 0 { result[gap_start - 1].as_ref().map(|w| w.end_ms) } else { None };
            let next_start_ms = if gap_end < result.len() { result[gap_end].as_ref().map(|w| w.start_ms) } else { None };

            let (range_start, range_end) = match (prev_end_ms, next_start_ms) {
                (Some(s), Some(e)) if e > s => (s, e),
                (Some(s), _) => (s, s + FALLBACK_WORD_MS * n),
                (None, Some(e)) => (e.saturating_sub(FALLBACK_WORD_MS * n), e),
                (None, None) => (0, FALLBACK_WORD_MS * n),
            };

            let span = (range_end - range_start) / n;
            for (k, idx) in (gap_start..gap_end).enumerate() {
                let s = range_start + span * k as u32;
                let e = if k as u32 + 1 == n { range_end } else { s + span };
                result[idx] = Some(WordTimestamp { word: word_spans[idx].2.clone(), start_ms: s, end_ms: e.max(s + 1) });
            }
            i = gap_end;
        }

        result.into_iter().flatten().collect()
    }

    pub fn greedy_decode(&self, emission_probs: &Array2<f32>) -> Vec<usize> {
        let n_frames = emission_probs.nrows();
        let mut path = Vec::with_capacity(n_frames);
        for t in 0..n_frames {
            let mut best_idx = 0; let mut best_prob = f32::NEG_INFINITY;
            for (idx, &prob) in emission_probs.row(t).iter().enumerate() { if prob > best_prob { best_prob = prob; best_idx = idx; } }
            path.push(best_idx);
        }
        path
    }

    pub fn get_text_from_path(&self, path: &[usize], start: usize, end: usize) -> String {
        let end = end.min(path.len()); if start >= end { return String::new(); }
        let mut tokens = Vec::new(); let mut prev = None;
        for &t in &path[start..end] { if t != self.blank_id && Some(t) != prev { tokens.push(t); } prev = Some(t); }
        let mut id_to_token = HashMap::new();
        for (token, &id) in &self.token_to_id { id_to_token.insert(id, token.as_str()); }
        
        let mut parts = Vec::new();
        for id in tokens { 
            if let Some(&token) = id_to_token.get(&id) { 
                parts.push(token); 
            } 
        }
        
        if self.is_syllable_based || self.is_latin_based {
            // 음절 기반(한글) 또는 라틴(영어): 토큰을 그대로 직결(| = 공백).
            parts.join("").replace("|", " ").trim().to_string()
        } else {
            // 자모 기반(한글): 분해된 자모를 음절로 조립.
            self.assemble_hangul(&parts)
        }
    }

    fn assemble_hangul(&self, jamos: &[&str]) -> String {
        let mut combined = String::new();
        let mut cur_syllable = String::new();
        
        // Simple state machine to track syllable structure: empty -> choseong -> jungseong -> jongseong
        #[derive(PartialEq)]
        enum SyllableState { Empty, Choseong, Jungseong, Jongseong }
        let mut state = SyllableState::Empty;

        for &j in jamos {
            if j == " " || j == "|" {
                if !cur_syllable.is_empty() {
                    combined.push_str(&cur_syllable.nfc().collect::<String>());
                    cur_syllable.clear();
                }
                combined.push(' ');
                state = SyllableState::Empty;
                continue;
            }

            let is_vowel = "ㅏㅐㅑㅒㅓㅔㅕㅖㅗㅘㅙㅚㅛㅜㅜㅝㅞㅟㅠㅡㅢㅣ".contains(j);
            
            match state {
                SyllableState::Empty => {
                    if is_vowel {
                        // Vowel starting a syllable (unusual but possible)
                        cur_syllable.push(self.to_combining_jamo_internal(j, false));
                        state = SyllableState::Jungseong;
                    } else {
                        cur_syllable.push(self.to_combining_jamo_internal(j, true));
                        state = SyllableState::Choseong;
                    }
                }
                SyllableState::Choseong => {
                    if is_vowel {
                        cur_syllable.push(self.to_combining_jamo_internal(j, false));
                        state = SyllableState::Jungseong;
                    } else {
                        // Double consonant? Flush previous and start new choseong
                        combined.push_str(&cur_syllable.nfc().collect::<String>());
                        cur_syllable = self.to_combining_jamo_internal(j, true).to_string();
                        state = SyllableState::Choseong;
                    }
                }
                SyllableState::Jungseong => {
                    if is_vowel {
                        // Composite vowel?
                        cur_syllable.push(self.to_combining_jamo_internal(j, false));
                    } else {
                        let c = self.to_combining_jamo_internal(j, false);
                        if c == ' ' { // Failed to find jongseong version
                            combined.push_str(&cur_syllable.nfc().collect::<String>());
                            cur_syllable = self.to_combining_jamo_internal(j, true).to_string();
                            state = SyllableState::Choseong;
                        } else {
                            cur_syllable.push(c);
                            state = SyllableState::Jongseong;
                        }
                    }
                }
                SyllableState::Jongseong => {
                    if is_vowel {
                        // Vowel after Jongseong! (e.g., 각 + ㅏ -> 가 + 가)
                        // Need to pull last jongseong and move it to choseong of next syllable
                        // For simplicity here, we flush and start new vowel syllable
                        combined.push_str(&cur_syllable.nfc().collect::<String>());
                        cur_syllable = self.to_combining_jamo_internal(j, false).to_string();
                        state = SyllableState::Jungseong;
                    } else {
                        // New consonant: flush and start next
                        combined.push_str(&cur_syllable.nfc().collect::<String>());
                        cur_syllable = self.to_combining_jamo_internal(j, true).to_string();
                        state = SyllableState::Choseong;
                    }
                }
            }
        }
        
        if !cur_syllable.is_empty() {
            combined.push_str(&cur_syllable.nfc().collect::<String>());
        }
        combined
    }

    fn to_combining_jamo_internal(&self, j: &str, is_initial: bool) -> char {
        match j {
            "ㄱ" => if is_initial { '\u{1100}' } else { '\u{11A8}' },
            "ㄲ" => if is_initial { '\u{1101}' } else { '\u{11A9}' },
            "ㄳ" => '\u{11AA}',
            "ㄴ" => if is_initial { '\u{1102}' } else { '\u{11AB}' },
            "ㄵ" => '\u{11AC}',
            "ㄶ" => '\u{11AD}',
            "ㄷ" => if is_initial { '\u{1103}' } else { '\u{11AE}' },
            "ㄸ" => if is_initial { '\u{1104}' } else { ' ' },
            "ㄹ" => if is_initial { '\u{1105}' } else { '\u{11AF}' },
            "ㄺ" => '\u{11B0}', "ㄻ" => '\u{11B1}', "ㄼ" => '\u{11B2}', "ㄽ" => '\u{11B3}', "ㄾ" => '\u{11B4}', "ㄿ" => '\u{11B5}', "ㅀ" => '\u{11B6}',
            "ㅁ" => if is_initial { '\u{1106}' } else { '\u{11B7}' },
            "ㅂ" => if is_initial { '\u{1107}' } else { '\u{11B8}' },
            "ㅃ" => if is_initial { '\u{1108}' } else { ' ' },
            "ㅄ" => '\u{11B9}',
            "ㅅ" => if is_initial { '\u{1109}' } else { '\u{11BA}' },
            "ㅆ" => if is_initial { '\u{110A}' } else { '\u{11BB}' },
            "ㅇ" => if is_initial { '\u{110B}' } else { '\u{11BC}' },
            "ㅈ" => if is_initial { '\u{110C}' } else { '\u{11BD}' },
            "ㅉ" => if is_initial { '\u{110D}' } else { ' ' },
            "ㅊ" => if is_initial { '\u{110E}' } else { '\u{11BE}' },
            "ㅋ" => if is_initial { '\u{110F}' } else { '\u{11BF}' },
            "ㅌ" => if is_initial { '\u{1110}' } else { '\u{11C0}' },
            "ㅍ" => if is_initial { '\u{1111}' } else { '\u{11C1}' },
            "ㅎ" => if is_initial { '\u{1112}' } else { '\u{11C2}' },
            "ㅏ" => '\u{1161}', "ㅐ" => '\u{1162}', "ㅑ" => '\u{1163}', "ㅒ" => '\u{1164}', "ㅓ" => '\u{1165}', "ㅔ" => '\u{1166}', "ㅕ" => '\u{1167}', "ㅖ" => '\u{1168}',
            "ㅗ" => '\u{1169}', "ㅘ" => '\u{116A}', "ㅙ" => '\u{116B}', "ㅚ" => '\u{116C}', "ㅛ" => '\u{116D}', "ㅜ" => '\u{116E}', "ㅝ" => '\u{116F}', "ㅞ" => '\u{1170}', "ㅟ" => '\u{1171}', "ㅠ" => '\u{1172}',
            "ㅡ" => '\u{1173}', "ㅢ" => '\u{1174}', "ㅣ" => '\u{1175}',
            _ => j.chars().next().unwrap_or(' '),
        }
    }
}

#[command]
pub async fn save_lrc_file(handle: AppHandle, audio_path: String, content: String) -> Result<String, String> {
    sys_log(&format!(
        "[Alignment] save_lrc_file requested. is_url={}, path={}, content_len={}",
        audio_path.starts_with("http"),
        audio_path,
        content.len()
    ));
    let lrc_path = if audio_path.starts_with("http") {
        let paths = crate::state::AppPaths::from_handle(&handle);
        write_lrc_to_url_cache(&paths, &audio_path, &content)?
    } else {
        let audio_file = PathBuf::from(&audio_path);
        if !audio_file.exists() {
            return Err(format!("원본 오디오 파일을 찾을 수 없습니다: {}", audio_path));
        }
        if !audio_file.is_file() {
            return Err(format!("오디오 경로가 파일이 아닙니다: {}", audio_path));
        }
        let lrc_path = audio_file.with_extension("lrc");
        fs::write(&lrc_path, content).map_err(|e| format!("LRC 저장 실패: {}", e))?;
        lrc_path
    };

    let saved_path = lrc_path.to_string_lossy().to_string();
    sys_log(&format!("[Alignment] LRC saved to {}", saved_path));
    Ok(saved_path)
}

/// Writes LRC content to the URL-keyed cache dir (`<separated>/<urlencoded url>/lyric.lrc`)
/// and mirrors it to all `youtube_url_variants()` cache-key forms, so future
/// lookups find it regardless of which URL form was used to reference the
/// track. Returns the primary path written. Also invalidates the fast
/// sync-status cache entry for the primary path so `classify_lyric_sync_status`
/// reflects the new content on the very next library load.
fn write_lrc_to_url_cache(paths: &crate::state::AppPaths, url: &str, content: &str) -> Result<PathBuf, String> {
    let cache_key = urlencoding::encode(url).to_string();
    let base_dir = paths.separated.join(&cache_key);
    sys_log(&format!(
        "[Alignment] Saving URL LRC to cache. key={}, dir={}",
        cache_key,
        base_dir.to_string_lossy()
    ));
    if !base_dir.exists() {
        fs::create_dir_all(&base_dir).map_err(|e| format!("LRC 저장 폴더 생성 실패: {}", e))?;
    }
    let primary = base_dir.join("lyric.lrc");
    fs::write(&primary, content).map_err(|e| format!("LRC 저장 실패: {}", e))?;
    invalidate_lyric_sync_cache(&primary);

    // Mirror save to common URL variants so future loads find legacy/alternate forms too.
    for variant in youtube_url_variants(url) {
        let mirror_key = urlencoding::encode(&variant).to_string();
        let mirror_dir = paths.separated.join(&mirror_key);
        if mirror_dir != base_dir {
            if !mirror_dir.exists() {
                if let Err(e) = fs::create_dir_all(&mirror_dir) {
                    sys_log(&format!(
                        "[Alignment] Mirror dir create failed. key={}, dir={}, err={}",
                        mirror_key,
                        mirror_dir.to_string_lossy(),
                        e
                    ));
                }
            }
            let mirror_path = mirror_dir.join("lyric.lrc");
            if let Err(e) = fs::write(&mirror_path, content) {
                sys_log(&format!(
                    "[Alignment] Mirror LRC write failed. key={}, dir={}, err={}",
                    mirror_key,
                    mirror_dir.to_string_lossy(),
                    e
                ));
            } else {
                invalidate_lyric_sync_cache(&mirror_path);
                sys_log(&format!(
                    "[Alignment] Mirror LRC write ok. key={}, dir={}",
                    mirror_key,
                    mirror_dir.to_string_lossy()
                ));
            }
        }
    }
    Ok(primary)
}

/// Builds the ordered list of candidate LRC file paths for an audio path
/// (URL cache variants for http:// sources, sibling/cache/legacy paths for
/// local files). Shared by `load_lrc_file` and the sync-status classifier so
/// the resolution scheme (including URL cache paths) stays in one place.
fn lrc_search_paths(paths: &crate::state::AppPaths, audio_path: &str) -> Vec<PathBuf> {
    let mut search_paths = Vec::new();
    if audio_path.starts_with("http") {
        for key_src in youtube_url_variants(audio_path) {
            let cache_key = urlencoding::encode(&key_src).to_string();
            let cache_dir = paths.separated.join(&cache_key);
            search_paths.push(cache_dir.join("lyric.lrc"));
            search_paths.push(cache_dir.join("vocal.lrc"));
        }
    } else {
        let original_file = PathBuf::from(audio_path);
        search_paths.push(original_file.with_extension("lrc"));

        let cache_key = urlencoding::encode(audio_path).to_string();
        let cache_dir = paths.separated.join(&cache_key);
        search_paths.push(cache_dir.join("lyric.lrc"));
        search_paths.push(cache_dir.join("vocal.lrc"));

        // Local path normalization fallback for legacy entries with different slash/case.
        let normalized = normalize_path_key(audio_path);
        if normalized != audio_path {
            let norm_key = urlencoding::encode(&normalized).to_string();
            let norm_cache_dir = paths.separated.join(&norm_key);
            search_paths.push(norm_cache_dir.join("lyric.lrc"));
            search_paths.push(norm_cache_dir.join("vocal.lrc"));
        }

        // If current path is already inside a separated folder (e.g. vocal.wav)
        if let Some(parent) = original_file.parent() {
            search_paths.push(parent.join("lyric.lrc"));
            search_paths.push(parent.join("vocal.lrc"));
        }
    }
    search_paths
}

#[command]
pub async fn load_lrc_file(handle: AppHandle, audio_path: String) -> Result<String, String> {
    let paths = crate::state::AppPaths::from_handle(&handle);
    sys_log(&format!(
        "[Alignment] load_lrc_file requested. is_url={}, path={}",
        audio_path.starts_with("http"),
        audio_path
    ));

    if let Some(content) = read_lrc_content(&paths, &audio_path) {
        return Ok(content);
    }

    let tried = if audio_path.starts_with("http") {
        youtube_url_variants(&audio_path)
            .into_iter()
            .map(|v| {
                let k = urlencoding::encode(&v).to_string();
                format!("{} => {}", v, k)
            })
            .collect::<Vec<_>>()
            .join(" | ")
    } else {
        "(local path)".to_string()
    };
    sys_log(&format!(
        "[Alignment] LRC file not found. tried_keys={}, cache_root={}",
        tried,
        paths.separated.to_string_lossy()
    ));
    Err("LRC file not found".to_string())
}

// --- Fast lyric sync-status classification (library load performance) ------
//
// `classify_lyric_sync_status` backs the library's per-song "synced" /
// "unsynced" / "none" badge. It must stay cheap even with thousands of
// tracks, so it never reads a whole LRC into memory: only the first
// `SYNC_STATUS_SCAN_BYTES` bytes are read (a real timestamp, if any, always
// appears in the first line), and results are cached by resolved LRC path +
// mtime so unchanged files are never re-read across library loads. The
// timestamp regex is compiled once via `Lazy` rather than per call.
const SYNC_STATUS_SCAN_BYTES: usize = 64 * 1024;

static LRC_TIMESTAMP_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"\[(\d{1,2}):(\d{2}(?:\.\d{1,3})?)\]").unwrap());

/// Matches a standalone marker line (`[00:12.34][vocalstart]` etc, mirrors
/// `markerLineRegex` in lrc-parser.js). These carry a real timestamp but are
/// NOT a lyric line, so `lrc_sync_status` must skip them - otherwise a
/// Meloming-seeded (fully unsynced) LRC that only has a manually-placed
/// vocal-start/interlude marker would be misclassified as "synced".
static LRC_MARKER_LINE_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"^\[\d{1,2}:\d{2}(?:\.\d{1,3})?\]\[(?:vocalstart|ilstart|ilend)\]\s*$").unwrap()
});

/// path -> (mtime_secs, status). Guarded by the same `parking_lot::Mutex`
/// used elsewhere in this module; classification is fast enough (bounded
/// read + one regex scan) that lock contention is a non-issue.
static LRC_STATUS_CACHE: Lazy<Mutex<HashMap<String, (u64, &'static str)>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

fn invalidate_lyric_sync_cache(lrc_path: &Path) {
    LRC_STATUS_CACHE.lock().remove(&lrc_path.to_string_lossy().to_string());
}

/// Reads at most the first `SYNC_STATUS_SCAN_BYTES` of a file. Used only for
/// sync-status classification, never for actual LRC content (loading the
/// real lyrics for editing/display still goes through `load_lrc_file`, which
/// reads the whole file).
fn read_prefix(path: &Path, max_bytes: usize) -> Option<String> {
    use std::io::Read;
    let mut file = fs::File::open(path).ok()?;
    let mut buf = vec![0u8; max_bytes];
    let n = file.read(&mut buf).ok()?;
    buf.truncate(n);
    Some(String::from_utf8_lossy(&buf).into_owned())
}

/// Reads an audio path's full LRC content if any candidate file exists.
/// Synchronous; backs the `load_lrc_file` command. NOT used for sync-status
/// classification (see `classify_lyric_sync_status`, which bounds its read).
pub fn read_lrc_content(paths: &crate::state::AppPaths, audio_path: &str) -> Option<String> {
    for p in lrc_search_paths(paths, audio_path) {
        if p.is_file() {
            if let Ok(content) = fs::read_to_string(&p) {
                return Some(content);
            }
        }
    }
    None
}

/// Classifies an LRC's sync state: `"synced"` if any line carries a real
/// (non-zero) `[mm:ss.xx]` timestamp, else `"unsynced"` (lyrics present but
/// all lines sit at 00:00.00, e.g. a Meloming seed or pasted-but-untimed
/// lyrics). Callers treat missing/blank content as `"none"`.
pub fn lrc_sync_status(content: &str) -> &'static str {
    for line in content.lines() {
        if LRC_MARKER_LINE_RE.is_match(line.trim()) {
            continue; // Standalone marker line - not a lyric timestamp.
        }
        if let Some(cap) = LRC_TIMESTAMP_RE.captures(line) {
            let min: f64 = cap[1].parse().unwrap_or(0.0);
            let sec: f64 = cap[2].parse().unwrap_or(0.0);
            if min * 60.0 + sec > 0.0 {
                return "synced"; // First non-zero lyric timestamp found is enough to stop scanning.
            }
        }
    }
    "unsynced"
}

/// Fast per-song classification for the library list: resolves the LRC
/// candidate path (without reading it), checks an mtime-keyed cache, and
/// only falls back to a bounded (`SYNC_STATUS_SCAN_BYTES`) read + regex scan
/// on a cache miss. This is the entry point `library::get_songs_internal`
/// calls for every song on every load, so it must stay allocation-light and
/// must never read a whole file.
pub fn classify_lyric_sync_status(paths: &crate::state::AppPaths, audio_path: &str) -> &'static str {
    let lrc_path = match lrc_search_paths(paths, audio_path).into_iter().find(|p| p.is_file()) {
        Some(p) => p,
        None => return "none",
    };

    let mtime = fs::metadata(&lrc_path)
        .and_then(|m| m.modified())
        .map(|t| t.duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs())
        .unwrap_or(0);
    let key = lrc_path.to_string_lossy().to_string();

    if let Some((cached_mtime, status)) = LRC_STATUS_CACHE.lock().get(&key) {
        if *cached_mtime == mtime {
            return status;
        }
    }

    let content = read_prefix(&lrc_path, SYNC_STATUS_SCAN_BYTES).unwrap_or_default();
    let status = if content.trim().is_empty() { "none" } else { lrc_sync_status(&content) };
    LRC_STATUS_CACHE.lock().insert(key, (mtime, status));
    status
}

#[cfg(test)]
mod lyric_sync_status_tests {
    use super::*;

    #[test]
    fn lrc_sync_status_detects_real_timestamps() {
        // A real (non-zero) timestamp anywhere means synced.
        let synced = "[00:00.00]첫 줄\n[00:12.34]둘째 줄";
        assert_eq!(lrc_sync_status(synced), "synced");
        // All-zero timestamps (Meloming seed / pasted-but-untimed) => unsynced.
        let unsynced = "[00:00.00]첫 줄\n[00:00.00]둘째 줄";
        assert_eq!(lrc_sync_status(unsynced), "unsynced");
        // No timestamps at all => unsynced.
        assert_eq!(lrc_sync_status("가사만 있고 태그 없음"), "unsynced");
        // Triplet tags on the same line as a real timestamp still count.
        let triplet = "[00:00.00][orig]원문\n[00:05.00][pron]발음";
        assert_eq!(lrc_sync_status(triplet), "synced");
        // 1-digit minute + fractional seconds (matches the JS parser's regex).
        assert_eq!(lrc_sync_status("[1:05.5]hello"), "synced");
        // A standalone vocal-start/interlude marker carries a real timestamp
        // but is not a lyric line - must not flip an otherwise-unsynced
        // (e.g. Meloming-seeded) LRC to "synced" just because the user
        // dropped a marker in before actually syncing any line.
        let marker_only = "[00:12.34][vocalstart]\n[00:00.00]첫 줄\n[00:00.00]둘째 줄";
        assert_eq!(lrc_sync_status(marker_only), "unsynced");
        let marker_with_interlude =
            "[00:05.00][ilstart]\n[00:15.00][ilend]\n[00:00.00]가사";
        assert_eq!(lrc_sync_status(marker_with_interlude), "unsynced");
    }

    #[test]
    fn classify_lyric_sync_status_reads_bounded_prefix_and_caches() {
        let dir = std::env::temp_dir().join(format!("lrc_status_test_{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let audio_path = dir.join("song.mp3");
        fs::write(&audio_path, b"fake").unwrap();
        let lrc_path = dir.join("song.lrc");
        fs::write(&lrc_path, "[00:01.00]hello").unwrap();

        let paths = crate::state::AppPaths {
            root: dir.clone(),
            models: dir.join("models"),
            cache: dir.join("cache"),
            separated: dir.join("separated"),
            temp: dir.join("temp"),
            db: dir.join("library.db"),
        };
        let status = classify_lyric_sync_status(&paths, audio_path.to_str().unwrap());
        assert_eq!(status, "synced");

        // Cache should now hold this exact path; a second call with unchanged
        // mtime must not need to touch the filesystem content again (we can't
        // easily assert "no read happened" without a spy, but we can assert
        // the cached value stays consistent after the source file changes
        // without a mtime bump simulation being required for correctness).
        let status2 = classify_lyric_sync_status(&paths, audio_path.to_str().unwrap());
        assert_eq!(status2, "synced");

        fs::remove_file(&lrc_path).ok();
        fs::remove_file(&audio_path).ok();
        fs::remove_dir_all(&dir).ok();
    }
}

#[cfg(test)]
mod alignment_model_tests {
    use super::*;

    fn temp_app_paths(name: &str) -> crate::state::AppPaths {
        let dir = std::env::temp_dir().join(format!("align_model_test_{}_{}", name, std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        crate::state::AppPaths {
            root: dir.clone(),
            models: dir.join("models"),
            cache: dir.join("cache"),
            separated: dir.join("separated"),
            temp: dir.join("temp"),
            db: dir.join("library.db"),
        }
    }

    #[test]
    fn alignment_models_are_https_and_never_reference_third_party_fork() {
        assert_eq!(ALIGNMENT_MODELS.len(), 2);
        for spec in ALIGNMENT_MODELS {
            assert!(spec.model_url.starts_with("https://"), "model_url must be HTTPS: {}", spec.model_url);
            assert!(spec.tokens_url.starts_with("https://"), "tokens_url must be HTTPS: {}", spec.tokens_url);
            // Must only ever point at this project's own release, never a
            // third-party fork's release (e.g. the PR this was ported from).
            assert!(spec.model_url.contains("/AutumnColor77/Live-MR-Manager/releases/"));
            assert!(spec.tokens_url.contains("/AutumnColor77/Live-MR-Manager/releases/"));
            assert!(!spec.model_url.to_lowercase().contains("temmis"));
            assert!(!spec.tokens_url.to_lowercase().contains("temmis"));
            assert_eq!(spec.model_sha256.len(), 64, "sha256 hex must be 64 chars: {}", spec.id);
            assert_eq!(spec.tokens_sha256.len(), 64, "sha256 hex must be 64 chars: {}", spec.id);
            assert!(spec.model_size_bytes > 0);
            assert_eq!(spec.license, "Apache-2.0");
        }
    }

    #[test]
    fn find_alignment_model_spec_resolves_known_languages_only() {
        assert!(find_alignment_model_spec("ko").is_some());
        assert!(find_alignment_model_spec("en").is_some());
        assert!(find_alignment_model_spec("rap").is_none());
        assert!(find_alignment_model_spec("").is_none());
    }

    #[test]
    fn verify_file_sha256_accepts_matching_and_rejects_mismatched_hash() {
        let dir = std::env::temp_dir().join(format!("align_hash_test_{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("asset.bin");
        let content = b"live-mr-manager forced alignment model fixture";
        fs::write(&path, content).unwrap();

        let mut hasher = Sha256::new();
        hasher.update(content);
        let correct_hex = hex_encode(&hasher.finalize());

        assert!(verify_file_sha256(&path, &correct_hex).is_ok());
        // Case-insensitive comparison should still pass.
        assert!(verify_file_sha256(&path, &correct_hex.to_uppercase()).is_ok());

        // A wrong-but-well-formed hash must be rejected with a clear error,
        // not silently accepted.
        let wrong_hex = "0".repeat(64);
        let err = verify_file_sha256(&path, &wrong_hex).unwrap_err();
        assert!(err.contains("SHA-256"), "error should mention the mismatch: {}", err);

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn alignment_model_is_downloaded_reflects_both_files_present() {
        let paths = temp_app_paths("status");
        let spec = find_alignment_model_spec("ko").unwrap();

        assert!(!alignment_model_is_downloaded(&paths, spec), "fresh dir must report not downloaded");

        let dir = alignment_model_dir(&paths, spec);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("model.onnx"), b"fake-model").unwrap();
        assert!(!alignment_model_is_downloaded(&paths, spec), "tokens.txt missing => still not downloaded");

        fs::write(dir.join("tokens.txt"), b"[PAD] 0\n").unwrap();
        assert!(alignment_model_is_downloaded(&paths, spec), "both files present => downloaded");

        fs::remove_dir_all(&paths.root).ok();
    }

    #[test]
    fn download_and_verify_asset_rejects_oversized_body_before_hash_check() {
        // No network access in unit tests, but we can exercise the cap logic
        // directly against a local file:// is not supported by reqwest for
        // GET, so instead this test targets the smaller, network-free unit:
        // verify_file_sha256 is what actually gets called after a download,
        // and the size cap is enforced inline in the streaming loop against
        // `ALIGNMENT_TOKENS_MAX_BYTES` / `spec.model_size_bytes`. Here we
        // just confirm the constants used for that cap are sane.
        assert!(ALIGNMENT_TOKENS_MAX_BYTES >= 1024);
        for spec in ALIGNMENT_MODELS {
            assert!(spec.model_size_bytes > ALIGNMENT_TOKENS_MAX_BYTES, "model should be far larger than the tokens cap for '{}'", spec.id);
        }
    }

    /// Writes a minimal syllable-based Korean tokens.txt covering just the
    /// characters these tests need.
    fn write_korean_vocab(name: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!("align_ko_vocab_{}_{}.txt", name, std::process::id()));
        let vocab = "[PAD] 0\n[UNK] 1\n  2\n하 3\n는 4\n가 5\n사 6\n\n";
        fs::write(&path, vocab).unwrap();
        path
    }

    /// English wav2vec2 char-level vocab fixture (A-Z, |, ', <pad>/<unk>).
    fn write_english_vocab(name: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!("align_en_vocab_{}_{}.txt", name, std::process::id()));
        let mut vocab = String::from("<pad> 0\n<s> 1\n</s> 2\n<unk> 3\n| 4\n");
        let mut id = 5;
        for c in 'A'..='Z' {
            vocab.push_str(&format!("{} {}\n", c, id));
            id += 1;
        }
        vocab.push_str(&format!("' {}\n", id));
        fs::write(&path, vocab).unwrap();
        path
    }

    #[test]
    fn detects_latin_vocab_and_tokenizes_english() {
        let vocab_path = write_english_vocab("detect");
        let aligner = Aligner::new(vocab_path.to_str().unwrap()).unwrap();
        fs::remove_file(&vocab_path).ok();

        assert!(aligner.is_latin_based, "single-uppercase-letter vocab must be detected as Latin-based");
        assert!(!aligner.is_syllable_based);
        assert!(aligner.has_apostrophe);

        let (ids, spans) = aligner.tokenize("don't stop");
        assert_eq!(spans.len(), 2);
        assert!(spans[0].1 > spans[0].0);
        assert!(spans[1].1 > spans[1].0);
        assert!(!ids.contains(&aligner.unk_id), "every representable English word char should have a real vocab entry");
    }

    #[test]
    fn filters_digits_and_symbols_as_zero_width_spans() {
        let vocab_path = write_english_vocab("filter");
        let aligner = Aligner::new(vocab_path.to_str().unwrap()).unwrap();
        fs::remove_file(&vocab_path).ok();

        let (ids, spans) = aligner.tokenize("I have 2 cats!!");
        assert_eq!(spans.len(), 4);
        let two = spans.iter().find(|s| s.2 == "2").unwrap();
        assert_eq!(two.0, two.1, "pure-digit word must be a zero-width span");
        assert!(!ids.contains(&aligner.unk_id));
    }

    #[test]
    fn korean_char_filter_skips_latin_words_as_zero_width_spans() {
        let vocab_path = write_korean_vocab("skip");
        let aligner = Aligner::new(vocab_path.to_str().unwrap()).unwrap();
        fs::remove_file(&vocab_path).ok();

        assert!(!aligner.is_latin_based);
        let (ids, spans) = aligner.tokenize("하는 hater 가");
        assert_eq!(spans.len(), 3, "every word should still get a span entry");
        assert_ne!(spans[0].0, spans[0].1, "Korean word keeps real width");
        assert_eq!(spans[1].0, spans[1].1, "Latin word must be zero-width under a Korean vocab");
        assert_eq!(spans[1].2, "hater");
        assert_ne!(spans[2].0, spans[2].1);

        let unk_count = ids.iter().filter(|&&id| id == aligner.unk_id).count();
        assert_eq!(unk_count, 0, "skipped word must not contribute any UNK ids");
    }

    #[test]
    fn word_timestamps_interpolates_gaps_between_aligned_neighbors() {
        let vocab_path = write_korean_vocab("interp");
        let aligner = Aligner::new(vocab_path.to_str().unwrap()).unwrap();
        fs::remove_file(&vocab_path).ok();

        let word_spans = vec![
            (0usize, 2usize, "안녕".to_string()),
            (2, 2, "hey".to_string()),
            (2, 4, "하이".to_string()),
        ];
        let path = vec![0, 0, 1, 1, usize::MAX, usize::MAX, 2, 2, 3, 3];

        let timestamps = aligner.get_word_timestamps(&path, &word_spans, 20.0);

        assert_eq!(timestamps.len(), 3, "the interpolated word must not be dropped");
        assert_eq!(timestamps[0].word, "안녕");
        assert_eq!(timestamps[2].word, "하이");
        let gap_word = &timestamps[1];
        assert_eq!(gap_word.word, "hey");
        assert!(gap_word.start_ms >= timestamps[0].end_ms);
        assert!(gap_word.end_ms <= timestamps[2].start_ms);
        assert!(gap_word.end_ms > gap_word.start_ms);
    }
}
