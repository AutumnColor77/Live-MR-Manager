use std::path::Path;
use tauri::Emitter;
use ndarray::{Array2, Array3};
use ort::{session::Session, value::Value};
use ort::execution_providers::{CUDAExecutionProvider, CPUExecutionProvider};
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
    decoder: Session,
    tokenizer: Tokenizer,
    mel_filters: Array2<f32>,
    decoder_has_cache_branch: bool,
    decoder_has_past_key_values: bool,
    past_key_value_names: Vec<String>,
    present_value_names: Vec<String>,
    banned_tokens: Vec<usize>, // Tokens to suppress (hallucinations)
}

impl WhisperEngine {
    pub fn new(encoder_path: &Path, decoder_path: &Path, tokenizer_path: &Path) -> Result<Self> {
        sys_log(&format!("[Whisper] Loading models: Encoder={:?}, Decoder={:?}", encoder_path, decoder_path));
        
        // Try providers in order of preference: CUDA -> CPU (Skip DML for Whisper due to Reshape node crashes)
        let mut providers = Vec::new();
        if CUDAExecutionProvider::default().is_available().unwrap_or(false) {
            providers.push(CUDAExecutionProvider::default().build());
        }
        // DirectML is prone to Reshape node errors with Whisper models on some hardware (like RTX 2060).
        // Since Whisper Base Q4 is lightweight, we prefer CPU for stability.
        providers.push(CPUExecutionProvider::default().build());

        let encoder = Session::builder()
            .map_err(|e| anyhow!("Failed to create session builder: {}", e))?
            .with_execution_providers(providers.clone())
            .map_err(|e| anyhow!("Failed to set execution provider: {}", e))?
            .commit_from_file(encoder_path)
            .map_err(|e| anyhow!("Failed to load encoder: {}", e))?;
            
        for input in encoder.inputs() {
            sys_log(&format!("[Whisper] Encoder Input: {}", input.name()));
        }

        let decoder = Session::builder()
            .map_err(|e| anyhow!("Failed to create session builder: {}", e))?
            .with_execution_providers(providers)
            .map_err(|e| anyhow!("Failed to set execution provider: {}", e))?
            .commit_from_file(decoder_path)
            .map_err(|e| anyhow!("Failed to load decoder: {}", e))?;
            
        for input in decoder.inputs() {
            sys_log(&format!("[Whisper] Decoder Input: {:?}", input));
        }
            
        let tokenizer = Tokenizer::from_file(tokenizer_path)
            .map_err(|e| anyhow!("Failed to load tokenizer: {}", e))?;

        let mel_filters = Self::get_mel_filters(SAMPLE_RATE, N_FFT, N_MELS);

        let decoder_has_cache_branch = decoder.inputs().iter().any(|input| input.name() == "use_cache_branch");
        let decoder_has_past_key_values = decoder.inputs().iter().any(|input| input.name().starts_with("past_key_values"));

        let mut past_key_value_names = Vec::new();
        for input in decoder.inputs() {
            if input.name().starts_with("past_key_values") {
                past_key_value_names.push(input.name().to_string());
            }
        }
        // Sort to ensure consistent ordering if needed, though HashMap access is name-based
        past_key_value_names.sort();

        let mut present_value_names = Vec::new();
        for output in decoder.outputs() {
            if output.name().starts_with("present") {
                present_value_names.push(output.name().to_string());
            }
        }
        present_value_names.sort();

        let mut banned_tokens = Vec::new();
        // Specifically ban tokens that lead to hallucinations like [Sound], (Surprise), and the reported "Lid" patterns
        let hallucination_chars = ['(', ')', '[', ']', '{', '}', '뚜', '껑', '놀', '람'];
        for (token_str, id) in tokenizer.get_vocab(true) {
            if hallucination_chars.iter().any(|&c| token_str.contains(c)) {
                banned_tokens.push(id as usize);
            }
        }
        sys_log(&format!("[Whisper] Banned {} hallucination-prone tokens.", banned_tokens.len()));

        Ok(Self {
            encoder,
            decoder,
            tokenizer,
            mel_filters,
            decoder_has_cache_branch,
            decoder_has_past_key_values,
            past_key_value_names,
            present_value_names,
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
        // ... (existing audio_to_mel logic) ...
        // Keeping as is for now, but will use max_val locally in transcribe.
        // Wait, I should just keep the function signature fixed for now to avoid breaking too much.
        let mut planner = FftPlanner::new();
        let fft = planner.plan_fft_forward(N_FFT);
        let window: Vec<f32> = (0..N_FFT)
            .map(|i| 0.5 * (1.0 - (2.0 * std::f32::consts::PI * i as f32 / (N_FFT - 1) as f32).cos()))
            .collect();

        let num_frames = (samples.len() as f32 / HOP_LENGTH as f32).ceil() as usize;
        let mut mel_spectrogram = Array2::<f32>::zeros((N_MELS, num_frames));

        for f in 0..num_frames {
            let start = f * HOP_LENGTH;
            let mut buffer = vec![Complex::new(0.0f32, 0.0f32); N_FFT];
            for i in 0..N_FFT {
                if start + i < samples.len() {
                    buffer[i] = Complex::new(samples[start + i] * window[i], 0.0);
                }
            }
            fft.process(&mut buffer);
            let mut power_spec = Vec::with_capacity(N_FFT / 2 + 1);
            for i in 0..(N_FFT / 2 + 1) {
                power_spec.push(buffer[i].norm_sqr());
            }
            for m in 0..N_MELS {
                let mut mel_sum = 0.0;
                for j in 0..(N_FFT / 2 + 1) {
                    mel_sum += power_spec[j] * self.mel_filters[[m, j]];
                }
                mel_spectrogram[[m, f]] = mel_sum;
            }
        }

        let log_mel = mel_spectrogram.mapv(|val| val.max(1e-10).log10());
        let max_val = log_mel.fold(f32::MIN, |a, &b| a.max(b));
        let norm_mel = log_mel.mapv(|v| (v - max_val + 8.0) / 8.0);
        
        let mut final_mel = Array3::<f32>::zeros((1, N_MELS, FRAMES_PER_CHUNK));
        let copy_frames = num_frames.min(FRAMES_PER_CHUNK);
        for m in 0..N_MELS {
            for f in 0..copy_frames {
                final_mel[[0, m, f]] = norm_mel[[m, f]];
            }
        }
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
                    
                    if _step == 0 {
                        sys_log(&format!("[Whisper-Debug] Init Step - input_ids shape: {:?}, hidden_states shape: {:?}", tokens_array.shape(), hidden_states.shape()));
                    }

                    let mut decoder_inputs = ort::inputs![
                        "input_ids" => tokens_value,
                        "encoder_hidden_states" => Value::from_array(hidden_states.as_standard_layout().to_owned())?
                    ];

                    if self.decoder_has_cache_branch {
                        let use_cache = !cache_map.is_empty();
                        let use_cache_arr = ndarray::Array1::from_elem(1, use_cache);
                        decoder_inputs.push(("use_cache_branch".into(), Value::from_array(use_cache_arr)?.into()));
                    }

                    if self.decoder_has_past_key_values {
                        for name in &self.past_key_value_names {
                            if let Some(arr) = cache_map.get(name) {
                                decoder_inputs.push((name.clone().into(), Value::from_array(arr.clone())?.into()));
                            } else if name.contains("encoder") {
                                // For Merged models, encoder PKV is often required even in init step
                                let dummy = ndarray::Array4::<f32>::zeros((1, 8, 1500, 64));
                                decoder_inputs.push((name.clone().into(), Value::from_array(dummy)?.into()));
                            }
                            // Note: decoder PKVs are omitted in step 0 to see if it bypasses Reshape_4
                        }
                    }

                    let decoder_outputs = self.decoder.run(decoder_inputs)
                        .map_err(|e| {
                            let err_msg = format!("[Whisper-Error] Decoder run failed: {}", e);
                            let _ = crate::audio_player::sys_log(&err_msg);
                            anyhow!(err_msg)
                        })?;
                    
                    let logits_output = decoder_outputs.get("logits").ok_or_else(|| anyhow!("Logits not found"))?;
                    let (_logits_shape, logits_data) = logits_output.try_extract_tensor::<f32>()?;
                    let n_tokens = current_input_tokens.len();
                    let logits_view = ndarray::ArrayView::from_shape(ndarray::IxDyn(&[1, n_tokens, 51865]), logits_data)?;
                    let mut last_logits = logits_view.slice(ndarray::s![0, n_tokens - 1, ..]).to_owned();
                    
                    // --- REPETITION PENALTY & TRASH FILTERING ---
                    // 1. Aggressive repetition penalty: subtract more for recently seen tokens
                    for (i, &t) in recent_tokens.iter().rev().enumerate().take(20) {
                        if (t as usize) < 51865 {
                            let penalty = 2.0 + (i as f32 * 0.1);
                            last_logits[t as usize] -= penalty;
                        }
                    }

                    // 2. Hard Logit Suppression for banned hallucination tokens
                    for &t in &self.banned_tokens {
                        if t < 51865 {
                            last_logits[t] = -100.0;
                        }
                    }

                    if self.decoder_has_past_key_values {
                        for (i, out_name) in self.present_value_names.iter().enumerate() {
                            if let Some(pkv_val) = decoder_outputs.get(out_name) {
                                let (shape, data) = pkv_val.try_extract_tensor::<f32>()?;
                                let dims: Vec<usize> = shape.iter().map(|&d| d as usize).collect();
                                let arr = ndarray::ArrayView::from_shape(ndarray::IxDyn(&dims), data)?.to_owned();
                                if i < self.past_key_value_names.len() {
                                    let target_name = self.past_key_value_names[i].clone();
                                    cache_map.insert(target_name, arr);
                                }
                            }
                        }
                    }

                    let next_token = last_logits.iter().enumerate()
                        .max_by(|(_, a), (_, b)| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal))
                        .map(|(i, _)| i as i64)
                        .unwrap_or(50257); // Fallback to EOT if failed
                    
                    if next_token == 50257 || next_token == 50362 { break; } 

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
