# Live MR Songbook 연동 (Pull / Push / 원격 재생)

앱 헤더 닉네임 메뉴(v0.7.4):

- **운영페이지** → `/c/{slug}/admin`
- **노래책페이지** → `/c/{slug}`
- **로그아웃**

로그인 후 헤더에는 **프로필 사진·닉네임**(또는 채널명)이 표시됩니다.

## OAuth (데스크톱 로그인)

앱 헤더/신청목록의 Google·네이버 버튼으로만 시작합니다.

1. `begin_songbook_oauth`가 nonce(`state`)를 Settings DB에 저장합니다(약 180초).
2. 브라우저는 `desktop-connect` URL에 그 `state`를 실어 엽니다.
3. 딥링크 콜백 `live-mr-manager://oauth/callback?token=…&state=…`에서 pending state를 소비합니다. 콜백에 `state`가 있으면 반드시 일치해야 하고, Songbook이 `state`를 생략하면 로그인 창이 열려 있는 동안만 허용합니다.
4. 앱에서 로그인을 시작하지 않은 딥링크, 만료된 요청, 불일치 `state`는 거절됩니다.
5. 로그에는 토큰을 마스킹합니다 (`redact_oauth_url_for_log`).

구현: [`src-tauri/src/songbook_auth.rs`](../src-tauri/src/songbook_auth.rs), [`src-tauri/crates/lmrm-logic/src/oauth.rs`](../src-tauri/crates/lmrm-logic/src/oauth.rs).

라이브러리에서 **신청목록에 추가**는 시청자 신청 API(`POST /api/c/:slug/requests`)를 씁니다. 곡은 보내기로 노래책에 있어야 합니다.

## Push (앱 → 웹)

설정 → Songbook 동기화 → **보내기**

- 제목·아티스트 키로 매칭 후 POST/PATCH
- 로컬에 없는 원격 곡은 `enabled=false` (공개 숨김)
- 유튜브 `path`/`originalUrl`/`original_url`만 `originalUrl`로 전송 (`pickSongbookPushOriginalUrl` — **YouTube ID 있는 http(s)만**, 로컬 경로·비-유튜브 URL 금지)
- 유튜브 없으면 `originalUrl: null` (서버 DB null 정상)
- **성능 (2026-09)**: 곡당 순차 + throttle 제거, 최대 5건 병렬. 썸네일 JPEG 변환은 업로드 직전 1회(세션 캐시).

## Pull (웹 → 앱)

설정 → **가져오기**

1. `GET /api/c/:slug/admin/songs` (enabled만)
2. 제목·아티스트로 로컬 매칭
3. 매칭됨 → 메타 갱신 (path/MR/볼륨 유지). 플레이스홀더에 URL이 생기면 youtube로 승격
4. 없음 + `originalUrl`(또는 `original_url`, `youtube_url`, `karaoke_url` 등 http URL 필드) → youtube 곡 추가
5. 없음 + URL 없음 → `path=songbook:song:{id}`, `source=songbook` 플레이스홀더

## 재생 가능 URL 해석 (2026-09)

[`youtube-utils.js`](../src/js/youtube-utils.js) · [`player.js`](../src/js/player.js) · [`songbook-sync.js`](../src/js/songbook-sync.js)

- `resolvePlayableAudioPath`: `originalUrl`/`original_url`/`karaoke_url` 등 + scheme-less 유튜브 URL(`youtu.be/...`) 정규화. **YouTube 호스트만** 재생·다운로드합니다.
- `songbook:song:{id}` 플레이스홀더 재생 시 Songbook admin 목록을 **재조회**해 서버 URL 반영 후 `path` 승격
- Songbook에 URL이 **전혀 없으면** 재생 불가 → 토스트: 「이 곡은 웹에서 가져온 정보만 있습니다. 유튜브 URL이 없어 재생할 수 없습니다.」

## 웹 Admin 「재생」 → 앱 재생

웹은 `PATCH status=playing`만 수행. 앱 [`songbook-request-poller.js`](../src/js/songbook-request-poller.js)가 약 4초마다 `nowPlaying`을 보고:

- 새 request id면 `findLibrarySong` → `playQueueItem` (`patchPlaying: false`)
- 플레이스홀더/`songbook:` path면 토스트만
- 이미 같은 곡 재생 중이면 스킵

## Songbook 스키마

- `songs.original_url` — 마이그레이션 `0018_song_original_url.sql`
- 배포: `npm run db:migrate:remote` 후 `npm run deploy`

## (예정) Bulk upsert API

100곡+ Push 시 HTTP 왕복을 줄이기 위한 서버 bulk API는 Songbook 레포 작업 후 앱에서 우선 사용·fallback 예정.
