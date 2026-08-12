//! Library row classification helpers.

pub fn is_meloming_only_song(source: &str, path: &str) -> bool {
    source == "meloming" || path.starts_with("meloming:song:")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_meloming_source_rows() {
        assert!(is_meloming_only_song("meloming", "/any/path.mp3"));
        assert!(is_meloming_only_song("local", "meloming:song:abc"));
        assert!(!is_meloming_only_song("local", "C:\\Music\\a.mp3"));
        assert!(!is_meloming_only_song("youtube", "https://youtu.be/abc"));
    }

    #[test]
    fn meloming_prefix_is_case_sensitive_by_design() {
        assert!(!is_meloming_only_song("Meloming", "x"));
        assert!(!is_meloming_only_song("local", "Meloming:song:1"));
    }
}
