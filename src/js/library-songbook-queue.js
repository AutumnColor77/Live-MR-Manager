/**
 * 라이브러리 곡 → Songbook 신청목록(대기열) 추가
 */
import { invoke } from './tauri-bridge.js';
import { showNotification } from './utils.js';
import { normalizeSongKey } from './playback-queue.js';
import {
  createRequest,
  fetchPublicSongs,
  getActiveChannelSlug,
  getSongbookToken,
  SongbookAuthError,
} from './songbook-requests-api.js';
import {
  acknowledgePendingRequestIds,
  refreshSongbookRequestsNow,
} from './songbook-request-poller.js';

const CATALOG_TTL_MS = 30_000;
let catalogCache = { slug: '', at: 0, songs: [] };

async function loadCatalog(slug) {
  if (catalogCache.slug === slug && Date.now() - catalogCache.at < CATALOG_TTL_MS) {
    return catalogCache.songs;
  }
  const songs = await fetchPublicSongs(slug);
  catalogCache = { slug, at: Date.now(), songs };
  return songs;
}

function songIdFromPath(song) {
  const path = String(song?.path || '');
  const match = /^songbook:song:(.+)$/.exec(path);
  return match?.[1] || null;
}

function resolveRemoteSongId(song, catalog) {
  const fromPath = songIdFromPath(song);
  if (fromPath && (catalog || []).some((item) => item.id === fromPath)) {
    return fromPath;
  }
  const key = normalizeSongKey(song?.title, song?.artist);
  const match = (catalog || []).find(
    (item) => normalizeSongKey(item?.title, item?.artist) === key,
  );
  return match?.id || null;
}

function friendlyRequestError(err) {
  const msg = String(err?.message || '').trim();
  if (!msg || /^not found$/i.test(msg) || /song not found/i.test(msg)) {
    return '노래책에 없는 곡입니다. 설정에서 보내기를 먼저 하세요.';
  }
  return msg;
}

async function operatorNickname() {
  const auth = await invoke('get_songbook_auth').catch(() => null);
  const name = String(auth?.user?.name || '').trim();
  return name || undefined;
}

/**
 * @param {object[]} songs
 * @returns {Promise<{ added: number, skipped: number, missing: number }>}
 */
export async function addLibrarySongsToRequests(songs) {
  const list = (songs || []).filter(Boolean);
  if (list.length === 0) {
    return { added: 0, skipped: 0, missing: 0 };
  }

  const token = await getSongbookToken();
  if (!token) {
    showNotification('Songbook 로그인이 필요합니다.', 'error');
    return { added: 0, skipped: 0, missing: 0 };
  }

  const slug = getActiveChannelSlug();
  if (!slug) {
    showNotification('채널이 없습니다. 설정에서 보내기로 채널을 만들어 주세요.', 'warning');
    return { added: 0, skipped: 0, missing: 0 };
  }

  const catalog = await loadCatalog(slug);
  const nickname = await operatorNickname();
  let added = 0;
  let skipped = 0;
  let missing = 0;
  const createdIds = [];

  for (const song of list) {
    const songId = resolveRemoteSongId(song, catalog);
    if (!songId) {
      missing += 1;
      continue;
    }
    try {
      const request = await createRequest(slug, { songId, nickname });
      const id = request?.id;
      if (id) createdIds.push(id);
      added += 1;
    } catch (err) {
      if (err instanceof SongbookAuthError) {
        showNotification('세션이 만료되었습니다. 다시 로그인해 주세요.', 'error');
        window.dispatchEvent(new CustomEvent('songbook-requests-auth-expired'));
        return { added, skipped, missing };
      }
      skipped += 1;
      if (list.length === 1) {
        showNotification(friendlyRequestError(err), 'error');
        return { added, skipped, missing };
      }
    }
  }

  if (createdIds.length) {
    acknowledgePendingRequestIds(createdIds);
    await refreshSongbookRequestsNow();
  }

  if (list.length === 1) {
    if (added === 1) {
      const title = String(list[0].title || '곡').trim() || '곡';
      showNotification(`신청목록에 추가했습니다: ${title}`, 'success');
    } else if (missing === 1) {
      showNotification('노래책에 없는 곡입니다. 설정에서 보내기를 먼저 하세요.', 'warning');
    }
    return { added, skipped, missing };
  }

  if (added > 0) {
    const extra = [
      missing > 0 ? `없음 ${missing}` : '',
      skipped > 0 ? `건너뜀 ${skipped}` : '',
    ].filter(Boolean);
    showNotification(
      extra.length
        ? `신청목록에 ${added}곡을 추가했습니다. (${extra.join(' · ')})`
        : `신청목록에 ${added}곡을 추가했습니다.`,
      missing || skipped ? 'warning' : 'success',
    );
  } else if (missing === list.length) {
    showNotification('노래책에 없는 곡입니다. 설정에서 보내기를 먼저 하세요.', 'warning');
  } else if (skipped > 0) {
    showNotification('신청목록에 추가하지 못했습니다.', 'error');
  }

  return { added, skipped, missing };
}
