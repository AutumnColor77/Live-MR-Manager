use std::path::{Path, PathBuf};
use ort::session::Session;
use ort::value::Value;
use ort::Error;
use ndarray;
use std::sync::Arc;
use parking_lot::Mutex;
use crate::sys_log;
use ort::execution_providers::{CUDAExecutionProvider, DirectMLExecutionProvider, CPUExecutionProvider};

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
        
        Ok(Self { session: Arc::new(Mutex::new(session)) })
    }
}

impl InferenceEngine for WaveformRemover {
    fn separate(&self, audio_path: &Path, output_dir: &Path, on_progress: Box<dyn Fn(f32) + Send>) -> Result<(PathBuf, PathBuf), String> {
        sys_log(&format!("DEBUG: [WaveformRemover] Starting separation for: {:?}", audio_path));
        
        if !output_dir.exists() {
            std::fs::create_dir_all(output_dir).map_err(|e| e.to_string())?;
        }

        // 1. Load and Resample to 44.1kHz (Forced 2-channel)
        let (samples, _spec) = self.load_and_resample(audio_path, 44100)?;
        
        let channels = samples.len(); // Should be 2 now
        let n_samples = samples[0].len();
        
        // 2. Prepare Buffers for Results
        let mut vocal_out = vec![vec![0.0f32; n_samples]; channels];
        let mut inst_out = vec![vec![0.0f32; n_samples]; channels];

        // 3. Chunked Inference
        // Use a 10s chunk size (at 44.1kHz = 441,000 samples)
        // Some models require static input size. We always pad to chunk_size.
        let chunk_size = 44100 * 10;
        let mut offset = 0;

        while offset < n_samples {
            let actual_chunk = std::cmp::min(chunk_size, n_samples - offset);
            
            // Prepare chunk input tensor [1, 2, chunk_size] (ALWAYS use chunk_size for compatibility)
            let mut input_array = ndarray::Array3::<f32>::zeros((1, channels, chunk_size));
            for c in 0..channels {
                for s in 0..actual_chunk {
                    input_array[[0, c, s]] = samples[c][offset + s];
                }
            }

            let input_value = Value::from_array(input_array.into_dyn()).map_err(|e| e.to_string())?;
            let inputs = ort::inputs!["input" => input_value];

            let mut session_guard = self.session.lock();
            let outputs = session_guard.run(inputs).map_err(|e| e.to_string())?;

            // Extract results
            let v_val = &outputs[0];
            let i_val = &outputs[1];

            let (v_shape, v_data) = v_val.try_extract_tensor::<f32>().map_err(|e| e.to_string())?;
            let (i_shape, i_data) = i_val.try_extract_tensor::<f32>().map_err(|e| e.to_string())?;

            let v_chunk = self.deinterleave_output(v_data, &v_shape);
            let i_chunk = self.deinterleave_output(i_data, &i_shape);

            // Copy back to output buffers (CROP the padding: only copy up to actual_chunk)
            for c in 0..channels {
                for s in 0..std::cmp::min(actual_chunk, v_chunk[c].len()) {
                    vocal_out[c][offset + s] = v_chunk[c][s];
                    inst_out[c][offset + s] = i_chunk[c][s];
                }
            }

            offset += actual_chunk;
            on_progress((offset as f32 / n_samples as f32) * 100.0);
        }

        // 4. Save to WAV
        let vocal_path = output_dir.join("vocal.wav");
        let inst_path = output_dir.join("inst.wav");
        
        self.save_wav(&vocal_out, &vocal_path, 44100)?;
        self.save_wav(&inst_out, &inst_path, 44100)?;

        sys_log("DEBUG: [WaveformRemover] Separation complete.");
        Ok((vocal_path, inst_path))
    }
}

impl WaveformRemover {
    fn load_and_resample(&self, path: &Path, _target_rate: u32) -> Result<(Vec<Vec<f32>>, hound::WavSpec), String> {
        let mut reader = hound::WavReader::open(path).map_err(|e| format!("Failed to open WAV: {}", e))?;
        let spec = reader.spec();
        
        // We force 2 channels (Stereo)
        let mut channels = vec![vec![]; 2];
        let original_channels = spec.channels as usize;

        // Load all samples with correct bit-depth handling and NO unwrap()
        let raw_samples: Vec<f32> = match (spec.sample_format, spec.bits_per_sample) {
            (hound::SampleFormat::Int, 16) => {
                reader.samples::<i16>()
                    .map(|s| s.map(|v| v as f32 / 32768.0))
                    .collect::<Result<Vec<f32>, _>>()
                    .map_err(|e| format!("16비트 오디오 읽기 실패: {}", e))?
            },
            (hound::SampleFormat::Int, 24) => {
                // 24-bit is read as i32, and range is [-2^23, 2^23-1]
                reader.samples::<i32>()
                    .map(|s| s.map(|v| v as f32 / 8388608.0))
                    .collect::<Result<Vec<f32>, _>>()
                    .map_err(|e| format!("24비트 오디오 읽기 실패: {}", e))?
            },
            (hound::SampleFormat::Int, 32) => {
                // 32-bit range is [-2^31, 2^31-1]
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

        // Handle Mono to Stereo conversion
        if original_channels == 1 {
            channels[1] = channels[0].clone();
        } else if channels[1].is_empty() && !channels[0].is_empty() {
            // Safety in case channel count was somehow 1 but reported differently
            channels[1] = channels[0].clone();
        }

        Ok((channels, spec))
    }

    fn deinterleave_output(&self, data: &[f32], shape: &[i64]) -> Vec<Vec<f32>> {
        // Assume shape [1, 2, Samples]
        let n_channels = shape[1] as usize;
        let n_samples = shape[2] as usize;
        let mut result = vec![vec![0.0; n_samples]; n_channels];
        
        for c in 0..n_channels {
            for s in 0..n_samples {
                result[c][s] = data[c * n_samples + s];
            }
        }
        result
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
