# Live MR Manager — Vercel Companion

Live MR Manager **사용자-facing** companion 웹 (Next.js). 앱 다운로드·FAQ·법적 문서·문의 안내.

## 페이지

| 경로 | 용도 |
|------|------|
| `/` | 앱 안내 랜딩 |
| `/faq`, `/qa` | FAQ·문의 허브 (Discord, GitHub Issues) |
| `/privacy` | 개인정보 처리방침 (앱·웹 통합) |
| `/terms` | 이용약관 (MIT 소프트웨어 권리와 서비스 약관 분리) |
| `/download` | GitHub Releases 링크 |

## 로컬 실행

```bash
cd web/companion
npm install
npm run dev
```

http://localhost:3000

## 환경 변수

`.env.local` (Git 커밋 금지):

```env
# Discord 영구 초대 (프로덕션 Vercel에도 설정)
NEXT_PUBLIC_DISCORD_INVITE_URL=https://discord.gg/qfJnk3VJyf
```

문의 채널·Discord 서버 설정: [`docs/DISCORD_SETUP.md`](../../docs/DISCORD_SETUP.md)

## 라이선스

Companion 웹 코드는 루트 저장소와 동일하게 **MIT**입니다. 이용약관은 Companion 서비스 조건이며 MIT 재배포 권리를 축소하지 않습니다.
제3자·모델: [`THIRD_PARTY_NOTICES.md`](../../THIRD_PARTY_NOTICES.md), [`docs/MODEL_LICENSING.md`](../../docs/MODEL_LICENSING.md).

## GitHub Issues

버그·기능 제안 템플릿: [`.github/ISSUE_TEMPLATE/`](../../.github/ISSUE_TEMPLATE/)

## Vercel 배포

1. Vercel에서 이 폴더(`web/companion`)를 루트로 import
2. 프로덕션 URL: `https://lmrm.vercel.app`
