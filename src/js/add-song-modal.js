/**
 * add-song-modal.js — 유튜브 URL / 로컬 파일로 곡 추가하는 단일 모달.
 *
 * 플로우: 소스 입력 → 메타 미리보기(제목/아티스트 편집) → 라이브러리 추가
 * → (선택) MR 분리 모달.
 */
import { invoke } from './tauri-bridge.js';
import { state } from './state.js';
import { getAudioMetadata, saveLibrary } from './audio.js';
import { showNotification } from './utils.js';
import { isDuplicateYoutubeTrack, normalizeYoutubeUrl } from './youtube-utils.js';

const AUDIO_EXTS = new Set(['mp3', 'wav', 'flac', 'm4a', 'aac', 'ogg', 'wma']);

let initialized = false;
/** @type {object|null} */
let draftMeta = null;
/** @type {string[]} */
let pendingExtraPaths = [];

function modalEl() {
  return document.getElementById('add-song-modal');
}

function setSourceTab(source) {
  const isUrl = source === 'url';
  document.getElementById('add-song-tab-url')?.classList.toggle('active', isUrl);
  document.getElementById('add-song-tab-file')?.classList.toggle('active', !isUrl);
  document.getElementById('add-song-tab-url')?.setAttribute('aria-selected', String(isUrl));
  document.getElementById('add-song-tab-file')?.setAttribute('aria-selected', String(!isUrl));
  const urlPane = document.getElementById('add-song-pane-url');
  const filePane = document.getElementById('add-song-pane-file');
  if (urlPane) urlPane.hidden = !isUrl;
  if (filePane) filePane.hidden = isUrl;
}

function setDraft(meta) {
  draftMeta = meta;
  const metaBox = document.getElementById('add-song-meta');
  const submit = document.getElementById('add-song-submit');
  if (!meta) {
    if (metaBox) metaBox.hidden = true;
    if (submit) submit.disabled = true;
    return;
  }
  if (metaBox) metaBox.hidden = false;
  const title = document.getElementById('add-song-title');
  const artist = document.getElementById('add-song-artist');
  if (title) title.value = meta.title || '';
  if (artist) artist.value = meta.artist || '';
  if (submit) submit.disabled = false;
}

function updateExtraHint() {
  const hint = document.getElementById('add-song-extra-hint');
  if (!hint) return;
  const n = pendingExtraPaths.length;
  if (n <= 0) {
    hint.hidden = true;
    hint.textContent = '';
    return;
  }
  hint.hidden = false;
  hint.textContent = `추가로 드롭된 ${n}개 파일은 이 곡 추가 시 함께 등록됩니다.`;
}

function resetModal() {
  draftMeta = null;
  pendingExtraPaths = [];
  setDraft(null);
  updateExtraHint();
  const urlInput = document.getElementById('add-song-url-input');
  const filePath = document.getElementById('add-song-file-path');
  const sep = document.getElementById('add-song-opt-separate');
  if (urlInput) urlInput.value = '';
  if (filePath) filePath.value = '';
  if (sep) sep.checked = false;
  setSourceTab('url');
}

export function closeAddSongModal() {
  const m = modalEl();
  if (m) {
    m.classList.remove('active');
    m.setAttribute('aria-hidden', 'true');
  }
  resetModal();
}

/**
 * @param {{ paths?: string[], preferFileTab?: boolean }} [options]
 */
export function openAddSongModal(options = {}) {
  initAddSongModal();
  const m = modalEl();
  if (!m) return;
  resetModal();
  const paths = (options.paths || []).filter((p) => {
    const ext = String(p).split('.').pop()?.toLowerCase();
    return AUDIO_EXTS.has(ext);
  });
  if (paths.length > 0 || options.preferFileTab) {
    setSourceTab('file');
  }
  m.classList.add('active');
  m.setAttribute('aria-hidden', 'false');
  if (paths.length > 0) {
    loadFilePath(paths[0], paths.slice(1));
  } else {
    const focusId = options.preferFileTab ? 'add-song-pick-file' : 'add-song-url-input';
    document.getElementById(focusId)?.focus();
  }
}

async function loadFilePath(path, extraPaths = []) {
  pendingExtraPaths = extraPaths.slice();
  updateExtraHint();
  const filePath = document.getElementById('add-song-file-path');
  if (filePath) filePath.value = path;
  setSourceTab('file');
  try {
    const metadata = await getAudioMetadata(path);
    metadata.source = 'local';
    setDraft(metadata);
  } catch (err) {
    console.error('[AddSong] Local metadata failed:', err);
    showNotification('파일 정보를 읽지 못했습니다.', 'error');
    setDraft(null);
  }
}

async function fetchYoutubeMeta() {
  const input = document.getElementById('add-song-url-input');
  const btn = document.getElementById('add-song-fetch-btn');
  const url = (input?.value || '').trim();
  if (!url) return;
  const normalizedUrl = normalizeYoutubeUrl(url);
  if (btn) {
    btn.classList.add('loading-btn');
    btn.disabled = true;
  }
  try {
    const metadata = await getAudioMetadata(normalizedUrl);
    if (isDuplicateYoutubeTrack(state.songLibrary, normalizedUrl, metadata)) {
      showNotification('이미 등록된 곡입니다.', 'warning');
      setDraft(null);
      return;
    }
    if (input) input.value = normalizedUrl;
    setDraft(metadata);
  } catch (err) {
    console.error('[AddSong] YouTube metadata failed:', err);
    showNotification('정보를 가져오는데 실패했습니다.', 'error');
    setDraft(null);
  } finally {
    if (btn) {
      btn.classList.remove('loading-btn');
      btn.disabled = false;
    }
  }
}

async function addExtraLocalFiles(paths) {
  let added = 0;
  for (const path of paths) {
    try {
      if (state.songLibrary.some((s) => s.path === path)) continue;
      const metadata = await getAudioMetadata(path);
      metadata.source = 'local';
      state.songLibrary.push(metadata);
      added++;
    } catch (err) {
      console.error('[AddSong] Extra file failed:', path, err);
    }
  }
  return added;
}

async function submitAdd() {
  if (!draftMeta) return;
  const submit = document.getElementById('add-song-submit');
  if (submit) {
    submit.disabled = true;
    submit.classList.add('loading-btn');
  }

  const title = document.getElementById('add-song-title')?.value?.trim();
  const artist = document.getElementById('add-song-artist')?.value?.trim();
  const wantSep = !!document.getElementById('add-song-opt-separate')?.checked;
  const extras = pendingExtraPaths.slice();

  try {
    if (draftMeta.source === 'youtube' || String(draftMeta.path || '').startsWith('http')) {
      if (isDuplicateYoutubeTrack(state.songLibrary, draftMeta.path, draftMeta)) {
        showNotification('이미 등록된 곡입니다.', 'warning');
        return;
      }
    } else if (state.songLibrary.some((s) => s.path === draftMeta.path)) {
      showNotification('이미 등록된 곡입니다.', 'warning');
      return;
    }

    const song = { ...draftMeta };
    if (title) song.title = title;
    if (artist !== undefined) song.artist = artist;

    state.songLibrary.push(song);
    const extraCount = await addExtraLocalFiles(extras);
    await saveLibrary(state.songLibrary);

    try {
      if (title || artist !== undefined) {
        await invoke('update_song_metadata', { song });
      }
    } catch (err) {
      console.warn('[AddSong] Metadata update skipped:', err);
    }

    const { renderLibrary } = await import('./ui/library.js');
    const { refreshFilterDropdowns } = await import('./ui/core.js');
    await refreshFilterDropdowns();
    renderLibrary();

    const msg = extraCount > 0
      ? `추가되었습니다. (추가 파일 ${extraCount}개 포함)`
      : '추가되었습니다.';
    showNotification(msg, 'success');

    closeAddSongModal();

    if (wantSep) {
      const { openSeparationModeModal } = await import('./separation-mode-modal.js');
      openSeparationModeModal(song);
    }
  } catch (err) {
    console.error('[AddSong] Submit failed:', err);
    showNotification('곡 추가에 실패했습니다.', 'error');
  } finally {
    if (submit) {
      submit.classList.remove('loading-btn');
      if (draftMeta) submit.disabled = false;
    }
  }
}

async function pickLocalFile() {
  try {
    const paths = await invoke('pick_audio_files');
    if (!Array.isArray(paths) || paths.length === 0) return;
    await loadFilePath(paths[0], paths.slice(1));
  } catch (err) {
    if (String(err) === 'CANCELLED') return;
    console.error('[AddSong] pick_audio_files failed:', err);
    showNotification('파일 선택에 실패했습니다.', 'error');
  }
}

export function initAddSongModal() {
  if (initialized) return;
  initialized = true;
  const m = modalEl();
  if (!m) return;

  document.getElementById('btn-add-song')?.addEventListener('click', () => openAddSongModal());
  document.getElementById('add-song-close')?.addEventListener('click', closeAddSongModal);
  document.getElementById('add-song-cancel')?.addEventListener('click', closeAddSongModal);
  m.addEventListener('click', (e) => {
    if (e.target === m) closeAddSongModal();
  });

  document.querySelectorAll('.add-song-tab').forEach((tab) => {
    tab.addEventListener('click', () => setSourceTab(tab.dataset.addSource || 'url'));
  });

  document.getElementById('add-song-fetch-btn')?.addEventListener('click', () => fetchYoutubeMeta());
  document.getElementById('add-song-url-input')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') fetchYoutubeMeta();
  });
  document.getElementById('add-song-pick-file')?.addEventListener('click', () => pickLocalFile());
  document.getElementById('add-song-submit')?.addEventListener('click', () => submitAdd());
}
