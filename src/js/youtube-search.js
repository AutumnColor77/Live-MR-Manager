/**
 * youtube-search.js — 사이드바 「유튜브 검색」 페이지: 키워드 검색 → 라이브러리 추가.
 */
import { state } from './state.js';
import { getAudioMetadata, saveLibrary, searchYoutube } from './audio.js';
import { showNotification } from './utils.js';
import { isDuplicateYoutubeTrack, normalizeYoutubeUrl } from './youtube-utils.js';

let initialized = false;
/** @type {Array<object>} */
let lastResults = [];

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

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

function renderResults(results) {
  const container = document.getElementById('yt-search-results');
  if (!container) return;
  lastResults = Array.isArray(results) ? results : [];

  if (lastResults.length === 0) {
    container.innerHTML = '<div class="yt-search-empty">검색 결과가 없습니다.</div>';
    return;
  }

  container.innerHTML = lastResults
    .map((item, index) => {
      const thumb = item.thumbnail
        ? `<img src="${escapeHtml(item.thumbnail)}" alt="" loading="lazy" referrerpolicy="no-referrer">`
        : '<div class="yt-search-thumb-placeholder" aria-hidden="true"></div>';
      const meta = formatMetaLine(item);
      return `
        <article class="yt-search-row" data-index="${index}">
          <div class="yt-search-thumb">${thumb}</div>
          <div class="yt-search-info">
            <h4 class="yt-search-title">${escapeHtml(item.title || '제목 없음')}</h4>
            <p class="yt-search-meta">${escapeHtml(meta)}</p>
          </div>
          <button type="button" class="btn-ai-action is-inline yt-search-add-btn" data-index="${index}">추가</button>
        </article>
      `;
    })
    .join('');
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
  const container = document.getElementById('yt-search-results');
  if (container) container.innerHTML = '<div class="yt-search-empty">검색 중…</div>';

  try {
    const results = await searchYoutube(query, 10);
    renderResults(results || []);
    const count = (results || []).length;
    setStatus(count > 0 ? `${count}개 결과` : '검색 결과가 없습니다.');
  } catch (err) {
    console.error('[YoutubeSearch] Failed:', err);
    const msg = typeof err === 'string' ? err : '유튜브 검색에 실패했습니다.';
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
    const btn = e.target.closest('.yt-search-add-btn');
    if (!btn) return;
    const index = Number(btn.dataset.index);
    if (Number.isFinite(index)) addResult(index);
  });
}

export function focusYoutubeSearch() {
  document.getElementById('yt-search-input')?.focus();
}
