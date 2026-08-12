use serde::Serialize;
use tauri::{AppHandle, Emitter};
use std::time::Duration;

const GITHUB_OWNER: &str = "AutumnColor77";
const GITHUB_REPO: &str = "Live-MR-Manager";
const USER_AGENT: &str = "Live-MR-Manager-UpdateChecker";
/// 앱 최초 기동 후 한 번만 자동 확인 (이후는 설정의 「업데이트 확인」 버튼)
const STARTUP_CHECK_DELAY: Duration = Duration::from_secs(8);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppUpdateInfo {
    pub current_version: String,
    pub latest_version: String,
    pub release_url: String,
    pub has_update: bool,
}

fn default_release_url() -> String {
    format!("https://github.com/{}/{}/releases", GITHUB_OWNER, GITHUB_REPO)
}

fn strip_version_prefix(tag: &str) -> String {
    tag.trim().trim_start_matches('v').trim_start_matches('V').to_string()
}

fn version_gt(a: &str, b: &str) -> bool {
    let a = strip_version_prefix(a);
    let b = strip_version_prefix(b);
    match (semver::Version::parse(&a), semver::Version::parse(&b)) {
        (Ok(va), Ok(vb)) => va > vb,
        _ => a != b && a > b,
    }
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
    build_update_info().await
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
    match build_update_info().await {
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
        tokio::time::sleep(STARTUP_CHECK_DELAY).await;
        check_and_notify(app).await;
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_v_prefix() {
        assert_eq!(strip_version_prefix("v0.7.3"), "0.7.3");
        assert_eq!(strip_version_prefix("V1.2.0"), "1.2.0");
        assert_eq!(strip_version_prefix(" 0.7.3 "), "0.7.3");
    }

    #[test]
    fn compares_semver_versions() {
        assert!(version_gt("0.7.4", "0.7.3"));
        assert!(version_gt("v1.0.0", "0.9.9"));
        assert!(!version_gt("0.7.3", "0.7.3"));
        assert!(!version_gt("0.7.2", "0.7.3"));
    }

    #[test]
    fn default_release_url_points_at_this_repo() {
        let url = default_release_url();
        assert!(url.contains("AutumnColor77/Live-MR-Manager/releases"));
        assert!(url.starts_with("https://github.com/"));
    }
}
