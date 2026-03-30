use once_cell::sync::Lazy;
use parking_lot::{Condvar, Mutex};
use rodio::{Decoder, DeviceSinkBuilder, MixerDeviceSink, Player, Source};
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::fs::File;
use std::io::BufReader;
use std::num::{NonZeroU16, NonZeroU32};
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tauri::{async_runtime, DragDropEvent, Emitter, Manager, WebviewWindow, WindowEvent, AppHandle};
use std::io::Write;
mod youtube;
use crate::youtube::YoutubeManager;
use ort::ep::{CUDA, CPUExecutionProvider, ExecutionProvider};
// Transparent aliases for Rodio 0.22.2 architecture:
pub type OSStream = MixerDeviceSink;
pub type PlaybackController = Player;

static MAIN_WINDOW: Lazy<Mutex<Option<WebviewWindow>>> = Lazy::new(|| Mutex::new(None));

fn sys_log(message: &str) {
    println!("{}", message);
    if let Some(window) = MAIN_WINDOW.lock().as_ref() {
        let _ = window.emit("sys-log", message.to_string());
    }
}

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
#[serde(rename_all = "camelCase")]
pub struct SongMetadata {
    pub title: String,
    pub thumbnail: String,
    pub duration: String,
    pub source: String,
    pub path: String,
    // Per-song settings
    pub pitch: Option<f32>,
    pub tempo: Option<f32>,
    pub volume: Option<f32>,
    pub artist: Option<String>,
    pub tags: Option<Vec<String>>,
    pub category: Option<String>,
    pub play_count: Option<u32>,
    pub date_added: Option<u64>,
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
    _stream: OSStream,
    pub controller: Mutex<PlaybackController>,
    pub state: Mutex<AppState>,
    pub active_pitch: Arc<AtomicU32>,
    pub active_tempo: Arc<AtomicU32>,
    pub current_pos_samples: Arc<AtomicU64>,
    pub active_sample_rate: Arc<AtomicU32>,
    pub playback_cv: Condvar,
}

impl AudioHandler {
    pub fn get_progress_ms(&self) -> u64 {
        let samples = self.current_pos_samples.load(Ordering::Relaxed);
        let rate = self.active_sample_rate.load(Ordering::Relaxed);
        if rate == 0 {
            0
        } else {
            (samples * 1000) / rate as u64
        }
    }
}

static AUDIO_HANDLER: Lazy<Arc<AudioHandler>> = Lazy::new(|| {
    sys_log("DEBUG: [AUDIO_HANDLER] Initializing Lazy Static Instance...");

    let stream_result = DeviceSinkBuilder::open_default_sink();
    let stream = match stream_result {
        Ok(s) => {
            sys_log("DEBUG: [AUDIO_HANDLER] DeviceSinkBuilder opened successfully.");
            s
        }
        Err(e) => {
            let err_msg = format!("CRITICAL ERROR: Failed to open audio output: {}", e);
            sys_log(&err_msg);
            panic!("{}", err_msg);
        }
    };

    let controller = Player::connect_new(&stream.mixer());
    sys_log("DEBUG: [AUDIO_HANDLER] OS Stream and Player Controller initialized.");

    Arc::new(AudioHandler {
        _stream: stream,
        controller: Mutex::new(controller),
        state: Mutex::new(AppState::default()),
        active_pitch: Arc::new(AtomicU32::new(0)),
        active_tempo: Arc::new(AtomicU32::new(100)),
        current_pos_samples: Arc::new(AtomicU64::new(0)),
        active_sample_rate: Arc::new(AtomicU32::new(44100)),
        playback_cv: Condvar::new(),
    })
});

pub struct StretchedSource<S>
where
    S: Source<Item = f32>,
{
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
    sample_idx_in_frame: u16,
}

impl<S> StretchedSource<S>
where
    S: Source<Item = f32>,
{
    pub fn new(
        input: S,
        pitch: Arc<AtomicU32>,
        tempo: Arc<AtomicU32>,
        processed_samples: Arc<AtomicU64>,
    ) -> Self {
        let channels = input.channels();
        let sample_rate = input.sample_rate();
        let block_size = 1024;

        // One stretcher per channel to avoid multi-channel process bug on some platforms/wrappers
        let mut stretchers = Vec::new();
        let mut planar_input = Vec::new();
        let mut planar_output = Vec::new();
        for _ in 0..channels.get() {
            stretchers.push(signalsmith_stretch::Stretch::preset_default(
                1,
                sample_rate.get(),
            ));
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
            sample_idx_in_frame: 0,
        }
    }
}

impl<S> Iterator for StretchedSource<S>
where
    S: Source<Item = f32>,
{
    type Item = f32;

    fn next(&mut self) -> Option<Self::Item> {
        loop {
            // 1. Drain output buffer if any
            if let Some(s) = self.output_buffer.pop_front() {
                self.sample_idx_in_frame += 1;
                if self.sample_idx_in_frame >= self.channels.get() {
                    let total = self.processed_samples.fetch_add(1, Ordering::Relaxed) + 1;
                    if total % 100000 == 0 {
                        sys_log(&format!(
                            "DEBUG: StretchedSource handled {} frames (Output Buffer).",
                            total
                        ));
                    }
                    self.sample_idx_in_frame = 0;
                }
                return Some(s);
            }

            let p_semitones = self.pitch.load(Ordering::Relaxed) as i32 as f32 / 100.0;
            let t_ratio = self.tempo.load(Ordering::Relaxed) as u32 as f32 / 100.0;
            let t_ratio = t_ratio.max(0.1);

            // 2. Passthrough Optimization
            if p_semitones == 0.0 && (t_ratio - 1.0).abs() < 0.01 {
                if let Some(s) = self.input.next() {
                    self.sample_idx_in_frame += 1;
                    if self.sample_idx_in_frame >= self.channels.get() {
                        let total = self.processed_samples.fetch_add(1, Ordering::Relaxed) + 1;
                        if total % 100000 == 0 {
                            sys_log(&format!(
                                "DEBUG: StretchedSource handled {} frames (Passthrough).",
                                total
                            ));
                        }
                        self.sample_idx_in_frame = 0;
                    }
                    return Some(s);
                } else {
                    sys_log("DEBUG: StretchedSource Input Iterator Returned None (Passthrough)!");
                    return None;
                }
            }

            // 3. Update all stretchers
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
                if !complete_frame {
                    break;
                }
                frames_in += 1;
            }

            if frames_in == 0 {
                // Buffer is empty (checked above) and no data left
                sys_log("DEBUG: StretchedSource Input Iterator Exhausted Block!");
                return None;
            }

            let expected_frames_out = (frames_in as f32 / t_ratio).ceil() as usize;
            let frames_out = expected_frames_out.max(1);

            for c in 0..self.channels.get() as usize {
                if self.planar_output[c].len() < frames_out {
                    self.planar_output[c].resize(frames_out, 0.0);
                }

                // Process each channel independently
                self.stretchers[c].process(
                    &self.planar_input[c][0..frames_in],
                    &mut self.planar_output[c][0..frames_out],
                );
            }

            for i in 0..frames_out {
                for c in 0..self.channels.get() as usize {
                    self.output_buffer.push_back(self.planar_output[c][i]);
                }
            }

            // Looping back ensures that if stretchers generated 0 frames output momentarily, we fetch again without returning None
        }
    }
}

impl<S> Source for StretchedSource<S>
where
    S: Source<Item = f32>,
{
    fn current_span_len(&self) -> Option<usize> {
        None
    }
    fn channels(&self) -> NonZeroU16 {
        self.channels
    }
    fn sample_rate(&self) -> NonZeroU32 {
        self.sample_rate
    }
    fn total_duration(&self) -> Option<std::time::Duration> {
        self.input.total_duration()
    }

    fn try_seek(&mut self, pos: std::time::Duration) -> Result<(), rodio::source::SeekError> {
        self.input.try_seek(pos)?;
        self.output_buffer.clear();
        Ok(())
    }
}

fn get_app_path(handle: &AppHandle) -> std::path::PathBuf {
    handle.path().app_data_dir().expect("Failed to get app data dir")
}

async fn cache_thumbnail(handle: AppHandle, url: String, video_id: String) -> Option<String> {
    let app_dir = get_app_path(&handle);
    let thumb_dir = app_dir.join("thumbnails");
    
    if !thumb_dir.exists() {
        std::fs::create_dir_all(&thumb_dir).ok()?;
    }

    let file_path = thumb_dir.join(format!("{}.jpg", video_id));
    
    // Skip if already cached
    if file_path.exists() {
        return Some(file_path.to_string_lossy().to_string());
    }

    match reqwest::get(&url).await {
        Ok(response) => {
            if let Ok(bytes) = response.bytes().await {
                if let Ok(mut file) = File::create(&file_path) {
                    if file.write_all(&bytes).is_ok() {
                        return Some(file_path.to_string_lossy().to_string());
                    }
                }
            }
        }
        Err(e) => sys_log(&format!("Thumbnail download failed: {}", e)),
    }
    None
}

#[tauri::command]
async fn get_youtube_metadata(handle: AppHandle, url: String) -> Result<SongMetadata, String> {
    let metadata = YoutubeManager::get_video_metadata(&url).await?;
    let length_sec = metadata.duration.unwrap_or(0.0) as u64;

    // Extract Video ID for filename
    let video_id = url.split("v=").nth(1)
        .and_then(|v| v.split('&').next())
        .unwrap_or("unknown")
        .to_string();

    let mut local_thumbnail = metadata.thumbnail.clone().unwrap_or_default();
    if let Some(thumb_url) = metadata.thumbnail {
        if let Some(path) = cache_thumbnail(handle, thumb_url, video_id).await {
            local_thumbnail = path;
        }
    }

    Ok(SongMetadata {
        title: metadata
            .title
            .unwrap_or_else(|| "Unknown Title".to_string()),
        thumbnail: local_thumbnail,
        duration: format!("{}:{:02}", length_sec / 60, length_sec % 60),
        source: "youtube".to_string(),
        path: url,
        pitch: None,
        tempo: None,
        volume: None,
        artist: None,
        tags: None,
        category: None,
        play_count: Some(0),
        date_added: Some(
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_millis() as u64,
        ),
    })
}

fn get_audio_duration(path: &std::path::Path) -> String {
    let file = match File::open(path) {
        Ok(f) => f,
        Err(_) => return "-".to_string(),
    };
    let reader = BufReader::new(file);
    match rodio::Decoder::try_from(reader) {
        Ok(decoder) => {
            if let Some(duration) = decoder.total_duration() {
                let secs = duration.as_secs();
                return format!("{}:{:02}", secs / 60, secs % 60);
            }
        }
        Err(_) => {}
    }
    "-".to_string()
}

#[tauri::command]
async fn get_audio_metadata(path: String) -> Result<SongMetadata, String> {
    let p = std::path::Path::new(&path);
    if !p.exists() {
        return Err("File not found".to_string());
    }

    let title = p.file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .into_owned();
    
    let duration = get_audio_duration(p);

    Ok(SongMetadata {
        title,
        thumbnail: "".to_string(),
        duration,
        source: "local".to_string(),
        path,
        pitch: None,
        tempo: None,
        volume: None,
        artist: None,
        tags: None,
        category: None,
        play_count: Some(0),
        date_added: Some(
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_millis() as u64,
        ),
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
                    let duration = get_audio_duration(&path);
                    songs.push(SongMetadata {
                        title: path
                            .file_name()
                            .unwrap_or_default()
                            .to_string_lossy()
                            .into_owned(),
                        thumbnail: "".to_string(),
                        duration,
                        source: "local".to_string(),
                        path: path.to_string_lossy().into_owned(),
                        pitch: None,
                        tempo: None,
                        volume: None,
                        artist: None,
                        tags: None,
                        category: None,
                        play_count: Some(0),
                        date_added: Some(
                            std::time::SystemTime::now()
                                .duration_since(std::time::UNIX_EPOCH)
                                .unwrap()
                                .as_millis() as u64,
                        ),
                    });
                }
            }
        }
    }
    Ok(songs)
}

#[tauri::command]
async fn play_track(window: WebviewWindow, path: String) -> Result<(), String> {
    *MAIN_WINDOW.lock() = Some(window.clone());
    sys_log(&format!(
        "DEBUG: [play_track] Received request for: {}",
        &path
    ));

    let emit_status = |status, message: &str| {
        let _ = window.emit(
            "playback-status",
            PlaybackStatus {
                status,
                message: message.to_string(),
            },
        );
    };

    // Immediate stop previous track for instant feedback
    let handler = AUDIO_HANDLER.clone();
    {
        let controller = handler.controller.lock();
        let mut state = handler.state.lock();
        controller.clear();
        state.is_playing = false;
        sys_log("DEBUG: [play_track] Previous track cleared and state set to false.");
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

    emit_status(
        Status::Decoding,
        &format!("Final audio path to play: {}", &audio_file_path),
    );
    let handler = AUDIO_HANDLER.clone();

    let source_result = async_runtime::spawn_blocking(move || {
        let file = match File::open(&audio_file_path) {
            Ok(f) => f,
            Err(e) => return Err(format!("File open error: {}", e)),
        };
        Decoder::try_from(BufReader::new(file)).map_err(|e| format!("Decode error: {}", e))
    })
    .await
    .map_err(|e| e.to_string());

    let float_source = match source_result {
        Ok(Ok(s)) => s,
        Ok(Err(e)) | Err(e) => {
            let err_msg = format!("Failed to decode audio source: {}", e);
            emit_status(Status::Error, &err_msg);
            return Err(err_msg);
        }
    };

    sys_log(&format!(
        "Audio source decoded successfully: {} samples found.",
        if let Some(d) = float_source.total_duration() {
            format!("{:?}", d)
        } else {
            "Unknown duration".to_string()
        }
    ));

    // Reset position
    handler.current_pos_samples.store(0, Ordering::Relaxed);

    // Wrap with StretchedSource
    let stretched = StretchedSource::new(
        float_source,
        handler.active_pitch.clone(),
        handler.active_tempo.clone(),
        handler.current_pos_samples.clone(),
    );

    let sample_rate = stretched.sample_rate().get();
    let total_duration = stretched.total_duration().unwrap_or(Duration::from_secs(0));
    let total_ms = total_duration.as_millis() as u64;

    {
        let controller_lock = handler.controller.lock();
        println!("DEBUG: [play_track] Appending source to controller...");
        controller_lock.clear();
        controller_lock.append(stretched);
        controller_lock.play();
        println!("DEBUG: [play_track] Play signal sent to Rodio Player.");
    }

    let mut state = handler.state.lock();
    let track_id = path.clone();
    state.current_track = Some(path);
    state.is_playing = true;
    handler
        .active_sample_rate
        .store(sample_rate, Ordering::Relaxed);
    handler.playback_cv.notify_all();

    // Start progress thread
    let window_progress = window.clone();
    let handler_progress = handler.clone();
    let thread_track_id = track_id.clone();

    std::thread::spawn(move || {
        loop {
            {
                let mut state = handler_progress.state.lock();
                loop {
                    if state.current_track.as_ref() != Some(&thread_track_id) {
                        return;
                    } // Thread ends
                    if state.is_playing {
                        break;
                    }
                    handler_progress.playback_cv.wait(&mut state);
                }
            }

            let pos_ms = handler_progress.get_progress_ms();

            let _ = window_progress.emit(
                "playback-progress",
                PlaybackProgress {
                    position_ms: pos_ms,
                    duration_ms: total_ms,
                },
            );

            std::thread::sleep(Duration::from_millis(50)); // Higher refresh rate for smoother bar
        }
    });

    emit_status(Status::Playing, "Playback started.");
    println!(
        "DEBUG: Playback status set to Playing for track: {}",
        track_id
    );
    Ok(())
}

#[tauri::command]
#[allow(dead_code)]
fn seek_to(position_ms: u64) -> Result<(), String> {
    let handler = AUDIO_HANDLER.clone();
    let controller = handler.controller.lock();

    let duration = Duration::from_millis(position_ms);
    controller.try_seek(duration).map_err(|e| e.to_string())?;

    // Update our counter
    let current_rate = handler.active_sample_rate.load(Ordering::Relaxed);
    handler.current_pos_samples.store(
        (position_ms * current_rate as u64) / 1000,
        Ordering::Relaxed,
    );
    handler.playback_cv.notify_all();

    Ok(())
}

#[tauri::command]
fn toggle_playback(window: WebviewWindow) -> Result<bool, String> {
    *MAIN_WINDOW.lock() = Some(window);
    let handler = AUDIO_HANDLER.clone();
    let controller = handler.controller.lock();
    let mut state = handler.state.lock();

    if controller.is_paused() {
        controller.play();
        state.is_playing = true;
        handler.playback_cv.notify_all();
        sys_log("DEBUG: [toggle_playback] Resumed.");
    } else {
        controller.pause();
        state.is_playing = false;
        sys_log("DEBUG: [toggle_playback] Paused.");
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
    handler.controller.lock().set_volume(volume / 100.0);
    Ok(())
}

#[tauri::command]
fn toggle_ai_feature(feature: String, enabled: bool) -> Result<(), String> {
    sys_log(&format!("AI Processing [{}]: {}", feature, enabled));
    // TODO: Roformer/WhisperX Task Queue 連動
    Ok(())
}

#[tauri::command]
async fn check_ai_runtime() -> Result<Vec<String>, String> {
    sys_log("DEBUG: [check_ai_runtime] Checking available AI Execution Providers...");
    
    let mut providers = Vec::new();
    
    // Check CUDA
    if CUDA::default().is_available().unwrap_or(false) {
        providers.push("NVIDIA CUDA (GPU)".to_string());
    }
    
    // Check CPU (Always available)
    if CPUExecutionProvider::default().is_available().unwrap_or(false) {
        providers.push("CPU (Standard)".to_string());
    }
    
    sys_log(&format!("DEBUG: [check_ai_runtime] Available Providers: {:?}", providers));
    
    Ok(providers)
}

#[tauri::command]
fn save_library(app: tauri::AppHandle, songs: Vec<SongMetadata>) -> Result<(), String> {
    let path = app
        .path()
        .app_local_data_dir()
        .map_err(|e| e.to_string())?
        .join("library.json");

    // Ensure parent directory exists
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }

    let json = serde_json::to_string_pretty(&songs).map_err(|e| e.to_string())?;
    std::fs::write(path, json).map_err(|e| e.to_string())?;

    sys_log("DEBUG: [save_library] Library saved successfully.");
    Ok(())
}

#[tauri::command]
fn load_library(app: tauri::AppHandle) -> Result<Vec<SongMetadata>, String> {
    let path = app
        .path()
        .app_local_data_dir()
        .map_err(|e| e.to_string())?
        .join("library.json");

    if !path.exists() {
        sys_log("DEBUG: [load_library] No library file found, returning empty list.");
        return Ok(Vec::new());
    }

    let json = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
    let songs: Vec<SongMetadata> = serde_json::from_str(&json).map_err(|e| e.to_string())?;

    sys_log(&format!(
        "DEBUG: [load_library] Loaded {} songs.",
        songs.len()
    ));
    Ok(songs)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let window = app.get_webview_window("main");
            if window.is_some() {
                sys_log("DEBUG: [setup] Main window found and registered.");
            } else {
                println!("DEBUG: [setup] Main window NOT found during setup.");
            }
            *MAIN_WINDOW.lock() = window;

            sys_log("DEBUG: [setup] Starting Audio System Initialization...");
            Lazy::force(&AUDIO_HANDLER);
            sys_log("DEBUG: [setup] Audio System Initialized on Main Thread.");
            Ok(())
        })
        .plugin(tauri_plugin_opener::init())
        .on_window_event(|window, event| {
            if let WindowEvent::DragDrop(drop_event) = event {
                match drop_event {
                    DragDropEvent::Drop { paths, .. } => {
                        let _ = window.emit("tauri-file-dropped", paths);
                    }
                    _ => {} // Other variants are Hover, Cancel, etc.
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            get_youtube_metadata,
            get_audio_metadata,
            scan_local_folder,
            play_track,
            toggle_playback,
            seek_to,
            set_pitch,
            set_tempo,
            set_volume,
            toggle_ai_feature,
            save_library,
            load_library,
            check_ai_runtime
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
