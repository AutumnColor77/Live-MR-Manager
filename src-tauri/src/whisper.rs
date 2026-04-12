use std::path::Path;
use tauri::Emitter;
use ndarray::{Array2, Array3};
use ort::{
    execution_providers::{CPUExecutionProvider, CUDAExecutionProvider, DirectMLExecutionProvider},
    session::Session,
    value::Value,
};
use ort::ep::ExecutionProvider;
use tokenizers::Tokenizer;
use anyhow::{Result, anyhow};
use rustfft::{FftPlanner, num_complex::Complex};
use std::collections::HashMap;
use crate::audio_player::sys_log;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct TimestampedWord {
    pub text: String,
    pub start_sec: f32,
    pub end_sec: f32,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct TranscribedSegment {
    pub text: String,
    pub start_sec: f32,
    pub end_sec: f32,
    pub rms: f32,
    pub zcr: f32,
    pub voice_confidence: f32,
    pub words: Vec<TimestampedWord>,
}

// Whisper constant parameters
const SAMPLE_RATE: u32 = 16000;
const N_FFT: usize = 400;
const HOP_LENGTH: usize = 160;
const N_MELS: usize = 80;
const CHUNK_LENGTH: usize = 30; // 30 seconds
const SAMPLES_PER_CHUNK: usize = CHUNK_LENGTH * SAMPLE_RATE as usize; // 480,000
const FRAMES_PER_CHUNK: usize = SAMPLES_PER_CHUNK / HOP_LENGTH; // 3000

pub struct WhisperEngine {
    encoder: Session,
    decoder_init: Session,
    decoder_main: Session,
    tokenizer: Tokenizer,
    mel_filters: Array2<f32>,
    encoder_input_init_name: String,
    encoder_input_main_name: String,
    decoder_has_cache_branch: bool,
    decoder_has_past_key_values: bool,
    past_key_value_names: Vec<String>,
    present_value_names: Vec<String>,
    init_present_names: Vec<String>,
    banned_tokens: Vec<usize>,
}

impl WhisperEngine {
    pub fn new(encoder_path: &Path, decoder_init_path: &Path, decoder_main_path: &Path, tokenizer_path: &Path) -> Result<Self> {
        sys_log(&format!("[Whisper] Loading models: Encoder={:?}, Init={:?}, Main={:?}", encoder_path, decoder_init_path, decoder_main_path));
        
        let mut gpu_providers = Vec::new();
        if CUDAExecutionProvider::default().is_available().unwrap_or(false) {
            gpu_providers.push(CUDAExecutionProvider::default().build());
        } else if DirectMLExecutionProvider::default().is_available().unwrap_or(false) {
            gpu_providers.push(DirectMLExecutionProvider::default().build());
        }
        gpu_providers.push(CPUExecutionProvider::default().build());

        let mut cpu_providers = Vec::new();
        cpu_providers.push(CPUExecutionProvider::default().build());

        let encoder = Session::builder()
            .map_err(|e| anyhow!("Failed to create encoder builder: {}", e))?
            .with_execution_providers(gpu_providers)
            .map_err(|e| anyhow!("Failed to set encoder providers: {}", e))?
            .with_intra_threads(num_cpus::get())
            .map_err(|e| anyhow!("Failed to set encoder threads: {}", e))?
            .commit_from_file(encoder_path)
            .map_err(|e| anyhow!("Failed to load encoder model: {}", e))?;

        let decoder_init = Session::builder()
            .map_err(|e| anyhow!("Failed to create decoder_init builder: {}", e))?
            .with_execution_providers(cpu_providers.clone())
            .map_err(|e| anyhow!("Failed to set decoder_init providers: {}", e))?
            .with_intra_threads(num_cpus::get())
            .map_err(|e| anyhow!("Failed to set decoder_init threads: {}", e))?
            .commit_from_file(decoder_init_path)
            .map_err(|e| anyhow!("Failed to load decoder_init model: {}", e))?;

        let decoder_main = Session::builder()
            .map_err(|e| anyhow!("Failed to create decoder_main builder: {}", e))?
            .with_execution_providers(cpu_providers)
            .map_err(|e| anyhow!("Failed to set decoder_main providers: {}", e))?
            .with_intra_threads(num_cpus::get())
            .map_err(|e| anyhow!("Failed to set decoder_main threads: {}", e))?
            .commit_from_file(decoder_main_path)
            .map_err(|e| anyhow!("Failed to load decoder_main model: {}", e))?;

        let tokenizer = Tokenizer::from_file(tokenizer_path)
            .map_err(|e| anyhow!("Failed to load tokenizer: {}", e))?;

        let mel_filters = Self::get_mel_filters(SAMPLE_RATE, N_FFT, N_MELS);

        let mut encoder_input_init_name = "encoder_hidden_states".to_string();
        for input in decoder_init.inputs() {
            let name = input.name();
            if (name.contains("encoder_hidden_states") || name.contains("encoder")) && !name.contains("past_key_values") {
                encoder_input_init_name = name.to_string();
                break;
            }
        }

        let mut encoder_input_main_name = String::new(); // May be empty for some specialized models
        let main_input_names: Vec<String> = decoder_main.inputs().iter().map(|i| i.name().to_string()).collect();
        sys_log(&format!("[Whisper-Debug] Main Decoder Inputs: {:?}", main_input_names));

        for name in &main_input_names {
            if (name.contains("encoder_hidden_states") || name.contains("encoder")) && !name.contains("past_key_values") {
                encoder_input_main_name = name.clone();
                break;
            }
        }

        let init_output_names: Vec<String> = decoder_init.outputs().iter().map(|o| o.name().to_string()).collect();
        sys_log(&format!("[Whisper-Debug] Init Decoder Outputs: {:?}", init_output_names));
        sys_log(&format!("[Whisper] Using Encoder Input Name: (Init={}, Main='{}')", encoder_input_init_name, encoder_input_main_name));

        let decoder_has_cache_branch = decoder_main.inputs().iter().any(|input| input.name() == "use_cache_branch");
        let decoder_has_past_key_values = decoder_main.inputs().iter().any(|input| input.name().starts_with("past_key_values"));

        let mut past_key_value_names = Vec::new();
        for input in decoder_main.inputs() {
            if input.name().starts_with("past_key_values") {
                past_key_value_names.push(input.name().to_string());
            }
        }
        past_key_value_names.sort();

        let mut present_value_names = Vec::new();
        for output in decoder_main.outputs() {
            let name = output.name();
            if name.starts_with("present") || name.contains("present") {
                present_value_names.push(name.to_string());
            }
        }
        present_value_names.sort();

        let mut init_present_names = Vec::new();
        for output in decoder_init.outputs() {
            let name = output.name();
            if name.starts_with("present") || name.contains("present") {
                init_present_names.push(name.to_string());
            }
        }
        init_present_names.sort();

        let mut banned_tokens = Vec::new();
        let hallucination_chars = ['(', ')', '[', ']', '{', '}', '뚜', '껑', '놀', '람', '지', '은', '아', '주', '시', '청'];
        for (token_str, id) in tokenizer.get_vocab(true) {
            if hallucination_chars.iter().any(|&c| token_str.contains(c)) {
                banned_tokens.push(id as usize);
            }
        }

        sys_log(&format!("[Whisper-Debug] Init Present Outputs: {:?}", init_present_names));
        sys_log(&format!("[Whisper-Debug] Main Past Inputs: {:?}", past_key_value_names));
        sys_log(&format!("[Whisper-Debug] Main Present Outputs: {:?}", present_value_names));

        let model_type = if decoder_has_cache_branch { "Merged" } else { "Split (Dual)" };
        sys_log(&format!("[Whisper] Detected Decoder Configuration: {}", model_type));
        sys_log(&format!("[Whisper] Banned {} hallucination-prone tokens.", banned_tokens.len()));

        Ok(Self {
            encoder,
            decoder_init,
            decoder_main,
            tokenizer,
            mel_filters,
            encoder_input_init_name,
            encoder_input_main_name,
            decoder_has_cache_branch,
            decoder_has_past_key_values,
            past_key_value_names,
            present_value_names,
            init_present_names,
            banned_tokens,
        })
    }


    fn get_mel_filters(sr: u32, n_fft: usize, n_mels: usize) -> Array2<f32> {
        // Mel scale constants
        let f_min = 0.0f32;
        let f_max = (sr / 2) as f32;
        
        let hz_to_mel = |hz: f32| 2595.0 * (1.0 + hz / 700.0).log10();
        let mel_to_hz = |mel: f32| 700.0 * (10.0f32.powf(mel / 2595.0) - 1.0);
        
        let min_mel = hz_to_mel(f_min);
        let max_mel = hz_to_mel(f_max);
        
        let mels = Array2::from_shape_fn((n_mels + 2, 1), |(i, _)| {
            min_mel + (max_mel - min_mel) * i as f32 / (n_mels + 1) as f32
        });
        
        let hf = mels.mapv(mel_to_hz);
        let bins = hf.mapv(|h| (n_fft + 1) as f32 * h / sr as f32);
        
        let mut filters = Array2::zeros((n_mels, n_fft / 2 + 1));
        
        for i in 0..n_mels {
            let prev = bins[[i, 0]] as usize;
            let curr = bins[[i + 1, 0]] as usize;
            let next = bins[[i + 2, 0]] as usize;
            
            for j in prev..curr {
                filters[[i, j]] = (j - prev) as f32 / (curr - prev) as f32;
            }
            for j in curr..next {
                filters[[i, j]] = (next - j) as f32 / (next - curr) as f32;
            }
        }
        filters
    }

    pub fn audio_to_mel(&self, samples: &[f32]) -> (Array3<f32>, f32) {
        // Step 1: Pad waveform to exactly SAMPLES_PER_CHUNK (480,000 / 30s) before STFT.
        // Whisper's encoder expects a fixed-length context window. Trailing silence is safe.
        let mut padded_waveform = vec![0.0f32; SAMPLES_PER_CHUNK];
        let copy_len = samples.len().min(SAMPLES_PER_CHUNK);
        padded_waveform[..copy_len].copy_from_slice(&samples[..copy_len]);

        // Step 2: Apply reflection padding of n_fft // 2 on each side (PyTorch center=True).
        // This centers each STFT frame on the target sample, preventing edge phase distortion.
        let reflect_len = N_FFT / 2; // 200 samples
        let total_len = SAMPLES_PER_CHUNK + 2 * reflect_len;
        let mut reflected = vec![0.0f32; total_len];

        // Left: reflect signal[reflect_len-1..0]
        for i in 0..reflect_len {
            reflected[i] = padded_waveform[reflect_len - 1 - i];
        }
        // Center: original padded waveform
        reflected[reflect_len..reflect_len + SAMPLES_PER_CHUNK]
            .copy_from_slice(&padded_waveform);
        // Right: reflect signal[N-2..N-2-reflect_len]
        for i in 0..reflect_len {
            reflected[reflect_len + SAMPLES_PER_CHUNK + i] =
                padded_waveform[SAMPLES_PER_CHUNK - 2 - i];
        }

        // Step 3: Compute STFT with Hann window over exactly FRAMES_PER_CHUNK (3000) frames.
        // Frame k starts at index k*HOP_LENGTH in the reflected signal,
        // which is centered at sample k*HOP_LENGTH of the original waveform.
        let mut planner = FftPlanner::new();
        let fft = planner.plan_fft_forward(N_FFT);
        let window: Vec<f32> = (0..N_FFT)
            .map(|i| 0.5 * (1.0 - (2.0 * std::f32::consts::PI * i as f32 / (N_FFT - 1) as f32).cos()))
            .collect();

        let mut mel_spectrogram = Array2::<f32>::zeros((N_MELS, FRAMES_PER_CHUNK));
        for f in 0..FRAMES_PER_CHUNK {
            let start = f * HOP_LENGTH;
            let mut buffer = vec![Complex::new(0.0f32, 0.0f32); N_FFT];
            for i in 0..N_FFT {
                let idx = start + i;
                if idx < reflected.len() {
                    buffer[i] = Complex::new(reflected[idx] * window[i], 0.0);
                }
            }
            fft.process(&mut buffer);
            for m in 0..N_MELS {
                let mut mel_sum = 0.0f32;
                for j in 0..(N_FFT / 2 + 1) {
                    mel_sum += buffer[j].norm_sqr() * self.mel_filters[[m, j]];
                }
                mel_spectrogram[[m, f]] = mel_sum;
            }
        }

        let log_mel = mel_spectrogram.mapv(|val| val.max(1e-10).log10());
        let max_val = log_mel.fold(f32::MIN, |a, &b| a.max(b));
        // Official Whisper normalization (whisper/audio.py):
        //   log_spec = max(log_spec, log_spec.max() - 8.0)   <- clamp floor
        //   log_spec = (log_spec + 4.0) / 4.0                <- shift to [-1, 1]
        // Our previous (v - max + 8.0) / 8.0 produced [0, 1] — wrong range for the model.
        let norm_mel = log_mel.mapv(|v| ((v.max(max_val - 8.0)) + 4.0) / 4.0);

        // norm_mel is already (N_MELS, FRAMES_PER_CHUNK) — no Mel-level zero-padding needed.
        let final_mel = norm_mel
            .into_shape_with_order(((1, N_MELS, FRAMES_PER_CHUNK), ndarray::Order::C))
            .unwrap();
        (final_mel, max_val)
    }

    pub fn detect_voice_regions(&self, samples: &[f32], threshold: f32) -> Vec<(usize, usize)> {
        let frame_size = 800; // 50ms at 16kHz
        let mut voice_flags = Vec::new();
        
        for chunk in samples.chunks(frame_size) {
            let mut rms = 0.0f32;
            let mut zcr = 0.0f32;
            for i in 0..chunk.len() {
                rms += chunk[i] * chunk[i];
                if i > 0 && (chunk[i] >= 0.0) != (chunk[i-1] >= 0.0) {
                    zcr += 1.0;
                }
            }
            rms = (rms / chunk.len() as f32).sqrt();
            zcr /= chunk.len() as f32;

            // Use the dynamic threshold provided by the user
            let is_voice = rms > threshold || (rms > (threshold / 4.0) && zcr < 0.40);
            voice_flags.push(is_voice);
        }

        // Smoothing: fill 1-frame gaps (T-F-T -> T-T-T)
        let mut smoothed_flags = voice_flags.clone();
        for i in 1..voice_flags.len().saturating_sub(1) {
            if !voice_flags[i] && voice_flags[i-1] && voice_flags[i+1] {
                smoothed_flags[i] = true;
            }
        }

        // Extract raw regions
        let mut regions = Vec::new();
        let mut start = None;
        for (i, &is_voice) in smoothed_flags.iter().enumerate() {
            if is_voice && start.is_none() {
                start = Some(i);
            } else if !is_voice && start.is_some() {
                let s = start.unwrap();
                if i - s >= 3 { // Min 150ms
                    regions.push((s * frame_size, i * frame_size));
                }
                start = None;
            }
        }
        if let Some(s) = start {
            regions.push((s * frame_size, smoothed_flags.len() * frame_size));
        }

        // Padding & Bridge Gaps
        let mut final_regions: Vec<(usize, usize)> = Vec::new();
        let padding = 16000 * 4 / 10; // 400ms
        let gap_threshold = 16000 * 8 / 10; // 800ms
        
        for (s, e) in regions {
            let s_pad = s.saturating_sub(padding);
            let e_pad = (e + padding).min(samples.len());
            
            if let Some(last) = final_regions.last_mut() {
                // If this region is close to the last one, bridge them
                if s_pad <= last.1 + gap_threshold {
                    last.1 = e_pad;
                    continue;
                }
            }
            final_regions.push((s_pad, e_pad));
        }

        final_regions
    }

    pub fn transcribe_with_timestamps(
        &mut self,
        samples: &[f32],
        language: &str,
        vad_threshold: f32,
        handle: Option<&tauri::AppHandle>,
    ) -> Result<Vec<TranscribedSegment>> {
        let max_amp = samples.iter().fold(0.0f32, |a, &b| a.max(b.abs()));
        sys_log(&format!("[Whisper] Transcription Start. Length: {:.2}s, Max Amp: {:.4}, VAD: {:.4}", samples.len() as f32 / 16000.0, max_amp, vad_threshold));

        let mut all_segments = Vec::new();
        
        // Step 1: Detect voice regions to avoid transcribing silence (Using dynamic threshold)
        let regions = self.detect_voice_regions(samples, vad_threshold);
        let total_regions = regions.len();
        sys_log(&format!("[Whisper] VAD detected {} regions.", total_regions));

        for (idx, (start_raw, end_raw)) in regions.into_iter().enumerate() {
            // Emit progress
            if let Some(h) = handle {
                let progress = ((idx as f32 / total_regions as f32) * 100.0) as i32;
                let _ = h.emit("alignment-progress", progress);
            }
            // Add Context Padding: 500ms before and after (if possible) for better context
            let padding = (SAMPLE_RATE as f32 * 0.5) as usize;
            let start = start_raw.saturating_sub(padding);
            let end = (end_raw + padding).min(samples.len());
            
            let mut chunk_samples = samples[start..end].to_vec();
            let offset_sec = start as f32 / 16000.0;
            let duration_sec = chunk_samples.len() as f32 / 16000.0;

            // Step 1: Peak Normalization for this segment to improve low-volume recognition
            let mut max_abs = 0.0f32;
            for &s in &chunk_samples {
                let abs_s = f32::abs(s);
                if abs_s > max_abs { max_abs = abs_s; }
            }
            if max_abs > 1e-6 {
                let scale = 0.85 / max_abs; // Scale to 0.85 peak (conservative)
                for s in &mut chunk_samples { *s *= scale; }
            }
            
            // Re-calculate RMS and ZCR for the normalized chunk
            let mut rms = 0.0f32;
            let mut zcr = 0.0f32;
            for i in 0..chunk_samples.len() {
                rms += chunk_samples[i] * chunk_samples[i];
                if i > 0 && (chunk_samples[i] >= 0.0) != (chunk_samples[i-1] >= 0.0) {
                    zcr += 1.0;
                }
            }
            rms = (rms / chunk_samples.len() as f32).sqrt();
            zcr /= chunk_samples.len() as f32;
            let voice_confidence = (1.0 - (zcr * 5.0).min(0.5) + (rms * 10.0).min(0.5)).min(1.0);

            // Step 2: Try Whisper Transcription for this region
            let mut whisper_text = String::new();
            let mut timestamped_words = Vec::new();
            let mut current_start_time = 0.0f32;
            let mut pending_word = String::new();
            
            for (_sub_idx, sub_samples) in chunk_samples.chunks(16000 * 30).enumerate() {
                let (mel, _max_log_mel) = self.audio_to_mel(sub_samples);
                let mel_value = Value::from_array(mel).map_err(|e| anyhow!("Failed to create mel value: {}", e))?;

                let hidden_states = {
                    let encoder_outputs = self.encoder.run(ort::inputs!["input_features" => mel_value])? ;
                    let (hidden_shape, hidden_data) = encoder_outputs[0].try_extract_tensor::<f32>()?;
                    let hidden_dims: Vec<usize> = hidden_shape.iter().map(|&d| d as usize).collect();
                    ndarray::ArrayView::from_shape(ndarray::IxDyn(&hidden_dims), hidden_data)?.to_owned()
                };

                let mut tokens = vec![50258];
                match language { "ko" => tokens.push(50264), "en" => tokens.push(50259), "ja" => tokens.push(50266), _ => tokens.push(50259) }
                tokens.push(50359); tokens.push(50364);

                let mut last_timestamp = 0.0f32;
                let mut pending_tokens: Vec<u32> = Vec::new();
                let mut cache_map: HashMap<String, ndarray::ArrayD<f32>> = HashMap::new();
                
                // Track recent tokens for a smarter repetition penalty
                let mut recent_tokens: Vec<i64> = Vec::new();

                for _step in 0..150 {  // Decreased from 200 to 150 to reduce hallucination runway
                    let current_input_tokens = if self.decoder_has_past_key_values && !cache_map.is_empty() {
                        vec![*tokens.last().unwrap()]
                    } else {
                        tokens.clone()
                    };

                    let tokens_array = Array2::from_shape_vec((1, current_input_tokens.len()), current_input_tokens.clone())?
                        .as_standard_layout().to_owned();
                    let tokens_value = Value::from_array(tokens_array.clone())?;
                    
                    // 1. Core Inputs
                    let mut decoder_inputs: Vec<(String, Value)> = vec![
                        ("input_ids".to_string(), tokens_value.into())
                    ];

                    let enc_input_name = if _step == 0 { &self.encoder_input_init_name } else { &self.encoder_input_main_name };
                    if !enc_input_name.is_empty() {
                        decoder_inputs.push((enc_input_name.clone(), Value::from_array(hidden_states.as_standard_layout().to_owned())?.into()));
                    }
                    
                    // 3. Selective Past Key Values Injection
                    if _step > 0 && self.decoder_has_past_key_values {
                        for name in &self.past_key_value_names {
                            if let Some(arr) = cache_map.get(name) {
                                let val = arr.as_standard_layout().to_owned();
                                decoder_inputs.push((name.clone(), Value::from_array(val)?.into()));
                            }
                        }
                    }

                    if _step % 20 == 0 {
                         sys_log(&format!("[Whisper-Debug] Steps: {} ...", _step));
                    }

                    let decoder_outputs = if _step == 0 {
                        self.decoder_init.run(decoder_inputs)
                    } else {
                        self.decoder_main.run(decoder_inputs)
                    }.map_err(|e| {
                        let err = format!("[Whisper-Error] Decoder run failed at step {}: {}", _step, e);
                        sys_log(&err);
                        anyhow!(err)
                    })?;
                    
                    let logits_output = decoder_outputs.get("logits").ok_or_else(|| anyhow!("Logits not found"))?;
                    let (_logits_shape, logits_data) = logits_output.try_extract_tensor::<f32>()?;
                    let n_tokens = current_input_tokens.len();
                    let logits_view = ndarray::ArrayView::from_shape(ndarray::IxDyn(&[1, n_tokens, 51865]), logits_data)?;
                    let mut last_logits = logits_view.slice(ndarray::s![0, n_tokens - 1, ..]).to_owned();
                    
                    // --- REPETITION PENALTY & TRASH FILTERING ---
                    // 1. Aggressive repetition penalty: subtract more for recently seen tokens
                    for (i, &t) in recent_tokens.iter().rev().enumerate().take(30) {
                        if (t as usize) < 51865 {
                            let penalty = 5.0 + (i as f32 * 0.2);
                            last_logits[t as usize] -= penalty;
                        }
                    }

                    // 2. Hard Logit Suppression for banned hallucination tokens
                    for &t in &self.banned_tokens {
                        if t < 51865 {
                            last_logits[t] = -100.0;
                        }
                    }

                    // 4. Update Cache Map for the next step using name-based string replacement.
                    // CRITICAL FIX: Do NOT use index-based mapping (self.past_key_value_names[i]).
                    // Init decoder outputs 24 tensors (encoder + decoder cache), but Main decoder
                    // only inputs 12 (decoder-only). Index mapping would corrupt encoder cache slots
                    // by overwriting them with decoder-only tensors from the main loop.
                    // Instead, replace "present" -> "past_key_values" to safely target only the
                    // correct decoder cache entries, leaving encoder cache intact.
                    if self.decoder_has_past_key_values {
                        let active_present_names = if _step == 0 { &self.init_present_names } else { &self.present_value_names };
                        
                        for out_name in active_present_names.iter() {
                            if let Some(pkv_val) = decoder_outputs.get(out_name.as_str()) {
                                let (shape, data) = pkv_val.try_extract_tensor::<f32>()?;
                                let dims: Vec<usize> = (0..shape.len()).map(|idx| shape[idx] as usize).collect();
                                let arr = ndarray::ArrayView::from_shape(ndarray::IxDyn(&dims), data)?.to_owned();
                                let target_name = out_name.replace("present", "past_key_values");
                                cache_map.insert(target_name, arr);
                            }
                        }
                    }

                    let next_token = last_logits.iter().enumerate()
                        .max_by(|(_, a), (_, b)| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal))
                        .map(|(i, _)| i as i64)
                        .unwrap_or(50257);
                    
                    // --- SAFETY BREAKS ---
                    // 1. End of Transcription or No Speech tokens
                    if next_token == 50257 || next_token == 50362 { break; } 

                    // 2. Continuous Hallucination Detection (If we see too many banned/repeated tokens)
                    if tokens.len() > 100 { 
                        sys_log("[Whisper-Safety] Breaking long loop (potential hallucination)");
                        break; 
                    }

                    if next_token >= 50364 {
                        let timestamp = (next_token - 50364) as f32 * 0.02;
                        if !pending_tokens.is_empty() {
                            let word = self.tokenizer.decode(&pending_tokens, true).unwrap_or_else(|_| "".to_string());
                            // Filter out common hallucination characters like brackets
                            let word_clean = word.replace("[", "").replace("]", "");
                            if !word_clean.is_empty() {
                                pending_word.push_str(&word_clean);
                                whisper_text.push_str(&word_clean); // FIX: Populate the missing segment text
                            }
                            pending_tokens.clear();
                        }

                        if !pending_word.is_empty() {
                            timestamped_words.push(TimestampedWord {
                                text: pending_word.trim().to_string(),
                                start_sec: offset_sec + current_start_time,
                                end_sec: offset_sec + timestamp,
                            });
                            pending_word.clear();
                        }
                        current_start_time = timestamp;
                        last_timestamp = timestamp;
                    } else {
                        pending_tokens.push(next_token as u32);
                        recent_tokens.push(next_token);
                    }

                    tokens.push(next_token);
                    if tokens.len() > 300 { break; }
                }

                // Final flush for the segment to catch any remaining tokens
                if !pending_tokens.is_empty() || !pending_word.is_empty() {
                    let word = if !pending_tokens.is_empty() {
                        self.tokenizer.decode(&pending_tokens, true).unwrap_or_default()
                    } else {
                        String::new()
                    };
                    let word_clean = word.replace("[", "").replace("]", "");
                    let final_text = format!("{}{}", pending_word, word_clean).trim().to_string();
                    if !final_text.is_empty() {
                         whisper_text.push_str(&final_text); // FIX: Ensure text is in the final segment
                         timestamped_words.push(TimestampedWord {
                            text: final_text.clone(),
                            start_sec: offset_sec + current_start_time,
                            end_sec: offset_sec + last_timestamp + 0.3, // Smaller buffer for word sync
                        });
                        sys_log(&format!("[Whisper-Word-Final] '{}' ({:.2}s)", final_text, offset_sec + current_start_time));
                    }
                    pending_tokens.clear();
                    pending_word.clear();
                }
            }

            // [CRITICAL] Even if Whisper failed to output text, we MUST push a segment if VAD was high confidence
            // This ensures the frontend doesn't have "black holes" where audio clearly exists.
            let display_text = if whisper_text.trim().is_empty() { 
                "(Voice Detected)".to_string() 
            } else { 
                whisper_text.trim().to_string() 
            };

            all_segments.push(TranscribedSegment {
                text: display_text,
                start_sec: offset_sec,
                end_sec: offset_sec + duration_sec,
                rms,
                zcr,
                voice_confidence,
                words: timestamped_words,
            });
        }

        sys_log(&format!("[Whisper] Transcription finished. Total segments: {}", all_segments.len()));
        Ok(all_segments)
    }
}
