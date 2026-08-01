# 제3자 고지 (Third-Party Notices)

> 법률 자문이 아닙니다. Live MR Manager 배포·재배포 시 참고용 기술 인벤토리입니다.
> 최종 갱신: 2026-07-29 · 앱 버전 기준 v0.5.1

본 프로젝트 소스 코드는 [MIT License](LICENSE)입니다. 아래 항목은 **프로젝트 코드와 별개**인 제3자 구성요소입니다.

배포 형태 구분:

| 형태 | 의미 |
| --- | --- |
| **링크/포함** | 앱 바이너리에 정적/동적 링크되거나 빌드에 포함 |
| **런타임 다운로드** | 설치 파일에는 없고, 앱 실행 후 사용자 PC에 별도 저장 |
| **모델 가중치** | ONNX 등 AI 모델 파일(추론 코드와 라이선스가 다를 수 있음) |

---

## 1. 앱에 링크/포함되는 주요 구성요소

| 구성요소 | 용도 | 라이선스 | 출처 | 고지 |
| --- | --- | --- | --- | --- |
| Tauri 2 / wry / tao | 데스크톱 셸 | MIT / Apache-2.0 | [tauri.app](https://tauri.app/) | 원문 고지 유지 |
| ONNX Runtime (`ort`) | AI 추론 | MIT | [microsoft/onnxruntime](https://github.com/microsoft/onnxruntime) | Copyright Microsoft Corporation |
| ONNX Runtime EP DLL (선택) | CUDA/TensorRT/DirectML 가속 | MIT (ORT) | `src-tauri/resources/libs/*.dll` | 설치 패키지에 포함될 수 있음 · Microsoft 고지 유지 |
| signalsmith-stretch | Pitch/Tempo | MIT | [Signalsmith Stretch](https://github.com/Signalsmith-Audio/signalsmith-stretch) | Copyright notice 유지 |
| Rodio / Symphonia / cpal | 오디오 I/O·디코드 | MIT / Apache-2.0 등 | crates.io | Cargo 의존성 고지 |
| rusqlite (bundled SQLite) | 로컬 DB | MIT / Apache-2.0 (crate), SQLite Public Domain | crates.io | — |
| Next.js / React (Companion) | Companion 웹 | MIT | npm | `web/companion` 의존성 |

Rust·npm 전체 SBOM은 빌드 시점 `Cargo.lock` / `package-lock.json`을 기준으로 합니다. 릴리스 전에 주요 copyleft(GPL/LGPL/AGPL) 직접 링크 여부를 재확인하세요.

---

## 2. 런타임 다운로드 도구 (설치 파일 미포함)

앱이 필요 시 `%LOCALAPPDATA%\LiveMRManager\tools\` 등에 내려받습니다. **결합 바이너리**이므로 원 프로젝트 소스와 라이선스가 다를 수 있습니다.

| 도구 | 다운로드 URL | 배포 라이선스 | 고지 의무 |
| --- | --- | --- | --- |
| FFmpeg (BtbN win64 LGPL) | [고정 월말 빌드](https://github.com/BtbN/FFmpeg-Builds/releases/tag/autobuild-2026-06-30-13-34) | **LGPL-2.1-or-later** (해당 빌드 구성) | 자산 `ffmpeg-N-125365-g9a01c1cb6a-win64-lgpl.zip`; SHA-256 `75cb786fa14299eb1c1cacc2542a15c8da690e551ab41858383dc425c605b8ab`; 소스: [FFmpeg](https://ffmpeg.org/), 빌드: [BtbN/FFmpeg-Builds](https://github.com/BtbN/FFmpeg-Builds) |
| yt-dlp Windows exe | `https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe` | 소스 Unlicense, **PyInstaller exe는 GPLv3+** | [yt-dlp README](https://github.com/yt-dlp/yt-dlp), [THIRD_PARTY_LICENSES](https://github.com/yt-dlp/yt-dlp/blob/master/THIRD_PARTY_LICENSES.txt) |

정책:

- FFmpeg·yt-dlp는 원 배포처에서 사용자 PC로 직접 받으며, 프로젝트 GitHub Release·운영 서버에 **재호스팅하지 않음**.
- 설치 패키지(`*_setup.exe`)에 FFmpeg·yt-dlp를 **번들하지 않음**.
- 두 도구는 `std::process::Command`로 별도 프로세스 실행만 허용함. FFmpeg `libav*`를 앱에 정적·동적 링크하려면 별도 라이선스 검토가 필요함.
- 앱/문서에 도구명·출처·라이선스·소스 위치를 고지함.
- 사용자가 시스템 PATH의 자체 설치본을 쓰면 해당 배포본 라이선스가 적용됨.

GNU GPL FAQ는 설치 프로그램과 설치되는 파일을 별개의 저작물로 설명합니다. 이 프로젝트는 그 구분을 유지하면서 원 배포처 직접 다운로드와 별도 프로세스 호출만 사용합니다. 런타임 도구를 직접 재배포하게 되면 해당 라이선스의 소스 제공·고지 의무를 다시 검토해야 합니다.

---

## 3. AI 모델 가중치 (런타임 온디맨드)

코드 위치: [`src-tauri/src/state.rs`](src-tauri/src/state.rs) `MODELS`.

| model id | 파일 | 미러 | 상태 | 비고 |
| --- | --- | --- | --- | --- |
| `kim` | `Kim_Vocal_2.onnx` | [seanghay/uvr_models](https://huggingface.co/seanghay/uvr_models) | **잠정 MIT (크레딧 필수)** | UVR README가 모델 사용 시 MIT 준수·크레딧을 요청. HF 미러에는 `license` 태그 없음. 상업 이용 명시 확인은 [UVR#1242](https://github.com/Anjok07/ultimatevocalremovergui/issues/1242) 미해결. |
| `inst_hq_3` | `UVR-MDX-NET-Inst_HQ_3.onnx` | 동일 | **잠정 MIT (크레딧 필수)** | UVR 코어 개발자 학습 모델로 README에 포함. 동일하게 HF 라이선스 태그 없음. |

### UVR 크레딧 (필수)

Ultimate Vocal Remover (UVR) — [Anjok07](https://github.com/anjok07), [aufr33](https://github.com/aufr33)  
프로젝트: [Anjok07/ultimatevocalremovergui](https://github.com/Anjok07/ultimatevocalremovergui)

정식 배포 결론:

1. 기본 모델은 UVR README 근거로 **크레딧·고지와 함께** 온디맨드 제공을 유지한다.
2. HF 미러 라이선스 태그·작성자 직접 확인이 될 때까지 “잠정”으로 표기한다.
3. 명시적 비상업(CC-BY-NC 등) 모델은 **공식 기본/추천 카탈로그에 넣지 않는다**.
4. 신규 모델 채택 기준은 [`docs/MODEL_LICENSING.md`](docs/MODEL_LICENSING.md).

### 사용자 커스텀 분리 모델 (로컬 / HTTPS URL)

설정 → **커스텀 모델 관리**에서 이용자가 직접 등록하는 ONNX입니다. **프로젝트 공식 카탈로그가 아니며**, 라이선스·재배포·상업 이용 가능 여부는 이용자 책임입니다.

- **로컬 파일**: 이용자가 지정한 경로의 파일을 앱 데이터 폴더로 복사·검증합니다.
- **HTTPS URL**: HTTPS만 허용, 기대 SHA-256(64 hex) 필수, 용량 상한(2 GiB), 스트리밍 해시 검증 후 원자적 설치. 구현: [`src-tauri/src/model_commands.rs`](src-tauri/src/model_commands.rs).
- CC-BY-NC 등 비상업 모델은 공식 추천/Release에 넣지 않습니다. 커스텀으로 넣는 경우에도 이용자가 권리를 확인해야 합니다.

---

## 3.1 AI 가사 정렬(강제정렬) 모델 — KO/EN (런타임 온디맨드, 실험적)

코드 위치: [`src-tauri/src/alignment.rs`](src-tauri/src/alignment.rs) `ALIGNMENT_MODELS`. 배포처는
**본 프로젝트의 GitHub Release뿐**이며(재호스팅), 원본 Hugging Face 저장소를 ONNX로 변환한 결과물입니다.
전체 항목은 [`docs/MODEL_LICENSING.md`](docs/MODEL_LICENSING.md) §4를 참고하세요.

| 언어 | 원본 모델 카드 | 릴리스 자산 | SHA-256 | 용량 | 라이선스 |
| --- | --- | --- | --- | --- | --- |
| 한국어 | [kresnik/wav2vec2-large-xlsr-korean](https://huggingface.co/kresnik/wav2vec2-large-xlsr-korean) | [ai-align-model-v1/model.onnx](https://github.com/AutumnColor77/Live-MR-Manager/releases/download/ai-align-model-v1/model.onnx) · [tokens.txt](https://github.com/AutumnColor77/Live-MR-Manager/releases/download/ai-align-model-v1/tokens.txt) | model `e0377224ca28e4daa434155d9a035e858c7dc0c984084011734e101852bba4db` · tokens `4511d865e8decdc630f6a7c1781e53d3c22ae40b81702881e2629eddf846b082` | 약 1.2GB (model.onnx, 1,270,167,840 bytes) | Apache-2.0 |
| 영어 | [facebook/wav2vec2-base-960h](https://huggingface.co/facebook/wav2vec2-base-960h) | [align-model-en-v1/model.onnx](https://github.com/AutumnColor77/Live-MR-Manager/releases/download/align-model-en-v1/model.onnx) · [tokens.txt](https://github.com/AutumnColor77/Live-MR-Manager/releases/download/align-model-en-v1/tokens.txt) | model `7ffb91554931fb918bee1d2294d022886c73ca8642b93ad181d058300fe6a6ef` · tokens `07dd8185b1faf8802d94b9a1336aed9e54366994f7e2227b4b0fd0d32a9c044a` | 약 360MB (model.onnx, 377,884,762 bytes) | Apache-2.0 |

- **ONNX 변환 고지**: 위 두 모델은 원본 PyTorch 가중치를 ONNX로 변환(export)한 결과물입니다. 추론 코드·그래프 구조가 달라졌을 뿐, 학습 가중치의 저작권자는 원본 모델 카드에 기재된 저작자입니다. Apache License 2.0 §4(b)에 따라 변경 사실을 여기에 고지합니다.
- **다운로드 무결성**: 앱은 다운로드한 `model.onnx`/`tokens.txt`를 위 SHA-256과 대조해 일치하지 않으면 즉시 삭제하고 실패로 처리합니다(부분/변조 다운로드가 설치되지 않도록). 자세한 구현은 `src-tauri/src/alignment.rs`의 `download_alignment_model`을 참고하세요.
- **품질 고지**: 두 모델 모두 낭독체(read-speech) 데이터로 학습되었습니다. 가창(노래) 음성 정렬은 실험적 초안이며, 다운로드 확인 UI와 설정 화면에 "AI 초안, 사용자가 다듬기" 문구로 고지합니다.
- Apache-2.0 원문 고지: [`docs/licenses/alignment-models-NOTICE.md`](docs/licenses/alignment-models-NOTICE.md).
- 본 프로젝트 GitHub Release 자산은 **이 프로젝트가 직접 게시한 미러**이며, 외부 포크(fork)의 릴리스를 참조하지 않습니다.

---

## 4. 외부 서비스 (네트워크)

| 서비스 | 용도 | 비고 |
| --- | --- | --- |
| YouTube / yt-dlp | 메타·오디오 추출 | 플랫폼 ToS는 이용자 책임 |
| Hugging Face | 모델 다운로드 | Hub 약관·모델별 라이선스 |
| Last.fm | 메타 보강(선택) | Last.fm API 약관 |
| GitHub Releases | 앱 업데이트 확인 | — |
| Vercel Companion | OAuth 중계·법적 문서 | 서비스 이용약관 별도 |

---

## 5. 소프트웨어 라이선스 vs Companion 약관

- **MIT**: 소스·빌드 산출물의 사용·수정·재배포·판매을 허용(고지 조건).
- **Companion 이용약관**: `lmrm.vercel.app` 운영·OAuth·공식 브랜드에 관한 서비스 조건이며, MIT가 부여한 소프트웨어 권리를 축소하지 않는다.
- 상세: [`web/companion/lib/legal/terms-of-service.ts`](web/companion/lib/legal/terms-of-service.ts)
