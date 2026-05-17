/**
 * js/ui/library.js - Library Grid and Song Cards
 */
import { state } from '../state.js';
import { elements } from './elements.js';
import { invoke } from '../tauri-bridge.js';
import { getThumbnailUrl } from '../utils.js';
import { updateCardStatusBadge, updateThumbnailOverlay, showSongContextMenu } from './components.js';

export function updateLibraryCount(count) {
  const countEl = document.getElementById("library-count");
  if (countEl) countEl.textContent = count;
}

/** User-edited categories take priority over auto curation metadata. */
export function getSongCategory(song) {
  if (!song) return "";
  if (song.categories && song.categories.length > 0) {
    const first = String(song.categories[0] || "").trim();
    if (first) return first;
  }
  if (song.category && String(song.category).trim()) return String(song.category).trim();
  if (song.curationCategory && String(song.curationCategory).trim()) {
    return String(song.curationCategory).trim();
  }
  return "";
}

export function getFilteredSongs() {
  const query = (elements.libSearchInput?.value || "").toLowerCase().trim();
  const genreFilter = elements.libGenreFilter?.value || "all";
  const categoryFilter = elements.libCategoryFilter?.value || "all";
  const sortBy = elements.libSortSelect?.value || "dateNew";
  const currentTab = state.activeView || "library";

  let filtered = state.songLibrary.map((s, i) => ({ ...s, originalIndex: i }));

  // Tab Filter
  if (currentTab === "youtube") filtered = filtered.filter(s => s.source === "youtube");
  else if (currentTab === "local") filtered = filtered.filter(s => s.source === "local");

  // Search Filter
  if (query) {
    filtered = filtered.filter(s =>
      s.title.toLowerCase().includes(query) ||
      (s.artist && s.artist.toLowerCase().includes(query)) ||
      (s.genre && s.genre.toLowerCase().includes(query)) ||
      getSongCategory(s).toLowerCase().includes(query) ||
      (s.tags && s.tags.some(t => t.toLowerCase().includes(query)))
    );
  }

  // Genre Filter
  if (genreFilter !== "all" && genreFilter !== "") {
    filtered = filtered.filter(s => s.genre === genreFilter);
  }

  // Category Filter
  if (categoryFilter !== "all" && categoryFilter !== "") {
    filtered = filtered.filter(
      (s) =>
        getSongCategory(s) === categoryFilter ||
        (s.categories && s.categories.includes(categoryFilter))
    );
  }

  // Sorting
  filtered.sort((a, b) => {
    switch (sortBy) {
      case "title": return (a.title || "").localeCompare(b.title || "");
      case "dateNew": return (b.dateAdded || 0) - (a.dateAdded || 0);
      case "dateOld": return (a.dateAdded || 0) - (b.dateAdded || 0);
      case "plays": return (b.playCount || 0) - (a.playCount || 0);
      default: return 0;
    }
  });

  state.filteredTracks = filtered;
  return filtered;
}

export function renderLibrary() {
  if (!elements.songGrid) return;
  
  const filtered = getFilteredSongs();
  updateLibraryCount(filtered.length);
  
  elements.songGrid.innerHTML = "";
  
  if (filtered.length === 0) {
    elements.songGrid.innerHTML = `
      <div class="empty-state" style="grid-column: 1/-1; text-align: center; padding: 40px; color: var(--text-dim);">
        검색 결과가 없습니다.
      </div>`;
    return;
  }

  const count = filtered.length;
  invoke('remote_js_log', { msg: `[Library] Rendering ${count} cards.` }).catch(() => {});

  filtered.forEach(song => {
    addSongCard(song, song.originalIndex);
  });

  updateThumbnailOverlay();
}

export function addSongCard(song, index) {
  const card = document.createElement("article");
  card.className = `song-card ${state.viewMode === "list" ? "list-row" : ""} ${state.viewMode === "button" ? "button-row" : ""}`;
  card.dataset.path = song.path;
  card.dataset.index = index;
  const isButton = state.viewMode === "button";
  const isList = state.viewMode === "list";

  const thumbUrl = getThumbnailUrl(song.thumbnail, song);

  card.innerHTML = `
    <div class="thumbnail">
      <img src="${thumbUrl}" alt="${song.title}" style="width:100%; height:100%; object-fit:cover;">
      <div class="thumb-overlay">
        <svg class="icon-loading" viewBox="0 0 24 24" width="32" height="32" fill="none" stroke="currentColor" stroke-width="3">
          <circle cx="12" cy="12" r="10" stroke-opacity="0.2"/>
          <path d="M12 2a10 10 0 0 1 10 10"/>
        </svg>
        <svg class="icon-play" viewBox="0 0 24 24" width="32" height="32" fill="currentColor">
          <path d="M8 5v14l11-7z"/>
        </svg>
        <svg class="icon-pause" viewBox="0 0 24 24" width="32" height="32" fill="currentColor">
          <path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/>
        </svg>
      </div>
    </div>
    
    ${isButton ? (() => {
      const activeTask = (state.activeTasks || {})[song.path];
      let badgeHtml = "";
      if (activeTask && activeTask.status !== "Finished") {
        badgeHtml = `<span class="status-badge processing sm">ING</span>`;
      } else if (song.isSeparated || song.is_separated || song.isMr || song.is_mr || song.mr_path) {
        badgeHtml = `<span class="status-badge mr sm">MR</span>`;
      }

      return `
      <div class="song-info-content button-layout">
        <div class="col col-info">
          <div class="song-name" title="${song.title || ''}">${song.title || '제목 정보 없음'}</div>
          <div class="song-artist">${song.artist || '가수 정보 없음'}</div>
        </div>
        <div class="col col-status-duration">
          <div class="status-badge-wrapper">${badgeHtml}</div>
          <span class="duration-text">${song.duration || '--:--'}</span>
        </div>
      </div>
      `;
    })() : isList ? (() => {
      const activeTask = (state.activeTasks || {})[song.path];
      let badgeHtml = "";
      if (activeTask && activeTask.status !== "Finished") {
        const status = (activeTask.status || "").toLowerCase();
        const isWaiting = status.includes("queued") || status.includes("pending") || status.includes("starting") || status.includes("preparing");
        badgeHtml = `<span class="status-badge ${isWaiting ? 'pending' : 'processing'}">${isWaiting ? '대기중' : '분리중'}</span>`;
      } else if (song.isSeparated || song.is_separated || song.isMr || song.is_mr || song.mr_path) {
        badgeHtml = `<span class="status-badge mr">MR</span>`;
      }

      const category = getSongCategory(song);

      return `
        <div class="col col-info">
          <div class="song-name" title="${song.title || ''}">${song.title || '제목 정보 없음'}</div>
          <div class="song-artist-badge ${!song.artist ? 'no-info' : ''}">${song.artist || '가수 정보 없음'}</div>
        </div>
        <div class="col col-genre">
          <div class="status-badge-wrapper">${badgeHtml}</div>
          ${category ? `<span class="category-badge">${category}</span>` : ''}
          <span class="genre-badge ${!song.genre ? 'no-info' : ''}">${(song.genre || '미분류').toUpperCase()}</span>
        </div>
        <div class="col col-tags">
          <div class="tag-container ${!song.tags || song.tags.length === 0 ? 'no-info' : ''}">
            ${song.tags && song.tags.length > 0
              ? song.tags.map(t => `<span class="tag-badge">${t}</span>`).join('')
              : '<span class="tag-no-info">태그 없음</span>'}
          </div>
        </div>
        <div class="col col-duration">
          <span class="duration-text">${song.duration || '--:--'}</span>
        </div>
      `;
    })() : (() => {
      const category = getSongCategory(song);
      return `
      <div class="song-info-content grid-layout">
        <div class="song-name" title="${song.title || ''}">${song.title || '제목 정보 없음'}</div>
        <div class="song-artist-badge ${!song.artist ? 'no-info' : ''}">${song.artist || '가수 정보 없음'}</div>
        
        <div class="metadata-row">
          <div class="badge-group-inline">
            ${category ? `<span class="category-badge">${category}</span>` : ''}
            <span class="genre-badge ${!song.genre ? 'no-info' : ''}">${(song.genre || '미분류').toUpperCase()}</span>
          </div>
          <span class="duration-text">${song.duration || '--:--'}</span>
        </div>

        <div class="tag-row">
          <div class="tag-container ${!song.tags || song.tags.length === 0 ? 'no-info' : ''}">
            ${song.tags && song.tags.length > 0
              ? song.tags.map(t => `<span class="tag-badge">${t}</span>`).join('')
              : '<span class="tag-no-info">태그 정보 없음</span>'}
          </div>
        </div>
      </div>
      `;
    })()}
  `;

  // Unified Status Badge (MR / 분리중 / 대기중)
  updateCardStatusBadge(song.path, card);

  // Integrated click handler: Play immediately on card or thumbnail click
  const handlePlayClick = async (e) => {
    // 1. If any modal is active, block playback from library cards
    const activeModal = document.querySelector(".modal-overlay.active");
    if (activeModal) {
      e.stopPropagation();
      return;
    }

    // 2. If context menu is active, just close it and stop further action
    if (elements.contextMenu && (elements.contextMenu.classList.contains("active") || elements.contextMenu.style.display === 'flex')) {
      elements.contextMenu.classList.remove("active");
      elements.contextMenu.style.display = 'none';
      e.stopPropagation();
      e.preventDefault();
      return;
    }

    e.preventDefault();
    const { selectTrack } = await import('../player.js');
    selectTrack(index);
  };

  card.addEventListener("click", handlePlayClick);

  card.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    e.stopPropagation(); 
    invoke('remote_js_log', { msg: `[Card] contextmenu triggered for path: ${song.path}` }).catch(() => {});
    showSongContextMenu(e, song, index);
  });

  elements.songGrid.appendChild(card);
}


export async function performDeleteSong(index) {
  const song = state.songLibrary[index];
  if (!song) return;

  const { deleteSongFromDb } = await import('../audio.js');
  try {
    const path = song.path;
    state.songLibrary.splice(index, 1);
    await deleteSongFromDb(path);
    return true;
  } catch (err) {
    console.error("Deletion failed:", err);
    throw err;
  }
}

export async function deleteSong(index) {
  const song = state.songLibrary[index];
  if (!song) return;
  
  const { openConfirmModal } = await import('./modals.js');
  const { showNotification } = await import('../utils.js');

  openConfirmModal("곡 삭제", `'${song.title}' 곡을 삭제하시겠습니까?`, async () => {
    try {
      await performDeleteSong(index);
      const { refreshFilterDropdowns } = await import('./core.js');
      await refreshFilterDropdowns();
      renderLibrary();
      showNotification("곡이 삭제되었습니다.", "success");
    } catch (err) {
      showNotification("곡 삭제 중 오류가 발생했습니다.", "error");
    }
  });
}
