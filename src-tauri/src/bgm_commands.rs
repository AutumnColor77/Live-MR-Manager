//! Broadcast BGM — second rodio Player on the shared mixer.
//! Progressive YouTube cache (same as library play): start once the header is ready,
//! do not wait for the full file and do not emit `separation-progress`.

use crate::audio_commands::ensure_youtube_audio_file_ex;
use crate::audio_player::{sys_log, to_device_format, StreamingReader, AUDIO_HANDLER};
use crate::youtube::YoutubeManager;
use crate::youtube_url::youtube_audio_cache_filename;
use once_cell::sync::Lazy;
use parking_lot::Mutex;
use rodio::Source;
use std::io::BufReader;
use std::num::{NonZeroU16, NonZeroU32};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::{Emitter, Manager, WebviewWindow};

static BGM_URL: Lazy<Mutex<Option<String>>> = Lazy::new(|| Mutex::new(None));
static BGM_PATH: Lazy<Mutex<Option<PathBuf>>> = Lazy::new(|| Mutex::new(None));
static BGM_LOOP: AtomicBool = AtomicBool::new(true);
static BGM_AUTO_ENABLED: AtomicBool = AtomicBool::new(true);
static BGM_HAS_TRACK: AtomicBool = AtomicBool::new(false);
static BGM_GENERATION: AtomicU64 = AtomicU64::new(0);
static BGM_FADE_GENERATION: AtomicU64 = AtomicU64::new(0);

/// How long to keep retrying decode while the cache is still growing / downloading.
const BGM_DECODE_RETRY_BUDGET: Duration = Duration::from_secs(45);
const BGM_DECODE_RETRY_SLEEP: Duration = Duration::from_millis(350);
/// Fade / silence handoff between broadcast BGM and a library song.
pub const BGM_FADE_MS: u64 = 1500;
pub const BGM_GAP_MS: u64 = 3000;

#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct BgmState {
    pub playing: bool,
    pub has_track: bool,
    pub url: Option<String>,
    pub volume: u32,
    pub loop_enabled: bool,
    pub position_ms: u64,
}

fn handler() -> Result<Arc<crate::audio_player::AudioHandler>, String> {
    AUDIO_HANDLER
        .as_ref()
        .map(|h| h.clone())
        .map_err(|e| e.clone())
}

fn preferred_bgm_gain(handler: &crate::audio_player::AudioHandler) -> f32 {
    let pct = handler.bgm_volume.load(Ordering::SeqCst).min(100) as f32;
    (pct / 100.0).clamp(0.0, 1.0)
}

fn apply_bgm_volume(handler: &crate::audio_player::AudioHandler) {
    handler
        .bgm_controller
        .lock()
        .set_volume(preferred_bgm_gain(handler));
}

fn set_bgm_gain(handler: &crate::audio_player::AudioHandler, gain: f32) {
    handler
        .bgm_controller
        .lock()
        .set_volume(gain.clamp(0.0, 1.0));
}

fn bgm_is_audible(handler: &crate::audio_player::AudioHandler) -> bool {
    if !BGM_HAS_TRACK.load(Ordering::SeqCst) {
        return false;
    }
    let bgm = handler.bgm_controller.lock();
    !bgm.is_paused() && !bgm.empty()
}

async fn fade_bgm_gain(
    handler: &crate::audio_player::AudioHandler,
    from: f32,
    to: f32,
    duration_ms: u64,
    fade_gen: u64,
) {
    if duration_ms == 0 || (from - to).abs() < 0.001 {
        set_bgm_gain(handler, to);
        return;
    }
    let steps = ((duration_ms / 50).max(1)).min(60);
    let step_ms = duration_ms / steps;
    for i in 0..=steps {
        if BGM_FADE_GENERATION.load(Ordering::SeqCst) != fade_gen {
            return;
        }
        let t = i as f32 / steps as f32;
        set_bgm_gain(handler, from + (to - from) * t);
        if i < steps {
            tokio::time::sleep(Duration::from_millis(step_ms)).await;
        }
    }
}

/// Fade BGM out (if audible), pause it, then wait for the song gap.
/// Called from `play_track` right before the main player starts.
pub async fn duck_before_main_track() {
    if !BGM_AUTO_ENABLED.load(Ordering::SeqCst) {
        return;
    }
    let Ok(handler) = handler() else {
        return;
    };
    if !BGM_HAS_TRACK.load(Ordering::SeqCst) {
        return;
    }

    let fade_gen = BGM_FADE_GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    if bgm_is_audible(&handler) {
        let from = preferred_bgm_gain(&handler);
        sys_log(&format!(
            "[BGM] Fade out {}ms then {}ms gap before song",
            BGM_FADE_MS, BGM_GAP_MS
        ));
        fade_bgm_gain(&handler, from, 0.0, BGM_FADE_MS, fade_gen).await;
        if BGM_FADE_GENERATION.load(Ordering::SeqCst) != fade_gen {
            return;
        }
        handler.bgm_controller.lock().pause();
    } else {
        sys_log(&format!(
            "[BGM] {}ms gap before song (already held)",
            BGM_GAP_MS
        ));
    }

    tokio::time::sleep(Duration::from_millis(BGM_GAP_MS)).await;
}

/// Resume held BGM with fade-in (gap should already have been waited by caller if needed).
pub async fn fade_resume_bgm(duration_ms: Option<u64>) -> Result<BgmState, String> {
    let handler = handler()?;
    if !BGM_HAS_TRACK.load(Ordering::SeqCst) {
        return Ok(bgm_state_inner(&handler));
    }

    let fade_ms = duration_ms.unwrap_or(BGM_FADE_MS);
    let fade_gen = BGM_FADE_GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    let target = preferred_bgm_gain(&handler);

    set_bgm_gain(&handler, 0.0);
    let empty = {
        let bgm = handler.bgm_controller.lock();
        bgm.empty()
    };
    if empty {
        let path = BGM_PATH.lock().clone();
                    if let Some(path) = path {
            append_bgm_from_path(handler.clone(), path, None).await?;
        } else {
            return Ok(bgm_state_inner(&handler));
        }
    }
    {
        let bgm = handler.bgm_controller.lock();
        bgm.play();
    }
    sys_log(&format!("[BGM] Fade in {}ms", fade_ms));
    fade_bgm_gain(&handler, 0.0, target, fade_ms, fade_gen).await;
    Ok(bgm_state_inner(&handler))
}

fn file_len(path: &PathBuf) -> u64 {
    std::fs::metadata(path).map(|m| m.len()).unwrap_or(0)
}

fn still_downloading(path: &PathBuf) -> bool {
    crate::audio_player::ACTIVE_DOWNLOADS.lock().contains(path)
}

/// Blocking decode+append. Safe to call from `spawn_blocking`.
fn append_bgm_from_path_blocking(
    handler: &crate::audio_player::AudioHandler,
    path: &PathBuf,
    start_pos_ms: Option<u64>,
) -> Result<(), String> {
    let deadline = Instant::now() + BGM_DECODE_RETRY_BUDGET;
    #[allow(unused_assignments)]
    let mut last_err: Option<String> = None;
    let mut last_len = file_len(path);

    loop {
        let reader = match StreamingReader::new(path.clone(), true) {
            Ok(r) => r,
            Err(e) => {
                last_err = Some(e.to_string());
                if Instant::now() >= deadline {
                    break;
                }
                std::thread::sleep(BGM_DECODE_RETRY_SLEEP);
                continue;
            }
        };
        match rodio::Decoder::new(BufReader::new(reader)) {
            Ok(mut decoder) => {
                if let Some(ms) = start_pos_ms.filter(|m| *m > 0) {
                    if let Err(e) = decoder.try_seek(Duration::from_millis(ms)) {
                        sys_log(&format!(
                            "[BGM] Seek to {}ms failed (starting from 0): {}",
                            ms, e
                        ));
                    }
                }
                let target_rate =
                    NonZeroU32::new(handler.active_sample_rate).unwrap_or(NonZeroU32::MIN);
                let target_ch =
                    NonZeroU16::new(handler.active_channels).unwrap_or(NonZeroU16::MIN);
                let resampled = to_device_format(decoder, target_ch, target_rate);
                {
                    let bgm = handler.bgm_controller.lock();
                    bgm.append(resampled);
                }
                apply_bgm_volume(handler);
                return Ok(());
            }
            Err(e) => {
                last_err = Some(e.to_string());
            }
        }

        if Instant::now() >= deadline {
            break;
        }

        let len = file_len(path);
        let growing = len > last_len || still_downloading(path);
        if len > last_len {
            last_len = len;
        }
        if !growing && Instant::now() + BGM_DECODE_RETRY_SLEEP >= deadline {
            // File is idle and won't grow — fail sooner.
            break;
        }
        std::thread::sleep(BGM_DECODE_RETRY_SLEEP);
    }

    Err(YoutubeManager::user_facing_error(&format!(
        "BGM 디코딩 실패: {}",
        last_err.unwrap_or_else(|| "unknown".into())
    )))
}

async fn append_bgm_from_path(
    handler: Arc<crate::audio_player::AudioHandler>,
    path: PathBuf,
    start_pos_ms: Option<u64>,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        append_bgm_from_path_blocking(&handler, &path, start_pos_ms)
    })
    .await
    .map_err(|e| YoutubeManager::user_facing_error(&format!("BGM 디코드 작업 실패: {}", e)))?
}

fn spawn_bgm_loop_monitor(
    handler: Arc<crate::audio_player::AudioHandler>,
    path: PathBuf,
    gen: u64,
    window: WebviewWindow,
) {
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_millis(500)).await;
            if BGM_GENERATION.load(Ordering::SeqCst) != gen {
                break;
            }
            if !BGM_HAS_TRACK.load(Ordering::SeqCst) {
                break;
            }
            let (empty, paused) = {
                let bgm = handler.bgm_controller.lock();
                (bgm.empty(), bgm.is_paused())
            };
            // Natural end: queue empty while still "playing" (not ducked/paused).
            if !(empty && !paused) {
                continue;
            }

            if BGM_LOOP.load(Ordering::SeqCst) {
                sys_log("[BGM] Loop restart");
                {
                    let bgm = handler.bgm_controller.lock();
                    bgm.clear();
                }
                let h = handler.clone();
                let p = path.clone();
                if let Err(e) = append_bgm_from_path(h, p, None).await {
                    sys_log(&format!("[BGM] Loop restart failed: {}", e));
                    BGM_HAS_TRACK.store(false, Ordering::SeqCst);
                    break;
                }
                handler.bgm_controller.lock().play();
                continue;
            }

            // Playlist advance is handled on the frontend via this event.
            let ended_url = BGM_URL.lock().clone();
            BGM_HAS_TRACK.store(false, Ordering::SeqCst);
            {
                let bgm = handler.bgm_controller.lock();
                bgm.stop();
                bgm.clear();
            }
            sys_log("[BGM] Track ended (no single-track loop)");
            window
                .emit(
                    "bgm-status",
                    serde_json::json!({ "status": "ended", "url": ended_url }),
                )
                .ok();
            break;
        }
    });
}

async fn try_append_with_optional_redownload(
    window: &WebviewWindow,
    handler: Arc<crate::audio_player::AudioHandler>,
    url: &str,
    dest: &PathBuf,
    start_pos_ms: Option<u64>,
) -> Result<(), String> {
    match append_bgm_from_path(handler.clone(), dest.clone(), start_pos_ms).await {
        Ok(()) => Ok(()),
        Err(first_err) => {
            sys_log(&format!(
                "[BGM] Decode failed, discarding cache and re-downloading: {}",
                first_err
            ));
            let _ = std::fs::remove_file(dest);
            crate::audio_player::DOWNLOAD_ERRORS.lock().remove(dest);
            ensure_youtube_audio_file_ex(window, url, dest, false)
                .await
                .map_err(|e| YoutubeManager::user_facing_error(&e))?;
            if !dest.exists() {
                return Err(YoutubeManager::user_facing_error(
                    "BGM 오디오 파일을 준비하지 못했습니다.",
                ));
            }
            append_bgm_from_path(handler, dest.clone(), start_pos_ms).await
        }
    }
}

#[tauri::command]
pub async fn bgm_play(
    window: WebviewWindow,
    url: String,
    loop_enabled: Option<bool>,
    volume: Option<u32>,
    start_position_ms: Option<u64>,
) -> Result<BgmState, String> {
    let url = crate::ipc_validate::validate_youtube_or_http_url(&url)?;
    let loop_on = loop_enabled.unwrap_or(true);
    BGM_LOOP.store(loop_on, Ordering::SeqCst);
    let start_ms = start_position_ms.filter(|m| *m > 0);

    let handler = handler()?;
    if let Some(v) = volume {
        handler.bgm_volume.store(v.min(100), Ordering::SeqCst);
    }

    let gen = BGM_GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    {
        let bgm = handler.bgm_controller.lock();
        bgm.stop();
        bgm.clear();
    }
    BGM_HAS_TRACK.store(false, Ordering::SeqCst);

    window
        .emit(
            "bgm-status",
            serde_json::json!({ "status": "downloading", "url": url }),
        )
        .ok();

    let temp_dir = window.state::<crate::state::AppPaths>().temp.clone();
    let dest = temp_dir.join(youtube_audio_cache_filename(&url));
    // Progressive: same as library play — do NOT wait_for_full (avoids long waits
    // and separation-progress spam on the AI tasks page).
    ensure_youtube_audio_file_ex(&window, &url, &dest, false)
        .await
        .map_err(|e| YoutubeManager::user_facing_error(&e))?;

    if !dest.exists() {
        return Err(YoutubeManager::user_facing_error(
            "BGM 오디오 파일을 준비하지 못했습니다.",
        ));
    }

    try_append_with_optional_redownload(&window, handler.clone(), &url, &dest, start_ms).await?;
    {
        let bgm = handler.bgm_controller.lock();
        bgm.play();
    }

    *BGM_URL.lock() = Some(url.clone());
    *BGM_PATH.lock() = Some(dest.clone());
    BGM_HAS_TRACK.store(true, Ordering::SeqCst);
    spawn_bgm_loop_monitor(handler.clone(), dest, gen, window.clone());

    sys_log(&format!(
        "[BGM] Playing (stream) {} @ {}ms",
        url,
        start_ms.unwrap_or(0)
    ));
    window
        .emit(
            "bgm-status",
            serde_json::json!({ "status": "playing", "url": url }),
        )
        .ok();

    Ok(bgm_state_inner(&handler))
}

#[tauri::command]
pub fn bgm_pause() -> Result<BgmState, String> {
    let handler = handler()?;
    if BGM_HAS_TRACK.load(Ordering::SeqCst) {
        handler.bgm_controller.lock().pause();
        sys_log("[BGM] Paused (position kept)");
    }
    Ok(bgm_state_inner(&handler))
}

#[tauri::command]
pub async fn bgm_resume() -> Result<BgmState, String> {
    // Instant resume (pause toggle). Song handoff uses `bgm_fade_resume`.
    let handler = handler()?;
    if BGM_HAS_TRACK.load(Ordering::SeqCst) {
        BGM_FADE_GENERATION.fetch_add(1, Ordering::SeqCst);
        apply_bgm_volume(&handler);
        let empty = {
            let bgm = handler.bgm_controller.lock();
            bgm.empty()
        };
        if empty {
            let path = BGM_PATH.lock().clone();
            if let Some(path) = path {
                append_bgm_from_path(handler.clone(), path, None).await?;
                handler.bgm_controller.lock().play();
            }
        } else {
            handler.bgm_controller.lock().play();
        }
        sys_log("[BGM] Resumed");
    }
    Ok(bgm_state_inner(&handler))
}

#[tauri::command]
pub async fn bgm_fade_resume(duration_ms: Option<u64>) -> Result<BgmState, String> {
    fade_resume_bgm(duration_ms).await
}

/// Fade out then pause — used when the main song resumes from pause
/// (no 3s gap; that gap is only for a fresh song start).
#[tauri::command]
pub async fn bgm_fade_pause(duration_ms: Option<u64>) -> Result<BgmState, String> {
    let handler = handler()?;
    if !BGM_HAS_TRACK.load(Ordering::SeqCst) {
        return Ok(bgm_state_inner(&handler));
    }
    let fade_ms = duration_ms.unwrap_or(BGM_FADE_MS);
    let fade_gen = BGM_FADE_GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    if bgm_is_audible(&handler) {
        let from = preferred_bgm_gain(&handler);
        sys_log(&format!("[BGM] Fade pause {}ms (song resumed)", fade_ms));
        fade_bgm_gain(&handler, from, 0.0, fade_ms, fade_gen).await;
        if BGM_FADE_GENERATION.load(Ordering::SeqCst) != fade_gen {
            return Ok(bgm_state_inner(&handler));
        }
    }
    handler.bgm_controller.lock().pause();
    Ok(bgm_state_inner(&handler))
}

#[tauri::command]
pub fn bgm_stop() -> Result<BgmState, String> {
    BGM_GENERATION.fetch_add(1, Ordering::SeqCst);
    let handler = handler()?;
    {
        let bgm = handler.bgm_controller.lock();
        bgm.stop();
        bgm.clear();
    }
    BGM_HAS_TRACK.store(false, Ordering::SeqCst);
    *BGM_URL.lock() = None;
    *BGM_PATH.lock() = None;
    sys_log("[BGM] Stopped");
    Ok(bgm_state_inner(&handler))
}

#[tauri::command]
pub fn bgm_set_volume(volume: u32) -> Result<BgmState, String> {
    let handler = handler()?;
    handler.bgm_volume.store(volume.min(100), Ordering::SeqCst);
    apply_bgm_volume(&handler);
    Ok(bgm_state_inner(&handler))
}

#[tauri::command]
pub fn bgm_set_loop(loop_enabled: bool) -> Result<BgmState, String> {
    BGM_LOOP.store(loop_enabled, Ordering::SeqCst);
    let handler = handler()?;
    Ok(bgm_state_inner(&handler))
}

#[tauri::command]
pub fn bgm_set_auto_enabled(enabled: bool) -> Result<BgmState, String> {
    BGM_AUTO_ENABLED.store(enabled, Ordering::SeqCst);
    let handler = handler()?;
    Ok(bgm_state_inner(&handler))
}

#[tauri::command]
pub fn bgm_get_state() -> Result<BgmState, String> {
    let handler = handler()?;
    Ok(bgm_state_inner(&handler))
}

fn bgm_state_inner(handler: &crate::audio_player::AudioHandler) -> BgmState {
    let has_track = BGM_HAS_TRACK.load(Ordering::SeqCst);
    let (playing, position_ms) = if has_track {
        let bgm = handler.bgm_controller.lock();
        (
            !bgm.is_paused() && !bgm.empty(),
            bgm.get_pos().as_millis() as u64,
        )
    } else {
        (false, 0)
    };
    BgmState {
        playing,
        has_track,
        url: BGM_URL.lock().clone(),
        volume: handler.bgm_volume.load(Ordering::SeqCst).min(100),
        loop_enabled: BGM_LOOP.load(Ordering::SeqCst),
        position_ms,
    }
}

#[tauri::command]
pub async fn bgm_prepare(window: WebviewWindow, url: String) -> Result<(), String> {
    let url = crate::ipc_validate::validate_youtube_or_http_url(&url)?;
    let temp_dir = window.state::<crate::state::AppPaths>().temp.clone();
    let dest = temp_dir.join(youtube_audio_cache_filename(&url));
    ensure_youtube_audio_file_ex(&window, &url, &dest, false)
        .await
        .map_err(|e| YoutubeManager::user_facing_error(&e))?;
    Ok(())
}
