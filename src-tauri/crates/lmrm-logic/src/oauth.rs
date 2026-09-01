//! Songbook OAuth deep-link parsing (no Tauri / DB dependencies).

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OauthCallback {
    pub token: String,
    pub state: Option<String>,
}

fn query_param(raw: &str, key: &str) -> Option<String> {
    let q_start = raw.find('?')?;
    let query = raw[q_start + 1..].split('#').next().unwrap_or("");
    for pair in query.split('&') {
        let mut parts = pair.splitn(2, '=');
        let k = parts.next().unwrap_or("");
        if k != key {
            continue;
        }
        let v = parts.next().unwrap_or("");
        let decoded = urlencoding::decode(v).ok()?.into_owned();
        if decoded.is_empty() {
            return None;
        }
        return Some(decoded);
    }
    None
}

pub fn parse_oauth_callback_url(raw: &str) -> Option<OauthCallback> {
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
    let token = query_param(trimmed, "token")?;
    let state = query_param(trimmed, "state");
    Some(OauthCallback { token, state })
}

/// Strip bearer tokens from deep-link URLs before writing to app.log.
pub fn redact_oauth_url_for_log(raw: &str) -> String {
    let mut out = raw.to_string();
    let Some(start) = out.find("token=") else {
        return out;
    };
    let after = start + "token=".len();
    let rest = &out[after..];
    let end = rest
        .find(|c| c == '&' || c == '#' || c == ' ' || c == '"')
        .unwrap_or(rest.len());
    out.replace_range(after..after + end, "<redacted>");
    out
}

pub fn oauth_states_match(expected: &str, provided: &str) -> bool {
    let a = expected.as_bytes();
    let b = provided.as_bytes();
    if a.len() != b.len() {
        return false;
    }
    a.iter()
        .zip(b.iter())
        .fold(0u8, |acc, (x, y)| acc | (x ^ y))
        == 0
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ipc_validate;

    #[test]
    fn parses_desktop_oauth_callback_with_token() {
        // Low-entropy fixture (not a real credential). Allowed in .gitleaks.toml.
        let url = "live-mr-manager://oauth/callback?token=test-fixture-plain";
        let parsed = parse_oauth_callback_url(url).expect("parse");
        assert_eq!(parsed.token, "test-fixture-plain");
        assert_eq!(parsed.state, None);
    }

    #[test]
    fn parses_url_encoded_token() {
        let url = "live-mr-manager://oauth/callback?token=hello%2Bworld%2Fplain";
        assert_eq!(
            parse_oauth_callback_url(url).map(|c| c.token),
            Some("hello+world/plain".into())
        );
    }

    #[test]
    fn rejects_non_deep_link_schemes() {
        assert!(parse_oauth_callback_url("https://example.com/oauth/callback?token=x").is_none());
        assert!(parse_oauth_callback_url("http://localhost/oauth/callback?token=x").is_none());
    }

    #[test]
    fn rejects_deep_link_without_oauth_path() {
        assert!(parse_oauth_callback_url("live-mr-manager://settings?token=x").is_none());
    }

    #[test]
    fn rejects_oauth_callback_without_token() {
        assert!(parse_oauth_callback_url("live-mr-manager://oauth/callback?code=1").is_none());
        assert!(parse_oauth_callback_url("live-mr-manager://oauth/callback?token=").is_none());
    }

    #[test]
    fn stops_token_at_fragment_or_ampersand() {
        let url = "live-mr-manager://oauth/callback?token=part1&state=zz#frag";
        let parsed = parse_oauth_callback_url(url).expect("parse");
        assert_eq!(parsed.token, "part1");
        assert_eq!(parsed.state.as_deref(), Some("zz"));
    }

    #[test]
    fn trims_quotes_around_deep_link() {
        let url = "\"live-mr-manager://oauth/callback?token=quotedToken\"";
        assert_eq!(
            parse_oauth_callback_url(url).map(|c| c.token),
            Some("quotedToken".into())
        );
    }

    #[test]
    fn accepts_oauth_query_variant() {
        let url = "live-mr-manager://oauth?token=shortForm";
        assert_eq!(
            parse_oauth_callback_url(url).map(|c| c.token),
            Some("shortForm".into())
        );
    }

    #[test]
    fn redacts_token_query_for_logs() {
        let raw = "live-mr-manager://oauth/callback?token=secret-value&state=abc";
        let redacted = redact_oauth_url_for_log(raw);
        assert!(!redacted.contains("secret-value"));
        assert!(redacted.contains("token=<redacted>"));
        assert!(redacted.contains("state=abc"));
    }

    #[test]
    fn oauth_state_compare_is_length_checked() {
        assert!(oauth_states_match("abcd", "abcd"));
        assert!(!oauth_states_match("abcd", "abce"));
        assert!(!oauth_states_match("abc", "abcd"));
    }

    #[test]
    fn songbook_user_id_must_be_nonempty() {
        assert!(ipc_validate::require_nonempty("  ", "user.id").is_err());
        assert!(ipc_validate::require_nonempty("uid-1", "user.id").is_ok());
    }
}
