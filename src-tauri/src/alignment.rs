use serde::{Serialize, Deserialize};
use std::fs;
use std::path::Path;
use crate::audio_player::sys_log;
use symphonia::core::io::MediaSourceStream;
use symphonia::core::probe::Hint;
use tauri::command;

#[derive(Debug, Serialize, Deserialize)]
pub struct SeparatedTrack {
    pub name: String,
    pub folder_path: String,
    pub has_vocal: bool,
    pub has_inst: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct WordAlignment {
    pub word: String,
    pub start_ms: i64,
    pub end_ms: i64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct LineAlignment {
    pub text: String,
    pub start_ms: i64,
    pub end_ms: i64,
    pub words: Vec<WordAlignment>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct AlignmentResult {
    pub words: Vec<WordAlignment>,
    pub lines: Vec<LineAlignment>,
    pub raw_segments: Vec<crate::whisper::TranscribedSegment>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct WaveformSummary {
    pub points: Vec<(f32, f32)>,
    pub duration_sec: f32,
}

#[command]
pub async fn get_separated_audio_list(handle: tauri::AppHandle) -> Result<Vec<SeparatedTrack>, String> {
    let paths = crate::state::AppPaths::from_handle(&handle);
    let mut cache_bases = Vec::new();

    // 1. AppData separated path (production and dev)
    cache_bases.push(paths.separated.clone());

    // 2. Dev relative path fallback
    let dev_cache_rel = Path::new("src-tauri/cache/separated");
    if dev_cache_rel.exists() {
        cache_bases.push(dev_cache_rel.to_path_buf());
    }

    let mut tracks = Vec::new();
    let mut seen_folders = std::collections::HashSet::new();

    for cache_base in &cache_bases {
        sys_log(&format!("[Alignment] Scanning separated dir: {:?}", cache_base));
        if let Ok(entries) = fs::read_dir(cache_base) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() {
                    let folder_name = entry.file_name().to_string_lossy().to_string();
                    if seen_folders.contains(&folder_name) { continue; }

                    let has_vocal = path.join("vocal.wav").exists();
                    let has_inst = path.join("inst.wav").exists();

                    let name = urlencoding::decode(&folder_name)
                        .map(|d| d.into_owned())
                        .unwrap_or_else(|_| folder_name.clone());

                    let display_name = Path::new(&name)
                        .file_name()
                        .map(|f| f.to_string_lossy().to_string())
                        .unwrap_or_else(|| name.clone());

                    sys_log(&format!("[Alignment] Found track: {} (vocal={}, inst={})", display_name, has_vocal, has_inst));

                    tracks.push(SeparatedTrack {
                        name: display_name,
                        folder_path: path.to_string_lossy().to_string(),
                        has_vocal,
                        has_inst,
                    });
                    seen_folders.insert(folder_name);
                }
            }
        } else {
            sys_log(&format!("[Alignment] Failed to read dir: {:?}", cache_base));
        }
    }

    sys_log(&format!("[Alignment] Total tracks found: {}", tracks.len()));
    Ok(tracks)
}

#[command]
pub async fn get_model_list() -> Result<Vec<String>, String> {
    let local_app_data = std::env::var("LOCALAPPDATA").unwrap_or_default();

    let dev_models_rel = Path::new("src-tauri/models");
    let dev_models_abs = Path::new("F:/Live-MR-Manager/src-tauri/models");
    let dev_models: &Path = if dev_models_rel.exists() {
        dev_models_rel
    } else if dev_models_abs.exists() {
        dev_models_abs
    } else {
        dev_models_rel
    };
    let app_models = Path::new(&local_app_data)
        .join("com.autumncolor77.live-mr-manager")
        .join("models");

    let model_variants: Vec<(&str, &str)> = vec![
        ("encoder_model_q4.onnx",   "Whisper Base Q4 (Lightweight)"),
        ("encoder_model_fp16.onnx", "Whisper Base FP16"),
        ("encoder_model.onnx",      "Whisper Base Standard"),
    ];

    let mut models = Vec::new();
    let mut seen_labels = std::collections::HashSet::new();

    for search_path in [dev_models, app_models.as_path()] {
        for (filename, label) in &model_variants {
            if search_path.join(filename).exists() && !seen_labels.contains(*label) {
                models.push(format!("{}|{}", label, filename));
                seen_labels.insert(label.to_string());
            }
        }
    }

    if models.is_empty() {
        let mut seen = std::collections::HashSet::new();
        for search_path in [dev_models, app_models.as_path()] {
            if let Ok(entries) = fs::read_dir(search_path) {
                for entry in entries.flatten() {
                    let name = entry.file_name().to_string_lossy().to_string();
                    if name.ends_with(".onnx") && name.contains("encoder") && !seen.contains(&name) {
                        models.push(format!("{}|{}", name, name));
                        seen.insert(name);
                    }
                }
            }
        }
    }

    sys_log(&format!("[Alignment] Found {} model variants. dev_path={:?}", models.len(), dev_models));
    Ok(models)
}

#[command]
pub async fn read_audio_file(path: String) -> Result<Vec<u8>, String> {
    let file_path = Path::new(&path);
    if !file_path.exists() {
        return Err(format!("File not found: {}", path));
    }
    fs::read(file_path).map_err(|e| format!("Failed to read file: {}", e))
}

#[command]
pub async fn run_forced_alignment(
    _handle: tauri::AppHandle,
    audio_path: String,
    lyrics: String,
    model_name: String,
    language: String,
    vads_threshold: f32,
    noise_reduction: f32
) -> Result<AlignmentResult, String> {
    sys_log(&format!("Running 2-Pass AI alignment for: {} (Model: {}, Lang: {}, VAD: {}, Noise: {})",
        audio_path, model_name, language, vads_threshold, noise_reduction));

    let local_app_data = std::env::var("LOCALAPPDATA").unwrap_or_default();

    let dev_models_rel = Path::new("src-tauri/models");
    let dev_models_abs = Path::new("F:/Live-MR-Manager/src-tauri/models");
    let dev_models: &Path = if dev_models_rel.exists() {
        dev_models_rel
    } else if dev_models_abs.exists() {
        dev_models_abs
    } else {
        dev_models_rel
    };
    let app_models = Path::new(&local_app_data)
        .join("com.autumncolor77.live-mr-manager")
        .join("models");

    let enc_name = if model_name.contains("encoder") {
        model_name.clone()
    } else {
        if model_name.contains("fp16")     { "encoder_model_fp16.onnx".to_string() }
        else if model_name.contains("std") { "encoder_model.onnx".to_string() }
        else                               { "encoder_model_q4.onnx".to_string() }
    };

    let dec_main_name = if enc_name.contains("q4") && dev_models.join("decoder_with_past_model_q4.onnx").exists() {
        "decoder_with_past_model_q4.onnx"
    } else if enc_name.contains("q4") {
        "decoder_model_q4.onnx"
    } else if enc_name.contains("fp16") {
        "decoder_model_fp16.onnx"
    } else {
        "decoder_model.onnx"
    };

    let dec_init_name = if dec_main_name.contains("with_past") {
        "decoder_model_q4.onnx"
    } else {
        dec_main_name
    };

    let enc_path = if dev_models.join(&enc_name).exists() { dev_models.join(&enc_name) } else { app_models.join(&enc_name) };
    let dec_main_path = if dev_models.join(dec_main_name).exists() { dev_models.join(dec_main_name) } else { app_models.join(dec_main_name) };
    let dec_init_path = if dev_models.join(dec_init_name).exists() { dev_models.join(dec_init_name) } else { app_models.join(dec_init_name) };
    let tok_path = if dev_models.join("tokenizer.json").exists() { dev_models.join("tokenizer.json") } else { app_models.join("tokenizer.json") };

    sys_log(&format!("[Alignment] Dual Model Paths: enc={:?}, init={:?}, main={:?}, tok={:?}", enc_path, dec_init_path, dec_main_path, tok_path));

    if !enc_path.exists() || !dec_init_path.exists() || !dec_main_path.exists() || !tok_path.exists() {
        return Err(format!("Model files not found. enc={:?}, init={:?}, main={:?}, tok={:?}", enc_path, dec_init_path, dec_main_path, tok_path));
    }

    let samples = load_audio_as_16khz(&audio_path).map_err(|e| format!("Audio load error: {}", e))?;

    let mut engine = crate::whisper::WhisperEngine::new(&enc_path, &dec_init_path, &dec_main_path, &tok_path)
        .map_err(|e| format!("AI Engine init failed: {}", e))?;

    let segments = engine.transcribe_with_timestamps(&samples, &language, vads_threshold, Some(&_handle))
        .map_err(|e| format!("Pass 1 Transcription failed: {}", e))?;

    sys_log(&format!("[Whisper] Transcription finished. Raw segments: {}", segments.len()));

    let lyric_lines: Vec<String> = lyrics
        .lines()
        .map(|s| s.trim().to_owned())
        .filter(|s| !s.is_empty())
        .collect();

    if lyric_lines.is_empty() {
        return Err("Lyrics are empty.".to_string());
    }

    let all_ai_words: Vec<crate::whisper::TimestampedWord> = segments.iter()
        .flat_map(|s| s.words.clone())
        .collect();

    let mut aligned_lines = Vec::new();
    let mut ai_ptr = 0;

    for line_text in lyric_lines {
        let mut best_score = -1.0;
        let mut best_range = (ai_ptr, ai_ptr);

        let search_depth = (ai_ptr + 50).min(all_ai_words.len());

        for start in ai_ptr..search_depth {
            for end in (start + 1)..=(start + 12).min(all_ai_words.len()) {
                let ai_chunk: String = all_ai_words[start..end].iter()
                    .map(|w| w.text.as_str())
                    .collect::<Vec<&str>>()
                    .join("");

                let score = calculate_char_similarity(&line_text, &ai_chunk);

                if score > 0.05 {
                    sys_log(&format!("[MatchCheck] Score: {:.2} | Target: '{}' | AI: '{}'", score, line_text, ai_chunk));
                }

                if score > best_score {
                    best_score = score;
                    best_range = (start, end);
                }
            }
        }

        sys_log(&format!("[MatchResult] Best: {:.2} for '{}' at AI-idx {}", best_score, line_text, best_range.0));

        if best_score > 0.12 {
            let (start_idx, end_idx) = best_range;
            let start_ms = (all_ai_words[start_idx].start_sec * 1000.0) as i64;
            let end_ms = (all_ai_words[end_idx - 1].end_sec * 1000.0) as i64;

            let mut line_align = LineAlignment {
                text: line_text.clone(),
                start_ms,
                end_ms,
                words: Vec::new(),
            };

            let sub_words: Vec<&str> = line_text.split_whitespace().collect();
            let duration = end_ms - start_ms;
            let word_dur = if !sub_words.is_empty() { duration / sub_words.len() as i64 } else { 0 };
            for (i, &sw) in sub_words.iter().enumerate() {
                line_align.words.push(WordAlignment {
                    word: sw.to_string(),
                    start_ms: start_ms + (i as i64 * word_dur),
                    end_ms: start_ms + ((i + 1) as i64 * word_dur),
                });
            }

            aligned_lines.push(line_align);
            ai_ptr = end_idx;
        } else {
            let fallback_start = if ai_ptr < all_ai_words.len() {
                (all_ai_words[ai_ptr].start_sec * 1000.0) as i64
            } else {
                aligned_lines.last().map(|l| l.end_ms + 500).unwrap_or(0)
            };

            aligned_lines.push(LineAlignment {
                text: line_text.clone(),
                start_ms: fallback_start,
                end_ms: fallback_start + 2000,
                words: Vec::new(),
            });

            if ai_ptr < all_ai_words.len() {
                ai_ptr += 1;
            }
        }
    }

    Ok(AlignmentResult {
        words: Vec::new(),
        lines: aligned_lines,
        raw_segments: segments,
    })
}

#[command]
pub async fn get_waveform_summary(audio_path: String) -> Result<WaveformSummary, String> {
    sys_log(&format!("[Audio] Generating waveform summary for: {}", audio_path));
    let samples = load_audio_as_16khz(&audio_path).map_err(|e| format!("Decode error: {}", e))?;

    if samples.is_empty() { return Err("Empty audio file".to_string()); }

    let n_buckets = 2000;
    let samples_per_bucket = samples.len() / n_buckets;
    let mut points = Vec::with_capacity(n_buckets);

    for i in 0..n_buckets {
        let start = i * samples_per_bucket;
        let end = if i == n_buckets - 1 { samples.len() } else { (i + 1) * samples_per_bucket };

        let chunk = &samples[start..end];
        let mut min = 1.0f32;
        let mut max = -1.0f32;

        for &s in chunk {
            if s < min { min = s; }
            if s > max { max = s; }
        }
        points.push((min, max));
    }

    Ok(WaveformSummary {
        points,
        duration_sec: samples.len() as f32 / 16000.0,
    })
}

fn load_audio_as_16khz(path: &str) -> anyhow::Result<Vec<f32>> {
    use symphonia::core::formats::FormatOptions;
    use symphonia::core::meta::MetadataOptions;
    use symphonia::core::codecs::DecoderOptions;
    use symphonia::core::audio::Signal;

    let file_path = Path::new(path);
    sys_log(&format!("[Audio] Loading file: {:?}. Size: {} bytes", file_path, fs::metadata(file_path).map(|m| m.len()).unwrap_or(0)));

    let file = fs::File::open(file_path)?;
    let mss = MediaSourceStream::new(Box::new(file), Default::default());
    let mut hint = Hint::new();
    if path.ends_with(".wav") { hint.with_extension("wav"); }
    else if path.ends_with(".mp3") { hint.with_extension("mp3"); }

    let probed = symphonia::default::get_probe().format(&hint, mss, &FormatOptions::default(), &MetadataOptions::default())?;
    let mut format = probed.format;
    let track = format.tracks().iter().find(|t| t.codec_params.codec != symphonia::core::codecs::CODEC_TYPE_NULL)
        .ok_or_else(|| anyhow::anyhow!("No supported audio track"))?;

    let mut decoder = symphonia::default::get_codecs().make(&track.codec_params, &DecoderOptions::default())?;
    let src_sample_rate = track.codec_params.sample_rate.unwrap_or(44100);
    sys_log(&format!("[Audio] Format probed. Sample Rate: {}", src_sample_rate));

    let mut pcm_data = Vec::new();
    let mut packet_count = 0;
    while let Ok(packet) = format.next_packet() {
        packet_count += 1;
        match decoder.decode(&packet) {
            Ok(decoded) => {
                match decoded {
                    symphonia::core::audio::AudioBufferRef::F32(buf) => {
                        for i in 0..buf.frames() {
                            let mut sum = 0.0;
                            for ch in 0..buf.spec().channels.count() { sum += buf.chan(ch)[i]; }
                            pcm_data.push(sum / buf.spec().channels.count() as f32);
                        }
                    }
                    symphonia::core::audio::AudioBufferRef::S16(buf) => {
                        for i in 0..buf.frames() {
                            let mut sum = 0.0;
                            for ch in 0..buf.spec().channels.count() { sum += buf.chan(ch)[i] as f32 / 32768.0; }
                            pcm_data.push(sum / buf.spec().channels.count() as f32);
                        }
                    }
                    symphonia::core::audio::AudioBufferRef::S24(buf) => {
                        for i in 0..buf.frames() {
                            let mut sum = 0.0;
                            for ch in 0..buf.spec().channels.count() { sum += (buf.chan(ch)[i].0) as f32 / 8388608.0; }
                            pcm_data.push(sum / buf.spec().channels.count() as f32);
                        }
                    }
                    symphonia::core::audio::AudioBufferRef::S32(buf) => {
                        for i in 0..buf.frames() {
                            let mut sum = 0.0;
                            for ch in 0..buf.spec().channels.count() { sum += buf.chan(ch)[i] as f32 / 2147483648.0; }
                            pcm_data.push(sum / buf.spec().channels.count() as f32);
                        }
                    }
                    _ => {
                        if packet_count == 1 { sys_log(&format!("[Audio] Unhandled buffer type at packet 1")); }
                    }
                }
            }
            Err(e) => {
                sys_log(&format!("[Audio] Decode error at packet {}: {}", packet_count, e));
                break;
            }
        }
    }
    sys_log(&format!("[Audio] Decoding finished. Total Packets: {}, Total Samples: {}", packet_count, pcm_data.len()));

    if src_sample_rate != 16000 {
        use rubato::{Resampler, SincFixedIn, SincInterpolationType, SincInterpolationParameters, WindowFunction};
        let params = SincInterpolationParameters {
            sinc_len: 256, f_cutoff: 0.95, interpolation: SincInterpolationType::Linear,
            window: WindowFunction::BlackmanHarris2, oversampling_factor: 256,
        };
        let mut resampler = SincFixedIn::<f32>::new(16000 as f64 / src_sample_rate as f64, 2.0, params, 1024, 1)?;

        let mut resampled_pcm = Vec::with_capacity((pcm_data.len() as f64 * 16000.0 / src_sample_rate as f64) as usize + 1024);
        let mut input_pos = 0;

        while input_pos < pcm_data.len() {
            let frames_needed = resampler.input_frames_next();
            let mut chunk = vec![vec![0.0f32; frames_needed]];

            let to_copy = std::cmp::min(frames_needed, pcm_data.len() - input_pos);
            chunk[0][..to_copy].copy_from_slice(&pcm_data[input_pos..input_pos + to_copy]);

            let out_chunk = resampler.process(&chunk, None).map_err(|e| anyhow::anyhow!("Resampling failed: {}", e))?;
            resampled_pcm.extend_from_slice(&out_chunk[0]);
            input_pos += to_copy;

            if to_copy < frames_needed { break; }
        }

        sys_log(&format!("[Audio] Resampling finished. New size: {}", resampled_pcm.len()));
        return Ok(resampled_pcm);
    }

    Ok(pcm_data)
}

fn calculate_char_similarity(a: &str, b: &str) -> f32 {
    let a_clean: String = a.chars().filter(|c| !c.is_whitespace()).collect();
    let b_clean: String = b.chars().filter(|c| !c.is_whitespace()).collect();

    if a_clean.is_empty() || b_clean.is_empty() { return 0.0; }

    let a_jamo: Vec<char> = a_clean.chars().flat_map(decompose_hangul).collect();
    let b_jamo: Vec<char> = b_clean.chars().flat_map(decompose_hangul).collect();

    let a_set: std::collections::HashSet<char> = a_jamo.into_iter().collect();
    let b_set: std::collections::HashSet<char> = b_jamo.into_iter().collect();

    let intersection = a_set.intersection(&b_set).count() as f32;
    let union = a_set.union(&b_set).count() as f32;

    intersection / union
}

fn decompose_hangul(c: char) -> Vec<char> {
    let code = c as u32;
    if (0xAC00..=0xD7A3).contains(&code) {
        let index = code - 0xAC00;
        let initial = index / (21 * 28);
        let vowel = (index % (21 * 28)) / 28;
        let final_consonant = index % 28;

        let initial_char = std::char::from_u32(0x1100 + initial).unwrap_or(c);
        let vowel_char = std::char::from_u32(0x1161 + vowel).unwrap_or(c);

        let mut res = vec![initial_char, vowel_char];
        if final_consonant > 0 {
            let final_char = std::char::from_u32(0x11A7 + final_consonant).unwrap_or(c);
            res.push(final_char);
        }
        res
    } else {
        vec![c.to_ascii_lowercase()]
    }
}