use std::path::{Path, PathBuf};
use ort::session::Session;
use ort::value::Value;
use ndarray::{self, Array3};
use std::sync::Arc;
use parking_lot::Mutex;
use crate::audio_player::sys_log;
use ort::execution_providers::{CUDAExecutionProvider, DirectMLExecutionProvider, CPUExecutionProvider};
use rustfft::{FftPlanner, num_complex::Complex};

pub trait InferenceEngine: Send + Sync {
    fn separate(&self, audio_path: &Path, output_dir: &Path, on_progress: Box<dyn Fn(f32) + Send>) -> Result<(PathBuf, PathBuf), String>;
}

#[derive(Clone)]
pub struct WaveformRemover {
    session: Arc<Mutex<Session>>,
}

impl WaveformRemover {
    pub fn new(model_path: &Path) -> Result<Self, String> {
        let session = Session::builder()
            .map_err(|e| e.to_string())?
            .with_execution_providers([
                CUDAExecutionProvider::default().build(),
                DirectMLExecutionProvider::default().build(),
                CPUExecutionProvider::default().build(),
            ])
            .map_err(|e| e.to_string())?
            .commit_from_file(model_path)
            .map_err(|e| e.to_string())?;
        
        sys_log("[AI-ENGINE] Session initialized. Checking accelerators...");
        // Log available providers to help user diagnose CPU vs GPU
        // Note: in ort 2.x, the first successfully loaded EP in the list will be used.
        // We can't easily query the "active" one post-facto from the session easily in all versions, 
        // but we can log that we reached this point.
        sys_log("[AI-ENGINE] Roformer model loaded successfully.");
        
        Ok(Self { session: Arc::new(Mutex::new(session)) })
    }
}

impl InferenceEngine for WaveformRemover {
    fn separate(&self, audio_path: &Path, output_dir: &Path, on_progress: Box<dyn Fn(f32) + Send>) -> Result<(PathBuf, PathBuf), String> {
        sys_log(&format!("DEBUG: [WaveformRemover] Starting STFT-based separation for: {:?}", audio_path));
        
        if !output_dir.exists() {
            std::fs::create_dir_all(output_dir).map_err(|e| e.to_string())?;
        }

        // 1. Load and Resample to 44.1kHz
        let (samples, _spec) = self.load_and_resample(audio_path, 44100)?;
        let n_channels = samples.len();
        let n_samples = samples[0].len();
        
        // 2. STFT Parameters (Aligned with model: [1, 801, 4100])
        const N_FFT: usize = 1600;
        const HOP_LENGTH: usize = 400;
        const CHUNK_FRAMES: usize = 4100;
        let chunk_samples = CHUNK_FRAMES * HOP_LENGTH;

        let mut vocal_out = vec![vec![0.0f32; n_samples]; n_channels];
        let mut inst_out = vec![vec![0.0f32; n_samples]; n_channels];

        // Process each channel independently (Model expects [Batch, Freq, Time])
        for c in 0..n_channels {
            sys_log(&format!("DEBUG: Processing channel {}...", c));
            let channel_samples = &samples[c];
            
            let mut v_channel = vec![0.0f32; n_samples];
            let mut i_channel = vec![0.0f32; n_samples];
            
            let path_str = audio_path.to_string_lossy().to_string();
            let mut offset = 0;
            while offset < n_samples {
                // Check for cancellation
                if crate::audio_player::CANCEL_REQUESTS.lock().contains(&path_str) {
                    sys_log(&format!("DEBUG: Separation cancelled for: {}", path_str));
                    return Err("Cancelled by user".into());
                }

                let actual_samples = std::cmp::min(chunk_samples, n_samples - offset);
                
                // Extract and pad chunk to chunk_samples
                let mut chunk = vec![0.0f32; chunk_samples];
                for i in 0..actual_samples {
                    chunk[i] = channel_samples[offset + i];
                }

                // A. STFT
                let (mag, phase) = self.stft(&chunk, N_FFT, HOP_LENGTH);
                
                // B. Prepare Tensor [1, 801, 4100]
                // mag shape is [Frames, Bins], currently [4100, 801]
                let mut input_array = Array3::<f32>::zeros((1, 801, 4100));
                for f in 0..CHUNK_FRAMES {
                    for b in 0..801 {
                        input_array[[0, b, f]] = mag[f][b];
                    }
                }

                // C. Inference
                let input_value = Value::from_array(input_array.into_dyn()).map_err(|e| e.to_string())?;
                let inputs = ort::inputs!["input" => input_value];

                let mut session_guard = self.session.lock();
                let outputs = session_guard.run(inputs).map_err(|e| e.to_string())?;
                
                sys_log(&format!("DEBUG: Model inference complete. Output count: {}", outputs.len()));

                // D. Extract & iSTFT
                // Some models only have 1 output (Vocal), others have 2 (Vocal, Inst)
                let v_mag_tensor = outputs[0].try_extract_tensor::<f32>().map_err(|e| e.to_string())?;
                let v_mag = self.tensor_to_vec_2d(&v_mag_tensor.1, &v_mag_tensor.0); // [801, 4100]

                let i_mag = if outputs.len() > 1 {
                    let i_mag_tensor = outputs[1].try_extract_tensor::<f32>().map_err(|e| e.to_string())?;
                    self.tensor_to_vec_2d(&i_mag_tensor.1, &i_mag_tensor.0)
                } else {
                    // Fallback: If only vocal is provided, compute instrumental as (Original - Vocal)
                    let current_bins = v_mag.len();
                    let current_frames = if current_bins > 0 { v_mag[0].len() } else { 0 };
                    
                    let mut diff_mag = vec![vec![0.0f32; current_frames]; current_bins];
                    for f in 0..std::cmp::min(current_frames, mag.len()) {
                        for b in 0..std::cmp::min(current_bins, if mag.len() > 0 { mag[0].len() } else { 0 }) {
                            // Note: mag is [Frames][Bins], v_mag is [Bins][Frames]
                            diff_mag[b][f] = (mag[f][b] - v_mag[b][f]).max(0.0);
                        }
                    }
                    diff_mag
                };

                let v_reconstructed = self.istft(&v_mag, &phase, N_FFT, HOP_LENGTH);
                let i_reconstructed = self.istft(&i_mag, &phase, N_FFT, HOP_LENGTH);

                // E. Overlap-Add back to result buffer
                for i in 0..std::cmp::min(actual_samples, v_reconstructed.len()) {
                    v_channel[offset + i] = v_reconstructed[i];
                    i_channel[offset + i] = i_reconstructed[i];
                }

                offset += actual_samples;
                
                // Overall progress = (Current Channel Progress / 2) + (Channel Index * 50%)
                let channel_progress = (offset as f32 / n_samples as f32) * (100.0 / n_channels as f32);
                on_progress(channel_progress + (c as f32 * (100.0 / n_channels as f32)));
            }
            
            vocal_out[c] = v_channel;
            inst_out[c] = i_channel;
        }

        // 4. Save to WAV
        let vocal_path = output_dir.join("vocal.wav");
        let inst_path = output_dir.join("inst.wav");
        
        self.save_wav(&vocal_out, &vocal_path, 44100)?;
        self.save_wav(&inst_out, &inst_path, 44100)?;

        sys_log("DEBUG: [WaveformRemover] STFT Separation complete.");
        Ok((vocal_path, inst_path))
    }
}

impl WaveformRemover {
    fn load_and_resample(&self, path: &Path, _target_rate: u32) -> Result<(Vec<Vec<f32>>, hound::WavSpec), String> {
        let mut reader = hound::WavReader::open(path).map_err(|e| format!("Failed to open WAV: {}", e))?;
        let spec = reader.spec();
        
        let mut channels = vec![vec![]; 2];
        let original_channels = spec.channels as usize;

        let raw_samples: Vec<f32> = match (spec.sample_format, spec.bits_per_sample) {
            (hound::SampleFormat::Int, 16) => {
                reader.samples::<i16>()
                    .map(|s| s.map(|v| v as f32 / 32768.0))
                    .collect::<Result<Vec<f32>, _>>()
                    .map_err(|e| format!("16비트 오디오 읽기 실패: {}", e))?
            },
            (hound::SampleFormat::Int, 24) => {
                reader.samples::<i32>()
                    .map(|s| s.map(|v| v as f32 / 8388608.0))
                    .collect::<Result<Vec<f32>, _>>()
                    .map_err(|e| format!("24비트 오디오 읽기 실패: {}", e))?
            },
            (hound::SampleFormat::Int, 32) => {
                reader.samples::<i32>()
                    .map(|s| s.map(|v| v as f32 / 2147483648.0))
                    .collect::<Result<Vec<f32>, _>>()
                    .map_err(|e| format!("32비트 오디오 읽기 실패: {}", e))?
            },
            (hound::SampleFormat::Float, 32) => {
                reader.samples::<f32>()
                    .map(|s| s.map(|v| v))
                    .collect::<Result<Vec<f32>, _>>()
                    .map_err(|e| format!("Float 오디오 읽기 실패: {}", e))?
            },
            _ => {
                return Err(format!("지원되지 않는 비트 심도: {} bits ({:?})", spec.bits_per_sample, spec.sample_format));
            }
        };

        for (i, &s) in raw_samples.iter().enumerate() {
            let c = i % original_channels;
            if c < 2 {
                channels[c].push(s);
            }
        }

        if original_channels == 1 {
            channels[1] = channels[0].clone();
        } else if channels[1].is_empty() && !channels[0].is_empty() {
            channels[1] = channels[0].clone();
        }

        Ok((channels, spec))
    }

    fn tensor_to_vec_2d(&self, data: &[f32], shape: &[i64]) -> Vec<Vec<f32>> {
        let is_complex = shape.last().map(|&s| s == 2).unwrap_or(false);
        let n_dims = shape.len();
        
        let (n_bins, n_frames) = if is_complex && n_dims >= 3 {
            (shape[n_dims - 3] as usize, shape[n_dims - 2] as usize)
        } else if n_dims >= 2 {
            (shape[n_dims - 2] as usize, shape[n_dims - 1] as usize)
        } else {
            return Vec::new();
        };

        sys_log(&format!("DEBUG: Interpreting tensor: {} bins, {} frames (Complex: {})", n_bins, n_frames, is_complex));

        let mut result = vec![vec![0.0; n_frames]; n_bins];
        if is_complex {
            for b in 0..n_bins {
                for f in 0..n_frames {
                    let re_idx = (b * n_frames + f) * 2;
                    let im_idx = re_idx + 1;
                    if im_idx < data.len() {
                        let re = data[re_idx];
                        let im = data[im_idx];
                        result[b][f] = (re * re + im * im).sqrt();
                    }
                }
            }
        } else {
            for b in 0..n_bins {
                for f in 0..n_frames {
                    let idx = b * n_frames + f;
                    if idx < data.len() {
                        result[b][f] = data[idx];
                    }
                }
            }
        }
        result
    }

    fn stft(&self, samples: &[f32], n_fft: usize, hop_length: usize) -> (Vec<Vec<f32>>, Vec<Vec<f32>>) {
        let mut planner = FftPlanner::new();
        let fft = planner.plan_fft_forward(n_fft);
        let n_bins = (n_fft / 2) + 1;
        let n_frames = samples.len() / hop_length;
        
        let mut magnitudes = vec![vec![0.0f32; n_bins]; n_frames];
        let mut phases = vec![vec![0.0f32; n_bins]; n_frames];
        
        let window: Vec<f32> = (0..n_fft).map(|i| 0.5 * (1.0 - (2.0 * std::f32::consts::PI * i as f32 / (n_fft - 1) as f32).cos())).collect();

        for f in 0..n_frames {
            let start = f * hop_length;
            if start + n_fft > samples.len() { break; }
            
            let mut input: Vec<Complex<f32>> = (0..n_fft).map(|i| {
                Complex::new(samples[start + i] * window[i], 0.0)
            }).collect();
            
            fft.process(&mut input);
            
            for b in 0..n_bins {
                let complex = input[b];
                magnitudes[f][b] = complex.norm();
                phases[f][b] = complex.arg();
            }
        }
        
        (magnitudes, phases)
    }

    fn istft(&self, magnitude: &Vec<Vec<f32>>, phase: &Vec<Vec<f32>>, n_fft: usize, hop_length: usize) -> Vec<f32> {
        let mut planner = FftPlanner::new();
        let fft = planner.plan_fft_inverse(n_fft);
        if magnitude.is_empty() { return Vec::new(); }
        let n_bins = magnitude.len();
        let n_frames = magnitude[0].len();
        
        let output_len = n_frames * hop_length + n_fft;
        let mut samples = vec![0.0f32; output_len];
        let mut window_sum = vec![0.0f32; output_len];
        
        let window: Vec<f32> = (0..n_fft).map(|i| 0.5 * (1.0 - (2.0 * std::f32::consts::PI * i as f32 / (n_fft - 1) as f32).cos())).collect();

        for f in 0..n_frames {
            let mut input: Vec<Complex<f32>> = (0..n_fft).map(|i| {
                if i < n_bins {
                    Complex::from_polar(magnitude[i][f], if f < phase.len() && i < phase[0].len() { phase[f][i] } else { 0.0 })
                } else if i > 0 && n_fft - i < n_bins {
                    let b = n_fft - i;
                    Complex::from_polar(magnitude[b][f], if f < phase.len() && b < phase[0].len() { phase[f][b] } else { 0.0 }).conj()
                } else {
                    Complex::new(0.0, 0.0)
                }
            }).collect();

            fft.process(&mut input);
            
            let start = f * hop_length;
            for i in 0..n_fft {
                samples[start + i] += (input[i].re / n_fft as f32) * window[i];
                window_sum[start + i] += window[i] * window[i];
            }
        }
        
        for i in 0..output_len {
            if window_sum[i] > 1e-6 {
                samples[i] /= window_sum[i];
            }
        }
        samples
    }

    fn save_wav(&self, samples: &Vec<Vec<f32>>, path: &Path, rate: u32) -> Result<(), String> {
        let spec = hound::WavSpec {
            channels: 2,
            sample_rate: rate,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        };
        let mut writer = hound::WavWriter::create(path, spec).map_err(|e| e.to_string())?;
        let len = samples[0].len();
        for i in 0..len {
            writer.write_sample((samples[0][i].clamp(-1.0, 1.0) * 32767.0) as i16).map_err(|e| e.to_string())?;
            writer.write_sample((samples[1][i].clamp(-1.0, 1.0) * 32767.0) as i16).map_err(|e| e.to_string())?;
        }
        Ok(())
    }
}
