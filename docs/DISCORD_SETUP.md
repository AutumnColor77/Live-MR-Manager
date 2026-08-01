# Discord 서버 운영 가이드

Live MR Manager 사용자(스트리머·퍼포머) 문의용 Discord 서버 설정 안내입니다.

## 서버 정보

- 초대 링크: https://discord.gg/qfJnk3VJyf
- 서버 이름: [LMRM] Live MR Manager

코드 반영 위치: [`web/companion/lib/site.ts`](../web/companion/lib/site.ts), [`src/js/companion-links.js`](../src/js/companion-links.js)

Vercel 프로덕션에도 `NEXT_PUBLIC_DISCORD_INVITE_URL=https://discord.gg/qfJnk3VJyf` 환경 변수를 설정하세요.

## 권장 채널

| 채널 | 용도 |
|------|------|
| `#공지` | 릴리즈, 알려진 이슈, FAQ·앱 설정 경로 |
| `#질문-답변` | 설치·사용법 (주 활동) |
| `#버그-제보` | 증상 공유 → GitHub Issues template 유도 |
| `#건의` | 기능 제안 (선택) |

## `#공지` 핀 메시지 예시

- Discord: https://discord.gg/qfJnk3VJyf
- FAQ: https://lmrm.vercel.app/faq
- 문의 허브: https://lmrm.vercel.app/qa
- 버그 신고: https://github.com/AutumnColor77/Live-MR-Manager/issues/new?template=bug_report.yml
- 앱에서: 설정 → 도움말 · 문의

**주의:** OAuth token·Client Secret·전체 로그는 올리지 마세요.

## 릴리즈 자동 공지 (GitHub Actions)

`v*` 태그가 push되면 [`discord-release.yml`](../.github/workflows/discord-release.yml)이 [`DISCORD_ANNOUNCEMENTS.md`](../DISCORD_ANNOUNCEMENTS.md)에서 **사용자용** 공지를 읽어 **Discord `#공지`** webhook으로 게시합니다. (개발자용 [`RELEASE_NOTES.md`](../RELEASE_NOTES.md)와 분리)

### 릴리즈할 때

1. `RELEASE_NOTES.md` — 변경 이력(개발·GitHub Release용)
2. **`DISCORD_ANNOUNCEMENTS.md`** — `#공지`용 짧은 안내 (무엇이 바뀌었는지, 어디서 쓰는지)

### 1회 설정

1. Discord **서버 설정 → 연동 → Webhooks → 새 Webhook**
2. 채널: `#공지` (또는 릴리즈 전용 채널)
3. Webhook URL 복사
4. GitHub 저장소 → **Settings → Secrets and variables → Actions → New repository secret**
   - Name: `DISCORD_WEBHOOK_URL`
   - Value: webhook URL (`https://discord.com/api/webhooks/...`)

### 동작

| 트리거 | 설명 |
|--------|------|
| `git push origin v0.5.1` | 태그 push 시 자동 공지 |
| Actions → **discord-release** → Run workflow | 과거 태그 수동 공지 (tag 입력) |

- 본문: [`DISCORD_ANNOUNCEMENTS.md`](../DISCORD_ANNOUNCEMENTS.md)의 `## vX.Y.Z (...)` 블록 (없으면 짧은 기본 안내)
- `DISCORD_WEBHOOK_URL`이 없으면 워크플로는 **건너뜀**(빌드 실패 없음)
- NSIS 빌드 워크플로([`release.yml`](../.github/workflows/release.yml))와 **독립** 실행

### v0.5.0 등 이미 릴리즈한 버전

Webhook 설정 후 Actions에서 **discord-release** → **Run workflow** → tag에 `v0.5.0` 또는 `v0.5.1` 입력.
