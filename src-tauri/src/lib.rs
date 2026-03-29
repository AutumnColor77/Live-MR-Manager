use serde::{Deserialize, Serialize};
use std::sync::Arc;
use parking_lot::Mutex;
use tauri::{Manager, Emitter};
use once_cell::sync::Lazy;
use rodio::{Decoder, OutputStream};
use std::fs::File;
use std::io::BufReader;

#[derive(Debug, Serialize, Deserialize)]
pub struct SongMetadata {
    pub title: String,
    pub thumbnail: String,
    pub duration: String,
    pub source: String,
}

#[derive(Debug, Deserialize)]
struct OEmbedResponse {
    title: String,
    thumbnail_url: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct AppState {
    pub current_track: Option<String>,
    pub pitch: f32,
    pub tempo: f32,
    pub volume: f32,
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
            vocal_enabled: true,
            lyric_enabled: false,
            is_playing: false,
        }
    }
}

pub struct AudioHandler {
    pub sink: Arc<rodio::Sink>,
    pub _stream: OutputStream,
    pub state: Mutex<AppState>,
}

// Global Audio Handler (Shared across commands)
static AUDIO_HANDLER: Lazy<Arc<AudioHandler>> = Lazy::new(|| {
    let (stream, stream_handle) = OutputStream::try_default().expect("Failed to open audio output");
    let sink = rodio::Sink::try_new(&stream_handle).expect("Failed to create sink");
    
    Arc::new(AudioHandler {
        sink: Arc::new(sink),
        _stream: stream,
        state: Mutex::new(AppState::default()),
    })
});

#[tauri::command]
async fn get_youtube_metadata(url: String) -> Result<SongMetadata, String> {
    let oembed_url = format!("https://www.youtube.com/oembed?url={}&format=json", url);
    
    let client = reqwest::Client::new();
    let res = client.get(&oembed_url)
        .send()
        .await
        .map_err(|e| e.to_string())?
        .json::<OEmbedResponse>()
        .await
        .map_err(|e| e.to_string())?;

    Ok(SongMetadata {
        title: res.title,
        thumbnail: res.thumbnail_url,
        duration: "Unknown".to_string(), // oEmbed doesn't provide duration easily
        source: "youtube".to_string(),
    })
}

#[tauri::command]
fn scan_local_folder(path: String) -> Result<Vec<SongMetadata>, String> {
    let mut songs = Vec::new();
    let dir = std::fs::read_dir(path).map_err(|e| e.to_string())?;

    for entry in dir {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if path.is_file() {
            if let Some(ext) = path.extension() {
                let ext_str = ext.to_string_lossy().to_lowercase();
                if ["mp3", "wav", "flac"].contains(&ext_str.as_str()) {
                    songs.push(SongMetadata {
                        title: path.file_name().unwrap_or_default().to_string_lossy().into_owned(),
                        thumbnail: "".to_string(),
                        duration: "-".to_string(),
                        source: "local".to_string(),
                    });
                }
            }
        }
    }
    Ok(songs)
}
#[tauri::command]
async fn play_track(path: String) -> Result<(), String> {
    let handler = AUDIO_HANDLER.clone();
    
    // Stop current playback
    handler.sink.stop();

    // Load new file
    let file = File::open(&path).map_err(|e| format!("File open error: {}", e))?;
    let source = Decoder::new(BufReader::new(file)).map_err(|e| format!("Decode error: {}", e))?;
    
    handler.sink.append(source);
    handler.sink.play();
    
    let mut state = handler.state.lock();
    state.current_track = Some(path);
    state.is_playing = true;
    
    Ok(())
}

#[tauri::command]
fn set_pitch(semitones: f32) -> Result<(), String> {
    let handler = AUDIO_HANDLER.clone();
    let mut state = handler.state.lock();
    state.pitch = semitones;
    
    // rodio's speed affects both pitch and tempo simultaneously
    // For now, we use simple speed scaling. Proper pitch shift (WSOLA) is next.
    let speed = 2.0_f32.powf(semitones / 12.0);
    handler.sink.set_speed(speed * state.tempo);
    
    Ok(())
}

#[tauri::command]
fn set_tempo(ratio: f32) -> Result<(), String> {
    let handler = AUDIO_HANDLER.clone();
    let mut state = handler.state.lock();
    state.tempo = ratio;
    
    let speed = 2.0_f32.powf(state.pitch / 12.0);
    handler.sink.set_speed(speed * ratio);
    
    Ok(())
}

#[tauri::command]
fn set_volume(volume: f32) -> Result<(), String> {
    let handler = AUDIO_HANDLER.clone();
    handler.sink.set_volume(volume / 100.0);
    Ok(())
}

#[tauri::command]
fn toggle_ai_feature(feature: String, enabled: bool) -> Result<(), String> {
    println!("AI Processing [{}]: {}", feature, enabled);
    // TODO: Roformer/WhisperX Task Queue 連動
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Drop { paths, .. }) = event {
                // Emit dropped paths to frontend
                let _ = window.emit("tauri-file-dropped", paths);
            }
        })
        .invoke_handler(tauri::generate_handler![
            get_youtube_metadata, 
            scan_local_folder,
            play_track,
            set_pitch,
            set_tempo,
            set_volume,
            toggle_ai_feature
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
