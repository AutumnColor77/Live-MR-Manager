use tauri::AppHandle;
use std::fs::File;
use std::io::BufReader;
use id3::{Tag, TagLike};
use rusqlite::{params, Error as SqliteError};
use symphonia::core::io::MediaSourceStream;
use symphonia::core::probe::Hint;
use rodio::Source;
use crate::state::DB;
use crate::types::SongMetadata;

pub fn to_sqlite_err(e: SqliteError) -> String {
    e.to_string()
}

pub fn probe_audio_duration(path: &str) -> Option<String> {
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

#[tauri::command]
pub async fn update_song_metadata(song: SongMetadata) -> Result<(), String> {
    save_library_internal(vec![song]).await
}

#[tauri::command]
pub async fn get_audio_metadata(path: String) -> Result<SongMetadata, String> {
    // 1. Fetch metadata (YouTube or Local)
    let mut metadata = if path.starts_with("http") {
        crate::model_commands::youtube_metadata_fetcher(path.clone()).await?
    } else {
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

        SongMetadata {
            id: None, title: final_title, thumbnail: "".into(), duration: duration_str,
            source: "local".into(), path: path.clone(), pitch: Some(0.0), tempo: Some(1.0), volume: Some(100.0),
            artist: artist_id3, tags: None, genre: Some(genre), categories: None, play_count: Some(0),
            date_added: Some(now), is_mr: Some(false), is_separated: Some(false),
            has_lyrics: Some(false),
            original_title: None, translated_title: None, curation_category: None,
        }
    };

    // 2. Save to DB (Persist fetched metadata)
    save_library_internal(vec![metadata.clone()]).await?;
    
    // 3. Retrieve ID
    let db = DB.lock();
    if let Ok(id) = db.query_row("SELECT id FROM Tracks WHERE path = ?", params![path], |row| row.get(0)) {
        metadata.id = Some(id);
    }

    Ok(metadata)
}

pub async fn get_songs_internal(paths: crate::state::AppPaths) -> Result<Vec<SongMetadata>, String> {
    let db = DB.lock();
    let mut stmt = db.prepare(
        "SELECT t.id, t.path, t.title, t.thumbnail, t.duration, t.source, t.pitch, t.tempo, t.volume, t.artist, t.play_count, t.date_added, t.is_mr, g.name as genre,
         (SELECT GROUP_CONCAT(name) FROM Tags JOIN Track_Tag_Map ON Tags.id = Track_Tag_Map.tag_id WHERE Track_Tag_Map.track_id = t.id) as tags,
         (SELECT GROUP_CONCAT(name) FROM Categories JOIN Track_Category_Map ON Categories.id = Track_Category_Map.category_id WHERE Track_Category_Map.track_id = t.id) as categories,
         t.original_title, t.translated_title, t.curation_category
         FROM Tracks t LEFT JOIN Genres g ON t.genre_id = g.id"
    ).map_err(to_sqlite_err)?;
    
    let song_iter = stmt.query_map([], |row| {
        let raw_genre = row.get::<_, Option<String>>(13).ok().flatten();
        let raw_tags: Option<Vec<String>> = row.get::<_, Option<String>>(14).ok().flatten()
            .map(|s| s.split(',').map(|t| t.to_string()).collect());
        
        let (genre, tags, auto_category) = crate::metadata_fetcher::translate_metadata(raw_genre, raw_tags);
        
        let mut categories: Option<Vec<String>> = row.get::<_, Option<String>>(15).ok().flatten()
            .map(|s| s.split(',').map(|t| t.to_string()).collect());
        
        if categories.is_none() || categories.as_ref().unwrap().is_empty() {
            if let Some(ac) = auto_category {
                categories = Some(vec![ac]);
            }
        }
        
        let norm = row.get::<_, String>(1).unwrap_or_default().replace("\\", "/").to_lowercase();
        let cache_dir = paths.separated.join(urlencoding::encode(&norm).to_string());
        let is_separated = cache_dir.join("vocal.wav").exists() && cache_dir.join("inst.wav").exists();
        
        // Check for .lrc file in the same folder
        let track_path = row.get::<_, String>(1).unwrap_or_default();
        let lrc_path = std::path::Path::new(&track_path).with_extension("lrc");
        let has_lyrics = lrc_path.exists();

        Ok(SongMetadata {
            id: row.get(0).ok(), path: row.get(1)?, title: row.get(2)?, thumbnail: row.get::<_, String>(3).unwrap_or_default(),
            duration: row.get::<_, String>(4).unwrap_or_default(), source: row.get::<_, String>(5).unwrap_or_default(),
            pitch: row.get(6).ok(), tempo: row.get(7).ok(), volume: row.get(8).ok(), artist: row.get(9).ok(),
            play_count: row.get::<_, u32>(10).ok(), date_added: row.get::<_, u64>(11).ok(),
            is_mr: Some(row.get::<_, i64>(12).unwrap_or(0) != 0), genre, tags, categories,
            is_separated: Some(is_separated),
            has_lyrics: Some(has_lyrics),
            original_title: row.get(16).ok(),
            translated_title: row.get(17).ok(),
            curation_category: row.get(18).ok(),
        })
    }).map_err(to_sqlite_err)?;

    let mut songs = Vec::new();
    for song in song_iter { songs.push(song.map_err(to_sqlite_err)?); }
    Ok(songs)
}

#[tauri::command]
pub async fn get_songs(paths: tauri::State<'_, crate::state::AppPaths>) -> Result<Vec<SongMetadata>, String> {
    get_songs_internal(paths.inner().clone()).await
}

#[tauri::command]
pub async fn load_library(paths: tauri::State<'_, crate::state::AppPaths>) -> Result<Vec<SongMetadata>, String> { 
    match get_songs_internal(paths.inner().clone()).await {
        Ok(songs) => Ok(songs),
        Err(e) => {
            let _ = crate::audio_player::sys_log(&format!("[Command] [Error] load_library failed: {}", e));
            Err(e)
        }
    }
}

#[tauri::command]
pub async fn get_categories() -> Result<Vec<crate::types::Category>, String> {
    let db = DB.lock();
    let mut stmt = db.prepare("SELECT id, name FROM Categories").map_err(to_sqlite_err)?;
    let iter = stmt.query_map([], |row| Ok(crate::types::Category { id: row.get(0)?, name: row.get(1)? })).map_err(to_sqlite_err)?;
    let mut res = Vec::new();
    for i in iter { res.push(i.map_err(to_sqlite_err)?); }
    Ok(res)
}

#[tauri::command]
pub async fn get_genres() -> Result<Vec<crate::types::Genre>, String> {
    let db = DB.lock();
    let mut stmt = db.prepare("SELECT id, name FROM Genres").map_err(to_sqlite_err)?;
    let iter = stmt.query_map([], |row| Ok(crate::types::Genre { id: row.get(0)?, name: row.get(1)? })).map_err(to_sqlite_err)?;
    let mut res = Vec::new();
    for i in iter { res.push(i.map_err(to_sqlite_err)?); }
    Ok(res)
}

#[tauri::command]
pub async fn add_category(name: String) -> Result<i64, String> {
    let db = DB.lock();
    db.execute("INSERT INTO Categories (name) VALUES (?)", params![name]).map_err(to_sqlite_err)?;
    Ok(db.last_insert_rowid())
}

#[tauri::command]
pub async fn delete_category(id: i64) -> Result<(), String> {
    let db = DB.lock();
    db.execute("DELETE FROM Track_Category_Map WHERE category_id = ?", params![id]).ok();
    db.execute("DELETE FROM Categories WHERE id = ?", params![id]).map_err(to_sqlite_err)?;
    Ok(())
}

#[tauri::command]
pub async fn map_track_to_categories(track_id: i64, category_ids: Vec<i64>) -> Result<(), String> {
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
pub async fn delete_song(path: String) -> Result<(), String> {
    let db = DB.lock();
    db.execute("DELETE FROM Tracks WHERE path = ?", params![path]).map_err(|e| {
        let _ = crate::audio_player::sys_log(&format!("[Command] [Error] delete_song failed: {}", e));
        to_sqlite_err(e)
    })?;
    Ok(())
}

pub async fn save_library_internal(songs: Vec<SongMetadata>) -> Result<(), String> {
    let mut db = DB.lock();
    let tx = db.transaction().map_err(to_sqlite_err)?;
    
    for song in songs {
        let genre_id: Option<i64> = if let Some(g) = &song.genre {
            tx.execute("INSERT OR IGNORE INTO Genres (name) VALUES (?)", params![g]).ok();
            tx.query_row("SELECT id FROM Genres WHERE name = ?", params![g], |row| row.get(0)).ok()
        } else { None };

        tx.execute(
            "INSERT OR REPLACE INTO Tracks (path, title, thumbnail, duration, source, pitch, tempo, volume, artist, play_count, date_added, is_mr, genre_id, original_title, translated_title, curation_category)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            params![song.path, song.title, song.thumbnail, song.duration, song.source, song.pitch.unwrap_or(0.0), song.tempo.unwrap_or(1.0),
                    song.volume.unwrap_or(100.0), song.artist, song.play_count.unwrap_or(0), song.date_added, if song.is_mr.unwrap_or(false) { 1 } else { 0 }, 
                    genre_id, song.original_title, song.translated_title, song.curation_category]
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
pub async fn save_library(_app: AppHandle, songs: Vec<SongMetadata>) -> Result<(), String> {
    match save_library_internal(songs).await {
        Ok(_) => Ok(()),
        Err(e) => {
            let _ = crate::audio_player::sys_log(&format!("[Command] [Error] save_library failed: {}", e));
            Err(e)
        }
    }
}

#[tauri::command]
pub async fn get_track_count() -> Result<i64, String> {
    let db = DB.lock();
    db.query_row("SELECT count(*) FROM Tracks", [], |row| row.get(0)).map_err(to_sqlite_err)
}

pub fn update_track_duration(path: &str, duration: &str) -> Result<(), String> {
    let db = DB.lock();
    db.execute("UPDATE Tracks SET duration = ? WHERE path = ?", params![duration, path]).map_err(to_sqlite_err)?;
    Ok(())
}

