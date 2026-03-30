use std::collections::VecDeque;
use std::fs::File;
use std::io::BufReader;
use std::num::{NonZeroU16, NonZeroU32};
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use rodio::source::{Source, UniformSourceIterator};
use rodio::{Decoder, Sample, Sink};
use parking_lot::{Condvar, Mutex};
use cpal::traits::{DeviceTrait, HostTrait};

use crate::state::{AUDIO_HANDLER, AppState};

// --- Audio Handler Struct ---

pub struct AudioHandler {
    pub sink: Mutex<Sink>,
    pub state: Mutex<AppState>,
    pub active_pitch: Arc<AtomicU32>, // bits of f32
    pub active_tempo: Arc<AtomicU32>, // bits of f32
    pub current_pos_samples: Arc<AtomicU64>,
    pub active_sample_rate: u32,
    pub active_channels: u16,
    pub vocal_volume: Arc<AtomicU32>,      // 0-100
    pub instrumental_volume: Arc<AtomicU32>, // 0-100
    pub playback_cv: Condvar,
}

// --- Custom Audio Sources for Processing ---

// Source for applying dynamic volume control
pub struct DynamicVolumeSource<S>
where
    S: Source,
    S::Item: Sample,
{
    input: S,
    volume: Arc<AtomicU32>,
}

impl<S> DynamicVolumeSource<S>
where
    S: Source,
    S::Item: Sample,
{
    pub fn new(input: S, volume: Arc<AtomicU32>) -> Self {
        Self { input, volume }
    }
}


impl<S> Iterator for DynamicVolumeSource<S>
where
    S: Source,
    S::Item: Sample,
{
    type Item = S::Item;

    fn next(&mut self) -> Option<Self::Item> {
        let sample = self.input.next()?;
        let vol = self.volume.load(Ordering::Relaxed) as f32 / 100.0;
        Some(sample.amplify(vol))
    }
}

impl<S> Source for DynamicVolumeSource<S>
where
    S: Source,
    S::Item: Sample,
{
    fn current_frame_len(&self) -> Option<usize> {
        self.input.current_frame_len()
    }
    fn channels(&self) -> u16 {
        self.input.channels()
    }
    fn sample_rate(&self) -> u32 {
        self.input.sample_rate()
    }
    fn total_duration(&self) -> Option<Duration> {
        self.input.total_duration()
    }
}


// Source for applying real-time pitch and tempo shifting
pub struct StretchedSource<S>
where
    S: Source<Item = f32>,
{
    input: UniformSourceIterator<S, f32>,
    stretcher: signalsmith_stretch::Stretch,
    pitch: Arc<AtomicU32>,
    tempo: Arc<AtomicU32>,
    pos_tracker: Arc<AtomicU64>,
    output_buffer: VecDeque<f32>,
    input_channels: usize,
}

impl<S> StretchedSource<S>
where
    S: Source<Item = f32>,
{
    pub fn new(
        input: S,
        pitch: Arc<AtomicU32>,
        tempo: Arc<AtomicU32>,
        pos_tracker: Arc<AtomicU64>,
    ) -> Self {
        let channels = input.channels();
        let sample_rate = input.sample_rate();

        // The stretcher needs a fixed sample rate. We'll resample the input to it.
        // We use UniformSourceIterator to resample and convert to f32 at the same time.
        let resampled_input = UniformSourceIterator::new(input, channels, sample_rate);

        Self {
            input: resampled_input,
            stretcher: signalsmith_stretch::Stretch::preset_default(channels as usize, sample_rate),
            pitch,
            tempo,
            pos_tracker,
            output_buffer: VecDeque::new(),
            input_channels: channels as usize,
        }
    }
}

impl<S> Iterator for StretchedSource<S>
where
    S: Source<Item = f32>,
{
    type Item = f32;

    fn next(&mut self) -> Option<Self::Item> {
        if let Some(sample) = self.output_buffer.pop_front() {
            // Only increment position tracker on the first channel to count frames, not samples
            if self.output_buffer.len() % self.input_channels == 0 {
                 self.pos_tracker.fetch_add(1, Ordering::Relaxed);
            }
            return Some(sample);
        }

        let pitch_semitones = f32::from_bits(self.pitch.load(Ordering::Relaxed));
        let tempo_scale = f32::from_bits(self.tempo.load(Ordering::Relaxed));

        self.stretcher.set_transpose_factor(2.0f32.powf(pitch_semitones / 12.0));
        self.stretcher.set_rate_factor(tempo_scale);

        let block_size = 1024; // Process in blocks
        let mut input_block_interleaved: Vec<f32> = self.input.by_ref().take(block_size * self.input_channels).collect();
        if input_block_interleaved.is_empty() {
            return None; // End of source
        }

        let num_frames = input_block_interleaved.len() / self.input_channels;

        // De-interleave for stretcher
        let mut input_block_deinterleaved: Vec<Vec<f32>> = vec![vec![0.0; num_frames]; self.input_channels];
        for i in 0..num_frames {
            for c in 0..self.input_channels {
                input_block_deinterleaved[c][i] = input_block_interleaved[i * self.input_channels + c];
            }
        }
        
        let output_frames_required = self.stretcher.output_frames_required(num_frames);
        let mut output_block_deinterleaved = vec![vec![0.0; output_frames_required]; self.input_channels];
        
        self.stretcher.process(&input_block_deinterleaved, &mut output_block_deinterleaved);
        
        // Interleave back into the output buffer
        for i in 0..output_frames_required {
            for c in 0..self.input_channels {
                self.output_buffer.push_back(output_block_deinterleaved[c][i]);
            }
        }

        self.output_buffer.pop_front().map(|sample| {
            if self.output_buffer.len() % self.input_channels == 0 {
                 self.pos_tracker.fetch_add(1, Ordering::Relaxed);
            }
            sample
        })
    }
}

impl<S> Source for StretchedSource<S>
where
    S: Source<Item = f32>,
{
    fn current_frame_len(&self) -> Option<usize> {
        None // We are a dynamic-length source
    }
    fn channels(&self) -> u16 {
        self.input_channels as u16
    }
    fn sample_rate(&self) -> u32 {
        self.input.sample_rate()
    }
    fn total_duration(&self) -> Option<Duration> {
        None // Duration is dynamic due to tempo changes
    }
}
