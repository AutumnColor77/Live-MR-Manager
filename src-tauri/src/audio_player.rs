use std::collections::{VecDeque, HashSet};
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::num::{NonZeroU16, NonZeroU32};
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;
use std::path::PathBuf;
use serde::{Deserialize, Serialize};

use rodio::{Source, Player};
use parking_lot::Mutex;
use once_cell::sync::Lazy;
use tauri::{Emitter, WebviewWindow};
use cpal::traits::{HostTrait, DeviceTrait};

pub static ACTIVE_DOWNLOADS: Lazy<Mutex<HashSet<PathBuf>>> = Lazy::new(|| Mutex::new(HashSet::new()));
pub static MAIN_WINDOW: Lazy<Mutex<Option<WebviewWindow>>> = Lazy::new(|| Mutex::new(None));
pub static CANCEL_REQUESTS: Lazy<Mutex<HashSet<String>>> = Lazy::new(|| Mutex::new(HashSet::new()));
pub static IS_PREPARING_PLAYBACK: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

pub fn sys_log(message: &str) {
    println!("{}", message);
    if let Some(window) = MAIN_WINDOW.lock().as_ref() {
        let _ = window.emit("sys-log", message.to_string());
    }
}

// --- Status Types ---

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum Status {
    Pending,
    Downloading,
    Decoding,
    Playing,
    Error,
    Finished,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaybackStatus {
    pub status: Status,
    pub message: String,
}

// --- Streaming Support ---

pub struct StreamingReader {
    pub file: File,
    pub is_youtube: bool,
    pub path: PathBuf,
}

impl StreamingReader {
    pub fn new(path: PathBuf, is_youtube: bool) -> std::io::Result<Self> {
        let file = File::open(&path)?;
        Ok(Self { file, is_youtube, path })
    }
}

impl Read for StreamingReader {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        loop {
            let n = self.file.read(buf)?;
            if n > 0 {
                // println!("[AUDIO_DEBUG] StreamingReader read {} bytes", n);
                return Ok(n);
            } else if self.is_youtube {
                // Check if still downloading
                let still_downloading = {
                    let downloads = ACTIVE_DOWNLOADS.lock();
                    downloads.contains(&self.path)
                };
                
                if still_downloading {
                    std::thread::sleep(std::time::Duration::from_millis(150));
                    continue;
                } else {
                    // Download finished and no more data
                    return Ok(0);
                }
            } else {
                return Ok(0);
            }
        }
    }
}

impl Seek for StreamingReader {
    fn seek(&mut self, pos: SeekFrom) -> std::io::Result<u64> {
        self.file.seek(pos)
    }
}

// --- Custom Audio Sources ---

/// Dynamic volume control source using atomic bits for f32 volume.
pub struct DynamicVolumeSource<S> where S: Source<Item = f32> {
    pub input: S,
    pub volume: Arc<AtomicU32>, // bits of f32
}

impl<S> Iterator for DynamicVolumeSource<S> where S: Source<Item = f32> {
    type Item = f32;
    fn next(&mut self) -> Option<Self::Item> {
        let s = self.input.next()?;
        let vol_bits = self.volume.load(Ordering::Relaxed);
        let vol = f32::from_bits(vol_bits) / 100.0;
        
        // Debug: 샘플이 흘러가는지 확인 (터미널에 너무 많으면 나중에 주석 처리)
        // if s.abs() > 0.1 { println!("[AUDIO_DEBUG] Sample Flow: {:.3}, Vol: {:.2}", s, vol); }
        
        Some(s * vol)
    }
}

impl<S> Source for DynamicVolumeSource<S> where S: Source<Item = f32> {
    fn current_span_len(&self) -> Option<usize> { self.input.current_span_len() }
    fn channels(&self) -> NonZeroU16 { self.input.channels() }
    fn sample_rate(&self) -> NonZeroU32 { self.input.sample_rate() }
    fn total_duration(&self) -> Option<Duration> { self.input.total_duration() }
    fn try_seek(&mut self, pos: Duration) -> Result<(), rodio::source::SeekError> {
        self.input.try_seek(pos)
    }
}

/// Source for real-time pitch and tempo shifting.
pub struct StretchedSource<S> where S: Source<Item = f32> {
    pub input: S,
    pub stretcher: signalsmith_stretch::Stretch,
    pub pitch: Arc<AtomicU32>,
    pub tempo: Arc<AtomicU32>,
    pub pos: Arc<AtomicU64>,
    pub buffer: VecDeque<f32>,
    pub input_channels: usize,
}

impl<S> StretchedSource<S> where S: Source<Item = f32> {
    pub fn new(input: S, pitch: Arc<AtomicU32>, tempo: Arc<AtomicU32>, pos: Arc<AtomicU64>) -> Self {
        let channels = input.channels().get() as u32;
        let rate = input.sample_rate().get();
        Self {
            input,
            stretcher: signalsmith_stretch::Stretch::preset_default(channels, rate),
            pitch,
            tempo,
            pos,
            buffer: VecDeque::new(),
            input_channels: channels as usize,
        }
    }
}

impl<S> Iterator for StretchedSource<S> where S: Source<Item = f32> {
    type Item = f32;

    fn next(&mut self) -> Option<Self::Item> {
        // 1. Pop from buffer if available
        if let Some(s) = self.buffer.pop_front() {
            if self.buffer.len() % self.input_channels == 0 {
                self.pos.fetch_add(1, Ordering::Relaxed);
            }
            return Some(s);
        }

        // 2. Read parameters
        let pitch_semitones = f32::from_bits(self.pitch.load(Ordering::Relaxed));
        let tempo_scale = f32::from_bits(self.tempo.load(Ordering::Relaxed));

        // 3. Read input block
        let block_size = 1024;
        let mut input_interleaved: Vec<f32> = Vec::with_capacity(block_size * self.input_channels);
        for _ in 0..block_size {
            for _ in 0..self.input_channels {
                if let Some(s) = self.input.next() {
                    input_interleaved.push(s);
                }
            }
        }

        let frames_read = input_interleaved.len() / self.input_channels;
        if frames_read == 0 { 
            println!("[AUDIO_DEBUG] EOF reached in StretchedSource");
            return None; 
        }

        if pitch_semitones != 0.0 || (tempo_scale - 1.0).abs() > 0.001 {
            println!("[AUDIO_DEBUG] Processing frames: {}, Pitch: {:.2}, Tempo: {:.2}", frames_read, pitch_semitones, tempo_scale);
        }

        // 4. Processing logic
        if pitch_semitones == 0.0 && (tempo_scale - 1.0).abs() < 0.001 {
            // Bypass mode: 소리가 아예 안 난다면 이 루프가 문제일 수 있음
            for s in &input_interleaved {
                self.buffer.push_back(*s);
            }
            // println!("[AUDIO_DEBUG] Bypass mode: {} samples buffered", input_interleaved.len());
        } else {
            // Stretch mode
            let pitch_factor = 2.0f32.powf(pitch_semitones / 12.0);
            self.stretcher.set_transpose_factor(pitch_factor, None);
            
            // 안정적인 출력 버퍼 크기 계산 (충분한 공간 확보)
            let output_frames_est = (frames_read as f32 / tempo_scale).ceil() as usize + 64;
            let mut output_interleaved = vec![0.0; output_frames_est * self.input_channels];
            
            self.stretcher.process(&input_interleaved, &mut output_interleaved);
            // println!("[AUDIO_DEBUG] Stretched block: {} -> {} frames", frames_read, output_frames_est);
            
            for s in output_interleaved {
                self.buffer.push_back(s);
            }
        }

        // 5. Return first sample from new buffer
        self.buffer.pop_front().map(|s| {
            if self.buffer.len() % self.input_channels == 0 {
                self.pos.fetch_add(1, Ordering::Relaxed);
            }
            s
        })
    }
}

impl<S> Source for StretchedSource<S> where S: Source<Item = f32> {
    fn current_span_len(&self) -> Option<usize> { None }
    fn channels(&self) -> NonZeroU16 { NonZeroU16::new(self.input_channels as u16).unwrap() }
    fn sample_rate(&self) -> NonZeroU32 { self.input.sample_rate() }
    fn total_duration(&self) -> Option<Duration> { self.input.total_duration() }
    fn try_seek(&mut self, pos: Duration) -> Result<(), rodio::source::SeekError> {
        self.input.try_seek(pos)?;
        self.buffer.clear();
        self.stretcher.reset();
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaybackProgress {
    pub position_ms: u64,
    pub duration_ms: u64,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct SeekToArgs {
    pub position_ms: u64,
}

// --- App Handler Struct ---

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

pub type OSStream = rodio::MixerDeviceSink;
pub type PlaybackController = rodio::Player;

pub struct AudioHandler {
    pub _stream: OSStream, // Keep alive
    pub controller: Mutex<PlaybackController>,
    pub state: Mutex<AppState>,
    pub active_pitch: Arc<AtomicU32>,
    pub active_tempo: Arc<AtomicU32>,
    pub current_pos_samples: Arc<AtomicU64>,
    pub total_duration_ms: Arc<AtomicU64>,
    pub active_sample_rate: u32,
    pub active_channels: u16,
    pub track_sample_rate: Arc<AtomicU32>,
    pub vocal_volume: Arc<AtomicU32>, // 0-100
    pub instrumental_volume: Arc<AtomicU32>,
    pub playback_cv: parking_lot::Condvar,
}

pub static AUDIO_HANDLER: Lazy<Result<Arc<AudioHandler>, String>> = Lazy::new(|| {
    let stream_result: Result<rodio::MixerDeviceSink, _> = rodio::DeviceSinkBuilder::open_default_sink();
    let stream = match stream_result {
        Ok(s) => s,
        Err(e) => {
            let err_msg = format!("오디오 출력을 열지 못했습니다: {}", e);
            sys_log(&format!("[AUDIO] CRITICAL ERROR: {}", err_msg));
            return Err(err_msg);
        }
    };
    
    let host = cpal::default_host();
    let device: Option<cpal::Device> = host.default_output_device();
    let device_name = match device.as_ref() {
        Some(d) => d.name().unwrap_or_else(|_| "Unknown Device".to_string()),
        None => "Unknown Device".to_string(),
    };
    
    let (mut device_rate, mut device_channels) = if let Some(ref d) = device {
        let config_res: Result<cpal::SupportedStreamConfig, _> = d.default_output_config();
        if let Ok(config) = config_res {
            (u32::from(config.sample_rate()), config.channels() as u16)
        } else { (44100, 2) }
    } else { (44100, 2) };

    if device_rate == 0 { device_rate = 44100; }
    if device_channels == 0 { device_channels = 2; }

    sys_log(&format!("[AUDIO] Device Initialized: {} ({}Hz, {}ch)", device_name, device_rate, device_channels));
    
    let controller = Player::connect_new(&stream.mixer());
    Ok(Arc::new(AudioHandler {
        _stream: stream,
        controller: Mutex::new(controller),
        state: Mutex::new(AppState::default()),
        active_pitch: Arc::new(AtomicU32::new(0f32.to_bits())),
        active_tempo: Arc::new(AtomicU32::new(1.0f32.to_bits())),
        current_pos_samples: Arc::new(AtomicU64::new(0)),
        total_duration_ms: Arc::new(AtomicU64::new(0)),
        active_sample_rate: device_rate,
        active_channels: device_channels,
        track_sample_rate: Arc::new(AtomicU32::new(device_rate)),
        vocal_volume: Arc::new(AtomicU32::new(80.0f32.to_bits())),
        instrumental_volume: Arc::new(AtomicU32::new(100.0f32.to_bits())),
        playback_cv: parking_lot::Condvar::new(),
    }))
});
