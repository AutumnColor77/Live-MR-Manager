/**
 * Broadcast BGM — playlist page + duck/resume against main playback.
 */
import { invoke, listen } from './tauri-bridge.js';
import { getYoutubeMetadata } from './audio.js';
import { showNotification } from './utils.js';

const PLAYLIST_KEY = 'bgm-playlist';
const SETTINGS_KEY = 'bgm-settings';

const defaultSettings = () => ({
  enabled: true,
  volume: 40,
  loop: true,
  resumeOnPause: false,
  currentUrl: null,
  positionMs: 0,
});

/** @type {{ enabled: boolean, volume: number, loop: boolean, resumeOnPause: boolean, currentUrl: string|null, positionMs: number }} */
let settings = defaultSettings();
/** @type {Array<{ url: string, title: string, artist: string, thumbnail: string }>} */
let playlist = [];
/** BGM was paused because the main track is active (or held through pause). */
let bgmHeld = false;
let autoBusy = false;
let initialized = false;
let statusListening = false;
let positionPersistTimer = null;
let resumeOnLaunchDone = false;
/** @type {import('sortablejs').default | null} */
let bgmSortable = null;
let advancingPlaylist = false;
/** Cancels in-flight post-song gap + fade-in when a new song starts. */
let handoffEpoch = 0;

const BGM_GAP_MS = 3000;
const BGM_FADE_MS = 1500;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function persistPlaybackPosition() {
  if (!settings.currentUrl) return;
  try {
    const state = await invoke('bgm_get_state');
    if (!state?.hasTrack) return;
    const ms = Math.max(0, Math.floor(Number(state.positionMs) || 0));
    if (ms === settings.positionMs) return;
    settings.positionMs = ms;
    saveSettings();
  } catch {
    /* ignore */
  }
}

function startPositionPersist() {
  if (positionPersistTimer) return;
  positionPersistTimer = setInterval(() => {
    persistPlaybackPosition();
  }, 2000);
}

function stopPositionPersist() {
  if (positionPersistTimer) {
    clearInterval(positionPersistTimer);
    positionPersistTimer = null;
  }
}

export function loadBgmSettings() {
  try {
    const raw = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
    settings = { ...defaultSettings(), ...raw };
  } catch {
    settings = defaultSettings();
  }
  return settings;
}

export function getBgmSettings() {
  return { ...settings };
}

function saveSettings() {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

function loadPlaylist() {
  try {
    const raw = JSON.parse(localStorage.getItem(PLAYLIST_KEY) || '[]');
    playlist = Array.isArray(raw) ? raw.filter((i) => i && i.url) : [];
  } catch {
    playlist = [];
  }
}

function savePlaylist() {
  localStorage.setItem(PLAYLIST_KEY, JSON.stringify(playlist));
}

function syncPageControls() {
  const enabled = document.getElementById('toggle-bgm-enabled');
  const loop = document.getElementById('toggle-bgm-loop');
  const volume = document.getElementById('bgm-volume');
  const volumeVal = document.getElementById('bgm-volume-val');
  const resume = document.getElementById('toggle-bgm-resume-on-pause-page');
  if (enabled) enabled.checked = !!settings.enabled;
  if (loop) loop.checked = !!settings.loop;
  if (volume) volume.value = String(settings.volume ?? 40);
  if (volumeVal) volumeVal.textContent = `${settings.volume ?? 40}`;
  if (resume) resume.checked = !!settings.resumeOnPause;
}

function destroyBgmSortable() {
  if (bgmSortable) {
    try {
      bgmSortable.destroy();
    } catch {
      /* ignore */
    }
    bgmSortable = null;
  }
}

function bindBgmSortable(list) {
  if (!list) return;
  destroyBgmSortable();
  const SortableCtor = window.Sortable;
  if (typeof SortableCtor !== 'function') {
    console.warn('[BGM] Sortable.js unavailable');
    return;
  }
  bgmSortable = new SortableCtor(list, {
    animation: 150,
    handle: '.bgm-drag-handle',
    draggable: '.bgm-row',
    ghostClass: 'bgm-row-ghost',
    chosenClass: 'bgm-row-chosen',
    dragClass: 'bgm-row-drag',
    filter: 'button, input, label, .switch',
    preventOnFilter: true,
    forceFallback: true,
    fallbackOnBody: true,
    fallbackTolerance: 4,
    onEnd: (evt) => {
      if (evt.oldIndex == null || evt.newIndex == null || evt.oldIndex === evt.newIndex) {
        return;
      }
      const [moved] = playlist.splice(evt.oldIndex, 1);
      if (!moved) return;
      playlist.splice(evt.newIndex, 0, moved);
      savePlaylist();
      renderPlaylist();
    },
  });
}

function renderPlaylist() {
  const list = document.getElementById('bgm-playlist');
  const empty = document.getElementById('bgm-empty');
  if (!list) return;
  destroyBgmSortable();
  list.innerHTML = '';
  if (!playlist.length) {
    if (empty) empty.hidden = false;
    return;
  }
  if (empty) empty.hidden = true;

  playlist.forEach((item, index) => {
    const row = document.createElement('div');
    row.className = 'bgm-row';
    row.dataset.url = item.url;
    if (settings.currentUrl === item.url) row.classList.add('is-current');
    row.innerHTML = `
      <span class="bgm-drag-handle" title="드래그하여 순서 변경" aria-hidden="true">⋮⋮</span>
      <div class="bgm-thumb">${item.thumbnail ? `<img src="${escapeAttr(item.thumbnail)}" alt="">` : '<div class="bgm-thumb-fallback"></div>'}</div>
      <div class="bgm-info">
        <div class="bgm-title"></div>
        <div class="bgm-meta"></div>
      </div>
      <div class="bgm-actions">
        <button type="button" class="btn-ai-action secondary is-inline bgm-play-btn">재생</button>
        <button type="button" class="btn-ai-action secondary is-inline bgm-remove-btn">제거</button>
      </div>
    `;
    row.querySelector('.bgm-title').textContent = item.title || item.url;
    row.querySelector('.bgm-meta').textContent = item.artist || item.url;
    row.querySelector('.bgm-play-btn').addEventListener('click', () => playBgmUrl(item.url));
    row.querySelector('.bgm-remove-btn').addEventListener('click', () => removeBgmAt(index));
    list.appendChild(row);
  });

  bindBgmSortable(list);
}

function escapeAttr(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;');
}

function nextPlaylistUrl(currentUrl) {
  if (playlist.length < 2) return null;
  const idx = playlist.findIndex((i) => i.url === currentUrl);
  const nextIdx = idx < 0 ? 0 : (idx + 1) % playlist.length;
  return playlist[nextIdx]?.url || null;
}

async function playNextAfterEnded(endedUrl) {
  if (settings.loop || advancingPlaylist || autoBusy) return;
  const next = nextPlaylistUrl(endedUrl || settings.currentUrl);
  if (!next) {
    settings.currentUrl = null;
    saveSettings();
    renderPlaylist();
    return;
  }
  advancingPlaylist = true;
  try {
    await playBgmUrl(next, { silent: true });
  } finally {
    advancingPlaylist = false;
  }
}

export async function playBgmUrl(url, { silent = false, startMs = 0 } = {}) {
  if (!url) return;
  try {
    if (!silent) showNotification('BGM을 준비하는 중…', 'info');
    const resumeMs = Math.max(0, Math.floor(Number(startMs) || 0));
    await invoke('bgm_play', {
      url,
      loopEnabled: !!settings.loop,
      volume: settings.volume ?? 40,
      startPositionMs: resumeMs > 0 ? resumeMs : null,
    });
    settings.currentUrl = url;
    settings.positionMs = resumeMs;
    bgmHeld = false;
    saveSettings();
    startPositionPersist();
    renderPlaylist();
    if (!silent) showNotification('BGM 재생', 'success');
  } catch (err) {
    console.error(err);
    showNotification(`BGM 재생 실패: ${err}`, 'error');
  }
}

async function removeBgmAt(index) {
  const item = playlist[index];
  if (!item) return;
  if (settings.currentUrl === item.url) {
    try {
      await invoke('bgm_stop');
    } catch (_) {}
    settings.currentUrl = null;
    settings.positionMs = 0;
    bgmHeld = false;
    stopPositionPersist();
    saveSettings();
  }
  playlist.splice(index, 1);
  savePlaylist();
  renderPlaylist();
}

async function addBgmFromUrl() {
  const input = document.getElementById('bgm-url-input');
  const url = (input?.value || '').trim();
  if (!url) {
    showNotification('유튜브 URL을 입력하세요.', 'error');
    return;
  }
  if (playlist.some((i) => i.url === url)) {
    showNotification('이미 목록에 있는 URL입니다.', 'info');
    return;
  }
  const btn = document.getElementById('bgm-add-btn');
  if (btn) btn.disabled = true;
  try {
    const meta = await getYoutubeMetadata(url);
    playlist.push({
      url: meta.path || url,
      title: meta.title || 'Unknown',
      artist: meta.artist || '',
      thumbnail: meta.thumbnail || '',
    });
    savePlaylist();
    renderPlaylist();
    if (input) input.value = '';
    showNotification('BGM 목록에 추가했습니다.', 'success');
  } catch (err) {
    console.error(err);
    showNotification(`추가 실패: ${err}`, 'error');
  } finally {
    if (btn) btn.disabled = false;
  }
}

export function setResumeOnPause(value) {
  settings.resumeOnPause = !!value;
  saveSettings();
  syncPageControls();
}

export async function onMainPlaybackPlaying() {
  // Cancels any in-flight post-pause BGM fade-in.
  handoffEpoch += 1;
  if (!settings.enabled) return;
  try {
    await persistPlaybackPosition();
    const state = await invoke('bgm_get_state');
    if (state?.playing) {
      // Song resumed from pause while BGM was audible — duck without the 3s gap.
      await invoke('bgm_fade_pause', { durationMs: BGM_FADE_MS });
      bgmHeld = true;
    } else if (state?.hasTrack || settings.currentUrl) {
      // Fresh play_track already ducked in Rust; just mark held.
      bgmHeld = true;
    }
  } catch (err) {
    console.warn('[BGM] duck on play failed', err);
  }
}

export async function onMainPlaybackPaused() {
  if (!settings.enabled || !settings.resumeOnPause || !bgmHeld || autoBusy) return;
  autoBusy = true;
  const epoch = ++handoffEpoch;
  try {
    await sleep(BGM_GAP_MS);
    if (epoch !== handoffEpoch) return;
    await invoke('bgm_fade_resume', { durationMs: BGM_FADE_MS });
    if (epoch !== handoffEpoch) return;
    bgmHeld = false;
  } catch (err) {
    console.warn('[BGM] resume on pause failed', err);
  } finally {
    autoBusy = false;
  }
}

/** finished without queue advance, or explicit stop */
export async function onMainPlaybackEndedOrStopped({ queueAdvanced = false } = {}) {
  if (!settings.enabled || autoBusy) return;
  if (queueAdvanced) {
    // Next track keeps BGM held; Rust applies the pre-song gap again.
    bgmHeld = true;
    handoffEpoch += 1;
    return;
  }
  if (!bgmHeld && !settings.currentUrl) return;
  autoBusy = true;
  const epoch = ++handoffEpoch;
  try {
    await sleep(BGM_GAP_MS);
    if (epoch !== handoffEpoch) return;
    const state = await invoke('bgm_get_state');
    if (epoch !== handoffEpoch) return;
    if (state?.hasTrack) {
      await invoke('bgm_fade_resume', { durationMs: BGM_FADE_MS });
      bgmHeld = false;
    } else if (settings.currentUrl) {
      await playBgmUrl(settings.currentUrl, { silent: true });
      bgmHeld = false;
    }
  } catch (err) {
    console.warn('[BGM] resume failed', err);
  } finally {
    autoBusy = false;
  }
}

async function ensureStatusListener() {
  if (statusListening) return;
  statusListening = true;
  await listen('bgm-status', (event) => {
    const payload = event?.payload || {};
    if (payload.status === 'ended') {
      settings.positionMs = 0;
      saveSettings();
      playNextAfterEnded(payload.url || settings.currentUrl);
    }
  });
}

async function resumeBgmFromLastSession() {
  if (resumeOnLaunchDone) return;
  resumeOnLaunchDone = true;
  const url = settings.currentUrl;
  if (!url) return;
  const startMs = Math.max(0, Math.floor(Number(settings.positionMs) || 0));
  await playBgmUrl(url, { silent: true, startMs });
}

export function initBgmPage() {
  if (initialized) {
    syncPageControls();
    renderPlaylist();
    return;
  }
  initialized = true;
  loadBgmSettings();
  loadPlaylist();
  syncPageControls();
  renderPlaylist();
  invoke('bgm_set_auto_enabled', { enabled: !!settings.enabled }).catch(() => {});
  ensureStatusListener().catch((err) => console.warn('[BGM] status listen failed', err));
  startPositionPersist();

  const flushPosition = () => {
    persistPlaybackPosition();
  };
  window.addEventListener('pagehide', flushPosition);
  window.addEventListener('beforeunload', flushPosition);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushPosition();
  });

  document.getElementById('bgm-add-btn')?.addEventListener('click', () => addBgmFromUrl());
  document.getElementById('bgm-url-input')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') addBgmFromUrl();
  });
  document.getElementById('toggle-bgm-enabled')?.addEventListener('change', async (e) => {
    settings.enabled = !!e.target.checked;
    saveSettings();
    try {
      await invoke('bgm_set_auto_enabled', { enabled: !!settings.enabled });
    } catch (_) {}
  });
  document.getElementById('toggle-bgm-loop')?.addEventListener('change', async (e) => {
    settings.loop = !!e.target.checked;
    saveSettings();
    try {
      await invoke('bgm_set_loop', { loopEnabled: !!settings.loop });
    } catch (_) {}
  });
  document.getElementById('toggle-bgm-resume-on-pause-page')?.addEventListener('change', (e) => {
    setResumeOnPause(e.target.checked);
  });
  const volume = document.getElementById('bgm-volume');
  volume?.addEventListener('input', async (e) => {
    const v = Math.max(0, Math.min(100, parseInt(e.target.value, 10) || 0));
    settings.volume = v;
    const volumeVal = document.getElementById('bgm-volume-val');
    if (volumeVal) volumeVal.textContent = `${v}`;
    saveSettings();
    try {
      await invoke('bgm_set_volume', { volume: v });
    } catch (_) {}
  });

  document.getElementById('bgm-stop-btn')?.addEventListener('click', async () => {
    try {
      await persistPlaybackPosition();
      await invoke('bgm_stop');
      settings.currentUrl = null;
      settings.positionMs = 0;
      bgmHeld = false;
      stopPositionPersist();
      saveSettings();
      renderPlaylist();
    } catch (err) {
      showNotification(`BGM 정지 실패: ${err}`, 'error');
    }
  });

  // Restore last BGM position after the audio backend is ready.
  setTimeout(() => {
    resumeBgmFromLastSession().catch((err) => {
      console.warn('[BGM] session resume failed', err);
    });
  }, 800);
}

export function onBgmTabShown() {
  initBgmPage();
}
