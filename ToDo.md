# 🚀 Live MR Manager(Beta) 향후 작업 목록 (ToDo)

프로젝트의 완성도를 높이고 전문적인 MR 관리 도구로 발전시키기 위한 향후 개발 로드맵입니다.

## 📁 1. 라이브러리 및 탐색 (Library Management)

- [X] **태그 시스템**: `#신나는`, `#차분한`, `#높은키` 등 곡별 태그 추가 및 필터링
- [X] **카테고리/플레이리스트**: 사용자 정의 폴더 또는 곡 묶음 기능
- [X] **라이브러리 내 검색**: 곡 제목, 아티스트, 태그 기반 통합 검색바 구현
- [X] **정렬 기능**: 가나다순, 최근 추가순, 재생 횟수순 등 다양한 정렬 모드
- [X] **메타데이터 편집**: 곡 제목 수정, 썸네일 이미지 변경 및 카테고리/태그 연동
- [X] **곡 정보 관리자 (Library Manager)**: 엑셀 스타일의 일괄 편집 도구, 인접 열 연동 리사이징 및 비율 저장 시스템 구축 완료
- [X] **재생 시간 관리**: 유튜브 및 로컬 음원의 정확한 재생 시간 추출 및 영구 저장 연동
- [X] **장르/태그 정제**: 데이터 부재 시 "미분류" 통합 및 온라인 검색 노이즈(Unknown) 필터링 시스템 구축
- [X] **동적 번역 시스템 (Dynamic Translation)**: 백엔드 필터를 통한 장르/태그 실시간 번역 및 사전(Dictionary) 업데이트 즉시 반영 시스템 구축
- [X] **정식 릴리즈**: 실시간 번역 시스템 통합 및 빌드 환경 현대화 완료
- [X] **안정성 패치**: MR 삭제 시 프리징 문제 해결 및 배지 동기화 로직 개선 완료
- [X] **UI 고도화 및 태그 확장**: 오디오 제어 UI 정밀 조정 및 메타데이터 매핑 대거 추가 완료
- [X] **썸네일 로컬 캐싱**: 유튜브 썸네일 차단 문제 해결을 위한 자동 로컬 캐싱 시스템
- [X] **YouTube 등록 UX/중복 방지 (v0.4.7)**: `정보 가져오기` 버튼 로딩 상태/크기 정렬 적용 및 YouTube 영상 ID 기반 중복 등록 차단 로직 반영
- [X] **노래 추가 모달·미디어 네비 정리 (Unreleased)**: 유튜브/내 파일/멜로밍 사이드바 탭 제거, 라이브러리 아래 「노래 추가」 CTA·모달(URL/파일·선택 MR 분리), 소스 필터 칩, DnD→모달
- [X] **카테고리 필터 드롭다운 정합성 (v0.4.10)**: 실제 곡에 사용 중인 카테고리만 노출, 저장·추가·삭제 후 즉시 갱신(`refreshFilterDropdowns`)
- [X] **카테고리 표시/저장 동기화 (v0.4.10)**: `getSongCategory()` 우선순위 정리(`categories` → `curationCategory`), 편집 저장 시 DB·UI 일치
- [ ] **유튜브 노래 검색 추가**: URL 붙여넣기 외에 제목·아티스트로 유튜브를 검색해 결과를 고르고 라이브러리에 넣는 UI (yt-dlp 검색 연동)

## 🔉 2. 오디오 고성능 제어 (Advanced Audio)

- [X] **AI 음원 분리 (AI Audio Separation)**: BS-RoFormer 및 MDX-Net 엔진 통합 완료. 비동기 백그라운드 워커 및 ORT 가속 적용.
- [X] **AI 엔진 성능 최적화**: GPU 활용률 극대화를 위한 **Batch Inference** 및 **Parallel STFT** 프레임워크 구축 완료.
- [X] **오디오 품질 고도화**: RMS 정규화 및 소프트 리미팅 적용으로 클리핑 방지 및 음량 평준화 완료.
- [X] **오디오 엔진 리팩토링**: `audio_player.rs` 모듈화 및 **300ms 선형 페이딩** 로직 안정화 완료.
- [X] **(개선) AI 분리 중 UI 블로킹 현상**: 분리 프로세스 중에도 다른 곡 재생 등 모든 UI 컨트롤이 가능하도록 비동기 처리 로직 개선 완료.
- [X] **(개선) MR 수동 관리 시스템**: 메타데이터 모달 내 MR 수동 플래그 추가 및 AI 분리 시 체크박스 자동 잠금(Lock) 구현
- [X] **(개선) MR/보컬 트랙 삭제 후 재생**: 분리된 트랙 삭제 시, 플레이어가 자동으로 원본 트랙을 재생하도록 즉시 소스 연결 로직 구현 완료.
- [X] **모델 관리자 UI**: AI 모델 상태 배지, 다운로드 및 삭제 관리 UI 기초 구현 완료.
- [X] **커스텀 분리 모델 URL 등록 (Unreleased)**: HTTPS·SHA-256·용량 상한·스트리밍 검증·원자적 설치, 진행률 UI
- [X] **AI 분리 취소 안정화 (v0.4.8)**: 경로 정규화 기반 취소 키 통일 및 분리 스레드/진행률 루프 cancel flag 연동 완료
- [X] **MR 배지·캐시 경로 통일 (v0.4.10)**: `cache_key_variants` 기반 MR 파일 탐색으로 라이브러리 로드/F5 후 MR 배지 유지, 카드에서 `check_mr_separated` 재확인
- [X] **KEY/BPM 분석 MR 경로 수정 (v0.4.10)**: MR `inst.wav` 탐색을 재생·`check_mr_separated`와 동일한 URL 변형 키로 통일
- [ ] **오디오 출력 장치 설정 (Audio Device Selection)**: 다중 사운드 카드 및 가상 오디오 채널 환경을 위한 출력 장치 선택/전환 기능
- [X] **정밀 가사 동기화 도구 (Manual Sync Tool)**: 탭-투-싱크(Tap-to-Sync) 기반의 네이티브 Lyric Sync 시스템 구축 완료
- [X] **Lyric Sync 오디오 엔진 안정화**: 60fps 동기화 루프 및 탐색/재생 상태 불일치 문제 완전 해결
- [X] **웨이브폼 시각화**: Lyric Sync 시 오디오 파형(Waveform) 렌더링 및 클릭 기반 정밀 탐색 기능 구현
- [X] **원문/차음/번역 3줄 모드 (Unreleased)**: 3줄 1세트 수동 토글, LRC `[orig]`/`[pron]`/`[tran]` 저장·하위 호환
- [X] **BPM 그리드·AI 정렬 UX (Unreleased)**: 기분석 BPM 스킵, AI 패널·언어 드롭다운 설정 연동, 마커 버튼 그리드
- [ ] **가사 편집 편의 기능**: 정렬 중 가사 텍스트 즉석 수정 및 오프셋 일괄 조정 기능
- [X] **Forced Alignment 워크플로우 고도화 (v0.4.8)**: 정렬 작업 취소, 실시간 페널티 튜닝, 파형 요약 캐시 재사용, LRC 저장/로드 경로 호환 강화 완료
- [ ] **재생 큐 (Playback Queue)**: '다음에 재생할 곡' 목록 관리 및 수동 전환 기능 지원
- [ ] **반복/셔플 모드**: 한 곡 반복, 전체 반복, 무작위 재생 기능
- [ ] **이퀄라이저 (Equalizer)**: 주파수 대역별 조정 기능 추가

## 📡 3. 방송 및 외부 연동 (Broadcast Integration)

- [X] **방송 오버레이 커스텀**: 배율, 폰트, 컬러 팔레트, 투명도, 둥글기 등을 실시간으로 제어하는 전용 UI 및 WebSocket 동기화 시스템 구축 완료
- [X] **스트리밍 오버레이**: 시청자용 현재 곡 정보 HUD (HTML 소스 제공 및 실시간 흐름(Marquee) 애니메이션 적용 완료)
- [X] **OBS 오버레이 2-레이어 운영 고도화 (v0.4.7)**: 곡 정보/가사 오버레이 페이지 분리, 미리보기 탭 및 브라우저 소스 권장 해상도 가이드 정비
- [X] **오버레이 전환 안정화 (v0.4.7)**: 트랙 변경 시 곡 정보/가사 오버레이를 hide→show로 재전환하여 이전 메타데이터 잔상 방지
- [X] **가사 오버레이 타이밍 보정 (v0.4.7)**: 재생 시작 직후 첫 가사 하단 대기 표시 및 타임코드 진입 시 상단 승격 표시 로직 개선
- [X] **내장 오버레이 서버 운영 안정화 (v0.4.8)**: WebSocket(14201) + HTTP(14202) 자동 기동, 로컬 썸네일 Data URI 변환, 프리뷰/OBS 동시 브로드캐스트 안정화
- [ ] **글로벌 데이터 기여 (Tag Sync)**: 로컬에서 정제된 한국 음악 태그 데이터를 Last.fm/MusicBrainz 글로벌 표준 규격으로 역기여

## ✨ 4. UI/UX 고도화 (UI/UX Refinement)

- [X] **프리미엄 커스텀 UI**: 표준 드롭다운을 대체하는 커스텀 Select 및 고해상도 알림(Toast) 시스템
- [X] **커스텀 확인 모달**: 브라우저 기본 `confirm()`을 대체하는 글래스모피즘 스타일 확인창
- [X] **확인 모달 완성도 (Unreleased)**: 싱크 초기화 등 잔여 `confirm` 제거, X 닫기·소형 `confirm-box` 레이아웃
- [X] **설정·오버레이 톤앤매너 (Unreleased)**: 스택 카드·경로/버튼 정렬·설명문 단순화, 미싱크 배지 밝은 테마 대비
- [X] **알림 문구 목록 문서 (Unreleased)**: [`docs/NOTIFICATION_MESSAGES.md`](docs/NOTIFICATION_MESSAGES.md)
- [X] **사이드바 UI 동기화**: 메뉴 폰트 사이즈/패딩 일원화 및 타이틀 자동 업데이트 시스템 구축 완료
- [X] **마이크로 애니메이션**: 버튼 클릭, 탭 전환, 팝업 등장 시 더 부드러운 트랜지션 추가
- [X] **필셀 퍼펙트 그리드/리스트 뷰**: 6컬럼 기반 단일 그리드 구조 개편 및 완벽한 수직/수평 정렬 달성
- [X] **스마트 컨텍스트 메뉴**: 현재 상태 기반 동적 메뉴(재생/멈춤, 분리/취소) 및 화면 경계 보정 구현
- [X] **UX 편의성 강화**: 전역 `Esc` 키 연동 및 우클릭 메뉴 오픈 시 클릭 간섭 방지 로직 적용
- [X] **필셀 퍼펙트 오디오 UI**: 전역 폰트 크기 통일, 마스터 볼륨 레이아웃 개편 및 입력 시 레이아웃 밀림 해결
- [X] **전역 레이아웃 시스템**: 모든 뷰에 30px 세이프 에리어(Safe-area) 적용 및 수직/수평 정렬 기준선 통일 완료
- [X] **반응형 뷰포트**: 최대 1600px까지 유동적으로 확장되는 플루이드 레이아웃 및 사이드바 축소 모드 구현
- [X] **성능 최적화**: 수백 곡 이상의 대규모 라이브러리에서도 끊김 없는 스크롤 및 로딩 보장
- [X] **전역 테마 시스템 리뉴얼 (v0.4.7)**: 다크/라이트 모드 토큰화, 아이보리 톤 라이트 팔레트, 화면별 대비 문제(텍스트/배경/파형) 개선 완료
- [X] **테마 확장 (v0.4.8)**: 다크/아이보리에 더해 분홍/하늘 테마 추가 및 선택값 영속화 완료
- [X] **Lyric Sync & Drawer 고도화**: 
    - **가사 드로어 (Lyric Drawer)**: 음악 재생 시 실시간 가사 동기화, 하이라이트 및 어절 단위(`keep-all`) 줄바꿈 시스템 구축.
    - **가사 로직 중앙화**: `src/js/lyrics.js` 유틸리티를 통한 파싱/동기화 로직 일원화.
    - **디자인 복원**: 그리드 카드 디자인(15px 제목, 파란색 아티스트 배지, 대문자 태그) 정밀 복원 및 중복 스타일 정리.
    - **UX 정밀 조정**: 가사 카드 여백 최적화 및 그리드 태그 간격 확보 완료.

## 📡 5. 백엔드 및 서비스 안정화 (System Stability)

- [X] **지능형 작업 큐**: `Queued`, `Running` 상태 추적 및 전역 AI 락을 통한 시스템 안정성 확보 완료
- [X] **메타데이터 KEY/BPM 분석 버튼 (v0.4.8)**: 편집 모달에서 키/템포 자동 분석 후 필드 즉시 반영 기능 완료
- [X] **MR 캐시 키 헬퍼 통합 (v0.4.10)**: `mr_separated_files_exist` / `cache_key_variants`로 재생·배지·KEY/BPM·삭제 경로 일원화
- [X] **스프레드시트 가져오기/보내기 (v0.4.10)**: CSV(UTF-8 BOM)·XLSX 병합 가져오기 및 CSV보내기·양식 다운로드
- [X] **스프레드시트 유튜브 메타 보강 (v0.4.14)**: 가져오기 시 URL만 있어도 썸네일·재생시간·아티스트 자동 채움, `enriched` 건수 토스트 표시
- [X] **재생 시 유튜브 메타 보강 (v0.4.14)**: 최소 정보만 등록된 유튜브 곡 재생 시 도크·라이브러리 UI 즉시 갱신
- [X] **설정 법적 고지 링크 (v0.4.14)**: 개인정보 처리방침·이용약관 버튼 → Companion `/privacy`, `/terms`
- [X] **곡 정보 편집 저장 안정화 (v0.4.11)**: DB 데드락 수정, 저장 후 모달 즉시 닫기
- [X] **타이틀바 창 드래그 (v0.4.11)**: 커스텀 타이틀바 이동·capability
- [X] **GitHub 업데이트 확인 (v0.4.10)**: 설정에서 수동 확인·백그라운드 주기 검사 (`updater.rs`)
- [ ] **에러 핸들링 강화**: 오디오 디코딩 및 AI 추론 시 발생할 수 있는 예외 상황에 대한 상세 리포팅 시스템
- [ ] **자동 업데이트**: 앱 자동 다운로드·설치 (현재: GitHub Releases 수동 확인만. §7 Phase 4 companion manifest 연동 예정)

## 🛠️ 6. 개발 환경 및 문서 (DevEx)

- [X] **README 개발 환경 가이드 보강 (v0.4.10)**: LLVM(libclang), `cargo fetch`, Windows PowerShell/`npm.cmd` 안내 반영
- [X] **앱 버전 v0.5.1 핫픽스**: 배포본 Meloming OAuth — Client ID 임베드, Secret 없으면 Companion exchange/refresh
- [X] **앱 버전 v0.5.0**: 멜로밍 노래책 가져오기·보내기 재개, Push Diff·메타·별점 UI, Companion OAuth refresh
- [X] **앱 버전 v0.4.16 핫픽스**: MP3 MR ffmpeg PATH(`ffmpeg_tools`), 멜로밍 동기화 UI·백엔드 잠금 문구 정리
- [X] **앱 버전 v0.4.15 메타데이터 정합성**: `package.json`, `Cargo.toml`, `tauri.conf.json` 버전 번호 일괄 갱신
- [X] **설정 UI 정리 (v0.4.12)**: 설정 카드 버튼 너비 150px, MR 저장 형식 드롭다운 250px
- [X] **MP3 MR 저장 콘솔 숨김 (v0.4.12)**: ffmpeg `CREATE_NO_WINDOW`
- [X] **멜로밍 연동 기획 문서**: [`docs/MELOMING_SONGBOOK_INTEGRATION.md`](docs/MELOMING_SONGBOOK_INTEGRATION.md) (API·OAuth·필드 매핑·Vercel companion·동기화·업데이트 알림)

## 🎵 7. 멜로밍 노래책 연동 (Meloming OpenAPI)

[멜로밍 채널 노래책 API](https://developers.meloming.com/docs/openapi/reference/songbook)와 로컬 라이브러리 **양방향 메타데이터 동기화**. 음원·AI 분리 파일은 로컬만(P1); 멜로밍에는 제목·URL·가사·숙련도/난이도 등만 전송.

**인증 참고**: 문서의 「애플리케이션 등록」 링크는 개발자 센터 **미니앱(앱) 등록** UI로 연결됨. `GET` 읽기는 등록 없이 가능, `POST`/`PATCH`/`DELETE`는 OAuth 필요.

**Companion (Vercel)**: 미니앱 iframe·OAuth Redirect·FAQ/Q&A·changelog·업데이트 manifest — 별도 Next.js 프로젝트. **배포 앱 토큰 교환**: Client Secret은 Vercel env만, Client ID는 릴리스 바이너리 임베드(v0.5.1+).

**실행 순서 (2026-06)**: **Phase 2A(companion·미니앱 신청)를 먼저** → 심사·OAuth 대기 중 **Phase 0·1·2B 코드** 병행 → 승인 후 Push 연동.

### Phase 2A — Vercel companion + 미니앱 등록·심사 (**1순위**)

- [X] **Vercel companion 스캐폴딩**: [`web/companion`](web/companion) — `/`, `/oauth/callback`, `/faq`, `/qa`, `/download`, `/privacy` (로컬 `npm run dev` / `npm run build` 확인)
- [X] **Vercel 프로덕션 배포**: https://lmrm.vercel.app (`web/companion`)
- [X] **개인정보 처리방침 (v0.4.13)**: companion `/privacy`, 멜로밍 OAuth·쿠키·Last.fm 범위 명시, 푸터·FAQ 링크
- [X] **이용약관 (v0.4.13)**: companion `/terms`, 베타·멜로밍·저작권·면책, 푸터 링크
- [X] **미니앱(앱) 등록**: iframe `https://lmrm.vercel.app/`, Redirect `https://lmrm.vercel.app/oauth/callback`
- [X] **심사 제출** (승인 대기)
- [X] **OAuth 클라이언트 확보**: Client ID/Secret, API Key (미니앱 승인)
- [ ] **(병행) 멜로밍 문의**: OAuth 토큰 교환 500/401 — Redirect URI·Client 승인 상태 확인 (2026-06 진행 중)

### Phase 0 — 로컬 메타데이터 (2A 대기 중 병행)

- [X] **KEY/BPM DB 영속화**: `SongMetadata`/`song_key`·`bpm`·저장·로드
- [X] **숙련도·난이도 필드**: `difficulty`/`proficiency` (1–5) — DB·편집 모달
- [X] **songKey 명칭 통일**: UI `edit-key` ↔ DB `song_key` ↔ 멜로밍 `songKey`

### Phase 1 — 읽기 동기화 (인증 불필요)

- [X] **Rust `meloming` 모듈**: `client`·`sync`·`commands`·`resolve` — 목록·아티스트 (`GET`)
- [X] **설정 UI**: 방송 채널 주소(치지직·SOOP·씨미), 연결 테스트, 「가져오기」(Pull)
- [X] **플랫폼 채널 해석 (v0.4.11)**: `CHZZK` / `SOOP` / `CIME` URL·ID → `GET /v1/channels/platforms/{platform}/{id}`
- [X] **아티스트 Map 테이블**: `Meloming_Artist_Map`
- [X] **확장 DB 컬럼**: `meloming_song_id`, URL 필드, `sync_status` 등
- [ ] **카테고리 Map 갱신·매칭 UI**: Pull 시 `Meloming_Category_Map` + 로컬 카테고리 연동
- [ ] **Pull 매칭 정교화**: YouTube ID·제목+아티스트 중복 최소화, `meloming:` 경로 곡 UX

### Phase 2B — OAuth 쓰기 (2A 승인 후 실연동)

- [X] **Tauri OAuth PKCE**: Authorization Code + refresh, 토큰 Settings 저장, deep-link + companion `/api/oauth/exchange`
- [X] **배포 OAuth 자격 증명 (v0.5.1)**: Client ID 바이너리 임베드, Secret 없으면 Companion exchange/refresh 자동
- [X] **Push 코드**: `POST`/`PATCH` 노래책 API (일괄 보내기)
- [X] **Push 안정화 (v0.4.13·v0.4.14)**: 보내기 전 아티스트 Map 갱신, 유튜브 메타 보강, 아티스트 느슨 매칭, 채널별 `meloming_song_id`, PATCH 403/404 → CREATE 재시도
- [ ] **OAuth 실연동 (간헐적 이슈)**: 멜로밍 `POST /oauth/token` 500 INTERNAL_ERROR·401 Invalid redirect_uri — **v0.4.13 UI 재개**, 서버 오류 시 재시도 안내
- [X] **UI 잠금 해제 (v0.4.13)**: `MELOMING_COMING_SOON` 제거 — 「멜로밍 로그인」·「멜로밍에 보내기」 활성화
- [X] **MP3 MR ffmpeg PATH 핫픽스 (v0.4.16)**: `ffmpeg_tools` — MR 저장·유튜브 공통 탐색, 관리형 캐시·자동 다운로드
- [X] **노래책 동기화 UI 잠금 (v0.4.15–v0.4.16)**: OpenAPI 아티스트·카테고리 CRUD 대기, 설정 카드·백엔드 가드
- [X] **노래책 동기화 재개 (v0.5.0)**: 「가져오기」/「보내기」 UI 분리, Pull/Push 활성, 로그인 시 채널 자동 해석
- [X] **Push Diff·메타 고도화 (v0.5.0)**: RemoteSongIndex, PATCH diff, 가사·KEY/BPM·숙련도/난이도, rate limit, 아티스트·카테고리 자동 생성
- [X] **곡 정보 편집 별점 UI (v0.5.0)**: 난이도/숙련도 클릭 선택, KEY/BPM 그리드 정렬
- [X] **멜로밍 아티스트·카테고리 POST (v0.5.0)**: Push 시 `create_artist`/`create_category` 자동 등록 (OpenAPI 동작 확인)
- [X] **멜로밍 계정 메뉴 z-index (v0.4.14)**: 헤더·드롭다운 겹침 수정
- [ ] **DELETE** 노래 삭제 Push
- [ ] **YouTube `path` → `originalUrl`** 자동 매핑
- [ ] **2A 미완 시**: 읽기만·`pending_push` 큐 또는 웹 수동 안내

### Phase 2A+ — Companion 웹 (테스트·추후 정리)

- [X] **웹 OAuth 테스트**: `/login`, `/account`, `/api/oauth/login|complete|exchange`, `/api/auth/session`
- [X] **OAuth 콜백 분기**: 웹 PKCE 쿠키 있으면 웹 세션, 없으면 앱 딥링크
- [ ] **웹 로그인 UI 제거 또는 정식화** (OAuth 안정화 후 결정)

### Phase 3 — 양방향·충돌

- [ ] **동기화 엔진**: `local_updated_at`/`remote_updated_at`, `content_hash`
- [ ] **충돌 UI**: `newer_wins` / `local_wins` / `remote_wins` / `ask`
- [ ] **삭제·고아 정책**: 자동 삭제 전파 없음, 사용자 확인
- [ ] **일괄 Pull/Push·진행률 UI**

### Phase 4 — Companion 확장·업데이트 알림

- [ ] **Vercel `/changelog`**, `/qa` 본문, `GET /api/releases/latest`
- [ ] **`updater.rs` 연동**: GitHub Releases 유지 + companion manifest/changelog URL 폴백
- [ ] **`RELEASE_NOTES.md` ↔ changelog** 동기화 (CI 또는 릴리즈 스크립트)
- [X] **Discord 릴리즈 공지 (v0.5.0+)**: `v*` 태그 push → `#공지` webhook, 사용자용 [`DISCORD_ANNOUNCEMENTS.md`](DISCORD_ANNOUNCEMENTS.md)
- [ ] **(선택) 오버레이 숙련도/난이도 표시**

### Phase 5 — 멜로밍 신청곡 관리 (Song Request)

멜로밍 채널로 **들어온 신청곡**을 앱에서 조회·정리·처리하는 기능. 노래책(Pull/Push)과 별도 — **신청 큐·상태·라이브러리 연동** 중심. (P1: 음원은 로컬만, 멜로밍에는 메타·상태만)

- [ ] **멜로밍 OpenAPI 조사**: 신청곡 목록·상태·승인/거절·완료(처리됨) 등 제공 API·OAuth scope 확인
- [ ] **Rust `meloming` 신청곡 모듈**: 목록 Pull, 상태 변경(PATCH 등), 채널·기간 필터
- [ ] **신청곡 UI**: 대기/처리중/완료 탭 또는 필터, 신청자·곡명·URL·신청 시각 표시
- [ ] **로컬 라이브러리 연동**: 신청 URL/제목으로 기존 곡 매칭, 없으면 「라이브러리에 추가」·「노래책에 보내기」 단축 동작
- [ ] **방송 워크플로우**: 신청곡 → 재생 큐 또는 「다음 곡」 후보, 처리 완료 시 멜로밍 상태 반영
- [ ] **(선택) OBS·토스트 알림**: 새 신청 수신 시 앱 내 알림 또는 오버레이 표시

---

💡 **참고**: 이 목록은 우선순위에 따라 유동적으로 조정될 수 있습니다. v0.4.10은 2026-06-02 릴리즈, v0.4.11·v0.4.12는 2026-06 패치 빌드, **v0.4.13**은 2026-06-27(Companion 법적 문서·멜로밍 로그인/보내기 재개), **v0.4.14**는 2026-06-27(유튜브 메타 보강·Push 안정화·설정 법적 고지), **v0.4.15**는 2026-06-27(노래책 동기화 UI 업데이트 예정·OpenAPI 대기), **v0.4.16**은 2026-07-05(MP3 MR ffmpeg PATH 핫픽스·멜로밍 동기화 안내), **v0.5.0**은 2026-07-05(노래책 가져오기·보내기 재개·Push Diff·별점 UI), **v0.5.1**은 2026-07-13(멜로밍 OAuth 배포 로그인 핫픽스)입니다. **Unreleased(v0.5.2+ 예정)**에는 노래 추가 모달·소스 칩, 커스텀 모델 URL·가사 3줄 모드·BPM/AI 싱크·일괄 정렬·랩 정렬·설정 톤앤매너·라이선스 문서 정비가 포함됩니다([`RELEASE_NOTES.md`](RELEASE_NOTES.md)). 멜로밍 연동 상세는 [`docs/MELOMING_SONGBOOK_INTEGRATION.md`](docs/MELOMING_SONGBOOK_INTEGRATION.md) 및 [README](README.md) 로드맵을 참고하세요.
