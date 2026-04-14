use ndarray::Array2;
use ort::session::Session;
use std::path::Path;

pub struct OnnxEngine {
    session: Session,
}

impl OnnxEngine {
    pub fn new<P: AsRef<Path>>(model_path: P) -> Result<Self, String> {
        let session = Session::builder()
            .map_err(|e| format!("세션 빌더 생성 실패: {}", e))?
            .commit_from_file(model_path)
            .map_err(|e| format!("모델 로드 실패: {}", e))?;

        Ok(Self { session })
    }

    pub fn run_inference<F>(&mut self, audio_data: &[f32], is_whisper: bool, mut progress_callback: F) -> Result<Array2<f32>, String> 
    where F: FnMut(f32) {
        let total_samples = audio_data.len();
        
        if is_whisper {
            // Whisper 전용 로직: 단일 30초 덩어리 혹은 멜-데이터 처리
            println!("🚀 [Engine B] Whisper Encoder 추론 시작");
            
            // audio_data가 이미 멜-스펙트로그램으로 변환되었다고 가정
            // shape: [1, 80, 3000]
            let n_mels = 80;
            let n_frames = 3000;
            let mut mel_vec = audio_data.to_vec();
            mel_vec.resize(n_mels * n_frames, 0.0);
            
            let input_value =
                ort::value::Value::from_array(([1usize, n_mels, n_frames], mel_vec))
                    .map_err(|e| format!("Whisper 입력 값 생성 실패: {}", e))?;

            let outputs = self.session.run(ort::inputs![input_value])
                .map_err(|e| format!("Whisper 추론 실패: {}", e))?;

            let tensor = outputs[0].try_extract_tensor::<f32>()
                .map_err(|e| format!("Whisper 출력 추출 실패: {}", e))?;

            let shape = tensor.0;
            let frames = shape[1];
            let hidden_dim = shape[2];
            let data = tensor.1;
            
            progress_callback(90.0);
            
            Ok(Array2::from_shape_vec(
                (frames as usize, hidden_dim as usize), 
                data[..frames as usize * hidden_dim as usize].to_vec()
            ).map_err(|e| format!("Whisper 결과 변환 실패: {}", e))?)
        } else {
            // 기존 Wav2Vec2/CTC 로직 (Engine A)
            let chunk_size = 16000 * 30;
            let mut all_logits = Vec::new();
            let total_chunks = (total_samples as f32 / chunk_size as f32).ceil() as usize;

            for (i, start) in (0..total_samples).step_by(chunk_size).enumerate() {
                let end = (start + chunk_size).min(total_samples);
                let chunk = &audio_data[start..end];
                let seq_len = chunk.len();
                let chunk_vec = chunk.to_vec();

                let input_value =
                    ort::value::Value::from_array(([1usize, seq_len], chunk_vec))
                        .map_err(|e| format!("청크 #{} 입력 값 생성 실패: {}", i + 1, e))?;

                let outputs = self.session.run(ort::inputs![input_value])
                    .map_err(|e| format!("추론 실행 실패: {}", e))?;

                let tensor = outputs[0].try_extract_tensor::<f32>()
                    .map_err(|e| format!("출력 텐서 추출 실패: {}", e))?;

                let shape = tensor.0;
                if shape.len() == 3 {
                    let frames = shape[1] as usize;
                    let vocab = shape[2] as usize;
                    let data: &[f32] = tensor.1;
                    
                    let mut array = Array2::from_shape_vec(
                        (frames, vocab),
                        data[..frames * vocab].to_vec(),
                    )
                    .map_err(|e| format!("출력 변환 실패: {}", e))?;

                    // Log-Softmax 적용
                    for mut row in array.axis_iter_mut(ndarray::Axis(0)) {
                        let max_val = row.iter().fold(f32::NEG_INFINITY, |a, &b| a.max(b));
                        let sum_exp = row.iter().map(|&x| (x - max_val).exp()).sum::<f32>();
                        let log_sum_exp = max_val + sum_exp.ln();
                        for x in row.iter_mut() {
                            *x = *x - log_sum_exp;
                        }
                    }
                    all_logits.push(array);
                }

                let progress = ((i + 1) as f32 / total_chunks as f32) * 90.0;
                progress_callback(progress);
            }

            let views: Vec<_> = all_logits.iter().map(|a| a.view()).collect();
            ndarray::concatenate(ndarray::Axis(0), &views)
                .map_err(|e| format!("결과 병합 실패: {}", e))
        }
    }
}
