use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

const TOKEN_KEY: &str = "songbook_session_token";
const USER_JSON_KEY: &str = "songbook_user_json";

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

pub fn apply_session_token(app: &AppHandle, token: &str) -> Result<(), String> {
    let token = crate::ipc_validate::validate_session_token(token)?;
    db_set(TOKEN_KEY, &token)?;
    let _ = db_delete(USER_JSON_KEY);
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
    crate::audio_player::sys_log("[SongbookAuth] session token stored from deep link");
    Ok(())
}

pub fn handle_deep_link_urls(app: &AppHandle, urls: &[String]) {
    for raw in urls {
        crate::audio_player::sys_log(&format!("[SongbookAuth] deep-link recv: {raw}"));
        if let Some(token) = parse_oauth_callback_url(raw) {
            if let Err(err) = apply_session_token(app, &token) {
                crate::audio_player::sys_log(&format!(
                    "[SongbookAuth] failed to store token: {err}"
                ));
            }
        } else if raw.contains("live-mr-manager:") {
            crate::audio_player::sys_log("[SongbookAuth] deep-link ignored (no token)");
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

