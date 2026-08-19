//! Shared YouTube URL parsing helpers.

/// Minimum bytes before a streaming YouTube cache file is treated as playable.
pub const YOUTUBE_STREAM_MIN_BYTES: u64 = 8192;

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

fn fnv1a64(s: &str) -> u64 {
    let mut hash: u64 = 0xcbf29ce484222325;
    for byte in s.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    hash
}

/// Temp audio filename for a YouTube URL. Never `yt_unknown.m4a` (avoids collisions).
pub fn youtube_audio_cache_filename(url: &str) -> String {
    if let Some(id) = extract_youtube_video_id(url) {
        let safe: String = id
            .chars()
            .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
            .collect();
        if !safe.is_empty() {
            return format!("yt_{}.m4a", safe);
        }
    }
    format!("yt_{:x}.m4a", fnv1a64(url.trim()))
}

pub fn youtube_cache_bytes_ready(len: u64) -> bool {
    len >= YOUTUBE_STREAM_MIN_BYTES
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

    #[test]
    fn extracts_embed_and_music() {
        assert_eq!(
            extract_youtube_video_id("https://www.youtube.com/embed/abc123xyz01").as_deref(),
            Some("abc123xyz01")
        );
        assert_eq!(
            extract_youtube_video_id("https://music.youtube.com/watch?v=xyz789abc01&list=foo")
                .as_deref(),
            Some("xyz789abc01")
        );
    }

    #[test]
    fn cache_filename_uses_video_id_not_unknown() {
        assert_eq!(
            youtube_audio_cache_filename("https://youtu.be/dQw4w9WgXcQ?t=5"),
            "yt_dQw4w9WgXcQ.m4a"
        );
        let hashed = youtube_audio_cache_filename("https://example.com/not-youtube");
        assert!(hashed.starts_with("yt_"));
        assert!(hashed.ends_with(".m4a"));
        assert!(!hashed.contains("unknown"));
    }

    #[test]
    fn cache_ready_threshold() {
        assert!(!youtube_cache_bytes_ready(0));
        assert!(!youtube_cache_bytes_ready(8191));
        assert!(youtube_cache_bytes_ready(8192));
    }
}
