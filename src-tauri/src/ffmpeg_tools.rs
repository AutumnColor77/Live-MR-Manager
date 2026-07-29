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
