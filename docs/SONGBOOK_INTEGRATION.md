# Live MR Songbook 연동 (Pull / Push / 원격 재생)

## Push (앱 → 웹)

설정 → Songbook 동기화 → **보내기**

- 제목·아티스트 키로 매칭 후 POST/PATCH
- 로컬에 없는 원격 곡은 `enabled=false` (공개 숨김)
- 유튜브 `path`/`originalUrl`이 http(s)이면 `originalUrl`로 전송
- 로컬 파일 경로는 업로드하지 않음

## Pull (웹 → 앱)

설정 → **가져오기**

1. `GET /api/c/:slug/admin/songs` (enabled만)
2. 제목·아티스트로 로컬 매칭
3. 매칭됨 → 메타 갱신 (path/MR/볼륨 유지). 플레이스홀더에 URL이 생기면 youtube로 승격
4. 없음 + `originalUrl` → youtube 곡 추가
5. 없음 + URL 없음 → `path=songbook:song:{id}`, `source=songbook` 플레이스홀더

## 웹 Admin 「재생」 → 앱 재생

웹은 `PATCH status=playing`만 수행. 앱 [`songbook-request-poller.js`](../src/js/songbook-request-poller.js)가 약 4초마다 `nowPlaying`을 보고:

- 새 request id면 `findLibrarySong` → `playQueueItem` (`patchPlaying: false`)
- 플레이스홀더/`songbook:` path면 토스트만
- 이미 같은 곡 재생 중이면 스킵

## Songbook 스키마

- `songs.original_url` — 마이그레이션 `0018_song_original_url.sql`
- 배포: `npm run db:migrate:remote` 후 `npm run deploy`
