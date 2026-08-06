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

/** Live MR Songbook (Google/Naver 로그인 · 채널 운영) */
export const SONGBOOK_PROD = 'https://www.livemrsongbook.com';
/** 로컬 개발: localStorage.setItem('songbook_base', 'http://localhost:5173') */
export const SONGBOOK_BASE = SONGBOOK_PROD;

/** Songbook SLUG_RE 와 동일 */
export const SONGBOOK_SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export function songbookBase() {
  try {
    const override = localStorage.getItem('songbook_base');
    if (override) return override.replace(/\/$/, '');
  } catch {
    /* ignore */
  }
  return SONGBOOK_BASE;
}

export function songbookOAuthLoginUrl(provider = 'google', next = '/me') {
  const q = new URLSearchParams({ next });
  return `${songbookBase()}/api/auth/${provider}?${q}`;
}

/** 앱 로그인 진입점 — 브라우저에 Songbook 세션이 있으면 OAuth 없이 바로 앱으로 핸드오프 */
export function songbookDesktopConnectUrl(provider = 'google', next = '/me') {
  const q = new URLSearchParams({ provider, next, client: 'desktop' });
  return `${songbookBase()}/api/auth/desktop-connect?${q}`;
}

export function songbookGoogleLoginUrl(next = '/me') {
  return songbookOAuthLoginUrl('google', next);
}
export function songbookNaverLoginUrl(next = '/me') {
  return songbookOAuthLoginUrl('naver', next);
}
export function songbookDemoAdminUrl() {
  return `${songbookBase()}/c/${songbookChannelSlug()}/admin`;
}

/** 동기화 대상: 본인 소유 채널만 (demo 제외) */
export function pickOwnChannel(channels) {
  if (!Array.isArray(channels)) return null;
  return channels.find((c) => c?.slug && c.slug !== 'demo') || null;
}

/** UI 표시용: 본인 채널 우선, 없으면 demo */
export function pickPrimaryChannel(channels) {
  if (!Array.isArray(channels) || channels.length === 0) return null;
  return pickOwnChannel(channels) || channels.find((c) => c?.slug === 'demo') || channels[0] || null;
}

export function getSongbookChannels() {
  try {
    const raw = localStorage.getItem('songbook_channels');
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** /api/auth/me 의 channels 반영 → 기본 slug 자동 설정(본인 채널만) */
export function applySongbookChannels(channels) {
  const list = Array.isArray(channels)
    ? channels.filter((c) => c && typeof c.slug === 'string')
    : [];
  try {
    localStorage.setItem('songbook_channels', JSON.stringify(list));
  } catch {
    /* ignore */
  }
  const own = pickOwnChannel(list);
  if (own?.slug) {
    setSongbookChannelSlug(own.slug);
  } else {
    try {
      localStorage.removeItem('songbook_channel');
    } catch {
      /* ignore */
    }
  }
  return own || pickPrimaryChannel(list);
}

export function clearSongbookChannelCache() {
  try {
    localStorage.removeItem('songbook_channels');
    localStorage.removeItem('songbook_channel');
  } catch {
    /* ignore */
  }
}

/** 동기화 대상 채널 slug (본인 채널). 없으면 빈 문자열 */
export function songbookChannelSlug() {
  try {
    const override = localStorage.getItem('songbook_channel');
    if (override) {
      const slug = override.trim().toLowerCase().replace(/\/$/, '');
      if (slug && slug !== 'demo') return slug;
    }
  } catch {
    /* ignore */
  }
  const own = pickOwnChannel(getSongbookChannels());
  return own?.slug || '';
}

export function setSongbookChannelSlug(slug) {
  const next = String(slug || '')
    .trim()
    .toLowerCase()
    .replace(/\/$/, '');
  if (!next || next === 'demo' || !SONGBOOK_SLUG_RE.test(next)) {
    try {
      localStorage.removeItem('songbook_channel');
    } catch {
      /* ignore */
    }
    return '';
  }
  try {
    localStorage.setItem('songbook_channel', next);
  } catch {
    /* ignore */
  }
  return next;
}

export function songbookAdminSongsUrl(slug = songbookChannelSlug()) {
  return `${songbookBase()}/api/c/${encodeURIComponent(slug)}/admin/songs`;
}

const issuesBase = `https://github.com/${GITHUB_REPO}/issues`;

export const GITHUB_ISSUES_BUG_URL = `${issuesBase}/new?template=bug_report.yml`;
export const GITHUB_ISSUES_FEATURE_URL = `${issuesBase}/new?template=feature_request.yml`;

/** Discord URL이 없으면 문의 허브(/qa)로 폴백 */
export function resolveDiscordUrl() {
  return DISCORD_INVITE_URL || QA_URL;
}
