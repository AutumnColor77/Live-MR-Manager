//! ffmpeg discovery: managed cache, bundled tools, system PATH (where.exe on Windows).
//!
//! Managed download uses a pinned BtbN LGPL build and is not bundled in the app installer.
//! Keep FFmpeg as an arm's-length CLI tool; do not link libav* into the MIT application.
//! See THIRD_PARTY_NOTICES.md for source, license, and redistribution policy.

use sha2::{Digest, Sha256};
use std::io::Cursor;
use std::path::{Path, PathBuf};

const FFMPEG_RELEASE_TAG: &str = "autobuild-2026-06-30-13-34";
const FFMPEG_ARCHIVE: &str = "ffmpeg-N-125365-g9a01c1cb6a-win64-lgpl.zip";
const FFMPEG_ZIP_SHA256: &str = "75cb786fa14299eb1c1cacc2542a15c8da690e551ab41858383dc425c605b8ab";

pub fn tools_cache_dir() -> PathBuf {
    if let Ok(base) = std::env::var("LOCALAPPDATA").or_else(|_| std::env::var("APPDATA")) {
        return Path::new(&base).join("LiveMRManager").join("tools");
    }
    std::env::temp_dir().join("live-mr-manager-tools")
}

pub fn managed_ffmpeg_path() -> PathBuf {
    tools_cache_dir().join("ffmpeg.exe")
}

fn managed_ffmpeg_hash_path() -> PathBuf {
    tools_cache_dir().join("ffmpeg.archive.sha256")
}

fn managed_ffmpeg_is_current() -> bool {
    managed_ffmpeg_path().is_file()
        && std::fs::read_to_string(managed_ffmpeg_hash_path())
            .map(|hash| hash.trim().eq_ignore_ascii_case(FFMPEG_ZIP_SHA256))
            .unwrap_or(false)
}

/// Dirs shipped alongside the app. Excludes the managed cache, which is validated by hash.
fn ffmpeg_search_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(exe_dir) = exe.parent() {
            dirs.push(exe_dir.join("resources").join("tools"));
            dirs.push(exe_dir.join("tools"));
        }
    }
    dirs
}

pub fn find_bundled_ffmpeg() -> Option<PathBuf> {
    for dir in ffmpeg_search_dirs() {
        let p = dir.join("ffmpeg.exe");
        if p.is_file() {
            return Some(p);
        }
    }
    None
}

#[cfg(windows)]
pub fn find_system_ffmpeg() -> Option<PathBuf> {
    use std::os::windows::process::CommandExt;
    let output = std::process::Command::new("where.exe")
        .arg("ffmpeg")
        .creation_flags(0x08000000)
        .output()
        .ok()?;
    if output.status.success() {
        let p = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if !p.is_empty() {
            return Some(PathBuf::from(p.lines().next().unwrap_or(&p)));
        }
    }
    None
}

#[cfg(not(windows))]
pub fn find_system_ffmpeg() -> Option<PathBuf> {
    let output = std::process::Command::new("which")
        .arg("ffmpeg")
        .output()
        .ok()?;
    if output.status.success() {
        let p = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if !p.is_empty() {
            return Some(PathBuf::from(p));
        }
    }
    None
}

/// Sync lookup: managed cache → bundled → system PATH.
///
/// A managed copy from an earlier pinned build is ignored so callers fall through to
/// `ensure_managed_ffmpeg` and replace it with the current LGPL archive.
pub fn find_ffmpeg_executable() -> Option<PathBuf> {
    if managed_ffmpeg_is_current() {
        return Some(managed_ffmpeg_path());
    }
    if let Some(p) = find_bundled_ffmpeg() {
        return Some(p);
    }
    find_system_ffmpeg()
}

pub async fn ensure_managed_ffmpeg() -> Option<PathBuf> {
    let target = managed_ffmpeg_path();
    if managed_ffmpeg_is_current() {
        return Some(target);
    }
    if let Some(parent) = target.parent() {
        let _ = std::fs::create_dir_all(parent);
    }

    let zip_url = format!(
        "https://github.com/BtbN/FFmpeg-Builds/releases/download/{FFMPEG_RELEASE_TAG}/{FFMPEG_ARCHIVE}"
    );
    let response = reqwest::get(zip_url).await.ok()?;
    if !response.status().is_success() {
        return None;
    }
    let bytes = response.bytes().await.ok()?;
    let actual_hash = format!("{:x}", Sha256::digest(&bytes));
    if actual_hash != FFMPEG_ZIP_SHA256 {
        let _ = crate::audio_player::sys_log(&format!(
            "[FFmpeg] Download SHA-256 mismatch: expected {FFMPEG_ZIP_SHA256}, got {actual_hash}"
        ));
        return None;
    }
    let cursor = Cursor::new(bytes);
    let mut archive = zip::ZipArchive::new(cursor).ok()?;

    for i in 0..archive.len() {
        let mut entry = match archive.by_index(i) {
            Ok(v) => v,
            Err(_) => continue,
        };
        if !entry.is_file() {
            continue;
        }
        let name = entry.name().replace('\\', "/").to_lowercase();
        if name.ends_with("/ffmpeg.exe") || name.ends_with("/ffmpeg") {
            let mut content = Vec::new();
            if std::io::Read::read_to_end(&mut entry, &mut content).is_err() {
                continue;
            }
            if std::fs::write(&target, &content).is_err() {
                continue;
            }
            if target.is_file() {
                if std::fs::write(managed_ffmpeg_hash_path(), FFMPEG_ZIP_SHA256).is_err() {
                    let _ = crate::audio_player::sys_log(
                        "[FFmpeg] Executable installed, but version marker could not be written",
                    );
                }
                return Some(target);
            }
        }
    }
    None
}

/// Directory for yt-dlp `--ffmpeg-location`.
pub async fn resolve_ffmpeg_dir() -> Option<PathBuf> {
    if let Some(p) = ensure_managed_ffmpeg().await {
        return p.parent().map(|d| d.to_path_buf());
    }
    if let Some(p) = find_bundled_ffmpeg() {
        return p.parent().map(|d| d.to_path_buf());
    }
    find_system_ffmpeg().and_then(|p| p.parent().map(|d| d.to_path_buf()))
}

/// Sync lookup with blocking managed download on a separate thread (safe inside Tokio workers).
pub fn find_ffmpeg_executable_or_download() -> Option<PathBuf> {
    if let Some(p) = find_ffmpeg_executable() {
        return Some(p);
    }
    std::thread::spawn(|| {
        tokio::runtime::Runtime::new()
            .ok()?
            .block_on(ensure_managed_ffmpeg())
    })
    .join()
    .ok()
    .flatten()
}

/// Fallback decoder: decodes any audio format supported by FFmpeg (e.g. Opus, WebM) into interleaved f32 PCM samples (44100Hz, stereo).
pub fn decode_to_pcm_f32(path: &Path) -> Result<(Vec<f32>, u32, u8), String> {
    let ffmpeg = find_ffmpeg_executable_or_download()
        .ok_or_else(|| "FFmpeg 실행 파일을 찾을 수 없습니다.".to_string())?;

    let mut cmd = std::process::Command::new(&ffmpeg);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }

    cmd.args(&[
        "-nostdin",
        "-v", "error",
        "-i", path.to_str().ok_or_else(|| "Invalid input path".to_string())?,
        "-f", "f32le",
        "-ac", "2",
        "-ar", "44100",
        "pipe:1",
    ]);

    let output = cmd.output().map_err(|e| format!("FFmpeg 디코딩 실행 실패: {}", e))?;
    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr);
        return Err(format!("FFmpeg 디코딩 실패: {}", err.trim()));
    }

    let bytes = output.stdout;
    if bytes.len() % 4 != 0 {
        return Err("FFmpeg f32le 디코딩 데이터 크기가 올바르지 않습니다.".into());
    }

    let num_samples = bytes.len() / 4;
    let mut samples = Vec::with_capacity(num_samples);
    for chunk in bytes.chunks_exact(4) {
        let sample = f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]);
        samples.push(sample);
    }

    crate::audio_player::sys_log(&format!(
        "[FFmpeg] Successfully decoded fallback audio {:?} ({} samples, 44100Hz, 2ch)",
        path,
        samples.len()
    ));

    Ok((samples, 44100, 2))
}

/// Transcodes an unsupported audio file into a 16-bit PCM WAV for Rodio playback fallback.
pub fn transcode_to_wav_fallback(input_path: &Path, output_wav: &Path) -> Result<(), String> {
    let ffmpeg = find_ffmpeg_executable_or_download()
        .ok_or_else(|| "FFmpeg 실행 파일을 찾을 수 없습니다.".to_string())?;

    if let Some(parent) = output_wav.parent() {
        let _ = std::fs::create_dir_all(parent);
    }

    let mut cmd = std::process::Command::new(&ffmpeg);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000);
    }

    cmd.args(&[
        "-nostdin",
        "-y",
        "-v", "error",
        "-i", input_path.to_str().ok_or_else(|| "Invalid input path".to_string())?,
        "-vn",
        "-c:a", "pcm_s16le",
        "-ar", "44100",
        output_wav.to_str().ok_or_else(|| "Invalid output path".to_string())?,
    ]);

    let output = cmd.output().map_err(|e| format!("FFmpeg 변환 실행 실패: {}", e))?;
    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr);
        return Err(format!("FFmpeg 변환 실패: {}", err.trim()));
    }

    crate::audio_player::sys_log(&format!(
        "[FFmpeg] Successfully transcoded {:?} -> {:?}",
        input_path,
        output_wav
    ));

    Ok(())
}

/// Extract duration string (e.g. "3:45") via FFmpeg when Symphonia fails.
pub fn probe_duration_with_ffmpeg(path: &Path) -> Option<String> {
    let ffmpeg = find_ffmpeg_executable_or_download()?;
    let mut cmd = std::process::Command::new(&ffmpeg);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000);
    }

    cmd.args(&[
        "-nostdin",
        "-i", path.to_str()?,
    ]);

    let output = cmd.output().ok()?;
    let stderr = String::from_utf8_lossy(&output.stderr);
    
    // Look for "Duration: 00:03:09.24,"
    let dur_idx = stderr.find("Duration: ")?;
    let tail = &stderr[dur_idx + "Duration: ".len()..];
    let dur_str = tail.split(',').next()?.trim(); // e.g. "00:03:09.24"
    let parts: Vec<&str> = dur_str.split(':').collect();
    if parts.len() >= 3 {
        let hours: u64 = parts[0].parse().unwrap_or(0);
        let mins: u64 = parts[1].parse().unwrap_or(0);
        let secs: f64 = parts[2].parse().unwrap_or(0.0);
        let total_secs = (hours * 3600 + mins * 60) as f64 + secs;
        let total_s = total_secs.round() as u64;
        let m = total_s / 60;
        let s = total_s % 60;
        return Some(format!("{}:{:02}", m, s));
    }

    None
}
