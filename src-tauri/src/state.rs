use once_cell::sync::Lazy;
use parking_lot::{Condvar, Mutex};
use rodio::{MixerDeviceSink, Player};
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicU32, AtomicU64};
use std::sync::Arc;
use tauri::{WebviewWindow, AppHandle};
use cpal::traits::{DeviceTrait, HostTrait};

use crate::vocal_remover::RoformerEngine;
use crate::audio_player::AudioHandler; // Assuming AudioHandler will be in audio_player

// --- Global State ---

pub static MAIN_WINDOW: Lazy<Mutex<Option<WebviewWindow>>> = Lazy::new(|| Mutex::new(None));
pub static ROFORMER_ENGINE: Lazy<Arc<Mutex<Option<RoformerEngine>>>> = Lazy::new(|| Arc::new(Mutex::new(None)));
pub static AUDIO_HANDLER: Lazy<Arc<AudioHandler>> = Lazy::new(|| {
    let (_stream, handle) = rodio::OutputStream::try_default().expect("Failed to open audio output stream");
    
    // We need to keep the stream alive, but rodio's design makes this tricky with a static lazy.
    // A common approach is to detach it, but that's not ideal.
    // For now, let's leak it. This is not perfect but ensures the stream lives for the program's duration.
    // A better solution might involve a dedicated state management struct initialized at app startup.
    Box::leak(Box::new(_stream));

    // Detect system device config once:
    let host = cpal::default_host();
    let (device_rate, device_channels) = if let Some(device) = host.default_output_device() {
        if let Ok(config) = device.default_output_config() {
            (config.sample_rate().0, config.channels())
        } else { (44100, 2) }
    } else { (44100, 2) };

    println!("System audio initialized: {} Hz, {} ch", device_rate, device_channels);
    
    let sink = rodio::Sink::try_new(&handle).expect("Failed to create sink");

    Arc::new(AudioHandler {
        sink: Mutex::new(sink),
        state: Mutex::new(AppState::default()),
        active_pitch: Arc::new(AtomicU32::new(0f32.to_bits())),
        active_tempo: Arc::new(AtomicU32::new(1.0f32.to_bits())),
        current_pos_samples: Arc::new(AtomicU64::new(0)),
        active_sample_rate: device_rate,
        active_channels: device_channels,
        vocal_volume: Arc::new(AtomicU32::new(100)),
        instrumental_volume: Arc::new(AtomicU32::new(100)),
        playback_cv: Condvar::new(),
    })
});


// --- Data Structures ---

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Status {
    Pending,
    Downloading,
    Decoding,
    Separating,
    Playing,
    Error,
    Finished,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaybackStatus {
    pub status: Status,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaybackProgress {
    pub position_ms: u64,
    pub duration_ms: u64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SongMetadata {
    pub title: String,
    pub thumbnail: String,
    pub duration: String,
    pub source: String,
    pub path: String,
    pub pitch: Option<f32>,
    pub tempo: Option<f32>,
    pub volume: Option<f32>,
    pub artist: Option<String>,
    pub tags: Option<Vec<String>>,
    pub category: Option<String>,
    pub play_count: Option<u32>,
    pub date_added: Option<u64>,
    pub is_mr: Option<bool>,
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
