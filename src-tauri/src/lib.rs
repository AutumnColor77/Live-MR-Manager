use rodio::{Decoder, Source};
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

use crate::youtube::YoutubeManager;
use crate::model_manager::ModelManager;
pub use crate::vocal_remover::{InferenceEngine, WaveformRemover};
use urlencoding;
use crate::audio_player::{
    AUDIO_HANDLER, StreamingReader, StretchedSource, DynamicVolumeSource,
    sys_log
};
use crate::state::MAIN_WINDOW;
pub use crate::types::{Status, PlaybackStatus, PlaybackProgress, AppState, SongMetadata};
pub use crate::state::DB;
pub use parking_lot::Mutex;
use id3::{Tag, TagLike};
use rusqlite::{params, Error as SqliteError, Row as SqliteRow};
use ort::execution_providers::{CUDAExecutionProvider, CPUExecutionProvider, DirectMLExecutionProvider};
use ort::ep::ExecutionProvider;
use symphonia::core::formats::FormatOptions;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::io::MediaSourceStream;
use symphonia::core::probe::Hint;
use cpal::traits::{HostTrait, DeviceTrait};


// --- AI Engine ---
static PLAYBACK_VERSION: AtomicU64 = AtomicU64::new(0);


// --- Streaming Support ---
// Audio processing types and handlers have been moved to audio_player.rs

// AppState, Status, PlaybackStatus, etc. are now imported from audio_player.rs
// SongMetadata struct is now imported from crate::state

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
    
    // 1. Initial status - Only if not a seek (Silent Seek)
    if start_pos_ms.is_none() {
        window.emit("playback-status", PlaybackStatus { status: Status::Pending, message: "Preparing...".into() }).unwrap();
    }

    // 1. Immediate stop and reset
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
    
    // Set initial duration from hint immediately to avoid zero-flicker and fix FLAC/VBR finished detection
    if let Some(d) = duration_ms_hint {
        handler.total_duration_ms.store(d, Ordering::Relaxed);
    } else {
        handler.total_duration_ms.store(0, Ordering::Relaxed);
    }
    
    // 2. Metadata and path setup
    let paths = window.state::<crate::state::AppPaths>();
    let cache_key = urlencoding::encode(&path).to_string();
    let cache_dir = paths.separated.join(&cache_key);
    let vocal_path = cache_dir.join("vocal.wav");
    let inst_path = cache_dir.join("inst.wav");
    
    // Setup pipeline basic info for skip-path and fallback-path
    let target_rate = handler.active_sample_rate;
    let target_channels = handler.active_channels;
    let target_rate_nz = NonZeroU32::new(target_rate).expect("Invalid sample rate");
    let target_channels_nz = NonZeroU16::new(target_channels).expect("Invalid channels");

    // NEW LOGIC: Check for separated MR files first to avoid unnecessary network/file checks
    if vocal_path.exists() && inst_path.exists() {
        sys_log(&format!("[AUDIO] Playback Step 2: Found separated MR files at {:?}", cache_dir));
        
        // Separated paths - PLAY IMMEDIATELY
        let v_file = File::open(&vocal_path).map_err(|e| format!("Vocal file open failed: {}", e))?;
        let i_file = File::open(&inst_path).map_err(|e| format!("Inst file open failed: {}", e))?;
        
        let mut v_decoder = Decoder::new(BufReader::new(v_file)).map_err(|e| e.to_string())?;
        let mut i_decoder = Decoder::new(BufReader::new(i_file)).map_err(|e| e.to_string())?;
        
        handler.track_sample_rate.store(v_decoder.sample_rate().into(), Ordering::Relaxed);

        if let Some(ms) = start_pos_ms {
            let _ = v_decoder.try_seek(Duration::from_millis(ms));
            let _ = i_decoder.try_seek(Duration::from_millis(ms));
        }
        
        if let Some(d) = i_decoder.total_duration() {
            handler.total_duration_ms.store(d.as_millis() as u64, Ordering::Relaxed);
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

    // [FALLBACK] If MR doesn't exist, resolve the play_path (YouTube or Local)
    let play_path = if path.starts_with("http") {
        if start_pos_ms.is_none() {
            window.emit("playback-status", PlaybackStatus { 
                status: Status::Downloading, 
                message: "유튜브 오디오 다운로드 중...".to_string() 
            }).ok();
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
            window.emit("playback-status", PlaybackStatus { 
                status: Status::Decoding, 
                message: "파일 읽기 및 디코딩 중...".to_string() 
            }).ok();
        }
        std::path::PathBuf::from(&path)
    };

    if !play_path.exists() && !path.starts_with("http") {
        return Err("File not found".into());
    }

    sys_log(&format!("Playing original/mono: {} (Device: {}Hz, {}ch)", path, target_rate, target_channels));

    let is_yt = path.starts_with("http");
    let reader = StreamingReader::new(play_path.clone(), is_yt).map_err(|e: std::io::Error| format!("Failed to open stream: {}", e))?;
    let mut decoder = rodio::Decoder::new(std::io::BufReader::new(reader)).map_err(|e: rodio::decoder::DecoderError| e.to_string())?;
    
    handler.track_sample_rate.store(decoder.sample_rate().into(), Ordering::Relaxed);
    
    if let Some(ms) = start_pos_ms {
        let _ = decoder.try_seek(Duration::from_millis(ms));
    }
    
    if let Some(d) = decoder.total_duration() {
        handler.total_duration_ms.store(d.as_millis() as u64, Ordering::Relaxed);
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
    sys_log("[DEBUG] Starting playback (Original/Mono)");
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
        if controller.is_paused() {
            controller.play();
            true
        } else {
            controller.pause();
            false
        }
    };
    Ok(is_playing)
}

#[tauri::command]
async fn set_volume(volume: f64) -> Result<(), String> {
    let handler = AUDIO_HANDLER.as_ref().map_err(|e| e.clone())?.clone();
    let v_enabled = {
        let state = handler.state.lock();
        state.vocal_enabled
    };
    
    let v_vol = if v_enabled { volume as f32 } else { 0.0 };
    handler.vocal_volume.store(v_vol.to_bits(), Ordering::Relaxed);
    handler.instrumental_volume.store((volume as f32).to_bits(), Ordering::Relaxed);
    Ok(())
}

#[tauri::command]
async fn set_vocal_balance(balance: f64) -> Result<(), String> {
    let handler = AUDIO_HANDLER.as_ref().map_err(|e| e.clone())?.clone();
    // balance: 0 (inst only) to 100 (vocal only)
    let b = balance as f32;
    let v_vol = b;
    let i_vol = 100.0 - b;
    handler.vocal_volume.store(v_vol.to_bits(), Ordering::Relaxed);
    handler.instrumental_volume.store(i_vol.to_bits(), Ordering::Relaxed);
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
    
    // Get current track path and duration hint to recreate the pipeline
    let (path, duration_ms) = {
        let state = handler.state.lock();
        let path = state.current_track.clone();
        let duration = handler.total_duration_ms.load(Ordering::Relaxed);
        (path, duration)
    };

    if let Some(p) = path {
        let window_opt = { crate::state::MAIN_WINDOW.lock().clone() };
        
        if let Some(window) = window_opt {
            sys_log(&format!("[AUDIO] Seek request received: {}ms for {}", position_ms, p));
            // Re-run play_track_internal from the new start position
            let p_clone = p.clone();
            
            // Execute directly and await to ensure completion
            // The lock is already dropped here, so it's safe to await
            let res = play_track_internal(window, p_clone, Some(duration_ms), Some(position_ms)).await;
            if let Err(e) = res {
                sys_log(&format!("[DEBUG] play_track_internal failed during seek: {}", e));
            }
            
            sys_log(&format!("[AUDIO] Seek completed: {}ms", position_ms));
        } else {
             sys_log("[DEBUG] Seek failed: MAIN_WINDOW is None");
        }
    } else {
        sys_log("[DEBUG] Seek failed: No current track path available");
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
    let cache_key = urlencoding::encode(&path).to_string();
    let cache_dir = paths.separated.join(&cache_key);
    let vocal_path = cache_dir.join("vocal.wav");
    let inst_path = cache_dir.join("inst.wav");
    Ok(vocal_path.exists() && inst_path.exists())
}

#[tauri::command]
async fn delete_mr(window: WebviewWindow, path: String) -> Result<(), String> {
    // 1. Get audio handler and current playback state
    let handler = AUDIO_HANDLER.as_ref().map_err(|e| e.clone())?.clone();
    let (current_track_path, is_playing, current_pos_ms) = {
        let state = handler.state.lock();
        let track_rate = handler.track_sample_rate.load(Ordering::Relaxed);
        let samples = handler.current_pos_samples.load(Ordering::Relaxed);
        let pos_ms = if track_rate > 0 {
            (samples as f64 / track_rate as f64 * 1000.0) as u64
        } else {
            0
        };
        (state.current_track.clone(), state.is_playing, pos_ms)
    };

    // 2. Delete the cached MR files
    let paths = window.state::<crate::state::AppPaths>();
    let cache_key = urlencoding::encode(&path).to_string();
    let cache_dir = paths.separated.join(&cache_key);
    if cache_dir.exists() {
        std::fs::remove_dir_all(cache_dir).map_err(|e| e.to_string())?;
    }

    // 3. Check if the deleted track was the one currently playing
    if is_playing {
        if let Some(current_path) = current_track_path {
            if current_path == path {
                // The deleted track was active. Restart playback from the original source.
                sys_log(&format!("[DEBUG] Deleted MR for active track. Restarting playback from original source at {}ms.", current_pos_ms));
                let duration_hint = handler.total_duration_ms.load(Ordering::Relaxed);
                
                // Call play_track_internal to restart playback from the original source
                play_track_internal(window, path, Some(duration_hint), Some(current_pos_ms)).await?;
            }
        }
    }

    Ok(())
}

#[tauri::command]
async fn get_youtube_metadata(url: String) -> Result<SongMetadata, String> {
    let metadata_res = YoutubeManager::get_video_metadata(&url).await;
    let (title, thumbnail, duration, artist) = match metadata_res {
        Ok(m) => {
            let d = {
                let secs = m.duration.unwrap_or(0.0) as u64;
                format!("{}:{:02}", secs / 60, secs % 60)
            };
            (m.title.unwrap_or_else(|| "Unknown YouTube Video".into()), m.thumbnail.unwrap_or_default(), d, m.uploader)
        },
        Err(e) => {
            println!("DEBUG: [Youtube] Metadata fetch failed for {}: {}", url, e);
            ("Unknown YouTube Video".into(), "".into(), "0:00".into(), None)
        }
    };

    Ok(SongMetadata {
        id: None,
        title,
        thumbnail,
        duration,
        source: "youtube".into(),
        path: url,
        pitch: Some(0.0),
        tempo: Some(1.0),
        volume: Some(80.0),
        artist,
        tags: None,
        genre: None,
        categories: None,
        play_count: Some(0),
        date_added: Some(std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs()),
        is_mr: Some(false),
    })
}

#[tauri::command]
async fn get_audio_metadata(path: String) -> Result<SongMetadata, String> {
    if path.starts_with("http") {
        let metadata_res = YoutubeManager::get_video_metadata(&path).await;
        let (title, thumbnail, duration, artist) = match metadata_res {
            Ok(m) => {
                let d = {
                    let secs = m.duration.unwrap_or(0.0) as u64;
                    format!("{}:{:02}", secs / 60, secs % 60)
                };
                (m.title.unwrap_or_else(|| "Unknown YouTube Video".into()), m.thumbnail.unwrap_or_default(), d, Some(m.id.unwrap_or_default()))
            },
            Err(_) => ("Unknown YouTube Video".into(), "".into(), "0:00".into(), Some("unknown".into()))
        };

        return Ok(SongMetadata {
            id: None,
            title,
            thumbnail,
            duration,
            source: "youtube".into(),
            path: path.clone(),
            pitch: Some(0.0),
            tempo: Some(1.0),
            volume: Some(80.0),
            artist,
            tags: None,
            genre: None,
            categories: None,
            play_count: Some(0),
            date_added: Some(std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs()),
            is_mr: Some(false),
        });
    }

    let file_path = std::path::Path::new(&path);
    let file_name = file_path.file_name().unwrap_or_default().to_string_lossy().to_string();
    
    let duration_str = match probe_audio_duration(&path) {
        Some(d) => d,
        None => "0:00".into(),
    };

    // --- ID3 Data Extraction ---
    let mut genre = "Unknown".to_string();
    let mut artist_id3 = None;
    let mut title_id3 = None;

    if let Ok(tag) = Tag::read_from_path(&path) {
        if let Some(g) = tag.genre() { genre = g.to_string(); }
        artist_id3 = tag.artist().map(|s| s.to_string());
        title_id3 = tag.title().map(|s| s.to_string());
    }

    // --- DB Update Logic ---
    let db = DB.lock();
    
    // 1. Ensure Genre exists
    db.execute("INSERT OR IGNORE INTO Genres (name) VALUES (?)", params![genre]).map_err(to_sqlite_err)?;
    let genre_id: i64 = db.query_row("SELECT id FROM Genres WHERE name = ?", params![genre], |row: &SqliteRow| row.get::<usize, i64>(0)).map_err(to_sqlite_err)?;

    let final_title = title_id3.unwrap_or(file_name);
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs();

    // 2. Insert/Update Tracks
    db.execute(
        "INSERT INTO Tracks (path, title, thumbnail, duration, source, pitch, tempo, volume, artist, date_added, is_mr, genre_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(path) DO UPDATE SET
            title = excluded.title,
            duration = excluded.duration,
            artist = excluded.artist,
            genre_id = excluded.genre_id",
        params![
            path,
            final_title,
            "",
            duration_str,
            "local",
            0.0,
            1.0,
            80.0,
            artist_id3,
            now,
            0,
            genre_id
        ]
    ).map_err(to_sqlite_err)?;

    let track_id: i64 = db.query_row("SELECT id FROM Tracks WHERE path = ?", params![path], |row: &SqliteRow| row.get::<usize, i64>(0)).map_err(to_sqlite_err)?;

    Ok(SongMetadata {
        id: Some(track_id),
        title: final_title,
        thumbnail: "".into(),
        duration: duration_str,
        source: "local".into(),
        path: path.clone(),
        pitch: Some(0.0),
        tempo: Some(1.0),
        volume: Some(80.0),
        artist: artist_id3,
        tags: None,
        genre: Some(genre),
        categories: None,
        play_count: Some(0),
        date_added: Some(now),
        is_mr: Some(false),
    })
}

#[tauri::command]
async fn add_category(name: String) -> Result<i64, String> {
    let db = DB.lock();
    db.execute("INSERT INTO Categories (name) VALUES (?)", params![name]).map_err(to_sqlite_err)?;
    let id = db.last_insert_rowid();
    Ok(id)
}

#[tauri::command]
async fn delete_category(id: i64) -> Result<(), String> {
    let db = DB.lock();
    db.execute("DELETE FROM Track_Category_Map WHERE category_id = ?", params![id]).map_err(to_sqlite_err)?;
    db.execute("DELETE FROM Categories WHERE id = ?", params![id]).map_err(to_sqlite_err)?;
    Ok(())
}

#[tauri::command]
async fn load_library() -> Result<Vec<SongMetadata>, String> {
    get_songs().await
}

#[tauri::command]
async fn get_songs() -> Result<Vec<SongMetadata>, String> {
    let db = DB.lock();
    let mut stmt = db.prepare(
        "SELECT t.id, t.path, t.title, t.thumbnail, t.duration, t.source, t.pitch, t.tempo, t.volume, t.artist, t.play_count, t.date_added, t.is_mr, g.name as genre,
         (SELECT GROUP_CONCAT(name) FROM Tags JOIN Track_Tag_Map ON Tags.id = Track_Tag_Map.tag_id WHERE Track_Tag_Map.track_id = t.id) as tags,
         (SELECT GROUP_CONCAT(name) FROM Categories JOIN Track_Category_Map ON Categories.id = Track_Category_Map.category_id WHERE Track_Category_Map.track_id = t.id) as categories
         FROM Tracks t
         LEFT JOIN Genres g ON t.genre_id = g.id"
    ).map_err(to_sqlite_err)?;
    
    let song_iter = stmt.query_map([], |row| {
        let tag_str: Option<String> = row.get(14).ok();
        let tags = tag_str.map(|s| s.split(',').map(|t| t.to_string()).collect::<Vec<String>>());
        
        let cat_str: Option<String> = row.get(15).ok();
        let categories = cat_str.map(|s| s.split(',').map(|t| t.to_string()).collect::<Vec<String>>());
        
        Ok(SongMetadata {
            id: row.get(0).ok(),
            path: row.get(1)?,
            title: row.get(2)?,
            thumbnail: row.get::<usize, String>(3).unwrap_or_default(),
            duration: row.get::<usize, String>(4).unwrap_or_default(),
            source: row.get::<usize, String>(5).unwrap_or_default(),
            pitch: row.get(6).ok(),
            tempo: row.get(7).ok(),
            volume: row.get(8).ok(),
            artist: row.get(9).ok(),
            play_count: row.get::<usize, u32>(10).ok(),
            date_added: row.get::<usize, u64>(11).ok(),
            is_mr: Some(row.get::<usize, i64>(12).unwrap_or(0) != 0),
            genre: row.get(13).ok(),
            tags,
            categories,
        })
    }).map_err(to_sqlite_err)?;

    let mut songs = Vec::new();
    for song in song_iter {
        songs.push(song.map_err(to_sqlite_err)?);
    }
    Ok(songs)
}

#[tauri::command]
async fn get_categories() -> Result<Vec<crate::types::Category>, String> {
    let db = DB.lock();
    let mut stmt = db.prepare("SELECT id, name FROM Categories").map_err(to_sqlite_err)?;
    let category_iter = stmt.query_map([], |row| {
        Ok(crate::types::Category {
            id: row.get(0)?,
            name: row.get(1)?,
        })
    }).map_err(to_sqlite_err)?;

    let mut categories = Vec::new();
    for cat in category_iter {
        categories.push(cat.map_err(to_sqlite_err)?);
    }
    Ok(categories)
}

#[tauri::command]
async fn get_genres() -> Result<Vec<crate::types::Genre>, String> {
    let db = DB.lock();
    let mut stmt = db.prepare("SELECT id, name FROM Genres").map_err(to_sqlite_err)?;
    let genre_iter = stmt.query_map([], |row| {
        Ok(crate::types::Genre {
            id: row.get(0)?,
            name: row.get(1)?,
        })
    }).map_err(to_sqlite_err)?;

    let mut genres = Vec::new();
    for g in genre_iter {
        genres.push(g.map_err(to_sqlite_err)?);
    }
    Ok(genres)
}

#[tauri::command]
async fn get_track_categories(track_id: i64) -> Result<Vec<i64>, String> {
    let db = DB.lock();
    let mut stmt = db.prepare("SELECT category_id FROM Track_Category_Map WHERE track_id = ?").map_err(to_sqlite_err)?;
    let id_iter = stmt.query_map(params![track_id], |row| row.get::<usize, i64>(0)).map_err(to_sqlite_err)?;
    
    let mut ids = Vec::new();
    for id in id_iter {
        ids.push(id.map_err(to_sqlite_err)?);
    }
    Ok(ids)
}

#[tauri::command]
async fn map_track_to_categories(track_id: i64, category_ids: Vec<i64>) -> Result<(), String> {
    let mut db = DB.lock();
    let tx = db.transaction().map_err(to_sqlite_err)?;
    tx.execute("DELETE FROM Track_Category_Map WHERE track_id = ?", params![track_id]).map_err(to_sqlite_err)?;
    for cat_id in category_ids {
        tx.execute("INSERT INTO Track_Category_Map (track_id, category_id) VALUES (?, ?)", params![track_id, cat_id]).map_err(to_sqlite_err)?;
    }
    tx.commit().map_err(to_sqlite_err)?;
    Ok(())
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
async fn get_playback_state() -> Result<AppState, String> {
    let handler = match &*AUDIO_HANDLER {
        Ok(h) => h.clone(),
        Err(e) => return Err(e.clone()),
    };
    let state = handler.state.lock().clone();
    Ok(state)
}

#[tauri::command]
async fn check_ai_runtime() -> Result<Vec<String>, String> {
    let mut providers = Vec::new();
    if CUDAExecutionProvider::default().is_available().unwrap_or(false) {
        providers.push("CUDA".to_string());
    }
    if CPUExecutionProvider::default().is_available().unwrap_or(false) {
        providers.push("CPU".to_string());
    }
    Ok(providers)
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GpuStatus {
    pub has_nvidia: bool,
    pub is_cuda_available: bool,
    pub is_directml_available: bool,
    pub recommend_cuda: bool,
}

#[tauri::command]
async fn get_gpu_recommendation() -> Result<GpuStatus, String> {
    let mut has_nvidia = false;
    
    // 1. Detect Hardware (NVIDIA) - Windows implementation
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        let mut cmd = Command::new("wmic");
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW

        if let Ok(output) = cmd
            .args(["path", "win32_VideoController", "get", "name"])
            .output() {
            let stdout = String::from_utf8_lossy(&output.stdout).to_uppercase();
            if stdout.contains("NVIDIA") {
                has_nvidia = true;
            }
            sys_log(&format!("[GPU-CHECK] Detected Hardware Output: {}", stdout.trim()));
        }
    }

    // 2. Check Execution Providers
    let is_cuda_available = CUDAExecutionProvider::default().is_available().unwrap_or(false);
    let is_directml_available = DirectMLExecutionProvider::default().is_available().unwrap_or(false);

    sys_log(&format!("[GPU-CHECK] has_nvidia: {}, cuda_available: {}, directml_available: {}", 
        has_nvidia, is_cuda_available, is_directml_available));

    // 3. Recommendation logic: Only recommend CUDA if DirectML is also unavailable on NVIDIA hardware
    let recommend_cuda = has_nvidia && !is_cuda_available && !is_directml_available;
    
    if recommend_cuda {
        sys_log("[GPU-CHECK] RESULT: RECOMMENDATION BANNER SHOULD BE VISIBLE.");
    } else {
        sys_log("[GPU-CHECK] RESULT: BANNER HIDDEN (Either no NVIDIA or CUDA is already OK).");
    }

    Ok(GpuStatus {
        has_nvidia,
        is_cuda_available,
        is_directml_available,
        recommend_cuda,
    })
}

#[tauri::command]
async fn check_model_ready(handle: AppHandle) -> bool {
    let manager = ModelManager::new(&handle);
    manager.get_model_path("Kim_Vocal_2.onnx").exists()
}

#[tauri::command]
async fn download_ai_model(window: WebviewWindow) -> Result<(), String> {
    let app_handle = window.app_handle();
    let manager = ModelManager::new(app_handle);
    window.emit("playback-status", PlaybackStatus { status: Status::Downloading, message: "AI 모델 다운로드 시작...".into() }).unwrap();
    let model_url = "https://huggingface.co/seanghay/uvr_models/resolve/main/Kim_Vocal_2.onnx";
    let _model_path = manager.ensure_model(app_handle, "Kim_Vocal_2.onnx", model_url).await?;
    window.emit("playback-status", PlaybackStatus { status: Status::Finished, message: "AI 모델 다운로드 완료".into() }).unwrap();
    Ok(())
}

#[tauri::command]
async fn delete_ai_model(window: WebviewWindow) -> Result<(), String> {
    let app_handle = window.app_handle();
    let manager = ModelManager::new(app_handle);
    let path = manager.get_model_path("Kim_Vocal_2.onnx");
    
    if path.exists() {
        std::fs::remove_file(path).map_err(|e| format!("모델 파일 삭제 실패: {}", e))?;
        
        // Reset loaded engine
        let mut engine_guard = crate::separation::ROFORMER_ENGINE.lock();
        *engine_guard = None;
        
        sys_log("[AI-ENGINE] Model deleted and engine reset.");
    }
    Ok(())
}

#[tauri::command]
fn get_app_paths(handle: AppHandle) -> crate::state::AppPaths {
    handle.state::<crate::state::AppPaths>().inner().clone()
}

#[tauri::command]
async fn get_audio_devices() -> Result<Vec<String>, String> {
    let host = cpal::default_host();
    let devices = host.output_devices().map_err(|e| e.to_string())?;
    let mut names = Vec::new();
    for d in devices {
        if let Ok(desc) = d.description() {
            let config = d.default_output_config()
                .map(|c| format!("{}Hz, {}ch", u32::from(c.sample_rate()), c.channels()))
                .unwrap_or_else(|_| "Unknown Config".into());
            names.push(format!("{} ({})", desc.name(), config));
        }
    }
    Ok(names)
}

#[tauri::command]
async fn open_cache_folder(window: WebviewWindow) -> Result<(), String> {
    let paths = window.state::<crate::state::AppPaths>();
    let path = paths.separated.clone();
    if !path.exists() {
        std::fs::create_dir_all(&path).map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "windows")]
    {
        use std::process::Command;
        use std::os::windows::process::CommandExt;
        Command::new("explorer")
            .arg(path.to_string_lossy().to_string())
            .creation_flags(0x08000000) // CREATE_NO_WINDOW
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
async fn start_mr_separation(window: tauri::WebviewWindow, path: String) -> Result<(), String> {
    // 1. Quick check for existing task to prevent duplicates before spawning
    let norm_p = path.replace("\\", "/").to_lowercase();
    {
        let active = crate::separation::ACTIVE_SEPARATIONS.lock();
        if active.contains_key(&norm_p) {
            sys_log(&format!("[AI-QUEUE] Task already active or queued for: {}", path));
            return Err("ALREADY_PROCESSING".into()); 
        }
    }

    let app_dir = window.app_handle().path().app_local_data_dir().expect("Failed app dir");
    let cache_key = urlencoding::encode(&path).to_string();
    let cache_dir = app_dir.join("cache").join("separated").join(&cache_key);

    let task = crate::separation::task::SeparationTask::new(window, path, cache_dir);
    tauri::async_runtime::spawn(async move {
        task.run().await;
    });
    Ok(())
}


#[tauri::command]
fn cancel_separation(path: String) -> Result<(), String> {
    let mut active = crate::separation::ACTIVE_SEPARATIONS.lock();
    let normalized_path = path.replace("\\", "/").to_lowercase();
    if let Some(cancel_flag) = active.remove(&normalized_path) {
        cancel_flag.store(true, std::sync::atomic::Ordering::Relaxed);
        sys_log(&format!("CANCEL: AI Separation for {} has been requested.", path));
    }
    Ok(())
}

#[tauri::command]
async fn delete_song(path: String) -> Result<(), String> {
    let db = DB.lock();
    db.execute("DELETE FROM Tracks WHERE path = ?", params![path]).map_err(to_sqlite_err)?;
    sys_log(&format!("[DB] Song deleted from library: {}", path));
    Ok(())
}

#[tauri::command]
fn save_library(_app: AppHandle, songs: Vec<SongMetadata>) -> Result<(), String> {
    let mut db = DB.lock();
    let tx = db.transaction().map_err(to_sqlite_err)?;
    
    // 1. Sync Deletions: Remove tracks that are not in the current 'songs' list
    {
        let mut stmt = tx.prepare("SELECT path FROM Tracks").map_err(to_sqlite_err)?;
        let db_paths: Vec<String> = stmt.query_map([], |row| row.get::<usize, String>(0)).map_err(to_sqlite_err)?
            .filter_map(|r| r.ok()).collect();
        
        let input_paths: HashSet<String> = songs.iter().map(|s| s.path.clone()).collect();
        for path in db_paths {
            if !input_paths.contains(&path) {
                tx.execute("DELETE FROM Tracks WHERE path = ?", params![path]).ok();
            }
        }
    }

    // 2. Insert/Update existing tracks
    for song in songs {
        let genre_id: Option<i64> = if let Some(cat_name) = &song.genre {
            tx.execute("INSERT OR IGNORE INTO Genres (name) VALUES (?)", params![cat_name]).ok();
            tx.query_row("SELECT id FROM Genres WHERE name = ?", params![cat_name], |row| row.get::<usize, i64>(0)).ok()
        } else {
            None
        };

        tx.execute(
            "INSERT OR REPLACE INTO Tracks (path, title, thumbnail, duration, source, pitch, tempo, volume, artist, play_count, date_added, is_mr, genre_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            params![
                song.path,
                song.title,
                song.thumbnail,
                song.duration,
                song.source,
                song.pitch.unwrap_or(0.0),
                song.tempo.unwrap_or(1.0),
                song.volume.unwrap_or(80.0),
                song.artist,
                song.play_count.unwrap_or(0),
                song.date_added,
                if song.is_mr.unwrap_or(false) { 1 } else { 0 },
                genre_id
            ]
        ).ok();

        // 3. Update Tags
        if let Some(tags) = &song.tags {
            let track_id: Option<i64> = tx.query_row("SELECT id FROM Tracks WHERE path = ?", params![song.path], |row| row.get(0)).ok();
            if let Some(tid) = track_id {
                tx.execute("DELETE FROM Track_Tag_Map WHERE track_id = ?", params![tid]).ok();
                for tag in tags {
                    tx.execute("INSERT OR IGNORE INTO Tags (name) VALUES (?)", params![tag]).ok();
                    let tag_id: Option<i64> = tx.query_row("SELECT id FROM Tags WHERE name = ?", params![tag], |row| row.get(0)).ok();
                    if let Some(tgid) = tag_id {
                        tx.execute("INSERT OR IGNORE INTO Track_Tag_Map (track_id, tag_id) VALUES (?, ?)", params![tid, tgid]).ok();
                    }
                }
            }
        }

        // 4. Update Categories
        if let Some(cats) = &song.categories {
            let track_id: Option<i64> = tx.query_row("SELECT id FROM Tracks WHERE path = ?", params![song.path], |row| row.get(0)).ok();
            if let Some(tid) = track_id {
                tx.execute("DELETE FROM Track_Category_Map WHERE track_id = ?", params![tid]).ok();
                for cat in cats {
                    tx.execute("INSERT OR IGNORE INTO Categories (name) VALUES (?)", params![cat]).ok();
                    let cat_id: Option<i64> = tx.query_row("SELECT id FROM Categories WHERE name = ?", params![cat], |row| row.get(0)).ok();
                    if let Some(cid) = cat_id {
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
async fn get_track_count() -> Result<i64, String> {
    let db = DB.lock();
    let count: i64 = db.query_row("SELECT count(*) FROM Tracks", [], |row| row.get(0)).map_err(to_sqlite_err)?;
    Ok(count)
}


fn probe_audio_duration(path: &str) -> Option<String> {
    let file = File::open(path).ok()?;
    let mss = MediaSourceStream::new(Box::new(file), Default::default());
    let mut hint = Hint::new();
    if path.to_lowercase().ends_with(".mp3") { hint.with_extension("mp3"); }

    let format_opts = FormatOptions { enable_gapless: true, ..Default::default() };
    let meta_opts = MetadataOptions::default();

    let probed = symphonia::default::get_probe().format(&hint, mss, &format_opts, &meta_opts).ok()?;
    let format = probed.format;

    // Try default track first
    let track = format.default_track().or_else(|| format.tracks().first())?;
    let params = &track.codec_params;

    if let Some(n_frames) = params.n_frames {
        if let Some(rate) = params.sample_rate {
            let total_secs = n_frames / (rate as u64);
            return Some(format!("{}:{:02}", total_secs / 60, total_secs % 60));
        }
    }

    // Fallback: Check metadata for duration tags or rodio decoder if n_frames is missing
    // Sometimes MP3 duration is found in metadata tags (TLEN etc)
    // Here we'll try rodio as secondary fallback
    let f2 = File::open(path).ok()?;
        if let Ok(decoder) = Decoder::new(BufReader::new(f2)) {
            let opt_d: Option<Duration> = decoder.total_duration();
            if let Some(d) = opt_d {
                let s = d.as_secs();
                return Some(format!("{}:{:02}", s / 60, s % 60));
            }
        }

    None
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Limit Rayon global thread pool to half of logical cores (min 2, max 8)
    // This prevents Rayon from starving the UI/Main thread during heavy STFT/Post-processing.
    let num_threads = (num_cpus::get() / 2).max(2).min(8);
    let _ = rayon::ThreadPoolBuilder::new()
        .num_threads(num_threads)
        .build_global();
    sys_log(&format!("[SYSTEM] Rayon global thread pool initialized with {} threads", num_threads));

    tauri::Builder::default()
        .setup(|app| {
            // 1. Initialize Global AppPaths
            let app_paths = crate::state::AppPaths::from_handle(app.handle());
            *crate::state::APP_PATHS.lock() = Some(app_paths.clone());
            app.manage(app_paths);

            // 2. Pre-initialize DB with correct paths
            let _ = &*crate::state::DB;
            sys_log("[SYSTEM] Global AppPaths and DB initialized.");

            let window = app.get_webview_window("main");
            if let Some(w) = window {
                *crate::state::MAIN_WINDOW.lock() = Some(w.clone());
                
                let w_clone = w.clone();
                std::thread::spawn(move || {
                    loop {
                        std::thread::sleep(Duration::from_millis(200));
                        if let Ok(handler) = &*AUDIO_HANDLER {
                            let (samples, duration_ms, rate, track_rate, is_empty) = {
                                let controller = handler.controller.lock();
                                (
                                    handler.current_pos_samples.load(Ordering::Relaxed),
                                    handler.total_duration_ms.load(Ordering::Relaxed),
                                    handler.active_sample_rate,
                                    handler.track_sample_rate.load(Ordering::Relaxed),
                                    controller.empty()
                                )
                            };

                            let pos_ms = if track_rate > 0 { (samples as f64 / track_rate as f64 * 1000.0) as u64 } else { 0 };

                            // Detection of finished playback: sink is empty OR time exceeded duration (safety fallback for FLAC/VBR)
                            let is_finished_fallback = duration_ms > 0 && pos_ms >= duration_ms + 1000;
                            
                            // CRITICAL: Verify if we are currently in the middle of a seek/re-init
                            let is_locked_for_init = crate::audio_player::IS_PREPARING_PLAYBACK.load(Ordering::SeqCst);

                            if (is_empty || is_finished_fallback) && duration_ms > 0 && !is_locked_for_init {
                                let mut state = handler.state.lock();
                                if state.is_playing {
                                    state.is_playing = false;
                                    
                                    // Ensure sink is cleared to stop trailing audio
                                    handler.controller.lock().clear();
                                    
                                    // Reset position samples when finished
                                    handler.current_pos_samples.store(0, Ordering::Relaxed);
                                    
                                    let _ = w_clone.emit("playback-status", PlaybackStatus { 
                                        status: Status::Finished, 
                                        message: "Finished".into() 
                                    });
                                }
                            }

                            if rate > 0 {
                                // If already finished, emit 0ms to reset UI time
                                let is_really_finished = is_empty || is_finished_fallback;
                                let pos_to_emit_ms = if is_really_finished { 0 } else { pos_ms };
                                
                                let _ = w_clone.emit("playback-progress", PlaybackProgress {
                                    position_ms: pos_to_emit_ms,
                                    duration_ms,
                                });
                            }
                        }
                    }
                });
            }
            Ok(())
        })
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            play_track,
            toggle_playback,
            stop_playback,
            seek_to,
            set_pitch,
            set_tempo,
            set_volume,
            set_master_volume,
            set_vocal_balance,
            toggle_ai_feature,
            check_mr_separated,
            delete_mr,
            start_mr_separation,
            get_youtube_metadata,
            get_audio_metadata,
            get_playback_state,
            check_ai_runtime,
            check_model_ready,
            download_ai_model,
            save_library,
            load_library,
            get_songs,
            get_categories,
            get_genres,
            get_track_categories,
            get_track_count,
            cancel_separation,
            get_audio_devices,
            open_cache_folder,
            delete_ai_model,
            get_gpu_recommendation,
            add_category,
            delete_category,
            delete_song,
            map_track_to_categories,
            get_app_paths
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}


