//! Library import/export for Excel workflows (CSV with UTF-8 BOM + XLSX read).

use calamine::{open_workbook_auto, Data, Reader};
use csv::{ReaderBuilder, WriterBuilder};
use serde::Serialize;
use std::collections::HashMap;
use std::path::Path;

use crate::library::{get_songs_internal, parse_id_list, save_library_internal};
use crate::state::{AppPaths, DB};
use crate::types::SongMetadata;
use rusqlite::params;

/// 보내기 헤더는 한글. 가져오기 시 normalize_header가 내부 키로 변환합니다.
const EXPORT_HEADERS: &[&str] = &[
    "경로",
    "제목",
    "아티스트",
    "원곡",
    "키",
    "BPM",
    "난이도",
    "숙련도",
    "노래방",
    "커버",
    "가사링크",
    "멜로밍곡ID",
    "멜로밍아티스트ID",
    "카테고리",
    "카테고리ID",
    "장르",
    "태그",
    "재생시간",
    "피치",
    "템포",
    "볼륨",
    "출처",
];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpreadsheetImportResult {
    pub added: usize,
    pub updated: usize,
    pub skipped: usize,
    /// 유튜브 URL에서 썸네일·재생시간 등을 자동 보강한 행 수
    pub enriched: usize,
    pub errors: Vec<String>,
}

fn normalize_header(h: &str) -> String {
    let s = h.trim().trim_start_matches('\u{feff}').to_lowercase();
    match s.as_str() {
        "경로" | "url" | "링크" | "주소" => "path".into(),
        "제목" | "곡명" => "title".into(),
        "아티스트" | "가수" => "artist".into(),
        "장르" => "genre".into(),
        "카테고리" | "categories" | "분류" => "category".into(),
        "카테고리id" | "카테고리ids" | "categoryids" => "meloming_category_ids".into(),
        "태그" => "tags".into(),
        "재생시간" | "길이" | "시간" => "duration".into(),
        "피치" => "pitch".into(),
        "템포" | "속도" => "tempo".into(),
        "볼륨" | "음량" => "volume".into(),
        "출처" | "소스" => "source".into(),
        "원곡" | "원곡url" | "원곡링크" | "originalurl" => "original_url".into(),
        "키" | "key" => "song_key".into(),
        "난이도" => "difficulty".into(),
        "숙련도" => "proficiency".into(),
        "노래방" | "노래방url" => "karaoke_url".into(),
        "커버" | "커버url" => "cover_url".into(),
        "가사링크" | "가사" => "lyrics_link".into(),
        "멜로밍곡id" | "멜로밍id" => "meloming_song_id".into(),
        "멜로밍아티스트id" => "meloming_artist_id".into(),
        // 이전 영문 헤더 호환
        "path" => "path".into(),
        "title" => "title".into(),
        "artist" => "artist".into(),
        "original_url" => "original_url".into(),
        "song_key" => "song_key".into(),
        "bpm" => "bpm".into(),
        "difficulty" => "difficulty".into(),
        "proficiency" => "proficiency".into(),
        "karaoke_url" => "karaoke_url".into(),
        "cover_url" => "cover_url".into(),
        "lyrics_link" => "lyrics_link".into(),
        "meloming_song_id" => "meloming_song_id".into(),
        "meloming_artist_id" => "meloming_artist_id".into(),
        "category" => "category".into(),
        "meloming_category_ids" | "category_ids" => "meloming_category_ids".into(),
        "genre" => "genre".into(),
        "tags" => "tags".into(),
        "duration" => "duration".into(),
        "pitch" => "pitch".into(),
        "tempo" => "tempo".into(),
        "volume" => "volume".into(),
        "source" => "source".into(),
        other => other.to_string(),
    }
}

fn cell_to_string(cell: &Data) -> String {
    match cell {
        Data::Empty => String::new(),
        Data::String(s) => s.trim().to_string(),
        Data::Float(f) => {
            if f.fract() == 0.0 {
                format!("{}", *f as i64)
            } else {
                f.to_string()
            }
        }
        Data::Int(i) => i.to_string(),
        Data::Bool(b) => b.to_string(),
        Data::DateTime(f) => f.to_string(),
        Data::DateTimeIso(s) => s.clone(),
        Data::DurationIso(s) => s.clone(),
        Data::Error(_) => String::new(),
    }
}

fn parse_delimited_text(text: &str) -> Result<Vec<HashMap<String, String>>, String> {
    let mut reader = ReaderBuilder::new()
        .flexible(true)
        .trim(csv::Trim::All)
        .from_reader(text.as_bytes());

    let headers: Vec<String> = reader
        .headers()
        .map_err(|e| e.to_string())?
        .iter()
        .map(normalize_header)
        .collect();

    if headers.is_empty() || !headers.iter().any(|h| h == "path") {
        return Err("첫 행에 'path'(경로) 열이 필요합니다.".into());
    }

    let mut rows = Vec::new();
    for (idx, record) in reader.records().enumerate() {
        let record = record.map_err(|e| format!("{}행: {}", idx + 2, e))?;
        let mut map = HashMap::new();
        for (i, field) in record.iter().enumerate() {
            if let Some(key) = headers.get(i) {
                if !key.is_empty() {
                    map.insert(key.clone(), field.trim().to_string());
                }
            }
        }
        if map.values().all(|v| v.is_empty()) {
            continue;
        }
        rows.push(map);
    }
    Ok(rows)
}

fn parse_xlsx(path: &Path) -> Result<Vec<HashMap<String, String>>, String> {
    let mut workbook = open_workbook_auto(path).map_err(|e| format!("엑셀 파일을 열 수 없습니다: {}", e))?;
    let sheet_name = workbook
        .sheet_names()
        .first()
        .cloned()
        .ok_or_else(|| "시트가 비어 있습니다.".to_string())?;
    let range = workbook
        .worksheet_range(&sheet_name)
        .map_err(|e| e.to_string())?;

    let mut rows_iter = range.rows();
    let header_row = rows_iter
        .next()
        .ok_or_else(|| "헤더 행이 없습니다.".to_string())?;
    let headers: Vec<String> = header_row
        .iter()
        .map(|c| normalize_header(&cell_to_string(c)))
        .collect();

    if !headers.iter().any(|h| h == "path") {
        return Err("첫 행에 'path'(경로) 열이 필요합니다.".into());
    }

    let mut rows = Vec::new();
    for (_row_idx, row) in rows_iter.enumerate() {
        let mut map = HashMap::new();
        for (i, cell) in row.iter().enumerate() {
            if let Some(key) = headers.get(i) {
                if !key.is_empty() {
                    map.insert(key.clone(), cell_to_string(cell));
                }
            }
        }
        if map.values().all(|v| v.is_empty()) {
            continue;
        }
        rows.push(map);
    }
    if rows.is_empty() {
        return Err("데이터 행이 없습니다. 2행부터 곡 정보를 입력해 주세요.".into());
    }
    Ok(rows)
}

pub fn parse_spreadsheet_file(path: &Path) -> Result<Vec<HashMap<String, String>>, String> {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    match ext.as_str() {
        "xlsx" | "xls" | "xlsm" => parse_xlsx(path),
        "csv" | "txt" => {
            let raw = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
            parse_delimited_text(&raw)
        }
        _ => {
            // Try CSV first, then Excel
            if let Ok(rows) = std::fs::read_to_string(path).and_then(|t| {
                parse_delimited_text(&t).map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))
            }) {
                Ok(rows)
            } else {
                parse_xlsx(path)
            }
        }
    }
}

fn is_http_url(value: &str) -> bool {
    let p = value.trim().to_lowercase();
    p.starts_with("http://") || p.starts_with("https://")
}

/// 보내기: original_url 없으면 경로가 URL일 때 경로와 동일하게 채움
fn export_original_url(song: &SongMetadata) -> String {
    if let Some(url) = song.original_url.as_deref().filter(|s| !s.is_empty()) {
        return url.to_string();
    }
    if is_http_url(&song.path) {
        return song.path.trim().to_string();
    }
    String::new()
}

/// 가져오기: 원곡 열이 비어 있고 경로가 URL이면 원곡도 채움
fn fill_original_url_from_path(song: &mut SongMetadata) {
    if song.original_url.as_ref().is_some_and(|s| !s.is_empty()) {
        return;
    }
    if is_http_url(&song.path) {
        song.original_url = Some(song.path.trim().to_string());
    }
}

fn infer_source(path: &str) -> String {
    let p = path.trim().to_lowercase();
    if p.starts_with("http://") || p.starts_with("https://") {
        "youtube".into()
    } else {
        "local".into()
    }
}

fn split_list(value: &str) -> Option<Vec<String>> {
    let items: Vec<String> = value
        .split([',', ';', '|'])
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();
    if items.is_empty() {
        None
    } else {
        Some(items)
    }
}

fn parse_f32(value: &str) -> Option<f32> {
    if value.trim().is_empty() {
        return None;
    }
    value.trim().parse().ok()
}

fn parse_i32(value: &str) -> Option<i32> {
    if value.trim().is_empty() {
        return None;
    }
    value.trim().parse().ok()
}

fn parse_i64(value: &str) -> Option<i64> {
    if value.trim().is_empty() {
        return None;
    }
    value.trim().parse().ok()
}

fn parse_u8_1_5(value: &str) -> Option<u8> {
    parse_i32(value).and_then(|n| (1..=5).contains(&n).then_some(n as u8))
}

fn get_settings_meloming_channel_id() -> Option<i64> {
    let db = DB.lock();
    db.query_row(
        "SELECT value FROM Settings WHERE key = 'meloming_channel_id'",
        [],
        |row| row.get::<_, String>(0),
    )
    .ok()
    .and_then(|v| v.trim().parse().ok())
}

fn export_category_ids(song: &SongMetadata) -> String {
    if let Some(ids) = &song.meloming_category_ids {
        if !ids.is_empty() {
            return ids
                .iter()
                .map(|id| id.to_string())
                .collect::<Vec<_>>()
                .join(",");
        }
    }

    let channel_id = match song.meloming_channel_id.or_else(get_settings_meloming_channel_id) {
        Some(id) => id,
        None => return String::new(),
    };
    let names: Vec<String> = song
        .categories
        .as_ref()
        .cloned()
        .or_else(|| {
            song.curation_category
                .as_ref()
                .map(|name| vec![name.clone()])
        })
        .unwrap_or_default();
    if names.is_empty() {
        return String::new();
    }

    let db = DB.lock();
    let mut ids = Vec::new();
    for name in names {
        if let Ok(id) = db.query_row(
            "SELECT meloming_category_id FROM Meloming_Category_Map WHERE channel_id = ? AND local_name = ?",
            params![channel_id, name.trim()],
            |row| row.get::<_, i64>(0),
        ) {
            ids.push(id);
        }
    }
    ids.iter()
        .map(|id| id.to_string())
        .collect::<Vec<_>>()
        .join(",")
}

fn apply_row_to_song(song: &mut SongMetadata, row: &HashMap<String, String>) {
    if let Some(v) = row.get("title").filter(|s| !s.is_empty()) {
        song.title = v.clone();
    }
    if let Some(v) = row.get("artist").filter(|s| !s.is_empty()) {
        song.artist = Some(v.clone());
    }
    if let Some(v) = row.get("genre").filter(|s| !s.is_empty()) {
        song.genre = Some(v.clone());
    }
    if let Some(v) = row.get("category").filter(|s| !s.is_empty()) {
        let cats = split_list(v).unwrap_or_else(|| vec![v.clone()]);
        song.categories = Some(cats.clone());
        song.curation_category = cats.first().cloned();
    }
    if let Some(v) = row.get("tags").filter(|s| !s.is_empty()) {
        song.tags = split_list(v);
    }
    if let Some(v) = row.get("duration").filter(|s| !s.is_empty()) {
        song.duration = v.clone();
    }
    if let Some(v) = parse_f32(row.get("pitch").map(|s| s.as_str()).unwrap_or("")) {
        song.pitch = Some(v);
    }
    if let Some(v) = parse_f32(row.get("tempo").map(|s| s.as_str()).unwrap_or("")) {
        song.tempo = Some(v);
    }
    if let Some(v) = parse_f32(row.get("volume").map(|s| s.as_str()).unwrap_or("")) {
        song.volume = Some(v);
    }
    if let Some(v) = row.get("source").filter(|s| !s.is_empty()) {
        song.source = v.clone();
    }
    if let Some(v) = row.get("original_url").filter(|s| !s.is_empty()) {
        song.original_url = Some(v.clone());
    }
    if let Some(v) = row.get("song_key").filter(|s| !s.is_empty()) {
        song.song_key = Some(v.clone());
    }
    if let Some(v) = parse_i32(row.get("bpm").map(|s| s.as_str()).unwrap_or("")) {
        song.bpm = Some(v);
    }
    if let Some(v) = parse_u8_1_5(row.get("difficulty").map(|s| s.as_str()).unwrap_or("")) {
        song.difficulty = Some(v);
    }
    if let Some(v) = parse_u8_1_5(row.get("proficiency").map(|s| s.as_str()).unwrap_or("")) {
        song.proficiency = Some(v);
    }
    if let Some(v) = row.get("karaoke_url").filter(|s| !s.is_empty()) {
        song.karaoke_url = Some(v.clone());
    }
    if let Some(v) = row.get("cover_url").filter(|s| !s.is_empty()) {
        song.cover_url = Some(v.clone());
    }
    if let Some(v) = row.get("lyrics_link").filter(|s| !s.is_empty()) {
        song.lyrics_link = Some(v.clone());
    }
    if let Some(v) = parse_i64(row.get("meloming_song_id").map(|s| s.as_str()).unwrap_or("")) {
        song.meloming_song_id = Some(v);
    }
    if let Some(v) = parse_i64(row.get("meloming_artist_id").map(|s| s.as_str()).unwrap_or("")) {
        song.meloming_artist_id = Some(v);
    }
    if let Some(v) = row.get("meloming_category_ids").filter(|s| !s.is_empty()) {
        song.meloming_category_ids = parse_id_list(Some(v.clone()));
    }
    fill_original_url_from_path(song);
}

fn row_has_value(row: &HashMap<String, String>, key: &str) -> bool {
    row.get(key).is_some_and(|s| !s.trim().is_empty())
}

fn song_needs_youtube_enrich(song: &SongMetadata) -> bool {
    song.thumbnail.trim().is_empty()
        || song.duration.trim().is_empty()
        || song.duration.trim() == "0:00"
}

/// CSV에 경로·제목·아티스트만 있어도, 유튜브 URL이면 UI 「정보 가져오기」와 같이 메타데이터를 보강합니다.
/// CSV에 명시된 제목·아티스트·재생시간 등은 덮어쓰지 않습니다.
async fn enrich_youtube_from_row(
    song: &mut SongMetadata,
    row: &HashMap<String, String>,
) -> Result<bool, String> {
    if !is_http_url(&song.path) {
        return Ok(false);
    }
    if !song_needs_youtube_enrich(song) {
        fill_original_url_from_path(song);
        return Ok(false);
    }

    let path = song.path.trim().to_string();
    let meta = crate::model_commands::youtube_metadata_fetcher(path).await?;

    if !row_has_value(row, "title") && !meta.title.is_empty() {
        song.title = meta.title;
    }
    if !row_has_value(row, "artist") {
        song.artist = meta.artist;
    }
    if song.thumbnail.trim().is_empty() && !meta.thumbnail.trim().is_empty() {
        song.thumbnail = meta.thumbnail;
    }
    if (song.duration.trim().is_empty() || song.duration.trim() == "0:00")
        && !meta.duration.trim().is_empty()
    {
        song.duration = meta.duration;
    }
    if !row_has_value(row, "source") {
        song.source = "youtube".into();
    }
    fill_original_url_from_path(song);
    Ok(true)
}

fn song_from_row(row: &HashMap<String, String>) -> Result<SongMetadata, String> {
    let path = row
        .get("path")
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "path(경로) 값이 비어 있습니다.".to_string())?;

    let title = row
        .get("title")
        .filter(|s| !s.is_empty())
        .cloned()
        .unwrap_or_else(|| path.clone());

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();

    let mut song = SongMetadata {
        id: None,
        title,
        thumbnail: String::new(),
        duration: row.get("duration").cloned().unwrap_or_else(|| "0:00".into()),
        source: row
            .get("source")
            .filter(|s| !s.is_empty())
            .cloned()
            .unwrap_or_else(|| infer_source(&path)),
        path,
        pitch: parse_f32(row.get("pitch").map(|s| s.as_str()).unwrap_or("")).or(Some(0.0)),
        tempo: parse_f32(row.get("tempo").map(|s| s.as_str()).unwrap_or("")).or(Some(1.0)),
        volume: parse_f32(row.get("volume").map(|s| s.as_str()).unwrap_or("")).or(Some(100.0)),
        artist: row.get("artist").filter(|s| !s.is_empty()).cloned(),
        tags: row.get("tags").and_then(|s| split_list(s)),
        genre: row.get("genre").filter(|s| !s.is_empty()).cloned(),
        categories: None,
        play_count: Some(0),
        date_added: Some(now),
        is_mr: Some(false),
        is_separated: Some(false),
        has_lyrics: Some(false),
        lyric_sync_status: None,
        original_title: None,
        translated_title: None,
        curation_category: None,
        ..Default::default()
    };

    apply_row_to_song(&mut song, row);
    Ok(song)
}

fn songs_to_csv(songs: &[SongMetadata], include_example: bool) -> Result<Vec<u8>, String> {
    let mut wtr = WriterBuilder::new()
        .delimiter(b',')
        .from_writer(vec![]);

    wtr.write_record(EXPORT_HEADERS).map_err(|e| e.to_string())?;

    if include_example {
        wtr.write_record([
            "https://youtu.be/VIDEO_ID",
            "곡 제목",
            "아티스트",
            "https://youtu.be/VIDEO_ID",
            "Am",
            "120",
            "3",
            "4",
            "",
            "",
            "",
            "",
            "",
            "애창곡",
            "12",
            "발라드",
            "태그1,태그2",
            "3:45",
            "0",
            "1.0",
            "100",
            "youtube",
        ])
        .map_err(|e| e.to_string())?;
    }

    for song in songs {
        let category = song
            .categories
            .as_ref()
            .and_then(|c| c.first())
            .cloned()
            .or_else(|| song.curation_category.clone())
            .unwrap_or_default();
        let tags = song
            .tags
            .as_ref()
            .map(|t| t.join(","))
            .unwrap_or_default();
        let original_url = export_original_url(song);
        wtr.write_record([
            &song.path,
            &song.title,
            song.artist.as_deref().unwrap_or(""),
            &original_url,
            song.song_key.as_deref().unwrap_or(""),
            &song.bpm.map(|v| v.to_string()).unwrap_or_default(),
            &song
                .difficulty
                .map(|v| v.to_string())
                .unwrap_or_default(),
            &song
                .proficiency
                .map(|v| v.to_string())
                .unwrap_or_default(),
            song.karaoke_url.as_deref().unwrap_or(""),
            song.cover_url.as_deref().unwrap_or(""),
            song.lyrics_link.as_deref().unwrap_or(""),
            &song
                .meloming_song_id
                .map(|v| v.to_string())
                .unwrap_or_default(),
            &song
                .meloming_artist_id
                .map(|v| v.to_string())
                .unwrap_or_default(),
            &category,
            &export_category_ids(song),
            song.genre.as_deref().unwrap_or(""),
            &tags,
            &song.duration,
            &song.pitch.map(|p| p.to_string()).unwrap_or_else(|| "0".into()),
            &song.tempo.map(|t| t.to_string()).unwrap_or_else(|| "1".into()),
            &song.volume.map(|v| v.to_string()).unwrap_or_else(|| "100".into()),
            &song.source,
        ])
        .map_err(|e| e.to_string())?;
    }

    let data = wtr.into_inner().map_err(|e| e.to_string())?;
    let mut out = Vec::with_capacity(3 + data.len());
    out.extend_from_slice("\u{feff}".as_bytes());
    out.extend(data);
    Ok(out)
}

pub async fn merge_rows_into_library(
    paths: &AppPaths,
    rows: Vec<HashMap<String, String>>,
) -> Result<SpreadsheetImportResult, String> {
    let mut songs = get_songs_internal(paths.clone()).await?;
    let mut result = SpreadsheetImportResult {
        added: 0,
        updated: 0,
        skipped: 0,
        enriched: 0,
        errors: Vec::new(),
    };

    for (i, row) in rows.into_iter().enumerate() {
        let line = i + 2;
        let path_key = row.get("path").map(|s| s.trim().to_string()).unwrap_or_default();
        if path_key.is_empty() {
            result.skipped += 1;
            result.errors.push(format!("{}행: path(경로)가 비어 있어 건너뜀", line));
            continue;
        }

        if let Some(existing) = songs.iter_mut().find(|s| s.path == path_key) {
            apply_row_to_song(existing, &row);
            match enrich_youtube_from_row(existing, &row).await {
                Ok(true) => result.enriched += 1,
                Ok(false) => {}
                Err(e) => result.errors.push(format!(
                    "{}행: 유튜브 정보를 가져오지 못했습니다 (기본 정보만 반영): {}",
                    line, e
                )),
            }
            result.updated += 1;
            continue;
        }

        match song_from_row(&row) {
            Ok(mut new_song) => {
                match enrich_youtube_from_row(&mut new_song, &row).await {
                    Ok(true) => result.enriched += 1,
                    Ok(false) => {}
                    Err(e) => result.errors.push(format!(
                        "{}행: 유튜브 정보를 가져오지 못했습니다 (기본 정보만 반영): {}",
                        line, e
                    )),
                }
                songs.push(new_song);
                result.added += 1;
            }
            Err(e) => {
                result.skipped += 1;
                result.errors.push(format!("{}행: {}", line, e));
            }
        }
    }

    save_library_internal(songs).await?;
    Ok(result)
}

pub async fn export_library_csv(paths: &AppPaths, include_example: bool) -> Result<Vec<u8>, String> {
    let songs = if include_example {
        Vec::new()
    } else {
        get_songs_internal(paths.clone()).await?
    };
    songs_to_csv(&songs, include_example)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_korean_headers() {
        let csv = "\u{feff}경로,제목,아티스트,장르,카테고리,카테고리ID\nhttps://youtu.be/abc,테스트,가수,발라드,애창곡,12\n";
        let rows = parse_delimited_text(csv).unwrap();
        assert_eq!(rows[0].get("path").unwrap(), "https://youtu.be/abc");
        assert_eq!(rows[0].get("title").unwrap(), "테스트");
        assert_eq!(rows[0].get("meloming_category_ids").unwrap(), "12");
    }
}
