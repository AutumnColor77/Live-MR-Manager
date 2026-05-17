//! Library import/export for Excel workflows (CSV with UTF-8 BOM + XLSX read).

use calamine::{open_workbook_auto, Data, Reader};
use csv::{ReaderBuilder, WriterBuilder};
use serde::Serialize;
use std::collections::HashMap;
use std::path::Path;

use crate::library::{get_songs_internal, save_library_internal};
use crate::state::AppPaths;
use crate::types::SongMetadata;

const EXPORT_HEADERS: &[&str] = &[
    "path",
    "title",
    "artist",
    "genre",
    "category",
    "tags",
    "duration",
    "pitch",
    "tempo",
    "volume",
    "source",
];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpreadsheetImportResult {
    pub added: usize,
    pub updated: usize,
    pub skipped: usize,
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
        "태그" => "tags".into(),
        "재생시간" | "길이" | "시간" => "duration".into(),
        "피치" => "pitch".into(),
        "템포" | "속도" => "tempo".into(),
        "볼륨" | "음량" => "volume".into(),
        "출처" | "소스" => "source".into(),
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
    for (row_idx, row) in rows_iter.enumerate() {
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
        original_title: None,
        translated_title: None,
        curation_category: None,
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
            "발라드",
            "애창곡",
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
        wtr.write_record([
            &song.path,
            &song.title,
            song.artist.as_deref().unwrap_or(""),
            song.genre.as_deref().unwrap_or(""),
            &category,
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
            result.updated += 1;
            continue;
        }

        match song_from_row(&row) {
            Ok(new_song) => {
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
        let csv = "\u{feff}경로,제목,아티스트,장르,카테고리\nhttps://youtu.be/abc,테스트,가수,발라드,애창곡\n";
        let rows = parse_delimited_text(csv).unwrap();
        assert_eq!(rows[0].get("path").unwrap(), "https://youtu.be/abc");
        assert_eq!(rows[0].get("title").unwrap(), "테스트");
    }
}
