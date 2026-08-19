/**
 * Songbook 채널로 앱 라이브러리 Push
 * - 본인 채널만 (demo 차단)
 * - 없으면 POST /api/me/channels 로 생성 유도
 * - 신규 POST / 기존 PATCH (메타 갱신)
 * - 로컬에 없는 원격 곡은 enabled=false (공개 목록에서 제거, 신청 이력 FK 보존)
 */
import {
  applySongbookChannels,
  pickOwnChannel,
  songbookBase,
  SONGBOOK_SLUG_RE,
} from './companion-links.js';
import { prepareSongbookThumbnail } from './songbook-thumbnail.js';
import { invoke } from './tauri-bridge.js';
import { showNotification } from './utils.js';

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

/** YouTube http(s) path only — never upload local file paths. */
function pickOriginalUrl(song) {
  const candidates = [song?.originalUrl, song?.original_url, song?.path];
  for (const raw of candidates) {
    const value = String(raw || '').trim();
    if (/^https?:\/\//i.test(value)) return value;
  }
  return null;
}

function resolveRemoteThumbnail(remoteThumb) {
  const value = String(remoteThumb || '').trim();
  if (!value) return '';
  if (value.startsWith('/api/media/thumbs/')) {
    return `${songbookBase()}${value}`;
  }
  return value;
}

async function toSongPayload(song) {
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
    tags: normalizeTags(song?.tags),
    songKey: song?.songKey ?? song?.song_key ?? null,
    bpm,
    difficulty: mapSongbookDifficulty(song),
    donationAmount: mapSongbookDonationAmount(song),
    thumbnail: await prepareSongbookThumbnail(song),
    originalUrl: pickOriginalUrl(song),
    enabled: true,
  };
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

function needsPatch(remote, localPayload) {
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
  if (thumbnailNeedsPatch(remote.thumbnail, localPayload.thumbnail)) return true;
  const remoteUrl = String(remote.originalUrl || remote.original_url || '').trim();
  const localUrl = String(localPayload.originalUrl || '').trim();
  if (remoteUrl !== localUrl) return true;
  if (remote.enabled === false) return true;
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
  const res = await fetch(`${songbookBase()}/api/auth/me`, {
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

function confirmAsync(title, message) {
  return new Promise(async (resolve) => {
    const { openConfirmModal } = await import('./ui/modals.js');
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    openConfirmModal(title, message, () => finish(true));
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

export async function createOwnChannel(token, nameHint) {
  const name = String(nameHint || 'My Songbook').trim().slice(0, 80) || 'My Songbook';
  const res = await fetch(`${songbookBase()}/api/me/channels`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({ name }),
  });
  if (res.status === 401) throw new Error('AUTH_EXPIRED');
  if (res.status === 409) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error?.includes?.('1개') ? '이미 채널이 있습니다.' : (body.error || '채널을 만들 수 없습니다.'));
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `채널 생성 실패 (${res.status})`);
  }
  const data = await res.json();
  const channel = data.channel;
  if (!channel?.slug) throw new Error('채널 생성 응답이 올바르지 않습니다.');
  const refreshed = await fetchMeChannels(token);
  return refreshed.own || channel;
}

async function resolveOwnChannel(token, user, { offerCreate = true } = {}) {
  const { own, channels } = await fetchMeChannels(token);
  if (own?.slug && own.slug !== 'demo') {
    if (!SONGBOOK_SLUG_RE.test(own.slug)) {
      throw new Error('채널 slug 형식이 올바르지 않습니다.');
    }
    return own;
  }

  if (!offerCreate) {
    throw new Error('동기화하려면 내 Songbook 채널이 필요합니다.');
  }

  const ok = await confirmAsync(
    'Songbook 채널 만들기',
    '동기화하려면 채널이 필요합니다. 지금 만들까요?',
  );
  if (!ok) {
    throw new Error('채널 생성을 취소했습니다.');
  }
  return createOwnChannel(token, user?.name || user?.email);
}

/**
 * @returns {Promise<{ added: number, updated: number, removed: number, skipped: number, failed: number, total: number, slug: string }>}
 */
export async function pushLibraryToSongbook({ onProgress } = {}) {
  const { token, user } = await getAuthOrThrow();
  const channel = await resolveOwnChannel(token, user, { offerCreate: true });
  const slug = channel.slug;

  const base = songbookBase();
  const headers = authHeaders(token);
  const listUrl = `${base}/api/c/${encodeURIComponent(slug)}/admin/songs`;

  const remoteRes = await fetch(listUrl, { headers });
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

  let added = 0;
  let updated = 0;
  let removed = 0;
  let skipped = 0;
  let failed = 0;

  for (let i = 0; i < list.length; i++) {
    const song = list[i];
    const payload = await toSongPayload(song);
    if (!payload.title) {
      skipped += 1;
      onProgress?.({
        index: i + 1,
        total: list.length,
        added,
        updated,
        removed,
        skipped,
        failed,
      });
      continue;
    }

    const key = normalizeKey(payload.title, payload.artist);
    localKeys.add(key);
    const existing = remoteByKey.get(key);

    try {
      if (existing?.id) {
        if (!needsPatch(existing, payload)) {
          skipped += 1;
        } else {
          const res = await fetch(`${listUrl}/${encodeURIComponent(existing.id)}`, {
            method: 'PATCH',
            headers,
            body: JSON.stringify(payload),
          });
          if (res.ok) {
            updated += 1;
            const body = await res.json().catch(() => null);
            if (body?.song) remoteByKey.set(key, body.song);
          } else {
            failed += 1;
            console.warn('[SongbookSync] PATCH failed', res.status, await res.text().catch(() => ''));
          }
        }
      } else {
        const res = await fetch(listUrl, {
          method: 'POST',
          headers,
          body: JSON.stringify(payload),
        });
        if (res.ok) {
          added += 1;
          const body = await res.json().catch(() => null);
          if (body?.song) remoteByKey.set(key, body.song);
          else remoteByKey.set(key, { ...payload, id: 'pending' });
        } else {
          failed += 1;
          console.warn('[SongbookSync] POST failed', res.status, await res.text().catch(() => ''));
        }
      }
    } catch (err) {
      failed += 1;
      console.warn('[SongbookSync] request error', err);
    }

    onProgress?.({
      index: i + 1,
      total: list.length,
      added,
      updated,
      removed,
      skipped,
      failed,
    });
    if (i < list.length - 1) {
      await new Promise((r) => setTimeout(r, 40));
    }
  }

  // 앱 라이브러리에 없는 원격 곡 → 공개 목록에서 숨김 (재동기화 시 enabled 복구)
  const toDisable = remoteSongs.filter((s) => {
    if (!s?.id || s.enabled === false) return false;
    return !localKeys.has(normalizeKey(s.title, s.artist));
  });

  for (let i = 0; i < toDisable.length; i++) {
    const remote = toDisable[i];
    try {
      const res = await fetch(`${listUrl}/${encodeURIComponent(remote.id)}`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ enabled: false }),
      });
      if (res.ok) {
        removed += 1;
      } else {
        failed += 1;
        console.warn(
          '[SongbookSync] disable failed',
          res.status,
          await res.text().catch(() => ''),
        );
      }
    } catch (err) {
      failed += 1;
      console.warn('[SongbookSync] disable error', err);
    }
    onProgress?.({
      index: list.length + i + 1,
      total: list.length + toDisable.length,
      added,
      updated,
      removed,
      skipped,
      failed,
    });
    if (i < toDisable.length - 1) {
      await new Promise((r) => setTimeout(r, 40));
    }
  }

  return { added, updated, removed, skipped, failed, total: list.length, slug };
}

function applyRemoteMetaToLocal(local, remote) {
  const next = { ...local };
  next.title = String(remote.title || local.title || '').trim() || local.title;
  next.artist = String(remote.artist || local.artist || '').trim() || local.artist;
  next.songKey = remote.songKey ?? remote.song_key ?? local.songKey ?? null;
  next.bpm = remote.bpm ?? local.bpm ?? null;
  next.difficulty = remote.difficulty ?? local.difficulty ?? null;
  next.tags = normalizeTags(remote.tags?.length ? remote.tags : local.tags);
  const category = String(remote.category || '').trim();
  if (category) {
    next.categories = [category];
    next.curationCategory = category;
  }
  const genre = String(remote.genre || '').trim();
  if (genre) next.genre = genre;
  const thumb = resolveRemoteThumbnail(remote.thumbnail);
  if (thumb) next.thumbnail = thumb;
  const url = String(remote.originalUrl || remote.original_url || '').trim();
  if (/^https?:\/\//i.test(url)) {
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
  const url = String(remote.originalUrl || remote.original_url || '').trim();
  const hasUrl = /^https?:\/\//i.test(url);
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
    isMr: false,
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
  const { token, user } = await getAuthOrThrow();
  const channel = await resolveOwnChannel(token, user, { offerCreate: false });
  const slug = channel.slug;

  const base = songbookBase();
  const headers = authHeaders(token);
  const listUrl = `${base}/api/c/${encodeURIComponent(slug)}/admin/songs`;

  const remoteRes = await fetch(listUrl, { headers });
  if (remoteRes.status === 401) throw new Error('AUTH_EXPIRED');
  if (remoteRes.status === 404) {
    throw new Error(`채널 '${slug}'을(를) 찾을 수 없습니다.`);
  }
  if (!remoteRes.ok) {
    throw new Error(`원격 목록 조회 실패 (${remoteRes.status})`);
  }

  const remoteJson = await remoteRes.json();
  const remoteSongs = (Array.isArray(remoteJson?.songs) ? remoteJson.songs : []).filter(
    (s) => s && s.enabled !== false,
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
  document.querySelectorAll('[data-songbook-sync], [data-songbook-sync-pull], [data-songbook-create-channel]').forEach((el) => {
    el.disabled = busy;
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
  document.querySelectorAll('[data-songbook-sync-pull]').forEach((el) => {
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

async function runPushFromUi(trigger) {
  if (trigger?.disabled) return;
  setSyncBusy(true);
  showNotification('Songbook으로 목록을 보내는 중…', 'info');
  try {
    const result = await pushLibraryToSongbook();
    const parts = [
      `추가 ${result.added}`,
      `갱신 ${result.updated}`,
      `제거 ${result.removed}`,
      `그대로 ${result.skipped}`,
    ];
    if (result.failed) parts.push(`실패 ${result.failed}`);
    showNotification(
      `Songbook 동기화 완료 (${result.slug}): ${parts.join(' · ')}`,
      result.failed ? 'warning' : 'success',
    );
  } catch (err) {
    console.error('[SongbookSync]', err);
    if (err?.message === 'AUTH_EXPIRED') {
      await handleAuthExpired();
    } else {
      showNotification(err?.message || 'Songbook 동기화에 실패했습니다.', 'error');
    }
  } finally {
    setSyncBusy(false);
  }
}

async function runPullFromUi(trigger) {
  if (trigger?.disabled) return;
  setSyncBusy(true);
  showNotification('Songbook에서 목록을 가져오는 중…', 'info');
  try {
    const result = await pullLibraryFromSongbook();
    const { loadLibrary } = await import('./audio.js');
    const { state } = await import('./state.js');
    const { renderLibrary } = await import('./ui/library.js');
    const { refreshFilterDropdowns } = await import('./ui/core.js');
    state.songLibrary = (await loadLibrary()) || [];
    await refreshFilterDropdowns();
    renderLibrary();
    const parts = [
      `추가 ${result.added}`,
      `갱신 ${result.updated}`,
    ];
    if (result.placeholders) parts.push(`플레이스홀더 ${result.placeholders}`);
    if (result.skipped) parts.push(`건너뜀 ${result.skipped}`);
    showNotification(
      `Songbook 가져오기 완료 (${result.slug}): ${parts.join(' · ')}`,
      'success',
    );
  } catch (err) {
    console.error('[SongbookSync] pull', err);
    if (err?.message === 'AUTH_EXPIRED') {
      await handleAuthExpired();
    } else {
      showNotification(err?.message || 'Songbook 가져오기에 실패했습니다.', 'error');
    }
  } finally {
    setSyncBusy(false);
  }
}

async function runCreateChannelFromUi(trigger) {
  if (trigger?.disabled) return;
  setSyncBusy(true);
  try {
    const { token, user } = await getAuthOrThrow();
    const existing = await fetchMeChannels(token);
    if (existing.own?.slug) {
      showNotification(`이미 채널이 있습니다: /c/${existing.own.slug}`, 'info');
      return;
    }
    const ok = await confirmAsync(
      'Songbook 채널 만들기',
      '닉네임으로 채널을 만들까요?',
    );
    if (!ok) return;
    const channel = await createOwnChannel(token, user?.name || user?.email);
    showNotification(`채널 생성 완료: /c/${channel.slug}`, 'success');
  } catch (err) {
    console.error('[SongbookSync] create channel', err);
    if (err?.message === 'AUTH_EXPIRED') {
      await handleAuthExpired();
    } else {
      showNotification(err?.message || '채널 생성에 실패했습니다.', 'error');
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
      void runPushFromUi(btn);
    });
  });

  document.querySelectorAll('[data-songbook-sync-pull]').forEach((btn) => {
    if (btn.dataset.bound === '1') return;
    btn.dataset.bound = '1';
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      void runPullFromUi(btn);
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
