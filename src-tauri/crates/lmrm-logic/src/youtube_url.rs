//! Shared YouTube URL parsing helpers.

pub fn extract_youtube_video_id(url: &str) -> Option<String> {
    let u = url.trim();
    if let Some(idx) = u.find("youtu.be/") {
        let tail = &u[idx + "youtu.be/".len()..];
        let id = tail
            .split(&['?', '&', '/', '#'][..])
            .next()
            .unwrap_or("")
            .trim();
        if !id.is_empty() {
            return Some(id.to_string());
        }
    }
    if let Some(idx) = u.find("watch?v=") {
        let tail = &u[idx + "watch?v=".len()..];
        let id = tail
            .split(&['&', '/', '#', '?'][..])
            .next()
            .unwrap_or("")
            .trim();
        if !id.is_empty() {
            return Some(id.to_string());
        }
    }
    if let Some(idx) = u.find("/shorts/") {
        let tail = &u[idx + "/shorts/".len()..];
        let id = tail
            .split(&['?', '&', '/', '#'][..])
            .next()
            .unwrap_or("")
            .trim();
        if !id.is_empty() {
            return Some(id.to_string());
        }
    }
    if let Some(idx) = u.find("/embed/") {
        let tail = &u[idx + "/embed/".len()..];
        let id = tail
            .split(&['?', '&', '/', '#'][..])
            .next()
            .unwrap_or("")
            .trim();
        if !id.is_empty() {
            return Some(id.to_string());
        }
    }
    None
}

pub fn cache_key_variants(path: &str) -> Vec<String> {
    let mut variants = vec![path.trim().replace('\\', "/")];
    if let Some(id) = extract_youtube_video_id(path) {
        variants.push(format!("https://youtu.be/{}", id));
        variants.push(format!("https://www.youtube.com/watch?v={}", id));
        variants.push(format!("https://youtube.com/watch?v={}", id));
    }
    variants.sort();
    variants.dedup();
    variants
}

pub fn normalize_cache_key(path: &str) -> String {
    let normalized = path.trim().replace('\\', "/");
    if let Some(id) = extract_youtube_video_id(&normalized) {
        return format!("https://www.youtube.com/watch?v={}", id);
    }
    normalized
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_from_youtu_be() {
        assert_eq!(
            extract_youtube_video_id("https://youtu.be/abc123?t=10").as_deref(),
            Some("abc123")
        );
    }

    #[test]
    fn extracts_from_watch_url() {
        assert_eq!(
            extract_youtube_video_id("https://www.youtube.com/watch?v=xyz789&list=foo").as_deref(),
            Some("xyz789")
        );
    }

    #[test]
    fn normalize_cache_key_prefers_canonical_youtube() {
        assert_eq!(
            normalize_cache_key("https://youtu.be/abc123?t=5"),
            "https://www.youtube.com/watch?v=abc123"
        );
    }

    #[test]
    fn cache_key_variants_include_aliases() {
        let variants = cache_key_variants("https://youtu.be/abc123");
        assert!(variants.iter().any(|v| v.contains("youtu.be/abc123")));
        assert!(variants
            .iter()
            .any(|v| v.contains("youtube.com/watch?v=abc123")));
    }

    #[test]
    fn rejects_non_youtube_for_id_extract() {
        assert!(extract_youtube_video_id("https://vimeo.com/123").is_none());
        assert!(extract_youtube_video_id("C:\\local\\track.mp3").is_none());
    }
}
