use once_cell::sync::Lazy;
use parking_lot::Mutex;
use std::sync::Arc;
use tauri::{WebviewWindow, Manager};
use rusqlite::{params, Connection, Row as SqliteRow};
use std::path::PathBuf;
use std::fs;

use crate::vocal_remover::WaveformRemover;
use crate::audio_player::sys_log;
use crate::types::SongMetadata;

// --- App Paths Management ---
#[derive(Debug, Clone, serde::Serialize)]
pub struct AppPaths {
    pub root: PathBuf,
    pub models: PathBuf,
    pub cache: PathBuf,
    pub separated: PathBuf,
    pub temp: PathBuf,
    pub db: PathBuf,
}

impl AppPaths {
    pub fn from_handle(handle: &tauri::AppHandle) -> Self {
        let root = handle.path().app_local_data_dir().expect("Failed to get app data dir");
        let models = root.join("models");
        let cache = root.join("cache");
        let separated = cache.join("separated");
        let temp = root.join("temp");
        let db = root.join("library.db");

        // Ensure directories exist
        let _ = fs::create_dir_all(&models);
        let _ = fs::create_dir_all(&separated);
        let _ = fs::create_dir_all(&temp);

        Self { root, models, cache, separated, temp, db }
    }
}

pub static APP_PATHS: Lazy<Mutex<Option<AppPaths>>> = Lazy::new(|| Mutex::new(None));

// --- Global State ---

pub static MAIN_WINDOW: Lazy<Mutex<Option<WebviewWindow>>> = Lazy::new(|| Mutex::new(None));
pub static ROFORMER_ENGINE: Lazy<Arc<Mutex<Option<WaveformRemover>>>> = Lazy::new(|| Arc::new(Mutex::new(None)));
pub static DB: Lazy<Arc<Mutex<Connection>>> = Lazy::new(|| {
    // Determine app data directory using AppPaths if available, otherwise fallback
    let paths_guard = APP_PATHS.lock();
    let app_dir = if let Some(paths) = paths_guard.as_ref() {
        paths.root.clone()
    } else {
        drop(paths_guard);
        if let Some(window) = MAIN_WINDOW.lock().as_ref() {
            window.app_handle().path().app_local_data_dir().expect("Failed to get app data dir")
        } else {
            let mut path = std::env::var("LOCALAPPDATA") // Use Local instead of Roaming
                .map(PathBuf::from)
                .unwrap_or_else(|_| {
                    std::env::var("APPDATA")
                        .map(PathBuf::from)
                        .unwrap_or_else(|_| PathBuf::from("data"))
                });
            path.push("com.autumncolor77.live-mr-manager");
            path
        }
    };
    
    if !app_dir.exists() {
        fs::create_dir_all(&app_dir).expect("Failed to create app data dir");
    }
    
    let db_path = app_dir.join("library.db");
    sys_log(&format!("[DB] Connecting to: {:?}", db_path));
    
    let mut conn = Connection::open(db_path).expect("Failed to open database");
    conn.execute("PRAGMA foreign_keys = ON", []).ok();
    init_db(&mut conn, &app_dir);
    
    Arc::new(Mutex::new(conn))
});

fn init_db(conn: &mut Connection, app_dir: &PathBuf) {
    // 1. Rename existing Category table to Genres if it exists
    let table_exists: bool = conn.query_row(
        "SELECT count(*) FROM sqlite_master WHERE type='table' AND name='Category'",
        [],
        |row: &SqliteRow| row.get::<usize, i64>(0),
    ).unwrap_or(0) > 0;

    if table_exists {
        sys_log("[DB] Migrating old Category table to Genres...");
        conn.execute("ALTER TABLE Category RENAME TO Genres_Old", []).ok();
        conn.execute("CREATE TABLE IF NOT EXISTS Genres (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE NOT NULL)", []).ok();
        conn.execute("INSERT OR IGNORE INTO Genres (name) SELECT name FROM Genres_Old", []).ok();
        conn.execute("DROP TABLE Genres_Old", []).ok();
    }

    // 2. Create tables
    conn.execute_batch(
        "BEGIN;
         CREATE TABLE IF NOT EXISTS Genres (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT UNIQUE NOT NULL
         );
         CREATE TABLE IF NOT EXISTS Categories (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT UNIQUE NOT NULL
         );
         CREATE TABLE IF NOT EXISTS Tracks (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            path TEXT UNIQUE NOT NULL,
            title TEXT NOT NULL,
            thumbnail TEXT,
            duration TEXT,
            source TEXT,
            pitch REAL,
            tempo REAL,
            volume REAL,
            artist TEXT,
            play_count INTEGER DEFAULT 0,
            date_added INTEGER,
            is_mr INTEGER DEFAULT 0,
            genre_id INTEGER,
            FOREIGN KEY(genre_id) REFERENCES Genres(id)
         );
         CREATE TABLE IF NOT EXISTS Track_Category_Map (
            track_id INTEGER,
            category_id INTEGER,
            PRIMARY KEY(track_id, category_id),
            FOREIGN KEY(track_id) REFERENCES Tracks(id) ON DELETE CASCADE,
            FOREIGN KEY(category_id) REFERENCES Categories(id) ON DELETE CASCADE
         );
         CREATE TABLE IF NOT EXISTS Tags (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT UNIQUE NOT NULL
         );
         CREATE TABLE IF NOT EXISTS Track_Tag_Map (
            track_id INTEGER,
            tag_id INTEGER,
            PRIMARY KEY(track_id, tag_id),
            FOREIGN KEY(track_id) REFERENCES Tracks(id) ON DELETE CASCADE,
            FOREIGN KEY(tag_id) REFERENCES Tags(id) ON DELETE CASCADE
         );
         COMMIT;"
    ).expect("Failed to create tables");

    // 2.1. Check if Tracks has old 'category' column and needs migration to 'genre_id'
    let columns: Vec<String> = {
        let mut stmt = conn.prepare("PRAGMA table_info(Tracks)").unwrap();
        let col_iter = stmt.query_map([], |row| row.get::<usize, String>(1)).unwrap();
        col_iter.map(|r| r.unwrap()).collect()
    };

    if columns.contains(&"category".to_string()) && !columns.contains(&"genre_id".to_string()) {
        sys_log("[DB] Found old 'category' column in Tracks. Migrating to 'genre_id'...");
        
        // 1. Ensure all categories exist in Genres table
        let _ = conn.execute("INSERT OR IGNORE INTO Genres (name) SELECT DISTINCT category FROM Tracks WHERE category IS NOT NULL", []);
        
        // 2. Temporarily rename Tracks
        let _ = conn.execute("ALTER TABLE Tracks RENAME TO Tracks_Old", []);
        
        // 3. Recreate Tracks with NEW schema
        conn.execute(
            "CREATE TABLE Tracks (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                path TEXT UNIQUE NOT NULL,
                title TEXT NOT NULL,
                thumbnail TEXT,
                duration TEXT,
                source TEXT,
                pitch REAL,
                tempo REAL,
                volume REAL,
                artist TEXT,
                play_count INTEGER DEFAULT 0,
                date_added INTEGER,
                is_mr INTEGER DEFAULT 0,
                genre_id INTEGER,
                FOREIGN KEY(genre_id) REFERENCES Genres(id)
            )",
            []
        ).unwrap();
        
        // 4. Fill with old data, joining with Genres to get ID
        conn.execute(
            "INSERT INTO Tracks (path, title, thumbnail, duration, source, pitch, tempo, volume, artist, play_count, date_added, is_mr, genre_id)
             SELECT t.path, t.title, t.thumbnail, t.duration, t.source, t.pitch, t.tempo, t.volume, t.artist, t.play_count, t.date_added, t.is_mr, g.id
             FROM Tracks_Old t
             LEFT JOIN Genres g ON t.category = g.name",
            []
        ).unwrap();
        
        // 5. Drop old table
        let _ = conn.execute("DROP TABLE Tracks_Old", []);
        sys_log("[DB] Tracks table migration completed.");
    } else if !columns.contains(&"genre_id".to_string()) {
        // Fallback: Just add genre_id if it's missing (though usually handled above)
        let _ = conn.execute("ALTER TABLE Tracks ADD COLUMN genre_id INTEGER", []);
    }

    // 3. One-time migration from library.json if exists
    let json_path = app_dir.join("library.json");
    if json_path.exists() {
        let track_count: i64 = conn.query_row("SELECT count(*) FROM Tracks", [], |row: &SqliteRow| row.get::<usize, i64>(0)).unwrap_or(0);
        if track_count == 0 {
            sys_log("[DB] Starting one-time migration from library.json...");
            if let Ok(json_data) = fs::read_to_string(&json_path) {
                if let Ok(songs) = serde_json::from_str::<Vec<SongMetadata>>(&json_data) {
                    let tx = conn.transaction().expect("Failed to start transaction");
                    for song in songs {
                        let genre_id: Option<i64> = if let Some(cat_name) = &song.genre {
                            tx.execute("INSERT OR IGNORE INTO Genres (name) VALUES (?)", params![cat_name]).ok();
                            tx.query_row("SELECT id FROM Genres WHERE name = ?", params![cat_name], |row: &SqliteRow| row.get::<usize, i64>(0)).ok()
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

                        // Migrate Tags
                        if let Some(tags) = &song.tags {
                            let track_id: Option<i64> = tx.query_row("SELECT id FROM Tracks WHERE path = ?", params![song.path], |row| row.get(0)).ok();
                            if let Some(tid) = track_id {
                                for tag in tags {
                                    tx.execute("INSERT OR IGNORE INTO Tags (name) VALUES (?)", params![tag]).ok();
                                    let tag_id: Option<i64> = tx.query_row("SELECT id FROM Tags WHERE name = ?", params![tag], |row| row.get(0)).ok();
                                    if let Some(tgid) = tag_id {
                                        tx.execute("INSERT OR IGNORE INTO Track_Tag_Map (track_id, tag_id) VALUES (?, ?)", params![tid, tgid]).ok();
                                    }
                                }
                            }
                        }
                    }
                    tx.commit().expect("Failed to commit migration");
                    sys_log("[DB] Migration from library.json completed.");
                }
            }
        }
    }
}
// AUDIO_HANDLER initialized in audio_player.rs


// --- Data structures moved to types.rs ---
