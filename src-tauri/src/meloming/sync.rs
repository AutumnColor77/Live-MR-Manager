//! Pull meloming songbook into local library (Phase 1).

use crate::library::{load_all_songs_from_db, save_library_internal};
use crate::meloming::client::{ArtistResponse, CategoryResponse, MelomingClient, MelomingError, SongResponse};
use crate::state::DB;
use crate::types::SongMetadata;
use std::collections::HashMap;
use rusqlite::params;
use serde::Serialize;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PullResult {
    pub fetched: usize,
    pub created: usize,
    pub updated: usize,
    pub artists_mapped: usize,
}

pub(crate) use crate::youtube_url::normalize_youtube_watch;

fn pull_path(song: &SongResponse) -> String {
    if let Some(url) = song.original_url.as_deref().and_then(normalize_youtube_watch) {
        return url;
    }
    format!("meloming:song:{}", song.id)
}

fn to_u8(v: Option<i32>) -> Option<u8> {
    v.and_then(|n| (1..=5).contains(&n).then_some(n as u8))
}

fn song_to_metadata(song: &SongResponse, channel_id: i64, artist_name: Option<String>) -> SongMetadata {
    SongMetadata {
        title: song.title.clone(),
        thumbnail: song.album_art.clone().unwrap_or_default(),
        source: "meloming".into(),
        path: pull_path(song),
        artist: artist_name,
        song_key: song.song_key.clone(),
        bpm: song.bpm,
        difficulty: to_u8(song.difficulty),
        proficiency: to_u8(song.proficiency),
        karaoke_url: song.karaoke_url.clone(),
        cover_url: song.cover_url.clone(),
        original_url: song.original_url.clone(),
        lyrics_link: song.lyrics_link.clone(),
        meloming_song_id: Some(song.id),
        meloming_channel_id: Some(channel_id),
        meloming_artist_id: song.artist_id,
        meloming_category_ids: song.category_ids.clone(),
        sync_status: Some("synced".into()),
        ..Default::default()
    }
}

pub(crate) fn upsert_category_maps(channel_id: i64, categories: &[CategoryResponse]) -> Result<usize, MelomingError> {
    let db = DB.lock();
    let mut count = 0usize;
    for c in categories {
        db.execute(
            "INSERT OR REPLACE INTO Meloming_Category_Map (local_name, meloming_category_id, channel_id) VALUES (?, ?, ?)",
            params![c.name, c.id, channel_id],
        )
        .map_err(|e| MelomingError::Message(e.to_string()))?;
        count += 1;
    }
    Ok(count)
}

fn apply_meloming_categories(
    meta: &mut SongMetadata,
    song: &SongResponse,
    cat_name_by_id: &std::collections::HashMap<i64, String>,
    keep_user_categories: bool,
) {
    if let Some(ids) = &song.category_ids {
        if !ids.is_empty() {
            meta.meloming_category_ids = Some(ids.clone());
        }
    }

    if keep_user_categories {
        return;
    }

    if let Some(ids) = &song.category_ids {
        if !ids.is_empty() {
            let names: Vec<String> = ids
                .iter()
                .filter_map(|id| cat_name_by_id.get(id).cloned())
                .collect();
            if !names.is_empty() {
                meta.categories = Some(names.clone());
                meta.curation_category = names.first().cloned();
            }
        }
    }
}

/// 멜로밍 Pull 시 기존 로컬 메타데이터(MR, 재생 설정, 태그 등)를 유지합니다.
fn merge_pull_update(existing: SongMetadata, mut remote: SongMetadata) -> SongMetadata {
    remote.path = existing.path;
    remote.id = existing.id;

    remote.pitch = existing.pitch;
    remote.tempo = existing.tempo;
    remote.volume = existing.volume;
    remote.play_count = existing.play_count;
    remote.date_added = existing.date_added;
    remote.duration = existing.duration;
    remote.is_mr = existing.is_mr;
    remote.is_separated = existing.is_separated;
    remote.has_lyrics = existing.has_lyrics;

    remote.genre = existing.genre;
    remote.tags = existing.tags;

    let has_user_categories = existing
        .categories
        .as_ref()
        .is_some_and(|cats| cats.iter().any(|c| !c.trim().is_empty()));
    if has_user_categories {
        remote.categories = existing.categories;
        remote.curation_category = existing.curation_category;
    }

    remote.original_title = existing.original_title;
    remote.translated_title = existing.translated_title;

    if !existing.source.is_empty() && existing.source != "meloming" {
        remote.source = existing.source;
    }

    if remote.thumbnail.trim().is_empty() {
        remote.thumbnail = existing.thumbnail;
    }

    if existing.artist.as_ref().is_some_and(|a| !a.trim().is_empty()) {
        remote.artist = existing.artist;
    }

    remote.song_key = remote.song_key.or(existing.song_key);
    remote.bpm = remote.bpm.or(existing.bpm);
    remote.difficulty = remote.difficulty.or(existing.difficulty);
    remote.proficiency = remote.proficiency.or(existing.proficiency);
    remote.karaoke_url = remote.karaoke_url.or(existing.karaoke_url);
    remote.cover_url = remote.cover_url.or(existing.cover_url);
    remote.original_url = remote.original_url.or(existing.original_url);
    // Local edits always win: a manually-set link should never be silently
    // overwritten by a Pull; remote only fills in when local is empty.
    remote.lyrics_link = existing.lyrics_link.or(remote.lyrics_link);

    remote
}

fn find_existing_match<'a>(
    by_path: &'a HashMap<String, SongMetadata>,
    song: &SongResponse,
) -> Option<&'a SongMetadata> {
    for existing in by_path.values() {
        if existing.meloming_song_id == Some(song.id) {
            return Some(existing);
        }
    }
    if let Some(url) = song.original_url.as_deref().and_then(normalize_youtube_watch) {
        if let Some(existing) = by_path.get(&url) {
            return Some(existing);
        }
    }
    for existing in by_path.values() {
        if existing.title == song.title {
            return Some(existing);
        }
    }
    None
}

pub(crate) fn upsert_artist_map_entry(
    channel_id: i64,
    local_name: &str,
    meloming_artist_id: i64,
) -> Result<(), MelomingError> {
    let db = DB.lock();
    db.execute(
        "INSERT OR REPLACE INTO Meloming_Artist_Map (local_name, meloming_artist_id, channel_id) VALUES (?, ?, ?)",
        params![local_name.trim(), meloming_artist_id, channel_id],
    )
    .map_err(|e| MelomingError::Message(e.to_string()))?;
    Ok(())
}

pub(crate) fn upsert_category_map_entry(
    channel_id: i64,
    local_name: &str,
    meloming_category_id: i64,
) -> Result<(), MelomingError> {
    let db = DB.lock();
    db.execute(
        "INSERT OR REPLACE INTO Meloming_Category_Map (local_name, meloming_category_id, channel_id) VALUES (?, ?, ?)",
        params![local_name.trim(), meloming_category_id, channel_id],
    )
    .map_err(|e| MelomingError::Message(e.to_string()))?;
    Ok(())
}

pub(crate) fn upsert_artist_maps(channel_id: i64, artists: &[ArtistResponse]) -> Result<usize, MelomingError> {
    let db = DB.lock();
    let mut count = 0usize;
    for a in artists {
        db.execute(
            "INSERT OR REPLACE INTO Meloming_Artist_Map (local_name, meloming_artist_id, channel_id) VALUES (?, ?, ?)",
            params![a.name, a.id, channel_id],
        )
        .map_err(|e| MelomingError::Message(e.to_string()))?;
        count += 1;
    }
    Ok(count)
}

pub async fn pull_channel(channel_id: i64) -> Result<PullResult, MelomingError> {
    let songs = MelomingClient::list_songs(channel_id).await?;
    let artists = MelomingClient::list_artists(channel_id).await.unwrap_or_default();
    let categories = MelomingClient::list_categories(channel_id).await.unwrap_or_default();
    let artists_mapped = upsert_artist_maps(channel_id, &artists)?;
    let _ = upsert_category_maps(channel_id, &categories)?;
    let cat_name_by_id: std::collections::HashMap<i64, String> =
        categories.iter().map(|c| (c.id, c.name.clone())).collect();

    let artist_by_id: std::collections::HashMap<i64, String> =
        artists.iter().map(|a| (a.id, a.name.clone())).collect();

    let existing_songs = load_all_songs_from_db().map_err(MelomingError::Message)?;
    let by_path: HashMap<String, SongMetadata> = existing_songs
        .into_iter()
        .map(|s| (s.path.clone(), s))
        .collect();

    let mut created = 0usize;
    let mut updated = 0usize;
    let mut batch = Vec::new();

    for song in &songs {
        let artist_name = song
            .artist_id
            .and_then(|id| artist_by_id.get(&id).cloned())
            .or_else(|| song.artist_name.clone());

        let mut entry = song_to_metadata(song, channel_id, artist_name);
        let keep_user_categories = find_existing_match(&by_path, song)
            .and_then(|existing| existing.categories.as_ref())
            .is_some_and(|cats| cats.iter().any(|c| !c.trim().is_empty()));
        apply_meloming_categories(&mut entry, song, &cat_name_by_id, keep_user_categories);

        if let Some(existing) = find_existing_match(&by_path, song) {
            entry = merge_pull_update(existing.clone(), entry);
            updated += 1;
        } else {
            created += 1;
        }

        // Best-effort: seed a local unsynced .lrc from Meloming's lyrics text
        // when the track is addressable by URL and no local LRC exists yet.
        // Never overwrites existing sync data (seed_lrc_if_missing is a no-op
        // if any LRC is already found). Songs without a real source URL
        // (synthetic `meloming:song:<id>` paths) have no valid on-disk LRC
        // location under the current addressing scheme, so they're skipped.
        if entry.path.starts_with("http") {
            if let Some(text) = song.lyrics_text.as_deref().filter(|t| !t.trim().is_empty()) {
                if let Some(paths) = crate::state::APP_PATHS.lock().as_ref() {
                    if let Err(e) = crate::alignment::seed_lrc_if_missing(paths, &entry.path, text) {
                        crate::audio_player::sys_log(&format!(
                            "[Meloming] Failed to seed LRC from lyrics_text for {}: {}",
                            entry.path, e
                        ));
                    }
                }
            }
        }

        batch.push(entry);
    }

    save_library_internal(batch)
        .await
        .map_err(|e| MelomingError::Message(e))?;

    Ok(PullResult {
        fetched: songs.len(),
        created,
        updated,
        artists_mapped,
    })
}
