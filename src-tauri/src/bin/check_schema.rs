use rusqlite::{params, Connection};
use std::path::PathBuf;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut path = std::env::var("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|_| {
            std::env::var("APPDATA").map(PathBuf::from).unwrap_or_else(|_| PathBuf::from("data"))
        });
    path.push("com.boohu.tauri-app");
    let db_path = path.join("library.db");

    println!("Checking DB at: {:?}", db_path);
    let conn = Connection::open(db_path)?;

    println!("\n--- Tables ---");
    let mut stmt = conn.prepare("PRAGMA table_info(Tracks)")?;
    let cols = stmt.query_map(params![], |row| Ok(row.get::<usize, String>(1)?))?;
    for t in cols {
        println!("Column: {}", t?);
    }

    println!("\n--- Sample Tracks (first 10) ---");
    let mut stmt = conn.prepare("
        SELECT t.title, g.name, 
        (SELECT GROUP_CONCAT(name) FROM Tags JOIN Track_Tag_Map ON Tags.id = Track_Tag_Map.tag_id WHERE Track_Tag_Map.track_id = t.id)
        FROM Tracks t 
        LEFT JOIN Genres g ON t.genre_id = g.id 
        LIMIT 10
    ")?;
    let samples = stmt.query_map(params![], |row| Ok((row.get::<usize, String>(0)?, row.get::<usize, Option<String>>(1)?, row.get::<usize, Option<String>>(2)?)))?;
    for s in samples {
        let (title, genre, tags) = s?;
        println!("Title: {} | Genre: {:?} | Tags: {:?}", title, genre, tags);
    }

    Ok(())
}
