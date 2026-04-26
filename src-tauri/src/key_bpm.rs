//! Lightweight key / BPM estimation for local audio files (heuristic, not studio-grade).

use rodio::source::Source;
use rodio::Decoder;
use cpal::Sample;
use rustfft::{num_complex::Complex, FftPlanner};
use serde::Serialize;
use std::fs::File;
use std::io::BufReader;
use std::path::{Path, PathBuf};
use tauri::command;

const ANALYSIS_SR: u32 = 22_050;
const MAX_SECONDS: f32 = 90.0;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyBpmAnalysis {
    pub key: String,
    pub bpm: f32,
}

fn resolve_analysis_path(path: &str) -> Result<PathBuf, String> {
    // Prefer MR instrumental file when separation exists.
    if let Some(paths) = crate::state::APP_PATHS.lock().as_ref() {
        let norm = path.replace("\\", "/");
        let encoded = urlencoding::encode(&norm).to_string();
        let inst_path = paths.separated.join(encoded).join("inst.wav");
        if inst_path.is_file() {
            return Ok(inst_path);
        }
    }

    // Fallback to the original local file.
    if path.starts_with("http://") || path.starts_with("https://") {
        return Err("원본이 온라인 곡이며 MR 파일이 없어 분석할 수 없습니다.".into());
    }
    let local = PathBuf::from(path);
    if !local.is_file() {
        return Err("오디오 파일을 찾을 수 없습니다.".into());
    }
    Ok(local)
}

fn convert_to_f32_vec<S>(source: S) -> Vec<f32>
where
    S: Source,
    S::Item: Sample,
{
    source.map(|s: S::Item| s.to_sample::<f32>()).collect()
}

fn decode_mono(path: &Path, max_samples: usize) -> Result<(Vec<f32>, u32), String> {
    let file = File::open(path).map_err(|e| format!("파일을 열 수 없습니다: {}", e))?;
    let decoder = Decoder::new(BufReader::new(file)).map_err(|e| format!("오디오 디코딩 실패: {}", e))?;
    let sample_rate = decoder.sample_rate().get();
    let channels = decoder.channels().get() as usize;
    let all = convert_to_f32_vec(decoder);
    let mono: Vec<f32> = if channels > 1 {
        all.chunks_exact(channels)
            .map(|c| c.iter().sum::<f32>() / channels as f32)
            .collect()
    } else {
        all
    };
    let take = mono.len().min(max_samples);
    Ok((mono[..take].to_vec(), sample_rate))
}

fn linear_resample(input: &[f32], from_sr: u32, to_sr: u32) -> Vec<f32> {
    if from_sr == to_sr || input.is_empty() {
        return input.to_vec();
    }
    let ratio = from_sr as f64 / to_sr as f64;
    let out_len = ((input.len() as f64 / ratio).floor() as usize).max(1);
    let mut out = Vec::with_capacity(out_len);
    for i in 0..out_len {
        let pos = i as f64 * ratio;
        let idx = pos.floor() as usize;
        let frac = (pos - idx as f64) as f32;
        let a = *input.get(idx).unwrap_or(&0.0);
        let b = *input.get(idx.saturating_add(1)).unwrap_or(&a);
        out.push(a * (1.0 - frac) + b * frac);
    }
    out
}

/// Krumhansl–Schmuckler major / minor profiles (C as tonic), correlation with chroma.
fn estimate_key(chroma: &[f32; 12]) -> String {
    const MAJOR: [f32; 12] = [
        6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88,
    ];
    const MINOR: [f32; 12] = [
        6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17,
    ];
    let names = [
        "C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B",
    ];
    let mut c = *chroma;
    let sum: f32 = c.iter().sum();
    if sum > 0.0 {
        for x in c.iter_mut() {
            *x /= sum;
        }
    }
    let norm = |v: &[f32; 12]| -> f32 {
        v.iter().map(|x| x * x).sum::<f32>().sqrt().max(1e-6)
    };
    let maj_n = norm(&MAJOR);
    let min_n = norm(&MINOR);

    let mut best = (-1.0f32, 0usize, false);
    for is_minor in [false, true] {
        let profile = if is_minor { MINOR } else { MAJOR };
        let pn = if is_minor { min_n } else { maj_n };
        for shift in 0..12 {
            let mut score = 0.0f32;
            for i in 0..12 {
                score += c[i] * profile[(i + 12 - shift) % 12];
            }
            score /= pn;
            if score > best.0 {
                best = (score, shift, is_minor);
            }
        }
    }
    let root = names[best.1];
    if best.2 {
        format!("{}m", root)
    } else {
        root.to_string()
    }
}

fn build_chroma(samples: &[f32], sr: u32) -> [f32; 12] {
    let n_fft: usize = 4096;
    let hop: usize = 2048;
    if samples.len() < n_fft + hop {
        return [0.0; 12];
    }
    let mut planner = FftPlanner::new();
    let fft = planner.plan_fft_forward(n_fft);
    let mut chroma = [0.0f32; 12];
    let mut window = vec![0.0f32; n_fft];
    let mut buf = vec![Complex::new(0.0f32, 0.0f32); n_fft];

    for start in (0..samples.len().saturating_sub(n_fft)).step_by(hop) {
        for i in 0..n_fft {
            let w = 0.5 * (1.0 - (2.0 * std::f32::consts::PI * i as f32 / (n_fft - 1).max(1) as f32).cos());
            window[i] = samples[start + i] * w;
        }
        for i in 0..n_fft {
            buf[i] = Complex::new(window[i], 0.0);
        }
        fft.process(&mut buf);
        for k in 1..(n_fft / 2) {
            let re = buf[k].re;
            let im = buf[k].im;
            let mag = (re * re + im * im).sqrt();
            let freq = k as f32 * sr as f32 / n_fft as f32;
            if freq < 80.0 || freq > 5_000.0 {
                continue;
            }
            let midi = 12.0 * (freq / 440.0).log2() + 69.0;
            if !midi.is_finite() {
                continue;
            }
            let pc = ((midi.round() as i32 % 12) + 12) % 12;
            chroma[pc as usize] += mag;
        }
    }
    chroma
}

fn estimate_bpm(samples: &[f32], sr: u32) -> f32 {
    let hop = ((sr as f32) * 0.01).max(1.0) as usize;
    let mut env = Vec::new();
    let mut i = 0usize;
    while i + hop <= samples.len() {
        let e: f32 = samples[i..i + hop].iter().map(|x| x * x).sum::<f32>() / hop as f32;
        env.push(e.sqrt());
        i += hop;
    }
    if env.len() < 32 {
        return 120.0;
    }
    let mut onsets = vec![0.0f32; env.len()];
    for j in 1..env.len() {
        onsets[j] = (env[j] - env[j - 1]).max(0.0);
    }
    let frame_dur = hop as f32 / sr as f32;
    let mut best_bpm = 120.0f32;
    let mut best_score = -1.0f32;
    for bpm in 60i32..=200 {
        let b = bpm as f32;
        let lag = ((60.0 / b) / frame_dur).round().max(2.0) as usize;
        if lag >= onsets.len() / 2 {
            continue;
        }
        let mut s = 0.0f32;
        let mut n = 0usize;
        for k in lag..onsets.len() {
            s += onsets[k] * onsets[k - lag];
            n += 1;
        }
        if n == 0 {
            continue;
        }
        s /= n as f32;
        if s > best_score {
            best_score = s;
            best_bpm = b;
        }
    }
    let score_at = |bpm: f32| -> f32 {
        let lag = ((60.0 / bpm) / frame_dur).round().max(2.0) as usize;
        if lag >= onsets.len() / 2 {
            return -1.0;
        }
        let mut s = 0.0f32;
        let mut n = 0usize;
        for k in lag..onsets.len() {
            s += onsets[k] * onsets[k - lag];
            n += 1;
        }
        if n == 0 {
            return -1.0;
        }
        s / n as f32
    };
    let b_half = (best_bpm * 0.5).clamp(60.0, 200.0);
    let b_dbl = (best_bpm * 2.0).clamp(60.0, 200.0);
    let s_half = score_at(b_half);
    let s_dbl = score_at(b_dbl);
    let mut fb = best_bpm;
    let mut fs = best_score;
    if s_half > 0.0 && s_half > fs * 0.95 {
        fb = b_half;
        fs = s_half;
    }
    if s_dbl > 0.0 && s_dbl > fs * 0.95 {
        fb = b_dbl;
    }
    fb
}

pub fn analyze_key_bpm_for_path(path: &str) -> Result<KeyBpmAnalysis, String> {
    let analysis_path = resolve_analysis_path(path)?;
    let p = Path::new(&analysis_path);
    let max_samples = (MAX_SECONDS * 48_000.0 * 2.0) as usize;
    let (mono, sr_in) = decode_mono(p, max_samples)?;
    let mono = linear_resample(&mono, sr_in, ANALYSIS_SR);
    if mono.len() < 8_192 {
        return Err("분석할 오디오가 너무 짧습니다.".into());
    }
    let chroma = build_chroma(&mono, ANALYSIS_SR);
    let key = estimate_key(&chroma);
    let bpm = estimate_bpm(&mono, ANALYSIS_SR);
    Ok(KeyBpmAnalysis { key, bpm })
}

#[command]
pub async fn analyze_key_bpm(path: String) -> Result<KeyBpmAnalysis, String> {
    tokio::task::spawn_blocking(move || analyze_key_bpm_for_path(&path))
        .await
        .map_err(|e| format!("분석 작업 실패: {}", e))?
}
