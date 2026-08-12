//! App update version helpers.

const GITHUB_OWNER: &str = "AutumnColor77";
const GITHUB_REPO: &str = "Live-MR-Manager";

pub fn default_release_url() -> String {
    format!("https://github.com/{}/{}/releases", GITHUB_OWNER, GITHUB_REPO)
}

pub fn strip_version_prefix(tag: &str) -> String {
    tag.trim()
        .trim_start_matches('v')
        .trim_start_matches('V')
        .to_string()
}

pub fn version_gt(a: &str, b: &str) -> bool {
    let a = strip_version_prefix(a);
    let b = strip_version_prefix(b);
    match (semver::Version::parse(&a), semver::Version::parse(&b)) {
        (Ok(va), Ok(vb)) => va > vb,
        _ => a != b && a > b,
    }
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
