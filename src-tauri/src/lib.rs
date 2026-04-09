use rodio::Source;
use rodio::source::UniformSourceIterator;
use std::fs::File;
use std::io::BufReader;
use std::num::{NonZeroU16, NonZeroU32};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tauri::{Emitter, Manager, WebviewWindow, AppHandle};
use std::process::Command;
use std::collections::HashSet;

mod types;
mod youtube;
mod model_manager;
pub mod vocal_remover;
pub mod audio_player;
mod separation;
pub mod state;
mod metadata_fetcher;

use crate::youtube::YoutubeManager;
use crate::model_manager::ModelManager;
pub use crate::vocal_remover::{InferenceEngine, WaveformRemover};
use urlencoding;
use crate::audio_player::{
    AUDIO_HANDLER, StreamingReader, StretchedSource, DynamicVolumeSource,
    sys_log
};
// use crate::state::MAIN_WINDOW; // Unused in lib.rs
pub use crate::types::{Status, PlaybackStatus, PlaybackProgress, AppState, SongMetadata};
pub use crate::state::DB;
pub use parking_lot::Mutex;
use id3::{Tag, TagLike};
use rusqlite::{params, Error as SqliteError};
use ort::execution_providers::{CUDAExecutionProvider, CPUExecutionProvider, DirectMLExecutionProvider};
use ort::ep::ExecutionProvider;
// use symphonia::core::formats::FormatOptions;
// use symphonia::core::meta::MetadataOptions;
use symphonia::core::io::MediaSourceStream;
use symphonia::core::probe::Hint;
use cpal::traits::{HostTrait, DeviceTrait};

// --- Global Statics ---
static PLAYBACK_VERSION: AtomicU64 = AtomicU64::new(0);

fn to_sqlite_err(e: SqliteError) -> String {
    e.to_string()
}

#[tauri::command]
async fn play_track(window: WebviewWindow, path: String, duration_ms: Option<u64>) -> Result<(), String> {
    let res = play_track_internal(window.clone(), path, duration_ms, None).await;
    if let Err(ref e) = res {
        let _ = window.emit("playback-status", PlaybackStatus { status: Status::Error, message: e.clone() });
    }
    res
}

async fn play_track_internal(window: WebviewWindow, path: String, duration_ms_hint: Option<u64>, start_pos_ms: Option<u64>) -> Result<(), String> {
    let handler = match &*AUDIO_HANDLER {
        Ok(h) => h.clone(),
        Err(e) => return Err(e.clone()),
    };
    
    let target_version = PLAYBACK_VERSION.fetch_add(1, Ordering::SeqCst) + 1;
    sys_log(&format!("[DEBUG] play_track_internal Start: version={}, path={}, start_pos={:?}ms", target_version, path, start_pos_ms));
    
    struct PlaybackPreparationGuard;
    impl Drop for PlaybackPreparationGuard {
        fn drop(&mut self) {
            crate::audio_player::IS_PREPARING_PLAYBACK.store(false, Ordering::SeqCst);
        }
    }
    let _prep_guard = PlaybackPreparationGuard;
    crate::audio_player::IS_PREPARING_PLAYBACK.store(true, Ordering::SeqCst);
    
    let msg = if start_pos_ms.is_some() { "Seeking..." } else { "Preparing..." };
    let _ = window.emit("playback-status", PlaybackStatus { status: Status::Pending, message: msg.into() });

    {
        let controller = handler.controller.lock();
        controller.clear();
        sys_log("[AUDIO] Playback Step 1: Controller cleared");
    }
    
    let rate = handler.track_sample_rate.load(Ordering::Relaxed) as f64;
    let start_samples = if let Some(ms) = start_pos_ms {
        (ms as f64 * rate / 1000.0) as u64
    } else {
        0
    };
    handler.current_pos_samples.store(start_samples, Ordering::Relaxed);
    
    if let Some(d) = duration_ms_hint {
        handler.total_duration_ms.store(d, Ordering::Relaxed);
    } else {
        handler.total_duration_ms.store(0, Ordering::Relaxed);
    }
    
    let paths = window.state::<crate::state::AppPaths>();
    let cache_key = urlencoding::encode(&path).to_string();
    let cache_dir = paths.separated.join(&cache_key);
    let vocal_path = cache_dir.join("vocal.wav");
    let inst_path = cache_dir.join("inst.wav");
    
    let target_rate = handler.active_sample_rate;
    let target_channels = handler.active_channels;
    let target_rate_nz = NonZeroU32::new(target_rate).expect("Invalid sample rate");
    let target_channels_nz = NonZeroU16::new(target_channels).expect("Invalid channels");

    // Case 1: MR Files Exist
    if vocal_path.exists() && inst_path.exists() {
        sys_log(&format!("[AUDIO] Playback Step 2: Found separated MR files at {:?}", cache_dir));
        
        let v_file = File::open(&vocal_path).map_err(|e| format!("Vocal file open failed: {}", e))?;
        let i_file = File::open(&inst_path).map_err(|e| format!("Inst file open failed: {}", e))?;
        
        let mut v_decoder = rodio::Decoder::new(BufReader::new(v_file)).map_err(|e| e.to_string())?;
        let mut i_decoder = rodio::Decoder::new(BufReader::new(i_file)).map_err(|e| e.to_string())?;
        
        handler.track_sample_rate.store(v_decoder.sample_rate().into(), Ordering::Relaxed);

        if let Some(ms) = start_pos_ms {
            let _ = v_decoder.try_seek(Duration::from_millis(ms));
            let _ = i_decoder.try_seek(Duration::from_millis(ms));
        }
        
        if let Some(d) = i_decoder.total_duration() {
            let ms = d.as_millis() as u64;
            handler.total_duration_ms.store(ms, Ordering::Relaxed);

            // [DB Metadata Sync] Update duration if missing (0:00)
            let db = DB.lock();
            let mut current_duration = String::new();
            if let Ok(d_str) = db.query_row("SELECT duration FROM Tracks WHERE path = ?", params![&path], |row| row.get::<_, String>(0)) {
                current_duration = d_str;
            }
            if current_duration == "0:00" || current_duration.is_empty() {
                let secs = ms / 1000;
                let new_duration = format!("{}:{:02}", secs / 60, secs % 60);
                let _ = db.execute("UPDATE Tracks SET duration = ? WHERE path = ?", params![&new_duration, &path]);
                sys_log(&format!("[DB] Updated missing duration for {}: {}", path, new_duration));
            }
        }

        let stretched_v = StretchedSource::new(v_decoder, handler.active_pitch.clone(), handler.active_tempo.clone(), Arc::new(AtomicU64::new(0)));
        let stretched_i = StretchedSource::new(i_decoder, handler.active_pitch.clone(), handler.active_tempo.clone(), handler.current_pos_samples.clone());
        
        let resampled_v = UniformSourceIterator::new(DynamicVolumeSource::new(stretched_v, handler.vocal_volume.clone()), target_channels_nz, target_rate_nz);
        let resampled_i = UniformSourceIterator::new(DynamicVolumeSource::new(stretched_i, handler.instrumental_volume.clone()), target_channels_nz, target_rate_nz);

        let mixed = resampled_i.mix(resampled_v);
        
        let final_v = PLAYBACK_VERSION.load(Ordering::SeqCst);
        if final_v != target_version { return Ok(()); }
        
        {
            let controller = handler.controller.lock();
            controller.append(mixed);
            controller.play();
        }

        {
            let mut state = handler.state.lock();
            state.current_track = Some(path.clone());
            state.is_playing = true;
        }
        
        window.emit("playback-status", PlaybackStatus { status: Status::Playing, message: "Playing".into() }).unwrap();
        sys_log("[DEBUG] Starting instantaneous playback from local MR cache.");
        return Ok(());
    }

    // Case 2: Fallback to Original source
    let play_path = if path.starts_with("http") {
        if start_pos_ms.is_none() {
            window.emit("playback-status", PlaybackStatus { status: Status::Downloading, message: "유튜브 오디오 다운로드 중...".into() }).ok();
        }
        let metadata = YoutubeManager::get_video_metadata(&path).await?;
        let temp_dir = window.state::<crate::state::AppPaths>().temp.clone();
        let final_path = temp_dir.join(format!("yt_{}.m4a", metadata.id.unwrap_or_else(|| "unknown".into())));
        if !final_path.exists() {
            YoutubeManager::download_audio(&window, &path, final_path.clone(), false).await?;
        }
        final_path
    } else {
        if start_pos_ms.is_none() {
            window.emit("playback-status", PlaybackStatus { status: Status::Decoding, message: "파일 읽기 및 디코딩 중...".into() }).ok();
        }
        std::path::PathBuf::from(&path)
    };

    if !play_path.exists() && !path.starts_with("http") {
        return Err("File not found".into());
    }

    let is_yt = path.starts_with("http");
    let mut decoder = {
        let mut first_error_msg = "Unknown error".to_string();
        let mut d = None;
        for i in 0..3 {
            let reader = match StreamingReader::new(play_path.clone(), is_yt) {
                Ok(r) => r,
                Err(e) => {
                    sys_log(&format!("[AUDIO_DEBUG] Reader attempt {} failed to open: {}", i+1, e));
                    first_error_msg = e.to_string();
                    tokio::time::sleep(tokio::time::Duration::from_millis(600)).await;
                    continue;
                }
            };
            match rodio::Decoder::new(std::io::BufReader::new(reader)) {
                Ok(res) => { d = Some(res); break; }
                Err(e) => {
                    sys_log(&format!("[AUDIO_DEBUG] Decoder attempt {} failed: {}", i+1, e));
                    first_error_msg = e.to_string();
                    if i < 2 { tokio::time::sleep(tokio::time::Duration::from_millis(600)).await; }
                }
            }
        }
        match d { Some(res) => res, None => return Err(format!("Failed to decode audio: {}", first_error_msg)) }
    };
    
    handler.track_sample_rate.store(decoder.sample_rate().into(), Ordering::Relaxed);
    if let Some(ms) = start_pos_ms { let _ = decoder.try_seek(Duration::from_millis(ms)); }
    
    if let Some(d) = decoder.total_duration() {
        let ms = d.as_millis() as u64;
        handler.total_duration_ms.store(ms, Ordering::Relaxed);

        // [DB Metadata Sync] Update duration if missing (0:00)
        let db = DB.lock();
        let mut current_duration = String::new();
        if let Ok(d_str) = db.query_row("SELECT duration FROM Tracks WHERE path = ?", params![&path], |row| row.get::<_, String>(0)) {
            current_duration = d_str;
        }
        if current_duration == "0:00" || current_duration.is_empty() {
            let secs = ms / 1000;
            let new_duration = format!("{}:{:02}", secs / 60, secs % 60);
            let _ = db.execute("UPDATE Tracks SET duration = ? WHERE path = ?", params![&new_duration, &path]);
            sys_log(&format!("[DB] Updated missing duration for {}: {}", path, new_duration));
        }
    }

    let stretched = StretchedSource::new(decoder, handler.active_pitch.clone(), handler.active_tempo.clone(), handler.current_pos_samples.clone());
    let dyn_vol = DynamicVolumeSource::new(stretched, handler.instrumental_volume.clone());
    let resampled = UniformSourceIterator::new(dyn_vol, target_channels_nz, target_rate_nz);
    
    let final_v = PLAYBACK_VERSION.load(Ordering::SeqCst);
    if final_v != target_version { return Ok(()); }
    
    {
        let controller = handler.controller.lock();
        controller.append(resampled);
        controller.play();
    }
    
    {
        let mut state = handler.state.lock();
        state.current_track = Some(path.clone());
        state.is_playing = true;
    }
    
    window.emit("playback-status", PlaybackStatus { status: Status::Playing, message: "Playing".into() }).unwrap();
    sys_log("[DEBUG] Starting playback (Original/Fallback)");
    Ok(())
}

#[tauri::command]
fn set_master_volume(volume: f32) -> Result<(), String> {
    if let Ok(handler) = &*AUDIO_HANDLER {
        let controller = handler.controller.lock();
        controller.set_volume(volume / 100.0);
    }
    Ok(())
}

#[tauri::command]
async fn toggle_playback() -> Result<bool, String> {
    let handler = AUDIO_HANDLER.as_ref().map_err(|e| e.clone())?.clone();
    let is_playing = {
        let controller = handler.controller.lock();
        if controller.is_paused() { controller.play(); true } 
        else { controller.pause(); false }
    };
    Ok(is_playing)
}

#[tauri::command]
async fn stop_playback() -> Result<(), String> {
    if let Ok(handler) = &*AUDIO_HANDLER {
        let controller = handler.controller.lock();
        controller.clear();
        let mut state = handler.state.lock();
        state.is_playing = false;
        state.current_track = None;
    }
    Ok(())
}

#[tauri::command]
async fn set_volume(volume: f64) -> Result<(), String> {
    let handler = AUDIO_HANDLER.as_ref().map_err(|e| e.clone())?.clone();
    let v_enabled = handler.state.lock().vocal_enabled;
    let v_vol = if v_enabled { volume as f32 } else { 0.0 };
    handler.vocal_volume.store(v_vol.to_bits(), Ordering::Relaxed);
    handler.instrumental_volume.store((volume as f32).to_bits(), Ordering::Relaxed);
    Ok(())
}

#[tauri::command]
async fn set_vocal_balance(balance: f64) -> Result<(), String> {
    let handler = AUDIO_HANDLER.as_ref().map_err(|e| e.clone())?.clone();
    let b = balance as f32;
    handler.vocal_volume.store(b.to_bits(), Ordering::Relaxed);
    handler.instrumental_volume.store((100.0 - b).to_bits(), Ordering::Relaxed);
    Ok(())
}

#[tauri::command]
async fn set_pitch(semitones: f64) -> Result<(), String> {
    let handler = AUDIO_HANDLER.as_ref().map_err(|e| e.clone())?.clone();
    handler.active_pitch.store((semitones as f32).to_bits(), Ordering::Relaxed);
    Ok(())
}

#[tauri::command]
async fn set_tempo(ratio: f64) -> Result<(), String> {
    let handler = AUDIO_HANDLER.as_ref().map_err(|e| e.clone())?.clone();
    handler.active_tempo.store((ratio as f32).to_bits(), Ordering::Relaxed);
    Ok(())
}

#[tauri::command]
async fn seek_to(position_ms: u64) -> Result<(), String> {
    let handler = AUDIO_HANDLER.as_ref().map_err(|e| e.clone())?.clone();
    let (path, duration_ms) = {
        let state = handler.state.lock();
        (state.current_track.clone(), handler.total_duration_ms.load(Ordering::Relaxed))
    };

    if let Some(p) = path {
        // [FADE-OUT] Set volumes to 0 for a quick fade out before jump
        let current_instrumental = handler.instrumental_volume.load(Ordering::Relaxed);
        let current_vocal = handler.vocal_volume.load(Ordering::Relaxed);
        
        handler.instrumental_volume.store(0f32.to_bits(), Ordering::Relaxed);
        handler.vocal_volume.store(0f32.to_bits(), Ordering::Relaxed);
        
        // Wait for fade-out to complete (approx 50-60ms)
        tokio::time::sleep(tokio::time::Duration::from_millis(60)).await;

        let window_opt = crate::state::MAIN_WINDOW.lock().clone();
        if let Some(window) = window_opt {
            sys_log(&format!("[AUDIO] Seek request: {}ms for {}", position_ms, p));
            
            // Restore target volumes so play_track_internal's new source can fade-in to them
            handler.instrumental_volume.store(current_instrumental, Ordering::Relaxed);
            handler.vocal_volume.store(current_vocal, Ordering::Relaxed);
            
            let _ = play_track_internal(window, p, Some(duration_ms), Some(position_ms)).await;
        }
    }
    Ok(())
}

#[tauri::command]
async fn toggle_ai_feature(feature: String, enabled: bool) -> Result<(), String> {
    if let Ok(handler) = &*AUDIO_HANDLER {
        let mut state = handler.state.lock();
        match feature.as_str() {
            "vocal" => {
                state.vocal_enabled = enabled;
                let current_vol = f32::from_bits(handler.instrumental_volume.load(Ordering::Relaxed));
                let target_v_vol = if enabled { current_vol } else { 0.0 };
                handler.vocal_volume.store(target_v_vol.to_bits(), Ordering::Relaxed);
            },
            "lyric" => state.lyric_enabled = enabled,
            _ => {}
        }
    }
    Ok(())
}

#[tauri::command]
async fn check_mr_separated(window: WebviewWindow, path: String) -> Result<bool, String> {
    let paths = window.state::<crate::state::AppPaths>();
    let cache_dir = paths.separated.join(urlencoding::encode(&path).to_string());
    Ok(cache_dir.join("vocal.wav").exists() && cache_dir.join("inst.wav").exists())
}

#[tauri::command]
async fn delete_mr(window: WebviewWindow, path: String) -> Result<(), String> {
    let handler = AUDIO_HANDLER.as_ref().map_err(|e| e.clone())?.clone();
    let (current_path, is_playing, current_pos_ms) = {
        let state = handler.state.lock();
        let samples = handler.current_pos_samples.load(Ordering::Relaxed);
        let track_rate = handler.track_sample_rate.load(Ordering::Relaxed);
        let pos_ms = if track_rate > 0 { (samples as f64 / track_rate as f64 * 1000.0) as u64 } else { 0 };
        (state.current_track.clone(), state.is_playing, pos_ms)
    };

    let paths = window.state::<crate::state::AppPaths>();
    let cache_dir = paths.separated.join(urlencoding::encode(&path).to_string());
    if cache_dir.exists() {
        std::fs::remove_dir_all(cache_dir).map_err(|e| e.to_string())?;
    }

    // Update DB: Reset MR flag
    {
        let db = DB.lock();
        let _ = db.execute("UPDATE Tracks SET is_mr = 0 WHERE path = ?", params![&path]);
        sys_log(&format!("[DB] Reset is_mr flag for {}", path));
    }

    if is_playing && current_path.as_deref() == Some(&path) {
        sys_log(&format!("[DEBUG] Deleted MR for active track. Reverting to original source @{}ms.", current_pos_ms));
        let hint = handler.total_duration_ms.load(Ordering::Relaxed);
        play_track_internal(window, path, Some(hint), Some(current_pos_ms)).await?;
    }
    Ok(())
}

#[tauri::command]
async fn get_youtube_metadata(url: String) -> Result<SongMetadata, String> {
    let metadata_res = YoutubeManager::get_video_metadata(&url).await;
    let (title, thumbnail, duration, artist) = match metadata_res {
        Ok(m) => {
            let secs = m.duration.unwrap_or(0.0) as u64;
            (m.title.unwrap_or_else(|| "Unknown Video".into()), m.thumbnail.unwrap_or_default(), format!("{}:{:02}", secs / 60, secs % 60), m.uploader)
        },
        Err(e) => {
            sys_log(&format!("[Youtube] Fetch failed for {}: {}", url, e));
            ("Unknown YouTube Video".into(), "".into(), "0:00".into(), None)
        }
    };

    Ok(SongMetadata {
        id: None, title, thumbnail, duration, source: "youtube".into(), path: url,
        pitch: Some(0.0), tempo: Some(1.0), volume: Some(80.0), artist,
        tags: None, genre: None, categories: None, play_count: Some(0),
        date_added: Some(std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs()), is_mr: Some(false),
    })
}

#[tauri::command]
async fn get_audio_metadata(path: String) -> Result<SongMetadata, String> {
    if path.starts_with("http") { return get_youtube_metadata(path).await; }

    let file_path = std::path::Path::new(&path);
    let file_name = file_path.file_name().unwrap_or_default().to_string_lossy().to_string();
    let duration_str = probe_audio_duration(&path).unwrap_or_else(|| "0:00".into());

    let mut genre = "Unknown".to_string();
    let (mut artist_id3, mut title_id3) = (None, None);
    if let Ok(tag) = Tag::read_from_path(&path) {
        if let Some(g) = tag.genre() { genre = g.to_string(); }
        artist_id3 = tag.artist().map(|s| s.to_string());
        title_id3 = tag.title().map(|s| s.to_string());
    }

    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs();
    let final_title = title_id3.unwrap_or(file_name);

    let db = DB.lock();
    db.execute("INSERT OR IGNORE INTO Genres (name) VALUES (?)", params![genre]).map_err(to_sqlite_err)?;
    let genre_id: i64 = db.query_row("SELECT id FROM Genres WHERE name = ?", params![genre], |row| row.get(0)).map_err(to_sqlite_err)?;

    db.execute(
        "INSERT INTO Tracks (path, title, thumbnail, duration, source, pitch, tempo, volume, artist, date_added, is_mr, genre_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(path) DO UPDATE SET title=excluded.title, duration=excluded.duration, artist=excluded.artist, genre_id=excluded.genre_id",
        params![path, final_title, "", duration_str, "local", 0.0, 1.0, 80.0, artist_id3, now, 0, genre_id]
    ).map_err(to_sqlite_err)?;

    let track_id: i64 = db.query_row("SELECT id FROM Tracks WHERE path = ?", params![path], |row| row.get(0)).map_err(to_sqlite_err)?;

    Ok(SongMetadata {
        id: Some(track_id), title: final_title, thumbnail: "".into(), duration: duration_str,
        source: "local".into(), path, pitch: Some(0.0), tempo: Some(1.0), volume: Some(80.0),
        artist: artist_id3, tags: None, genre: Some(genre), categories: None, play_count: Some(0),
        date_added: Some(now), is_mr: Some(false),
    })
}

#[tauri::command]
async fn get_songs() -> Result<Vec<SongMetadata>, String> {
    let db = DB.lock();
    let mut stmt = db.prepare(
        "SELECT t.id, t.path, t.title, t.thumbnail, t.duration, t.source, t.pitch, t.tempo, t.volume, t.artist, t.play_count, t.date_added, t.is_mr, g.name as genre,
         (SELECT GROUP_CONCAT(name) FROM Tags JOIN Track_Tag_Map ON Tags.id = Track_Tag_Map.tag_id WHERE Track_Tag_Map.track_id = t.id) as tags,
         (SELECT GROUP_CONCAT(name) FROM Categories JOIN Track_Category_Map ON Categories.id = Track_Category_Map.category_id WHERE Track_Category_Map.track_id = t.id) as categories
         FROM Tracks t LEFT JOIN Genres g ON t.genre_id = g.id"
    ).map_err(to_sqlite_err)?;
    
    let song_iter = stmt.query_map([], |row| {
        let tags = row.get::<_, Option<String>>(14).ok().flatten()
            .map(|s| s.split(',').map(|t| t.to_string()).collect());
        let categories = row.get::<_, Option<String>>(15).ok().flatten()
            .map(|s| s.split(',').map(|t| t.to_string()).collect());
        
        Ok(SongMetadata {
            id: row.get(0).ok(), path: row.get(1)?, title: row.get(2)?, thumbnail: row.get::<_, String>(3).unwrap_or_default(),
            duration: row.get::<_, String>(4).unwrap_or_default(), source: row.get::<_, String>(5).unwrap_or_default(),
            pitch: row.get(6).ok(), tempo: row.get(7).ok(), volume: row.get(8).ok(), artist: row.get(9).ok(),
            play_count: row.get::<_, u32>(10).ok(), date_added: row.get::<_, u64>(11).ok(),
            is_mr: Some(row.get::<_, i64>(12).unwrap_or(0) != 0), genre: row.get(13).ok(), tags, categories,
        })
    }).map_err(to_sqlite_err)?;

    let mut songs = Vec::new();
    for song in song_iter { songs.push(song.map_err(to_sqlite_err)?); }
    Ok(songs)
}

#[tauri::command]
async fn load_library() -> Result<Vec<SongMetadata>, String> { get_songs().await }

#[tauri::command]
async fn get_categories() -> Result<Vec<crate::types::Category>, String> {
    let db = DB.lock();
    let mut stmt = db.prepare("SELECT id, name FROM Categories").map_err(to_sqlite_err)?;
    let iter = stmt.query_map([], |row| Ok(crate::types::Category { id: row.get(0)?, name: row.get(1)? })).map_err(to_sqlite_err)?;
    let mut res = Vec::new();
    for i in iter { res.push(i.map_err(to_sqlite_err)?); }
    Ok(res)
}

#[tauri::command]
async fn get_genres() -> Result<Vec<crate::types::Genre>, String> {
    let db = DB.lock();
    let mut stmt = db.prepare("SELECT id, name FROM Genres").map_err(to_sqlite_err)?;
    let iter = stmt.query_map([], |row| Ok(crate::types::Genre { id: row.get(0)?, name: row.get(1)? })).map_err(to_sqlite_err)?;
    let mut res = Vec::new();
    for i in iter { res.push(i.map_err(to_sqlite_err)?); }
    Ok(res)
}

#[tauri::command]
async fn add_category(name: String) -> Result<i64, String> {
    let db = DB.lock();
    db.execute("INSERT INTO Categories (name) VALUES (?)", params![name]).map_err(to_sqlite_err)?;
    Ok(db.last_insert_rowid())
}

#[tauri::command]
async fn delete_category(id: i64) -> Result<(), String> {
    let db = DB.lock();
    db.execute("DELETE FROM Track_Category_Map WHERE category_id = ?", params![id]).ok();
    db.execute("DELETE FROM Categories WHERE id = ?", params![id]).map_err(to_sqlite_err)?;
    Ok(())
}

#[tauri::command]
async fn map_track_to_categories(track_id: i64, category_ids: Vec<i64>) -> Result<(), String> {
    let mut db = DB.lock();
    let tx = db.transaction().map_err(to_sqlite_err)?;
    tx.execute("DELETE FROM Track_Category_Map WHERE track_id = ?", params![track_id]).ok();
    for cat_id in category_ids {
        tx.execute("INSERT INTO Track_Category_Map (track_id, category_id) VALUES (?, ?)", params![track_id, cat_id]).ok();
    }
    tx.commit().map_err(to_sqlite_err)?;
    Ok(())
}

#[tauri::command]
async fn get_playback_state() -> Result<AppState, String> {
    let handler = AUDIO_HANDLER.as_ref().map_err(|e| e.clone())?.clone();
    let state = handler.state.lock().clone();
    Ok(state)
}

#[tauri::command]
async fn check_ai_runtime() -> Result<Vec<String>, String> {
    let mut providers = Vec::new();
    if CUDAExecutionProvider::default().is_available().unwrap_or(false) { providers.push("CUDA".to_string()); }
    if CPUExecutionProvider::default().is_available().unwrap_or(false) { providers.push("CPU".to_string()); }
    Ok(providers)
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GpuStatus { pub has_nvidia: bool, pub is_cuda_available: bool, pub is_directml_available: bool, pub recommend_cuda: bool }

#[tauri::command]
async fn get_gpu_recommendation() -> Result<GpuStatus, String> {
    let mut has_nvidia = false;
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        let mut cmd = Command::new("wmic");
        cmd.creation_flags(0x08000000); // NO_WINDOW
        if let Ok(output) = cmd.args(["path", "win32_VideoController", "get", "name"]).output() {
            if String::from_utf8_lossy(&output.stdout).to_uppercase().contains("NVIDIA") { has_nvidia = true; }
        }
    }
    let cuda = CUDAExecutionProvider::default().is_available().unwrap_or(false);
    let dml = DirectMLExecutionProvider::default().is_available().unwrap_or(false);
    Ok(GpuStatus { has_nvidia, is_cuda_available: cuda, is_directml_available: dml, recommend_cuda: has_nvidia && !cuda && !dml })
}

#[tauri::command]
async fn check_model_ready(handle: AppHandle) -> bool {
    ModelManager::new(&handle).get_model_path("Kim_Vocal_2.onnx").exists()
}

#[tauri::command]
async fn download_ai_model(window: WebviewWindow) -> Result<(), String> {
    let app = window.app_handle();
    let manager = ModelManager::new(app);
    window.emit("playback-status", PlaybackStatus { status: Status::Downloading, message: "AI 모델 다운로드...".into() }).ok();
    manager.ensure_model(app, "Kim_Vocal_2.onnx", "https://huggingface.co/seanghay/uvr_models/resolve/main/Kim_Vocal_2.onnx").await?;
    window.emit("playback-status", PlaybackStatus { status: Status::Finished, message: "AI 모델 준비됨".into() }).ok();
    Ok(())
}

#[tauri::command]
async fn delete_ai_model(window: WebviewWindow) -> Result<(), String> {
    let manager = ModelManager::new(window.app_handle());
    let path = manager.get_model_path("Kim_Vocal_2.onnx");
    if path.exists() {
        std::fs::remove_file(path).ok();
        *crate::separation::ROFORMER_ENGINE.lock() = None;
    }
    Ok(())
}

#[tauri::command]
async fn set_broadcast_mode(enabled: bool) -> Result<(), String> {
    crate::separation::BROADCAST_MODE.store(enabled, std::sync::atomic::Ordering::Relaxed);
    crate::audio_player::sys_log(&format!("Broadcast Mode set to: {}", enabled));
    Ok(())
}

#[tauri::command]
fn get_active_separations() -> Vec<String> {
    crate::separation::ACTIVE_SEPARATIONS.lock()
        .values()
        .map(|(original_path, _)| original_path.clone())
        .collect()
}

#[tauri::command]
fn get_app_paths(handle: AppHandle) -> crate::state::AppPaths { handle.state::<crate::state::AppPaths>().inner().clone() }

#[tauri::command]
async fn get_audio_devices() -> Result<Vec<String>, String> {
    let host = cpal::default_host();
    let devices = host.output_devices().map_err(|e| e.to_string())?;
    let mut names = Vec::new();
    for d in devices {
        if let Ok(desc) = d.description() {
            let config = d.default_output_config().map(|c| format!("{}Hz, {}ch", u32::from(c.sample_rate()), c.channels())).unwrap_or_else(|_| "N/A".into());
            names.push(format!("{} ({})", desc.name(), config));
        }
    }
    Ok(names)
}

#[tauri::command]
async fn open_cache_folder(window: WebviewWindow) -> Result<(), String> {
    let path = window.state::<crate::state::AppPaths>().separated.clone();
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        Command::new("explorer").arg(path.to_string_lossy().to_string()).creation_flags(0x08000000).spawn().ok();
    }
    Ok(())
}

#[tauri::command]
async fn start_mr_separation(window: WebviewWindow, path: String) -> Result<(), String> {
    let norm = path.replace("\\", "/").to_lowercase();
    if crate::separation::ACTIVE_SEPARATIONS.lock().contains_key(&norm) { return Err("ALREADY_PROCESSING".into()); }
    let cache = window.state::<crate::state::AppPaths>().separated.join(urlencoding::encode(&path).to_string());
    let task = crate::separation::task::SeparationTask::new(window, path, cache);
    tauri::async_runtime::spawn(async move { task.run().await; });
    Ok(())
}

#[tauri::command]
fn cancel_separation(path: String) -> Result<(), String> {
    let norm = path.replace("\\", "/").to_lowercase();
    if let Some((_, flag)) = crate::separation::ACTIVE_SEPARATIONS.lock().remove(&norm) { flag.store(true, Ordering::Relaxed); }
    Ok(())
}

#[tauri::command]
async fn delete_song(path: String) -> Result<(), String> {
    let db = DB.lock();
    db.execute("DELETE FROM Tracks WHERE path = ?", params![path]).map_err(to_sqlite_err)?;
    Ok(())
}

#[tauri::command]
fn save_library(_app: AppHandle, songs: Vec<SongMetadata>) -> Result<(), String> {
    let mut db = DB.lock();
    let tx = db.transaction().map_err(to_sqlite_err)?;
    
    // Sync Deletions
    let db_paths: Vec<String> = tx.prepare("SELECT path FROM Tracks").unwrap().query_map([], |row| row.get(0)).unwrap().filter_map(|r| r.ok()).collect();
    let current_paths: HashSet<String> = songs.iter().map(|s| s.path.clone()).collect();
    for p in db_paths { if !current_paths.contains(&p) { tx.execute("DELETE FROM Tracks WHERE path = ?", params![p]).ok(); } }

    for song in songs {
        let genre_id: Option<i64> = if let Some(g) = &song.genre {
            tx.execute("INSERT OR IGNORE INTO Genres (name) VALUES (?)", params![g]).ok();
            tx.query_row("SELECT id FROM Genres WHERE name = ?", params![g], |row| row.get(0)).ok()
        } else { None };

        tx.execute(
            "INSERT OR REPLACE INTO Tracks (path, title, thumbnail, duration, source, pitch, tempo, volume, artist, play_count, date_added, is_mr, genre_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            params![song.path, song.title, song.thumbnail, song.duration, song.source, song.pitch.unwrap_or(0.0), song.tempo.unwrap_or(1.0),
                    song.volume.unwrap_or(80.0), song.artist, song.play_count.unwrap_or(0), song.date_added, if song.is_mr.unwrap_or(false) { 1 } else { 0 }, genre_id]
        ).ok();

        let track_id: Option<i64> = tx.query_row("SELECT id FROM Tracks WHERE path = ?", params![song.path], |row| row.get(0)).ok();
        if let Some(tid) = track_id {
            if let Some(tags) = &song.tags {
                tx.execute("DELETE FROM Track_Tag_Map WHERE track_id = ?", params![tid]).ok();
                for t in tags {
                    tx.execute("INSERT OR IGNORE INTO Tags (name) VALUES (?)", params![t]).ok();
                    if let Ok(tgid) = tx.query_row("SELECT id FROM Tags WHERE name = ?", params![t], |row| row.get::<_, i64>(0)) {
                        tx.execute("INSERT OR IGNORE INTO Track_Tag_Map (track_id, tag_id) VALUES (?, ?)", params![tid, tgid]).ok();
                    }
                }
            }
            if let Some(cats) = &song.categories {
                tx.execute("DELETE FROM Track_Category_Map WHERE track_id = ?", params![tid]).ok();
                for c in cats {
                    tx.execute("INSERT OR IGNORE INTO Categories (name) VALUES (?)", params![c]).ok();
                    if let Ok(cid) = tx.query_row("SELECT id FROM Categories WHERE name = ?", params![c], |row| row.get::<_, i64>(0)) {
                        tx.execute("INSERT OR IGNORE INTO Track_Category_Map (track_id, category_id) VALUES (?, ?)", params![tid, cid]).ok();
                    }
                }
            }
        }
    }
    tx.commit().map_err(to_sqlite_err)?;
    Ok(())
}

#[tauri::command]
async fn export_backup() -> Result<(), String> {
    if let Some(path) = rfd::AsyncFileDialog::new()
        .add_filter("JSON", &["json"])
        .set_file_name("LiveMR_Backup.json")
        .save_file()
        .await
    {
        let songs = get_songs().await?;
        let json = serde_json::to_string_pretty(&songs).map_err(|e| e.to_string())?;
        std::fs::write(path.path(), json).map_err(|e| e.to_string())?;
        Ok(())
    } else {
        Err("CANCELLED".into())
    }
}

#[tauri::command]
async fn import_backup(app: AppHandle) -> Result<(), String> {
    if let Some(path) = rfd::AsyncFileDialog::new()
        .add_filter("JSON", &["json"])
        .pick_file()
        .await
    {
        let json = std::fs::read_to_string(path.path()).map_err(|e| e.to_string())?;
        let backup_songs: Vec<SongMetadata> = serde_json::from_str(&json).map_err(|e| e.to_string())?;
        
        // 병합 (Merge) 로직
        let mut current_songs = get_songs().await?;
        let current_paths: std::collections::HashSet<String> = current_songs.iter().map(|s| s.path.clone()).collect();
        
        for song in backup_songs {
            if !current_paths.contains(&song.path) {
                current_songs.push(song);
            }
        }
        
        save_library(app, current_songs)?;
        Ok(())
    } else {
        Err("CANCELLED".into())
    }
}

#[tauri::command]
async fn get_track_count() -> Result<i64, String> {
    let db = DB.lock();
    db.query_row("SELECT count(*) FROM Tracks", [], |row| row.get(0)).map_err(to_sqlite_err)
}

fn probe_audio_duration(path: &str) -> Option<String> {
    let mss = MediaSourceStream::new(Box::new(File::open(path).ok()?), Default::default());
    let mut hint = Hint::new();
    if path.to_lowercase().ends_with(".mp3") { hint.with_extension("mp3"); }
    let probed = symphonia::default::get_probe().format(&hint, mss, &Default::default(), &Default::default()).ok()?;
    let track = probed.format.default_track().or_else(|| probed.format.tracks().first())?;
    if let (Some(frames), Some(rate)) = (track.codec_params.n_frames, track.codec_params.sample_rate) {
        let s = frames / (rate as u64);
        return Some(format!("{}:{:02}", s / 60, s % 60));
    }
    if let Ok(d) = rodio::Decoder::new(BufReader::new(File::open(path).ok()?)) {
        if let Some(dur) = d.total_duration() {
            let s = dur.as_secs();
            return Some(format!("{}:{:02}", s / 60, s % 60));
        }
    }
    None
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let paths = crate::state::AppPaths::from_handle(app.handle());
            *crate::state::APP_PATHS.lock() = Some(paths.clone());
            app.manage(paths);
            let _ = &*crate::state::DB;
            if let Some(w) = app.get_webview_window("main") {
                *crate::state::MAIN_WINDOW.lock() = Some(w.clone());
                let w_clone = w.clone();
                std::thread::spawn(move || loop {
                    std::thread::sleep(Duration::from_millis(200));
                    if let Ok(handler) = &*AUDIO_HANDLER {
                        let (samples, duration_ms, track_rate) = {
                            (handler.current_pos_samples.load(Ordering::Relaxed), handler.total_duration_ms.load(Ordering::Relaxed), handler.track_sample_rate.load(Ordering::Relaxed))
                        };
                        let pos_ms = if track_rate > 0 { (samples as f64 / track_rate as f64 * 1000.0) as u64 } else { 0 };
                        let is_locked = crate::audio_player::IS_PREPARING_PLAYBACK.load(Ordering::SeqCst);
                        let sink_empty = handler.controller.lock().empty();
                        
                        if (sink_empty || (duration_ms > 0 && pos_ms >= duration_ms + 1000)) && duration_ms > 0 && !is_locked {
                            let mut state = handler.state.lock();
                            if state.is_playing {
                                state.is_playing = false;
                                handler.controller.lock().clear();
                                handler.current_pos_samples.store(0, Ordering::Relaxed);
                                let _ = w_clone.emit("playback-status", PlaybackStatus { status: Status::Finished, message: "Finished".into() });
                            }
                        }
                        if duration_ms > 0 {
                            let _ = w_clone.emit("playback-progress", PlaybackProgress { position_ms: pos_ms, duration_ms });
                        }
                    }
                });
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            play_track, toggle_playback, stop_playback, seek_to, set_pitch, set_tempo, set_volume, set_master_volume,
            set_vocal_balance, toggle_ai_feature, check_mr_separated, delete_mr, start_mr_separation, get_youtube_metadata,
            get_audio_metadata, get_playback_state, check_ai_runtime, check_model_ready, download_ai_model, save_library,
            load_library, get_songs, get_categories, get_genres, get_track_count, cancel_separation, set_broadcast_mode,
            get_audio_devices, open_cache_folder, delete_ai_model, get_gpu_recommendation, add_category, delete_category,
            delete_song, map_track_to_categories, get_app_paths, export_backup, import_backup, get_active_separations,
            metadata_fetcher::search_track_metadata, metadata_fetcher::fetch_and_process_tags,
            metadata_fetcher::init_metadata_context, metadata_fetcher::get_unclassified_tags,
            metadata_fetcher::update_custom_dictionary
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
