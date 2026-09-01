use serde::Serialize;
use tauri::{AppHandle, Emitter};
use std::time::Duration;
use once_cell::sync::Lazy;
use parking_lot::Mutex;

const GITHUB_OWNER: &str = "AutumnColor77";
const GITHUB_REPO: &str = "Live-MR-Manager";
const USER_AGENT: &str = "Live-MR-Manager-UpdateChecker";

static UPDATE_INFO_CACHE: Lazy<Mutex<Option<AppUpdateInfo>>> = Lazy::new(|| Mutex::new(None));
static UPDATE_FETCH_LOCK: Lazy<tokio::sync::Mutex<()>> = Lazy::new(|| tokio::sync::Mutex::new(()));

use lmrm_logic::version::{default_release_url, strip_version_prefix, version_gt};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppUpdateInfo {
    pub current_version: String,
    pub latest_version: String,
    pub release_url: String,
    pub has_update: bool,
}

async fn github_get_json(client: &reqwest::Client, url: &str) -> Option<serde_json::Value> {
    let resp = client.get(url).send().await.ok()?;
    if !resp.status().is_success() {
        return None;
    }
    resp.json().await.ok()
}

async fn fetch_from_latest_release(client: &reqwest::Client) -> Option<(String, String)> {
    let url = format!(
        "https://api.github.com/repos/{}/{}/releases/latest",
        GITHUB_OWNER, GITHUB_REPO
    );
    let json = github_get_json(client, &url).await?;
    let tag = json.get("tag_name")?.as_str()?.to_string();
    let release_url = json
        .get("html_url")
        .and_then(|v| v.as_str())
        .unwrap_or(default_release_url().as_str())
        .to_string();
    Some((tag, release_url))
}

async fn fetch_from_tags(client: &reqwest::Client) -> Option<(String, String)> {
    let url = format!(
        "https://api.github.com/repos/{}/{}/tags?per_page=30",
        GITHUB_OWNER, GITHUB_REPO
    );
    let json = github_get_json(client, &url).await?;
    let tags = json.as_array()?;

    let mut best: Option<(semver::Version, String)> = None;
    for tag in tags {
        let name = tag.get("name")?.as_str()?;
        let normalized = strip_version_prefix(name);
        let Ok(version) = semver::Version::parse(&normalized) else {
            continue;
        };
        let replace = best
            .as_ref()
            .map(|(current, _)| version > *current)
            .unwrap_or(true);
        if replace {
            best = Some((version, name.to_string()));
        }
    }

    let (_, tag_name) = best?;
    Some((tag_name, default_release_url()))
}

async fn fetch_latest_release() -> Result<(String, String), String> {
    let client = reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| e.to_string())?;

    if let Some(found) = fetch_from_latest_release(&client).await {
        return Ok(found);
    }

    fetch_from_tags(&client)
        .await
        .ok_or_else(|| "GitHub에서 최신 버전 정보를 가져오지 못했습니다.".to_string())
}

async fn cached_build_update_info(force_refresh: bool) -> Result<AppUpdateInfo, String> {
    if !force_refresh {
        if let Some(info) = UPDATE_INFO_CACHE.lock().clone() {
            return Ok(info);
        }
    }

    let _guard = UPDATE_FETCH_LOCK.lock().await;

    if !force_refresh {
        if let Some(info) = UPDATE_INFO_CACHE.lock().clone() {
            return Ok(info);
        }
    }

    let info = build_update_info().await?;
    *UPDATE_INFO_CACHE.lock() = Some(info.clone());
    Ok(info)
}

pub async fn build_update_info() -> Result<AppUpdateInfo, String> {
    let current_version = env!("CARGO_PKG_VERSION").to_string();
    let (latest_tag, release_url) = fetch_latest_release().await?;
    let latest_version = strip_version_prefix(&latest_tag);
    let has_update = version_gt(&latest_version, &current_version);

    Ok(AppUpdateInfo {
        current_version,
        latest_version,
        release_url,
        has_update,
    })
}

#[tauri::command]
pub async fn check_for_app_update() -> Result<AppUpdateInfo, String> {
    cached_build_update_info(true).await
}

#[tauri::command]
pub async fn peek_app_update() -> Result<AppUpdateInfo, String> {
    cached_build_update_info(false).await
}

#[tauri::command]
pub async fn open_app_update_page(url: String) -> Result<(), String> {
    let target = if url.trim().is_empty() {
        default_release_url()
    } else {
        crate::ipc_validate::validate_external_open_url(&url)?
    };

    // cmd.exe `start "" "url"` via Command::args mangles nested quotes on Windows
    // (ShellExecute ends up with `\\` → 「₩₩을(를) 찾을 수 없습니다」). Use opener instead.
    tauri_plugin_opener::open_url(&target, None::<&str>).map_err(|e| e.to_string())
}

async fn check_and_notify(app: AppHandle) {
    match cached_build_update_info(false).await {
        Ok(info) if info.has_update => {
            crate::audio_player::sys_log(&format!(
                "[Updater] New version available: {} (current {})",
                info.latest_version, info.current_version
            ));
            let _ = app.emit("app-update-available", info);
        }
        Ok(_) => {}
        Err(e) => {
            crate::audio_player::sys_log(&format!("[Updater] Check skipped: {}", e));
        }
    }
}

pub fn start_update_checker(app: AppHandle) {
    if cfg!(debug_assertions) {
        crate::audio_player::sys_log("[Updater] Skipping auto-check in debug build");
        return;
    }

    tauri::async_runtime::spawn(async move {
        check_and_notify(app).await;
    });
}

