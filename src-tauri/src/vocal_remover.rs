use std::path::{Path, PathBuf};
use ort::session::Session;
use ort::value::{Value, ValueType};
use ndarray::{self, Array3, Array4};
use std::sync::Arc;
use parking_lot::Mutex;
use crate::audio_player::sys_log;
use ort::execution_providers::{CUDAExecutionProvider, DirectMLExecutionProvider, CPUExecutionProvider, ExecutionProvider};
use rustfft::{FftPlanner, num_complex::Complex};
use symphonia::core::formats::FormatOptions;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::io::MediaSourceStream;
use symphonia::core::probe::Hint;
use symphonia::core::audio::{AudioBufferRef, Signal};
use symphonia::core::codecs::DecoderOptions;
use rubato::{Resampler, SincFixedIn, SincInterpolationType, SincInterpolationParameters, WindowFunction};
use anyhow::{anyhow, Result};

pub trait InferenceEngine: Send + Sync {
    fn separate(&self, audio_path: &Path, output_dir: &Path, on_progress: Box<dyn Fn(f32) + Send>) -> Result<(PathBuf, PathBuf)>;
    fn get_provider(&self) -> String;
}

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

    pub fn stft(&self, samples: &[f32], target_bins: usize) -> Vec<Vec<[f32; 2]>> {
        let mut stft_result = Vec::new();
        let num_samples = samples.len();
        let n_fft = self.n_fft;

        for start in (0..=num_samples.saturating_sub(n_fft)).step_by(self.hop_length) {
            let mut input: Vec<Complex<f32>> = (0..n_fft)
                .map(|i| Complex::new(samples[start + i] * self.window[i], 0.0))
                .collect();
            self.fft.process(&mut input);
            
            let mut frame = Vec::with_capacity(target_bins);
            for i in 0..target_bins {
                if i < input.len() / 2 + 1 {
                    frame.push([input[i].re, input[i].im]);
                } else {
                    frame.push([0.0, 0.0]);
                }
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
        
        for (f_idx, frame) in frames.iter().enumerate() {
            let start = f_idx * self.hop_length;
            let mut complex_buffer = vec![Complex::new(0.0, 0.0); n_fft];
            for (i, &bin) in frame.iter().enumerate() {
                if i < n_fft / 2 + 1 {
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
        let threads = (num_cpus::get() - 1).max(1);
        sys_log(&format!("[AI-ENGINE] Initializing with {} intra-op threads", threads));

        let session = Session::builder()
            .map_err(|e| anyhow!("[AI-ENGINE] Session builder error: {}", e))?
            .with_intra_threads(threads)
            .map_err(|e| anyhow!("[AI-ENGINE] Thread config error: {}", e))?
            .with_execution_providers([
                CUDAExecutionProvider::default().build(),
                DirectMLExecutionProvider::default().build(),
                CPUExecutionProvider::default().build(),
            ])
            .map_err(|e| anyhow!("[AI-ENGINE] Execution provider error: {}", e))?
            .commit_from_file(model_path)
            .map_err(|e| anyhow!("[AI-ENGINE] Model load error: {}", e))?;
        
        let model_name = model_path.file_name().and_then(|n| n.to_str()).unwrap_or("unknown").to_string();
        
        let active_provider = if CUDAExecutionProvider::default().is_available().unwrap_or(false) {
            "GPU (CUDA)".to_string()
        } else if DirectMLExecutionProvider::default().is_available().unwrap_or(false) {
            "GPU (DirectML)".to_string()
        } else {
            "CPU".to_string()
        };
        
        sys_log(&format!("[AI-ENGINE] Model loaded: {}, Provider: {}", model_name, active_provider));
        Ok(Self { session: Arc::new(Mutex::new(session)), model_name, active_provider })
    }
}

impl InferenceEngine for WaveformRemover {
    fn get_provider(&self) -> String {
        self.active_provider.clone()
    }
    fn separate(&self, audio_path: &Path, output_dir: &Path, on_progress: Box<dyn Fn(f32) + Send>) -> Result<(PathBuf, PathBuf)> {
        sys_log(&format!("DEBUG: [WaveformRemover] Starting advanced separation for: {:?}. Using: {}", audio_path, self.active_provider));
        
        if !output_dir.exists() {
            std::fs::create_dir_all(output_dir)?;
        }

        // 1. Load and Resample (always to 44.1kHz for these models)
        let (raw_samples, sample_rate, channels) = self.load_any_audio(audio_path)?;
        
        // Normalize path for reliable cancellation check (ignore slash direction and case)
        let path_str = audio_path.to_string_lossy().to_string().replace("\\", "/").to_lowercase();
        
        if crate::audio_player::CANCEL_REQUESTS.lock().contains(&path_str) {
            return Err(anyhow!("Cancelled after audio load"));
        }

        let target_sample_rate = 44100;
        let processed_samples = if sample_rate != target_sample_rate {
            let res = self.resample(&raw_samples, sample_rate, target_sample_rate, channels as usize)?;
            if crate::audio_player::CANCEL_REQUESTS.lock().contains(&path_str) {
                return Err(anyhow!("Cancelled after resampling"));
            }
            res
        } else {
            raw_samples
        };

        if crate::audio_player::CANCEL_REQUESTS.lock().contains(&path_str) {
            return Err(anyhow!("Cancelled before model parameter detection"));
        }

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
        sys_log(&format!("DEBUG: [WaveformRemover] Model identification: is_mdx={}, model={}", is_mdx, self.model_name));
        
        let mut n_fft = 2048;
        let mut hop_length = 441;
        let mut target_bins = 1025;
        let mut required_samples = 354848;

        if is_mdx {
            n_fft = 6144;
            hop_length = 1024;
            target_bins = 3072;
            if input_rank >= 4 {
                let frames = input_shape[3] as usize;
                if frames > 0 { required_samples = (frames - 1) * hop_length + n_fft; }
            }
        } else {
            if input_rank == 4 && input_shape.len() >= 2 {
                let frames = input_shape[1] as usize; // Roformer: [2, frames, bins, 2]
                if frames > 0 { required_samples = (frames - 1) * hop_length + n_fft; }
            }
        }

        if crate::audio_player::CANCEL_REQUESTS.lock().contains(&path_str) {
            return Err(anyhow!("Cancelled before STFT engine creation"));
        }

        sys_log(&format!("DEBUG: [WaveformRemover] Params: FFT={}, HOP={}, REQ_SAMPLES={}", n_fft, hop_length, required_samples));

        let stft_engine = StftEngine::new(n_fft, hop_length);

        // 3. Prepare Channels
        let mut channels_data = vec![vec![0.0f32; total_samples]; ch_count];
        for (i, sample) in processed_samples.iter().enumerate() {
            channels_data[i % ch_count][i / ch_count] = *sample;
        }

        if crate::audio_player::CANCEL_REQUESTS.lock().contains(&path_str) {
            return Err(anyhow!("Cancelled after preparing channels"));
        }

        // 4. Overlap-Add Setup
        let overlap_size = 4096.min(required_samples / 4);
        let step_size = required_samples - overlap_size;
        
        let mut final_vocal = vec![vec![0.0f32; total_samples]; ch_count];
        let mut final_inst = vec![vec![0.0f32; total_samples]; ch_count];
        let mut weight_sum = vec![0.0f32; total_samples];

        // Sin-squared windows for smooth OLA
        let chunk_window: Vec<f32> = (0..required_samples)
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
            .collect();

        let num_chunks = (total_samples + step_size - 1) / step_size;
        let path_str = audio_path.to_string_lossy().to_string();

        // 5. Processing Loop
        for chunk_idx in 0..num_chunks {
            // Check cancellation
            if crate::audio_player::CANCEL_REQUESTS.lock().contains(&path_str) {
                return Err(anyhow!("Cancelled by user"));
            }

            let mut chunk_start = chunk_idx * step_size;
            let mut is_last_chunk_at_end = false;
            if chunk_start + required_samples > total_samples {
                chunk_start = total_samples.saturating_sub(required_samples);
                is_last_chunk_at_end = true;
            }
            let chunk_end = chunk_start + required_samples;

            let mut current_chunks = vec![vec![0.0f32; required_samples]; ch_count];
            for ch in 0..ch_count {
                let end_idx = chunk_end.min(total_samples);
                let len = end_idx - chunk_start;
                current_chunks[ch][..len].copy_from_slice(&channels_data[ch][chunk_start..end_idx]);
            }

            // Inference
            let vocal_samples = if input_rank == 3 {
                // Waveform model
                let mut audio_tensor = Array3::<f32>::zeros((1, ch_count, required_samples));
                for ch in 0..ch_count {
                    // Check cancellation more frequently in copy loops if needed, 
                    // but for waveform, simple check before session is enough
                    for s in 0..required_samples {
                        audio_tensor[[0, ch, s]] = current_chunks[ch][s];
                    }
                }
                
                let owned_data: Vec<f32> = {
                    let mut session_guard = self.session.lock();
                    let input_value = Value::from_array(audio_tensor.into_dyn())
                        .map_err(|e| anyhow!("[AI-ENGINE] Input value error: {}", e))?;
                    let outputs = session_guard.run([input_value.into()])
                        .map_err(|e| anyhow!("[AI-ENGINE] Session run error: {}", e))?;
                    let (_, owned_tensor) = outputs[0].try_extract_tensor::<f32>()
                        .map_err(|e| anyhow!("[AI-ENGINE] Extraction error: {}", e))?;
                    owned_tensor.iter().cloned().collect()
                };
                
                // Immediate check after session run
                if crate::audio_player::CANCEL_REQUESTS.lock().contains(&path_str) {
                    return Err(anyhow!("Cancelled during waveform inference"));
                }

                let mut res = vec![vec![0.0f32; required_samples]; ch_count];
                for ch in 0..ch_count {
                    for s in 0..required_samples {
                        res[ch][s] = owned_data[ch * required_samples + s];
                    }
                }
                res
            } else {
                // Spectral model (STFT)
                let left_stft = stft_engine.stft(&current_chunks[0], target_bins);
                if crate::audio_player::CANCEL_REQUESTS.lock().contains(&path_str) { return Err(anyhow!("Cancelled after L-STFT")); }

                let right_stft = if ch_count > 1 {
                    let r = stft_engine.stft(&current_chunks[1], target_bins);
                    if crate::audio_player::CANCEL_REQUESTS.lock().contains(&path_str) { return Err(anyhow!("Cancelled after R-STFT")); }
                    r
                } else {
                    left_stft.clone()
                };
                let num_frames = left_stft.len();

                let owned_data: Vec<f32> = {
                    let mut session_guard = self.session.lock();
                    let input_value = if is_mdx {
                        let mut stereo_tensor = Array4::<f32>::zeros((1, 4, target_bins, num_frames));
                        for f in 0..num_frames {
                            // Frequent sub-check (every 100 frames) to keep performance but improve stop speed
                            if f % 100 == 0 && crate::audio_player::CANCEL_REQUESTS.lock().contains(&path_str) {
                                return Err(anyhow!("Cancelled during MDX tensor preparation"));
                            }
                            for b in 0..target_bins {
                                stereo_tensor[[0, 0, b, f]] = left_stft[f][b][0];
                                stereo_tensor[[0, 1, b, f]] = left_stft[f][b][1];
                                stereo_tensor[[0, 2, b, f]] = right_stft[f][b][0];
                                stereo_tensor[[0, 3, b, f]] = right_stft[f][b][1];
                            }
                        }
                        Value::from_array(stereo_tensor.into_dyn())
                    } else {
                        let mut stereo_tensor = Array4::<f32>::zeros((2, num_frames, target_bins, 2));
                        for f in 0..num_frames {
                            if f % 100 == 0 && crate::audio_player::CANCEL_REQUESTS.lock().contains(&path_str) {
                                return Err(anyhow!("Cancelled during RoFormer tensor preparation"));
                            }
                            for b in 0..target_bins {
                                stereo_tensor[[0, f, b, 0]] = left_stft[f][b][0];
                                stereo_tensor[[0, f, b, 1]] = left_stft[f][b][1];
                                stereo_tensor[[1, f, b, 0]] = right_stft[f][b][0];
                                stereo_tensor[[1, f, b, 1]] = right_stft[f][b][1];
                            }
                        }
                        Value::from_array(stereo_tensor.into_dyn())
                    }.map_err(|e| anyhow!("[AI-ENGINE] Input value error: {}", e))?;

                    let outputs = session_guard.run([input_value.into()])
                        .map_err(|e| anyhow!("[AI-ENGINE] Session run error: {}", e))?;
                    let (_, owned_tensor) = outputs[0].try_extract_tensor::<f32>()
                        .map_err(|e| anyhow!("[AI-ENGINE] Extraction error: {}", e))?;
                    owned_tensor.iter().cloned().collect()
                };
                
                // Immediate check after session run
                if crate::audio_player::CANCEL_REQUESTS.lock().contains(&path_str) { 
                    return Err(anyhow!("Cancelled after session run")); 
                }

                let mut vocal_stft = vec![vec![vec![[0.0f32, 0.0f32]; target_bins]; num_frames]; 2];
                
                if is_mdx {
                    // MDX Shape: [1, 4, bins, frames] -> (L_re, L_im, R_re, R_im)
                    for f in 0..num_frames {
                        for b in 0..target_bins {
                            vocal_stft[0][f][b][0] = owned_data[0 * target_bins * num_frames + b * num_frames + f];
                            vocal_stft[0][f][b][1] = owned_data[1 * target_bins * num_frames + b * num_frames + f];
                            vocal_stft[1][f][b][0] = owned_data[2 * target_bins * num_frames + b * num_frames + f];
                            vocal_stft[1][f][b][1] = owned_data[3 * target_bins * num_frames + b * num_frames + f];
                        }
                    }
                } else {
                    // RoFormer Shape: [2, frames, bins, 2]
                    for f in 0..num_frames {
                        for b in 0..target_bins {
                            vocal_stft[0][f][b][0] = owned_data[0 * num_frames * target_bins * 2 + f * target_bins * 2 + b * 2 + 0];
                            vocal_stft[0][f][b][1] = owned_data[0 * num_frames * target_bins * 2 + f * target_bins * 2 + b * 2 + 1];
                            vocal_stft[1][f][b][0] = owned_data[1 * num_frames * target_bins * 2 + f * target_bins * 2 + b * 2 + 0];
                            vocal_stft[1][f][b][1] = owned_data[1 * num_frames * target_bins * 2 + f * target_bins * 2 + b * 2 + 1];
                        }
                    }
                }

                let mut res = vec![vec![0.0f32; required_samples]; ch_count];
                for ch in 0..ch_count {
                    res[ch] = stft_engine.istft(&vocal_stft[ch], required_samples);
                }
                res
            };

            // Overlap-Add to final buffers
            for ch in 0..ch_count {
                for i in 0..required_samples {
                    let out_idx = chunk_start + i;
                    if out_idx < total_samples {
                        let mut w = chunk_window[i];
                        // Handle boundaries
                        if chunk_idx == 0 && i < overlap_size { w = 1.0; }
                        if chunk_idx == num_chunks - 1 && !is_last_chunk_at_end && i >= required_samples - overlap_size { w = 1.0; }
                        if is_last_chunk_at_end && i >= required_samples - overlap_size { w = 1.0; }
                        
                        let vocal_sample = vocal_samples[ch][i];
                        let orig_sample = current_chunks[ch][i];
                        
                        final_vocal[ch][out_idx] += vocal_sample * w;
                        final_inst[ch][out_idx] += (orig_sample - vocal_sample) * w;
                        if ch == 0 { weight_sum[out_idx] += w; }
                    }
                }
            }

            on_progress((chunk_idx + 1) as f32 / num_chunks as f32 * 100.0);
        }

        // Finalize OLA Normalization
        for i in 0..total_samples {
            if weight_sum[i] > 1e-10 {
                for ch in 0..ch_count {
                    final_vocal[ch][i] /= weight_sum[i];
                    final_inst[ch][i] /= weight_sum[i];
                }
            }
        }

        // 6. Save Results
        let vocal_path = output_dir.join("vocal.wav");
        let inst_path = output_dir.join("inst.wav");
        
        self.save_wav(&final_vocal, &vocal_path, target_sample_rate)?;
        self.save_wav(&final_inst, &inst_path, target_sample_rate)?;

        sys_log("DEBUG: [WaveformRemover] Advanced Separation complete.");
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
        for (i, sample) in samples.iter().enumerate() {
            interleaved[i % channels][i / channels] = *sample;
        }

        let resampled = resampler.process(&interleaved, None)?;
        let mut result = Vec::with_capacity(resampled[0].len() * channels);
        for f in 0..resampled[0].len() {
            for c in 0..channels {
                result.push(resampled[c][f]);
            }
        }
        Ok(result)
    }

    fn save_wav(&self, samples: &Vec<Vec<f32>>, path: &Path, rate: u32) -> Result<()> {
        let spec = hound::WavSpec {
            channels: samples.len() as u16,
            sample_rate: rate,
            bits_per_sample: 32,
            sample_format: hound::SampleFormat::Float,
        };
        let mut writer = hound::WavWriter::create(path, spec)?;
        let len = samples[0].len();
        
        // Normalize peak to 0.95
        let mut max_abs = 0.0f32;
        for ch in samples {
            for s in ch { max_abs = max_abs.max(s.abs()); }
        }
        let scale = if max_abs > 1e-6 { 0.95 / max_abs } else { 1.0 };

        for i in 0..len {
            for ch in 0..samples.len() {
                let s = samples[ch][i] * scale;
                writer.write_sample(s.clamp(-1.0, 1.0))?;
            }
        }
        writer.finalize()?;
        Ok(())
    }
}
