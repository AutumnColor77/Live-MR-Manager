/**
 * Songbook 신청 백그라운드 폴링 — 토스트 알림·사이드바 배지·웹 재생→앱 연동
 */
import { songbookChannelSlug } from './companion-links.js';
import { elements } from './ui/elements.js';
import { showNotification } from './utils.js';
import { state } from './state.js';
import {
  fetchAdminRequests,
  fetchPublicStatus,
  getSongbookToken,
  SongbookAuthError,
} from './songbook-requests-api.js';
import { findLibrarySong, playQueueItem, syncPlaybackQueueFromRequests } from './playback-queue.js';
import { isPlaceholderAudioPath, resolvePlayableAudioPath } from './youtube-utils.js';

const POLL_MS = 4000;

let pollTimer = null;
let lastPendingIds = new Set();
let lastPendingCount = 0;
let requestsTabVisible = false;
let seenPendingIds = new Set();
/** Last request id we already auto-played (or skipped) for remote play bridge. */
let lastAutoPlayRequestId = null;
let lastMissingPlayToastId = null;

function getSlug() {
  return songbookChannelSlug();
}

function updateBadge(count) {
  const badge = elements.requestsBadge || document.getElementById('requests-badge');
  if (!badge) return;
  if (requestsTabVisible || count <= 0) {
    badge.style.display = 'none';
    badge.textContent = '0';
    return;
  }
  badge.style.display = 'inline-flex';
  badge.textContent = String(Math.min(99, count));
}

function detectNewPending(requests) {
  const pending = (requests || []).filter((r) => r?.status === 'pending');
  const ids = new Set(pending.map((r) => r.id));
  const newcomers = pending.filter((r) => !lastPendingIds.has(r.id) && !seenPendingIds.has(r.id));

  if (lastPendingIds.size > 0 && newcomers.length > 0) {
    for (const item of newcomers.slice(0, 3)) {
      showNotification(`새 신청: ${item.title} - ${item.artist}`, 'info');
    }
  } else if (lastPendingCount > 0 && pending.length > lastPendingCount) {
    const latest = pending[pending.length - 1];
    if (latest) {
      showNotification(`새 신청: ${latest.title} - ${latest.artist}`, 'info');
    }
  }

  lastPendingIds = ids;
  lastPendingCount = pending.length;

  const unseen = pending.filter((r) => !seenPendingIds.has(r.id)).length;
  updateBadge(unseen);
}

function resolveNowPlaying(status, requests) {
  if (status?.nowPlaying?.id) return status.nowPlaying;
  return (requests || []).find((r) => r?.status === 'playing') || null;
}

function isPlayableLibrarySong(song) {
  const playable = resolvePlayableAudioPath(song);
  return Boolean(playable) && !isPlaceholderAudioPath(playable);
}

async function maybeAutoPlayFromRemote(status, requests, slug) {
  const nowPlaying = resolveNowPlaying(status, requests);
  const requestId = nowPlaying?.id || null;
  if (!requestId) {
    lastAutoPlayRequestId = null;
    return;
  }
  if (requestId === lastAutoPlayRequestId) return;

  const song = findLibrarySong(nowPlaying.title, nowPlaying.artist);
  if (!song || !isPlayableLibrarySong(song)) {
    if (lastMissingPlayToastId !== requestId) {
      showNotification(
        `웹에서 재생 요청: 라이브러리에 재생 가능한 음원이 없습니다 (${nowPlaying.title || '제목 없음'})`,
        'warning',
      );
      lastMissingPlayToastId = requestId;
    }
    lastAutoPlayRequestId = requestId;
    return;
  }

  if (state.currentTrack === song.path && state.isPlaying) {
    lastAutoPlayRequestId = requestId;
    return;
  }

  lastAutoPlayRequestId = requestId;
  try {
    await playQueueItem(
      {
        requestId,
        path: song.path,
        title: nowPlaying.title || song.title || '',
        artist: nowPlaying.artist || song.artist || '',
        status: 'playing',
      },
      { patchPlaying: false, slug, playNow: true },
    );
  } catch (err) {
    console.warn('[SongbookPoller] remote play failed', err);
    showNotification('웹 재생 연동에 실패했습니다.', 'error');
  }
}

async function pollOnce() {
  const slug = getSlug();
  const token = await getSongbookToken();
  if (!token || !slug) {
    stopSongbookRequestPoller();
    updateBadge(0);
    return;
  }

  try {
    const [status, requests] = await Promise.all([
      fetchPublicStatus(slug),
      fetchAdminRequests(slug),
    ]);
    detectNewPending(requests);
    syncPlaybackQueueFromRequests(requests);
    await maybeAutoPlayFromRemote(status, requests, slug);
    window.dispatchEvent(new CustomEvent('songbook-requests-updated', {
      detail: { status, requests, slug },
    }));
  } catch (err) {
    if (err instanceof SongbookAuthError) {
      window.dispatchEvent(new CustomEvent('songbook-requests-auth-expired'));
      stopSongbookRequestPoller();
    } else {
      console.warn('[SongbookPoller]', err);
    }
  }
}

export function startSongbookRequestPoller() {
  if (pollTimer !== null) return;
  void pollOnce();
  pollTimer = window.setInterval(() => void pollOnce(), POLL_MS);
}

export function stopSongbookRequestPoller() {
  if (pollTimer !== null) {
    window.clearInterval(pollTimer);
    pollTimer = null;
  }
  lastPendingIds = new Set();
  lastPendingCount = 0;
  updateBadge(0);
}

export async function refreshSongbookRequestsNow() {
  await pollOnce();
}

export function onRequestsTabShown() {
  requestsTabVisible = true;
  const pending = [...lastPendingIds];
  pending.forEach((id) => seenPendingIds.add(id));
  updateBadge(0);
}

export function onRequestsTabHidden() {
  requestsTabVisible = false;
  const unseen = [...lastPendingIds].filter((id) => !seenPendingIds.has(id)).length;
  updateBadge(unseen);
}

export function resetSongbookPollerState() {
  lastPendingIds = new Set();
  lastPendingCount = 0;
  seenPendingIds = new Set();
  lastAutoPlayRequestId = null;
  lastMissingPlayToastId = null;
  updateBadge(0);
}

/** Call when the app itself starts playback for a request (avoids double-play on next poll). */
export function markAutoPlayedRequest(requestId) {
  if (requestId) lastAutoPlayRequestId = requestId;
}

export async function initSongbookRequestPoller() {
  const token = await getSongbookToken();
  const slug = getSlug();
  if (token && slug) {
    startSongbookRequestPoller();
  }
}

export function onSongbookAuthChanged(loggedIn) {
  if (loggedIn && getSlug()) {
    resetSongbookPollerState();
    startSongbookRequestPoller();
  } else {
    stopSongbookRequestPoller();
    resetSongbookPollerState();
  }
}
