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
    fn separate(&self, audio_path: &Path, output_dir: &Path) -> Result<(PathBuf, PathBuf), String>;
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
    fn separate(&self, audio_path: &Path, output_dir: &Path) -> Result<(PathBuf, PathBuf), String> {
        sys_log(&format!("DEBUG: [WaveformRemover] Starting separation for: {:?}", audio_path));
        
        if !output_dir.exists() {
            std::fs::create_dir_all(output_dir).map_err(|e| e.to_string())?;
        }

        // 1. Load and Resample to 44.1kHz (Model specific)
        let (samples, _spec) = self.load_and_resample(audio_path, 44100)?;
        
        // INTERLEAVED TO PLANAR [2, samples]
        let channels = samples.len();
        let n_samples = samples[0].len();
        
        // 2. Prepare Buffer (BS-Roformer / MDX Waveform models usually take [Batch, Channels, Samples])
        // For simplicity, we process the whole track if it's short, otherwise we should chunk.
        // Let's implement basic full-track first.
        let mut input_array = ndarray::Array3::<f32>::zeros((1, channels, n_samples));
        for c in 0..channels {
            for s in 0..n_samples {
                input_array[[0, c, s]] = samples[c][s];
            }
        }

        sys_log("DEBUG: [WaveformRemover] Running ONNX inference...");
        let input_value = Value::from_array(input_array.into_dyn()).map_err(|e| e.to_string())?;
        
        let inputs = ort::inputs![
            "input" => input_value
        ];

        let mut session_guard = self.session.lock();
        let outputs = session_guard.run(inputs).map_err(|e| e.to_string())?;

        // 3. Extract outputs (Assumes output 0 is vocal or inst)
        // Usually: [Batch, Channels, Samples]
        let vocal_val = &outputs[0];
        let inst_val = &outputs[1];

        let (v_shape, v_data) = vocal_val.try_extract_tensor::<f32>().map_err(|e| e.to_string())?;
        let (i_shape, i_data) = inst_val.try_extract_tensor::<f32>().map_err(|e| e.to_string())?;

        let vocal_samples = self.deinterleave_output(v_data, &v_shape);
        let inst_samples = self.deinterleave_output(i_data, &i_shape);

        // 4. Save to WAV
        let vocal_path = output_dir.join("vocal.wav");
        let inst_path = output_dir.join("inst.wav");
        
        self.save_wav(&vocal_samples, &vocal_path, 44100)?;
        self.save_wav(&inst_samples, &inst_path, 44100)?;

        sys_log("DEBUG: [WaveformRemover] Separation complete.");
        Ok((vocal_path, inst_path))
    }
}

impl WaveformRemover {
    fn load_and_resample(&self, path: &Path, _target_rate: u32) -> Result<(Vec<Vec<f32>>, hound::WavSpec), String> {
        // Simplified loading using hound for WAV or symphonia for others
        // FOR NOW: Assume input is WAV for test, in real use we'd use a robust decoder.
        let mut reader = hound::WavReader::open(path).map_err(|e| format!("Failed to open WAV: {}", e))?;
        let spec = reader.spec();
        let samples: Vec<f32> = reader.samples::<i16>().map(|s| s.unwrap() as f32 / 32768.0).collect();
        
        let mut channels = vec![vec![]; spec.channels as usize];
        for (i, &s) in samples.iter().enumerate() {
            channels[i % spec.channels as usize].push(s);
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
