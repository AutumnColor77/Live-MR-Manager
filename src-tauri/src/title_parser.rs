//! 유튜브 영상 제목/업로더에서 곡 제목·아티스트를 추정한다.
//!
//! 지금까지는 영상 제목을 그대로 곡 제목에, 업로더를 그대로 아티스트에 넣었는데,
//! 실제로는 `(아티스트) - 곡제목 (부가설명)`, `아티스트 - 곡제목 (Official MV)`처럼
//! 훨씬 자주 규칙적인 패턴을 따른다. 이 패턴은 정규식으로 충분히 잡히므로
//! ML 없이 휴리스틱 파서로 처리한다.
//!
//! 결과는 항상 곡 추가 창의 편집 가능한 입력란에 프리필될 뿐이라, 잘못 파싱돼도
//! 사용자가 바로 고칠 수 있다(기존의 "영상 제목 그대로"보다 나쁠 일은 없다).

use regex::Regex;

/// 제목에 흔히 붙는 부가설명 라벨 — 실제 아티스트/제목이 아니므로 통째로 제거.
/// (가사 정렬의 코러스 처리와 같은 원리: 화이트리스트에 정확히 일치할 때만 제거,
/// 그 외엔 원문을 보존해 진짜 이름을 실수로 지우지 않는다.)
fn is_title_descriptor(inner: &str) -> bool {
    const LABELS: &[&str] = &[
        "official video", "official mv", "official music video", "m/v", "mv",
        "official audio", "audio", "lyrics", "lyric video", "official lyric video",
        "color coded lyrics", "han/rom/eng lyrics", "가사", "가사포함", "가사 포함",
        "자막", "sub", "eng sub", "han sub", "rom sub", "가사 자막",
        "hd", "4k", "1080p", "60fps",
        "live", "live clip", "cover", "dance practice", "안무영상", "안무 영상",
        "안무", "교차편집", "visualizer", "performance video", "music video",
        "official teaser", "teaser", "trailer", "mv teaser", "highlight medley",
        "쇼케이스", "showcase", "behind", "making film", "mv making",
        "official", "prod", "prod.",
    ];
    let normalized = inner.trim().to_lowercase();
    LABELS.contains(&normalized.as_str())
}

/// 제목 안의 `[]`/`()`/`〈〉`/`【】` 부가설명을 제거한다. 화이트리스트에 정확히
/// 일치하는 것만 지우고, 그 외엔 **괄호째 그대로 둔다**(제거하지도 벗기지도
/// 않음) — "(여자)아이들"처럼 이름 중간에 낀 괄호를 잘못 풀어 공백을 끼워넣는
/// 걸 막기 위함. 가사 코러스 처리와 달리, 제목에서는 모르는 괄호를 함부로
/// 만지지 않는 게 더 안전하다(아티스트명 훼손 리스크 > 부가설명 못 지우는 리스크).
fn strip_title_descriptors(text: &str) -> String {
    let re = Regex::new(r"[\[({<【〈]([^\[\](){}<>【】〈〉]*)[\])}>】〉]").unwrap();
    let cleaned = re.replace_all(text, |caps: &regex::Captures| {
        let inner = &caps[1];
        if is_title_descriptor(inner) {
            String::new()
        } else {
            caps[0].to_string()
        }
    });
    collapse_spaces(&cleaned)
}

fn collapse_spaces(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ").trim().to_string()
}

/// 좌우 공백이 있는 "-"/en dash/em dash/세로줄만 구분자로 인정한다(공백 없이
/// 붙은 하이픈은 "T-ara"/"K-pop"처럼 단어 일부일 수 있어 제외).
fn split_artist_title(text: &str) -> Option<(String, String)> {
    let seps = [" - ", " – ", " — ", " | ", " ｜ "];
    for sep in seps {
        if let Some(idx) = text.find(sep) {
            let left = text[..idx].trim().to_string();
            let right = text[idx + sep.len()..].trim().to_string();
            if !left.is_empty() && !right.is_empty() {
                return Some((left, right));
            }
        }
    }
    None
}

/// 문자열 전체가 단일 괄호 쌍으로 감싸져 있으면 안쪽만 돌려준다.
/// ("(방탄소년단)" → "방탄소년단", "(여자)아이들"은 괄호 뒤에 글자가 더 있어 그대로 유지)
fn unwrap_if_fully_bracketed(s: &str) -> String {
    let pairs = [('(', ')'), ('[', ']'), ('〈', '〉'), ('【', '】')];
    for (open, close) in pairs {
        let chars: Vec<char> = s.chars().collect();
        if chars.first() == Some(&open) && chars.last() == Some(&close) {
            let inner: String = chars[1..chars.len() - 1].iter().collect();
            // 안쪽에 짝이 안 맞는 괄호가 없어야 진짜 "전체를 감싼" 경우다.
            if !inner.contains(open) && !inner.contains(close) {
                return inner.trim().to_string();
            }
        }
    }
    s.to_string()
}

/// YouTube "Topic" 채널(자동 생성) 접미사를 제거한다. 이 채널명은 거의 항상
/// 아티스트 본명 그대로라 가장 신뢰도 높은 신호다.
fn strip_topic_suffix(uploader: &str) -> Option<String> {
    let trimmed = uploader.trim();
    trimmed.strip_suffix(" - Topic").map(|s| s.trim().to_string())
}

pub struct ParsedTitle {
    pub title: String,
    pub artist: Option<String>,
}

/// 영상 제목(+업로더)에서 곡 제목·아티스트를 추정한다.
///
/// 우선순위:
/// 1. 제목이 "아티스트 - 제목" 패턴이면 분리(좌측이 괄호로 완전히 감싸져
///    있으면 벗겨서 아티스트로 — `(가수) - 곡제목`).
/// 2. 패턴이 없으면 제목은 부가설명만 벗기고 그대로, 아티스트는 업로더의
///    " - Topic" 접미사를 벗긴 값(있으면) 또는 업로더 그대로.
pub fn parse_youtube_title(raw_title: &str, uploader: Option<&str>) -> ParsedTitle {
    let prelim = strip_title_descriptors(raw_title);

    if let Some((left, right)) = split_artist_title(&prelim) {
        let artist = unwrap_if_fully_bracketed(&left);
        let title = strip_title_descriptors(&right);
        if !title.is_empty() && !artist.is_empty() {
            return ParsedTitle { title, artist: Some(artist) };
        }
    }

    let artist = uploader.and_then(|u| strip_topic_suffix(u).or_else(|| {
        let t = u.trim();
        if t.is_empty() { None } else { Some(t.to_string()) }
    }));

    ParsedTitle { title: prelim, artist }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_artist_dash_title() {
        let p = parse_youtube_title("IU - Through the Night", Some("1theK"));
        assert_eq!(p.title, "Through the Night");
        assert_eq!(p.artist.as_deref(), Some("IU"));
    }

    #[test]
    fn unwraps_parenthesized_artist() {
        let p = parse_youtube_title("(방탄소년단) - 봄날", Some("Ibighit"));
        assert_eq!(p.title, "봄날");
        assert_eq!(p.artist.as_deref(), Some("방탄소년단"));
    }

    #[test]
    fn strips_trailing_descriptor_from_title() {
        let p = parse_youtube_title("NewJeans - Ditto (Official MV)", Some("HYBE LABELS"));
        assert_eq!(p.title, "Ditto");
        assert_eq!(p.artist.as_deref(), Some("NewJeans"));
    }

    #[test]
    fn strips_leading_bracket_prefix() {
        let p = parse_youtube_title("[MV] aespa - Spicy", Some("SMTOWN"));
        assert_eq!(p.title, "Spicy");
        assert_eq!(p.artist.as_deref(), Some("aespa"));
    }

    #[test]
    fn keeps_group_name_with_internal_parens() {
        // "(여자)아이들"은 괄호 뒤에 글자가 더 있어 "전체 감싸기"가 아니므로
        // is_title_descriptor 화이트리스트에도 없어 그대로 보존돼야 한다.
        let p = parse_youtube_title("(여자)아이들 - 퀸카", Some("cube entertainment"));
        assert_eq!(p.artist.as_deref(), Some("(여자)아이들"));
        assert_eq!(p.title, "퀸카");
    }

    #[test]
    fn falls_back_to_uploader_when_no_dash_pattern() {
        let p = parse_youtube_title("오늘도 좋은 하루", Some("어떤채널"));
        assert_eq!(p.title, "오늘도 좋은 하루");
        assert_eq!(p.artist.as_deref(), Some("어떤채널"));
    }

    #[test]
    fn strips_topic_channel_suffix() {
        let p = parse_youtube_title("Through the Night", Some("IU - Topic"));
        assert_eq!(p.artist.as_deref(), Some("IU"));
    }

    #[test]
    fn does_not_split_hyphenated_word_without_spaces() {
        // "T-ara"처럼 공백 없는 하이픈은 구분자로 취급하지 않는다.
        let p = parse_youtube_title("T-ara Comeback Stage", Some("Mnet K-POP"));
        assert_eq!(p.title, "T-ara Comeback Stage");
        assert_eq!(p.artist.as_deref(), Some("Mnet K-POP"));
    }

    #[test]
    fn handles_missing_uploader() {
        let p = parse_youtube_title("어떤 제목", None);
        assert_eq!(p.title, "어떤 제목");
        assert_eq!(p.artist, None);
    }

    #[test]
    fn strips_multiple_descriptor_brackets() {
        let p = parse_youtube_title("BLACKPINK - Pink Venom (Official MV) (4K)", Some("BLACKPINK"));
        assert_eq!(p.title, "Pink Venom");
        assert_eq!(p.artist.as_deref(), Some("BLACKPINK"));
    }
}
