# Live MR Manager - Backend Refactoring Plan

## 목적
- 1000라인이 넘는 `lib.rs`를 기능별로 모듈화하여 가독성 및 유지보수성 향상
- 컴파일러 중복 정의 에러(`E0255`)의 근본 원인 해결
- 데이터 복구 로직(`rescue`)의 안정적 통합

## 로드맵 (단계별 진행)

### 1단계: 라이브러리 관리 모듈 분리 (`src-tauri/src/library.rs`)
- **대상:** 곡 정보 조회, 카테고리/태그 관리, DB 트랜잭션 로직
- **주요 함수:** `get_songs`, `get_audio_metadata`, `save_library`, `add_category` 등
- **작업 내용:** `lib.rs`에서 관련 로직을 추출하여 신규 파일로 이동

### 2단계: 오디오 제어 모듈 분리 (`src-tauri/src/audio_commands.rs`)
- **대상:** 플레이어 컨트롤 명령
- **주요 함수:** `play_track`, `stop_playback`, `set_pitch`, `set_tempo`, `set_volume` 등
- **작업 내용:** `Rodio` 핸들러 제어 로직을 별도 모듈화

### 3단계: 시스템 및 백업 모듈 분리 (`src-tauri/src/system.rs`)
- **대상:** 앱 설정 및 유틸리티
- **주요 함수:** `export_backup`, `import_backup`, `get_app_paths`, `open_cache_folder` 등
- **작업 내용:** 기타 시스템 명령들을 한곳에 정리

### 4단계: 복구 로직 통합 및 `lib.rs` 정화
- **대상:** 유실된 데이터 복구 엔진 (`rescue.rs`)
- **작업 내용:**
    - `rescue.rs`를 정식 모듈로 편입
    - `lib.rs`에는 모듈 선언과 `run()` 함수, `generate_handler!`만 남김
    - 모든 명령의 경로를 `library::...`, `audio_commands::...` 등으로 명확히 지정

## 주의 사항
- 각 단계가 끝날 때마다 빌드 성공 여부를 반드시 확인한다.
- 기존의 DB 스키마와 데이터 무결성을 유지한다.
- `main.js`의 `invoke` 호출부와 이름을 일치시킨다.
