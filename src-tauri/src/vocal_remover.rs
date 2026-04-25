use std::path::{Path, PathBuf};
use std::time::Instant;
use std::sync::atomic::{AtomicBool, Ordering};
use ort::session::Session;
use ort::value::{Value, ValueType};
use ndarray::{self, Array4};
use std::sync::Arc;
use parking_lot::Mutex;
use crate::audio_player::sys_log;
use ort::execution_providers::{CUDAExecutionProvider, CPUExecutionProvider};
#[cfg(target_os = "windows")]
use ort::execution_providers::DirectMLExecutionProvider;
#[cfg(target_os = "macos")]
use ort::execution_providers::CoreMLExecutionProvider;
use rustfft::{FftPlanner, num_complex::Complex};
use symphonia::core::formats::FormatOptions;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::io::MediaSourceStream;
use symphonia::core::probe::Hint;
use symphonia::core::audio::{AudioBufferRef, Signal};
use symphonia::core::codecs::DecoderOptions;
use rubato::{Resampler, SincFixedIn, SincInterpolationType, SincInterpolationParameters, WindowFunction};
use anyhow::{anyhow, Result};
const BATCH_SIZE: usize = 4;

pub trait InferenceEngine: Send + Sync {
    fn separate(&self, audio_path: &Path, output_dir: &Path, cancel_flag: Arc<AtomicBool>, on_progress: Box<dyn Fn(f32) + Send>) -> Result<(PathBuf, PathBuf)>;
    fn get_provider(&self) -> String;
    fn get_model_name(&self) -> String;
}

#[derive(Clone)]
pub struct StftEngine {
    n_fft: usize,
    hop_length: usize,
    window: Vec<f32>,
    fft: Arc<dyn rustfft::Fft<f32>>,
    ifft: Arc<dyn rustfft::Fft<f32>>,
}

impl StftEngine {
    pub fn new(n_fft: usize, hop_length: usize) -> Self {
        let mut planner = FftPlanner::new();
        let fft = planner.plan_fft_forward(n_fft);
        let ifft = planner.plan_fft_inverse(n_fft);
        
        let window: Vec<f32> = (0..n_fft)
            .map(|i| 0.5 * (1.0 - (2.0 * std::f32::consts::PI * i as f32 / n_fft as f32).cos()))
            .collect();
            
        Self { n_fft, hop_length, window, fft, ifft }
    }

    pub fn stft_ndarray(&self, samples: &[f32], target_bins: usize) -> ndarray::Array2<Complex<f32>> {
        let num_samples = samples.len();
        let n_fft = self.n_fft;
        let num_frames = if num_samples < n_fft { 0 } else { (num_samples - n_fft) / self.hop_length + 1 };
        
        let mut stft_result = ndarray::Array2::from_elem((num_frames, target_bins), Complex::new(0.0f32, 0.0f32));
        let mut input = vec![Complex::new(0.0f32, 0.0f32); n_fft];

        let throttle = crate::separation::BROADCAST_MODE.load(std::sync::atomic::Ordering::Relaxed);
        for (f_idx, start) in (0..=num_samples.saturating_sub(n_fft)).step_by(self.hop_length).enumerate() {
            if throttle && (f_idx % 2 == 0) { 
                std::thread::sleep(std::time::Duration::from_millis(1)); 
            }
            if f_idx >= num_frames { break; }
            for i in 0..n_fft {
                input[i] = Complex::new(samples[start + i] * self.window[i], 0.0);
            }
            self.fft.process(&mut input);
            
            let n_bins = (n_fft / 2 + 1).min(target_bins);
            for b_idx in 0..n_bins {
                stft_result[[f_idx, b_idx]] = input[b_idx];
            }
        }
        stft_result
    }

    pub fn istft_ndarray(&self, frames: &ndarray::Array2<Complex<f32>>, target_len: usize) -> Vec<f32> {
        let n_fft = self.n_fft;
        let num_frames = frames.shape()[0];
        let max_len = num_frames * self.hop_length + n_fft;
        let mut output = vec![0.0; max_len];
        let mut window_sum = vec![0.0; max_len];
        
        let mut complex_buffer = vec![Complex::new(0.0f32, 0.0f32); n_fft];
        let n_bins_limit = n_fft / 2 + 1;
        let bins_in_frame = frames.shape()[1];

        let throttle = crate::separation::BROADCAST_MODE.load(std::sync::atomic::Ordering::Relaxed);
        for f_idx in 0..num_frames {
            if throttle && (f_idx % 2 == 0) { 
                std::thread::sleep(std::time::Duration::from_millis(1)); 
            }
            let start = f_idx * self.hop_length;
            
            // Reset buffer
            for i in 0..n_fft { complex_buffer[i] = Complex::new(0.0, 0.0); }
            
            for b_idx in 0..bins_in_frame {
                if b_idx < n_bins_limit {
                    let bin = frames[[f_idx, b_idx]];
                    complex_buffer[b_idx] = bin;
                    if b_idx > 0 && b_idx < n_fft / 2 {
                        complex_buffer[n_fft - b_idx] = Complex::new(bin.re, -bin.im);
                    }
                }
            }
            self.ifft.process(&mut complex_buffer);
            
            for i in 0..n_fft {
                if start + i < output.len() {
                    let sample = complex_buffer[i].re / (n_fft as f32);
                    output[start + i] += sample * self.window[i];
                    window_sum[start + i] += self.window[i] * self.window[i];
                }
            }
        }
        
        let mut final_samples = Vec::with_capacity(target_len);
        for i in 0..target_len {
            if i < output.len() {
                if window_sum[i] > 1e-6 {
                    final_samples.push(output[i] / window_sum[i]);
                } else {
                    final_samples.push(output[i]);
                }
            } else {
                final_samples.push(0.0);
            }
        }

        // Final samples normalization is no longer needed here as OLA handles it.
        // Fading at the boundaries of each chunk is removed to ensure phase consistency for OLA.
        final_samples
    }

    pub fn stft(&self, samples: &[f32], target_bins: usize) -> Vec<Vec<[f32; 2]>> {
        let num_samples = samples.len();
        let n_fft = self.n_fft;
        let num_frames = if num_samples < n_fft { 0 } else { (num_samples - n_fft) / self.hop_length + 1 };
        let mut stft_result = Vec::with_capacity(num_frames);
        
        let mut input = vec![Complex::new(0.0f32, 0.0f32); n_fft];

        let throttle = crate::separation::BROADCAST_MODE.load(std::sync::atomic::Ordering::Relaxed);
        for (f_idx, start) in (0..=num_samples.saturating_sub(n_fft)).step_by(self.hop_length).enumerate() {
            if throttle && (f_idx % 4 == 0) { std::thread::yield_now(); }
            for i in 0..n_fft {
                input[i] = Complex::new(samples[start + i] * self.window[i], 0.0);
            }
            self.fft.process(&mut input);
            
            let mut frame = Vec::with_capacity(target_bins);
            let n_bins = (n_fft / 2 + 1).min(target_bins);
            for i in 0..n_bins {
                frame.push([input[i].re, input[i].im]);
            }
            // Fill remaining bins if target_bins > n_bins
            for _ in n_bins..target_bins {
                frame.push([0.0, 0.0]);
            }
            stft_result.push(frame);
        }
        stft_result
    }

    pub fn istft(&self, frames: &Vec<Vec<[f32; 2]>>, target_len: usize) -> Vec<f32> {
        let n_fft = self.n_fft;
        let num_frames = frames.len();
        let max_len = num_frames * self.hop_length + n_fft;
        let mut output = vec![0.0; max_len];
        let mut window_sum = vec![0.0; max_len];
        
        let mut complex_buffer = vec![Complex::new(0.0f32, 0.0f32); n_fft];
        let n_bins_limit = n_fft / 2 + 1;

        let throttle = crate::separation::BROADCAST_MODE.load(std::sync::atomic::Ordering::Relaxed);
        for (f_idx, frame) in frames.iter().enumerate() {
            if throttle && (f_idx % 4 == 0) { std::thread::yield_now(); }
            let start = f_idx * self.hop_length;
            
            // Reset buffer
            for i in 0..n_fft { complex_buffer[i] = Complex::new(0.0, 0.0); }
            
            for (i, &bin) in frame.iter().enumerate() {
                if i < n_bins_limit {
                    complex_buffer[i] = Complex::new(bin[0], bin[1]);
                    if i > 0 && i < n_fft / 2 {
                        complex_buffer[n_fft - i] = Complex::new(bin[0], -bin[1]);
                    }
                }
            }
            self.ifft.process(&mut complex_buffer);
            
            for i in 0..n_fft {
                if start + i < output.len() {
                    let sample = complex_buffer[i].re / (n_fft as f32);
                    output[start + i] += sample * self.window[i];
                    window_sum[start + i] += self.window[i] * self.window[i];
                }
            }
        }
        
        let mut final_samples = Vec::with_capacity(target_len);
        for i in 0..target_len {
            if i < output.len() {
                if window_sum[i] > 1e-6 {
                    final_samples.push(output[i] / window_sum[i]);
                } else {
                    final_samples.push(output[i]);
                }
            } else {
                final_samples.push(0.0);
            }
        }

        // Fading at the boundaries of each chunk is removed to ensure phase consistency for OLA.
        final_samples
    }
}

#[derive(Clone)]
pub struct WaveformRemover {
    session: Arc<Mutex<Session>>,
    model_name: String,
    active_provider: String,
}

impl WaveformRemover {
    pub fn new(model_path: &Path) -> Result<Self> {
        let threads = (num_cpus::get() / 2).max(1).min(4);
        sys_log(&format!("[AI-ENGINE] Initializing with {} intra-op threads", threads));

        let mut providers_to_try = Vec::new();
        #[cfg(target_os = "windows")]
        {
            // Windows default GPU path.
            providers_to_try.push(("GPU (DirectML)", DirectMLExecutionProvider::default().build()));
        }
        #[cfg(target_os = "macos")]
        {
            // macOS acceleration path.
            providers_to_try.push(("GPU (CoreML)", CoreMLExecutionProvider::default().build()));
        }
        providers_to_try.push((
            "GPU (CUDA)",
            CUDAExecutionProvider::default().with_device_id(0).build(),
        ));
        providers_to_try.push(("CPU", CPUExecutionProvider::default().build()));

        let mut session_opt = None;
        let mut active_provider = "Unknown".to_string();

        for (name, ep) in providers_to_try {
            let session_res: Result<Session, ort::Error> = (|| {
                Session::builder()?
                    .with_intra_threads(threads)?
                    .with_optimization_level(ort::session::builder::GraphOptimizationLevel::Level3)?
                    .with_execution_providers([ep])?
                    .commit_from_file(model_path)
            })();

            match session_res {
                Ok(session) => {
                    session_opt = Some(session);
                    active_provider = name.to_string();
                    break;
                }
                Err(e) => {
                    sys_log(&format!("[AI-ENGINE] Provider {} failed or unavailable: {}", name, e));
                }
            }
        }

        let session = session_opt.ok_or_else(|| anyhow!("[AI-ENGINE] Failed to initialize any execution provider"))?;
        let model_name = model_path.file_name().and_then(|n| n.to_str()).unwrap_or("unknown").to_string();
        
        sys_log(&format!("[AI-ENGINE] Model loaded: {}, Provider: {}", model_name, active_provider));
        Ok(Self { session: Arc::new(Mutex::new(session)), model_name, active_provider })
    }
}

impl InferenceEngine for WaveformRemover {
    fn get_provider(&self) -> String {
        self.active_provider.clone()
    }
    fn get_model_name(&self) -> String {
        self.model_name.clone()
    }
    fn separate(&self, audio_path: &Path, output_dir: &Path, cancel_flag: Arc<AtomicBool>, on_progress: Box<dyn Fn(f32) + Send>) -> Result<(PathBuf, PathBuf)> {
        let start_time = Instant::now();
        sys_log(&format!("DEBUG: [WaveformRemover] Starting advanced separation for: {:?}. Using: {}", audio_path, self.active_provider));
        
        if !output_dir.exists() {
            std::fs::create_dir_all(output_dir)?;
        }

        // 1. Load and Resample (always to 44.1kHz for these models)
        let load_and_resample_start = Instant::now();
        let (raw_samples, sample_rate, channels) = self.load_any_audio(audio_path)?;
        
        // Normalize path for reliable cancellation check (ignore slash direction and case)
        let path_str = audio_path.to_string_lossy().to_string().replace("\\", "/").to_lowercase();
        
        let is_cancelled = || {
            cancel_flag.load(Ordering::Relaxed) || crate::audio_player::CANCEL_REQUESTS.lock().contains(&path_str)
        };

        if is_cancelled() {
            return Err(anyhow!("Cancelled before processing"));
        }

        let target_sample_rate = 44100;
        let mut processed_samples = if sample_rate != target_sample_rate {
            sys_log(&format!("DEBUG: [WaveformRemover] Resampling from {} to {}", sample_rate, target_sample_rate));
            let padding_samples = (sample_rate as f32 * 0.1) as usize; // 100ms padding for resampler
            let num_channels = channels as usize;

            // 1. Pad audio to prevent resampler artifacts at boundaries
            let mut padded_samples = vec![0.0f32; padding_samples * num_channels];
            padded_samples.extend_from_slice(&raw_samples);
            padded_samples.extend_from_slice(&vec![0.0f32; padding_samples * num_channels]);
            
            if is_cancelled() {
                return Err(anyhow!("Cancelled before resampling"));
            }

            // 2. Resample the padded audio
            let resampled_padded = self.resample(&padded_samples, sample_rate, target_sample_rate, num_channels)?;
            
            if is_cancelled() {
                return Err(anyhow!("Cancelled after resampling"));
            }

            // 3. Calculate samples to trim from resampled output
            let resample_ratio = target_sample_rate as f64 / sample_rate as f64;
            let trim_samples = (padding_samples as f64 * resample_ratio) as usize;

            // 4. Trim the resampled audio to remove padded silence
            if resampled_padded.len() > 2 * trim_samples * num_channels {
                let start_index = trim_samples * num_channels;
                let end_index = resampled_padded.len() - (trim_samples * num_channels);
                resampled_padded[start_index..end_index].to_vec()
            } else {
                resampled_padded
            }
        } else {
            raw_samples
        };

        // [ENHANCE] Always add 1.0s silence padding for AI Stabilizing
        let ai_padding_sec = 1.0;
        let ai_padding_samples = (target_sample_rate as f32 * ai_padding_sec) as usize;
        let num_channels = channels as usize;
        
        let mut final_v_padded = vec![0.0f32; ai_padding_samples * num_channels];
        final_v_padded.extend_from_slice(&processed_samples);
        final_v_padded.extend_from_slice(&vec![0.0f32; ai_padding_samples * num_channels]);
        processed_samples = final_v_padded;
        
        sys_log(&format!("PERF: [WaveformRemover] Audio load & resample (+ 1.0s Padding) took: {:?}", load_and_resample_start.elapsed()));

        if crate::audio_player::CANCEL_REQUESTS.lock().contains(&path_str) {
            return Err(anyhow!("Cancelled before model parameter detection"));
        }

        let setup_start = Instant::now();
        let ch_count = channels as usize;
        let total_samples = processed_samples.len() / ch_count;

        // 2. Model Parameter Auto-Detection
        let session_guard = self.session.lock();
        let input_shape = match session_guard.inputs()[0].dtype() {
            ValueType::Tensor { shape, .. } => shape.clone(),
            _ => return Err(anyhow!("Unexpected input type")),
        };
        let input_rank = input_shape.len();
        drop(session_guard);

        if crate::audio_player::CANCEL_REQUESTS.lock().contains(&path_str) {
            return Err(anyhow!("Cancelled after model detection"));
        }

        let is_mdx = self.model_name.contains("MDX") || self.model_name.contains("Kim");
        let is_roformer = self.model_name.contains("RoFormer");
        let is_kara = self.model_name.contains("KARA");
        sys_log(&format!("DEBUG: [WaveformRemover] Model identification: is_mdx={}, is_roformer={}, is_kara={}, model={}", is_mdx, is_roformer, is_kara, self.model_name));
        
        let mut n_fft = 2048;
        let mut hop_length = 512;
        let mut target_bins = 1025;
        let mut required_samples = 354848;

        if is_mdx {
            n_fft = 7680;
            hop_length = 1024;
            target_bins = 3072;

            // [FIX] KARA 2 모델 전용 파라미터 (2048 Bins 모델 대응)
            if self.model_name.contains("KARA") {
                n_fft = 4096;
                target_bins = 2048;
            }

            if input_rank >= 4 {
                let frames = input_shape[3] as usize; // MDX Shape: [1, 4, bins, frames]
                if frames > 0 { required_samples = (frames - 1) * hop_length + n_fft; }
            }
        } else if is_roformer || (input_rank == 4 && input_shape[3] == 2) {
            // Roformer: [2, frames, bins, 2] or some variants
            n_fft = 2048;
            hop_length = 512;
            target_bins = 1025;
            if input_rank == 4 {
                let frames = input_shape[1] as usize;
                if frames > 0 { required_samples = (frames - 1) * hop_length + n_fft; }
            }
        }

        if crate::audio_player::CANCEL_REQUESTS.lock().contains(&path_str) {
            return Err(anyhow!("Cancelled before STFT engine creation"));
        }

        sys_log(&format!("DEBUG: [WaveformRemover] Params: FFT={}, HOP={}, REQ_SAMPLES={}", n_fft, hop_length, required_samples));

        let stft_engine = StftEngine::new(n_fft, hop_length);

        // 3. Prepare Channels (Wrap in Arc to avoid cloning)
        let mut channels_raw = vec![vec![0.0f32; total_samples]; ch_count];
        for (f_idx, chunk) in processed_samples.chunks_exact(ch_count).enumerate() {
            for (c_idx, &sample) in chunk.iter().enumerate() {
                channels_raw[c_idx][f_idx] = sample;
            }
        }
        let channels_data = Arc::new(channels_raw);

        // 4. Overlap-Add Setup
        let overlap_size = if is_kara {
            // KARA needs heavy overlap (50%) to suppress clicking noises
            required_samples / 2
        } else if is_mdx { 
            88200.min(required_samples / 4) 
        } else if is_roformer {
            // Roformers usually need smaller overlap but we still want smooth OLA
            (2048 * 4).min(required_samples / 4)
        } else { 
            4096.min(required_samples / 4) 
        };
        let step_size = required_samples - overlap_size;
        
        let final_vocal = Arc::new(Mutex::new(vec![vec![0.0f32; total_samples]; ch_count]));
        let final_inst = Arc::new(Mutex::new(vec![vec![0.0f32; total_samples]; ch_count]));
        let weight_sum = Arc::new(Mutex::new(vec![0.0f32; total_samples]));

        // Sin-squared windows for smooth OLA
        let chunk_window = Arc::new((0..required_samples)
            .map(|i| {
                if i < overlap_size {
                    let ratio = i as f32 / overlap_size as f32;
                    (ratio * std::f32::consts::PI / 2.0).sin().powi(2)
                } else if i >= required_samples - overlap_size {
                    let ratio = (required_samples - 1 - i) as f32 / overlap_size as f32;
                    (ratio * std::f32::consts::PI / 2.0).sin().powi(2)
                } else {
                    1.0
                }
            })
            .collect::<Vec<f32>>());

        let num_chunks = (total_samples + step_size - 1) / step_size;
        sys_log(&format!("PERF: [WaveformRemover] Parameter setup took: {:?}", setup_start.elapsed()));

        // --- 3-STAGE PIPELINE SETUP ---
        let _pipeline_start = Instant::now();
        // STAGE 1: Preprocessing (STFT) Thread
        let (pre_tx, pre_rx) = std::sync::mpsc::sync_channel::<(usize, Value, Vec<Vec<f32>>, usize, bool, bool)>(BATCH_SIZE * 2);
        let (post_tx, post_rx) = std::sync::mpsc::sync_channel::<(usize, Vec<Value>, Vec<Vec<f32>>, usize, bool, bool)>(BATCH_SIZE * 2);

        // STAGE 1: Preprocessing (STFT) Thread
        let channels_data_clone = Arc::clone(&channels_data);
        let stft_engine_clone = stft_engine.clone();
        let cancel_flag_prep = cancel_flag.clone();
        let path_str_prep = path_str.clone();
        let pre_tx_clone = pre_tx.clone();
        std::thread::spawn(move || {
            let prep_start = Instant::now();
            
            let check_cancel = || {
                cancel_flag_prep.load(Ordering::Relaxed) || crate::audio_player::CANCEL_REQUESTS.lock().contains(&path_str_prep)
            };

            for chunk_idx in 0..num_chunks {
                if check_cancel() { break; }
                
                // [FIX] Broadcast Mode Throttle (More aggressive)
                if crate::separation::BROADCAST_MODE.load(Ordering::Relaxed) {
                    std::thread::sleep(std::time::Duration::from_millis(120));
                }
                
                let mut chunk_start = chunk_idx * step_size;
                let mut is_last_chunk_at_end = false;
                if chunk_start + required_samples > total_samples {
                    chunk_start = total_samples.saturating_sub(required_samples);
                    is_last_chunk_at_end = true;
                }
                
                let mut current_chunks = vec![vec![0.0f32; required_samples]; ch_count];
                for ch in 0..ch_count {
                    let end_idx = (chunk_start + required_samples).min(total_samples);
                    let len = end_idx - chunk_start;
                    current_chunks[ch][..len].copy_from_slice(&channels_data_clone[ch][chunk_start..end_idx]);
                }

                // Pre-gain scaling (currently disabled for Inst HQ 3 to preserve quality)

                // Internal parallelism for Left/Right channels is still maintained
                let (left_stft, right_stft) = if ch_count > 1 {
                    if crate::separation::BROADCAST_MODE.load(Ordering::Relaxed) {
                        let l = stft_engine_clone.stft_ndarray(&current_chunks[0], target_bins);
                        let r = stft_engine_clone.stft_ndarray(&current_chunks[1], target_bins);
                        (l, r)
                    } else {
                        rayon::join(
                            || stft_engine_clone.stft_ndarray(&current_chunks[0], target_bins),
                            || stft_engine_clone.stft_ndarray(&current_chunks[1], target_bins)
                        )
                    }
                } else {
                    let l = stft_engine_clone.stft_ndarray(&current_chunks[0], target_bins);
                    (l.clone(), l)
                };

                let num_frames = left_stft.shape()[0];
                let input_value_res = if is_mdx {
                    let mut stereo_tensor = Array4::<f32>::zeros((1, 4, target_bins, num_frames));
                    for b in 0..target_bins {
                        for f in 0..num_frames {
                            let l = left_stft[[f, b]];
                            let r = right_stft[[f, b]];
                            stereo_tensor[[0, 0, b, f]] = l.re;
                            stereo_tensor[[0, 1, b, f]] = l.im;
                            stereo_tensor[[0, 2, b, f]] = r.re;
                            stereo_tensor[[0, 3, b, f]] = r.im;
                        }
                    }
                    Value::from_array(stereo_tensor)
                } else {
                    let mut stereo_tensor = Array4::<f32>::zeros((2, num_frames, target_bins, 2));
                    for f in 0..num_frames {
                        for b in 0..target_bins {
                            let l = left_stft[[f, b]];
                            let r = right_stft[[f, b]];
                            stereo_tensor[[0, f, b, 0]] = l.re;
                            stereo_tensor[[0, f, b, 1]] = l.im;
                            stereo_tensor[[1, f, b, 0]] = r.re;
                            stereo_tensor[[1, f, b, 1]] = r.im;
                        }
                    }
                    Value::from_array(stereo_tensor)
                };

                if let Ok(input_value) = input_value_res {
                    if pre_tx_clone.send((chunk_idx, input_value.into_dyn(), current_chunks, chunk_start, is_last_chunk_at_end, is_kara)).is_err() {
                        break;
                    }
                }
            }
            sys_log(&format!("PERF: [AI-ENGINE] Stage 1 (Preprocessing) thread finished in {:?}.", prep_start.elapsed()));
        });

        // STAGE 2: Inference Loop (Main Thread - GPU Inference)
        let session_clone = Arc::clone(&self.session);
        
        let cancel_flag_infer = cancel_flag.clone();
        let path_str_infer = path_str.clone();
        std::thread::spawn(move || {
            let infer_start = Instant::now();
            while let Ok((chunk_idx, input_tensor, current_chunks, chunk_start, is_last_chunk, is_kara_chunk)) = pre_rx.recv() {
                if cancel_flag_infer.load(Ordering::Relaxed) || crate::audio_player::CANCEL_REQUESTS.lock().contains(&path_str_infer) { break; }
                
                let outputs_vec_res = {
                    let mut session_guard = session_clone.lock();
                    session_guard.run(ort::inputs![input_tensor])
                        .map(|outputs| outputs.into_iter().map(|(_, v)| v).collect::<Vec<Value>>())
                };

                if let Ok(outputs_vec) = outputs_vec_res {
                    if post_tx.send((chunk_idx, outputs_vec, current_chunks, chunk_start, is_last_chunk, is_kara_chunk)).is_err() { break; }
                }
            }
            drop(post_tx);
            sys_log(&format!("PERF: [AI-ENGINE] Stage 2 (Inference) thread finished in {:?}.", infer_start.elapsed()));
        });

        // STAGE 3: Post-processing (iSTFT & OLA) Thread
        let stft_engine_clone_2 = stft_engine.clone();
        let chunk_window_clone = Arc::clone(&chunk_window);
        let final_vocal_clone = Arc::clone(&final_vocal);
        let final_inst_clone = Arc::clone(&final_inst);
        let weight_sum_clone = Arc::clone(&weight_sum);
        let compensation = 1.0f32;
        let is_instrumental_model = self.model_name.contains("Inst") || self.model_name.contains("KARA");

        let cancel_flag_post = cancel_flag.clone();
        let path_str_post = path_str.clone();
        let post_handle = std::thread::spawn(move || {
            let post_proc_start = Instant::now();
            let mut processed_count = 0;
            while let Ok((chunk_idx, outputs, current_chunks, chunk_start, _is_last_chunk_at_end, _is_kara_node)) = post_rx.recv() {
                if cancel_flag_post.load(Ordering::Relaxed) || crate::audio_player::CANCEL_REQUESTS.lock().contains(&path_str_post) { break; }
                
                // Extract Result from Tensor
                let owned_data: Vec<f32> = if let Ok((_shape, slice)) = outputs[0].try_extract_tensor::<f32>() {
                    slice.to_vec()
                } else {
                    sys_log(&format!("ERROR: [AI-ENGINE] Failed to extract output tensor for chunk {}", chunk_idx));
                    break;
                };

                let total_elements = owned_data.len();
                let frames = total_elements / (4 * target_bins);

                let mut res_l = ndarray::Array2::from_elem((frames, target_bins), Complex::new(0.0f32, 0.0f32));
                let mut res_r = ndarray::Array2::from_elem((frames, target_bins), Complex::new(0.0f32, 0.0f32));
                
                if is_mdx {
                    for b in 0..target_bins {
                        let offset = b * frames;
                        for f in 0..frames {
                            let base = offset + f;
                            res_l[[f, b]] = Complex::new(
                                owned_data[0 * target_bins * frames + base],
                                owned_data[1 * target_bins * frames + base]
                            );
                            res_r[[f, b]] = Complex::new(
                                owned_data[2 * target_bins * frames + base],
                                owned_data[3 * target_bins * frames + base]
                            );
                        }
                    }
                } else {
                    for f in 0..frames {
                        let f_offset = f * target_bins * 2;
                        for b in 0..target_bins {
                            let base = f_offset + b * 2;
                            res_l[[f, b]] = Complex::new(owned_data[base + 0], owned_data[base + 1]);
                            res_r[[f, b]] = Complex::new(
                                owned_data[frames * target_bins * 2 + base + 0],
                                owned_data[frames * target_bins * 2 + base + 1]
                            );
                        }
                    }
                }

                let req_samples_inner = current_chunks[0].len();
                let (voc_l, voc_r) = if ch_count > 1 {
                    if crate::separation::BROADCAST_MODE.load(Ordering::Relaxed) {
                        let l = stft_engine_clone_2.istft_ndarray(&res_l, req_samples_inner);
                        let r = stft_engine_clone_2.istft_ndarray(&res_r, req_samples_inner);
                        (l, r)
                    } else {
                        rayon::join(
                            || stft_engine_clone_2.istft_ndarray(&res_l, req_samples_inner),
                            || stft_engine_clone_2.istft_ndarray(&res_r, req_samples_inner)
                        )
                    }
                } else {
                    let l = stft_engine_clone_2.istft_ndarray(&res_l, req_samples_inner);
                    (l.clone(), l)
                };
                let vocal_res = vec![voc_l, voc_r];

                let mut local_vocal = vec![vec![0.0f32; req_samples_inner]; ch_count];
                let mut local_inst = vec![vec![0.0f32; req_samples_inner]; ch_count];
                let mut local_weight = vec![0.0f32; req_samples_inner];

                for ch in 0..ch_count {
                    for i in 0..req_samples_inner {
                        let w = chunk_window_clone[i];
                        
                        // Note: For Inst models (like Inst HQ 3 or KARA), the model output is the instrumental track.
                        let model_output_sample = vocal_res[ch][i] * compensation;
                        let orig_sample = current_chunks[ch][i]; 
                        
                        if is_instrumental_model {
                            local_inst[ch][i] = model_output_sample * w;
                            local_vocal[ch][i] = (orig_sample - model_output_sample) * w;
                        } else {
                            local_vocal[ch][i] = model_output_sample * w;
                            local_inst[ch][i] = (orig_sample - model_output_sample) * w;
                        }
                        
                        if ch == 0 { local_weight[i] = w; }
                    }
                }

                {
                    let mut vocal_guard = final_vocal_clone.lock();
                    let mut inst_guard = final_inst_clone.lock();
                    let mut weight_guard = weight_sum_clone.lock();
                    
                    for ch in 0..ch_count {
                        for i in 0..req_samples_inner {
                            let out_idx = chunk_start + i;
                            if out_idx < total_samples {
                                vocal_guard[ch][out_idx] += local_vocal[ch][i];
                                inst_guard[ch][out_idx] += local_inst[ch][i];
                                if ch == 0 { weight_guard[out_idx] += local_weight[i]; }
                            }
                        }
                    }
                }
                
                processed_count += 1;
                if processed_count % 5 == 0 || processed_count == num_chunks {
                    on_progress(processed_count as f32 / num_chunks as f32 * 100.0);
                }
            }
            sys_log(&format!("PERF: [AI-ENGINE] Stage 3 (Post-processing) thread finished in {:?}. (Processed {} chunks)", post_proc_start.elapsed(), processed_count));
        });

        // Wait for all stages to finish
        drop(pre_tx); // Signals Stage 2 to stop after finishing remaining packets
        
        let _ = post_handle.join(); 
        
        // [FIX] Check if the process was cancelled before finalizing
        if is_cancelled() {
            return Err(anyhow!("Separation Cancelled during processing"));
        }

        sys_log("DEBUG: [WaveformRemover] Pipelined processing complete.");

        // Finalize OLA Normalization
        let finalize_start = Instant::now();
        // Extract inner vectors from Arc<Mutex<...>>
        let mut final_vocal_inner = Arc::try_unwrap(final_vocal).map_err(|_| anyhow!("Arc unwrap failed"))?.into_inner();
        let mut final_inst_inner = Arc::try_unwrap(final_inst).map_err(|_| anyhow!("Arc unwrap failed"))?.into_inner();
        let weight_sum_inner = Arc::try_unwrap(weight_sum).map_err(|_| anyhow!("Arc unwrap failed"))?.into_inner();

        for i in 0..total_samples {
            if weight_sum_inner[i] > 1e-10 {
                for ch in 0..ch_count {
                    final_vocal_inner[ch][i] /= weight_sum_inner[i];
                    final_inst_inner[ch][i] /= weight_sum_inner[i];
                }
            }
        }

        // 6. Trim Padding (Remove 1.0s from both ends)
        let ai_padding_samples = (target_sample_rate as f32 * 1.0) as usize;
        let mut trimmed_vocal = vec![vec![0.0f32; 0]; ch_count];
        let mut trimmed_inst = vec![vec![0.0f32; 0]; ch_count];
        
        if total_samples > 2 * ai_padding_samples {
            let start = ai_padding_samples;
            let end = total_samples - ai_padding_samples;
            for ch in 0..ch_count {
                trimmed_vocal[ch] = final_vocal_inner[ch][start..end].to_vec();
                trimmed_inst[ch] = final_inst_inner[ch][start..end].to_vec();
            }
            sys_log(&format!("DEBUG: [WaveformRemover] Trimming AI Stabilizing padding ({} samples).", ai_padding_samples));
        } else {
            sys_log("WARN: [WaveformRemover] Result too short to trim padding, results might have edge artifacts.");
            trimmed_vocal = final_vocal_inner;
            trimmed_inst = final_inst_inner;
        }

        // 7. Save Results
        let vocal_path = output_dir.join("vocal.wav");
        let inst_path = output_dir.join("inst.wav");
        
        self.save_wav(&trimmed_vocal, &vocal_path, target_sample_rate)?;
        self.save_wav(&trimmed_inst, &inst_path, target_sample_rate)?;

        sys_log(&format!("PERF: [WaveformRemover] Finalize & Save took: {:?}", finalize_start.elapsed()));
        sys_log(&format!("PERF: [WaveformRemover] Total separation time for track: {:?}", start_time.elapsed()));
        
        sys_log("DEBUG: [WaveformRemover] Advanced Separation complete with 3-stage pipeline.");
        Ok((vocal_path, inst_path))
    }
}

impl WaveformRemover {
    fn load_any_audio(&self, path: &Path) -> Result<(Vec<f32>, u32, u8)> {
        let file = std::fs::File::open(path)?;
        let mss = MediaSourceStream::new(Box::new(file), Default::default());
        
        let mut hint = Hint::new();
        if let Some(ext) = path.extension().and_then(|s| s.to_str()) {
            hint.with_extension(ext);
        }

        let probed = symphonia::default::get_probe()
            .format(&hint, mss, &FormatOptions::default(), &MetadataOptions::default())?;

        let mut format = probed.format;
        let track = format.tracks().iter()
            .find(|t| t.codec_params.codec != symphonia::core::codecs::CODEC_TYPE_NULL)
            .ok_or_else(|| anyhow!("No supported audio track found"))?;
        
        let track_id = track.id;
        let sample_rate = track.codec_params.sample_rate.ok_or_else(|| anyhow!("Unknown sample rate"))?;
        
        let mut decoder = symphonia::default::get_codecs()
            .make(&track.codec_params, &DecoderOptions::default())?;

        let mut samples: Vec<f32> = Vec::new();
        let mut detected_channels: Option<usize> = track.codec_params.channels.map(|c| c.count());

        loop {
            let packet = match format.next_packet() {
                Ok(packet) => packet,
                Err(symphonia::core::errors::Error::IoError(_)) => break,
                Err(e) => return Err(e.into()),
            };

            if packet.track_id() != track_id { continue; }

            let decoded = decoder.decode(&packet)?;
            
            // If channels not yet detected from metadata, get from the actual buffer
            let ch_count = detected_channels.get_or_insert_with(|| decoded.spec().channels.count());
            
            samples.extend_from_slice(&self.audio_bufref_to_samples(&decoded, *ch_count));
        }

        let final_channels = detected_channels.ok_or_else(|| anyhow!("Could not determine channel count"))? as u8;
        Ok((samples, sample_rate, final_channels))
    }

    fn audio_bufref_to_samples(&self, audio_buf: &AudioBufferRef<'_>, channels: usize) -> Vec<f32> {
        let frames = audio_buf.frames();
        if frames == 0 { return Vec::new(); }
        
        let mut samples = Vec::with_capacity(frames * channels);
        let ch_count = audio_buf.spec().channels.count();
        let process_chs = channels.min(ch_count);

        match audio_buf {
            AudioBufferRef::F32(buf) => {
                for f in 0..frames {
                    for c in 0..process_chs { samples.push(buf.chan(c)[f]); }
                    for _ in process_chs..channels { samples.push(0.0); }
                }
            }
            AudioBufferRef::S32(buf) => {
                let scale = 1.0 / 2147483648.0;
                for f in 0..frames {
                    for c in 0..process_chs { samples.push(buf.chan(c)[f] as f32 * scale); }
                    for _ in process_chs..channels { samples.push(0.0); }
                }
            }
            AudioBufferRef::S24(buf) => {
                let scale = 1.0 / 8388608.0;
                for f in 0..frames {
                    for c in 0..process_chs { samples.push(buf.chan(c)[f].0 as f32 * scale); }
                    for _ in process_chs..channels { samples.push(0.0); }
                }
            }
            AudioBufferRef::S16(buf) => {
                let scale = 1.0 / 32768.0;
                for f in 0..frames {
                    for c in 0..process_chs { samples.push(buf.chan(c)[f] as f32 * scale); }
                    for _ in process_chs..channels { samples.push(0.0); }
                }
            }
            AudioBufferRef::U8(buf) => {
                for f in 0..frames {
                    for c in 0..process_chs { samples.push((buf.chan(c)[f] as f32 - 128.0) / 128.0); }
                    for _ in process_chs..channels { samples.push(0.0); }
                }
            }
            _ => samples.resize(frames * channels, 0.0),
        }
        samples
    }

    fn resample(&self, samples: &[f32], source_rate: u32, target_rate: u32, channels: usize) -> Result<Vec<f32>> {
        let params = SincInterpolationParameters {
            sinc_len: 256,
            f_cutoff: 0.95,
            interpolation: SincInterpolationType::Cubic,
            oversampling_factor: 128,
            window: WindowFunction::BlackmanHarris2,
        };
        
        let mut resampler = SincFixedIn::<f32>::new(
            target_rate as f64 / source_rate as f64,
            2.0,
            params,
            samples.len() / channels,
            channels,
        )?;

        let mut interleaved = vec![vec![0.0f32; samples.len() / channels]; channels];
        for (f_idx, chunk) in samples.chunks_exact(channels).enumerate() {
            for (c_idx, &sample) in chunk.iter().enumerate() {
                interleaved[c_idx][f_idx] = sample;
            }
        }

        let resampled = resampler.process(&interleaved, None)?;
        let mut result = Vec::with_capacity(resampled[0].len() * channels);
        for f_idx in 0..resampled[0].len() {
            for c_idx in 0..channels {
                result.push(resampled[c_idx][f_idx]);
            }
        }
        Ok(result)
    }

    fn save_wav(&self, samples: &Vec<Vec<f32>>, path: &Path, rate: u32) -> Result<()> {
        let is_instrumental = self.model_name.contains("Inst") || self.model_name.contains("KARA");
        if is_instrumental {
            self.save_wav_inst(samples, path, rate)
        } else {
            self.save_wav_kim(samples, path, rate)
        }
    }

    /// Optimized logic for Kim model (User tuned)
    fn save_wav_kim(&self, samples: &Vec<Vec<f32>>, path: &Path, rate: u32) -> Result<()> {
        let spec = hound::WavSpec {
            channels: samples.len() as u16,
            sample_rate: rate,
            bits_per_sample: 32,
            sample_format: hound::SampleFormat::Float,
        };
        let mut writer = hound::WavWriter::create(path, spec)?;
        let num_channels = samples.len();
        if num_channels == 0 { return Ok(()); }
        let num_frames = samples[0].len();
        
        if num_frames < 200 { 
            if num_frames > 0 {
                for i in 0..num_frames {
                    for ch in 0..num_channels {
                        writer.write_sample(samples[ch][i].clamp(-1.0, 1.0))?;
                    }
                }
            }
            writer.finalize()?;
            return Ok(());
        }

        let total_samples_f64 = (num_channels * num_frames) as f64;

        // 1. DC Offset (Kim version)
        let mut dc_offset_sum = 0.0f64;
        for ch_samples in samples {
            for s in ch_samples { dc_offset_sum += *s as f64; }
        }
        let dc_offset = (dc_offset_sum / total_samples_f64) as f32;

        // 2. RMS Normalization
        let mut sum_sq = 0.0f64;
        for ch_samples in samples {
            for s in ch_samples {
                let s_corrected = (*s - dc_offset) as f64;
                sum_sq += s_corrected * s_corrected;
            }
        }
        let rms = (sum_sq / total_samples_f64).sqrt() as f32;
        let target_rms = 10.0_f32.powf(-16.0 / 20.0);
        let max_gain = 8.0; 
        let gain = if rms > 1e-6 { (target_rms / rms).min(max_gain) } else { 1.0 };

        // 3. Limiter & Fade Params
        let threshold = 0.90f32;
        let margin = 1.0 - threshold;
        let fade_frames = (rate as f32 * (15.0 / 1000.0)) as usize;
        let fade_in_end = fade_frames.min(num_frames / 2);
        let fade_out_start = num_frames.saturating_sub(fade_frames);

        for i in 0..num_frames {
            let fade_multiplier = if i < fade_in_end {
                (i as f32 / fade_in_end as f32).powi(2)
            } else if i >= fade_out_start {
                let progress = (i - fade_out_start) as f32 / (num_frames - fade_out_start) as f32;
                (1.0 - progress.min(1.0)).powi(2)
            } else {
                1.0
            };

            for ch in 0..num_channels {
                let mut s = (samples[ch][i] - dc_offset) * gain * fade_multiplier;
                let abs_s = s.abs();
                
                if abs_s > threshold {
                    let sign = s.signum();
                    s = sign * (threshold + margin * ((abs_s - threshold) / margin).tanh());
                }
                
                writer.write_sample(s.clamp(-1.0, 1.0))?;
            }
        }

        writer.finalize()?;
        Ok(())
    }

    /// Specialized logic for Instrumental models (Optimized for Peak/MR quality)
    fn save_wav_inst(&self, samples: &Vec<Vec<f32>>, path: &Path, rate: u32) -> Result<()> {
        let spec = hound::WavSpec {
            channels: samples.len() as u16,
            sample_rate: rate,
            bits_per_sample: 32,
            sample_format: hound::SampleFormat::Float,
        };
        let mut writer = hound::WavWriter::create(path, spec)?;
        let num_channels = samples.len();
        if num_channels == 0 { return Ok(()); }
        let num_frames = samples[0].len();
        
        let total_samples_f64 = (num_channels * num_frames) as f64;

        // 1. DC Offset Removal
        let mut dc_offset_sum = 0.0f64;
        for ch_samples in samples {
            for s in ch_samples { dc_offset_sum += *s as f64; }
        }
        let dc_offset = (dc_offset_sum / total_samples_f64) as f32;

        // 2. Peak Normalization (To prevent clipping)
        let mut max_peak = 0.0f32;
        for ch_samples in samples {
            for s in ch_samples {
                let abs_s = (*s - dc_offset).abs();
                if abs_s > max_peak { max_peak = abs_s; }
            }
        }

        // Target: -1.0 dBFS (approx 0.89) to leave some headroom
        let target_peak = 10.0_f32.powf(-1.0 / 20.0); 
        let gain = if max_peak > 1e-6 { target_peak / max_peak } else { 1.0 };
        
        // We only apply gain if it's necessary to avoid clipping (peak > target)
        // or if we want to boost a very quiet soul. 
        // For KARA, let's limit the boost to avoid amplifying model noise too much.
        let gain = gain.min(2.0); // Don't boost more than +6dB automatically

        // 3. Simple Soft Limiter (Safe ceiling at 0.98)
        let threshold = 0.95f32;
        let margin = 0.98f32 - threshold;

        // 4. Fade Params
        let fade_frames = (rate as f32 * (5.0 / 1000.0)) as usize; // Shorter fade for KARA
        let fade_in_end = fade_frames.min(num_frames / 2);
        let fade_out_start = num_frames.saturating_sub(fade_frames);

        for i in 0..num_frames {
            let fade_multiplier = if i < fade_in_end {
                i as f32 / fade_in_end as f32
            } else if i >= fade_out_start {
                1.0 - (i - fade_out_start) as f32 / (num_frames - fade_out_start) as f32
            } else {
                1.0
            };

            for ch in 0..num_channels {
                let mut s = (samples[ch][i] - dc_offset) * gain * fade_multiplier;
                let abs_s = s.abs();
                
                // Very gentle limiting for the last bits
                if abs_s > threshold {
                    let sign = s.signum();
                    s = sign * (threshold + margin * ((abs_s - threshold) / margin).tanh());
                }
                
                writer.write_sample(s.clamp(-1.0, 1.0))?;
            }
        }

        writer.finalize()?;
        Ok(())
    }
}
