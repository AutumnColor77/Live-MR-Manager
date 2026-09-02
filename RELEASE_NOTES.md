# Release Notes

## v0.7.7 (2026-09-02)

사이드바·오버레이·Songbook·재생 UX 개선과 **데스크톱 보안 강화** 묶음입니다. 기준: v0.7.6.

### 보안

- **비신뢰 HTML 차단**: 라이브러리 카드·토스트·메타 검색·필터 드롭다운에 `escapeHtml`/`textContent`를 적용해 유튜브 제목·시청자 신청곡이 DOM에 삽입되지 않습니다.
- **IPC 경로·URL**: `read_audio_file`은 오디오 파일만, `play_track` HTTP는 YouTube 호스트만 허용합니다.
- **오버레이 썸네일**: 앱 데이터 루트의 이미지(매직 바이트)만 data URI로 읽어 브로드캐스트합니다.
- **Songbook OAuth**: 딥링크는 일회용 `code`만 받고 `POST /api/auth/desktop-exchange`로 세션을 교환합니다. 로그에서 `code`/`token`을 마스킹하고, 로그인 시작 시 nonce(`state`)를 발급해 콜백을 검증합니다.
- **공급망**: 관리형 yt-dlp를 GitHub `2026.08.19` + SHA-256으로 고정. TLS 인증서 검증 생략(`--no-check-certificates`)과 Edge 쿠키 자동 재시도를 제거. 내장 UVR 모델도 SHA-256 검증.
- **커스텀 모델 URL**: 사설망/루프백 호스트 차단, HTTPS 리다이렉트만 허용.
- **asset 프로토콜**: `$HOME/**` 전역 스코프를 제거하고 `$HOME/Music/**`만 유지합니다.

### 라이브러리 UI

- **사이드바 접힘 시 그리드 열 수**: 라이브러리 영역 `container query`로 전환해, 사이드바를 접어도 카드/그리드 열 수가 실제 가용 너비에 맞게 유지됩니다.

### Songbook

- **로그인 버튼**: 「로그인됨」 대신 **프로필 사진·닉네임**(또는 채널명) 표시. OAuth 직후 `/api/auth/me` 재조회로 프로필 반영.
- **보내기 속도**: 곡별 순차 HTTP + 40ms throttle 제거, 동시 5건 병렬 처리. 썸네일은 PATCH/POST 시점에만 인코딩(세션 캐시).
- **플레이스홀더 재생**: `songbook:song:*` 경로 곡 재생 시 `originalUrl`·`karaoke_url` 등 추가 필드·scheme-less URL 인식, 서버 재조회 후 유튜브 URL로 승격.

### OBS 오버레이

- **미리보기 중앙 배치**: 점선 미리보기 영역 정중앙에 카드가 오도록 iframe·캔버스 정렬 통일(곡 정보·가사·대기열).
- **등장 애니메이션 미리보기**: 「현재 곡 정보」탭에서 방향 드롭다운 변경 시 등장 애니메이션 즉시 재생.
- **가사 탭 애니메이션**: 곡 정보와 동일한 이동 거리·속도·easing(`0.62s`)으로 통일.

### 곡 정보·기타

- **곡 정보 수정 모달**: 창 높이가 줄어들면 본문만 스크롤, 헤더·하단 버튼 고정.
- **앱 시작 업데이트 알림**: 8초 지연 제거, DOM 준비 후 즉시 `peek_app_update`로 토스트 표시.

---

## v0.7.6 (2026-08-29)

OBS 오버레이 릴리즈 연결/상시보기 오류 수정 및 AI 가사 정렬 대기열 UI/UX 개선 릴리즈입니다. 기준: v0.7.5.

### OBS 오버레이

- **상시보기 토글 및 노출 버그 수정**:
  - [상시 표시] 토글이 꺼져있을 때 음악이 멈추면 앱 내 미리보기와 실제 OBS 방송 화면 모두에서 오버레이가 완전히 투명하게 사라지도록 수정했습니다.
  - 미리보기 CSS의 불필요한 강제 노출 속성을 제거하여 가사 오버레이에서 빈 회색 박스만 노출되던 문제를 해결했습니다.
  - 곡 정보, 가사, 대기열 탭 간 상시보기 스위치가 양방향으로 즉시 동기화되도록 연동했습니다.
  - 가사 탭 전환 시 더미 텍스트가 백엔드로 브로드캐스트되어 OBS 화면에 가사가 영구 노출되던 현상을 제거했습니다.
- **릴리즈 환경 연결 거부(Connection Refused) 오류 수정**:
  - Tauri CSP 보안 정책의 `frame-ancestors`를 `'self'`로 변경하여 앱 내부의 오버레이 미리보기 iframe 로드가 차단되던 문제를 해결했습니다.
  - CSP `connect-src`에 `ws://localhost:* ws://127.0.0.1:*` 및 웹폰트/CSS CDN 도메인을 명시적으로 허용했습니다.
  - 릴리즈 빌드 환경(`tauri.localhost`)에서 WebSocket 연결 대상 호스트를 `127.0.0.1`로 정상 보정하도록 개선했습니다.

### AI 가사 정렬 대기열

- **대기열 카드 UI 정리**:
  - AI 가사 정렬 대기열 카드의 취소 버튼 위에 렌더링되던 불필요한 빈 네모 상자(프로바이더 배지)를 제거했습니다.
  - 취소 버튼의 하단 정렬선을 썸네일 이미지 및 진행률 텍스트와 동일한 수평 기준선에 맞춰 정렬했습니다.
- **정렬 완료 시 대기열 자동 삭제**:
  - 가사 정렬 작업이 성공적으로 완료되면 게이지가 100%로 꽉 찬 상태를 표시한 후, 대기열 목록에서 해당 항목이 자동으로 삭제되도록 개선했습니다.
  - 정렬 완료 시 라이브러리 가사 싱크 배지 및 완료 토스트 알림이 즉시 갱신됩니다.

---

## v0.7.5 (2026-08-23)

Opus/WebM 등 미지원 오디오 코덱에 대한 FFmpeg Fallback 파이프라인 구축 및 유튜브 재생·분리 안정성 강화 릴리즈입니다. 기준: v0.7.4.

### 오디오 엔진 & 미지원 코덱 Fallback

- **FFmpeg 직접 디코딩 Fallback (`decode_to_pcm_f32`)**:
  - 네이티브 디코더(`Symphonia`)가 지원하지 않는 `Opus`, `WebM`, `특수 AAC` 등의 음원을 AI MR 분리 시 FFmpeg 파이프를 통해 f32 PCM으로 즉시 로드하여 `unsupported codec` 오류 없이 정상 분리합니다.
- **라이브러리 재생 Fallback (`transcode_to_wav_fallback`)**:
  - 미지원 코덱 파일 재생 시 백그라운드에서 표준 16비트 PCM WAV 캐시를 생성하여 Rodio 플레이어 엔진(피치 조절, 템포 조절, 볼륨 제어, 시크)의 모든 기능을 동일하게 지원합니다.
- **오디오 메타데이터 Duration Fallback**:
  - Symphonia/Rodio로 길이를 파싱할 수 없는 특수 오디오 포맷도 FFmpeg를 통해 정확한 재생 시간을 추출합니다.

### YouTube 재생 및 포맷 셀렉터 개선

- **AAC 스트림 우선순위 강화**:
  - `ba[ext=m4a]/ba[acodec^=mp4a]/140` 형식을 최우선 요청하도록 개선하여 호환성 높은 스트림을 우선 확보합니다.
- **Fallback 클라이언트**:
  - YouTube 추출 차단 발생 시 fallback player client로 재시도합니다. (이후 v0.7.7에서 Edge 쿠키 자동 재시도는 제거)

---

## v0.7.4 (2026-08-19)

유튜브 재생 안정화와 Songbook·가사·오버레이 UX를 묶은 릴리즈입니다. 기준: v0.7.3.

### 유튜브 재생

- **불완전 캐시 재사용 금지**: 타임아웃·실패로 남은 `yt_*.m4a`를 다음 재생에 쓰지 않고 다시 받습니다. 캐시 파일명은 URL 영상 ID 기준이라 `yt_unknown.m4a` 충돌이 없습니다.
- **스트리밍 대기**: 파일이 있기만 하면 성공으로 치지 않고, 최소 크기(8KB)와 다운로드 오류를 확인합니다. 디코딩 실패 시 캐시를 지우고 한 번 재시도합니다.
- **yt-dlp 갱신**: 당시 관리형 `yt-dlp.exe`가 7일이 지났으면 GitHub latest로 다시 받았습니다. **v0.7.7부터는 릴리스 태그+SHA-256 고정**으로 바뀌었습니다. 포맷 없음/nsig/403 류 실패 시 세션당 한 번 강제 갱신 후 재시도합니다.
- **타임아웃**: 유튜브 재생 대기는 90초(로컬 30초 유지). 시간 초과 뒤에는 늦게 도착한 재생 이벤트가 UI를 덮지 않습니다.
- **알림**: 같은 실패로 토스트가 두 번 뜨지 않습니다. 사용자에게는 짧은 한국어 안내(시간 초과 / 도구 실행 실패 / 유튜브가 오디오를 막음 / 파일 손상)만 보이고, yt-dlp 원문은 앱 로그에 남습니다.

### 유튜브 검색

- **미리듣기**: 결과 행에서 스트림만 재생(파일 미저장). 독 마스터 볼륨을 따르고, 본 재생 중이면 일시정지합니다. 탭을 떠나거나 독에서 재생하면 미리듣기를 멈춥니다.
- **검색 오류**: IPC로 결과를 넘기지 못할 때 원인을 숨기지 않고 안내합니다.

### Songbook · 신청목록

- **계정 메뉴**: 닉네임 → **운영페이지**(`/c/{채널}/admin`) · **노래책페이지**(`/c/{채널}`) · **로그아웃**.
- **라이브러리 → 신청목록**: 우클릭·선택 모드에서 곡을 신청 대기열에 넣습니다. 곡은 노래책에 있어야 합니다(**보내기**).
- **동기화 버튼**: 작업 중 아이콘이 회전합니다. 설정 설명은 보내기(앱→웹)·가져오기(웹→앱)만 남깁니다.
- **가져오기(Pull)** · **웹 Admin 재생 → 앱**: v0.7.3 이후 포함된 연동을 이 릴리즈에 넣습니다.

### 가사 드로어 · 싱크

- **가사 싱크 등록하러 가기**: 방금 고른 곡(가사보기·라이브러리 선택)을 엽니다. 이전에 재생 중이던 곡으로 덮이지 않습니다.
- 좁은 드로어에서 CTA는 두 줄, 안내 문구는 단어 중간에서 잘리지 않습니다.

### OBS 오버레이

- 설정 화면을 **미리보기 | 설정** 2열로 나누고, 창이 좁으면 세로로 쌓입니다.

### v0.7.3 이후 포함

- 릴리즈 NSIS 빌드 성공 후에만 Discord `#공지` webhook.
- Tauri·공급망·CI 보안 보강(CVE 패치, 라이선스 정책, ORT 단위 테스트 분리).

### 문서

- [docs/NOTIFICATION_MESSAGES.md](docs/NOTIFICATION_MESSAGES.md) 미리듣기·신청목록 추가·유튜브 검색 문구
- [UserManual.md](UserManual.md) · [README.md](README.md) · [docs/SONGBOOK_INTEGRATION.md](docs/SONGBOOK_INTEGRATION.md)

---

## v0.7.3 (2026-08-07)

Windows 신규 설치 환경에서 Visual C++ 런타임 누락으로 앱이 안 뜨던 문제를 설치 단계에서 막는 핫픽스입니다. 기준: v0.7.2.

- **VC++ Redistributable 자동 설치**: NSIS 설치 시 x64 런타임이 없으면 `vc_redist.x64.exe`를 함께 설치합니다 (`MSVCP140_1.dll` / `VCRUNTIME140_1.dll` 오류 방지).
- **빌드 전 확보**: `beforeBuildCommand` + CI에서 `scripts/ensure-vcredist.ps1`로 redist를 받아 `bundle.resources` 검증 전에 준비합니다.

---

## v0.7.2 (2026-08-07)

Songbook 로그인 UX·업데이트 링크 핫픽스입니다. 기준: v0.7.1.

- **헤더 계정 메뉴**: 로그인 후 닉네임 클릭 시 **노래책** / **로그아웃** (즉시 로그아웃 제거).
- **신청목록 게이트**: Google/네이버 브랜드 버튼으로 바로 로그인 (상단 메뉴 연동 버그 수정).
- **업데이트 다운로드**: Windows에서 릴리즈 페이지가 `\\` 오류로 안 열리던 문제 수정 (`open_app_update_page` → opener).

---

## v0.7.1 (2026-08-06)

Songbook 프로덕션 URL 핫픽스입니다. 기준: v0.7.0.

- **Songbook 기본 URL**: `https://www.livemrsongbook.com`으로 변경 (`companion-links.js` `SONGBOOK_PROD`).
- 이전 Workers 주소(`*.workers.dev`) 대신 커스텀 도메인으로 로그인·동기화·신청목록 API를 호출합니다.
- 문서([UserManual.md](UserManual.md)·[README.md](README.md)) 링크를 동일 도메인으로 갱신.

> Google OAuth `redirect_uri_mismatch`는 앱 URL뿐 아니라 **Google Cloud Console**에 새 도메인 콜백 URI 등록이 필요합니다.

---

## v0.7.0 (2026-08-06)

Live MR Songbook 연동(로그인·보내기·신청목록·대기열 오버레이)과 후원금액 메타를 포함한 마이너 릴리즈입니다. 기준: v0.6.1.

### Live MR Songbook 연동

- **로그인**: Google/네이버, 웹 세션 재사용(`desktop-connect`), 헤더 프로필 아바타.
- **라이브러리 보내기(Push)**: 헤더 **동기화** 또는 **설정 → Songbook 동기화 → 보내기**. 본인 채널만(공유 `demo` 제외). 채널 없으면 생성.
- **메타 동기화**: 새 곡 `POST`, 같은 제목·아티스트 `PATCH`(카테고리·태그·KEY/BPM·썸네일·후원금액 등).
- **Push 삭제 정합**: 앱에 없는 원격 곡은 `enabled: false`로 웹 노래책에서 숨김(신청 이력 FK 보존). 토스트 **제거 N**.
- **썸네일**: 업로드 전 최대 96px JPEG data URL 축소. 음원 파일은 올리지 않음.
- **세션**: 로그아웃 시 서버 세션 정리, 401 시 재로그인 유도.
- **기본 URL**: 당시 프로덕션 Workers (`*.workers.dev`). v0.7.1에서 [livemrsongbook.com](https://www.livemrsongbook.com)으로 변경. 로컬은 `localStorage.songbook_base`.

### 신청목록 · 재생 큐 · 대기열 오버레이

- **신청목록** 탭: 대기열 운영(접수 on/off, 재생·완료·거절, 중복 신청 정책, 비우기, 토스트·사이드바 배지).
- **대기열 드래그 순서**: Sortable → Songbook `sort_order`/`/queue/reorder`. 앱·웹·시청자·OBS 동일 순서.
- **재생 큐**: 로컬 매칭 곡만 적재. 신청목록에서 수동 재생, 독 다음/이전이 신청 큐 우선.
- **OBS 대기열 오버레이**: `http://localhost:14202/queue` (권장 **1500×1000**). 등장·늘어나는 방향(위/양쪽/아래). 곡 정보·가사 권장 가로 **1500** 통일.

### 메타데이터 · UX

- **후원금액(원)**: 곡 정보 편집·스프레드시트·Songbook Push 연동.
- **가사 드로어 CTA**: 정렬 가사 없을 때 「가사 싱크 등록하러 가기」→ 가사 싱크 탭·현재 곡 로드.
- **홍보 데모 모드(내부)**: 검색란 `#promo`로 세션 전용 데모 목록.

### 문서 · Companion

- [UserManual.md](UserManual.md) Songbook·신청목록·오버레이·후원금액
- [ToDo.md](ToDo.md) · [README.md](README.md) · [DISCORD_ANNOUNCEMENTS.md](DISCORD_ANNOUNCEMENTS.md)
- [docs/NOTIFICATION_MESSAGES.md](docs/NOTIFICATION_MESSAGES.md) 신청목록·동기화 토스트
- Companion 다운로드/FAQ에 Songbook·유튜브 검색 안내 보강

---

## v0.6.1 (2026-08-04)

### 유튜브 검색 (하이브리드)

- 사이드바 **미디어 → 유튜브 검색** 페이지를 추가했습니다. 제목·아티스트 키워드로 YouTube를 검색(yt-dlp `ytsearch`)하고 결과에서 라이브러리에 추가합니다.
- **노래 추가** 모달은 기존처럼 **유튜브 URL / 로컬 파일**만 담당합니다 (하이브리드 UX).
- 검색 결과 추가 시 video ID 중복 차단, (선택) **추가 후 MR 분리**를 지원합니다.
- 검색바·결과 목록은 라이브러리와 동일한 `page-controls-wrapper`·30px safe-area 프레임에 맞췄습니다.

### OBS 오버레이 UX

- **상시 표시 (미리보기)** 토글 칩 배경·테두리를 하드코딩된 파란색에서 테마 `--accent-rgb`로 바꿔, 미드나잇/아이보리/분홍/하늘 테마에 맞게 표시됩니다.

### 문서

- [UserManual.md](UserManual.md) §2에 유튜브 검색·노래 추가 하이브리드 안내
- [ToDo.md](ToDo.md) 「유튜브 노래 검색 추가」 완료 처리
- [docs/NOTIFICATION_MESSAGES.md](docs/NOTIFICATION_MESSAGES.md) 검색·추가 토스트/백엔드 문구 보강

---

## v0.6.0 (2026-08-01)

큰 기능 업데이트와 **멜로밍 연동 제거**. Companion는 다운로드·FAQ·약관용으로 유지합니다.

**참고 기여**: [Temmis2077](https://github.com/Temmis2077)의 [Live-MR-Manager-Mod](https://github.com/Temmis2077/Live-MR-Manager-Mod) PR/포크에서 정렬·커스텀 모델·싱크 UX 아이디어를 선별 반영했습니다(거부 항목·라이선스 정책은 [`docs/MODEL_LICENSING.md`](docs/MODEL_LICENSING.md)).

### 멜로밍 연동 제거

- 앱·Companion에서 멜로밍 OAuth·노래책 가져오기/보내기·deep-link 스킴을 제거했습니다.
- 라이브러리 로드 시 `source === "meloming"` 또는 `path`가 `meloming:song:`로 시작하는 **멜로밍 전용 곡**을 일괄 삭제하고, N>0일 때 토스트로 안내합니다. (유튜브/로컬 곡에만 붙었던 연동 ID는 삭제하지 않습니다.)
- DB의 `meloming_*` 컬럼·Map 테이블은 DROP하지 않고 inert로 둡니다.
- 수동 체크리스트: Vercel `MELOMING_*` secret 삭제, GitHub `MELOMING_CLIENT_ID` 삭제, 멜로밍 개발자 센터 Redirect URI 정리.

### 라이선스·고지 (docs, 2026-07-29~)

- 루트 [LICENSE](LICENSE) (MIT) 복원 · `package.json` / `Cargo.toml` / Companion `package.json`에 `license: MIT` 선언
- [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) — 링크·런타임 다운로드(FFmpeg LGPL, yt-dlp.exe GPLv3+)·AI 모델 구분
- FFmpeg를 BtbN 월말 LGPL 고정 빌드로 전환하고 SHA-256 검증 추가 (`libmp3lame` 320kbps·yt-dlp 병합 확인)
- [docs/MODEL_LICENSING.md](docs/MODEL_LICENSING.md) — 상업 방송 허용 목표, UVR 잠정 MIT+크레딧, PR#1 Apache 정렬 OK / CC-BY-NC Deux 공식 제외
- Companion 이용약관: MIT 소프트웨어 권리를 축소하지 않도록 범위 정리 (시행일 2026-07-29)
- 설정 > 법적 고지: MIT·제3자 고지 링크 추가
- 릴리스 준수: [docs/LICENSE_COMPLIANCE_CHECKLIST.md](docs/LICENSE_COMPLIANCE_CHECKLIST.md)

### 커스텀 분리 모델 URL 등록

- 로컬 파일뿐 아니라 **HTTPS URL**로 ONNX 커스텀 모델을 등록할 수 있습니다.
- 보안: HTTPS만 허용, 용량 상한(2 GiB), **스트리밍 SHA-256** 검증, 검증 후 원자적 설치, 진행률 이벤트.
- 모델 라이선스·사용 권리는 이용자 확인 책임(공식 보증 없음). 상세: [docs/MODEL_LICENSING.md](docs/MODEL_LICENSING.md) §2.

### 가사 싱크 (Lyric Sync)

- **원문/차음/번역 3줄 모드**: 3줄을 한 싱크 단위로 묶어 `[orig]`/`[pron]`/`[tran]` LRC로 저장(태그 없는 기존 파일 호환).
- **BPM 그리드 배치**: 기능은 유지하되 싱크 화면 버튼을 숨겼습니다(`#bpm-grid-btn` `hidden`). 노출 시 라이브러리 BPM이 있으면 분석 단계를 건너뜁니다.
- **AI 자동 정렬** UI: 싱크 조작 박스 아래 전용 패널, 싱크 맞추기와 같은 버튼 톤, **정렬 언어 드롭다운**(설정과 연동).
- 마커 버튼(보컬 시작·간주 시작·간주 종료) 3등분 그리드 정렬.
- 미싱크 배지·상태 색: 밝은 테마에서 진한 앰버 등 테마별 경고/완료 토큰.
- 싱크 초기화 확인을 커스텀 모달로 통일(브라우저 `confirm` 제거). 확인 모달 X 닫기·소형 레이아웃.

### 설정·오버레이 UX

- 설정 카드 레이아웃을 기존 톤앤매너에 맞춤(스택 카드, 인라인 경로/버튼, 설명문 말줄임 완화).
- MR 캐시 경로: 현재 경로 표시·버튼 폭/배치 정리, 재시작 안내 문구 단순화.
- AI/정렬/오버레이 등 설명에서 불필요 기술 용어 정리.

### 라이브러리 · 노래 추가 UX

- **노래 추가 모달**: 사이드바 유튜브/내 파일 탭을 제거하고, **미디어** 그룹은 **라이브러리**만 유지합니다. 라이브러리 아래 **노래 추가** CTA로 URL·로컬 파일을 한 모달에서 등록합니다.
- 모달: 유튜브 URL / 로컬 파일 탭 → 메타(제목·아티스트) 확인 → (선택) **추가 후 MR 분리**. 드래그 앤 드롭도 같은 모달을 엽니다.
- 라이브러리 헤더 **소스 칩**(전체/유튜브/내 파일), 필터 순서(최근 추가순 ↔ 가사 상태), 선택 모드 버튼 높이·노래 추가 버튼 톤을 주변 UI에 맞춤.

### 가사 싱크 · AI 작업 (Temmis2077 포크 선별 반영)

- 싱크 단축키·플레이헤드 따라가기·마커 패널·보컬 시작 제안, 트랙 모달 접기/검색 디바운스.
- AI 프로세싱: 분리/정렬 섹션 접기, 대기열 비우기, 라이브러리 **선택 모드**로 일괄 AI 정렬.
- 정렬 언어 **랩(rap)**: ko+en 이중 패스 후 병합, 큐 진행률 `1/2`.
- 오버레이 가사 글자 크기, 메타데이터 **가사 링크**, 독 `⋯` 메뉴(편집·MR 분리·가사 싱크), 전역 Space 재생/일시정지.
- 분리 방식 「다음부터 바로 분리」 시 매번 묻기 끔, 오버레이 다줄 가로 레이아웃·MR 캐시 포맷 영속화·모델 초기화 타임아웃 등 안정화.

### 문서

- 알림·경고·확인 문구 목록: [docs/NOTIFICATION_MESSAGES.md](docs/NOTIFICATION_MESSAGES.md)
- ToDo: 유튜브 노래 검색 추가 항목 등록(이후 v0.6.1에서 구현 완료)
- 사용자 매뉴얼: 노래 추가 모달·소스 칩 반영 ([UserManual.md](UserManual.md) §2)

### 릴리스 준수 체크리스트 (배포 전)

- [ ] GitHub가 저장소 라이선스를 MIT로 표시하는지 확인
- [ ] 설치 파일에 ffmpeg.exe / yt-dlp.exe / `.onnx`가 **포함되지 않음** (런타임 다운로드만)
- [ ] RELEASE 본문 또는 앱 내 링크에 THIRD_PARTY_NOTICES·UVR 크레딧 안내
- [ ] FFmpeg 고정 자산 SHA-256 일치, 외부 도구 재호스팅·설치 패키지 번들 없음
- [ ] Companion `/terms`·`/privacy` 배포가 갱신된 약관을 반영 (멜로밍 문구 없음)
- [ ] NC 모델(Deux 등)을 공식 추천/Release 자산에 올리지 않음
- [ ] 커스텀 모델 URL: HTTPS·SHA-256·용량 상한이 릴리스 빌드에서도 동작
- [ ] Vercel/GitHub의 `MELOMING_*` secret 삭제(수동)

---

## v0.5.1 (2026-07-13)

멜로밍 OAuth **배포 로그인 핫픽스** — 설치본에서도 Client Secret 없이 로그인 가능.

### 멜로밍 OAuth

- **배포본 Client ID 임베드**: 릴리스 빌드 시 GitHub Actions secret `MELOMING_CLIENT_ID`를 바이너리에 포함합니다. 사용자 PC에 `.env`가 없어도 「멜로밍 로그인」을 시작할 수 있습니다.
- **Secret은 Companion만**: Client Secret은 앱에 넣지 않습니다. Secret이 없으면 토큰 교환·갱신을 Vercel Companion(`POST /api/oauth/exchange`, `POST /api/oauth/refresh`)으로 자동 사용합니다.
- **로컬 개발**: `src-tauri/.env`에 Client ID(+선택 Secret)를 두면 됩니다. Secret이 있으면 멜로밍 직접 교환, 없으면 Companion 경로.

### 메타데이터

- `package.json`, `Cargo.toml`, `tauri.conf.json`, UI 타이틀·매뉴얼·README·ToDo·Discord 공지를 **0.5.1**으로 통일.

---

## v0.5.0 (2026-07-05)

멜로밍 노래책 **가져오기·보내기 재개**, Push 안정화·메타 동기화 고도화, 곡 정보 편집 UI 개선.

### 멜로밍 노래책

- **동기화 재개**: v0.4.15~0.4.16에서 일시 중단했던 Pull/Push를 다시 활성화했습니다.
- **설정 UI 분리**: 「노래책 동기화」 단일 버튼 → **가져오기**(멜로밍 → 앱) / **보내기**(앱 → 멜로밍)로 분리. 보내기는 **멜로밍 로그인** 필요.
- **Push Diff**: 보내기 시작 시 채널 곡 목록을 불러와 `meloming_song_id`·YouTube URL·제목+아티스트로 매칭 후 **PATCH**, 없으면 **POST**. 409 중복 시 PATCH로 전환.
- **메타 전송**: KEY/BPM, 숙련도·난이도(1~5), 로컬 `.lrc` 가사(`lyricsText`). PATCH 시 멜로밍과 동일한 가사는 재전송 생략.
- **아티스트·카테고리 자동 생성**: 보내기 시 없는 아티스트·카테고리를 API로 등록(기본 카테고리 `"기본"`). rate limit 대응(스로틀·재시도).
- **Pull**: 기존 병합·갱신 로직 유지, 숙련도·난이도 필드 반영.

### 곡 정보 편집 UI

- **난이도·숙련도**: 드롭다운 → **별 클릭**(1~5) 선택. KEY/BPM과 같은 2열 그리드 정렬.
- **라벨 통일**: 편집 모달 우측 필드 라벨 스타일·X축 정렬 정리.

### Companion

- **`POST /api/oauth/refresh`**: refresh token으로 access token 갱신 프록시 추가.

### 메타데이터

- `package.json`, `Cargo.toml`, `tauri.conf.json`, UI 타이틀·매뉴얼·README·ToDo·Companion FAQ를 **0.5.0**으로 통일.

---

## v0.4.16 (2026-07-05)

MP3 MR 저장 ffmpeg 탐색 핫픽스 및 멜로밍 노래책 동기화 안내 정리.

### MR · MP3 저장

- **ffmpeg PATH 핫픽스**: MR MP3 저장(`mr_encode`)이 유튜브와 동일한 **관리형 ffmpeg** 경로·자동 다운로드·`where.exe` 탐색을 사용합니다. GUI 앱에서 PATH에 ffmpeg가 없어도 분리 저장이 실패하지 않습니다.
- **앱 시작 시 ffmpeg 준비**: 백그라운드에서 `%LOCALAPPDATA%\LiveMRManager\tools\ffmpeg.exe`를 미리 확보합니다.

### 멜로밍 노래책

- **동기화 UI·백엔드 잠금 유지**: OpenAPI 아티스트·카테고리 등록 API 대기 중 — 설정 카드 설명 정리, 클릭 시 안내 토스트, `pull`/`push` 커맨드 차단.
- **멜로밍 로그인 유지**: 우측 상단 OAuth 로그인은 계속 사용할 수 있습니다.

### 메타데이터

- `package.json`, `Cargo.toml`, `tauri.conf.json`, UI 타이틀·매뉴얼·README·ToDo를 **0.4.16**으로 통일.

---

## v0.4.15 (2026-06-27)

멜로밍 노래책 동기화 UI 일시 중단 — OpenAPI 아티스트·카테고리 등록 API 대기.

### 멜로밍 노래책

- **「노래책 동기화」 업데이트 예정**: 설정 버튼 클릭 시 Push를 실행하지 않고 안내 메시지를 표시합니다. (`MELOMING_SYNC_COMING_SOON`)
- **로그인은 유지**: 우측 상단 **「멜로밍 로그인」**·OAuth는 계속 사용할 수 있습니다.
- **배경**: 멜로밍 [노래책 OpenAPI](https://developers.meloming.com/docs/openapi/reference/songbook)에 아티스트·카테고리 **생성 API가 없어** 로컬 라이브러리와 채널 노래책을 안정적으로 맞출 수 없습니다. Push 코드(v0.4.14)는 유지하며 API 지원 후 잠금 해제 예정.

### 메타데이터

- `package.json`, `Cargo.toml`, `tauri.conf.json`, UI 타이틀·매뉴얼·Companion FAQ를 **0.4.15**로 통일.

---

## v0.4.14 (2026-06-27)

유튜브 메타데이터 자동 보강, 멜로밍 Push 안정화, 설정 법적 고지.

### 라이브러리 · 스프레드시트

- **가져오기 시 유튜브 메타 보강**: CSV/XLSX에 URL만 있어도 썸네일·재생 시간·아티스트를 「정보 가져오기」와 같이 채웁니다. CSV에 명시한 제목·아티스트·재생 시간은 덮어쓰지 않습니다.
- **완료 토스트**: 가져오기 결과에 `유튜브 정보 N곡` 보강 건수를 표시합니다.
- **재생 시 메타 보강**: 최소 정보만 등록된 유튜브 곡 재생 시 백그라운드로 썸네일·길이·아티스트를 채우고 도크·라이브러리 UI를 갱신합니다.

### 멜로밍 노래책

- **Push 전 유튜브 메타 보강**: 썸네일·재생 시간이 비어 있는 URL 곡을 보내기 전에 자동으로 채웁니다.
- **아티스트 느슨 매칭**: 등록명 포함 관계로 Map 매칭 성공률을 높였습니다.
- **채널별 song_id**: 다른 채널의 `meloming_song_id`는 무시합니다.
- **PATCH → CREATE 재시도**: 403/404·PERMISSION_DENIED·NOT_FOUND 시 새 곡으로 등록을 시도합니다.

### UI

- **설정 법적 고지**: 개인정보 처리방침·이용약관 버튼 → Companion `lmrm.vercel.app/privacy`, `/terms`.
- **멜로밍 계정 메뉴**: 헤더·드롭다운 z-index 조정으로 메뉴 가림 현상 수정.

### 메타데이터

- `package.json`, `Cargo.toml`, `tauri.conf.json`, UI 타이틀·매뉴얼을 **0.4.14**로 통일.

---

## v0.4.13 (2026-06-27)

Companion 웹 개인정보 처리방침 및 버전 메타데이터 정리.

### Companion (lmrm.vercel.app)

- **`/privacy` 개인정보 처리방침**: 데스크톱 앱·Companion 웹 통합 안내(멜로밍 OAuth scope, 쿠키, Last.fm·제3자 연동, 시행일 2026-06-27).
- **`/terms` 이용약관**: 베타 면책, 멜로밍 연동·저작권·이용자 의무, 준거법(대한민국).
- **푸터·FAQ**: 「개인정보 처리방침」「이용약관」 링크 및 안전·개인정보 FAQ에서 처리방침 페이지 연결.

### 메타데이터

- `package.json`, `Cargo.toml`, `tauri.conf.json`, UI 타이틀·매뉴얼을 **0.4.13**으로 통일.

---

## v0.4.12 (2026-06-10)

설정 UI 정리 및 MP3 저장 시 콘솔 창 노출 수정.

### UI

- **설정 버튼 너비 통일**: 멜로밍·백업 등 설정 카드 액션 버튼을 150px로 맞춤.
- **MR 저장 형식**: 드롭다운 열 250px, 긴 옵션 텍스트 줄바꿈 방지.

### 안정성

- **MP3 MR 저장**: ffmpeg 실행 시 `CREATE_NO_WINDOW` 적용 — 변환 중 CMD 창이 뜨지 않음.

---

## v0.4.11 (2026-06-09, 개발 빌드)

멜로밍 연동·UI 안정화 및 companion OAuth 확장. **공식 릴리즈 전** 기능 일부는 「개발 중」으로 잠금.

### 멜로밍 노래책

- **다중 플랫폼 채널 주소**: 설정에서 **치지직 · SOOP(숲) · 씨미(CIME)** URL·핸들·멜로밍 webPath·숫자 채널 ID로 노래책 Pull·연결 테스트.
- **OAuth (보류)**: authorize·code 수신·deep-link까지 동작하나 토큰 교환(`POST /oauth/token`)에서 500/401 지속 → **「멜로밍 로그인」·「멜로밍에 보내기」** 클릭 시 「개발 중입니다.」 안내.
- **채널 주소**: 「채널 저장」 시 로컬 DB에만 저장. 배포·신규 설치 시 입력란 비어 있음.

### UI · 안정성

- **곡 정보 저장**: DB 데드락 수정, 저장 후 모달 즉시 닫기·목록만 갱신.
- **타이틀바**: 창 드래그 이동 지원.

### Companion (lmrm.vercel.app)

- `/login`, `/account`, 웹 OAuth API. 콜백: 웹 PKCE 또는 앱 `live-mr-manager://` 분기.

---

## v0.4.10 (2026-06-02)

안정화 패치 및 라이브러리 일괄 편집 워크플로우를 추가한 릴리즈입니다. **Windows용 NSIS 설치 파일**을 제공합니다.

### 라이브러리 · 메타데이터

- **스프레드시트 가져오기/보내기**: 설정에서 라이브러리를 **CSV(UTF-8 BOM)** 또는 **XLSX**로 보내고, 엑셀·구글 시트에서 편집한 목록을 병합 가져오기할 수 있습니다. 한글 헤더(경로·제목·아티스트·장르·카테고리 등)를 인식하며, 동일 `path`는 갱신·신규 경로는 추가합니다.
- **카테고리 필터 정합성**: 실제 곡에 사용 중인 카테고리만 드롭다운에 표시하고, 저장·곡 추가/삭제 후 재시작 없이 목록이 갱신됩니다.
- **카테고리 표시/저장 동기화**: `categories` → `curationCategory` 우선순위로 카드·필터·편집 모달·DB 값이 일치합니다.

### MR · 오디오 분석

- **MR 캐시 경로 통일 (`cache_key_variants`)**: YouTube URL 형식(`youtu.be`, `watch?v=` 등) 차이로 MR 파일·배지·삭제 경로가 어긋나던 문제를 재생 로직과 동일한 변형 키 탐색으로 통일했습니다.
- **MR 배지 신뢰성**: 라이브러리 로드 시 `vocal.wav`/`inst.wav` 존재를 변형 키로 판별하고, 카드 렌더 시 `check_mr_separated`로 재확인해 F5 이후에도 배지가 유지됩니다.
- **KEY/BPM 분석 MR 연동**: MR `inst.wav` 탐색 경로를 배지·재생과 동일하게 맞춰, 분리 완료 후 온라인 곡에서도 MR 기반 분석이 동작합니다.

### 앱 · 배포

- **GitHub 릴리즈 업데이트 알림**: 6시간 간격으로 최신 릴리즈를 확인하고, 새 버전이 있으면 앱 내에서 안내합니다.
- **버전 메타데이터 통일**: `package.json`, `Cargo.toml`, `tauri.conf.json`, UI 타이틀을 `0.4.10`으로 맞췄습니다.
- **CI**: Windows NSIS 빌드만 유지(이번 릴리즈 아티팩트는 Windows 설치 파일).
- **문서**: Windows 개발 환경(LLVM/`cargo fetch`/PowerShell) 가이드 보강, 멜로밍 노래책 연동 기획 문서(`docs/MELOMING_SONGBOOK_INTEGRATION.md`) 추가.

---

## v0.4.9 (2026-04-27)

Windows용 NSIS 설치 파일을 제공합니다.
