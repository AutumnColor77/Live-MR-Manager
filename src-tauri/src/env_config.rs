//! Environment loading and typed accessors for Live MR Manager.
//!
//! Secrets must never be committed. Prefer OS / CI environment variables in
//! production; `src-tauri/.env` is for local development only (gitignored).

use std::path::PathBuf;

/// Load `.env` files without overriding variables already set in the process.
/// Secrets are never logged.
pub fn load_env_files() {
    // 1) Explicit crate-local `.env` (dev: `src-tauri/.env`)
    let manifest_env = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(".env");
    match dotenvy::from_path(&manifest_env) {
        Ok(_) => crate::audio_player::sys_log("[Env] Loaded src-tauri/.env"),
        Err(dotenvy::Error::Io(_)) => {}
        Err(e) => crate::audio_player::sys_log(&format!("[Env] src-tauri/.env parse warning: {e}")),
    }

    // 2) Optional CWD `.env` (e.g. repo root when launched from tooling)
    match dotenvy::dotenv() {
        Ok(path) => {
            if path != manifest_env {
                crate::audio_player::sys_log(&format!(
                    "[Env] Loaded {}",
                    path.display()
                ));
            }
        }
        Err(dotenvy::Error::Io(_)) => {}
        Err(e) => crate::audio_player::sys_log(&format!("[Env] CWD .env parse warning: {e}")),
    }

    // Validate optional overrides without logging secret values.
    let _ = discord_webhook_url();
    if discord_invite_url().is_some() {
        crate::audio_player::sys_log("[Env] DISCORD_INVITE_URL override active");
    }
    if let Some(base) = songbook_base_url() {
        crate::audio_player::sys_log(&format!("[Env] SONGBOOK_BASE_URL override active: {base}"));
    }
}

fn env_trimmed(key: &str) -> Option<String> {
    std::env::var(key)
        .ok()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
}

/// Optional Discord webhook (CI / local announce scripts). Never required at runtime.
pub fn discord_webhook_url() -> Option<String> {
    let url = env_trimmed("DISCORD_WEBHOOK_URL")?;
    if crate::ipc_validate::is_discord_webhook_url(&url) {
        Some(url)
    } else {
        crate::audio_player::sys_log(
            "[Env] DISCORD_WEBHOOK_URL ignored: expected https://discord.com/api/webhooks/...",
        );
        None
    }
}

/// Public Discord invite URL override (optional).
pub fn discord_invite_url() -> Option<String> {
    let url = env_trimmed("DISCORD_INVITE_URL")?;
    if url.starts_with("https://discord.gg/") || url.starts_with("https://discord.com/invite/") {
        Some(url)
    } else {
        crate::audio_player::sys_log("[Env] DISCORD_INVITE_URL ignored: invalid invite host");
        None
    }
}

/// Songbook API base URL override for development.
pub fn songbook_base_url() -> Option<String> {
    let url = env_trimmed("SONGBOOK_BASE_URL")?;
    if crate::ipc_validate::is_allowed_songbook_base(&url) {
        Some(url.trim_end_matches('/').to_string())
    } else {
        crate::audio_player::sys_log("[Env] SONGBOOK_BASE_URL ignored: host not allowlisted");
        None
    }
}

/// GPU provider opt-in. Unset defaults to enabled (Windows DirectML/CUDA path).
pub fn gpu_opt_in() -> bool {
    match env_trimmed("LIVE_MR_ENABLE_GPU") {
        None => true,
        Some(v) => matches!(
            v.as_str(),
            "1" | "true" | "TRUE" | "yes" | "YES"
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_non_webhook_discord_url() {
        std::env::set_var("DISCORD_WEBHOOK_URL", "https://example.com/hook");
        assert!(discord_webhook_url().is_none());
        std::env::remove_var("DISCORD_WEBHOOK_URL");
    }
}
