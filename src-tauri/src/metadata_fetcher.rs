use once_cell::sync::Lazy;
use parking_lot::RwLock;
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::Arc;
use tauri::{AppHandle, Manager};

// --- Data Types ---

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TrackResult {
    pub name: String,
    pub artist: String,
    pub genre: String,
    pub tags: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProcessedMetadata {
    pub genre: String,
    pub tags: Vec<String>,
}

#[derive(Debug, Clone)]
struct GenreEntity {
    id: String,
    name: String,
    depth: i32,
    priority: i32,
    parent_id: Option<String>,
}

struct AppContext {
    genre_map: HashMap<String, String>,         // raw -> id
    genre_master: HashMap<String, GenreEntity>, // id -> entity
    tag_map: HashMap<String, String>,           // raw -> id
    tag_master: HashMap<String, String>,        // id -> name
    exclusions: Vec<Regex>,
}

static UNKNOWN_TAGS: Lazy<Arc<RwLock<HashMap<String, usize>>>> = Lazy::new(|| Arc::new(RwLock::new(HashMap::new())));
static CONTEXT: Lazy<Arc<RwLock<Option<AppContext>>>> = Lazy::new(|| Arc::new(RwLock::new(None)));

fn load_context(app: &AppHandle) -> AppContext {
    let seed_content = include_str!("seed_tags.json");
    let mut seed: Value = serde_json::from_str(seed_content).expect("Failed to parse seed_tags.json");

    // Try to load custom_tags.json from app data dir
    let app_dir = app.path().app_data_dir().unwrap_or_else(|_| PathBuf::from("."));
    let custom_path = app_dir.join("metadata_custom.json");
    
    if custom_path.exists() {
        if let Ok(custom_content) = std::fs::read_to_string(&custom_path) {
            if let Ok(custom_val) = serde_json::from_str::<Value>(&custom_content) {
                // Merge logic: Simple append for now
                if let Some(custom_genres) = custom_val["genres"].as_array() {
                    if let Some(base_genres) = seed["genres"].as_array_mut() {
                        base_genres.extend(custom_genres.clone());
                    }
                }
                if let Some(custom_tags) = custom_val["tags"].as_array() {
                    if let Some(base_tags) = seed["tags"].as_array_mut() {
                        base_tags.extend(custom_tags.clone());
                    }
                }
                if let Some(custom_excl) = custom_val["exclusions"].as_array() {
                    if let Some(base_excl) = seed["exclusions"].as_array_mut() {
                        base_excl.extend(custom_excl.clone());
                    }
                }
            }
        }
    }

    let mut genre_map = HashMap::new();
    let mut genre_master = HashMap::new();
    let mut tag_map = HashMap::new();
    let mut tag_master = HashMap::new();
    let mut exclusions = Vec::new();

    if let Some(genres) = seed["genres"].as_array() {
        let mut genre_id_map = HashMap::new();
        let mut genre_parent_map = HashMap::new();
        let mut genre_priority_map = HashMap::new();

        for g in genres {
            let name = g["name"].as_str().unwrap().to_string();
            let priority = g["priority"].as_i64().unwrap_or(0) as i32;
            let id = name.clone(); // Use name as ID since it's unique in the seed
            genre_id_map.insert(name.clone(), id.clone());
            genre_priority_map.insert(name.clone(), priority);
            if let Some(p) = g["parent"].as_str() {
                genre_parent_map.insert(name, p.to_string());
            }
        }

        fn get_depth(name: &str, parents: &HashMap<String, String>) -> i32 {
            let mut d = 0;
            let mut cur = name;
            while let Some(p) = parents.get(cur) {
                d += 1;
                cur = p;
            }
            d
        }

        for g in genres {
            let name = g["name"].as_str().unwrap().to_string();
            let id = genre_id_map.get(&name).unwrap().clone();
            let priority = genre_priority_map.get(&name).unwrap().clone();
            let depth = get_depth(&name, &genre_parent_map);
            let parent_id = g["parent"].as_str().map(|p| p.to_string());

            genre_master.insert(
                id.clone(),
                GenreEntity {
                    id: id.clone(),
                    name: name.clone(),
                    depth,
                    priority,
                    parent_id,
                },
            );

            if let Some(ms) = g["mappings"].as_array() {
                for m in ms {
                    genre_map.insert(m.as_str().unwrap().to_lowercase(), id.clone());
                }
            }
        }
    }

    if let Some(tags) = seed["tags"].as_array() {
        for t in tags {
            if let Some(name) = t["name"].as_str() {
                let id = name.to_string();
                tag_master.insert(id.clone(), name.to_string());
                if let Some(ms) = t["mappings"].as_array() {
                    for m in ms {
                        if let Some(mapping) = m.as_str() {
                            tag_map.insert(mapping.to_lowercase(), id.clone());
                        }
                    }
                }
            }
        }
    }

    if let Some(excl) = seed["exclusions"].as_array() {
        for p in excl {
            if let Some(pattern) = p.as_str() {
                if let Ok(re) = Regex::new(&format!("(?i){}", pattern)) {
                    exclusions.push(re);
                }
            }
        }
    }

    AppContext {
        genre_map,
        genre_master,
        tag_map,
        tag_master,
        exclusions,
    }
}

// --- Commands ---

const CLOUDFLARE_PROXY_URL: &str = "https://live-mr-manager-lastfm.boohun2771.workers.dev"; // Placeholder or real one if user provided

#[tauri::command]
pub fn init_metadata_context(app: AppHandle) -> Result<(), String> {
    let mut ctx = CONTEXT.write();
    *ctx = Some(load_context(&app));
    Ok(())
}

#[tauri::command]
pub async fn search_track_metadata(app: AppHandle, query: String) -> Result<Vec<TrackResult>, String> {
    // Ensure context is loaded
    {
        let ctx = CONTEXT.read();
        if ctx.is_none() {
            drop(ctx);
            let _ = init_metadata_context(app.clone());
        }
    }
    
    let client = reqwest::Client::new();
    let url = format!(
        "{}/search?track={}",
        CLOUDFLARE_PROXY_URL,
        urlencoding::encode(&query)
    );

    let res: Value = client
        .get(url)
        .send()
        .await
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())?;

    let mut initial_results = Vec::new();
    if let Some(tracks) = res["results"]["trackmatches"]["track"].as_array() {
        for track in tracks.iter().take(6) { // Limit to top 6 to avoid rate limits
            let name = track["name"].as_str().unwrap_or("Unknown").to_string();
            let artist = track["artist"].as_str().unwrap_or("Unknown").to_string();
            initial_results.push((name, artist));
        }
    }

    let mut futures = Vec::new();

    for (name, artist) in initial_results {
        let client_clone = client.clone();
        let artist_clone = artist.clone();
        let name_clone = name.clone();
        
        futures.push(async move {
            if let Ok(processed) = process_metadata_logic(&client_clone, artist_clone.clone(), name_clone.clone()).await {
                TrackResult {
                    name: name_clone,
                    artist: artist_clone,
                    genre: processed.genre,
                    tags: processed.tags,
                }
            } else {
                TrackResult {
                    name: name_clone,
                    artist: artist_clone,
                    genre: "Unknown".to_string(),
                    tags: Vec::new(),
                }
            }
        });
    }

    use futures::future::join_all;
    let final_results = join_all(futures).await;

    Ok(final_results)
}

#[tauri::command]
pub async fn fetch_and_process_tags(
    app: AppHandle,
    artist: String,
    track: String,
) -> Result<ProcessedMetadata, String> {
    // Ensure context is loaded
    {
        let ctx = CONTEXT.read();
        if ctx.is_none() {
            drop(ctx);
            let _ = init_metadata_context(app.clone());
        }
    }
    let client = reqwest::Client::new();
    process_metadata_logic(&client, artist, track).await
}

#[tauri::command]
pub fn get_unclassified_tags() -> Result<HashMap<String, usize>, String> {
    let tags = UNKNOWN_TAGS.read();
    Ok(tags.clone())
}

#[tauri::command]
pub async fn update_custom_dictionary(app: AppHandle, category: String, original: String, translated: String) -> Result<(), String> {
    let app_dir = app.path().app_data_dir().unwrap_or_else(|_| PathBuf::from("."));
    let custom_path = app_dir.join("metadata_custom.json");
    
    let mut custom_val = if custom_path.exists() {
        let content = std::fs::read_to_string(&custom_path).map_err(|e| e.to_string())?;
        serde_json::from_str::<Value>(&content).unwrap_or(serde_json::json!({"genres": [], "tags": [], "exclusions": []}))
    } else {
        serde_json::json!({"genres": [], "tags": [], "exclusions": []})
    };

    if category == "genre" {
        if let Some(genres) = custom_val["genres"].as_array_mut() {
            genres.push(serde_json::json!({
                "name": translated,
                "mappings": [original]
            }));
        }
    } else {
        if let Some(tags) = custom_val["tags"].as_array_mut() {
            tags.push(serde_json::json!({
                "name": translated,
                "mappings": [original]
            }));
        }
    }

    let updated_content = serde_json::to_string_pretty(&custom_val).map_err(|e| e.to_string())?;
    std::fs::write(&custom_path, updated_content).map_err(|e| e.to_string())?;

    // Reload context immediately
    let _ = init_metadata_context(app);
    
    // Remove from unknown tags
    let mut unknown = UNKNOWN_TAGS.write();
    unknown.remove(&original.to_lowercase());

    Ok(())
}

async fn process_metadata_logic(client: &reqwest::Client, artist: String, track: String) -> Result<ProcessedMetadata, String> {
    let mut raw_tags = Vec::new();
    
    // 1. Fetch tags from Track and Artist
    let urls = [
        format!(
            "{}/getTopTags?artist={}&track={}",
            CLOUDFLARE_PROXY_URL,
            urlencoding::encode(&artist),
            urlencoding::encode(&track)
        ),
        format!(
            "{}/getArtistTopTags?artist={}",
            CLOUDFLARE_PROXY_URL,
            urlencoding::encode(&artist)
        ),
    ];

    for url in urls {
        if let Ok(res) = client.get(url).send().await {
            if let Ok(json) = res.json::<Value>().await {
                if let Some(tags) = json["toptags"]["tag"].as_array() {
                    for t in tags {
                        if let Some(n) = t["name"].as_str() {
                            raw_tags.push(n.to_lowercase());
                        }
                    }
                }
            }
        }
    }

    // 2. Process Tags using rules
    let ctx_lock = CONTEXT.read();
    let ctx = ctx_lock.as_ref().ok_or("Metadata context not initialized")?;
    
    let mut found_genre_ids = HashSet::new();
    let mut found_tag_ids = HashSet::new();
    let mut unmapped_tags = Vec::new();
    
    let mut session_unknown = Vec::new();

    let artist_lower = artist.to_lowercase();
    let track_lower = track.to_lowercase();

    for tag in raw_tags {
        if ctx.exclusions.iter().any(|re: &Regex| re.is_match(&tag)) {
            continue;
        }

        let tag_low = tag.to_lowercase();
        // Improved Noise filtering: Remove if tag is artist or track name (fuzzy)
        if tag_low.chars().count() >= 2 {
            if artist_lower.contains(&tag_low) || tag_low.contains(&artist_lower) ||
               track_lower.contains(&tag_low) || tag_low.contains(&track_lower) {
                continue;
            }
        }

        let mut matched = false;
        if let Some(gid) = ctx.genre_map.get(&tag_low) {
            found_genre_ids.insert(gid);
            matched = true;
        }
        if let Some(tid) = ctx.tag_map.get(&tag_low) {
            found_tag_ids.insert(tid);
            matched = true;
        }

        if !matched && !tag_low.is_empty() {
            unmapped_tags.push(tag.clone());
            session_unknown.push(tag_low);
        }
    }

    // Record unknown tags in global tracker
    if !session_unknown.is_empty() {
        let mut unknown = UNKNOWN_TAGS.write();
        for t in session_unknown {
            *unknown.entry(t).or_insert(0) += 1;
        }
    }

    // 3. Resolve Final Genre
    let (final_genre, final_genre_items) = if found_genre_ids.is_empty() {
        ("Unknown".to_string(), vec![])
    } else {
        let mut genre_candidates: Vec<&GenreEntity> = found_genre_ids
            .iter()
            .map(|id| ctx.genre_master.get(*id).unwrap())
            .collect();

        // 1. Depth 우선, 2. Priority 우선
        genre_candidates.sort_by(|a, b| {
            b.depth
                .cmp(&a.depth)
                .then_with(|| b.priority.cmp(&a.priority))
        });

        let top = genre_candidates[0];
        // Display only the most specific (lowest) genre name as per user rule
        let display_name = top.name.clone();
        
        // We still build the full path items for the redundancy check (removing overlapping tags)
        let mut full_path_items = vec![top.name.clone()];
        let mut cur_entity = top;
        while let Some(pid) = &cur_entity.parent_id {
            if let Some(p) = ctx.genre_master.get(pid) {
                full_path_items.insert(0, p.name.clone());
                cur_entity = p;
            } else {
                break;
            }
        }
        
        (display_name, full_path_items)
    };

    // 4. Resolve Tags (Cleaning overlaps)
    // Genre path에 포함된 단어들은 태그에서 제외 (예: 인디 록 -> 록 태그 삭제)
    let mut genre_words = HashSet::new();
    for name in &final_genre_items {
        let low_name = name.to_lowercase();
        for word in low_name.split(|c: char| !c.is_alphanumeric() && c != ' ') {
            if !word.is_empty() {
                genre_words.insert(word.trim().to_string());
            }
        }
    }

    let mut final_tags: Vec<String> = found_tag_ids
        .iter()
        .map(|id| ctx.tag_master.get(*id).unwrap().clone())
        .collect();

    for ut in unmapped_tags {
        if !final_tags.contains(&ut) {
            final_tags.push(ut);
        }
    }

    final_tags.retain(|tag: &String| {
        let low = tag.to_lowercase();
        // Check if this tag is already represented in the genre path
        let is_overlap = genre_words
            .iter()
            .any(|gw: &String| low.contains(gw) || gw.contains(&low));
        
        !is_overlap && tag.chars().count() > 1
    });

    final_tags.sort();
    final_tags.dedup();
    if final_tags.len() > 8 {
        final_tags.truncate(8);
    }

    Ok(ProcessedMetadata {
        genre: final_genre,
        tags: final_tags,
    })
}
