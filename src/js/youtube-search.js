/**
 * youtube-search.js — 사이드바 「유튜브 검색」 페이지: 키워드 검색 → 라이브러리 추가.
 */
import { state } from './state.js';
import { getAudioMetadata, saveLibrary, searchYoutube, youtubePreviewAudio, togglePlayback } from './audio.js';
import { escapeHtml, showNotification } from './utils.js';
import { isDuplicateYoutubeTrack, normalizeYoutubeUrl } from './youtube-utils.js';
import { listen } from './tauri-bridge.js';

let initialized = false;
/** @type {Array<object>} */
let lastResults = [];

/** @type {HTMLAudioElement | null} */
let previewAudio = null;
let previewIndex = null;
let previewBusyIndex = null;
let previewToken = 0;
let previewStatusUnlisten = null;

function setStatus(message) {
  const el = document.getElementById('yt-search-status');
  if (el) el.textContent = message || '';
}

function setSearching(busy) {
  const btn = document.getElementById('yt-search-btn');
  const input = document.getElementById('yt-search-input');
  if (btn) {
    btn.disabled = busy;
    btn.classList.toggle('loading-btn', busy);
  }
  if (input) input.disabled = busy;
}

function formatMetaLine(item) {
  const parts = [];
  if (item.uploader) parts.push(item.uploader);
  if (item.durationLabel) parts.push(item.durationLabel);
  return parts.join(' · ');
}

function masterVolumePercent() {
  const slider = document.getElementById('master-volume-slider');
  const fromSlider = Number.parseFloat(slider?.value);
  const raw = Number.isFinite(fromSlider) ? fromSlider : Number(state.masterVolume);
  if (!Number.isFinite(raw)) return 100;
  return Math.max(0, Math.min(120, raw));
}

function previewGain() {
  if (state.isMuted) return 0;
  return Math.max(0, Math.min(1, masterVolumePercent() / 100));
}

export function applyYoutubePreviewVolume() {
  if (previewAudio) previewAudio.volume = previewGain();
}

function syncPreviewButtons() {
  document.querySelectorAll('.yt-search-preview-btn').forEach((btn) => {
    const index = Number(btn.dataset.index);
    const row = btn.closest('.yt-search-row');
    const isBusy = previewBusyIndex === index;
    const isCurrent = previewIndex === index;
    const isPlaying = Boolean(isCurrent && previewAudio && !previewAudio.paused);
    btn.disabled = isBusy;
    btn.classList.toggle('loading-btn', isBusy);
    btn.textContent = isBusy ? '준비 중' : isPlaying ? '정지' : '미리듣기';
    row?.classList.toggle('is-previewing', isCurrent && (isBusy || isPlaying));
  });
}

function stopYoutubePreviewAudio() {
  previewToken += 1;
  previewBusyIndex = null;
  previewIndex = null;
  if (previewAudio) {
    previewAudio.pause();
    previewAudio.removeAttribute('src');
    previewAudio.load();
    previewAudio = null;
  }
  syncPreviewButtons();
}

async function pauseMainPlaybackForPreview() {
  if (!state.isPlaying) return;
  try {
    await togglePlayback();
    showNotification('미리듣기를 위해 재생을 일시정지했습니다.', 'info');
  } catch {
    /* ignore */
  }
}

async function togglePreview(index) {
  const item = lastResults[index];
  if (!item) return;

  if (previewIndex === index && previewAudio) {
    if (previewAudio.paused) {
      await pauseMainPlaybackForPreview();
      applyYoutubePreviewVolume();
      try {
        await previewAudio.play();
      } catch (err) {
        console.error('[YoutubeSearch] Preview resume failed:', err);
        showNotification('미리듣기를 재생할 수 없습니다.', 'error');
        stopYoutubePreviewAudio();
        return;
      }
    } else {
      previewAudio.pause();
    }
    syncPreviewButtons();
    return;
  }

  const url = normalizeYoutubeUrl(item.url || `https://youtu.be/${item.id}`);
  if (previewAudio) {
    previewAudio.pause();
    previewAudio.removeAttribute('src');
    previewAudio.load();
    previewAudio = null;
    previewIndex = null;
  }

  const token = ++previewToken;
  previewBusyIndex = index;
  syncPreviewButtons();
  await pauseMainPlaybackForPreview();

  try {
    const streamUrl = await youtubePreviewAudio(url);
    if (token !== previewToken) return;
    if (!streamUrl) {
      throw new Error('미리듣기 주소를 받지 못했습니다.');
    }

    const audio = new Audio(streamUrl);
    audio.preload = 'auto';
    audio.volume = previewGain();
    audio.addEventListener('ended', () => {
      if (previewAudio === audio) stopYoutubePreviewAudio();
    });
    audio.addEventListener('error', () => {
      if (previewAudio === audio) {
        showNotification('미리듣기를 재생할 수 없습니다.', 'error');
        stopYoutubePreviewAudio();
      }
    });
    previewAudio = audio;
    previewIndex = index;
    previewBusyIndex = null;
    await audio.play();
    if (token !== previewToken) {
      audio.pause();
      return;
    }
    syncPreviewButtons();
  } catch (err) {
    if (token !== previewToken) return;
    previewBusyIndex = null;
    syncPreviewButtons();
    console.error('[YoutubeSearch] Preview failed:', err);
    const msg = typeof err === 'string' ? err : (err?.message || '미리듣기에 실패했습니다.');
    showNotification(msg, 'error');
  }
}

export function stopYoutubePreview() {
  stopYoutubePreviewAudio();
}

function renderResults(results) {
  const container = document.getElementById('yt-search-results');
  if (!container) return;
  lastResults = Array.isArray(results) ? results : [];

  if (lastResults.length === 0) {
    container.innerHTML = '<div class="yt-search-empty">검색 결과가 없습니다.</div>';
    return;
  }

  try {
    container.innerHTML = lastResults
      .map((item, index) => {
        const thumbUrl = String(item?.thumbnail || '').trim();
        const thumb = thumbUrl
          ? `<img src="${escapeHtml(thumbUrl)}" alt="" loading="lazy" referrerpolicy="no-referrer">`
          : '<div class="yt-search-thumb-placeholder" aria-hidden="true"></div>';
        const meta = formatMetaLine(item || {});
        return `
        <article class="yt-search-row" data-index="${index}">
          <div class="yt-search-thumb">${thumb}</div>
          <div class="yt-search-info">
            <h4 class="yt-search-title">${escapeHtml(item?.title || '제목 없음')}</h4>
            <p class="yt-search-meta">${escapeHtml(meta)}</p>
          </div>
          <div class="yt-search-actions">
            <button type="button" class="btn-ai-action secondary is-inline yt-search-preview-btn" data-index="${index}">미리듣기</button>
            <button type="button" class="btn-ai-action is-inline yt-search-add-btn" data-index="${index}">추가</button>
          </div>
        </article>
      `;
      })
      .join('');
    syncPreviewButtons();
  } catch (err) {
    console.error('[YoutubeSearch] Render failed:', err);
    container.innerHTML = '<div class="yt-search-empty">검색 결과를 표시하지 못했습니다.</div>';
    throw err;
  }
}

function invokeErrorMessage(err, fallback) {
  if (typeof err === 'string' && err.trim()) return err;
  if (typeof err?.message === 'string' && err.message.trim()) return err.message;
  return fallback;
}

async function runSearch() {
  const input = document.getElementById('yt-search-input');
  const query = (input?.value || '').trim();
  if (!query) {
    showNotification('검색어를 입력하세요.', 'warning');
    input?.focus();
    return;
  }

  setSearching(true);
  setStatus('검색 중…');
  stopYoutubePreviewAudio();
  const container = document.getElementById('yt-search-results');
  if (container) container.innerHTML = '<div class="yt-search-empty">검색 중…</div>';

  try {
    const raw = await searchYoutube(query, 10);
    const results = Array.isArray(raw) ? raw : [];
    renderResults(results);
    const count = results.length;
    setStatus(count > 0 ? `${count}개 결과` : '검색 결과가 없습니다.');
  } catch (err) {
    console.error('[YoutubeSearch] Failed:', err);
    const msg = invokeErrorMessage(err, '유튜브 검색에 실패했습니다.');
    showNotification(msg, 'error');
    setStatus(msg);
    if (container) container.innerHTML = `<div class="yt-search-empty">${escapeHtml(msg)}</div>`;
    lastResults = [];
  } finally {
    setSearching(false);
  }
}

/**
 * Flat search rows can lack duration; enrich via metadata fetcher when needed.
 * @param {object} item
 */
async function resolveSongMetadata(item) {
  const url = normalizeYoutubeUrl(item.url || `https://youtu.be/${item.id}`);
  const needsEnrich =
    !item.durationLabel ||
    !item.thumbnail ||
    !item.title ||
    item.title === '제목 없음';

  if (!needsEnrich) {
    const secs = typeof item.duration === 'number' ? Math.round(item.duration) : 0;
    const duration =
      item.durationLabel ||
      (secs > 0 ? `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}` : '0:00');
    return {
      id: null,
      title: item.title || 'Unknown Video',
      thumbnail: item.thumbnail || '',
      duration,
      source: 'youtube',
      path: url,
      pitch: 0,
      tempo: 1,
      volume: 100,
      artist: item.uploader || null,
      playCount: 0,
      dateAdded: Math.floor(Date.now() / 1000),
      isMr: false,
      isSeparated: false,
      hasLyrics: false,
    };
  }

  const metadata = await getAudioMetadata(url);
  metadata.source = 'youtube';
  metadata.path = url;
  if (item.title && item.title !== '제목 없음') metadata.title = item.title;
  if (item.uploader) metadata.artist = item.uploader;
  return metadata;
}

async function addResult(index) {
  const item = lastResults[index];
  if (!item) return;

  const btn = document.querySelector(`.yt-search-add-btn[data-index="${index}"]`);
  if (btn) {
    btn.disabled = true;
    btn.classList.add('loading-btn');
  }

  const wantSep = !!document.getElementById('yt-search-opt-separate')?.checked;

  try {
    const url = normalizeYoutubeUrl(item.url || `https://youtu.be/${item.id}`);
    if (isDuplicateYoutubeTrack(state.songLibrary, url, { path: url })) {
      showNotification('이미 등록된 곡입니다.', 'warning');
      return;
    }

    const song = await resolveSongMetadata(item);
    if (isDuplicateYoutubeTrack(state.songLibrary, song.path, song)) {
      showNotification('이미 등록된 곡입니다.', 'warning');
      return;
    }

    state.songLibrary.push(song);
    await saveLibrary(state.songLibrary);

    const { renderLibrary } = await import('./ui/library.js');
    const { refreshFilterDropdowns } = await import('./ui/core.js');
    await refreshFilterDropdowns();
    renderLibrary();

    showNotification(`「${song.title}」을(를) 추가했습니다.`, 'success');

    if (wantSep) {
      const { openSeparationModeModal } = await import('./separation-mode-modal.js');
      openSeparationModeModal(song);
    }
  } catch (err) {
    console.error('[YoutubeSearch] Add failed:', err);
    showNotification('곡 추가에 실패했습니다.', 'error');
  } finally {
    if (btn) {
      btn.classList.remove('loading-btn');
      btn.disabled = false;
    }
  }
}

export function initYoutubeSearch() {
  if (initialized) return;
  initialized = true;

  document.getElementById('yt-search-btn')?.addEventListener('click', () => runSearch());
  document.getElementById('yt-search-input')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      runSearch();
    }
  });

  document.getElementById('yt-search-results')?.addEventListener('click', (e) => {
    const previewBtn = e.target.closest('.yt-search-preview-btn');
    if (previewBtn) {
      const index = Number(previewBtn.dataset.index);
      if (Number.isFinite(index)) void togglePreview(index);
      return;
    }
    const btn = e.target.closest('.yt-search-add-btn');
    if (!btn) return;
    const index = Number(btn.dataset.index);
    if (Number.isFinite(index)) addResult(index);
  });

  if (!previewStatusUnlisten) {
    listen('playback-status', (event) => {
      const status = String(event?.payload?.status || '').toLowerCase();
      if (status === 'playing' || status === 'downloading') {
        stopYoutubePreviewAudio();
      }
    }).then((unlisten) => {
      previewStatusUnlisten = unlisten;
    }).catch(() => {});
  }

  window.addEventListener('master-volume-changed', () => applyYoutubePreviewVolume());
}

export function focusYoutubeSearch() {
  document.getElementById('yt-search-input')?.focus();
}
