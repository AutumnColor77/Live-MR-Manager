/**
 * Songbook 채널로 앱 라이브러리 Push
 * - 본인 채널만 (demo 차단)
 * - 없으면 Songbook 내 계정(/me)에서 채널을 만들도록 안내
 * - 신규 POST / 기존 PATCH (메타 갱신)
 * - 로컬에 없는 원격 곡은 enabled=false (공개 목록에서 제거, 신청 이력 FK 보존)
 * - 웹에서 추가한 곡(origin=web)은 앱에서 지운 적이 없으면 숨기지 않는다. origin이 없으면 push로 본다.
 * - 앱에서 삭제한 곡은 origin과 관계없이 웹에서 숨기고, 가져오기로 되돌리지 않는다.
 * - 로컬에 보낼 YouTube URL이 없으면 PATCH에서 originalUrl을 빼 원격 링크를 유지한다.
 * - isMr인 곡은 tags에 "MR"을 한 번만 붙인다. Pull은 MR 태그가 있을 때만 isMr를 켠다.
 */
import {
  applySongbookChannels,
  pickOwnChannel,
  songbookBase,
  SONGBOOK_SLUG_RE,
} from './companion-links.js';
import { prepareSongbookThumbnail } from './songbook-thumbnail.js';
import { songbookFetch, songbookErrorMessage } from './songbook-api.js';
import { invoke } from './tauri-bridge.js';
import { showNotification } from './utils.js';
import { resolveMediaUrlFromRecord, pickSongbookPushOriginalUrl } from './youtube-utils.js';

const SYNC_CONCURRENCY = 5;
const DELETED_SONG_KEYS = 'songbook_deleted_keys';
const songbookPlayableUrlCache = new Map();
export const CHANNEL_SETUP_REQUIRED = 'CHANNEL_SETUP_REQUIRED';
const CHANNEL_SETUP_TITLE = 'Songbook 채널이 필요합니다';
const CHANNEL_SETUP_MESSAGE = '동기화하려면 Songbook 채널이 필요합니다. 웹사이트에서 채널을 만든 뒤 다시 동기화해 주세요.';
const CHANNEL_SETUP_TOAST = '브라우저에서 채널을 만든 뒤 다시 동기화해 주세요.';

/** Run async work over items with a concurrency cap. */
async function mapPool(items, concurrency, fn) {
  if (items.length === 0) return [];
  const results = new Array(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(concurrency, items.length);

  async function worker() {
    while (true) {
      const i = nextIndex;
      nextIndex += 1;
      if (i >= items.length) break;
      results[i] = await fn(items[i], i);
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

function normalizeKey(title, artist) {
  return `${String(title || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')}\0${String(artist || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')}`;
}

function normalizeTags(tags) {
  if (!Array.isArray(tags)) return [];
  return tags.map(String).map((t) => t.trim()).filter(Boolean);
}

/** Songbook marks instrumentals with an "MR" tag; the app uses `isMr`. */
function hasMrTag(tags) {
  return normalizeTags(tags).some((t) => t.toUpperCase() === 'MR');
}

export function pushTags(song) {
  const tags = normalizeTags(song?.tags);
  const isMr = Boolean(song?.isMr || song?.is_mr);
  return isMr && !hasMrTag(tags) ? ['MR', ...tags] : tags;
}

/** Missing or unknown origin is treated as an app push. */
function songOrigin(remote) {
  return String(remote?.origin || '').trim().toLowerCase() === 'web' ? 'web' : 'push';
}

function readDeletedSongKeys() {
  try {
    const raw = JSON.parse(localStorage.getItem(DELETED_SONG_KEYS) || '[]');
    if (!Array.isArray(raw)) return new Set();
    return new Set(raw.filter((key) => typeof key === 'string' && key));
  } catch {
    return new Set();
  }
}

function writeDeletedSongKeys(keys) {
  localStorage.setItem(DELETED_SONG_KEYS, JSON.stringify([...keys]));
}

/** Remember a library delete so the next sync does not import that song again. */
export function rememberSongbookDeletion(song) {
  const title = String(song?.title || '').trim();
  if (!title) return;
  const keys = readDeletedSongKeys();
  keys.add(normalizeKey(title, song?.artist));
  writeDeletedSongKeys(keys);
}

/** Drop deletion marks for songs that are in the library again. */
export function forgetSongbookDeletions(songs) {
  const keys = readDeletedSongKeys();
  if (!keys.size) return keys;
  let changed = false;
  for (const song of songs || []) {
    const title = String(song?.title || '').trim();
    if (!title) continue;
    if (keys.delete(normalizeKey(title, song.artist))) changed = true;
  }
  if (changed) writeDeletedSongKeys(keys);
  return keys;
}

/**
 * Remote songs Push may hide. Web-created songs stay unless the user deleted them in the app.
 * @param {object[]} remoteSongs
 * @param {Set<string>} localKeys normalizeKey(title, artist)
 * @param {Set<string>} [deletedKeys]
 */
export function remoteSongsToDisable(remoteSongs, localKeys, deletedKeys) {
  const deleted = deletedKeys instanceof Set ? deletedKeys : new Set();
  return remoteSongs.filter((s) => {
    if (!s?.id || s.enabled === false) return false;
    const key = normalizeKey(s.title, s.artist);
    if (localKeys.has(key)) return false;
    if (songOrigin(s) === 'web' && !deleted.has(key)) return false;
    return true;
  });
}

function tagsEqual(a, b) {
  const left = normalizeTags(a).slice().sort();
  const right = normalizeTags(b).slice().sort();
  if (left.length !== right.length) return false;
  return left.every((v, i) => v === right[i]);
}

/** 앱 큐레이션 카테고리 (인기/감성 등) */
function mapSongbookCategory(song) {
  const raw = String(
    song?.categories?.[0] || song?.curationCategory || song?.category || '',
  ).trim();
  return raw.slice(0, 40);
}

/** 앱 장르 (K-POP/Ballad 등) */
function mapSongbookGenre(song) {
  const raw = String(song?.genre || '').trim();
  return raw.slice(0, 40) || '미분류';
}

function authHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };
}

function mapSongbookDifficulty(song) {
  const raw = song?.difficulty;
  const n =
    typeof raw === 'number'
      ? raw
      : raw != null && raw !== ''
        ? Number(raw)
        : NaN;
  if (!Number.isFinite(n)) return null;
  const rounded = Math.round(n);
  if (rounded < 1 || rounded > 5) return null;
  return rounded;
}

function mapSongbookDonationAmount(song) {
  const raw = song?.donationAmount ?? song?.donation_amount;
  const n =
    typeof raw === 'number'
      ? raw
      : raw != null && raw !== ''
        ? Number(raw)
        : NaN;
  if (!Number.isFinite(n)) return null;
  const rounded = Math.round(n);
  if (rounded < 0 || rounded > 100_000_000) return null;
  return rounded;
}

/** YouTube http(s) only — never upload local file paths. */
function pickOriginalUrl(song) {
  return pickSongbookPushOriginalUrl(song);
}

function resolveRemoteMediaUrl(remote) {
  return resolveMediaUrlFromRecord(remote);
}

/**
 * Songbook placeholder(`songbook:song:*`) 재생 시 서버에 저장된 URL을 조회.
 * 로컬 Pull 이후 서버에 URL이 추가된 경우에도 재생 가능하게 한다.
 */
export async function lookupSongbookPlayableUrl(song) {
  const path = String(song?.path || '').trim();
  const match = /^songbook:song:(.+)$/.exec(path);
  if (!match) return null;
  if (songbookPlayableUrlCache.has(path)) {
    return songbookPlayableUrlCache.get(path);
  }

  try {
    const { token } = await getAuthOrThrow();
    const channel = await resolveOwnChannel(token);
    const base = songbookBase();
    const listUrl = `${base}/api/c/${encodeURIComponent(channel.slug)}/admin/songs`;
    const res = await songbookFetch(listUrl, { headers: authHeaders(token) });
    if (!res.ok) {
      songbookPlayableUrlCache.set(path, null);
      return null;
    }
    const json = await res.json();
    const songs = Array.isArray(json?.songs) ? json.songs : [];
    const remoteId = match[1];
    const remote = songs.find((entry) => String(entry?.id || '') === remoteId)
      || songs.find((entry) => normalizeKey(entry?.title, entry?.artist) === normalizeKey(song?.title, song?.artist));
    const url = resolveRemoteMediaUrl(remote);
    songbookPlayableUrlCache.set(path, url || null);
    return url || null;
  } catch {
    songbookPlayableUrlCache.set(path, null);
    return null;
  }
}

function resolveRemoteThumbnail(remoteThumb) {
  const value = String(remoteThumb || '').trim();
  if (!value) return '';
  if (value.startsWith('/api/media/thumbs/')) {
    return `${songbookBase()}${value}`;
  }
  return value;
}

function withoutEmptyOriginalUrl(payload) {
  if (!String(payload?.originalUrl || '').trim()) {
    const next = { ...payload };
    delete next.originalUrl;
    return next;
  }
  return payload;
}

function buildMetaPayload(song) {
  const title = String(song?.title || '').trim();
  const artist = String(song?.artist || '').trim() || 'Unknown';
  const bpmRaw = song?.bpm;
  const bpm =
    typeof bpmRaw === 'number' && Number.isFinite(bpmRaw)
      ? Math.round(bpmRaw)
      : bpmRaw != null && bpmRaw !== '' && Number.isFinite(Number(bpmRaw))
        ? Math.round(Number(bpmRaw))
        : null;
  return {
    title,
    artist,
    category: mapSongbookCategory(song),
    genre: mapSongbookGenre(song),
    tags: pushTags(song),
    songKey: song?.songKey ?? song?.song_key ?? null,
    bpm,
    difficulty: mapSongbookDifficulty(song),
    donationAmount: mapSongbookDonationAmount(song),
    originalUrl: pickOriginalUrl(song),
    enabled: true,
  };
}

function localHttpThumbnail(song) {
  const raw = String(song?.thumbnail || '').trim();
  if (/^https?:\/\//i.test(raw) && raw.length <= 2048) return raw;
  return '';
}

function thumbnailNeedsUpload(song, remoteThumb) {
  const raw = String(song?.thumbnail || '').trim();
  if (!raw) return false;
  const httpThumb = localHttpThumbnail(song);
  if (httpThumb) {
    return thumbnailNeedsPatch(remoteThumb, httpThumb);
  }
  const remote = String(remoteThumb || '').trim();
  if (!remote) return true;
  return false;
}

async function buildPostPayload(song) {
  return {
    ...buildMetaPayload(song),
    thumbnail: await prepareSongbookThumbnail(song),
    enabled: true,
  };
}

/**
 * Meta fields for PATCH. Omits originalUrl when this app has no YouTube URL to send,
 * so a web-entered non-YouTube link is left alone.
 * @returns {object|null}
 */
export function buildSongbookMetaPatch(song, existing) {
  const meta = withoutEmptyOriginalUrl(buildMetaPayload(song));
  if (!needsMetaPatch(existing, meta) && existing?.enabled !== false) return null;
  return { ...meta, enabled: true };
}

/** PATCH payload; null if nothing to send. */
async function buildPatchPayload(song, existing) {
  const meta = withoutEmptyOriginalUrl(buildMetaPayload(song));
  const httpThumb = localHttpThumbnail(song);
  const metaPatch = needsMetaPatch(existing, meta);
  const thumbPatch = thumbnailNeedsUpload(song, existing.thumbnail);

  if (!metaPatch && !thumbPatch && existing.enabled !== false) {
    return null;
  }

  const payload = { ...meta, enabled: true };
  if (thumbPatch) {
    payload.thumbnail = await prepareSongbookThumbnail(song);
  } else if (httpThumb) {
    payload.thumbnail = httpThumb;
  }
  return payload;
}

function thumbnailNeedsPatch(remoteThumb, localThumb) {
  const remote = String(remoteThumb || '').trim();
  const local = String(localThumb || '').trim();
  if (!local) return false;
  if (!remote) return true;
  // http(s) URL이 바뀐 경우만 갱신 (data URL은 재인코딩마다 달라져 스킵)
  if (/^https?:\/\//i.test(local) && remote !== local) return true;
  return false;
}

function needsMetaPatch(remote, localPayload) {
  if (
    String(remote.category || '')
      .trim()
      .toLowerCase() !==
    String(localPayload.category || '')
      .trim()
      .toLowerCase()
  ) {
    return true;
  }
  if (
    String(remote.genre || '')
      .trim()
      .toLowerCase() !==
    String(localPayload.genre || '')
      .trim()
      .toLowerCase()
  ) {
    return true;
  }
  if (!tagsEqual(remote.tags, localPayload.tags)) return true;
  const remoteKey = remote.songKey ?? null;
  const localKey = localPayload.songKey ?? null;
  if (String(remoteKey || '') !== String(localKey || '')) return true;
  const remoteBpm = remote.bpm ?? null;
  const localBpm = localPayload.bpm ?? null;
  if (remoteBpm !== localBpm) return true;
  const remoteDiff = remote.difficulty ?? null;
  const localDiff = localPayload.difficulty ?? null;
  if (remoteDiff !== localDiff) return true;
  const remoteDonation = remote.donationAmount ?? null;
  const localDonation = localPayload.donationAmount ?? null;
  if (remoteDonation !== localDonation) return true;
  const localUrl = String(localPayload.originalUrl || '').trim();
  // No local YouTube URL means "leave the remote link", including non-YouTube http(s).
  if (localUrl) {
    const remoteUrl = String(remote.originalUrl || remote.original_url || '').trim();
    if (remoteUrl !== localUrl) return true;
  }
  if (remote.enabled === false) return true;
  return false;
}

function needsPatch(remote, localPayload) {
  if (needsMetaPatch(remote, localPayload)) return true;
  if (thumbnailNeedsPatch(remote.thumbnail, localPayload.thumbnail)) return true;
  return false;
}

async function getAuthOrThrow() {
  const raw = await invoke('get_songbook_auth');
  const loggedIn = Boolean(raw?.loggedIn ?? raw?.logged_in);
  const token = raw?.token ?? null;
  if (!loggedIn || !token) {
    throw new Error('Songbook 로그인이 필요합니다.');
  }
  return { token, user: raw?.user ?? null };
}

async function fetchMeChannels(token) {
  const res = await songbookFetch(`${songbookBase()}/api/auth/me`, {
    headers: authHeaders(token),
  });
  if (res.status === 401) {
    throw new Error('AUTH_EXPIRED');
  }
  if (!res.ok) {
    throw new Error(`계정 채널 조회 실패 (${res.status})`);
  }
  const data = await res.json();
  const channels = Array.isArray(data.channels) ? data.channels : [];
  const primary = applySongbookChannels(channels);
  updateSongbookChannelLabel(primary, channels);
  return { user: data.user, channels, own: pickOwnChannel(channels) };
}

function confirmAsync(title, message, options = {}) {
  return new Promise(async (resolve) => {
    const { openConfirmModal } = await import('./ui/modals.js');
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    openConfirmModal(title, message, () => finish(true), options);
    const cancelBtn =
      document.getElementById('confirm-cancel') || document.getElementById('confirm-no');
    const closeIcon = document.getElementById('confirm-close-icon');
    const modal = document.getElementById('confirm-modal');
    const wrapCancel = () => finish(false);
    if (cancelBtn) {
      const prev = cancelBtn.onclick;
      cancelBtn.onclick = () => {
        if (typeof prev === 'function') prev();
        wrapCancel();
      };
    }
    if (closeIcon) {
      const prev = closeIcon.onclick;
      closeIcon.onclick = () => {
        if (typeof prev === 'function') prev();
        wrapCancel();
      };
    }
    if (modal) {
      const prev = modal.onclick;
      modal.onclick = (e) => {
        if (typeof prev === 'function') prev(e);
        if (e.target === modal) wrapCancel();
      };
    }
  });
}

function channelSetupRequired() {
  const err = new Error(CHANNEL_SETUP_REQUIRED);
  err.code = CHANNEL_SETUP_REQUIRED;
  return err;
}

function isChannelSetupRequired(err) {
  return err?.code === CHANNEL_SETUP_REQUIRED || err?.message === CHANNEL_SETUP_REQUIRED;
}

async function openExternalUrl(url) {
  if (window.__TAURI__?.core?.invoke) {
    try {
      await window.__TAURI__.core.invoke('plugin:opener|open_url', { url });
      return;
    } catch (err) {
      console.warn('[SongbookSync] opener failed, fallback', err);
    }
    try {
      await invoke('open_app_update_page', { url });
      return;
    } catch (err) {
      console.warn('[SongbookSync] open_app_update_page failed', err);
    }
  }
  const opened = window.open(url, '_blank', 'noopener');
  if (!opened) throw new Error('팝업이 차단되었습니다.');
}

/** 채널이 없을 때 Songbook 내 계정 페이지를 열어 채널 생성을 안내한다. */
export async function promptOpenSongbookChannelSetup() {
  const ok = await confirmAsync(CHANNEL_SETUP_TITLE, CHANNEL_SETUP_MESSAGE, {
    confirmLabel: 'Songbook 열기',
  });
  if (!ok) return false;
  try {
    await openExternalUrl(`${songbookBase()}/me`);
  } catch (err) {
    console.error('[SongbookSync] open account failed', err);
    showNotification('Songbook 페이지를 열지 못했습니다.', 'error');
    return false;
  }
  showNotification(CHANNEL_SETUP_TOAST, 'info');
  return true;
}

async function resolveOwnChannel(token) {
  const { own } = await fetchMeChannels(token);
  if (own?.slug && own.slug !== 'demo') {
    if (!SONGBOOK_SLUG_RE.test(own.slug)) {
      throw new Error('채널 slug 형식이 올바르지 않습니다.');
    }
    return own;
  }
  throw channelSetupRequired();
}

/**
 * @returns {Promise<{ added: number, updated: number, removed: number, skipped: number, failed: number, total: number, slug: string }>}
 */
export async function pushLibraryToSongbook({ onProgress } = {}) {
  const { token } = await getAuthOrThrow();
  const channel = await resolveOwnChannel(token);
  const slug = channel.slug;

  const base = songbookBase();
  const headers = authHeaders(token);
  const listUrl = `${base}/api/c/${encodeURIComponent(slug)}/admin/songs`;

  const remoteRes = await songbookFetch(listUrl, { headers });
  if (remoteRes.status === 401) throw new Error('AUTH_EXPIRED');
  if (remoteRes.status === 404) {
    throw new Error(`채널 '${slug}'을(를) 찾을 수 없습니다.`);
  }
  if (!remoteRes.ok) {
    throw new Error(`원격 목록 조회 실패 (${remoteRes.status})`);
  }

  const remoteJson = await remoteRes.json();
  const remoteSongs = Array.isArray(remoteJson?.songs) ? remoteJson.songs : [];
  const remoteByKey = new Map(
    remoteSongs.map((s) => [normalizeKey(s.title, s.artist), s]),
  );

  const localSongs = await invoke('get_songs');
  const list = Array.isArray(localSongs) ? localSongs : [];
  const localKeys = new Set();

  const stats = {
    added: 0,
    updated: 0,
    removed: 0,
    skipped: 0,
    failed: 0,
    completed: 0,
  };

  const reportProgress = (total) => {
    onProgress?.({
      index: stats.completed,
      total,
      added: stats.added,
      updated: stats.updated,
      removed: stats.removed,
      skipped: stats.skipped,
      failed: stats.failed,
    });
  };

  let progressLock = Promise.resolve();
  const bumpProgress = (total, delta) => {
    progressLock = progressLock.then(() => {
      stats.added += delta.added || 0;
      stats.updated += delta.updated || 0;
      stats.skipped += delta.skipped || 0;
      stats.failed += delta.failed || 0;
      stats.completed += 1;
      reportProgress(total);
    });
    return progressLock;
  };

  await mapPool(list, SYNC_CONCURRENCY, async (song) => {
    const delta = { added: 0, updated: 0, skipped: 0, failed: 0 };
    const meta = buildMetaPayload(song);
    if (!meta.title) {
      delta.skipped = 1;
      await bumpProgress(list.length, delta);
      return;
    }

    const key = normalizeKey(meta.title, meta.artist);
    localKeys.add(key);
    const existing = remoteByKey.get(key);

    try {
      if (existing?.id) {
        const payload = await buildPatchPayload(song, existing);
        if (!payload) {
          delta.skipped = 1;
        } else {
          const res = await songbookFetch(`${listUrl}/${encodeURIComponent(existing.id)}`, {
            method: 'PATCH',
            headers,
            body: JSON.stringify(payload),
          });
          if (res.ok) {
            delta.updated = 1;
            const body = await res.json().catch(() => null);
            if (body?.song) remoteByKey.set(key, body.song);
          } else {
            delta.failed = 1;
            console.warn('[SongbookSync] PATCH failed', res.status, await res.text().catch(() => ''));
          }
        }
      } else {
        const payload = await buildPostPayload(song);
        const res = await songbookFetch(listUrl, {
          method: 'POST',
          headers,
          body: JSON.stringify(payload),
        });
        if (res.ok) {
          delta.added = 1;
          const body = await res.json().catch(() => null);
          if (body?.song) remoteByKey.set(key, body.song);
          else remoteByKey.set(key, { ...payload, id: 'pending' });
        } else {
          delta.failed = 1;
          console.warn('[SongbookSync] POST failed', res.status, await res.text().catch(() => ''));
        }
      }
    } catch (err) {
      delta.failed = 1;
      console.warn('[SongbookSync] request error', err);
    }

    await bumpProgress(list.length, delta);
  });

  // 앱 라이브러리에 없는 원격 곡 → 공개 목록에서 숨김 (재동기화 시 enabled 복구).
  // origin=web 은 앱에서 삭제한 곡만 숨긴다. 한 번도 지우지 않은 웹 곡은 이어서 가져온다.
  // TODO: PUT /songs/sync 의 disableMissing 으로 옮기면 서버가 origin=web 을 지켜 준다. 이번엔 곡별 PATCH를 유지한다.
  const deletedKeys = forgetSongbookDeletions(list);
  const toDisable = remoteSongsToDisable(remoteSongs, localKeys, deletedKeys);

  const disableTotal = list.length + toDisable.length;
  let disableProgressLock = Promise.resolve();
  let disableCompleted = list.length;

  await mapPool(toDisable, SYNC_CONCURRENCY, async (remote) => {
    let removedDelta = 0;
    let failedDelta = 0;
    try {
      const res = await songbookFetch(`${listUrl}/${encodeURIComponent(remote.id)}`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ enabled: false }),
      });
      if (res.ok) {
        removedDelta = 1;
      } else {
        failedDelta = 1;
        console.warn(
          '[SongbookSync] disable failed',
          res.status,
          await res.text().catch(() => ''),
        );
      }
    } catch (err) {
      failedDelta = 1;
      console.warn('[SongbookSync] disable error', err);
    }

    disableProgressLock = disableProgressLock.then(() => {
      stats.removed += removedDelta;
      stats.failed += failedDelta;
      disableCompleted += 1;
      onProgress?.({
        index: disableCompleted,
        total: disableTotal,
        added: stats.added,
        updated: stats.updated,
        removed: stats.removed,
        skipped: stats.skipped,
        failed: stats.failed,
      });
    });
    await disableProgressLock;
  });

  return {
    added: stats.added,
    updated: stats.updated,
    removed: stats.removed,
    skipped: stats.skipped,
    failed: stats.failed,
    total: list.length,
    slug,
  };
}

export function applyRemoteMetaToLocal(local, remote) {
  const next = { ...local };
  next.title = String(remote.title || local.title || '').trim() || local.title;
  next.artist = String(remote.artist || local.artist || '').trim() || local.artist;
  next.songKey = remote.songKey ?? remote.song_key ?? local.songKey ?? null;
  next.bpm = remote.bpm ?? local.bpm ?? null;
  next.difficulty = remote.difficulty ?? local.difficulty ?? null;
  next.tags = normalizeTags(remote.tags?.length ? remote.tags : local.tags);
  // Only promote: older pushes never sent the MR tag, so its absence must not clear a local flag.
  if (hasMrTag(remote.tags)) {
    next.isMr = true;
    next.is_mr = true;
  }
  const category = String(remote.category || '').trim();
  if (category) {
    next.categories = [category];
    next.curationCategory = category;
  }
  const genre = String(remote.genre || '').trim();
  if (genre) next.genre = genre;
  const thumb = resolveRemoteThumbnail(remote.thumbnail);
  if (thumb) next.thumbnail = thumb;
  const url = resolveRemoteMediaUrl(remote);
  if (url) {
    next.originalUrl = url;
    next.original_url = url;
    const localPath = String(local.path || '').trim();
    const localIsHttp = /^https?:\/\//i.test(localPath);
    const shouldBindYoutube =
      !localPath
      || localPath.startsWith('songbook:')
      || localPath.startsWith('meloming:')
      || (!localIsHttp && String(local.source || '').toLowerCase() === 'youtube')
      || (!localIsHttp && !/\.(mp3|wav|flac|m4a|aac|ogg|wma|opus)$/i.test(localPath));
    if (shouldBindYoutube) {
      next.path = url;
      next.source = 'youtube';
    }
  }
  return next;
}

function buildImportedSong(remote) {
  const title = String(remote.title || '').trim();
  const artist = String(remote.artist || '').trim() || 'Unknown';
  const url = resolveRemoteMediaUrl(remote);
  const hasUrl = Boolean(url);
  const remoteId = String(remote.id || '').trim() || `unknown-${Date.now()}`;
  const category = String(remote.category || '').trim();
  const now = Math.floor(Date.now() / 1000);
  return {
    id: null,
    title,
    artist,
    path: hasUrl ? url : `songbook:song:${remoteId}`,
    source: hasUrl ? 'youtube' : 'songbook',
    thumbnail: resolveRemoteThumbnail(remote.thumbnail),
    duration: '0:00',
    pitch: 0,
    tempo: 1,
    volume: 100,
    tags: normalizeTags(remote.tags),
    genre: String(remote.genre || '').trim() || null,
    categories: category ? [category] : null,
    curationCategory: category || null,
    playCount: 0,
    dateAdded: now,
    isMr: hasMrTag(remote.tags),
    is_mr: hasMrTag(remote.tags),
    songKey: remote.songKey ?? remote.song_key ?? null,
    bpm: remote.bpm ?? null,
    difficulty: remote.difficulty ?? null,
    originalUrl: hasUrl ? url : null,
    original_url: hasUrl ? url : null,
  };
}

/**
 * Pull enabled (and all admin-visible) remote songs into local library.
 * @returns {Promise<{ added: number, updated: number, placeholders: number, skipped: number, total: number, slug: string }>}
 */
export async function pullLibraryFromSongbook({ onProgress } = {}) {
  const { token } = await getAuthOrThrow();
  const channel = await resolveOwnChannel(token);
  const slug = channel.slug;

  const base = songbookBase();
  const headers = authHeaders(token);
  const listUrl = `${base}/api/c/${encodeURIComponent(slug)}/admin/songs`;

  const remoteRes = await songbookFetch(listUrl, { headers });
  if (remoteRes.status === 401) throw new Error('AUTH_EXPIRED');
  if (remoteRes.status === 404) {
    throw new Error(`채널 '${slug}'을(를) 찾을 수 없습니다.`);
  }
  if (!remoteRes.ok) {
    throw new Error(`원격 목록 조회 실패 (${remoteRes.status})`);
  }

  const remoteJson = await remoteRes.json();
  const deletedKeys = readDeletedSongKeys();
  const remoteSongs = (Array.isArray(remoteJson?.songs) ? remoteJson.songs : []).filter(
    (s) => s && s.enabled !== false && !deletedKeys.has(normalizeKey(s.title, s.artist)),
  );

  const localSongs = await invoke('get_songs');
  const library = Array.isArray(localSongs) ? [...localSongs] : [];
  const byKey = new Map(library.map((s) => [normalizeKey(s.title, s.artist), s]));

  let added = 0;
  let updated = 0;
  let placeholders = 0;
  let skipped = 0;
  const merged = [...library];

  for (let i = 0; i < remoteSongs.length; i++) {
    const remote = remoteSongs[i];
    const title = String(remote.title || '').trim();
    if (!title) {
      skipped += 1;
      continue;
    }
    const key = normalizeKey(title, remote.artist);
    const existing = byKey.get(key);
    if (existing) {
      const next = applyRemoteMetaToLocal(existing, remote);
      const idx = merged.findIndex((s) => s === existing || normalizeKey(s.title, s.artist) === key);
      if (idx >= 0) {
        merged[idx] = next;
        byKey.set(key, next);
        updated += 1;
      } else {
        skipped += 1;
      }
    } else {
      const created = buildImportedSong(remote);
      merged.push(created);
      byKey.set(key, created);
      added += 1;
      if (created.source === 'songbook') placeholders += 1;
    }
    onProgress?.({
      index: i + 1,
      total: remoteSongs.length,
      added,
      updated,
      placeholders,
      skipped,
    });
  }

  if (added > 0 || updated > 0) {
    await invoke('save_library', { songs: merged });
  }

  songbookPlayableUrlCache.clear();

  return {
    added,
    updated,
    placeholders,
    skipped,
    total: remoteSongs.length,
    slug,
  };
}

function setSyncBusy(busy) {
  document.querySelectorAll('[data-songbook-sync], [data-songbook-create-channel]').forEach((el) => {
    el.disabled = busy;
  });
  document.querySelectorAll('.songbook-sync-btn').forEach((el) => {
    el.classList.toggle('is-syncing', busy);
    el.setAttribute('aria-busy', busy ? 'true' : 'false');
  });
}

export function setSongbookSyncVisible(visible) {
  document.querySelectorAll('[data-songbook-sync-visible]').forEach((el) => {
    el.hidden = !visible;
  });
  refreshChannelActionVisibility();
}

export function updateSongbookChannelLabel(channel, channels) {
  const el = document.getElementById('songbook-channel-label');
  const list = Array.isArray(channels) ? channels : null;
  const own = list ? pickOwnChannel(list) : pickOwnChannel(
    (() => {
      try {
        return JSON.parse(localStorage.getItem('songbook_channels') || '[]');
      } catch {
        return [];
      }
    })(),
  );

  if (el) {
    if (own?.slug) {
      el.textContent = `${own.name || own.slug} · /c/${own.slug}`;
    } else if (channel?.slug === 'demo' || !own) {
      el.textContent = '연결된 채널이 없습니다. 채널을 만들어 주세요.';
    } else if (channel?.slug) {
      el.textContent = `${channel.name || channel.slug} · /c/${channel.slug}`;
    } else {
      el.textContent = '로그인하면 연결된 채널이 표시됩니다.';
    }
  }
  refreshChannelActionVisibility(own);
}

function refreshChannelActionVisibility(ownOverride) {
  const own =
    ownOverride !== undefined
      ? ownOverride
      : pickOwnChannel(
          (() => {
            try {
              return JSON.parse(localStorage.getItem('songbook_channels') || '[]');
            } catch {
              return [];
            }
          })(),
        );
  const loggedIn = document.getElementById('songbook-login-btn')?.dataset?.loggedIn === '1';
  document.querySelectorAll('[data-songbook-create-channel]').forEach((el) => {
    el.hidden = !(loggedIn && !own?.slug);
  });
  document.querySelectorAll('[data-songbook-sync]').forEach((el) => {
    if (el.hasAttribute('data-songbook-sync-visible')) {
      el.hidden = !loggedIn;
    }
  });
}

async function handleAuthExpired() {
  try {
    await invoke('clear_songbook_auth');
  } catch {
    /* ignore */
  }
  setSongbookSyncVisible(false);
  updateSongbookChannelLabel(null);
  showNotification('세션이 만료되었습니다. 다시 로그인해 주세요.', 'error');
}

async function reloadLibraryAfterPull() {
  const { loadLibrary } = await import('./audio.js');
  const { state } = await import('./state.js');
  const { renderLibrary } = await import('./ui/library.js');
  const { refreshFilterDropdowns } = await import('./ui/core.js');
  state.songLibrary = (await loadLibrary()) || [];
  await refreshFilterDropdowns();
  renderLibrary();
}

async function handleSyncError(err, stage) {
  if (isChannelSetupRequired(err)) {
    await promptOpenSongbookChannelSetup();
    return;
  }
  if (err?.message === 'AUTH_EXPIRED') {
    await handleAuthExpired();
    return;
  }
  console.error('[SongbookSync]', stage, err);
  const fallback = stage === 'pull'
    ? 'Songbook 가져오기에 실패했습니다.'
    : 'Songbook 동기화에 실패했습니다.';
  showNotification(songbookErrorMessage(err, fallback), 'error');
}

async function runSyncFromUi(trigger) {
  if (trigger?.disabled) return;
  setSyncBusy(true);
  showNotification('Songbook과 동기화하는 중…', 'info');
  let pushed = null;
  try {
    pushed = await pushLibraryToSongbook();
    const pulled = await pullLibraryFromSongbook();
    await reloadLibraryAfterPull();
    const parts = [
      `보냄 추가 ${pushed.added}`,
      `갱신 ${pushed.updated}`,
      `제거 ${pushed.removed}`,
      `가져옴 추가 ${pulled.added}`,
      `갱신 ${pulled.updated}`,
    ];
    if (pulled.placeholders) parts.push(`플레이스홀더 ${pulled.placeholders}`);
    if (pushed.failed) parts.push(`실패 ${pushed.failed}`);
    showNotification(
      `Songbook 동기화 완료 (${pushed.slug || pulled.slug}): ${parts.join(' · ')}`,
      pushed.failed ? 'warning' : 'success',
    );
  } catch (err) {
    await handleSyncError(err, pushed ? 'pull' : 'push');
  } finally {
    setSyncBusy(false);
  }
}

async function runCreateChannelFromUi(trigger) {
  if (trigger?.disabled) return;
  setSyncBusy(true);
  try {
    const { token } = await getAuthOrThrow();
    const existing = await fetchMeChannels(token);
    if (existing.own?.slug) {
      showNotification(`이미 채널이 있습니다: /c/${existing.own.slug}`, 'info');
      return;
    }
    await promptOpenSongbookChannelSetup();
  } catch (err) {
    console.error('[SongbookSync] create channel', err);
    if (err?.message === 'AUTH_EXPIRED') {
      await handleAuthExpired();
    } else {
      showNotification(songbookErrorMessage(err, 'Songbook 페이지를 열지 못했습니다.'), 'error');
    }
  } finally {
    setSyncBusy(false);
  }
}

export function initSongbookSync() {
  updateSongbookChannelLabel(null);

  document.querySelectorAll('[data-songbook-sync]').forEach((btn) => {
    if (btn.dataset.bound === '1') return;
    btn.dataset.bound = '1';
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      void runSyncFromUi(btn);
    });
  });

  document.querySelectorAll('[data-songbook-create-channel]').forEach((btn) => {
    if (btn.dataset.bound === '1') return;
    btn.dataset.bound = '1';
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      void runCreateChannelFromUi(btn);
    });
  });

  void invoke('get_songbook_auth')
    .then((state) => {
      setSongbookSyncVisible(Boolean(state?.loggedIn ?? state?.logged_in));
    })
    .catch(() => setSongbookSyncVisible(false));
}
