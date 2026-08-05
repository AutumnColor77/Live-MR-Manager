/**
 * Songbook 신청 백그라운드 폴링 — 토스트 알림·사이드바 배지
 */
import { songbookChannelSlug } from './companion-links.js';
import { elements } from './ui/elements.js';
import { showNotification } from './utils.js';
import {
  fetchAdminRequests,
  fetchPublicStatus,
  getSongbookToken,
  SongbookAuthError,
} from './songbook-requests-api.js';
import { syncPlaybackQueueFromRequests } from './playback-queue.js';

const POLL_MS = 4000;

let pollTimer = null;
let lastPendingIds = new Set();
let lastPendingCount = 0;
let requestsTabVisible = false;
let seenPendingIds = new Set();

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
  updateBadge(0);
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
