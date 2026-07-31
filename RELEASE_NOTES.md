# Release Notes

## Unreleased (다음 정식 릴리스 v0.5.2+ 예정, 2026-07-31)

앱 버전 번호는 아직 올리지 않았습니다. 아래는 개발 브랜치에 들어간 변경입니다.

**참고 기여**: [Temmis2077](https://github.com/Temmis2077)의 [Live-MR-Manager-Mod](https://github.com/Temmis2077/Live-MR-Manager-Mod) PR/포크에서 정렬·커스텀 모델·싱크 UX 아이디어를 선별 반영했습니다(거부 항목·라이선스 정책은 [`docs/MODEL_LICENSING.md`](docs/MODEL_LICENSING.md)).

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
- **BPM 그리드 배치**: 라이브러리에 BPM이 있으면 분석 단계를 건너뛰고 즉시 배치.
- **AI 자동 정렬** UI: 싱크 조작 박스 아래 전용 패널, 싱크 맞추기와 같은 버튼 톤, **정렬 언어 드롭다운**(설정과 연동).
- 마커 버튼(보컬 시작~BPM 그리드) 4등분 그리드 정렬.
- 미싱크 배지·상태 색: 밝은 테마에서 진한 앰버 등 테마별 경고/완료 토큰.
- 싱크 초기화 확인을 커스텀 모달로 통일(브라우저 `confirm` 제거). 확인 모달 X 닫기·소형 레이아웃.

### 설정·오버레이 UX

- 설정 카드 레이아웃을 기존 톤앤매너에 맞춤(스택 카드, 인라인 경로/버튼, 설명문 말줄임 완화).
- MR 캐시 경로: 현재 경로 표시·버튼 폭/배치 정리, 재시작 안내 문구 단순화.
- AI/정렬/오버레이 등 설명에서 불필요 기술 용어 정리.

### 라이브러리 · 노래 추가 UX

- **노래 추가 모달**: 사이드바 유튜브/내 파일/멜로밍 탭을 제거하고, **미디어** 그룹은 **라이브러리**만 유지합니다. 라이브러리 아래 **노래 추가** CTA로 URL·로컬 파일을 한 모달에서 등록합니다.
- 모달: 유튜브 URL / 로컬 파일 탭 → 메타(제목·아티스트) 확인 → (선택) **추가 후 MR 분리**. 드래그 앤 드롭도 같은 모달을 엽니다.
- 라이브러리 헤더 **소스 칩**(전체/유튜브/내 파일), 필터 순서(최근 추가순 ↔ 가사 상태), 선택 모드 버튼 높이·노래 추가 버튼 톤을 주변 UI에 맞춤.
- 멜로밍 연동 곡 보기는 사이드바 탭 대신 설정 **가져오기/보내기**·헤더 로그인으로 유지합니다(멜로밍 네비 제거).

### 가사 싱크 · AI 작업 (Temmis2077 포크 선별 반영)

- 싱크 단축키·플레이헤드 따라가기·마커 패널·보컬 시작 제안, 트랙 모달 접기/검색 디바운스.
- AI 프로세싱: 분리/정렬 섹션 접기, 대기열 비우기, 라이브러리 **선택 모드**로 일괄 AI 정렬.
- 정렬 언어 **랩(rap)**: ko+en 이중 패스 후 병합, 큐 진행률 `1/2`.
- 오버레이 가사 글자 크기, 메타데이터 **가사 링크**, 독 `⋯` 메뉴(편집·MR 분리·가사 싱크), 전역 Space 재생/일시정지.
- 분리 방식 「다음부터 바로 분리」 시 매번 묻기 끔, 오버레이 다줄 가로 레이아웃·MR 캐시 포맷 영속화·모델 초기화 타임아웃 등 안정화.

### 문서

- 알림·경고·확인 문구 목록: [docs/NOTIFICATION_MESSAGES.md](docs/NOTIFICATION_MESSAGES.md)
- ToDo: 유튜브 노래 검색 추가(미구현) 항목 등록
- 사용자 매뉴얼: 노래 추가 모달·소스 칩 반영 ([UserManual.md](UserManual.md) §2)

### 릴리스 준수 체크리스트 (배포 전)

- [ ] GitHub가 저장소 라이선스를 MIT로 표시하는지 확인
- [ ] 설치 파일에 ffmpeg.exe / yt-dlp.exe / `.onnx`가 **포함되지 않음** (런타임 다운로드만)
- [ ] RELEASE 본문 또는 앱 내 링크에 THIRD_PARTY_NOTICES·UVR 크레딧 안내
- [ ] FFmpeg 고정 자산 SHA-256 일치, 외부 도구 재호스팅·설치 패키지 번들 없음
- [ ] Companion `/terms` 배포가 갱신된 약관을 반영
- [ ] NC 모델(Deux 등)을 공식 추천/Release 자산에 올리지 않음
- [ ] 커스텀 모델 URL: HTTPS·SHA-256·용량 상한이 릴리스 빌드에서도 동작

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
