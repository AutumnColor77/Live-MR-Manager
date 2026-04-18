use serde::{Serialize, Deserialize};
use std::fs;
use std::path::{Path, PathBuf};
use crate::audio_player::sys_log;
use tauri::{command, AppHandle, Emitter};
use ndarray::Array2;
use unicode_normalization::UnicodeNormalization;
use std::collections::HashMap;
use std::io::{BufRead, BufReader};

use std::sync::atomic::{AtomicBool, Ordering};
use crate::audio::AudioProcessor;
use crate::onnx_engine::OnnxEngine;
use regex::Regex;
use parking_lot::Mutex;

pub struct CachedAlignmentState {
    pub emission_probs: Array2<f32>,
    pub tokens_path: PathBuf,
    pub lyrics: String,
}

pub static CACHED_STATE: Mutex<Option<CachedAlignmentState>> = Mutex::new(None);

pub static CANCEL_ALIGNMENT: AtomicBool = AtomicBool::new(false);

fn clean_lyrics(text: &str) -> String {
    // 괄호 안의 메타데이터 제거 (e.g. [Chorus], (Intro))
    let re_brackets = Regex::new(r"\[.*?\]|\(.*?\)|<.*?>").unwrap();
    let cleaned = re_brackets.replace_all(text, "");
    
    // 단순 특수문자 제거 (정렬에 방해되는 기호들)
    let re_symbols = Regex::new(r"[\?!\.,\-\+_~]").unwrap();
    let cleaned = re_symbols.replace_all(&cleaned, " ");
    
    cleaned.to_string()
}

#[derive(Debug, Serialize, Deserialize)]
pub struct SeparatedTrack {
    pub name: String,
    pub original_path: String,
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
    pub extracted_text: String,
    pub start_ms: i64,
    pub end_ms: i64,
    pub words: Vec<WordAlignment>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TimestampedWord {
    pub text: String,
    pub start_sec: f32,
    pub end_sec: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TranscribedSegment {
    pub text: String,
    pub start_sec: f32,
    pub end_sec: f32,
    pub words: Vec<TimestampedWord>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct AlignmentResult {
    pub words: Vec<WordAlignment>,
    pub lines: Vec<LineAlignment>,
    pub raw_segments: Vec<TranscribedSegment>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct WaveformSummary {
    pub points: Vec<(f32, f32)>,
    pub duration_sec: f32,
}

#[command]
pub async fn get_separated_audio_list(handle: AppHandle) -> Result<Vec<SeparatedTrack>, String> {
    let paths = crate::state::AppPaths::from_handle(&handle);
    let mut tracks = Vec::new();

    if let Ok(entries) = fs::read_dir(&paths.separated) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                let folder_name = entry.file_name().to_string_lossy().to_string();
                let has_vocal = path.join("vocal.wav").exists();
                let has_inst = path.join("inst.wav").exists();

                let name = urlencoding::decode(&folder_name).map(|d| d.into_owned()).unwrap_or(folder_name.clone());
                let display_name = Path::new(&name).file_name().map(|f| f.to_string_lossy().to_string()).unwrap_or_else(|| name.clone());

                tracks.push(SeparatedTrack {
                    name: display_name,
                    original_path: name,
                    folder_path: path.to_string_lossy().to_string(),
                    has_vocal,
                    has_inst,
                });
            }
        }
    }
    Ok(tracks)
}

#[command]
pub async fn get_model_list(handle: AppHandle) -> Result<Vec<String>, String> {
    let paths = crate::state::AppPaths::from_handle(&handle);
    let mut models = Vec::new();

    let search_dirs = vec![
        paths.models.clone(),
        std::env::current_exe().map(|p| p.parent().unwrap().join("models")).unwrap_or_default(),
        PathBuf::from("models"),
    ];

    for dir in search_dirs {
        // Scan models directory for subfolders
        if let Ok(entries) = fs::read_dir(&dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() {
                    let folder_name = entry.file_name().to_string_lossy().to_string();
                    let onnx_path = path.join("model.onnx");
                    let enc_path = path.join("encoder.onnx");
                    let tokens_path = path.join("tokens.txt");

                    if (onnx_path.exists() || enc_path.exists()) && tokens_path.exists() {
                        let display_name = match folder_name.as_str() {
                            "wav2vec2-large" => "Engine A: Wav2Vec2-Large (High Precision)",
                            "whisper-base" => "Engine B: Whisper-Base (Multi-lingual/Efficient)",
                            _ => &folder_name,
                        };
                        models.push(format!("{}|{}", display_name, path.to_string_lossy()));
                    }
                }
            }
        }
    }
    
    if models.is_empty() {
        models.push("사용 가능한 모델 없음|none".to_string());
    }

    Ok(models)
}

#[command]
pub async fn read_audio_file(path: String) -> Result<Vec<u8>, String> {
    fs::read(path).map_err(|e| format!("Failed to read file: {}", e))
}

#[command]
pub async fn cancel_forced_alignment() {
    CANCEL_ALIGNMENT.store(true, Ordering::SeqCst);
    sys_log("[Alignment] Cancellation signal sent.");
}

#[command]
pub async fn run_forced_alignment(
    handle: AppHandle,
    audio_path: String,
    lyrics: String,
    _model_name: String,
    _language: String,
    trans_penalty: Option<f32>,
    blank_penalty: Option<f32>,
    rep_penalty: Option<f32>,
    _use_vad: Option<bool>
) -> Result<AlignmentResult, String> {
    CANCEL_ALIGNMENT.store(false, Ordering::SeqCst);
    sys_log(&format!("[Alignment] Starting new CTC alignment path: {}", audio_path));

    let _paths = crate::state::AppPaths::from_handle(&handle);
    let model_full_path = _model_name.split('|').last().unwrap_or(".");
    let target_dir = PathBuf::from(model_full_path);
    
    let mut model_path = target_dir.join("model.onnx");
    if !model_path.exists() {
        model_path = target_dir.join("encoder.onnx");
    }
    let tokens_path = target_dir.join("tokens.txt");

    if !model_path.exists() || !tokens_path.exists() {
        // Fallback for relative paths if the UI didn't pass absolute
        return Err(format!("모델 파일을 찾을 수 없습니다: {:?}", target_dir));
    }

    let is_whisper = model_path.to_string_lossy().contains("whisper-base");
    let processor = AudioProcessor::new();
    
    let emission_probs = if is_whisper {
        sys_log("[Alignment] Engine B (Whisper) Preprocessing: Extracting Mel-spectrogram...");
        let raw_samples = processor.load_and_preprocess(&audio_path)?;
        let mel_data = processor.get_mel_spectrogram(raw_samples.as_slice().unwrap());
        
        sys_log(&format!("[Alignment] Engine B: Creating ONNX session for {:?}", model_path));
        let mut engine = OnnxEngine::new(&model_path)?;
        let h_clone = handle.clone();
        
        sys_log("[Alignment] Engine B: Running Whisper Inference...");
        engine.run_inference(&mel_data, true, |p| {
            let _ = h_clone.emit("alignment-progress", p as i32);
        }).map_err(|e| {
            let err_msg = format!("❌ [Engine B Error] {}", e);
            sys_log(&err_msg);
            err_msg
        })?
    } else {
        sys_log("[Alignment] Engine A (Wav2Vec2) Preprocessing: Raw audio PCM...");
        let audio_data = processor.load_and_preprocess(&audio_path)?;
        
        sys_log(&format!("[Alignment] Engine A: Creating ONNX session for {:?}", model_path));
        let mut engine = OnnxEngine::new(&model_path)?;
        let h_clone = handle.clone();
        
        sys_log("[Alignment] Engine A: Running Wav2Vec2 Inference...");
        engine.run_inference(audio_data.as_slice().unwrap(), false, |p| {
            let _ = h_clone.emit("alignment-progress", p as i32);
        }).map_err(|e| {
            let err_msg = format!("❌ [Engine A Error] {}", e);
            sys_log(&err_msg);
            err_msg
        })?
    };

    if CANCEL_ALIGNMENT.load(Ordering::SeqCst) {
        return Err("작업이 사용자에 의해 취소되었습니다.".to_string());
    }

    // Cache the inference results
    {
        let mut cache = CACHED_STATE.lock();
        *cache = Some(CachedAlignmentState {
            emission_probs: emission_probs.clone(),
            tokens_path: tokens_path.clone(),
            lyrics: lyrics.clone(),
        });
    }

    Ok(perform_alignment_internal(emission_probs, &tokens_path, &lyrics, trans_penalty.unwrap_or(-0.05), blank_penalty.unwrap_or(0.0), rep_penalty.unwrap_or(0.0))?)
}

#[command]
pub async fn apply_alignment_tuning(penalty: f32, blank_penalty: Option<f32>, rep_penalty: Option<f32>) -> Result<AlignmentResult, String> {
    CANCEL_ALIGNMENT.store(false, Ordering::SeqCst);
    sys_log(&format!("[Alignment] Real-time tuning requested with penalty: {:.3}", penalty));

    let cache = CACHED_STATE.lock();
    if let Some(state) = &*cache {
        let result = perform_alignment_internal(
            state.emission_probs.clone(),
            &state.tokens_path,
            &state.lyrics,
            penalty,
            blank_penalty.unwrap_or(0.0),
            rep_penalty.unwrap_or(0.0)
        )?;
        sys_log("[Alignment] Real-time tuning completed successfully.");
        Ok(result)
    } else {
        Err("캐시된 정렬 데이터가 없습니다. 먼저 정렬을 한번 수행하세요.".to_string())
    }
}

fn perform_alignment_internal(
    emission_probs: Array2<f32>,
    tokens_path: &Path,
    lyrics: &str,
    trans_p: f32,
    blank_p: f32,
    rep_p: f32
) -> Result<AlignmentResult, String> {
    let aligner = Aligner::new(tokens_path.to_str().unwrap())?;
    let cleaned_lyrics = clean_lyrics(lyrics);
    let lyric_lines: Vec<String> = cleaned_lyrics.lines().map(|s| s.trim().to_owned()).filter(|s| !s.is_empty()).collect();

    let (target_tokens, word_spans) = aligner.tokenize(&cleaned_lyrics);
    if target_tokens.is_empty() { return Err("유효한 가사 토큰이 없습니다.".to_string()); }

    let path = aligner.forced_align(&emission_probs, &target_tokens, trans_p, blank_p, rep_p);
    let frame_duration_ms = 20.0;
    let timestamps = aligner.get_word_timestamps(&path, &word_spans, frame_duration_ms);

    let greedy_path = aligner.greedy_decode(&emission_probs);

    let mut all_line_alignments = Vec::new();
    let mut word_idx = 0;
    for line_text in lyric_lines {
        let words_in_line: Vec<&str> = line_text.split_whitespace().collect();
        let mut line_words = Vec::new();
        let mut line_start_ms = 0;
        let mut line_end_ms = 0;

        for _ in 0..words_in_line.len() {
            if word_idx < timestamps.len() {
                let ts = &timestamps[word_idx];
                if line_words.is_empty() { line_start_ms = ts.start_ms as i64; }
                line_end_ms = ts.end_ms as i64;
                line_words.push(WordAlignment {
                    word: ts.word.clone(),
                    start_ms: ts.start_ms as i64,
                    end_ms: ts.end_ms as i64,
                });
                word_idx += 1;
            }
        }

        if !line_words.is_empty() {
            let start_frame = (line_start_ms as f32 / frame_duration_ms) as usize;
            let end_frame = (line_end_ms as f32 / frame_duration_ms) as usize;
            let extracted_text = aligner.get_text_from_path(&greedy_path, start_frame, end_frame);

            all_line_alignments.push(LineAlignment {
                text: line_text,
                extracted_text,
                start_ms: line_start_ms,
                end_ms: line_end_ms,
                words: line_words,
            });
        }
    }

    Ok(AlignmentResult {
        words: Vec::new(),
        lines: all_line_alignments,
        raw_segments: Vec::new(),
    })
}

#[command]
pub async fn get_waveform_summary(audio_path: String) -> Result<WaveformSummary, String> {
    let processor = AudioProcessor::new();
    let n_buckets = 2000;
    
    let (points, duration_sec) = processor.create_waveform_summary(&audio_path, n_buckets)?;
    
    Ok(WaveformSummary { 
        points, 
        duration_sec
    })
}

pub struct WordTimestamp {
    pub word: String,
    pub start_ms: u32,
    pub end_ms: u32,
}

pub struct Aligner {
    token_to_id: HashMap<String, usize>,
    blank_id: usize,
    space_id: Option<usize>,
    unk_id: usize,
    is_syllable_based: bool,
}

impl Aligner {
    pub fn new(tokens_path: &str) -> Result<Self, String> {
        let file = fs::File::open(tokens_path).map_err(|e| format!("토큰 파일 오픈 실패: {}", e))?;
        let reader = BufReader::new(file);
        let mut token_to_id = HashMap::new();
        let mut has_syllables = false;
        
        for line in reader.lines() {
            let line = line.map_err(|e| e.to_string())?;
            let line = line.trim_end();
            if line.is_empty() { continue; }
            if let Some(idx) = line.rfind(' ') {
                let token = &line[..idx];
                let id_str = &line[idx + 1..];
                if let Ok(id) = id_str.parse::<usize>() {
                    token_to_id.insert(token.to_string(), id);
                    
                    // 완성형 글자(AC00-D7AF)가 포함되어 있는지 확인
                    if !has_syllables {
                        if let Some(c) = token.chars().next() {
                            let cp = c as u32;
                            if cp >= 0xAC00 && cp <= 0xD7AF {
                                has_syllables = true;
                            }
                        }
                    }
                }
            }
        }
        let blank_id = token_to_id.get("[PAD]").copied()
            .or_else(|| token_to_id.get("<pad>").copied())
            .or_else(|| token_to_id.get("<blank>").copied())
            .unwrap_or(0);
        let space_id = token_to_id.get(" ").copied()
            .or_else(|| token_to_id.get("|").copied());
        let unk_id = token_to_id.get("[UNK]").copied()
            .or_else(|| token_to_id.get("<unk>").copied())
            .unwrap_or(blank_id);
            
        Ok(Self { 
            token_to_id, 
            blank_id, 
            space_id, 
            unk_id, 
            is_syllable_based: has_syllables 
        })
    }

    pub fn tokenize(&self, text: &str) -> (Vec<usize>, Vec<(usize, usize, String)>) {
        let mut ids = Vec::new();
        let mut word_spans = Vec::new();
        let words: Vec<&str> = text.split_whitespace().collect();
        
        for (wi, word) in words.iter().enumerate() {
            let start_idx = ids.len();
            let cleaned_word = word.trim_matches(|c: char| !c.is_alphanumeric());
            
            if self.is_syllable_based {
                // 음절 기반: 이미 완성형 한글이 Vocab에 있는 경우
                for c in cleaned_word.chars() {
                    let s = c.to_string();
                    ids.push(*self.token_to_id.get(&s).unwrap_or(&self.unk_id));
                }
            } else {
                // 자모 기반: 이전과 동일하게 분해
                let decomposed = cleaned_word.nfd().collect::<String>();
                for c in decomposed.chars() {
                    let s = self.to_compatibility_jamo(c);
                    ids.push(*self.token_to_id.get(&s).unwrap_or(&self.unk_id));
                }
            }
            
            if ids.len() == start_idx { ids.push(self.unk_id); }
            word_spans.push((start_idx, ids.len(), word.to_string()));
            if wi < words.len() - 1 { if let Some(sid) = self.space_id { ids.push(sid); } }
        }
        (ids, word_spans)
    }

    fn to_compatibility_jamo(&self, c: char) -> String {
        let cp = c as u32;
        if cp >= 0x1100 && cp <= 0x1112 {
            let mapping = ['ㄱ', 'ㄲ', 'ㄴ', 'ㄷ', 'ㄸ', 'ㄹ', 'ㅁ', 'ㅂ', 'ㅃ', 'ㅅ', 'ㅆ', 'ㅇ', 'ㅈ', 'ㅉ', 'ㅊ', 'ㅋ', 'ㅌ', 'ㅍ', 'ㅎ'];
            return mapping[(cp - 0x1100) as usize].to_string();
        }
        if cp >= 0x1161 && cp <= 0x1175 {
            let mapping = ['ㅏ', 'ㅐ', 'ㅑ', 'ㅒ', 'ㅓ', 'ㅔ', 'ㅕ', 'ㅖ', 'ㅗ', 'ㅘ', 'ㅙ', 'ㅚ', 'ㅛ', 'ㅜ', 'ㅝ', 'ㅞ', 'ㅟ', 'ㅠ', 'ㅡ', 'ㅢ', 'ㅣ'];
            return mapping[(cp - 0x1161) as usize].to_string();
        }
        if cp >= 0x11A8 && cp <= 0x11C2 {
            let mapping = ['ㄱ', 'ㄲ', 'ㄳ', 'ㄴ', 'ㄵ', 'ㄶ', 'ㄷ', 'ㄹ', 'ㄺ', 'ㄻ', 'ㄼ', 'ㄽ', 'ㄾ', 'ㄿ', 'ㅀ', 'ㅁ', 'ㅂ', 'ㅄ', 'ㅅ', 'ㅆ', 'ㅇ', 'ㅈ', 'ㅊ', 'ㅋ', 'ㅌ', 'ㅍ', 'ㅎ'];
            return mapping[(cp - 0x11A8) as usize].to_string();
        }
        c.to_string()
    }

    pub fn forced_align(&self, emission_probs: &Array2<f32>, target_tokens: &[usize], trans_penalty: f32, blank_penalty: f32, rep_penalty: f32) -> Vec<usize> {
        let mut extended = Vec::with_capacity(target_tokens.len() * 2 + 1);
        for &t in target_tokens { extended.push(self.blank_id); extended.push(t); }
        extended.push(self.blank_id);
        let n_frames = emission_probs.nrows();
        let n_states = extended.len();
        if n_frames == 0 || n_states == 0 { return vec![]; }
        let mut dp = vec![vec![f32::NEG_INFINITY; n_states]; n_frames];
        let mut bp = vec![vec![0usize; n_states]; n_frames];
        dp[0][0] = emission_probs[[0, extended[0]]];
        if n_states > 1 { dp[0][1] = emission_probs[[0, extended[1]]]; }
        for t in 1..n_frames {
            if t % 50 == 0 && CANCEL_ALIGNMENT.load(Ordering::SeqCst) { break; } // Early exit for inner loops
            for s in 0..n_states {
                let mut emit = emission_probs[[t, extended[s]]];
                if extended[s] == self.blank_id {
                    emit += blank_penalty;
                }
                
                let mut best = dp[t - 1][s];
                if extended[s] != self.blank_id {
                    best += rep_penalty;
                }
                
                let mut best_from = s;
                if s > 0 {
                    let val = dp[t - 1][s - 1] + trans_penalty;
                    if val > best { best = val; best_from = s - 1; }
                }
                if s > 1 && extended[s] != extended[s - 2] {
                    let val = dp[t - 1][s - 2] + trans_penalty;
                    if val > best { best = val; best_from = s - 2; }
                }
                dp[t][s] = best + emit; bp[t][s] = best_from;
            }
        }
        let mut state = n_states - 1;
        if n_states >= 2 && dp[n_frames - 1][n_states - 2] > dp[n_frames - 1][n_states - 1] { state = n_states - 2; }
        let mut path = vec![0usize; n_frames];
        path[n_frames - 1] = state;
        for t in (0..n_frames - 1).rev() { state = bp[t + 1][state]; path[t] = state; }
        path.iter().map(|&s| if s % 2 == 0 { usize::MAX } else { s / 2 }).collect()
    }

    pub fn get_word_timestamps(&self, path: &[usize], word_spans: &[(usize, usize, String)], frame_duration_ms: f32) -> Vec<WordTimestamp> {
        let mut result = Vec::new();
        for (token_start, token_end, word) in word_spans {
            let mut first_frame = None; let mut last_frame = None;
            for (frame_idx, &token_idx) in path.iter().enumerate() {
                if token_idx != usize::MAX && token_idx >= *token_start && token_idx < *token_end {
                    if first_frame.is_none() { first_frame = Some(frame_idx); }
                    last_frame = Some(frame_idx);
                }
            }
            if let (Some(start), Some(end)) = (first_frame, last_frame) {
                result.push(WordTimestamp { word: word.clone(), start_ms: (start as f32 * frame_duration_ms) as u32, end_ms: ((end + 1) as f32 * frame_duration_ms) as u32 });
            }
        }
        result
    }

    pub fn greedy_decode(&self, emission_probs: &Array2<f32>) -> Vec<usize> {
        let n_frames = emission_probs.nrows();
        let mut path = Vec::with_capacity(n_frames);
        for t in 0..n_frames {
            let mut best_idx = 0; let mut best_prob = f32::NEG_INFINITY;
            for (idx, &prob) in emission_probs.row(t).iter().enumerate() { if prob > best_prob { best_prob = prob; best_idx = idx; } }
            path.push(best_idx);
        }
        path
    }

    pub fn get_text_from_path(&self, path: &[usize], start: usize, end: usize) -> String {
        let end = end.min(path.len()); if start >= end { return String::new(); }
        let mut tokens = Vec::new(); let mut prev = None;
        for &t in &path[start..end] { if t != self.blank_id && Some(t) != prev { tokens.push(t); } prev = Some(t); }
        let mut id_to_token = HashMap::new();
        for (token, &id) in &self.token_to_id { id_to_token.insert(id, token.as_str()); }
        
        let mut parts = Vec::new();
        for id in tokens { 
            if let Some(&token) = id_to_token.get(&id) { 
                parts.push(token); 
            } 
        }
        
        if self.is_syllable_based {
            parts.join("").replace("|", " ").trim().to_string()
        } else {
            self.assemble_hangul(&parts)
        }
    }

    fn assemble_hangul(&self, jamos: &[&str]) -> String {
        let mut combined = String::new();
        let mut cur_syllable = String::new();
        
        // Simple state machine to track syllable structure: empty -> choseong -> jungseong -> jongseong
        #[derive(PartialEq)]
        enum SyllableState { Empty, Choseong, Jungseong, Jongseong }
        let mut state = SyllableState::Empty;

        for &j in jamos {
            if j == " " || j == "|" {
                if !cur_syllable.is_empty() {
                    combined.push_str(&cur_syllable.nfc().collect::<String>());
                    cur_syllable.clear();
                }
                combined.push(' ');
                state = SyllableState::Empty;
                continue;
            }

            let is_vowel = "ㅏㅐㅑㅒㅓㅔㅕㅖㅗㅘㅙㅚㅛㅜㅜㅝㅞㅟㅠㅡㅢㅣ".contains(j);
            
            match state {
                SyllableState::Empty => {
                    if is_vowel {
                        // Vowel starting a syllable (unusual but possible)
                        cur_syllable.push(self.to_combining_jamo_internal(j, false));
                        state = SyllableState::Jungseong;
                    } else {
                        cur_syllable.push(self.to_combining_jamo_internal(j, true));
                        state = SyllableState::Choseong;
                    }
                }
                SyllableState::Choseong => {
                    if is_vowel {
                        cur_syllable.push(self.to_combining_jamo_internal(j, false));
                        state = SyllableState::Jungseong;
                    } else {
                        // Double consonant? Flush previous and start new choseong
                        combined.push_str(&cur_syllable.nfc().collect::<String>());
                        cur_syllable = self.to_combining_jamo_internal(j, true).to_string();
                        state = SyllableState::Choseong;
                    }
                }
                SyllableState::Jungseong => {
                    if is_vowel {
                        // Composite vowel?
                        cur_syllable.push(self.to_combining_jamo_internal(j, false));
                    } else {
                        let c = self.to_combining_jamo_internal(j, false);
                        if c == ' ' { // Failed to find jongseong version
                            combined.push_str(&cur_syllable.nfc().collect::<String>());
                            cur_syllable = self.to_combining_jamo_internal(j, true).to_string();
                            state = SyllableState::Choseong;
                        } else {
                            cur_syllable.push(c);
                            state = SyllableState::Jongseong;
                        }
                    }
                }
                SyllableState::Jongseong => {
                    if is_vowel {
                        // Vowel after Jongseong! (e.g., 각 + ㅏ -> 가 + 가)
                        // Need to pull last jongseong and move it to choseong of next syllable
                        // For simplicity here, we flush and start new vowel syllable
                        combined.push_str(&cur_syllable.nfc().collect::<String>());
                        cur_syllable = self.to_combining_jamo_internal(j, false).to_string();
                        state = SyllableState::Jungseong;
                    } else {
                        // New consonant: flush and start next
                        combined.push_str(&cur_syllable.nfc().collect::<String>());
                        cur_syllable = self.to_combining_jamo_internal(j, true).to_string();
                        state = SyllableState::Choseong;
                    }
                }
            }
        }
        
        if !cur_syllable.is_empty() {
            combined.push_str(&cur_syllable.nfc().collect::<String>());
        }
        combined
    }

    fn to_combining_jamo_internal(&self, j: &str, is_initial: bool) -> char {
        match j {
            "ㄱ" => if is_initial { '\u{1100}' } else { '\u{11A8}' },
            "ㄲ" => if is_initial { '\u{1101}' } else { '\u{11A9}' },
            "ㄳ" => '\u{11AA}',
            "ㄴ" => if is_initial { '\u{1102}' } else { '\u{11AB}' },
            "ㄵ" => '\u{11AC}',
            "ㄶ" => '\u{11AD}',
            "ㄷ" => if is_initial { '\u{1103}' } else { '\u{11AE}' },
            "ㄸ" => if is_initial { '\u{1104}' } else { ' ' },
            "ㄹ" => if is_initial { '\u{1105}' } else { '\u{11AF}' },
            "ㄺ" => '\u{11B0}', "ㄻ" => '\u{11B1}', "ㄼ" => '\u{11B2}', "ㄽ" => '\u{11B3}', "ㄾ" => '\u{11B4}', "ㄿ" => '\u{11B5}', "ㅀ" => '\u{11B6}',
            "ㅁ" => if is_initial { '\u{1106}' } else { '\u{11B7}' },
            "ㅂ" => if is_initial { '\u{1107}' } else { '\u{11B8}' },
            "ㅃ" => if is_initial { '\u{1108}' } else { ' ' },
            "ㅄ" => '\u{11B9}',
            "ㅅ" => if is_initial { '\u{1109}' } else { '\u{11BA}' },
            "ㅆ" => if is_initial { '\u{110A}' } else { '\u{11BB}' },
            "ㅇ" => if is_initial { '\u{110B}' } else { '\u{11BC}' },
            "ㅈ" => if is_initial { '\u{110C}' } else { '\u{11BD}' },
            "ㅉ" => if is_initial { '\u{110D}' } else { ' ' },
            "ㅊ" => if is_initial { '\u{110E}' } else { '\u{11BE}' },
            "ㅋ" => if is_initial { '\u{110F}' } else { '\u{11BF}' },
            "ㅌ" => if is_initial { '\u{1110}' } else { '\u{11C0}' },
            "ㅍ" => if is_initial { '\u{1111}' } else { '\u{11C1}' },
            "ㅎ" => if is_initial { '\u{1112}' } else { '\u{11C2}' },
            "ㅏ" => '\u{1161}', "ㅐ" => '\u{1162}', "ㅑ" => '\u{1163}', "ㅒ" => '\u{1164}', "ㅓ" => '\u{1165}', "ㅔ" => '\u{1166}', "ㅕ" => '\u{1167}', "ㅖ" => '\u{1168}',
            "ㅗ" => '\u{1169}', "ㅘ" => '\u{116A}', "ㅙ" => '\u{116B}', "ㅚ" => '\u{116C}', "ㅛ" => '\u{116D}', "ㅜ" => '\u{116E}', "ㅝ" => '\u{116F}', "ㅞ" => '\u{1170}', "ㅟ" => '\u{1171}', "ㅠ" => '\u{1172}',
            "ㅡ" => '\u{1173}', "ㅢ" => '\u{1174}', "ㅣ" => '\u{1175}',
            _ => j.chars().next().unwrap_or(' '),
        }
    }
}

#[command]
pub async fn save_lrc_file(audio_path: String, content: String) -> Result<(), String> {
    let audio_buf = PathBuf::from(&audio_path);
    let lrc_path = audio_buf.with_extension("lrc");
    
    fs::write(&lrc_path, content).map_err(|e| format!("LRC 저장 실패: {}", e))?;
    sys_log(&format!("[Alignment] LRC saved to {:?}", lrc_path));
    Ok(())
}
