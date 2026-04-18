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

export function getFilteredSongs() {
  const query = (elements.libSearchInput?.value || "").toLowerCase().trim();
  const genreFilter = elements.libGenreFilter?.value || "all";
  const categoryFilter = elements.libCategoryFilter?.value || "all";
  const sortBy = elements.libSortSelect?.value || "dateNew";
  const currentTab = state.activeView || "library";

  let filtered = state.library.map((s, i) => ({ ...s, originalIndex: i }));

  // Tab Filter
  if (currentTab === "youtube") filtered = filtered.filter(s => s.source === "youtube");
  else if (currentTab === "local") filtered = filtered.filter(s => s.source === "local");

  // Search Filter
  if (query) {
    filtered = filtered.filter(s =>
      s.title.toLowerCase().includes(query) ||
      (s.artist && s.artist.toLowerCase().includes(query)) ||
      (s.genre && s.genre.toLowerCase().includes(query)) ||
      (s.category && s.category.toLowerCase().includes(query)) ||
      (s.tags && s.tags.some(t => t.toLowerCase().includes(query)))
    );
  }

  // Genre Filter
  if (genreFilter !== "all" && genreFilter !== "") {
    filtered = filtered.filter(s => s.genre === genreFilter);
  }

  // Category Filter
  if (categoryFilter !== "all" && categoryFilter !== "") {
    filtered = filtered.filter(s => s.category === categoryFilter || (s.categories && s.categories.includes(categoryFilter)));
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
  card.className = "song-card";
  card.dataset.path = song.path;
  const isButton = state.viewMode === "button";
  const isList = state.viewMode === "list";

  if (isList) card.classList.add("list-row");

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
    
    ${isButton ? `
      <div class="button-content">
        <div class="song-name" title="${song.title || ''}"><span>${song.title || '제목 정보 없음'}</span></div>
        <div class="song-artist-badge ${!song.artist ? 'no-info' : ''}">${song.artist || '가수 정보 없음'}</div>
      </div>
      <div class="status-badge-container"></div>
    ` : isList ? `
      <div class="song-info-content list-layout">
        <div class="col col-info">
          <div class="info-row top-row">
            <div class="song-name" title="${song.title || ''}"><span>${song.title || '제목 정보 없음'}</span></div>
            <div class="status-badge-container"></div>
          </div>
          <div class="info-row bottom-row">
            <div class="song-artist-badge ${!song.artist ? 'no-info' : ''}">${song.artist || '가수 정보 없음'}</div>
            <div class="duration-text">${song.duration || '--:--'}</div>
          </div>
        </div>
        <div class="col col-genre">
          <div class="genre-list">
            <span class="genre-badge ${!song.genre ? 'no-info' : ''}">${(song.genre || '미분류').toUpperCase()}</span>
          </div>
        </div>
        <div class="col col-tags">
          <div class="tag-container ${!song.tags || song.tags.length === 0 ? 'no-info' : ''}">
            ${song.tags && song.tags.length > 0
              ? song.tags.map(t => `<span class="tag-badge">${t}</span>`).join('')
              : '<span class="tag-no-info">태그 없음</span>'}
          </div>
        </div>
      </div>
    ` : `
      <div class="song-info-content grid-layout">
        <div class="metadata-stack">
          <div class="song-name"><span>${song.title || '제목 정보 없음'}</span></div>
          <div class="song-artist-badge ${!song.artist ? 'no-info' : ''}">${song.artist || '가수 정보 없음'}</div>
          ${(song.curationCategory || song.originalTitle) ? `
            <div class="curation-info-badges">
              ${song.curationCategory ? `<span class="cur-badge cat">${song.curationCategory}</span>` : ''}
              ${song.originalTitle ? `<span class="cur-badge orig">${song.originalTitle}</span>` : ''}
            </div>
          ` : ''}
          <div class="song-meta">
            <div class="meta-badges">
              ${(song.category || (song.categories && song.categories.length > 0 ? song.categories[0] : ""))
      ? `<span class="category-badge">${song.category || song.categories[0]}</span>`
      : ''}
              <span class="genre-badge ${!song.genre ? 'no-info' : ''}">${(song.genre || '미분류').toUpperCase()}</span>
            </div>
            <span class="duration-text">${song.duration || '--:--'}</span>
          </div>
          <div class="tag-container ${!song.tags || song.tags.length === 0 ? 'no-info' : ''}">
            ${song.tags && song.tags.length > 0
      ? song.tags.map(t => `<span class="tag-badge">${t}</span>`).join('')
      : '<span class="tag-no-info">태그 정보 없음</span>'}
          </div>
        </div>
      </div>
    `}
  `;

  // Unified Status Badge (MR / 분리중 / 대기중)
  updateCardStatusBadge(song.path, card);

  // Integrated click handler: Play immediately on card or thumbnail click
  const handlePlayClick = async (e) => {
    // If context menu is active, just close it and stop further action
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


export async function deleteSong(index) {
  const song = state.library[index];
  if (!song) return;
  
  const { openConfirmModal } = await import('./modals.js');
  const { showNotification } = await import('../utils.js');
  const { deleteSongFromDb } = await import('../audio.js');

  openConfirmModal("곡 삭제", `'${song.title}' 곡을 삭제하시겠습니까?`, async () => {
    try {
      const path = song.path;
      state.library.splice(index, 1);
      await deleteSongFromDb(path);
      renderLibrary();
      showNotification("곡이 삭제되었습니다.", "success");
    } catch (err) {
      showNotification("곡 삭제 중 오류가 발생했습니다.", "error");
    }
  });
}
