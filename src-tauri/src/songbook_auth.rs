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

pub fn parse_oauth_callback_url(raw: &str) -> Option<String> {
    let trimmed = raw.trim().trim_matches(|c| c == '"' || c == '\'');
    if !trimmed.starts_with("live-mr-manager:") {
        return None;
    }
    if !trimmed.contains("oauth/callback")
        && !trimmed.contains("oauth?")
        && !trimmed.contains("://oauth")
    {
        return None;
    }
    let idx = trimmed.find("token=")?;
    let rest = &trimmed[idx + "token=".len()..];
    let end = rest
        .find(|c| c == '&' || c == '#' || c == ' ' || c == '"')
        .unwrap_or(rest.len());
    let encoded = &rest[..end];
    let token = urlencoding::decode(encoded).ok()?.into_owned();
    if token.is_empty() {
        None
    } else {
        Some(token)
    }
}

pub fn apply_session_token(app: &AppHandle, token: &str) -> Result<(), String> {
    db_set(TOKEN_KEY, token)?;
    let _ = db_delete(USER_JSON_KEY);
    let _ = app.emit(
        "songbook-auth-changed",
        SongbookAuthState {
            logged_in: true,
            token: Some(token.to_string()),
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
