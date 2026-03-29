use serde::{Deserialize, Serialize};
use std::sync::Arc;
use parking_lot::Mutex;
use tauri::{Emitter, async_runtime, WindowEvent, DragDropEvent, Window};
use once_cell::sync::Lazy;
use rodio::{Decoder, DeviceSinkBuilder, MixerDeviceSink, Player, Source};
use std::fs::File;
use std::io::BufReader;
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::collections::VecDeque;
use std::num::{NonZeroU16, NonZeroU32};
use std::time::Duration;
mod youtube;
use crate::youtube::YoutubeManager;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
enum Status {
    Pending,
    Downloading,
    Decoding,
    Playing,
    Error,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PlaybackStatus {
    status: Status,
    message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PlaybackProgress {
    position_ms: u64,
    duration_ms: u64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SongMetadata {
    pub title: String,
    pub thumbnail: String,
    pub duration: String,
    pub source: String,
    pub path: String,
}


#[derive(Debug, Serialize, Deserialize, Clone)]
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
    _handle: MixerDeviceSink,
    pub player: Mutex<Player>,
    pub state: Mutex<AppState>,
    pub active_pitch: Arc<AtomicU32>,
    pub active_tempo: Arc<AtomicU32>,
    pub current_pos_samples: Arc<AtomicU64>,
}



static AUDIO_HANDLER: Lazy<Arc<AudioHandler>> = Lazy::new(|| {
    let handle = DeviceSinkBuilder::open_default_sink().expect("Failed to open audio output");
    let player = Player::connect_new(&handle.mixer());

    Arc::new(AudioHandler {
        _handle: handle,
        player: Mutex::new(player),
        state: Mutex::new(AppState::default()),
        active_pitch: Arc::new(AtomicU32::new(0)),       // 0 semitones * 100
        active_tempo: Arc::new(AtomicU32::new(100)),     // 1.0x * 100
        current_pos_samples: Arc::new(AtomicU64::new(0)),
    })
});

pub struct StretchedSource<S> where S: Source<Item = f32> {
    input: S,
    stretchers: Vec<signalsmith_stretch::Stretch>,
    pitch: Arc<AtomicU32>,
    tempo: Arc<AtomicU32>,
    processed_samples: Arc<AtomicU64>,
    output_buffer: VecDeque<f32>,
    channels: NonZeroU16,
    sample_rate: NonZeroU32,
    planar_input: Vec<Vec<f32>>,
    planar_output: Vec<Vec<f32>>,
    block_size: usize,
}

impl<S> StretchedSource<S> where S: Source<Item = f32> {
    pub fn new(input: S, pitch: Arc<AtomicU32>, tempo: Arc<AtomicU32>, processed_samples: Arc<AtomicU64>) -> Self {
        let channels = input.channels();
        let sample_rate = input.sample_rate();
        let block_size = 1024;
        
        // One stretcher per channel to avoid multi-channel process bug on some platforms/wrappers
        let mut stretchers = Vec::new();
        let mut planar_input = Vec::new();
        let mut planar_output = Vec::new();
        for _ in 0..channels.get() {
            stretchers.push(signalsmith_stretch::Stretch::preset_default(1, sample_rate.get()));
            planar_input.push(Vec::with_capacity(block_size));
            planar_output.push(vec![0.0; block_size * 4]);
        }
        
        Self {
            input,
            stretchers,
            pitch,
            tempo,
            processed_samples,
            output_buffer: VecDeque::new(),
            channels,
            sample_rate,
            planar_input,
            planar_output,
            block_size,
        }
    }
}

impl<S> Iterator for StretchedSource<S> where S: Source<Item = f32> {
    type Item = f32;

    fn next(&mut self) -> Option<Self::Item> {
        if let Some(s) = self.output_buffer.pop_front() {
            return Some(s);
        }

        let p_semitones = self.pitch.load(Ordering::Relaxed) as i32 as f32 / 100.0;
        let t_ratio = self.tempo.load(Ordering::Relaxed) as u32 as f32 / 100.0;
        let t_ratio = t_ratio.max(0.1); 
        
        // --- Added: Correct Block-based Passthrough ---
        if p_semitones == 0.0 && (t_ratio - 1.0).abs() < 0.01 {
            let mut frames_read = 0;
            for _ in 0..self.block_size {
                let mut complete_frame = true;
                for _ in 0..self.channels.get() as usize {
                    if let Some(s) = self.input.next() {
                        self.output_buffer.push_back(s);
                    } else {
                        complete_frame = false;
                        break;
                    }
                }
                if !complete_frame { break; }
                frames_read += 1;
            }
            if frames_read > 0 {
                self.processed_samples.fetch_add(frames_read as u64, Ordering::Relaxed);
                return self.output_buffer.pop_front();
            } else {
                return None;
            }
        }
        // ----------------------------------------------

        // Update all stretchers
        for stretcher in self.stretchers.iter_mut() {
            stretcher.set_transpose_factor_semitones(p_semitones, None);
        }

        for c in 0..self.channels.get() as usize {
            self.planar_input[c].clear();
        }

        let mut frames_in = 0;
        for _ in 0..self.block_size {
            let mut complete_frame = true;
            for c in 0..self.channels.get() as usize {
                if let Some(s) = self.input.next() {
                    self.planar_input[c].push(s);
                } else {
                    complete_frame = false;
                    break;
                }
            }
            if !complete_frame { break; }
            frames_in += 1;
        }

        if frames_in == 0 { return None; }
        self.processed_samples.fetch_add(frames_in as u64, Ordering::Relaxed);
        
        let expected_frames_out = (frames_in as f32 / t_ratio).ceil() as usize;
        let frames_out = expected_frames_out.max(1);

        for c in 0..self.channels.get() as usize {
            if self.planar_output[c].len() < frames_out {
                self.planar_output[c].resize(frames_out, 0.0);
            }
            
            // Process each channel independently
            self.stretchers[c].process(&self.planar_input[c][0..frames_in], &mut self.planar_output[c][0..frames_out]);
        }

        for i in 0..frames_out {
            for c in 0..self.channels.get() as usize {
                self.output_buffer.push_back(self.planar_output[c][i]);
            }
        }
        
        self.output_buffer.pop_front()
    }
}

impl<S> Source for StretchedSource<S> where S: Source<Item = f32> {
    fn current_span_len(&self) -> Option<usize> { 
        None 
    }
    fn channels(&self) -> NonZeroU16 { self.channels }
    fn sample_rate(&self) -> NonZeroU32 { self.sample_rate }
    fn total_duration(&self) -> Option<std::time::Duration> { self.input.total_duration() }
    
    fn try_seek(&mut self, pos: std::time::Duration) -> Result<(), rodio::source::SeekError> {
        self.input.try_seek(pos)?;
        self.output_buffer.clear();
        Ok(())
    }
}

#[tauri::command]
async fn get_youtube_metadata(url: String) -> Result<SongMetadata, String> {
    let metadata = YoutubeManager::get_video_metadata(&url).await?;
    let length_sec = metadata.duration.unwrap_or(0.0) as u64;

    Ok(SongMetadata {
        title: metadata.title.unwrap_or_else(|| "Unknown Title".to_string()),
        thumbnail: metadata.thumbnail.unwrap_or_default(),
        duration: format!("{}:{:02}", length_sec / 60, length_sec % 60),
        source: "youtube".to_string(),
        path: url,
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
                if ["mp3", "wav", "flac", "ogg", "m4a"].contains(&ext_str.as_str()) {
                    songs.push(SongMetadata {
                        title: path.file_name().unwrap_or_default().to_string_lossy().into_owned(),
                        thumbnail: "".to_string(),
                        duration: "-".to_string(),
                        source: "local".to_string(),
                        path: path.to_string_lossy().into_owned(), // <-- Add the full file path
                    });
                }
            }
        }
    }
    Ok(songs)
}

#[tauri::command]
async fn play_track(window: Window, path: String) -> Result<(), String> {
    let emit_status = |status, message: &str| {
        let _ = window.emit("playback-status", PlaybackStatus { status, message: message.to_string() });
    };

    // Immediate stop previous track for instant feedback
    let handler = AUDIO_HANDLER.clone();
    {
        let player = handler.player.lock();
        let mut state = handler.state.lock();
        player.stop();
        state.is_playing = false;
    }

    emit_status(Status::Pending, &format!("Attempting to play: {}", &path));

    let audio_file_path = if path.starts_with("http") {
        emit_status(Status::Downloading, "Fetching video metadata...");
        
        let metadata = YoutubeManager::get_video_metadata(&path).await?;
        
        let temp_dir = std::env::temp_dir();
        let id = metadata.id.ok_or("Could not determine video ID")?;
        let file_name = format!("yt_{}.m4a", id);
        let final_path = temp_dir.join(file_name);

        if !final_path.exists() {
            emit_status(Status::Downloading, "Downloading audio...");
            YoutubeManager::download_audio(&window, &path, final_path.clone()).await?;
            emit_status(Status::Downloading, "Download complete.");
        } else {
            emit_status(Status::Downloading, "Using cached audio file.");
        }
        
        final_path.to_string_lossy().to_string()
    } else {
        emit_status(Status::Pending, "Recognized as local file path.");
        path.clone()
    };

    emit_status(Status::Decoding, &format!("Final audio path to play: {}", &audio_file_path));
    let handler = AUDIO_HANDLER.clone();
    
    let source_result = async_runtime::spawn_blocking(move || {
        let file = match File::open(&audio_file_path) {
            Ok(f) => f,
            Err(e) => return Err(format!("File open error: {}", e)),
        };
        Decoder::try_from(BufReader::new(file)).map_err(|e| format!("Decode error: {}", e))
    }).await.map_err(|e| e.to_string());

    let float_source = match source_result {
        Ok(Ok(s)) => s,
        Ok(Err(e)) | Err(e) => {
            let err_msg = format!("Failed to decode audio source: {}", e);
            emit_status(Status::Error, &err_msg);
            return Err(err_msg);
        }
    };
    
    println!("Audio source decoded successfully: {} samples found.", if let Some(d) = float_source.total_duration() { format!("{:?}", d) } else { "Unknown duration".to_string() });
    
    // Reset position
    handler.current_pos_samples.store(0, Ordering::Relaxed);
    
    // Wrap with StretchedSource
    let stretched = StretchedSource::new(
        float_source, 
        handler.active_pitch.clone(), 
        handler.active_tempo.clone(),
        handler.current_pos_samples.clone()
    );

    let total_duration = stretched.total_duration().unwrap_or(Duration::from_secs(0));
    let total_ms = total_duration.as_millis() as u64;

    let player_lock = handler.player.lock();
    player_lock.stop();
    player_lock.append(stretched);
    player_lock.play(); 
    println!("Rodio Player: Playback signal sent for track: {}", &path);    
    let mut state = handler.state.lock();
    let track_id = path.clone();
    state.current_track = Some(path);
    state.is_playing = true;
    
    // Start progress thread
    let window_progress = window.clone();
    let pos_samples = handler.current_pos_samples.clone();
    let handler_progress = handler.clone();
    
    std::thread::spawn(move || {
        loop {
            // Check if song still exists AND matches the track this thread tracks
            {
                let state = handler_progress.state.lock();
                if state.current_track.as_ref() != Some(&track_id) { break; }
                if !state.is_playing { 
                    std::thread::sleep(Duration::from_millis(200));
                    continue; 
                }
            }

            let samples_consumed = pos_samples.load(Ordering::Relaxed);
            
            // To be accurate, we need the sample rate
            // Hardcoding 44100 for now, but ideally this comes from the source stream
            let pos_ms = (samples_consumed * 1000) / 44100; 
            
            let _ = window_progress.emit("playback-progress", PlaybackProgress {
                position_ms: pos_ms,
                duration_ms: total_ms,
            });

            std::thread::sleep(Duration::from_millis(50)); // Higher refresh rate for smoother bar
        }
    });

    emit_status(Status::Playing, "Playback started.");
    Ok(())
}

#[tauri::command]
#[allow(dead_code)]
fn seek_to(position_ms: u64) -> Result<(), String> {
    let handler = AUDIO_HANDLER.clone();
    let player = handler.player.lock();
    
    // Rodio Player/Sink seeking
    let duration = Duration::from_millis(position_ms);
    player.try_seek(duration).map_err(|e| e.to_string())?;
    
    // Update our counter
    handler.current_pos_samples.store((position_ms * 44100) / 1000, Ordering::Relaxed);
    
    Ok(())
}

#[tauri::command]
fn toggle_playback() -> Result<bool, String> {
    let handler = AUDIO_HANDLER.clone();
    let player = handler.player.lock();
    let mut state = handler.state.lock();

    if player.is_paused() {
        player.play();
        state.is_playing = true;
    } else {
        player.pause();
        state.is_playing = false;
    }

    Ok(state.is_playing)
}

#[tauri::command]
fn set_pitch(semitones: f32) -> Result<(), String> {
    let handler = AUDIO_HANDLER.clone();
    let mut state = handler.state.lock();
    state.pitch = semitones;
    
    let p_u32 = (semitones * 100.0) as i32;
    handler.active_pitch.store(p_u32 as u32, Ordering::Relaxed);
    
    Ok(())
}

#[tauri::command]
fn set_tempo(ratio: f32) -> Result<(), String> {
    let handler = AUDIO_HANDLER.clone();
    let mut state = handler.state.lock();
    state.tempo = ratio;
    
    let t_u32 = (ratio * 100.0) as u32;
    handler.active_tempo.store(t_u32, Ordering::Relaxed);
    
    Ok(())
}

#[tauri::command]
fn set_volume(volume: f32) -> Result<(), String> {
    let handler = AUDIO_HANDLER.clone();
    handler.player.lock().set_volume(volume / 100.0);
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
            if let WindowEvent::DragDrop(drop_event) = event {
                match drop_event {
                    DragDropEvent::Drop { paths, .. } => {
                        let _ = window.emit("tauri-file-dropped", paths);
                    },
                    _ => {}, // Other variants are Hover, Cancel, etc.
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            get_youtube_metadata, 
            scan_local_folder,
            play_track,
            toggle_playback,
            seek_to,
            set_pitch,
            set_tempo,
            set_volume,
            toggle_ai_feature
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
