use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Status {
    Pending,
    Downloading,
    Decoding,
    Separating,
    Playing,
    Paused,
    Error,
    Finished,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaybackStatus {
    pub status: Status,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaybackProgress {
    pub position_ms: u64,
    pub duration_ms: u64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AppState {
    pub current_track: Option<String>,
    pub pitch: f32,
    pub tempo: f32,
    pub volume: f32,
    pub vocal_balance: f32,
    pub vocal_enabled: bool,
    pub lyric_enabled: bool,
    pub is_playing: bool,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            current_track: None,
            pitch: 0.0,
            tempo: 1.0,
            volume: 80.0,
            vocal_balance: 50.0,
            vocal_enabled: true,
            lyric_enabled: false,
            is_playing: false,
        }
    }
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Genre {
    pub id: i64,
    pub name: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Category {
    pub id: i64,
    pub name: String,
}

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct SongMetadata {
    pub id: Option<i64>,
    pub title: String,
    pub thumbnail: String,
    pub duration: String,
    pub source: String,
    pub path: String,
    pub pitch: Option<f32>,
    pub tempo: Option<f32>,
    pub volume: Option<f32>,
    pub artist: Option<String>,
    pub tags: Option<Vec<String>>,
    pub genre: Option<String>,
    pub categories: Option<Vec<String>>,
    pub play_count: Option<u32>,
    pub date_added: Option<u64>,
    pub is_mr: Option<bool>,
    pub is_separated: Option<bool>,
    pub has_lyrics: Option<bool>,
    /// 가사 싱크 상태: "synced"(타임스탬프 있음) / "unsynced"(가사만) / "none"(가사 없음).
    /// `get_songs_internal`에서만 채워지고, 다른 생성 경로는 None.
    #[serde(default)]
    pub lyric_sync_status: Option<String>,
    pub original_title: Option<String>,
    pub translated_title: Option<String>,
    pub curation_category: Option<String>,
    #[serde(default, alias = "key")]
    pub song_key: Option<String>,
    pub bpm: Option<i32>,
    pub difficulty: Option<u8>,
    pub proficiency: Option<u8>,
    pub karaoke_url: Option<String>,
    pub cover_url: Option<String>,
    pub original_url: Option<String>,
    pub lyrics_link: Option<String>,
    pub meloming_song_id: Option<i64>,
    pub meloming_channel_id: Option<i64>,
    pub meloming_artist_id: Option<i64>,
    /// 멜로밍 API `categoryIds` (1–N개)
    pub meloming_category_ids: Option<Vec<i64>>,
    pub sync_status: Option<String>,
}
