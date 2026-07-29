/**
 * Companion 웹·GitHub Issues·Discord URL (앱 설정 링크용)
 * web/companion/lib/site.ts 와 동기화 유지
 */
export const GITHUB_REPO = 'AutumnColor77/Live-MR-Manager';
export const COMPANION_BASE = 'https://lmrm.vercel.app';
export const GITHUB_REPO_URL = `https://github.com/${GITHUB_REPO}`;

export const FAQ_URL = `${COMPANION_BASE}/faq`;
export const QA_URL = `${COMPANION_BASE}/qa`;
export const PRIVACY_URL = `${COMPANION_BASE}/privacy`;
export const TERMS_URL = `${COMPANION_BASE}/terms`;
export const LICENSE_URL = `${GITHUB_REPO_URL}/blob/main/LICENSE`;
export const THIRD_PARTY_NOTICES_URL = `${GITHUB_REPO_URL}/blob/main/THIRD_PARTY_NOTICES.md`;
export const MODEL_LICENSING_URL = `${GITHUB_REPO_URL}/blob/main/docs/MODEL_LICENSING.md`;
export const FFMPEG_SOURCE_URL = 'https://github.com/BtbN/FFmpeg-Builds/releases/tag/autobuild-2026-06-30-13-34';
export const YTDLP_SOURCE_URL = 'https://github.com/yt-dlp/yt-dlp';

/** Discord 초대 링크 — [LMRM] Live MR Manager */
export const DISCORD_INVITE_URL = 'https://discord.gg/qfJnk3VJyf';

const issuesBase = `https://github.com/${GITHUB_REPO}/issues`;

export const GITHUB_ISSUES_BUG_URL = `${issuesBase}/new?template=bug_report.yml`;
export const GITHUB_ISSUES_MELOMING_URL = `${issuesBase}/new?template=meloming_integration.yml`;
export const GITHUB_ISSUES_FEATURE_URL = `${issuesBase}/new?template=feature_request.yml`;

/** Discord URL이 없으면 문의 허브(/qa)로 폴백 */
export function resolveDiscordUrl() {
  return DISCORD_INVITE_URL || QA_URL;
}
