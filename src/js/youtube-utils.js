/**
 * youtube-utils.js - Shared YouTube URL parsing helpers
 */

const MEDIA_URL_KEYS = [
  'originalUrl',
  'original_url',
  'youtubeUrl',
  'youtube_url',
  'videoUrl',
  'video_url',
  'url',
  'karaokeUrl',
  'karaoke_url',
  'path',
];

export function extractYoutubeVideoId(raw) {
  if (!raw || typeof raw !== "string") return null;
  const trimmed = raw.trim();
  try {
    const parsed = new URL(trimmed);
    const host = parsed.hostname.replace(/^www\./, "").toLowerCase();
    if (host === "youtu.be") {
      return parsed.pathname.split("/").filter(Boolean)[0] || null;
    }
    if (host.endsWith("youtube.com")) {
      if (parsed.pathname === "/watch") {
        return parsed.searchParams.get("v");
      }
      if (parsed.pathname.startsWith("/shorts/") || parsed.pathname.startsWith("/embed/")) {
        return parsed.pathname.split("/").filter(Boolean)[1] || null;
      }
    }
  } catch (_) {
    // fall through to regex fallback
  }
  const shortMatch = trimmed.match(/youtu\.be\/([^?&#/]+)/i);
  if (shortMatch?.[1]) return shortMatch[1];
  const watchMatch = trimmed.match(/[?&]v=([^&#/]+)/i);
  if (watchMatch?.[1]) return watchMatch[1];
  if (/^[\w-]{11}$/.test(trimmed)) return trimmed;
  return null;
}

/** @deprecated Use extractYoutubeVideoId */
export function youtubeVideoIdFromPath(path) {
  return extractYoutubeVideoId(path);
}

export function normalizeYoutubeKey(raw) {
  const videoId = extractYoutubeVideoId(raw);
  if (videoId) return `yt:${videoId}`;
  return String(raw || "").trim().toLowerCase();
}

export function normalizeYoutubeUrl(raw) {
  const videoId = extractYoutubeVideoId(raw);
  return videoId ? `https://youtu.be/${videoId}` : String(raw || "").trim();
}

export function isPlaceholderAudioPath(path) {
  const p = String(path || "").trim();
  return !p || p.startsWith("songbook:") || p.startsWith("meloming:");
}

/** Normalize scheme-less or partial YouTube URLs to https form. */
export function coerceHttpMediaUrl(raw) {
  const value = String(raw ?? '').trim();
  if (!value) return null;
  if (/^https?:\/\//i.test(value)) {
    const id = extractYoutubeVideoId(value);
    return id ? normalizeYoutubeUrl(value) : value;
  }
  if (value.startsWith('//')) {
    return coerceHttpMediaUrl(`https:${value}`);
  }
  if (/^(www\.)?(youtube\.com|youtu\.be)\b/i.test(value)) {
    return coerceHttpMediaUrl(`https://${value.replace(/^\/+/, '')}`);
  }
  const id = extractYoutubeVideoId(value);
  if (id) return normalizeYoutubeUrl(value);
  return null;
}

export function pickHttpMediaUrl(...candidates) {
  for (const raw of candidates) {
    const url = coerceHttpMediaUrl(raw);
    if (url) return url;
  }
  return null;
}

/** Extract the first playable http(s) media URL from a metadata record. */
export function resolveMediaUrlFromRecord(record) {
  if (!record) return null;
  for (const key of MEDIA_URL_KEYS) {
    const url = coerceHttpMediaUrl(record[key]);
    if (url) return url;
  }
  return null;
}

/**
 * Path to actually play. Songbook Pull may store a placeholder or a missing
 * local path while originalUrl still has the YouTube link.
 */
export function resolvePlayableAudioPath(song) {
  if (!song) return null;
  const path = String(song.path || "").trim();
  const httpPath = coerceHttpMediaUrl(path);
  if (httpPath) return httpPath;

  const original = resolveMediaUrlFromRecord(song);
  if (original && isPlaceholderAudioPath(path)) return original;
  if (original && String(song.source || "").toLowerCase() === "youtube") return original;
  const looksLikeLocalAudio = /\.(mp3|wav|flac|m4a|aac|ogg|wma|opus)$/i.test(path);
  if (original && path && !looksLikeLocalAudio) return original;
  return path || original || null;
}

export function youtubePathsMatch(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  const aId = extractYoutubeVideoId(a);
  const bId = extractYoutubeVideoId(b);
  return !!(aId && bId && aId === bId);
}

export function isDuplicateYoutubeTrack(library, requestedUrl, metadata) {
  const candidateKeys = new Set([
    normalizeYoutubeKey(requestedUrl),
    normalizeYoutubeKey(metadata?.path),
  ]);

  return (library || []).some((song) => {
    if (!song) return false;
    if (metadata?.path && song.path === metadata.path) return true;
    return candidateKeys.has(normalizeYoutubeKey(song.path));
  });
}
