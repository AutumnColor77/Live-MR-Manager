//! Shared validation helpers for Tauri IPC commands.
//! Keep checks cheap, deterministic, and free of secret logging.

use std::path::{Component, PathBuf};

pub const MAX_LOG_MSG_LEN: usize = 4_096;
pub const MAX_PATH_LEN: usize = 4_096;
pub const MAX_URL_LEN: usize = 2_048;
pub const MAX_SESSION_TOKEN_LEN: usize = 8_192;
pub const MAX_SEARCH_QUERY_LEN: usize = 200;
pub const MAX_USER_FIELD_LEN: usize = 512;

pub fn require_nonempty<'a>(value: &'a str, field: &str) -> Result<&'a str, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(format!("{field}이(가) 비어 있습니다."));
    }
    Ok(trimmed)
}

pub fn require_max_len(value: &str, max: usize, field: &str) -> Result<(), String> {
    if value.len() > max {
        return Err(format!("{field} 길이가 허용 한도({max})를 초과합니다."));
    }
    Ok(())
}

/// Reject NUL and control characters that break path APIs / shell usage.
pub fn validate_path_string(path: &str) -> Result<&str, String> {
    let trimmed = require_nonempty(path, "경로")?;
    require_max_len(trimmed, MAX_PATH_LEN, "경로")?;
    if trimmed.chars().any(|c| c.is_control()) {
        return Err("경로에 허용되지 않는 제어 문자가 포함되어 있습니다.".into());
    }
    Ok(trimmed)
}

/// Soft path hygiene: reject empty components after normalize (does not require existence).
pub fn validate_filesystem_path(path: &str) -> Result<PathBuf, String> {
    let trimmed = validate_path_string(path)?;
    let pb = PathBuf::from(trimmed);
    if pb.as_os_str().is_empty() {
        return Err("경로가 비어 있습니다.".into());
    }
    for component in pb.components() {
        if matches!(component, Component::ParentDir) {
            // Parent (`..`) is allowed for relative paths but not as the only means
            // of escaping via repeated `..` into absolute roots from untrusted IPC.
            // Absolute paths with `..` are normalized by the OS; still reject raw `..`
            // segments on relative inputs to reduce traversal surprises.
            if !pb.is_absolute() {
                return Err("상대 경로에 '..'는 허용되지 않습니다.".into());
            }
        }
    }
    Ok(pb)
}

pub fn is_discord_webhook_url(url: &str) -> bool {
    let u = url.trim();
    u.starts_with("https://discord.com/api/webhooks/")
        || u.starts_with("https://discordapp.com/api/webhooks/")
}

pub fn is_allowed_songbook_base(url: &str) -> bool {
    let Ok(parsed) = url::Url::parse(url.trim()) else {
        return false;
    };
    match parsed.scheme() {
        "https" => matches!(
            parsed.host_str(),
            Some("www.livemrsongbook.com")
                | Some("livemrsongbook.com")
                | Some("live-mr-songbook.boohun2771.workers.dev")
        ),
        "http" => matches!(parsed.host_str(), Some("localhost") | Some("127.0.0.1")),
        _ => false,
    }
}

fn host_path_allowed(host: &str, path: &str) -> bool {
    match host {
        "www.livemrsongbook.com" | "livemrsongbook.com" => true,
        "live-mr-songbook.boohun2771.workers.dev" => true,
        "accounts.google.com" => true,
        "nid.naver.com" => true,
        "lmrm.vercel.app" => true,
        "discord.gg" => true,
        "discord.com" => path.starts_with("/invite/"),
        "github.com" => {
            path.starts_with("/AutumnColor77/Live-MR-Manager")
                || path.starts_with("/BtbN/FFmpeg-Builds")
                || path.starts_with("/yt-dlp/yt-dlp")
        }
        "localhost" | "127.0.0.1" => true,
        _ => false,
    }
}

/// External browser open allowlist (mirrors `capabilities/default.json` opener rules).
pub fn validate_external_open_url(url: &str) -> Result<String, String> {
    let trimmed = require_nonempty(url, "URL")?;
    require_max_len(trimmed, MAX_URL_LEN, "URL")?;

    let parsed = url::Url::parse(trimmed).map_err(|_| "URL 형식이 올바르지 않습니다.".to_string())?;
    let scheme = parsed.scheme();
    let host = parsed.host_str().ok_or_else(|| "URL 호스트가 없습니다.".to_string())?;
    let path = parsed.path();

    match scheme {
        "https" => {
            if host_path_allowed(host, path) {
                Ok(trimmed.to_string())
            } else {
                Err("허용되지 않은 외부 URL입니다.".into())
            }
        }
        "http" => {
            if matches!(host, "localhost" | "127.0.0.1") && host_path_allowed(host, path) {
                Ok(trimmed.to_string())
            } else {
                Err("http는 localhost만 허용됩니다.".into())
            }
        }
        _ => Err("http(s) URL만 허용됩니다.".into()),
    }
}

pub fn validate_youtube_or_http_url(url: &str) -> Result<String, String> {
    let trimmed = require_nonempty(url, "URL")?;
    require_max_len(trimmed, MAX_URL_LEN, "URL")?;
    if !(trimmed.starts_with("https://") || trimmed.starts_with("http://")) {
        return Err("http(s) URL만 허용됩니다.".into());
    }
    let parsed = url::Url::parse(trimmed).map_err(|_| "URL 형식이 올바르지 않습니다.".to_string())?;
    match parsed.host_str() {
        Some("youtu.be")
        | Some("youtube.com")
        | Some("www.youtube.com")
        | Some("m.youtube.com")
        | Some("music.youtube.com") => Ok(trimmed.to_string()),
        _ => Err("YouTube URL만 허용됩니다.".into()),
    }
}

pub fn validate_local_audio_path(path: &str) -> Result<String, String> {
    let pb = validate_filesystem_path(path)?;
    let ext = pb
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    const ALLOWED: &[&str] = &["mp3", "wav", "flac", "m4a", "aac", "ogg", "wma", "opus"];
    if !ALLOWED.contains(&ext.as_str()) {
        return Err(format!("지원하지 않는 오디오 확장자입니다: .{ext}"));
    }
    if !pb.exists() {
        return Err("오디오 파일을 찾을 수 없습니다.".into());
    }
    if !pb.is_file() {
        return Err("파일 경로가 아닙니다.".into());
    }
    Ok(pb.to_string_lossy().into_owned())
}

pub fn validate_audio_source(path_or_url: &str) -> Result<String, String> {
    let trimmed = require_nonempty(path_or_url, "경로")?;
    require_max_len(trimmed, MAX_PATH_LEN.max(MAX_URL_LEN), "경로")?;
    if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
        validate_youtube_or_http_url(trimmed)
    } else {
        validate_local_audio_path(trimmed)
    }
}

pub fn validate_session_token(token: &str) -> Result<String, String> {
    let trimmed = require_nonempty(token, "세션 토큰")?;
    require_max_len(trimmed, MAX_SESSION_TOKEN_LEN, "세션 토큰")?;
    if trimmed.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err("세션 토큰 형식이 올바르지 않습니다.".into());
    }
    // Opaque bearer tokens: prefer URL-safe / base64ish charset
    if !trimmed
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | '+' | '/' | '='))
    {
        return Err("세션 토큰에 허용되지 않는 문자가 있습니다.".into());
    }
    Ok(trimmed.to_string())
}

pub fn validate_search_query(query: &str) -> Result<String, String> {
    let trimmed = require_nonempty(query, "검색어")?;
    require_max_len(trimmed, MAX_SEARCH_QUERY_LEN, "검색어")?;
    Ok(trimmed.to_string())
}

pub fn sanitize_log_message(msg: &str) -> String {
    let truncated: String = msg.chars().take(MAX_LOG_MSG_LEN).collect();
    truncated
        .chars()
        .map(|c| if c.is_control() && c != '\t' { ' ' } else { c })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn external_open_allowlist() {
        assert!(validate_external_open_url(
            "https://github.com/AutumnColor77/Live-MR-Manager/releases"
        )
        .is_ok());
        assert!(validate_external_open_url("https://lmrm.vercel.app/faq").is_ok());
        assert!(validate_external_open_url("https://discord.gg/qfJnk3VJyf").is_ok());
        assert!(validate_external_open_url(
            "https://github.com/BtbN/FFmpeg-Builds/releases/tag/x"
        )
        .is_ok());
        assert!(validate_external_open_url("https://evil.example/").is_err());
        assert!(validate_external_open_url("http://github.com/AutumnColor77/Live-MR-Manager").is_err());
    }

    #[test]
    fn youtube_url_allowlist() {
        assert!(validate_youtube_or_http_url("https://www.youtube.com/watch?v=dQw4w9WgXcQ").is_ok());
        assert!(validate_youtube_or_http_url("https://youtu.be/dQw4w9WgXcQ").is_ok());
        assert!(validate_youtube_or_http_url("https://example.com/watch").is_err());
    }

    #[test]
    fn discord_webhook_shape() {
        assert!(is_discord_webhook_url(
            "https://discord.com/api/webhooks/123/abc"
        ));
        assert!(is_discord_webhook_url(
            "https://discordapp.com/api/webhooks/999/token"
        ));
        assert!(!is_discord_webhook_url("https://discord.gg/invite"));
        assert!(!is_discord_webhook_url("https://evil.example/api/webhooks/1/2"));
        assert!(!is_discord_webhook_url("http://discord.com/api/webhooks/1/2"));
    }

    #[test]
    fn songbook_base_allowlist() {
        assert!(is_allowed_songbook_base("https://www.livemrsongbook.com"));
        assert!(is_allowed_songbook_base("http://localhost:5173"));
        assert!(is_allowed_songbook_base(
            "https://live-mr-songbook.boohun2771.workers.dev"
        ));
        assert!(!is_allowed_songbook_base("https://evil.example"));
        assert!(!is_allowed_songbook_base("ftp://localhost"));
    }

    #[test]
    fn session_token_validation() {
        assert!(validate_session_token("abc.def-ghi_123").is_ok());
        assert!(validate_session_token("").is_err());
        assert!(validate_session_token("has space").is_err());
        assert!(validate_session_token("bad\ntoken").is_err());
        assert!(validate_session_token(&"a".repeat(MAX_SESSION_TOKEN_LEN + 1)).is_err());
    }

    #[test]
    fn sanitize_log_strips_controls_and_truncates() {
        let dirty = format!("ok\u{0000}line\n{}", "x".repeat(MAX_LOG_MSG_LEN + 50));
        let clean = sanitize_log_message(&dirty);
        assert!(!clean.contains('\0'));
        assert!(clean.chars().count() <= MAX_LOG_MSG_LEN);
    }

    #[test]
    fn discord_invite_open_urls_allowed() {
        assert!(validate_external_open_url("https://discord.gg/qfJnk3VJyf").is_ok());
        assert!(validate_external_open_url("https://discord.com/invite/qfJnk3VJyf").is_ok());
    }

    #[test]
    fn search_query_bounds() {
        assert!(validate_search_query("IU celebrity").is_ok());
        assert!(validate_search_query("   ").is_err());
        assert!(validate_search_query(&"q".repeat(MAX_SEARCH_QUERY_LEN + 1)).is_err());
    }
}
