use std::collections::{VecDeque, HashSet, HashMap};
use std::fs::{File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::num::{NonZeroU16, NonZeroU32};
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;
use std::path::PathBuf;

use rodio::source::{SeekError, UniformSourceIterator};
use rodio::{Source, Player, MixerDeviceSink, DeviceSinkBuilder};
use rubato::{FastFixedIn, PolynomialDegree, Resampler};
use crate::types::AppState;
use parking_lot::Mutex;
use once_cell::sync::Lazy;
use tauri::Emitter;
use cpal::traits::{HostTrait, DeviceTrait};

pub static ACTIVE_DOWNLOADS: Lazy<Mutex<HashSet<PathBuf>>> = Lazy::new(|| Mutex::new(HashSet::new()));
pub static DOWNLOAD_FINISHED_NOTIFIER: Lazy<Mutex<HashMap<PathBuf, Arc<tokio::sync::Notify>>>> = Lazy::new(|| Mutex::new(HashMap::new()));
pub static DOWNLOAD_ERRORS: Lazy<Mutex<HashMap<PathBuf, String>>> = Lazy::new(|| Mutex::new(HashMap::new()));
pub static CANCEL_REQUESTS: Lazy<Mutex<HashSet<String>>> = Lazy::new(|| Mutex::new(HashSet::new()));
pub static IS_PREPARING_PLAYBACK: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

fn append_sys_log_file(message: &str) {
    let log_path = {
        if let Some(paths) = crate::state::APP_PATHS.lock().as_ref() {
            paths.root.join("logs").join("app.log")
        } else {
            let base = std::env::temp_dir().join("live-mr-manager");
            base.join("logs").join("app.log")
        }
    };

    if let Some(parent) = log_path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }

    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(log_path) {
        let _ = writeln!(f, "[{}] {}", ts, message);
    }
}

pub fn sys_log(message: &str) {
    println!("{}", message);
    append_sys_log_file(message);
    if let Some(guard) = crate::state::MAIN_WINDOW.try_lock() {
        if let Some(window) = guard.as_ref() {
            let _ = window.emit("sys-log", message.to_string());
        }
    }
}

// --- Status types are now in types.rs ---

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
    pub volume: Arc<AtomicU32>, // Shared target volume (bits of f32)
    pub current_vol: f32,       // Internal state for fading
}

impl<S> DynamicVolumeSource<S> where S: Source<Item = f32> {
    pub fn new(input: S, volume: Arc<AtomicU32>) -> Self {
        Self {
            input,
            volume,
            current_vol: 0.0,
        }
    }
}

impl<S> Iterator for DynamicVolumeSource<S> where S: Source<Item = f32> {
    type Item = f32;
    fn next(&mut self) -> Option<Self::Item> {
        let s = self.input.next()?;
        let target_vol_bits = self.volume.load(Ordering::Relaxed);
        let target_vol = f32::from_bits(target_vol_bits) / 125.0; // Linear scale for tracks to avoid nested quadratic drop
        
        // Smoothly interpolate current_vol towards target_vol

        // Smoothly interpolate current_vol towards target_vol
        // Fade duration: 100ms
        const FADE_DURATION: f32 = 0.1; 
        let sample_rate = self.input.sample_rate().get() as f32;
        let step = 1.0 / (sample_rate * FADE_DURATION);

        if (self.current_vol - target_vol).abs() > step {
            if self.current_vol < target_vol {
                self.current_vol += step;
            } else {
                self.current_vol -= step;
            }
        } else {
            self.current_vol = target_vol;
        }
        
        Some(s * self.current_vol)
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
    pub remainder_frames: f32, // For precise tempo matching
    pub remainder_pos: f32,    // For precise progress reporting
    pub last_pitch: f32,       // For caching
    pub last_tempo: f32,       // For caching
    pub output_buffer: Vec<f32>, // Reusable buffer to avoid allocations
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
            remainder_frames: 0.0,
            remainder_pos: 0.0,
            last_pitch: 0.0,
            last_tempo: 1.0,
            output_buffer: Vec::with_capacity(2048 * channels as usize), // Pre-allocate enough space
        }
    }
}

impl<S> Iterator for StretchedSource<S> where S: Source<Item = f32> {
    type Item = f32;

    fn next(&mut self) -> Option<Self::Item> {
        let pitch_semitones = f32::from_bits(self.pitch.load(Ordering::Relaxed));
        let tempo_scale = f32::from_bits(self.tempo.load(Ordering::Relaxed)).max(0.1); // Prevent div by zero

        // 1. Pop from buffer if available
        if let Some(s) = self.buffer.pop_front() {
            // Track progress relative to the output samples
            // For every output sample, we've "traversed" tempo_scale worth of original samples
            if self.buffer.len() % self.input_channels == 0 {
                self.remainder_pos += tempo_scale;
                let whole_samples = self.remainder_pos.floor();
                if whole_samples >= 1.0 {
                    self.pos.fetch_add(whole_samples as u64, Ordering::Relaxed);
                    self.remainder_pos -= whole_samples;
                }
            }
            return Some(s);
        }

        // 2. Read input block
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
        if frames_read == 0 { return None; }

        // 3. Stretch or Bypass
        if pitch_semitones == 0.0 && (tempo_scale - 1.0).abs() < 0.001 {
            // Bypass mode
            for s in input_interleaved {
                self.buffer.push_back(s);
            }
            self.remainder_frames = 0.0; // Reset error
            self.last_pitch = 0.0;
            self.last_tempo = 1.0;
        } else {
            // Stretch mode
            // Only update pitch if it changed significantly
            if (pitch_semitones - self.last_pitch).abs() > 0.01 {
                let pitch_factor = 2.0f32.powf(pitch_semitones / 12.0);
                self.stretcher.set_transpose_factor(pitch_factor, None);
                self.last_pitch = pitch_semitones;
            }
            self.last_tempo = tempo_scale;
            
            // Calculate precise output frames with error diffusion
            let total_needed = (frames_read as f32 / tempo_scale) + self.remainder_frames;
            let output_frames = total_needed.floor() as usize;
            self.remainder_frames = total_needed - output_frames as f32;
            
            if output_frames > 0 {
                // Resize internal buffer if needed (usually stays constant)
                let needed_samples = output_frames * self.input_channels;
                if self.output_buffer.len() < needed_samples {
                    self.output_buffer.resize(needed_samples, 0.0);
                }
                
                // Use slice of internal buffer directly
                let target_slice = &mut self.output_buffer[0..needed_samples];
                self.stretcher.process(&input_interleaved, target_slice);
                
                // Re-borrow for the loop
                for &s in self.output_buffer[0..needed_samples].iter() {
                    self.buffer.push_back(s);
                }
            }
        }

        // 4. Return first sample from new buffer
        self.buffer.pop_front().map(|s| {
            if self.buffer.len() % self.input_channels == 0 {
                self.remainder_pos += tempo_scale;
                let whole_samples = self.remainder_pos.floor();
                if whole_samples >= 1.0 {
                    self.pos.fetch_add(whole_samples as u64, Ordering::Relaxed);
                    self.remainder_pos -= whole_samples;
                }
            }
            s
        })
    }
}

impl<S> Source for StretchedSource<S> where S: Source<Item = f32> {
    #[allow(deprecated)]
    fn current_span_len(&self) -> Option<usize> { None }
    fn channels(&self) -> std::num::NonZeroU16 { std::num::NonZeroU16::new((self.input_channels as u16).max(1)).unwrap() }
    fn sample_rate(&self) -> std::num::NonZeroU32 { self.input.sample_rate() }
    fn total_duration(&self) -> Option<Duration> { self.input.total_duration() }
    fn try_seek(&mut self, pos: Duration) -> Result<(), rodio::source::SeekError> {
        self.input.try_seek(pos)?;
        self.buffer.clear();
        self.stretcher.reset();
        self.remainder_frames = 0.0;
        self.remainder_pos = 0.0;
        Ok(())
    }
}

const PLAYBACK_RESAMPLE_CHUNK: usize = 1024;

/// Plays at the device rate. Matching rates skip conversion. A mismatch uses
/// rubato's septic polynomial instead of rodio's linear interpolator, which
/// dulls 44.1 kHz YouTube audio on a 48 kHz device and drops samples the other way.
pub fn to_device_format<S>(
    source: S,
    target_channels: NonZeroU16,
    target_rate: NonZeroU32,
) -> UniformSourceIterator<DeviceRateSource<S>>
where
    S: Source<Item = f32>,
{
    let source_rate = source.sample_rate();
    let source_channels = source.channels();
    let inner = if source_rate == target_rate {
        sys_log(&format!(
            "[AUDIO] Playback rate {source_rate} Hz matches device, skip resample ({source_channels} ch -> {target_channels} ch)"
        ));
        DeviceRateSource::Passthrough(source)
    } else {
        sys_log(&format!(
            "[AUDIO] Resample {source_rate} Hz -> {target_rate} Hz via rubato ({source_channels} ch -> {target_channels} ch)"
        ));
        DeviceRateSource::Resampled(RubatoResample::new(source, target_rate))
    };
    UniformSourceIterator::new(inner, target_channels, target_rate)
}

pub enum DeviceRateSource<S> {
    Passthrough(S),
    Resampled(RubatoResample<S>),
}

pub struct RubatoResample<S> {
    input: S,
    resampler: FastFixedIn<f32>,
    channels: usize,
    target_rate: NonZeroU32,
    chunk_size: usize,
    in_planar: Vec<Vec<f32>>,
    in_fill: usize,
    out_planar: Vec<Vec<f32>>,
    pending: VecDeque<f32>,
    input_ended: bool,
    flushed: bool,
    produced: bool,
}

impl<S> RubatoResample<S>
where
    S: Source<Item = f32>,
{
    fn new(input: S, target_rate: NonZeroU32) -> Self {
        let channels = input.channels().get() as usize;
        let source_rate = input.sample_rate().get();
        let ratio = f64::from(target_rate.get()) / f64::from(source_rate);
        let resampler = FastFixedIn::<f32>::new(
            ratio,
            1.0,
            PolynomialDegree::Septic,
            PLAYBACK_RESAMPLE_CHUNK,
            channels,
        )
        .expect("playback resample ratio is derived from non-zero rates");
        let out_len = resampler.output_frames_max().max(1);
        Self {
            input,
            resampler,
            channels,
            target_rate,
            chunk_size: PLAYBACK_RESAMPLE_CHUNK,
            in_planar: vec![vec![0.0; PLAYBACK_RESAMPLE_CHUNK]; channels],
            in_fill: 0,
            out_planar: vec![vec![0.0; out_len]; channels],
            pending: VecDeque::new(),
            input_ended: false,
            flushed: false,
            produced: false,
        }
    }

    fn reset_state(&mut self) {
        self.resampler.reset();
        self.in_fill = 0;
        self.pending.clear();
        self.input_ended = false;
        self.flushed = false;
        self.produced = false;
    }

    fn read_frame(&mut self) -> bool {
        for channel in 0..self.channels {
            match self.input.next() {
                Some(sample) => self.in_planar[channel][self.in_fill] = sample,
                None => {
                    self.input_ended = true;
                    return false;
                }
            }
        }
        self.in_fill += 1;
        true
    }

    fn enqueue_planar(&mut self, wave: &[Vec<f32>], frames: usize) {
        let frames = frames.min(wave.first().map(|channel| channel.len()).unwrap_or(0));
        for frame in 0..frames {
            for channel in 0..self.channels {
                self.pending.push_back(wave[channel][frame]);
            }
        }
    }

    fn process_full(&mut self) {
        let result =
            self.resampler
                .process_into_buffer(&self.in_planar, &mut self.out_planar, None);
        self.in_fill = 0;
        match result {
            Ok((_, frames)) => {
                self.produced = true;
                let frames = frames.min(
                    self.out_planar
                        .first()
                        .map(|channel| channel.len())
                        .unwrap_or(0),
                );
                for frame in 0..frames {
                    for channel in 0..self.channels {
                        let sample = self.out_planar[channel][frame];
                        self.pending.push_back(sample);
                    }
                }
            }
            Err(err) => {
                sys_log(&format!("[AUDIO] Resample failed: {err}"));
                self.flushed = true;
            }
        }
    }

    fn flush_tail(&mut self, frames: usize) {
        self.flushed = true;
        if frames == 0 && !self.produced {
            return;
        }
        let produced = if frames == 0 {
            self.resampler.process_partial::<Vec<f32>>(None, None)
        } else {
            let partial: Vec<Vec<f32>> = self
                .in_planar
                .iter()
                .map(|channel| channel[..frames].to_vec())
                .collect();
            self.in_fill = 0;
            self.resampler
                .process_partial(Some(partial.as_slice()), None)
        };
        self.in_fill = 0;
        match produced {
            Ok(wave) => {
                let count = wave.first().map(|channel| channel.len()).unwrap_or(0);
                self.enqueue_planar(&wave, count);
            }
            Err(err) => sys_log(&format!("[AUDIO] Resample tail failed: {err}")),
        }
    }

    fn pull_chunk(&mut self) {
        if self.flushed {
            return;
        }
        if self.input_ended {
            self.flush_tail(self.in_fill);
            return;
        }
        while self.in_fill < self.chunk_size {
            if !self.read_frame() {
                self.flush_tail(self.in_fill);
                return;
            }
        }
        self.process_full();
    }
}

impl<S> Iterator for RubatoResample<S>
where
    S: Source<Item = f32>,
{
    type Item = f32;

    fn next(&mut self) -> Option<Self::Item> {
        if self.pending.is_empty() {
            self.pull_chunk();
        }
        self.pending.pop_front()
    }
}

impl<S> Source for RubatoResample<S>
where
    S: Source<Item = f32>,
{
    fn current_span_len(&self) -> Option<usize> {
        None
    }

    fn channels(&self) -> NonZeroU16 {
        NonZeroU16::new(self.channels as u16).unwrap_or(NonZeroU16::MIN)
    }

    fn sample_rate(&self) -> NonZeroU32 {
        self.target_rate
    }

    fn total_duration(&self) -> Option<Duration> {
        self.input.total_duration()
    }

    fn try_seek(&mut self, pos: Duration) -> Result<(), SeekError> {
        self.input.try_seek(pos)?;
        self.reset_state();
        Ok(())
    }
}

impl<S> Iterator for DeviceRateSource<S>
where
    S: Source<Item = f32>,
{
    type Item = f32;

    fn next(&mut self) -> Option<Self::Item> {
        match self {
            Self::Passthrough(source) => source.next(),
            Self::Resampled(source) => source.next(),
        }
    }
}

impl<S> Source for DeviceRateSource<S>
where
    S: Source<Item = f32>,
{
    fn current_span_len(&self) -> Option<usize> {
        match self {
            Self::Passthrough(source) => source.current_span_len(),
            Self::Resampled(source) => source.current_span_len(),
        }
    }

    fn channels(&self) -> NonZeroU16 {
        match self {
            Self::Passthrough(source) => source.channels(),
            Self::Resampled(source) => source.channels(),
        }
    }

    fn sample_rate(&self) -> NonZeroU32 {
        match self {
            Self::Passthrough(source) => source.sample_rate(),
            Self::Resampled(source) => source.sample_rate(),
        }
    }

    fn total_duration(&self) -> Option<Duration> {
        match self {
            Self::Passthrough(source) => source.total_duration(),
            Self::Resampled(source) => source.total_duration(),
        }
    }

    fn try_seek(&mut self, pos: Duration) -> Result<(), SeekError> {
        match self {
            Self::Passthrough(source) => source.try_seek(pos),
            Self::Resampled(source) => source.try_seek(pos),
        }
    }
}

// --- PlaybackProgress and SeekToArgs are in types.rs or defined locally ---
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct SeekToArgs {
    pub position_ms: u64,
}

// --- App Handler Struct ---

// --- AppState is in types.rs ---

pub struct AudioHandler {
    pub _stream: MixerDeviceSink, // Keep alive
    pub controller: Mutex<Player>,
    pub state: Mutex<AppState>,
    pub active_pitch: Arc<AtomicU32>,
    pub active_tempo: Arc<AtomicU32>,
    pub current_pos_samples: Arc<AtomicU64>,
    pub total_duration_ms: Arc<AtomicU64>,
    pub active_sample_rate: u32,
    pub active_channels: u16,
    pub track_sample_rate: Arc<AtomicU32>,
    pub vocal_volume: Arc<AtomicU32>, // f32 bits
    pub instrumental_volume: Arc<AtomicU32>, // f32 bits
    pub playback_cv: parking_lot::Condvar,
}

pub static AUDIO_HANDLER: Lazy<Result<Arc<AudioHandler>, String>> = Lazy::new(|| {
    let stream = match DeviceSinkBuilder::open_default_sink() {
        Ok(s) => s,
        Err(e) => return Err(format!("오디오 출력을 열지 못했습니다: {}", e)),
    };
    
    let host = cpal::default_host();
    let device = host.default_output_device();
    let device_name = match device.as_ref() {
        #[allow(deprecated)]
        Some(d) => d.name().unwrap_or_else(|_| "Unknown Device".into()),
        None => "Unknown Device".to_string(),
    };
    
    let (mut device_rate, mut device_channels) = if let Some(ref d) = device {
        let config_res = d.default_output_config();
        if let Ok(config) = config_res {
            (u32::from(config.sample_rate()), config.channels() as u16)
        } else { (44100, 2) }
    } else { (44100, 2) };

    if device_rate == 0 { device_rate = 44100; }
    if device_channels == 0 { device_channels = 2; }

    sys_log(&format!("[AUDIO] Device Initialized: {} ({}Hz, {}ch)", device_name, device_rate, device_channels));
    
    let player = Player::connect_new(&stream.mixer());

    Ok(Arc::new(AudioHandler {
        _stream: stream,
        controller: Mutex::new(player),
        state: Mutex::new(AppState::default()),
        active_pitch: Arc::new(AtomicU32::new(0f32.to_bits())),
        active_tempo: Arc::new(AtomicU32::new(1.0f32.to_bits())),
        current_pos_samples: Arc::new(AtomicU64::new(0)),
        total_duration_ms: Arc::new(AtomicU64::new(0)),
        active_sample_rate: device_rate,
        active_channels: device_channels,
        track_sample_rate: Arc::new(AtomicU32::new(device_rate)),
        vocal_volume: Arc::new(AtomicU32::new(100.0f32.to_bits())),
        instrumental_volume: Arc::new(AtomicU32::new(100.0f32.to_bits())),
        playback_cv: parking_lot::Condvar::new(),
    }))
});

#[cfg(test)]
mod playback_resample_tests {
    use super::to_device_format;
    use rodio::Source;
    use std::num::{NonZeroU16, NonZeroU32};
    use std::time::Duration;

    struct Tone {
        samples: Vec<f32>,
        pos: usize,
        channels: u16,
        rate: u32,
    }

    impl Iterator for Tone {
        type Item = f32;
        fn next(&mut self) -> Option<Self::Item> {
            let sample = *self.samples.get(self.pos)?;
            self.pos += 1;
            Some(sample)
        }
    }

    impl Source for Tone {
        fn current_span_len(&self) -> Option<usize> {
            None
        }
        fn channels(&self) -> NonZeroU16 {
            NonZeroU16::new(self.channels).unwrap()
        }
        fn sample_rate(&self) -> NonZeroU32 {
            NonZeroU32::new(self.rate).unwrap()
        }
        fn total_duration(&self) -> Option<Duration> {
            None
        }
    }

    fn collect_resampled(samples: Vec<f32>, channels: u16, from: u32, to: u32) -> Vec<f32> {
        let tone = Tone {
            samples,
            pos: 0,
            channels,
            rate: from,
        };
        to_device_format(
            tone,
            NonZeroU16::new(channels).unwrap(),
            NonZeroU32::new(to).unwrap(),
        )
        .collect()
    }

    fn assert_no_clicks(samples: &[f32], steady_end: usize) {
        let end = steady_end.min(samples.len());
        assert!(end > 512, "resampled output too short: {}", samples.len());
        let steady = &samples[64..end];
        let mut peak = 0.0f32;
        for pair in steady.windows(2) {
            peak = peak.max((pair[1] - pair[0]).abs());
        }
        assert!(
            peak < 0.2,
            "sample step {peak} looks like a chunk-boundary click"
        );
        let energy = steady.iter().map(|s| s * s).sum::<f32>() / steady.len() as f32;
        assert!(
            energy > 0.05,
            "resampler collapsed the signal: rms2={energy}"
        );
    }

    #[test]
    fn upsample_44100_to_48000_keeps_a_smooth_sine() {
        let frames = 4096;
        let samples: Vec<f32> = (0..frames)
            .map(|i| (2.0 * std::f32::consts::PI * 440.0 * i as f32 / 44100.0).sin() * 0.5)
            .collect();
        let out = collect_resampled(samples, 1, 44100, 48000);
        let steady_end = (frames as f64 * 48000.0 / 44100.0) as usize - 64;
        assert_no_clicks(&out, steady_end);
    }

    #[test]
    fn downsample_48000_to_44100_keeps_a_smooth_sine() {
        let frames = 4096;
        let samples: Vec<f32> = (0..frames)
            .map(|i| (2.0 * std::f32::consts::PI * 440.0 * i as f32 / 48000.0).sin() * 0.5)
            .collect();
        let out = collect_resampled(samples, 1, 48000, 44100);
        let steady_end = (frames as f64 * 44100.0 / 48000.0) as usize - 64;
        assert_no_clicks(&out, steady_end);
    }

    #[test]
    fn matching_rate_copies_samples() {
        let samples: Vec<f32> = (0..128).map(|i| i as f32 / 128.0).collect();
        let out = collect_resampled(samples.clone(), 1, 44100, 44100);
        assert_eq!(out, samples);
    }

    #[test]
    fn stereo_channels_stay_independent() {
        let frames = 2048;
        let mut samples = Vec::with_capacity(frames * 2);
        for _ in 0..frames {
            samples.push(0.25);
            samples.push(-0.5);
        }
        let out = collect_resampled(samples, 2, 44100, 48000);
        let mid = out.len() / 2;
        let left = out[mid - (mid % 2)];
        let right = out[mid - (mid % 2) + 1];
        assert!((left - 0.25).abs() < 0.01, "left {left}");
        assert!((right + 0.5).abs() < 0.01, "right {right}");
    }
}
