use hound;
use rubato::{FftFixedIn, Resampler};
use ndarray::Array1;
use std::path::Path;

pub struct AudioProcessor {
    pub target_sample_rate: u32,
}

impl AudioProcessor {
    pub fn new() -> Self {
        Self {
            target_sample_rate: 16000,
        }
    }

    /// WAV 파일을 로드하고 16kHz로 리샘플링 및 ZMUV 정규화된 f32 배열을 반환합니다.
    pub fn load_and_preprocess<P: AsRef<Path>>(&self, path: P) -> Result<Array1<f32>, String> {
        let mut reader = hound::WavReader::open(path)
            .map_err(|e| format!("WAV 파일을 열 수 없습니다: {}", e))?;

        let spec = reader.spec();
        let source_sample_rate = spec.sample_rate;
        let channels = spec.channels as usize;

        // 모든 채널의 샘플을 읽어서 f32로 변환
        let samples: Vec<f32> = match spec.sample_format {
            hound::SampleFormat::Float => {
                reader.samples::<f32>().map(|s| s.unwrap_or(0.0)).collect()
            }
            hound::SampleFormat::Int => {
                let max_val = (1 << (spec.bits_per_sample - 1)) as f32;
                reader
                    .samples::<i32>()
                    .map(|s| s.unwrap_or(0) as f32 / max_val)
                    .collect()
            }
        };

        // 다중 채널인 경우 모노로 믹싱
        let mono_samples = if channels > 1 {
            samples
                .chunks_exact(channels)
                .map(|chunk| chunk.iter().sum::<f32>() / channels as f32)
                .collect()
        } else {
            samples
        };

        // 16kHz로 리샘플링
        let mut final_samples = if source_sample_rate != self.target_sample_rate {
            self.resample(mono_samples, source_sample_rate, self.target_sample_rate)?
        } else {
            mono_samples
        };

        // 1. High-Pass Filter (80Hz) - Remove low-frequency rumble
        self.apply_high_pass(&mut final_samples, 80.0);

        // 2. Pre-emphasis Filter - Boost high frequencies for better consonant recognition
        self.apply_pre_emphasis(&mut final_samples, 0.90);

        // 3. 글로벌 ZMUV (Zero Mean Unit Variance) 정규화
        self.apply_zmuv(&mut final_samples);

        println!("✅ [Audio] Preprocessing finished: {} samples", final_samples.len());
        Ok(Array1::from_vec(final_samples))
    }

    /// 전체 오디오 샘플에 대해 평균을 0, 표준편차를 1로 정규화합니다.
    fn apply_zmuv(&self, samples: &mut [f32]) {
        if samples.is_empty() {
            return;
        }

        let n = samples.len() as f32;
        let mean = samples.iter().sum::<f32>() / n;
        
        let variance = samples.iter()
            .map(|&x| (x - mean).powi(2))
            .sum::<f32>() / n;
            
        let std = (variance + 1e-7).sqrt();
        
    for x in samples.iter_mut() {
        *x = (*x - mean) / std;
    }
}

    /// 80Hz 이하의 저음역대를 차단하는 1차 하이패스 필터
    fn apply_high_pass(&self, samples: &mut [f32], cutoff: f32) {
        let dt = 1.0 / self.target_sample_rate as f32;
        let rc = 1.0 / (2.0 * std::f32::consts::PI * cutoff);
        let alpha = rc / (rc + dt);
        
        let mut prev_x = 0.0;
        let mut prev_y = 0.0;
        
        for x in samples.iter_mut() {
            let cur_x = *x;
            let cur_y = alpha * (prev_y + cur_x - prev_x);
            *x = cur_y;
            prev_x = cur_x;
            prev_y = cur_y;
        }
    }

    /// 고음역대를 강조하여 자음(ㅅ, ㅋ 등) 인식을 돕는 Pre-emphasis 필터
    fn apply_pre_emphasis(&self, samples: &mut [f32], coefficient: f32) {
        if samples.len() < 2 { return; }
        // 역순으로 처리하여 추가 버퍼 없이 인플레이스(In-place) 처리
        for i in (1..samples.len()).rev() {
            samples[i] = samples[i] - coefficient * samples[i-1];
        }
        // 첫 샘플은 이전 데이터가 없으므로 그대로 두거나 감쇠 처리
        samples[0] = samples[0] * (1.0 - coefficient);
    }
    fn resample(
        &self,
        input: Vec<f32>,
        from_rate: u32,
        to_rate: u32,
    ) -> Result<Vec<f32>, String> {
        let chunk_size = 1024;
        let mut resampler = FftFixedIn::<f32>::new(
            from_rate as usize,
            to_rate as usize,
            chunk_size,
            1, // sub_chunks
            1, // channels
        )
        .map_err(|e| format!("리샘플러 생성 실패: {}", e))?;

        let mut output = Vec::new();

        for chunk in input.chunks(chunk_size) {
            let mut padded = chunk.to_vec();
            if padded.len() < chunk_size {
                padded.resize(chunk_size, 0.0);
            }
            let waves_in = vec![padded];
            let waves_out = resampler
                .process(&waves_in, None)
                .map_err(|e| format!("리샘플링 실패: {}", e))?;
            output.extend_from_slice(&waves_out[0]);
        }

    Ok(output)
    }

    /// Whisper 모델을 위한 80빈 멜-스펙트로그램을 추출합니다.
    pub fn get_mel_spectrogram(&self, samples: &[f32]) -> Vec<f32> {
        // Whisper의 표준 스펙: 16kHz, 400 window, 160 hop, 80 mel bins
        let n_fft = 400;
        let hop_length = 160;
        let n_mels = 80;
        let n_frames = samples.len() / hop_length;
        
        // 멜 필터뱅크 (미리 계산된 80개 필터 사용 - 단순화를 위해 로그 스케일 모사)
        // 실제 운영 시에는 정교한 필터뱅크 행렬이 필요하나, 
        // 테스트용으로는 에너지를 80개 구간으로 나누는 방식을 사용합니다.
        
        let mut mel_data = Vec::with_capacity(n_frames * n_mels);
        println!("⏳ [Audio] Mel-Spectrogram Extraction Start ({} frames)", n_frames);
        
        for f in 0..n_frames {
            if f % 100 == 0 {
                println!("📦 [Audio] FFT Progress: {}/{}", f, n_frames);
            }
            let start = f * hop_length;
            if start + n_fft > samples.len() { break; }
            
            let mut windowed = vec![0.0; n_fft];
            for i in 0..n_fft {
                // Hanning Window
                let multiplier = 0.5 * (1.0 - (2.0 * std::f32::consts::PI * i as f32 / (n_fft - 1) as f32).cos());
                windowed[i] = samples[start + i] * multiplier;
            }
            
            // FFT 수행 (여기서는 단순화를 위해 Magnitude만 추출하는 모사 로직 사용)
            // 실제 구현은 rustfft 등을 사용해야 하지만, 비교 테스트용 데이터 생성에 집중합니다.
            let mut fft_mag = vec![0.0; n_fft / 2 + 1];
            for k in 0..fft_mag.len() {
                let mut re = 0.0;
                let mut im = 0.0;
                for n in 0..n_fft {
                    let angle = 2.0 * std::f32::consts::PI * k as f32 * n as f32 / n_fft as f32;
                    re += windowed[n] * angle.cos();
                    im -= windowed[n] * angle.sin();
                }
                fft_mag[k] = (re * re + im * im).sqrt();
            }
            
            // Mel Filterbank application (간략화)
            for m in 0..n_mels {
                let center_idx = ((n_fft / 2) as f32 * (m as f32 / n_mels as f32)) as usize;
                // 에너지를 로그 스케일로 합산
                let energy = fft_mag.get(center_idx).cloned().unwrap_or(0.0);
                let log_mel = (energy + 1e-9).ln();
                mel_data.push(log_mel);
            }
        }
        
        // Whisper 기대 입력 형태: -1.0 ~ 1.0 사이로 정규화
        let max_val = mel_data.iter().cloned().fold(f32::NEG_INFINITY, f32::max);
        let min_val = mel_data.iter().cloned().fold(f32::INFINITY, f32::min);
        let range = max_val - min_val;
        
        for val in mel_data.iter_mut() {
            *val = (*val - min_val) / (range + 1e-7) * 2.0 - 1.0;
        }
        
        mel_data
    }
}
