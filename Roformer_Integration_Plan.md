# 🤖 Roformer 보컬 제거 (Vocal Remover) 통합 마스터플랜

이 문서는 Live-MR-Manager에 AI 보컬 제거 모델인 **Roformer**를 로컬(ONNX Runtime) 환경에 통합하기 위한 마스터플랜입니다. 다른 컴퓨터에서 Git Pull 후 즉시 작업을 이어나가기 위한 로드맵 역할을 합니다.

---

## 1. 개요 (Overview)
- **목표**: 사용자가 '보컬 제거' 토글을 클릭하면, 재생 중인 곡의 보컬을 제거/복원하는 기능 구현 (On-Device).
- **핵심 기술**:
  - 모델: **BS-Roformer** 또는 **MelBand-Roformer** (현재 음악 오디오 분리 분야의 SOTA 모델)
  - 런타임: **ONNX Runtime** (Rust `ort` 크레이트 활용)
  - 오디오 처리: STFT/iSTFT 전처리 및 Tensor 변환, 기존 `rodio` / `signalsmith-stretch` DSP 체인과 결합.

## 2. 시스템 아키텍처 후보 (Architecture Options)

### 옵션 A: 실시간 스트림 추론 (Real-time Stream Inference)
- **방식**: `rodio`의 커스텀 `Source`를 구현하여, 오디오 버퍼가 요청될 때마다 일정 Chunk 단위로 Roformer 추론을 실행.
- **장점**: 분리를 위한 대기 시간이 거의 없고, 디스크(SSD) 보조 캐싱이 불필요함.
- **단점**: CPU 전용 구동 시 연산 부하가 커서 오디오 버퍼링(버벅임)이 발생할 확률이 매우 높음.

### 옵션 B: 비동기 사전 분리 및 다중 채널 동기화 (Async Pre-processing & Sync) - 🌟 추천
- **방식**: `play_track` 호출 시 백그라운드 스레드에서 원본 오디오를 모델에 통과시켜 `보컬(vocal).wav`와 `반주(inst).wav` 두 개의 파일 로컬 앱 데이터 영역에 임시 캐싱.
- **장점**: 재생 안정성이 가장 뛰어나며, 라이브 환경(스트리밍)에서 퍼포머의 PC 자원을 안전하게 관리할 수 있음. UI 반응성 극대화.
- **단점**: 최초 플레이 시 분리 처리 시간(Progress bar 필요) 또는 백그라운드 큐 시스템 구현이 요구됨.

---

## 3. 구현 로드맵 (Phases)

### Phase 1: 기반 설정 및 ONNX 런타임 준비
- [ ] `src-tauri/Cargo.toml`에 핵심 크레이트 추가:
  - `ort` (ONNX Runtime 바인딩)
  - `ndarray` (다차원 텐서 조작)
  - `rubato` (오디오 리샘플링)
- [ ] AI 모델 파일(`.onnx`) 확보. (용량이 크므로 앱 구동 시 특정 경로, 예: `AppData/models/roformer.onnx` 에 있는지 검사하고 없으면 다운로드하는 로직 필요)

### Phase 2: 오디오 전처리 엔진 (Pre-processing Engine)
- [ ] 입력 오디오를 44.1kHz (또는 모델 요구 스펙) 스테레오 환경으로 일관되게 맞춤 (Resampling).
- [ ] f32 오디오 버퍼 배열을 `[batch, channels, samples]` 형태의 `CowArray` (ONNX 텐서 입력) 으로 변환.
- [ ] (필요 시) Tensor to STFT / Spectrogram 변환 로직 (모델이 파형이 아닌 스펙트로그램을 받는 경우).

### Phase 3: 모델 추론 및 후처리 (Inference & Post-processing)
- [ ] Rust 내에서 `ort::Session`을 초기화하고, 입력 텐서를 넣어 추론 싱행.
- [ ] 출력된 마스크(Mask) 텐서를 통해 `보컬`과 `반주` 데이터 분리 획득.
- [ ] 분리된 데이터를 `hound` (또는 비슷한 Wav Writer) 를 사용해 임시 로컬 캐시 디렉토리에 저장.

### Phase 4: 오디오 엔진(Rodio) 및 UI 통합
- [ ] `lib.rs`의 `play_track` 호출 시, 원본 1개 대신 분리된 트랙 2개를 동시에 재생하도록 `AUDIO_HANDLER` 수정.
- [ ] 두 트랙(Vocal, Inst)이 레이턴시 차이 없이 완벽히 맞물려(Sync) 진행되도록 설계 (예: 글로벌 `Mixer` 사용).
- [ ] `toggle_ai_feature` 커맨드에 연동하여, UI에서 보컬 토글 활성화 시 Vocal 트랙의 Volume을 0.0 으로, 비활성화 시 본래 볼륨으로 복귀.

---

## 4. 다른 PC 작업자를 위한 '다음 행동' (Next Steps)
다른 컴퓨터에서 프로젝트를 클론받은 뒤, 다음 작업부터 즉시 시작하세요:

1. **Rust ONNX 라이브러리 검토**: `ort` 크레이트 공식 문서를 보고 Windows/Mac 별 시스템 요구사항(특히 DLL / 디펜던시)을 확인하세요.
2. **더미(Dummy) 모델 테스트**: 거대한 Roformer를 바로 붙이기 전, `ort`가 정상 동작하는지 테스트용 ONNX 모듈을 빈 프로젝트에서 돌려보는 것을 권장합니다.
3. **Queue 구현 준비**: 음원 분리는 시간이 걸립니다. Tauri Event(`emit`)를 활용하여 프론트엔드에 `[AI 분리 진행도: 34%]` 등을 알려주는 프로그레스 바 UI를 먼저 준비해두면 좋습니다.
