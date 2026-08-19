/**
 * Songbook 대기열 → 로컬 재생 큐 동기화 (수동 재생)
 */
import { state } from './state.js';
import { invoke } from './tauri-bridge.js';
import { showNotification } from './utils.js';
import { isPlaceholderAudioPath, resolvePlayableAudioPath } from './youtube-utils.js';

export function normalizeSongKey(title, artist) {
  return `${String(title || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')}\0${String(artist || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')}`;
}

export function findLibrarySong(title, artist) {
  const key = normalizeSongKey(title, artist);
  return (state.songLibrary || []).find(
    (song) => normalizeSongKey(song?.title, song?.artist) === key,
  ) || null;
}

function sortActiveRequests(requests) {
  return (requests || [])
    .filter((r) => r && (r.status === 'pending' || r.status === 'playing'))
    .sort((a, b) => {
      const ao = a.sortOrder ?? a.createdAt ?? 0;
      const bo = b.sortOrder ?? b.createdAt ?? 0;
      if (ao !== bo) return ao - bo;
      return (a.createdAt || 0) - (b.createdAt || 0);
    });
}

function buildQueueItems(requests) {
  const items = [];
  for (const req of sortActiveRequests(requests)) {
    const song = findLibrarySong(req.title, req.artist);
    const playable = resolvePlayableAudioPath(song);
    if (!playable || isPlaceholderAudioPath(playable)) continue;
    items.push({
      requestId: req.id,
      path: playable,
      title: req.title || song.title || '',
      artist: req.artist || song.artist || '',
      status: req.status,
    });
  }
  return items;
}

function queueItemsEqual(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  if (a.length !== b.length) return false;
  return a.every((item, i) => {
    const other = b[i];
    return item.requestId === other.requestId && item.path === other.path && item.status === other.status;
  });
}

export function isOverlayQueueVisible() {
  try {
    const raw = localStorage.getItem('overlayQueueVisible');
    return raw === null ? true : raw === 'true';
  } catch {
    return true;
  }
}

export function setOverlayQueueVisible(visible) {
  try {
    localStorage.setItem('overlayQueueVisible', visible ? 'true' : 'false');
  } catch {
    /* ignore */
  }
  void pushOverlayQueuePreview();
}

async function pushOverlayQueuePreview() {
  const show = isOverlayQueueVisible();
  const pending = (state.playbackQueue || [])
    .filter((item) => item.status !== 'playing')
    .slice(0, 3)
    .map((item) => ({ title: item.title, artist: item.artist }));

  try {
    await invoke('update_overlay_queue', {
      items: pending,
      showQueue: show,
    });
  } catch (err) {
    console.warn('[PlaybackQueue] overlay sync failed', err);
  }
}

export function syncPlaybackQueueFromRequests(requests) {
  const next = buildQueueItems(requests);
  const changed = !queueItemsEqual(state.playbackQueue, next);
  state.playbackQueue = next;
  if (changed) {
    void pushOverlayQueuePreview();
    window.dispatchEvent(new CustomEvent('playback-queue-changed'));
  }
  return changed;
}

export function clearPlaybackQueue() {
  state.playbackQueue = [];
  void pushOverlayQueuePreview();
  window.dispatchEvent(new CustomEvent('playback-queue-changed'));
}

export async function playQueueItem(item, { patchPlaying = true, slug, playNow = true } = {}) {
  if (!item?.path) {
    showNotification('라이브러리에 없는 곡입니다.', 'warning');
    return false;
  }

  const { playTrack } = await import('./audio.js');
  const { selectTrack } = await import('./player.js');
  const index = (state.songLibrary || []).findIndex((s) => {
    if (s.path === item.path) return true;
    return resolvePlayableAudioPath(s) === item.path;
  });

  if (patchPlaying && item.requestId && slug) {
    const { patchRequestStatus } = await import('./songbook-requests-api.js');
    await patchRequestStatus(slug, item.requestId, 'playing');
  }

  if (index >= 0) {
    await selectTrack(index, { playNow });
  } else {
    await playTrack(item.path, 0, playNow);
  }
  return true;
}

/**
 * 대기열에서 재생 중이던 곡이 끝나면: 완료 처리 후 다음 곡을 정지 상태로 로드.
 * @returns {Promise<boolean>} 다음 곡으로 넘어갔으면 true
 */
export async function advanceQueueAfterFinished() {
  const queue = state.playbackQueue || [];
  const currentPath = state.currentTrack?.path;
  if (!queue.length || !currentPath) return false;

  const currentIdx = queue.findIndex((item) => item.path === currentPath);
  if (currentIdx < 0) return false;

  const finished = queue[currentIdx];
  const nextItem = queue.slice(currentIdx + 1).find((item) => item?.path) || null;

  const { getActiveChannelSlug, patchRequestStatus } = await import('./songbook-requests-api.js');
  const slug = getActiveChannelSlug();

  try {
    if (finished.requestId && slug) {
      await patchRequestStatus(slug, finished.requestId, 'done');
    }
  } catch (err) {
    console.warn('[PlaybackQueue] mark done failed', err);
  }

  if (!nextItem) {
    try {
      const { refreshSongbookRequestsNow } = await import('./songbook-request-poller.js');
      await refreshSongbookRequestsNow();
    } catch {
      /* ignore */
    }
    return false;
  }

  try {
    if (nextItem.requestId && slug) {
      await patchRequestStatus(slug, nextItem.requestId, 'playing');
    }
  } catch (err) {
    console.warn('[PlaybackQueue] mark next playing failed', err);
  }

  const loaded = await playQueueItem(nextItem, {
    patchPlaying: false,
    playNow: false,
  });

  try {
    const { refreshSongbookRequestsNow } = await import('./songbook-request-poller.js');
    await refreshSongbookRequestsNow();
  } catch {
    /* ignore */
  }

  return loaded;
}

/**
 * 독 다음/이전: 신청목록 재생 큐 안에서 이동.
 * 현재 곡이 큐에 있을 때만 동작. 성공 시 true (라이브러리 fallback 생략).
 * @param {'next' | 'prev'} direction
 * @returns {Promise<boolean>}
 */
export async function navigatePlaybackQueue(direction) {
  const queue = state.playbackQueue || [];
  const currentPath = state.currentTrack?.path;
  if (!queue.length || !currentPath) return false;

  const currentIdx = queue.findIndex((item) => item.path === currentPath);
  if (currentIdx < 0) return false;

  const { getActiveChannelSlug, patchRequestStatus } = await import('./songbook-requests-api.js');
  const slug = getActiveChannelSlug();

  if (direction === 'next') {
    const finished = queue[currentIdx];
    const nextItem = queue.slice(currentIdx + 1).find((item) => item?.path) || null;
    if (!nextItem) return false;

    try {
      if (finished.requestId && slug) {
        await patchRequestStatus(slug, finished.requestId, 'done');
      }
    } catch (err) {
      console.warn('[PlaybackQueue] mark done failed', err);
    }

    const loaded = await playQueueItem(nextItem, {
      patchPlaying: true,
      slug,
      playNow: true,
    });

    try {
      const { refreshSongbookRequestsNow } = await import('./songbook-request-poller.js');
      await refreshSongbookRequestsNow();
    } catch {
      /* ignore */
    }

    return loaded;
  }

  if (direction === 'prev') {
    if (currentIdx <= 0) return false;
    const prevItem = queue[currentIdx - 1];
    if (!prevItem?.path) return false;

    const loaded = await playQueueItem(prevItem, {
      patchPlaying: true,
      slug,
      playNow: true,
    });

    try {
      const { refreshSongbookRequestsNow } = await import('./songbook-request-poller.js');
      await refreshSongbookRequestsNow();
    } catch {
      /* ignore */
    }

    return loaded;
  }

  return false;
}
