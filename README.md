# 🎙️ Live MR Manager(Beta)

> **AI 기반 로컬 구동형 스마트 오디오 제어 시스템 — 상세 설계서 반영**

[![Tauri 2.0](https://img.shields.io/badge/Tauri_2.0-FFC131?style=for-the-badge&logo=tauri&logoColor=white)](https://tauri.app/)
[![Rust](https://img.shields.io/badge/Rust-000000?style=for-the-badge&logo=rust&logoColor=white)](https://www.rust-lang.org/)
[![C++](https://img.shields.io/badge/C++_Engine-00599C?style=for-the-badge&logo=cplusplus&logoColor=white)](https://isocpp.org/)
[![ONNX Runtime](https://img.shields.io/badge/ONNX_Runtime-005BA1?style=for-the-badge&logo=onnx&logoColor=white)](https://onnxruntime.ai/)

**Live MR Manager(Beta)**는 실시간 방송 및 공연 환경에서 고성능 AI 음원 분리 및 정밀 오디오 제어를 제공하는 네이티브 데스크톱 애플리케이션입니다. 퍼포머 중심의 워크플로우를 위해 100% 로컬(On-Device) 자원을 활용하며, 저작권 리스크로부터 퍼포머를 보호하는 '법적 안전성'을 최우선으로 설계되었습니다.

---

## 💎 3대 핵심 설계 원칙 (Core Principles)

모든 기술적 의사결정은 아래 세 원칙의 우선순위를 기준으로 평가됩니다.

| 우선순위 | 원칙                | 적용 방향                                                                                                                                   |
| :------- | :------------------ | :------------------------------------------------------------------------------------------------------------------------------------------ |
| **P1**   | **법적 안전성**     | 모든 음원 가공은 **로컬(Local)**에서만 수행. 서버에 음원 데이터가 존재하지 않는 구조를 물리적으로 강제하여 저작권 리스크를 원천 차단합니다. |
| **P2**   | **기계적 실시간성** | 오디오 처리 지연율 **20ms 이하**를 표준으로 설정. 모든 AI 파이프라인과 DSP 엔진은 이 기준선 아래에서 작동하도록 최적화됩니다.               |
| **P3**   | **퍼포머 중심성**   | UI/UX 및 OBS 연동 등 모든 기능은 라이브 스트리머와 아티스트의 실제 **워크플로우**를 최우선으로 고려하여 설계합니다.                         |

---

## 🚀 현재 구현된 주요 기능 (Current Features)

### 🤖 온디바이스 오디오 엔진 (DSP Engine)

- **고성능 모듈화 아키텍처**: 오디오 처리 로직을 `audio_player.rs`로 분리하여 코드 가독성과 확장성 극대화. 전역 `AUDIO_HANDLER`를 통한 정밀한 상태 관리.
- **실시간 Pitch/Tempo 독립 제어**: `signalsmith-stretch` 및 `Rodio 0.22.x` 기반의 고성능 오디오 파이프라인. 음질 손실 없이 `-12` ~ `+12` 반음 및 `0.5x` ~ `2.0x` 속도 조절 지원.
- **보컬 토글 페이딩 (Audio Fading)**: 보컬 On/Off 시 클릭 노이즈(Pops)를 방지하고 부드러운 전환을 위해 **300ms 실시간 선형 페이딩(Linear Interpolation)** 로직 적용.
- **초저지연 Passthrough**: 피치와 속도가 기본값일 때 DSP 엔진을 우회하여 레이턴시를 최소화하고 원래 음원을 그대로 재생.
- **다중 채널 완벽 지원**: 스테레오 채널 분리 및 위상 정합 처리(Planar processing)를 통해 위상 뒤틀림 없는 사운드 재생.

### 🧠 AI 고성능 음원 분리 (AI MR Separation)

- **BS-RoFormer & MDX-Net 통합**: 최신 AI 모델을 활용한 전문가급 보컬/세션 분리 기능 제공.
- **모듈화된 분리 엔진**: 분리 로직을 별도의 `separation` 모듈로 독립시켜 코드 유지보수성 향상.
- **완전 비동기 파이프라인**: `Tokio` 백엔드 워커를 통한 비동기 처리로 음원 분리 중에도 UI 및 오디오 재생이 끊기지 않는 논블로킹 환경 구현.
- **성능 최적화**: NVIDIA GPU 환경에서 CUDA 가속을 지원하며, 일반 환경에서도 DirectML/CPU를 통해 안정적인 고속 분리 제공.
- **고정밀 오디오 프로세싱**: 32-bit float 정밀 디코딩, **RMS 기반 자동 볼륨 정규화**, **소프트 리미팅** 적용으로 클리핑 없는 오디오 품질 확보.
- **지능형 작업 관리**: 전역 AI 가동 락 및 작업 큐 시스템을 통해 시스템 안정성 확보.

### 🎥 유튜브 및 로컬 스트리밍 (Streaming & Local)

- **유튜브 검색**: 사이드바 **유튜브 검색**에서 키워드로 YouTube를 검색(yt-dlp `ytsearch`)해 라이브러리에 추가. URL·로컬 파일은 **노래 추가** 모달로 등록 (하이브리드).
- **yt-dlp 고도화 통합**: 백엔드에서 실시간 유튜브 오디오 추출 및 재생. `yt-dlp` 출력 노이즈(WARNING 등) 자동 필터링 및 견고한 JSON 파싱 로직 적용.
- **레이스 컨디션 해결 및 스트리밍 최적화**: 유튜브 첫 재생 시 파일 생성 지연 문제를 `--no-part` 옵션과 파일 준비 대기 로직으로 완벽 해결.
- **데이터 저장소 현대화**: 기존 `Roaming` 경로의 불안정성을 해결하기 위해 **`LocalAppData`(`app_local_data_dir`)**로 라이브러리 및 AI 모델 저장소를 일원화하여 신뢰성 확보.
- **견고한 메타데이터 수집**: 음원 파일 손상이나 네트워크 지연 시에도 에러 없이 기본 정보를 생성하여 리스트에 즉각 추가되는 무중단(Robust) 추가 로직 구현.
- **썸네일 로컬 캐싱**: 유튜브 썸네일 차단 문제(Tracking Prevention)를 해결하기 위해 로컬 앱 데이터 폴더에 썸네일을 자동 저장하고 캐싱.
- **실시간 다운로드/재생**: 불완전 캐시는 버리고 다시 받으며, 관리형 yt-dlp는 **고정 릴리스 태그+SHA-256**으로 받습니다. YouTube 호스트만 재생·다운로드합니다. 실패 시 짧은 한국어 안내만 표시합니다.
- **로컬 폴더 스캐닝**: 지정된 로컬 폴더 내 오디오 파일을 고속으로 스캔하고 관리. (`m4a`, `flac`, `wav` 등 다양한 포맷 지원)

### 🎛️ 퍼포머 대시보드 (Smart Dashboard UI)

- **프리미엄 다크 테마**: 고해상도 글래스모피즘(Glassmorphism) 기반의 세련된 UI와 고밀도(High-density) 정보 배치.
- **전역 30px 세이프 에리어 (Safe-area Layout)**: 모든 페이지(Library, YouTube Search, Lyric Sync, Settings, Task Manager)에 엄격한 좌측 정렬 기준선(30px)을 적용하여 시각적 일관성과 안정성 확보.
- **통합 6컬럼 그리드 시스템**: 리스트 모드를 단일 그리드 구조로 개편하여 썸네일, 제목, 장르, 태그, 재생 시간의 **완벽한 수직/수평 정렬** 달성.
- **데이터 밀도 최적화**: 카드 내부 여백을 최소화하고 태그 표시 영역을 대폭 확장하여 한눈에 많은 정보를 파악할 수 있는 고효율 레이아웃 구현.
- **스마트 컨텍스트 메뉴**: 우클릭 시 현재 상태(재생/일시정지, 분리 중/취소)에 따라 메뉴 텍스트와 동작이 동적으로 변하며, 화면 경계 이탈 방지 로직 적용.
- **마이크로 애니메이션 및 트랜지션**: 버튼 클릭, 탭 전환, 팝업 등장 시 UX 완성도를 높이는 부드러운 애니메이션 시스템.

### 📁 라이브러리 및 Lyric Sync (Library & Syncing)

- **정밀 가사 동기화 도구 (Manual Lyric Sync)**: 탭-투-싱크(Tap-to-Sync) 방식의 고성능 Lyric Sync 도구.
  - **실시간 웨이브폼 렌더링**: 오디오 PCM 데이터를 기반으로 실시간 파형을 시각화하여 정밀한 타이밍 포인트 선정 지원.
  - **하이브리드 동기화 루프**: Rust 네이티브 엔진과 JS UI 간의 60fps 동기화 루프를 통해 탐색 바와 가사 스크롤의 완벽한 일치 달성.
  - **DB 메타데이터 통합**: 정렬할 곡 선택 시 라이브러리 DB와 연동하여 썸네일, 장르, 태그 정보를 즉각적으로 표시.
  - **뷰포트 최적화**: 하단 컨트롤 독(Dock)과의 레이아웃 간섭을 해결하고 30px 세이프 에리어를 적용한 프리미엄 UI.
  - **스마트 가사 분석**: 기존 `.lrc` 파일 자동 로드 및 텍스트 수정 시 타임스탬프를 유지하는 지능형 파싱 로직.
  - **원문/차음/번역 3줄 모드**: 3줄을 한 싱크 단위로 묶어 `[orig]`/`[pron]`/`[tran]`으로 저장(태그 없는 LRC와 하위 호환).
  - **AI 자동 정렬**: 언어 선택(설정 연동)·대기열 공유. BPM 그리드 배치는 코드만 남기고 UI에서 숨김.
  - **듀레이션 락킹 (Duration Locking)**: 백엔드 상태 변화 시에도 트랙 길이를 고정하여 UI 리셋 현상을 원천 차단.
- **곡 정보 관리자 (Library Manager)**: 엑셀 스타일의 고밀도 테이블을 통한 곡 메타데이터(제목, 아티스트, 카테고리, 장르, 태그) 일괄 편집 기능.
- **MR(인스트루먼탈) 수동 관리**: 메타데이터 모달에서 직접 MR 여부를 설정 가능. 단, AI로 분리된 곡은 데이터 보호를 위해 체크박스가 자동으로 잠김(Lock) 처리됨.
- **지능형 상태 뱃지**: "MR", "분리중", "대기중" 등 곡의 현재 상태를 독립적인 전용 컬럼에서 명확하게 표시.
- **정밀 열 너비 제어 (Adjacent Resizing)**: 인접한 두 열이 서로 연동되어 변하는 'Adjacent Trade-off' 방식의 리사이저 구현. 백분율(%) 기반 너비 저장 시스템으로 다양한 창 크기에서도 레이아웃 유지.
- **장르 데이터 전처리**: 장르 정보가 없는 곡을 "미분류"로 자동 통합하며, 온라인 메타데이터 검색 시 "Unknown" 계열의 노이즈 데이터를 자동 필터링.
- **유동적 정렬 및 필터링**: 관리자 모달 내 실시간 검색 및 각 컬럼별 즉각적인 정렬 기능 제공.
- **재생 시간 자동 보정**: 최초 재생 시 실제 음원 파일의 메타데이터를 분석하여 재생 시간을 (`3:45` 등) 영구적으로 업데이트 및 저장.
- **다이나믹 탐색**: 제목, 아티스트, 태그 기반 실시간 통합 검색 및 다양한 정렬 기준 지원.
- **메타데이터 에디터**: 곡 정보(제목, 아티스트, 썸네일, 카테고리, 태그, MR 여부) 실시간 수정 및 영구 저장.
- **UX 편의 시스템**: 전역 `Esc` 키 연동을 통한 모든 모달/메뉴 닫기 기능 및 컨텍스트 메뉴 오픈 시 클릭 간섭 방지 로직 적용.
- [x] **실시간 가사 드로어 (Lyric Drawer)**: 음악 재생 시 오른쪽에서 슬라이딩되는 가사 전용 창. 실시간 하이라이트 동기화 및 자동 스크롤 지원.
- [x] **그리드 카드 디자인 복원**: 과거의 정갈한 서식(15px 제목, 파란색 가수명 배지, 대문자 태그)과 역동적인 호버 효과 복원.
- [x] **스마트 가사 파싱**: 어절 단위(`keep-all`) 줄바꿈 및 가사 카드 여백 최적화를 통한 감상 최적화.
- [x] **오디오 UI 고도화 및 태그 확장**: 전역 폰트 크기 통일, 마스터 볼륨 레이아웃 개편 및 50여 종의 신규 장르/태그 매핑 대거 추가.
- [x] **재생 통계**: 곡별 플레이 횟수(`play_count`) 및 추가 날짜(`date_added`) 자동 추적.
- [x] **방송 오버레이 커스텀 (Broadcast Integration)**: 실시간 방송 송출을 위한 전문적인 오버레이 관리 시스템.
  - **WebSocket 기반 실시간 동기화**: 앱의 재생 상태와 디자인 설정을 별도의 브라우저 소스로 실시간 전송.
  - **디자인 커스텀 UI**: 배율(Scale), 폰트, 테마 컬러(팔레트/Hex), 배경 투명도 및 둥글기를 제어하는 전용 설정 인터페이스 제공.
  - **텍스트 흐름(Marquee) 애니메이션**: 제목이나 가수명이 길 경우 자동으로 좌우로 흐르는 가독성 강화 애니메이션 적용.
  - **디자인 설정 영속성**: 사용자 지정 디자인 테마를 `localStorage`에 저장하여 앱 재시작 시 자동 복구.

### 🆕 v0.7.7 업데이트 (2026-09-02)

상세: [RELEASE_NOTES.md](RELEASE_NOTES.md) v0.7.7 절.

- **데스크톱 보안**: 비신뢰 HTML 이스케이프, YouTube 전용 HTTP 재생, Songbook OAuth `state` 검증, yt-dlp/UVR SHA-256 고정, 커스텀 모델 사설망 차단.
- **라이브러리 UI**: 사이드바 접힘 시 그리드 열 수 유지.
- **Songbook**: 로그인 프로필 표시, 보내기 병렬화, 플레이스홀더 재생 URL 해석.
- **OBS 오버레이**: 미리보기 중앙 배치, 등장 애니메이션 미리보기.
- **곡 정보 수정**: 창이 작을 때 모달 본문만 스크롤.
- **업데이트 알림**: 앱 시작 시 즉시 표시.

### 🆕 v0.7.6 업데이트 (2026-08-29)

상세: [RELEASE_NOTES.md](RELEASE_NOTES.md) v0.7.6 절.

- **OBS 오버레이**: 상시보기 꺼진 상태에서 재생 정지 시 미리보기·방송 화면이 투명하게 사라지고, 탭 간 스위치가 즉시 동기화됩니다. 가사 탭 전환 시 더미 가사가 OBS에 남던 문제를 제거했습니다.
- **릴리즈 미리보기 연결**: CSP·WebSocket 호스트를 보정하여 릴리즈 빌드에서 오버레이 iframe/연결 거부 오류를 수정했습니다.
- **AI 가사 정렬 대기열**: 빈 프로바이더 배지 제거, 취소 버튼 정렬, 완료 시 대기열 항목 자동 삭제.

### 🆕 v0.7.5 업데이트 (2026-08-23)

상세: [RELEASE_NOTES.md](RELEASE_NOTES.md) v0.7.5 절.

- **미지원 코덱 Fallback**: Opus/WebM 등 Symphonia가 못 읽는 음원을 FFmpeg로 PCM 디코딩·WAV 캐시 재생·재생 시간 추출합니다.
- **유튜브 포맷**: AAC(`m4a`/`mp4a`/140) 우선 요청, 추출 차단 시 fallback player client 재시도.

### 🆕 v0.7.4 업데이트 (2026-08-19)

상세: [RELEASE_NOTES.md](RELEASE_NOTES.md) v0.7.4 절.

- **유튜브 재생**: 깨진 캐시 재사용 금지, 관리형 yt-dlp 무결성 검증, 90초 대기, 실패 알림 1회·한국어 안내. YouTube 호스트만 재생·다운로드합니다.
- **유튜브 검색 미리듣기**: 스트림만 재생, 독 마스터 볼륨 연동.
- **신청목록에 추가**: 라이브러리 우클릭·선택 모드 (노래책에 있는 곡).
- **계정 메뉴**: 운영페이지 / 노래책페이지 / 로그아웃.
- **가사 드로어**: 선택한 곡으로 싱크 화면 이동, 좁은 폭 CTA·문구 줄바꿈.
- **OBS 오버레이**: 미리보기·설정 2열 레이아웃.

### 🆕 v0.7.3 핫픽스 (2026-08-07)

상세: [RELEASE_NOTES.md](RELEASE_NOTES.md) v0.7.3 절.

- **VC++ Redistributable**: Windows 신규 설치 시 x64 런타임이 없으면 NSIS가 `vc_redist.x64.exe`를 함께 설치합니다 (`MSVCP140_1.dll` 오류 방지).

### 🆕 v0.7.2 핫픽스 (2026-08-07)

상세: [RELEASE_NOTES.md](RELEASE_NOTES.md) v0.7.2 절.

- **계정 메뉴**: 닉네임 → 노래책 / 로그아웃.
- **신청목록**: Google·네이버 브랜드 로그인 버튼.
- **업데이트 링크**: Windows `\\` 오류 수정.

### 🆕 v0.7.1 핫픽스 (2026-08-06)

상세: [RELEASE_NOTES.md](RELEASE_NOTES.md) v0.7.1 절.

- **Songbook URL**: 프로덕션 기본 주소를 [www.livemrsongbook.com](https://www.livemrsongbook.com)으로 변경.

### 🆕 v0.7.0 업데이트 (2026-08-06)

상세: [RELEASE_NOTES.md](RELEASE_NOTES.md) v0.7.0 절 · 사용자 안내 [UserManual.md](UserManual.md) §6 Songbook.

- **Songbook 로그인**: Google/네이버, 웹 세션 재사용(`desktop-connect`), 헤더 프로필 아바타.
- **라이브러리 보내기**: 본인 채널로 Push(POST/PATCH). 채널 없으면 생성. 공유 demo 제외. 앱에 없는 원격 곡은 웹에서 숨김.
- **신청목록·재생 큐**: 대기열 운영·드래그 순서, OBS 대기열 오버레이(`/queue`).
- **후원금액**: 곡 정보·스프레드시트·Songbook 동기화.
- **썸네일**: 동기화 전 작게 줄여 업로드. 음원 파일은 올리지 않음(메타만).

### 🆕 v0.6.1 업데이트 (2026-08-04)

상세: [RELEASE_NOTES.md](RELEASE_NOTES.md) v0.6.1 절.

- **유튜브 검색**: 사이드바 **유튜브 검색**(yt-dlp `ytsearch`) + **노래 추가** 모달(URL/파일) 하이브리드.
- **오버레이**: 상시 표시(미리보기) 토글 칩이 앱 테마 색을 따름.

### 🆕 v0.6.0 업데이트 (2026-08-01)

상세: [RELEASE_NOTES.md](RELEASE_NOTES.md) v0.6.0 절.

- **멜로밍 연동 제거**: OAuth·노래책 가져오기/보내기·deep-link 제거. 멜로밍 전용 곡은 라이브러리 로드 시 정리.
- **커스텀 분리 모델 URL 등록**: HTTPS + SHA-256 + 용량 상한 + 사설망 차단으로 외부 ONNX 등록(이용자 라이선스 확인 책임).
- **노래 추가 UX**: 사이드바 **노래 추가** 모달(URL/파일), 소스 필터 칩, DnD→모달. (이후 v0.6.1에서 **유튜브 검색** 페이지 추가)
- **가사 싱크**: 3줄(원문/차음/번역) 모드, AI 정렬 패널·언어 연동, 미싱크 배지 밝은 테마 대비, BPM 그리드 버튼 숨김.
- **AI 작업**: 라이브러리 선택 모드 일괄 정렬, 랩(rap) 이중 패스, 분리/정렬 대기열 UI.
- **설정 UX**: 카드 레이아웃·MR 캐시 경로·설명 문구를 기존 톤앤매너에 맞춤.
- **확인 모달**: 싱크 초기화 등 네이티브 `confirm` 제거, X 닫기·소형 확인창.
- **라이선스 문서**: MIT·THIRD_PARTY_NOTICES·MODEL_LICENSING·준수 체크리스트.
- **Companion**: 다운로드·FAQ·약관 안내 사이트로 유지(멜로밍 OAuth 제거).
- **알림 문구 목록**: [docs/NOTIFICATION_MESSAGES.md](docs/NOTIFICATION_MESSAGES.md)

### 🆕 v0.5.1 핫픽스 (2026-07-13)

- 멜로밍 OAuth 배포 로그인 핫픽스(이후 v0.6.0에서 멜로밍 연동 제거).
- 버전 메타데이터 `0.5.1` 통일.

### 🆕 v0.5.0 업데이트 (2026-07-05)

- 멜로밍 노래책 가져오기/보내기·Push 고도화·별점 UI(이후 v0.6.0에서 연동 제거).
- 버전 메타데이터 `0.5.0` 통일.

### 🆕 v0.4.16 핫픽스 (2026-07-05)

- **MP3 MR 저장 ffmpeg 핫픽스**: MR MP3 저장이 유튜브와 같은 **관리형 ffmpeg** 탐색·자동 다운로드를 사용합니다. 설치 PC에 ffmpeg가 PATH에 없어도 `Vocal save failed: failed to run ffmpeg` 오류를 방지합니다.
- **멜로밍 노래책 동기화 안내**: OpenAPI 아티스트·카테고리 API 대기 중 — 설정 카드 문구 정리, 클릭 시 안내, 백엔드 `pull`/`push` 차단. **멜로밍 로그인**은 유지.
- **버전 메타데이터 통일**: `0.4.16`으로 일괄 갱신.

### 🆕 v0.4.15 업데이트 (2026-06-27)

- **노래책 동기화 업데이트 예정**: 설정 **「노래책 동기화」** 버튼을 일시 중단합니다. 멜로밍 OpenAPI에 아티스트·카테고리 등록 API가 없어 Push가 대부분 실패하는 상태이므로, API 지원 후 다시 제공할 예정입니다.
- **멜로밍 로그인 유지**: 우측 상단 OAuth 로그인은 계속 사용할 수 있습니다.
- **버전 메타데이터 통일**: `package.json`, `Cargo.toml`, `tauri.conf.json`, 앱 타이틀·사용자 매뉴얼·Companion FAQ를 `0.4.15`로 맞춤.

### 🆕 v0.4.14 업데이트 (2026-06-27)

- **유튜브 메타데이터 자동 보강**: CSV/XLSX 가져오기 시 URL만 있어도 썸네일·재생 시간·아티스트를 「정보 가져오기」와 같이 채웁니다. CSV에 명시한 제목·아티스트·재생 시간은 덮어쓰지 않으며, 완료 토스트에 보강 곡 수를 표시합니다.
- **재생 시 메타 보강**: 스프레드시트 등으로 최소 정보만 등록된 유튜브 곡을 재생하면 백그라운드에서 썸네일·길이·아티스트를 보강하고 도크·라이브러리 UI를 즉시 갱신합니다.
- **설정 법적 고지**: 설정 화면에 **개인정보 처리방침**·**이용약관** 버튼을 추가해 Companion([lmrm.vercel.app](https://lmrm.vercel.app)) 문서를 앱에서 바로 열 수 있습니다.
- **멜로밍 Push 안정화**: Push 전 유튜브 메타 보강, 아티스트명 느슨 매칭(포함 관계), 다른 채널 `meloming_song_id` 무시, PATCH 403/404 시 CREATE 재시도.
- **멜로밍 계정 메뉴 UI**: 헤더와 계정 드롭다운 z-index를 조정해 메뉴가 가려지지 않도록 수정했습니다.
- **버전 메타데이터 통일**: `package.json`, `Cargo.toml`, `tauri.conf.json`, 앱 타이틀·사용자 매뉴얼을 `0.4.14`로 맞춤.

### 🆕 v0.4.13 업데이트 (2026-06-27)

- **Companion 개인정보 처리방침**: [lmrm.vercel.app/privacy](https://lmrm.vercel.app/privacy) — 멜로밍 OAuth 4 scope, 음원 로컬 전용, Last.fm·쿠키·제3자 연동 안내. 푸터·FAQ에서 링크.
- **Companion 이용약관**: [lmrm.vercel.app/terms](https://lmrm.vercel.app/terms) — 베타 면책, 멜로밍·저작권·이용자 의무. 푸터 링크.
- **멜로밍 로그인·보내기 재개**: `MELOMING_COMING_SOON` 잠금을 해제해 우측 상단 **「멜로밍 로그인」**·설정 **「멜로밍에 보내기」**를 다시 사용할 수 있습니다. (멜로밍 서버 500 등 오류 시 재시도 안내)
- **멜로밍 Push 개선**: 보내기 전 아티스트 Map 갱신, 건너뜀·오류 요약을 토스트에 표시.
- **버전 메타데이터 통일**: `package.json`, `Cargo.toml`, `tauri.conf.json`, 앱 타이틀·사용자 매뉴얼을 `0.4.13`으로 맞춤.

### 🆕 v0.4.12 업데이트 (2026-06-10)

- **설정 버튼 레이아웃**: 멜로밍·백업 등 설정 카드 액션 버튼 너비를 150px로 통일했습니다.
- **MR 저장 형식 UI**: 드롭다운 열 250px, 긴 옵션 텍스트 줄바꿈 방지.
- **MP3 MR 저장 안정성**: ffmpeg 실행 시 `CREATE_NO_WINDOW` 적용 — 변환 중 CMD 창이 뜨지 않습니다.

### 🆕 v0.4.11 업데이트 (개발 빌드 · 2026-06-09)

- **멜로밍 노래책 — 다중 플랫폼 채널 주소**: 설정 「방송 채널 주소」에 **치지직 · SOOP(숲) · 씨미(CIME)** URL·ID를 입력해 Pull·연결 테스트 가능. (`resolve.rs` → `GET /v1/channels/platforms/{CHZZK|SOOP|CIME}/…`)
- **멜로밍 OAuth·Push (v0.4.13 재개)**: PKCE·deep-link·companion 토큰 프록시·**로그인·보내기** UI 활성화. 멜로밍 `POST /oauth/token` **500** 등 서버 오류 시 재시도 안내. **가져오기·연결 테스트·채널 저장**은 OAuth 없이 사용 가능.
- **곡 정보 저장 안정화**: 메타데이터 저장 시 DB 락 데드락 수정, 저장 후 전체 `loadLibrary()` 대신 로컬 state 갱신·모달 즉시 닫기.
- **타이틀바 창 이동**: 커스텀 타이틀바 드래그 영역·`startDragging` 폴백, Tauri capability(`core:window:allow-start-dragging`) 반영.
- **Vercel companion 확장** ([lmrm.vercel.app](https://lmrm.vercel.app)): `/login`, `/account`, 웹 OAuth 테스트 API, `/api/oauth/exchange`(앱용). OAuth 콜백은 웹 PKCE 세션이 있으면 웹 로그인, 없으면 앱 딥링크(`live-mr-manager://`)로 분기.
- **채널 주소 저장**: 설정 입력값은 **로컬 SQLite**에만 저장. 신규 설치·배포본에는 기본값 없음(빈 칸).

### 🆕 v0.4.10 업데이트 (안정화 패치 · 2026-06-02)

- **MR 캐시 경로 통일 (`cache_key_variants`)**: 유튜브 URL 형식(`youtu.be`, `watch?v=` 등) 차이로 MR 파일·배지·KEY/BPM 분석 경로가 어긋나던 문제를 재생/삭제 로직과 동일한 변형 키 탐색으로 통일했습니다.
- **MR 배지 신뢰성 개선**: 라이브러리 로드 시 `vocal.wav`/`inst.wav` 존재 여부를 변형 키로 판별하고, 카드 렌더 시 `check_mr_separated`로 한 번 더 확인해 F5 이후에도 배지가 유지됩니다.
- **KEY/BPM 분석 MR 연동 수정**: MR 분리 완료 후에도 `inst.wav`를 찾지 못하던 경로 불일치를 해결해, 온라인 곡에서도 MR 기반 분석이 동작합니다.
- **카테고리 필터 드롭다운 정합성**: 실제 곡에 쓰인 카테고리만 표시하고, 메타데이터·관리자 저장·곡 추가/삭제 후 **재시작 없이** 목록이 갱신됩니다.
- **카테고리 표시/저장 동기화**: `categories`와 `curationCategory` 우선순위를 정리해 카드·필터·편집 모달이 같은 값을 보여 주며, 저장 시 DB에 일관되게 반영됩니다.
- **Windows 개발 환경 가이드 보강**: `signalsmith-stretch` 빌드용 **LLVM(libclang)** 및 PowerShell 실행 정책/`npm.cmd` 안내를 추가했습니다.
- **스프레드시트 가져오기/보내기**: 설정에서 라이브러리를 CSV/XLSX로 보내고 병합 가져오기(한글 헤더 지원).
- **GitHub 업데이트 알림**: 최신 릴리즈를 주기적으로 확인해 앱 내에서 새 버전을 안내합니다.

### 🆕 v0.4.9 업데이트

- **버전 정합성 업데이트**: 앱 메타데이터(`package`, `cargo`, `tauri`)를 `0.4.9`로 통일했습니다.
- **문서/타이틀 버전 표기 정리**: 사용자 매뉴얼 및 앱 타이틀에 노출되는 버전을 `v0.4.9`로 갱신했습니다.

### 🆕 v0.4.8 업데이트

- **앱 버전 업그레이드 및 테마 확장**: 기본 다크/아이보리 외에 `분홍`, `하늘` 테마를 추가해 방송 콘셉트별 톤 전환이 쉬워졌습니다.
- **가사 싱크 엔진 고도화**: Forced Alignment 실행/취소, 정렬 페널티 실시간 튜닝, 파형 요약 캐시 재활용을 통해 긴 곡에서도 안정적인 정렬 워크플로우를 제공합니다.
- **LRC 저장/로드 호환성 강화**: 유튜브 URL 변형(`youtu.be`, `watch?v=` 등)과 경로 정규화 케이스를 통합 처리하여 가사 파일 탐색 실패를 크게 줄였습니다.
- **AI 분리 취소 안정성 개선**: 경로 정규화 + 취소 플래그를 분리 스레드/진행률 루프 전반에 반영해 대기중/처리중 취소가 일관되게 동작합니다.
- **OBS 오버레이 서버 내장 운영**: 앱 시작 시 WebSocket(`14201`) + 페이지 서버(`14202`)를 자동 기동하고, 곡정보/가사 URL을 분리해 OBS 구성 유연성을 높였습니다.
- **메타데이터 편집 생산성 향상**: 메타데이터 모달에서 `KEY/BPM 분석`을 즉시 실행해 결과를 편집 필드에 자동 반영할 수 있습니다.

### 🆕 v0.4.7 업데이트

- **앱 전역 다크/라이트 테마 도입**: 기존 다크 UI를 유지하면서 라이트 모드를 추가하고, 선택값을 저장해 재실행 후에도 동일한 테마가 유지됩니다.
- **라이트 테마 톤앤매너 리디자인**: 순백 기반이 아닌 아이보리/웜 뉴트럴 팔레트로 재구성하고, 주요 포인트 컬러를 블루 계열에서 웜 계열로 조정해 장시간 사용 가독성을 개선했습니다.
- **UI 전역 토큰화 및 대비 개선**: 메인/모달/토스트/플레이어/라이브러리/가사 싱크 화면의 하드코딩 색상을 테마 토큰으로 치환하고, 라이트 모드에서 발생하던 저대비(흰 배경/흰 글자 등) 문제를 정리했습니다.
- **Lyric Sync 가시성 강화**: 오디오 타임라인 파형/세그먼트 렌더링을 테마별 팔레트로 분기해 라이트 모드에서도 웨이브폼, 테두리, 가사 카드 텍스트가 명확히 보이도록 개선했습니다.
- **유튜브 추가 UX/안정성 개선**: `정보 가져오기` 버튼 로딩 스피너 및 크기 정렬을 적용하고, YouTube 영상 ID 기반 중복 등록 방지 로직을 추가했습니다.
- **관리 화면 및 오버레이 완성도 보강**: 곡 정보 관리자 테이블 대비/열 너비/삭제 버튼 줄바꿈 문제를 수정하고, OBS 미리보기/가이드 박스 및 가사/곡정보 오버레이의 테마 동기화를 일관되게 맞췄습니다.

---

## 🔗 Live MR Songbook

멜로밍 연동(v0.6.0에서 제거)을 대체하는 **자체 Songbook**([livemrsongbook.com](https://www.livemrsongbook.com)) 연동입니다.

| 원칙 | 내용 |
| --- | --- |
| 음원 | 로컬만. Songbook에는 제목·아티스트·카테고리·태그·KEY/BPM·썸네일 등 **메타만** |
| 로그인 | Google / 네이버 · deep-link 세션 |
| 동기화 | 앱 ↔ Songbook **보내기**·**가져오기**(본인 채널). Pull·Push 모두 지원 |

사용자 절차: [UserManual.md](UserManual.md) 「Live MR Songbook」.

---

## 🔗 참고: 멜로밍 노래책 연동 (제거됨)

로컬 MR 라이브러리와 [멜로밍 OpenAPI](https://developers.meloming.com/docs/openapi) 채널 노래책을 **양방향으로 메타데이터만** 맞추는 기능입니다. ([노래책 API 레퍼런스](https://developers.meloming.com/docs/openapi/reference/songbook))

| 원칙 | 내용 |
| :--- | :--- |
| **P1 유지** | 음원·AI 분리 결과는 로컬만. 멜로밍에는 제목·URL·가사 텍스트·숙련도/난이도·KEY/BPM 등 **메타만** 전송 |
| **읽기** | `GET /v1/...` — 개발자 등록 **없이** 채널 ID만으로 Pull·검색 가능 |
| **쓰기** | `POST`/`PATCH`/`DELETE` — OAuth 필요. 문서 「애플리케이션 등록」→ 콘솔 **미니앱(앱) 등록·심사** 경로 |

### 구현 단계 (실행 순서)

**1순위: Vercel companion + 미니앱 신청** → 심사·OAuth 대기 중 **Phase 0·1·2B 코드** 병행 → 승인 후 Push 연동.

| 순서 | 단계 | 내용 |
| :--- | :--- | :--- |
| **1** | **Phase 2A** | **Vercel** companion + 미니앱 등록·심사 (임계 경로) |
| 병행 | **Phase 0** | KEY/BPM·숙련도·난이도 DB/UI 영속화 |
| 병행 | **Phase 1** | Rust `meloming` 모듈, Pull, Map (무인증) |
| 병행 | **2B 준비** | OAuth PKCE·Push 코드 (실연동은 2A 승인 후) |
| **2** | **Phase 2B** | Push·PATCH·DELETE 실연동 |
| **3** | **Phase 3** | 양방향 동기화, 충돌 해결 |
| **4** | **Phase 4** | changelog·`/api/releases/latest`, 업데이트 알림 |

### Vercel companion (미니앱·OAuth·서비스 허브)

단일 HTTPS 도메인([lmrm.vercel.app](https://lmrm.vercel.app))으로 다음을 운영합니다.

- **미니앱 iframe** — 연동 안내, 다운로드
- **OAuth Redirect** — `https://lmrm.vercel.app/oauth/callback` (웹 PKCE 로그인 또는 앱 딥링크 브릿지)
- **OAuth 토큰 프록시** — `POST /api/oauth/exchange`, `POST /api/oauth/refresh` (배포본 기본: Client Secret은 Vercel에만, 앱에는 Client ID만 임베드)
- **FAQ / Q&A** — 동기화·숙련도/난이도 등
- **`/privacy`** — 개인정보 처리방침 (앱·웹 통합)
- **`/terms`** — 이용약관
- **(테스트) 웹 로그인** — `/login`, `/account` (OAuth API 검증용, 추후 정리 예정)
- **changelog·업데이트 API** — GitHub Releases(설치 파일) + companion(릴리즈 노트·manifest) (Phase 4)

**현재 상태 (2026-07)**: **노래책 가져오기·보내기(v0.5.0)** 활성. **멜로밍 로그인(v0.5.1)** — 배포본은 Client ID 임베드 + Companion 토큰 프록시. 없는 아티스트·카테고리는 Push 시 자동 등록. **MP3 MR 저장(v0.4.16)** 은 관리형 ffmpeg로 PATH 없이도 동작. OAuth 토큰 교환 **500/401**은 멜로밍 서버 이슈 시 간헐적 발생.

작업 체크리스트: [ToDo.md §7](ToDo.md). 상세 기획: [docs/MELOMING_SONGBOOK_INTEGRATION.md](docs/MELOMING_SONGBOOK_INTEGRATION.md).

---

## 🏗️ 기술 아키텍처 (Layer Structure)

시스템은 제로-카피(Zero-copy) 데이터 전달을 목표로 하는 5계층 구조로 설계되었습니다.

| 레이어        | 명칭             | 기술 구성 및 역할                                                      |
| :------------ | :--------------- | :--------------------------------------------------------------------- |
| **Layer 3**   | **UI Layer**     | JavaScript/UI 컴포넌트 기반 퍼포머 대시보드. Tauri Event API 연동.     |
| **Layer 2**   | **IPC Layer**    | Tauri 커맨드 핸들러. Rust 기반 비동기 스트리밍 설계. (예정: `meloming` OpenAPI 클라이언트) |
| **Layer 1.5** | **AI Inference** | **ONNX Runtime Engine**. BS-RoFormer/MDX 모델 기반 음원 분리.          |
| **Layer 1**   | **Audio Engine** | **audio_player.rs (Modularized Engine)**. Rodio 0.22 기반 저수준 제어. |
| **Layer 0**   | **DSP Engine**   | **signalsmith-stretch 0.1.3**. 실시간 샘플 도메인 오디오 변환.         |

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

- **Windows 10/11** (릴리스·개발 타깃은 Windows 전용입니다)
- [Rust](https://www.rust-lang.org/tools/install) (rustup + stable toolchain)
- [Node.js](https://nodejs.org/) (LTS, v18+)
- [LLVM](https://releases.llvm.org/) 또는 `winget install LLVM.LLVM` — `signalsmith-stretch` 빌드 시 **libclang** 필요 (`LIBCLANG_PATH` → `...\LLVM\bin`)
- [C++ Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) — 네이티브 크레이트 및 Tauri 빌드용 (**「C++를 사용한 데스크톱 개발」** 워크로드 권장)

### 프로젝트 시작

```bash
# 의존성 설치
npm install

# Rust 크레이트 미리 받기 (선택)
cd src-tauri && cargo fetch && cd ..

# Tauri 개발 모드 실행
npm run tauri dev
```

**Windows PowerShell 참고**

- `npm`이 인식되지 않으면: 터미널을 새로 열거나 `npm.cmd` 사용
- `npm.ps1` 실행 정책 오류 시: `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` 또는 `npm.cmd run tauri dev`
- MR/AI 캐시 데이터: `%LOCALAPPDATA%\com.autumncolor77.live-mr-manager\`

### 멜로밍 OAuth (개발·릴리스)

| 환경 | Client ID | Client Secret |
|------|-----------|---------------|
| 로컬 개발 | `src-tauri/.env`의 `MELOMING_CLIENT_ID` (`.env.example` 참고) | 선택. 있으면 멜로밍 직접 교환, 없으면 Companion |
| 릴리스 빌드 | GitHub Actions secret `MELOMING_CLIENT_ID` → 바이너리 임베드 | **넣지 않음** — Vercel Production env만 |
| Companion (Vercel) | `MELOMING_CLIENT_ID` | `MELOMING_CLIENT_SECRET` (Production) |

Redirect URI: `https://lmrm.vercel.app/oauth/callback`

---

## 📄 라이선스 및 협약

- **프로젝트 코드**: [MIT License](LICENSE) — Copyright (c) 2026 AutumnColor77
- **제3자 구성요소·런타임 도구·AI 모델**: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)
- **AI 모델 채택 기준** (상업 방송 사용자 허용 목표): [docs/MODEL_LICENSING.md](docs/MODEL_LICENSING.md)
- **릴리스 라이선스 준수 체크리스트**: [docs/LICENSE_COMPLIANCE_CHECKLIST.md](docs/LICENSE_COMPLIANCE_CHECKLIST.md)
- **알림·경고 문구 목록** (톤앤매너 정리용): [docs/NOTIFICATION_MESSAGES.md](docs/NOTIFICATION_MESSAGES.md)
- **기여**: [CONTRIBUTING.md](CONTRIBUTING.md) — PR 제출 시 MIT로 기여하는 것에 동의

### 요약

| 구분 | 상태 |
| --- | --- |
| 앱 소스·Companion 웹 코드 | MIT |
| ONNX Runtime, Signalsmith 등 | 각 구성요소 라이선스 (대부분 MIT/Apache-2.0) |
| FFmpeg (BtbN LGPL), yt-dlp.exe | 원 배포처에서 실행 시 별도 다운로드 · LGPL-2.1-or-later / GPLv3+ 고지 |
| 기본 MR 모델 (Kim Vocal 2, Inst HQ 3) | UVR 생태계 · **잠정 MIT + 필수 크레딧** ([상세](docs/MODEL_LICENSING.md)) |

Companion 이용약관·개인정보 처리방침은 서비스 운영 문서이며, MIT가 부여한 소프트웨어 사용·재배포 권리를 축소하지 않습니다.
→ [이용약관](https://lmrm.vercel.app/terms) · [개인정보 처리방침](https://lmrm.vercel.app/privacy)

### UVR 크레딧

기본 분리 모델은 [Ultimate Vocal Remover](https://github.com/Anjok07/ultimatevocalremovergui) 생태계 가중치를 사용합니다.
크레딧: Anjok07, aufr33 및 UVR 기여자.

### 감사 · 기여자

- **[Temmis2077](https://github.com/Temmis2077)** ([Live-MR-Manager-Mod](https://github.com/Temmis2077/Live-MR-Manager-Mod)): 가사 정렬·커스텀 모델·싱크 UX 등 아이디어와 참고 구현. 본 저장소에는 선별 반영·재구현했으며, 공식 카탈로그에서 제외한 항목(예: CC-BY-NC 분리 모델)은 [`docs/MODEL_LICENSING.md`](docs/MODEL_LICENSING.md)를 참고하세요.
