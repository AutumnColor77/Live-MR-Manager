//! MR separated-audio cache path setting.
//!
//! Local disk is the recommended/default location (matches the bounded LRC
//! sync-status scan in `alignment::classify_lyric_sync_status`, which relies
//! on fast local `stat`/mtime checks). A writable network share may be
//! configured instead, but the UI must warn about performance before saving.
//! The chosen path only takes effect on next launch (`AppPaths::from_handle`
//! reads it at startup), so every command here just validates + persists the
//! setting; nothing here should try to migrate already-separated files.

use std::path::{Path, PathBuf};
use tauri::State;

use crate::state::{default_separated_dir, AppConfig, AppPaths};

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MrCachePathInfo {
    /// Raw custom base folder as saved (parent of the `separated` subfolder), if any.
    pub custom_path: Option<String>,
    /// The `separated` folder actually in use for this running session.
    pub effective_path: String,
    /// What `effective_path` would be with no custom override.
    pub default_path: String,
    pub is_custom: bool,
    pub is_network_path: bool,
    /// True when a custom path is saved but wasn't applied this session
    /// (e.g. network share unreachable at startup, so the default was used).
    pub pending_restart: bool,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CachePathCheckResult {
    pub writable: bool,
    pub is_network_path: bool,
    pub error: Option<String>,
}

/// Best-effort heuristic — UNC paths (`\\server\share\...` or `//server/share`)
/// are always network shares. Mapped drive letters can't be distinguished
/// from local drives without extra OS APIs, so those just don't trigger the
/// warning; the writability check still runs regardless.
fn is_likely_network_path(path: &Path) -> bool {
    let s = path.to_string_lossy();
    s.starts_with("\\\\") || s.starts_with("//")
}

fn probe_writable(target: &Path) -> Result<(), String> {
    std::fs::create_dir_all(target)
        .map_err(|e| format!("폴더를 만들 수 없습니다: {}", e))?;
    let probe = target.join(".livemr_write_test");
    std::fs::write(&probe, b"ok")
        .map_err(|e| format!("폴더에 쓸 수 없습니다 (읽기 전용이거나 권한 부족): {}", e))?;
    let _ = std::fs::remove_file(&probe);
    Ok(())
}

#[tauri::command]
pub fn get_mr_cache_path_info(paths: State<'_, AppPaths>) -> MrCachePathInfo {
    let config = AppConfig::load(&paths.root);
    let default_path = default_separated_dir(&paths.root);
    let custom_path = config
        .mr_separated_path
        .as_ref()
        .map(|p| p.trim().to_string())
        .filter(|p| !p.is_empty());
    let is_custom = custom_path.is_some();

    // If a custom path is set but the currently-active `separated` dir still
    // matches the default, the override couldn't be applied this session
    // (see AppPaths::from_handle's fallback) and needs a restart + fixed path.
    let pending_restart = is_custom && paths.separated == default_path;

    MrCachePathInfo {
        custom_path,
        effective_path: paths.separated.to_string_lossy().to_string(),
        default_path: default_path.to_string_lossy().to_string(),
        is_custom,
        is_network_path: is_likely_network_path(&paths.separated),
        pending_restart,
    }
}

#[tauri::command]
pub async fn check_mr_cache_path(path: String) -> CachePathCheckResult {
    let trimmed = match crate::ipc_validate::validate_path_string(&path) {
        Ok(v) => v,
        Err(e) => {
            return CachePathCheckResult {
                writable: false,
                is_network_path: false,
                error: Some(e),
            };
        }
    };
    let base = PathBuf::from(trimmed);
    let is_network = is_likely_network_path(&base);
    let target = base.join("separated");
    match probe_writable(&target) {
        Ok(()) => CachePathCheckResult { writable: true, is_network_path: is_network, error: None },
        Err(e) => CachePathCheckResult { writable: false, is_network_path: is_network, error: Some(e) },
    }
}

/// Persists the custom cache path after re-validating it's writable.
/// `path: None` (or empty) resets to the default local location. Does not
/// move existing separated files — the user must re-separate or move them
/// manually; the app just starts looking in the new place after restart.
#[tauri::command]
pub async fn set_mr_cache_path(paths: State<'_, AppPaths>, path: Option<String>) -> Result<(), String> {
    let normalized = match path {
        Some(p) => {
            let trimmed = p.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(crate::ipc_validate::validate_path_string(trimmed)?.to_string())
            }
        }
        None => None,
    };

    if let Some(p) = &normalized {
        let target = PathBuf::from(p).join("separated");
        probe_writable(&target)?;
    }

    let cfg = AppConfig { mr_separated_path: normalized, ..AppConfig::load(&paths.root) };
    AppConfig::save(&paths.root, &cfg).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn pick_mr_cache_folder() -> Option<String> {
    let picked = rfd::AsyncFileDialog::new().pick_folder().await?;
    Some(picked.path().to_string_lossy().to_string())
}

// --- Overlay LAN exposure setting (companion to the cache path setting —
// same "persist now, apply on next launch" model) ---

#[tauri::command]
pub fn get_overlay_lan_setting(paths: State<'_, AppPaths>) -> bool {
    AppConfig::load(&paths.root).overlay_allow_lan
}

#[tauri::command]
pub fn set_overlay_lan_setting(paths: State<'_, AppPaths>, enabled: bool) -> Result<(), String> {
    let cfg = AppConfig { overlay_allow_lan: enabled, ..AppConfig::load(&paths.root) };
    AppConfig::save(&paths.root, &cfg).map_err(|e| e.to_string())
}
