use std::path::{Path, PathBuf};
use ort::session::Session;
use ort::value::Value;
use ort::value::ValueType;
use ndarray::{self, Array3};
use std::sync::Arc;
use parking_lot::Mutex;
use crate::audio_player::sys_log;
use ort::execution_providers::{CUDAExecutionProvider, DirectMLExecutionProvider, CPUExecutionProvider};
use rustfft::{FftPlanner, num_complex::Complex};
use symphonia::core::formats::FormatOptions;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::io::MediaSourceStream;
use symphonia::core::probe::Hint;
use symphonia::core::audio::{AudioBufferRef, Signal};
use rubato::{Resampler, SincFixedIn, SincInterpolationType, SincInterpolationParameters, WindowFunction};

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

        // 1. Load any audio format and resample to 44.1kHz
        let samples = self.load_any_audio(audio_path, 44100)?;
        let n_channels = samples.len();
        let n_samples = samples[0].len();
        
        // 2. Query Model Input Shape to determine STFT parameters
        let session_guard = self.session.lock();
        let inputs = session_guard.inputs();
        let input_shape = match inputs[0].dtype() {
            ValueType::Tensor { shape, .. } => shape.clone(),
            _ => return Err("Unexpected input type".into()),
        };
        drop(session_guard);

        sys_log(&format!("DEBUG: [WaveformRemover] Model Input Shape: {:?}", input_shape));

        // Detect indices based on rank
        // Rank 3: [Batch, Freq, Time] -> n_bins at 1, chunk_frames at 2
        // Rank 4: [Batch, Channel, Freq, Time] -> n_bins at 2, chunk_frames at 3
        let (n_bins, chunk_frames) = if input_shape.len() == 4 {
            (input_shape[2] as usize, input_shape[3] as usize)
        } else {
            (input_shape[1] as usize, input_shape[2] as usize)
        };

        let n_fft = (n_bins - 1) * 2;
        let hop_length = n_fft / 4; // Usual default
        let chunk_samples = chunk_frames * hop_length;

        sys_log(&format!("DEBUG: [WaveformRemover] Deduced Params: FFT={}, HOP={}, CHUNKS={}", n_fft, hop_length, chunk_frames));

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
                let (mag, phase) = self.stft(&chunk, n_fft, hop_length);
                
                // B. Prepare Tensor
                let mut input_array = Array3::<f32>::zeros((1, n_bins, chunk_frames));
                
                let mut sum_val = 0.0;
                let mut max_val = 0.0f32;
                for f in 0..chunk_frames {
                    for b in 0..n_bins {
                        let val = mag[f][b];
                        input_array[[0, b, f]] = val;
                        sum_val += val;
                        max_val = max_val.max(val);
                    }
                }
                
                if offset == 0 {
                    sys_log(&format!("DEBUG: Input Tensor Stats - Max: {:.4}, Mean: {:.4}", max_val, sum_val / (n_bins * chunk_frames) as f32));
                }

                // C. Inference
                let input_value = Value::from_array(input_array.into_dyn()).map_err(|e| e.to_string())?;
                let mut session_guard = self.session.lock();
                
                // Use fixed array of SessionInputValue for positional inputs
                let outputs = session_guard.run([input_value.into()]).map_err(|e| e.to_string())?;
                
                sys_log(&format!("DEBUG: Model inference complete. Output count: {}", outputs.len()));

                // D. Extract & iSTFT
                // Some models only have 1 output (Vocal), others have 2 (Vocal, Inst)
                let v_mag_tensor = outputs[0].try_extract_tensor::<f32>().map_err(|e| e.to_string())?;
                
                // Logging output stats for the first chunk
                if offset == 0 {
                    let out_data = v_mag_tensor.1;
                    let out_max = out_data.iter().fold(0.0f32, |m, &x| m.max(x));
                    sys_log(&format!("DEBUG: Output Tensor Stats - Max: {:.4}", out_max));
                }

                let v_mag = self.tensor_to_vec_2d(&v_mag_tensor.1, &v_mag_tensor.0); 

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

                let v_reconstructed = self.istft(&v_mag, &phase, n_fft, hop_length);
                let i_reconstructed = self.istft(&i_mag, &phase, n_fft, hop_length);

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
    fn load_any_audio(&self, path: &Path, target_rate: u32) -> Result<Vec<Vec<f32>>, String> {
        let file = std::fs::File::open(path).map_err(|e| format!("파일 열기 실패: {}", e))?;
        let mss = MediaSourceStream::new(Box::new(file), Default::default());
        
        let mut hint = Hint::new();
        if let Some(ext) = path.extension().and_then(|s| s.to_str()) {
            hint.with_extension(ext);
        }

        let format_opts = FormatOptions { enable_gapless: true, ..Default::default() };
        let meta_opts = MetadataOptions::default();

        let mut probed = symphonia::default::get_probe()
            .format(&hint, mss, &format_opts, &meta_opts)
            .map_err(|e| format!("포맷 인식 실패: {}", e))?;

        let track = probed.format.default_track().ok_or("트랙을 찾을 수 없습니다.")?;
        let mut decoder = symphonia::default::get_codecs()
            .make(&track.codec_params, &Default::default())
            .map_err(|e| format!("디코더 생성 실패: {}", e))?;

        let track_id = track.id;
        let original_rate = track.codec_params.sample_rate.unwrap_or(44100);
        let n_channels = track.codec_params.channels.map(|c| c.count()).unwrap_or(2);

        let mut samples: Vec<Vec<f32>> = vec![vec![]; n_channels];

        loop {
            let packet = match probed.format.next_packet() {
                Ok(packet) => packet,
                Err(symphonia::core::errors::Error::IoError(_)) => break,
                Err(e) => return Err(format!("패킷 읽기 오류: {}", e)),
            };

            if packet.track_id() != track_id { continue; }

            let decoded = decoder.decode(&packet).map_err(|e| format!("디코딩 오류: {}", e))?;

            match decoded {
                AudioBufferRef::F32(buf) => {
                    for c in 0..n_channels {
                        samples[c].extend_from_slice(buf.chan(c));
                    }
                },
                AudioBufferRef::U8(buf) => {
                    for c in 0..n_channels {
                        for &s in buf.chan(c) {
                            samples[c].push((s as f32 - 128.0) / 128.0);
                        }
                    }
                },
                AudioBufferRef::U16(buf) => {
                    for c in 0..n_channels {
                        for &s in buf.chan(c) {
                            samples[c].push((s as f32 - 32768.0) / 32768.0);
                        }
                    }
                },
                AudioBufferRef::S16(buf) => {
                    for c in 0..n_channels {
                        for &s in buf.chan(c) {
                            samples[c].push(s as f32 / 32768.0);
                        }
                    }
                },
                AudioBufferRef::S32(buf) => {
                    for c in 0..n_channels {
                        for &s in buf.chan(c) {
                            samples[c].push(s as f32 / 2147483648.0);
                        }
                    }
                },
                AudioBufferRef::S24(buf) => {
                    for c in 0..n_channels {
                        for &s in buf.chan(c) {
                            // Symphonia 0.5.x i24 is often a tuple struct i24(i32)
                            samples[c].push(s.0 as f32 / 8388608.0);
                        }
                    }
                },


                _ => return Err("알 수 없는 오디오 버퍼 형식입니다.".into()),
            }
        }

        if samples[0].is_empty() {
            return Err("디코딩된 샘플이 없습니다.".into());
        }

        // 2채널 보장 (모노 -> 스테레오)
        if n_channels == 1 {
            samples.push(samples[0].clone());
        }

        // Resample if needed
        if original_rate != target_rate {
            sys_log(&format!("리샘플링 수행: {}Hz -> {}Hz", original_rate, target_rate));
            let params = SincInterpolationParameters {
                sinc_len: 256,
                f_cutoff: 0.95,
                interpolation: SincInterpolationType::Linear,
                oversampling_factor: 128,
                window: WindowFunction::BlackmanHarris2,
            };

            
            let mut resampler = SincFixedIn::<f32>::new(
                target_rate as f64 / original_rate as f64,
                2.0,
                params,
                samples[0].len(),
                2,
            ).map_err(|e| format!("리샘플러 초기화 실패: {}", e))?;

            let resampled = resampler.process(&samples, None)
                .map_err(|e| format!("리샘플링 오류: {}", e))?;
            
            return Ok(resampled);
        }

        Ok(samples)
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
