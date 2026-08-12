//! Songbook OAuth deep-link parsing (no Tauri / DB dependencies).

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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ipc_validate;

    #[test]
    fn parses_desktop_oauth_callback_with_token() {
        // Low-entropy fixture (not a real credential). Allowed in .gitleaks.toml.
        let url = "live-mr-manager://oauth/callback?token=test-fixture-plain";
        assert_eq!(
            parse_oauth_callback_url(url).as_deref(),
            Some("test-fixture-plain")
        );
    }

    #[test]
    fn parses_url_encoded_token() {
        let url = "live-mr-manager://oauth/callback?token=hello%2Bworld%2Fplain";
        assert_eq!(
            parse_oauth_callback_url(url).as_deref(),
            Some("hello+world/plain")
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
        assert_eq!(parse_oauth_callback_url(url).as_deref(), Some("part1"));
    }

    #[test]
    fn trims_quotes_around_deep_link() {
        let url = "\"live-mr-manager://oauth/callback?token=quotedToken\"";
        assert_eq!(parse_oauth_callback_url(url).as_deref(), Some("quotedToken"));
    }

    #[test]
    fn accepts_oauth_query_variant() {
        let url = "live-mr-manager://oauth?token=shortForm";
        assert_eq!(parse_oauth_callback_url(url).as_deref(), Some("shortForm"));
    }

    #[test]
    fn songbook_user_id_must_be_nonempty() {
        assert!(ipc_validate::require_nonempty("  ", "user.id").is_err());
        assert!(ipc_validate::require_nonempty("uid-1", "user.id").is_ok());
    }
}
