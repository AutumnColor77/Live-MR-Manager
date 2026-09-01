use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

const TOKEN_KEY: &str = "songbook_session_token";
const USER_JSON_KEY: &str = "songbook_user_json";
const OAUTH_STATE_KEY: &str = "songbook_oauth_state";
const OAUTH_STATE_AT_KEY: &str = "songbook_oauth_state_at";
const OAUTH_BASE_KEY: &str = "songbook_oauth_base";
const OAUTH_STATE_TTL_SECS: u64 = 180;
const DEFAULT_SONGBOOK_BASE: &str = "https://www.livemrsongbook.com";
const EXCHANGE_TIMEOUT_SECS: u64 = 20;

#[derive(Debug, Clone, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SongbookUser {
    pub id: String,
    pub email: String,
    pub name: String,
    pub picture: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SongbookAuthState {
    pub logged_in: bool,
    pub token: Option<String>,
    pub user: Option<SongbookUser>,
}

fn db_get(key: &str) -> Option<String> {
    let db = crate::state::DB.lock();
    db.query_row("SELECT value FROM Settings WHERE key = ?1", [key], |row| {
        row.get::<_, String>(0)
    })
    .ok()
}

fn db_set(key: &str, value: &str) -> Result<(), String> {
    let db = crate::state::DB.lock();
    db.execute(
        "INSERT INTO Settings (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        [key, value],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

fn db_delete(key: &str) -> Result<(), String> {
    let db = crate::state::DB.lock();
    db.execute("DELETE FROM Settings WHERE key = ?1", [key])
        .map_err(|e| e.to_string())?;
    Ok(())
}

pub use lmrm_logic::oauth::parse_oauth_callback_url;

fn unix_now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn random_oauth_state() -> Result<String, String> {
    let mut bytes = [0u8; 16];
    getrandom::getrandom(&mut bytes).map_err(|e| e.to_string())?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

fn peek_pending_oauth_state(callback_state: Option<&str>) -> Result<String, String> {
    let stored = db_get(OAUTH_STATE_KEY).ok_or_else(|| "로그인을 다시 시작해 주세요.".to_string())?;
    let started_at = db_get(OAUTH_STATE_AT_KEY)
        .and_then(|s| s.parse::<u64>().ok())
        .unwrap_or(0);
    if unix_now().saturating_sub(started_at) > OAUTH_STATE_TTL_SECS {
        return Err("로그인 요청이 만료되었습니다. 다시 시도해 주세요.".into());
    }
    if let Some(got) = callback_state {
        if !lmrm_logic::oauth::oauth_states_match(&stored, got) {
            return Err("OAuth state가 일치하지 않습니다.".into());
        }
    }
    Ok(stored)
}

fn resolve_songbook_base(base_url: Option<&str>) -> Result<String, String> {
    let candidate = base_url
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.trim_end_matches('/').to_string())
        .or_else(crate::env_config::songbook_base_url)
        .unwrap_or_else(|| DEFAULT_SONGBOOK_BASE.to_string());
    if !crate::ipc_validate::is_allowed_songbook_base(&candidate) {
        return Err("허용되지 않은 Songbook 주소입니다.".into());
    }
    Ok(candidate)
}

#[tauri::command]
pub fn begin_songbook_oauth(app: AppHandle, base_url: Option<String>) -> Result<String, String> {
    let base = resolve_songbook_base(base_url.as_deref())?;
    let state = random_oauth_state()?;
    db_set(OAUTH_BASE_KEY, &base)?;
    db_set(OAUTH_STATE_KEY, &state)?;
    db_set(OAUTH_STATE_AT_KEY, &unix_now().to_string())?;
    let poll_app = app.clone();
    let poll_base = base.clone();
    let poll_state = state.clone();
    tauri::async_runtime::spawn(async move {
        poll_desktop_handoff(poll_app, poll_base, poll_state).await;
    });
    Ok(state)
}

fn emit_auth_error(app: &AppHandle, message: &str) {
    let _ = app.emit(
        "songbook-auth-error",
        serde_json::json!({ "message": message }),
    );
}

fn store_session_token(app: &AppHandle, token: &str) -> Result<(), String> {
    let token = crate::ipc_validate::validate_session_token(token)?;
    db_set(TOKEN_KEY, &token)?;
    let _ = db_delete(USER_JSON_KEY);
    let _ = db_delete(OAUTH_STATE_KEY);
    let _ = db_delete(OAUTH_STATE_AT_KEY);
    let _ = db_delete(OAUTH_BASE_KEY);
    let _ = app.emit(
        "songbook-auth-changed",
        SongbookAuthState {
            logged_in: true,
            token: Some(token),
            user: None,
        },
    );
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
    crate::audio_player::sys_log("[SongbookAuth] session token stored from desktop-exchange");
    Ok(())
}

#[derive(serde::Deserialize)]
struct DesktopExchangeResponse {
    token: Option<String>,
}

async fn exchange_desktop_code(base: &str, code: &str) -> Result<String, String> {
    let url = crate::ipc_validate::songbook_desktop_exchange_url(base)?;
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(EXCHANGE_TIMEOUT_SECS))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| format!("로그인 서버에 연결하지 못했습니다. ({e})"))?;
    let response = client
        .post(&url)
        .json(&serde_json::json!({ "code": code }))
        .send()
        .await
        .map_err(|_| "로그인 서버에 연결하지 못했습니다.".to_string())?;
    let status = response.status();
    let body = response
        .json::<DesktopExchangeResponse>()
        .await
        .ok();
    if !status.is_success() {
        if status.as_u16() == 400 {
            return Err("로그인 코드가 만료되었거나 올바르지 않습니다. 다시 시도해 주세요.".into());
        }
        return Err("로그인에 실패했습니다. 다시 시도해 주세요.".into());
    }
    let token = body
        .and_then(|b| b.token)
        .filter(|t| !t.trim().is_empty())
        .ok_or_else(|| "로그인 서버가 세션을 주지 않았습니다.".to_string())?;
    Ok(token)
}

const POLL_INTERVAL_MS: u64 = 1_000;
const POLL_ATTEMPTS: u32 = 90;

async fn poll_desktop_state(base: &str, state: &str) -> Result<Option<String>, String> {
    let url = crate::ipc_validate::songbook_desktop_exchange_url(base)?;
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(EXCHANGE_TIMEOUT_SECS))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "로그인 서버에 연결하지 못했습니다.".to_string())?;
    let response = client
        .post(&url)
        .json(&serde_json::json!({ "state": state }))
        .send()
        .await
        .map_err(|_| "로그인 서버에 연결하지 못했습니다.".to_string())?;
    let status = response.status();
    if status.as_u16() == 404 {
        return Ok(None);
    }
    let body = response.json::<DesktopExchangeResponse>().await.ok();
    if !status.is_success() {
        return Ok(None);
    }
    Ok(body.and_then(|b| b.token).filter(|t| !t.trim().is_empty()))
}

async fn poll_desktop_handoff(app: AppHandle, base: String, state: String) {
    for _ in 0..POLL_ATTEMPTS {
        tokio::time::sleep(std::time::Duration::from_millis(POLL_INTERVAL_MS)).await;
        if db_get(OAUTH_STATE_KEY).as_deref() != Some(state.as_str()) {
            return;
        }
        match poll_desktop_state(&base, &state).await {
            Ok(Some(token)) => {
                if let Err(err) = store_session_token(&app, &token) {
                    crate::audio_player::sys_log(&format!(
                        "[SongbookAuth] poll store failed: {err}"
                    ));
                }
                return;
            }
            Ok(None) => {}
            Err(err) => {
                crate::audio_player::sys_log(&format!(
                    "[SongbookAuth] desktop-poll: {err}"
                ));
            }
        }
    }
}

pub fn handle_deep_link_urls(app: &AppHandle, urls: &[String]) {
    for raw in urls {
        crate::audio_player::sys_log(&format!(
            "[SongbookAuth] deep-link recv: {}",
            lmrm_logic::oauth::redact_oauth_url_for_log(raw)
        ));
        if let Some(parsed) = parse_oauth_callback_url(raw) {
            let code = match crate::ipc_validate::validate_handoff_code(&parsed.code) {
                Ok(code) => code,
                Err(err) => {
                    crate::audio_player::sys_log(&format!(
                        "[SongbookAuth] invalid handoff code: {err}"
                    ));
                    emit_auth_error(app, &err);
                    continue;
                }
            };
            if let Err(err) = peek_pending_oauth_state(parsed.state.as_deref()) {
                if db_get(TOKEN_KEY).is_some() {
                    continue;
                }
                crate::audio_player::sys_log(&format!(
                    "[SongbookAuth] oauth state rejected: {err}"
                ));
                emit_auth_error(app, &err);
                continue;
            }
            let base = db_get(OAUTH_BASE_KEY)
                .and_then(|b| resolve_songbook_base(Some(&b)).ok())
                .or_else(|| resolve_songbook_base(None).ok())
                .unwrap_or_else(|| DEFAULT_SONGBOOK_BASE.to_string());
            let app_handle = app.clone();
            tauri::async_runtime::spawn(async move {
                match exchange_desktop_code(&base, &code).await {
                    Ok(token) => {
                        if let Err(err) = store_session_token(&app_handle, &token) {
                            crate::audio_player::sys_log(&format!(
                                "[SongbookAuth] failed to store token: {err}"
                            ));
                            emit_auth_error(&app_handle, &err);
                        }
                    }
                    Err(err) => {
                        if db_get(TOKEN_KEY).is_some() {
                            return;
                        }
                        crate::audio_player::sys_log(&format!(
                            "[SongbookAuth] desktop-exchange failed: {err}"
                        ));
                        emit_auth_error(&app_handle, &err);
                    }
                }
            });
        } else if raw.contains("live-mr-manager:") {
            crate::audio_player::sys_log("[SongbookAuth] deep-link ignored (no code)");
        }
    }
}

#[tauri::command]
pub fn get_songbook_auth() -> Result<SongbookAuthState, String> {
    let token = db_get(TOKEN_KEY);
    let user = db_get(USER_JSON_KEY).and_then(|json| serde_json::from_str(&json).ok());
    Ok(SongbookAuthState {
        logged_in: token.is_some(),
        token,
        user,
    })
}

#[tauri::command]
pub fn set_songbook_user(user: SongbookUser) -> Result<(), String> {
    crate::ipc_validate::require_nonempty(&user.id, "user.id")?;
    crate::ipc_validate::require_max_len(&user.id, crate::ipc_validate::MAX_USER_FIELD_LEN, "user.id")?;
    crate::ipc_validate::require_max_len(&user.email, crate::ipc_validate::MAX_USER_FIELD_LEN, "user.email")?;
    crate::ipc_validate::require_max_len(&user.name, crate::ipc_validate::MAX_USER_FIELD_LEN, "user.name")?;
    crate::ipc_validate::require_max_len(
        &user.picture,
        crate::ipc_validate::MAX_URL_LEN,
        "user.picture",
    )?;
    let json = serde_json::to_string(&user).map_err(|e| e.to_string())?;
    db_set(USER_JSON_KEY, &json)
}

#[tauri::command]
pub fn clear_songbook_auth(app: AppHandle) -> Result<(), String> {
    db_delete(TOKEN_KEY)?;
    db_delete(USER_JSON_KEY)?;
    let _ = db_delete(OAUTH_STATE_KEY);
    let _ = db_delete(OAUTH_STATE_AT_KEY);
    let _ = db_delete(OAUTH_BASE_KEY);
    let _ = app.emit(
        "songbook-auth-changed",
        SongbookAuthState {
            logged_in: false,
            token: None,
            user: None,
        },
    );
    Ok(())
}
