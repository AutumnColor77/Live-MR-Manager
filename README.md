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

## 🚀 주요 기능 (Key Features)

### 🤖 하이엔드 온디바이스 AI 파이프라인
- **Roformer 기반 음원 분리**: 최신 SOTA 모델인 **Roformer**를 핵심 모델로 채택하여 보컬과 MR의 완벽한 분리 품질을 제공합니다. (INT8 양자화 모델 활용)
- **WhisperX 가사 싱크**: **WhisperX (Forced Alignment)**를 통해 단어 수준의 정밀한 가사 타임스탬프를 자동 생성합니다.
- **ONNX 가속**: DirectML(Windows) 및 CoreML(macOS) GPU 가속을 통해 실시간에 준하는 빠른 추론 속도를 보장합니다.

### 🎛️ 실시간 스마트 오디오 컨트롤
- **초저지연 Key/Tempo 조절**: C++ 기반 고성능 오디오 엔진(SoX/FMOD)을 통해 음질 손실 없는 실시간 피치 및 속도 조절이 가능합니다.
- **ASIO/CoreAudio 지원**: OS 레벨 드라이버에 직접 접근하여 오디오 인터페이스의 성능을 최대로 활용합니다.

### 🎥 퍼포머 대시보드 (OBS Integration)
- **Native Dock UI**: OBS 내부에 전용 컨트롤 패널을 임베딩하여 방송 중 원스톱 조작이 가능합니다.
- **WebSocket 연동**: 127.0.0.1 로컬 통신을 통해 투명 가사 오버레이 및 상태 정보를 실시간 송출합니다.

---

## 🏗️ 기술 아키텍처 (Layer Structure)

시스템은 제로-카피(Zero-copy) 데이터 전달을 목표로 하는 5계층 구조로 설계되었습니다.

| 레이어 | 명칭 | 기술 구성 및 역할 |
| :--- | :--- | :--- |
| **Layer 4** | **UI Layer** | React/Vue 기반 퍼포머 대시보드. WebSocket을 통한 상태 동기화. |
| **Layer 3** | **Bridge Layer** | Tauri IPC 커맨드 핸들러. Rust 기반의 안전한 데이터 마샬링. |
| **Layer 2** | **FFI Layer** | Rust ↔ C++ 경계면. `unsafe` 블록을 통한 고성능 함수 호출. |
| **Layer 1** | **Core Engine** | **C++ Audio Engine (SoX/FMOD)**. 오디오 버퍼 포인터 직접 제어. |
| **Layer 0** | **OS Driver** | **ASIO (Windows) / CoreAudio (macOS)** 직접 접근. |

---

## ⚙️ 상세 기술 스택 (Technical Stack)

- **Framework**: Tauri 2.0 (Rust)
- **UI Architecture**: React or Vue (Performer-centric UI)
- **Audio DSP**: C++ Core Engine (SoX or FMOD Library)
- **AI Inference**: ONNX Runtime 1.17+
- **Separation Model**: **Roformer (Primary)**
- **Alignment Model**: WhisperX (ONNX Optimized)
- **Database**: SQLite 3.40+ (WAL Mode)

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

