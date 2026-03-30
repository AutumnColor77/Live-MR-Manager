# 🎙️ Live MR Manager

> **AI 기반 로컬 구동형 스마트 오디오 제어 시스템 — 상세 설계서 v3 반영**

[![Tauri 2.0](https://img.shields.io/badge/Tauri_2.0-FFC131?style=for-the-badge&logo=tauri&logoColor=white)](https://tauri.app/)
[![Rust](https://img.shields.io/badge/Rust-000000?style=for-the-badge&logo=rust&logoColor=white)](https://www.rust-lang.org/)
[![C++](https://img.shields.io/badge/C++_Engine-00599C?style=for-the-badge&logo=cplusplus&logoColor=white)](https://isocpp.org/)
[![ONNX Runtime](https://img.shields.io/badge/ONNX_Runtime-005BA1?style=for-the-badge&logo=onnx&logoColor=white)](https://onnxruntime.ai/)

**Live MR Manager**는 실시간 방송 및 공연 환경에서 고성능 AI 음원 분리 및 정밀 오디오 제어를 제공하는 네이티브 데스크톱 애플리케이션입니다. 퍼포머 중심의 워크플로우를 위해 100% 로컬(On-Device) 자원을 활용하며, 저작권 리스크로부터 퍼포머를 보호하는 '법적 안전성'을 최우선으로 설계되었습니다.

---

## 💎 3대 핵심 설계 원칙 (Core Principles)

모든 기술적 의사결정은 아래 세 원칙의 우선순위를 기준으로 평가됩니다.

| 우선순위 | 원칙 | 적용 방향 |
| :--- | :--- | :--- |
| **P1** | **법적 안전성** | 모든 음원 가공은 **로컬(Local)**에서만 수행. 서버에 음원 데이터가 존재하지 않는 구조를 물리적으로 강제하여 저작권 리스크를 원천 차단합니다. |
| **P2** | **기계적 실시간성** | 오디오 처리 지연율 **20ms 이하**를 표준으로 설정. 모든 AI 파이프라인과 DSP 엔진은 이 기준선 아래에서 작동하도록 최적화됩니다. |
| **P3** | **퍼포머 중심성** | UI/UX 및 OBS 연동 등 모든 기능은 라이브 스트리머와 아티스트의 실제 **워크플로우**를 최우선으로 고려하여 설계합니다. |

---

## 🚀 현재 구현된 주요 기능 (Current Features)

### 🤖 온디바이스 오디오 엔진 (DSP Engine)
- **실시간 Pitch/Tempo 독립 제어**: `signalsmith-stretch` 및 `Rodio 0.22.x` 기반의 고성능 오디오 파이프라인. 음질 손실 없이 `-12` ~ `+12` 반음 및 `0.5x` ~ `2.0x` 속도 조절 지원.
- **초저지연 Passthrough**: 피치와 속도가 기본값일 때 DSP 엔진을 우회하여 레이턴시를 최소화하고 원래 음원을 그대로 재생.
- **다중 채널 완벽 지원**: 스테레오 채널 분리 및 위상 정합 처리(Planar processing)를 통해 위상 뒤틀림 없는 사운드 재생.

### 🎥 유튜브 및 로컬 스트리밍 (Streaming & Local)
- **yt-dlp 고도화 통합**: 백그라운드에서 실시간 유튜브 오디오 추출 및 재생. `yt-dlp` 출력 노이즈(WARNING 등) 자동 필터링 및 견고한 JSON 파싱 로직 적용.
- **데이터 저장소 현대화**: 기존 `Roaming` 경로의 불안정성을 해결하기 위해 **`LocalAppData`(`app_local_data_dir`)**로 라이브러리 및 AI 모델 저장소를 일원화하여 신뢰성 확보.
- **견고한 메타데이터 수집**: 음원 파일 손상이나 네트워크 지연 시에도 에러 없이 기본 정보를 생성하여 리스트에 즉각 추가되는 무중단(Robust) 추가 로직 구현.
- **썸네일 로컬 캐싱**: 유튜브 썸네일 차단 문제(Tracking Prevention)를 해결하기 위해 로컬 앱 데이터 폴더에 썸네일을 자동 저장하고 캐싱.
- **실시간 다운로드/재생**: `BufReader`와 비동기 다운로드를 결합하여 다운로드 완료 전에도 즉각적인 스트리밍 경험 제공.
- **로컬 폴더 스캐닝**: 지정된 로컬 폴더 내 오디오 파일을 고속으로 스캔하고 관리. (`m4a` 등 다양한 포맷 지원)

### 🎛️ 퍼포머 대시보드 (Smart Dashboard UI)
- **프리미엄 다크 테마**: 고해상도 글래스모피즘(Glassmorphism) 기반 세련된 UI.
- **정밀 그리드 레이아웃**: 모든 카드의 높이를 균일하게 유지하는 `grid-auto-rows: 1fr` 및 태그 하단 고정(`margin-top: auto`) 설계를 통해 잡지 레이아웃 수준의 시각적 안정성 확보.
- **커스텀 UI 컴포넌트**: 표준 컨트롤 및 브라우저 알럿을 대체하는 **Premium Select** 및 **Custom Confirm Modal** 시스템 도입.
- **고정밀 프로그레스 바**: 50ms 간격의 부드러운 재생 바 업데이트 및 정밀한 Seek 기능 지원.
- **통합 제어 패널**: 재생/일시정지, 다음 곡, 피치 조절 슬라이더, 검색 바 등 라이브 워크플로우 최적화.

### 📁 라이브러리 및 메타데이터 관리 (Library & Metadata)
- **카테고리 & 태그 중심 설계**: 카드 UI에서 불필요한 정보는 줄이고 카테고리와 태그 가시성을 극대화하여 실제 선곡 편의성 향상.
- **재생 시간 자동 보정**: 최초 재생 시 실제 음원 파일의 메타데이터를 분석하여 재생 시간을 (`3:45` 등) 영구적으로 업데이트 및 저장.
- **다이나믹 탐색**: 제목, 아티스트, 태그 기반 실시간 통합 검색 및 다양한 정렬 기준 지원.
- **메타데이터 에디터**: 곡 정보(제목, 아티스트, 썸네일, 카테고리, 태그) 실시간 수정 및 영구 저장.
- **재생 통계**: 곡별 플레이 횟수(`play_count`) 및 추가 날짜(`date_added`) 자동 추적.

---

## 🏗️ 기술 아키텍처 (Layer Structure)

시스템은 제로-카피(Zero-copy) 데이터 전달을 목표로 하는 5계층 구조로 설계되었습니다.

| 레이어 | 명칭 | 기술 구성 및 역할 |
| :--- | :--- | :--- |
| **Layer 3** | **UI Layer** | React/Dashboard UI 기반 퍼포머 대시보드. Tauri Event API 연동. |
| **Layer 2** | **IPC Layer** | Tauri 커맨드 핸들러. Rust 기반 비동기 스트리밍 설계. |
| **Layer 1** | **Audio Engine** | **Rodio 0.22 (Low-level playback control)**. Cpal 오디오 드라이버 연동. |
| **Layer 0** | **DSP Engine** | **signalsmith-stretch** (Rust optimized). 실시간 샘플 도메인 오디오 변환. |

---

## ⚙️ 상세 기술 스택 (Technical Stack)

- **Framework**: Tauri 2.0 (Rust/JS)
- **Audio Engine**: Rodio 0.22.x
- **DSP Engine**: **signalsmith-stretch 0.1.3**
- **YouTube Backend**: **yt-dlp (Fast Audio Extraction)**
- **UI Architecture**: Vanilla JS Core + Premium CSS Dashboard
- **Sample Processing**: 32-bit Floating Point (f32) high-fidelity processing

---

## 🏃 개발 환경 구축 (For Developers)

설계서 v3 기준 환경 구축 가이드입니다.

### 사전 요구 사항
- [Rust](https://www.rust-lang.org/tools/install)
- [Node.js](https://nodejs.org/) (v18+)
- [C++ Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) (SoX 엔진 빌드용)

### 프로젝트 시작
```bash
# 의존성 설치
npm install

# Tauri 개발 모드 실행
npm run tauri dev
```

---

## 📄 라이선스 및 협약
본 시스템은 기획/설계 단계(Phase 0-1)의 설계서 v3를 기반으로 구현 중입니다. 모든 기술적 권한은 설계서의 법적 준수 사항을 따릅니다.

