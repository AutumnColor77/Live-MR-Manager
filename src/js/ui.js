/**
 * ui.js - DOM Rendering and UI Logic
 */

import { state, DEFAULT_CATEGORIES, SORT_OPTIONS } from './state.js';
import { getThumbnailUrl, showNotification } from './utils.js';
import { checkMrSeparated, saveLibrary, deleteSongFromDb, setVolume } from './audio.js';

const { invoke } = window.__TAURI__.core;

// DOM Cache
export const elements = {
  songGrid: null,
  libSearchInput: null,
  libGenreFilter: null,
  libCategoryFilter: null,
  libSortSelect: null,
  viewTitle: null,
  viewSubtitle: null,
  youtubeSection: null,
  localSection: null,
  libraryControls: null,
  dockTitle: null,
  dockArtist: null,
  dockThumb: null,
  dockThumbImg: null,
  thumbOverlay: null,
  togglePlayBtn: null,
  playbackBar: null,
  progressFill: null,
  timeCurrent: null,
  timeTotal: null,
  pitchSlider: null,
  tempoSlider: null,
  pitchVal: null,
  tempoVal: null,
  contextMenu: null,
  metadataModal: null,
  confirmModal: null,

  // Additional Controls
  volSlider: null,
  vocalBalance: null,
  viewGridBtn: null,
  viewListBtn: null,
  ytFetchBtn: null,
  ytUrlInput: null,
  btnPrev: null,
  btnNext: null,
  aiModelStatus: null,
  btnDownloadModel: null,
  btnDeleteModel: null,
  btnStartTrack: null,
  statusMsg: null,
  cudaRecommendBanner: null,
  viewControls: null,

  // Library Manager
  managerModal: null,
  btnOpenManager: null,
  managerSearchInput: null,
  managerTableBody: null,
  managerStat: null,
  toggleBroadcastMode: null,
  toggleBroadcastModeActive: null,
  broadcastTasksControl: null,
  btnMetadataSearch: null,
  metadataSearchResultsModal: null,
  searchResultsClose: null,
  editVolume: null,
  editVolumeVal: null,
  viewport: null,
  scrollArea: null,

  // Curation
  curationOriginal: null,
  curationCategory: null,
  curationTranslated: null,
  unclassifiedTagsList: null,
};

export function initDomReferences() {
  elements.songGrid = document.getElementById("song-grid");
  elements.viewTitle = document.getElementById("view-title");
  elements.viewSubtitle = document.getElementById("view-subtitle");
  elements.libSearchInput = document.getElementById("lib-search-input");
  elements.libGenreFilter = document.getElementById("lib-genre-filter");
  elements.libCategoryFilter = document.getElementById("lib-category-filter");
  elements.libSortSelect = document.getElementById("lib-sort-select");
  elements.libraryControls = document.getElementById("library-controls");
  elements.youtubeSection = document.getElementById("youtube-search");
  elements.localSection = document.getElementById("local-drop-section");

  elements.dockTitle = document.getElementById("dock-title");
  elements.dockArtist = document.getElementById("dock-artist");
  elements.dockThumb = document.getElementById("dock-thumb");
  elements.dockThumbImg = document.querySelector("#dock-thumb img");
  elements.thumbOverlay = document.getElementById("thumb-overlay");
  elements.togglePlayBtn = document.getElementById("btn-toggle-play");

  elements.playbackBar = document.getElementById("playback-bar");
  elements.progressFill = document.getElementById("progress-fill");
  elements.timeCurrent = document.getElementById("time-current");
  elements.timeTotal = document.getElementById("time-total");

  elements.pitchSlider = document.getElementById("pitch-slider");
  elements.tempoSlider = document.getElementById("tempo-slider");
  elements.pitchVal = document.getElementById("pitch-val");
  elements.tempoVal = document.getElementById("tempo-val");
  elements.btnResetAudio = document.getElementById("btn-reset-audio");

  elements.contextMenu = document.getElementById("context-menu");
  elements.metadataModal = document.getElementById("metadata-modal");
  elements.confirmModal = document.getElementById("confirm-modal");

  elements.volSlider = document.getElementById("master-volume-slider");
  elements.volSliderVal = document.getElementById("master-volume-val");
  elements.vocalBalance = document.getElementById("vocal-balance");
  elements.viewGridBtn = document.getElementById("view-grid");
  elements.viewListBtn = document.getElementById("view-list");
  elements.ytFetchBtn = document.getElementById("yt-fetch-btn");
  elements.ytUrlInput = document.getElementById("yt-url-input");
  elements.btnPrev = document.getElementById("btn-prev");
  elements.btnNext = document.getElementById("btn-next");
  elements.aiModelStatus = document.getElementById("ai-model-status");
  elements.btnDownloadModel = document.getElementById("btn-download-model");
  elements.btnDeleteModel = document.getElementById("btn-delete-model");
  elements.btnStartTrack = document.getElementById("btn-start-track");
  elements.statusMsg = document.getElementById("system-status-msg");
  elements.toggleVocal = document.getElementById("toggle-vocal");
  elements.toggleLyric = document.getElementById("toggle-lyric");
  elements.cudaRecommendBanner = document.getElementById("cuda-recommend-banner");

  // Library Manager
  elements.managerModal = document.getElementById("library-manager-modal");
  elements.btnOpenManager = document.getElementById("btn-open-manager");
  elements.managerSearchInput = document.getElementById("manager-search-input");
  elements.managerTableBody = document.getElementById("manager-table-body");
  elements.managerStat = document.getElementById("manager-stat");
  elements.viewControls = document.getElementById("view-controls");
  elements.toggleBroadcastMode = document.getElementById("toggle-broadcast-mode");
  elements.toggleBroadcastModeActive = document.getElementById("toggle-broadcast-mode-tasks");
  elements.broadcastTasksControl = document.getElementById("broadcast-tasks-control");
  elements.btnMetadataSearch = document.getElementById("btn-metadata-search");
  elements.metadataSearchResultsModal = document.getElementById("metadata-search-results-modal");
  elements.searchResultsList = document.getElementById("search-results-list");
  elements.searchResultsClose = document.getElementById("search-results-close");
  elements.editVolume = document.getElementById("edit-volume");
  elements.editVolumeVal = document.getElementById("edit-volume-val");

  elements.curationOriginal = document.getElementById("curation-original");
  elements.curationCategory = document.getElementById("curation-category");
  elements.curationTranslated = document.getElementById("curation-translated");
  elements.unclassifiedTagsList = document.getElementById("unclassified-tags-list");
  elements.scrollArea = document.querySelector(".scroll-area");
  elements.viewport = document.querySelector(".viewport");

  // Active Tasks UI
  elements.taskBadge = document.getElementById("task-badge");
  elements.activeTasksList = document.getElementById("active-tasks-list");
}

export function updateSuggestions(fieldId) {
  const fieldType = fieldId === "lib-search-input" ? "search" : fieldId.replace("edit-", ""); // title, artist, category, tags, search

  // 1. Get unique values from library for this field
  let allValues = [];
  state.songLibrary.forEach(song => {
    if (fieldType === "tags" || fieldType === "search") {
      if (song.tags) allValues.push(...song.tags);
    }
    if (fieldType === "category" || fieldType === "search") {
      if (song.category) allValues.push(song.category);
      if (song.categories) allValues.push(...song.categories);
    }
    if (fieldType === "artist" || fieldType === "search") {
      if (song.artist) allValues.push(song.artist);
    }
    if (fieldType === "title") {
      if (song.title) allValues.push(song.title);
    }
  });

  // Unique and clean
  let uniqueValues = [...new Set(allValues)].filter(v => v && v.trim());

  // 2. Filter by ignored list (stored in localStorage)
  const ignoredCat = JSON.parse(localStorage.getItem(`ignored-category`) || "[]");
  const ignoredTags = JSON.parse(localStorage.getItem(`ignored-tags`) || "[]");
  const ignoredArtist = JSON.parse(localStorage.getItem(`ignored-artist`) || "[]");
  const ignoredSearch = JSON.parse(localStorage.getItem(`ignored-search`) || "[]");

  uniqueValues = uniqueValues.filter(v => {
    return !ignoredCat.includes(v) && !ignoredTags.includes(v) && !ignoredArtist.includes(v) && !ignoredSearch.includes(v);
  });

  // 3. Filter by query
  const inputEl = document.getElementById(fieldId);
  if (!inputEl) return;
  const query = inputEl.value.trim().toLowerCase();

  let filtered = uniqueValues;
  if (query) {
    filtered = uniqueValues.filter(v => v.toLowerCase().includes(query));
  }

  // Limit results
  filtered = filtered.slice(0, 10);

  const dropdown = document.getElementById(`${fieldId}-suggestions`);
  if (dropdown) {
    renderSuggestions(inputEl, dropdown, filtered);
  }
}

function renderSuggestions(inputEl, dropdown, suggestions) {
  if (suggestions.length === 0) {
    dropdown.innerHTML = "";
    dropdown.classList.remove("active");
    return;
  }

  dropdown.innerHTML = suggestions.map(val => `
    <div class="suggestion-item" data-value="${val.replace(/"/g, '&quot;')}">
      <span class="suggestion-text">${val}</span>
      <div class="suggestion-del-btn" title="제안에서 삭제">&times;</div>
    </div>
  `).join("");

  dropdown.classList.add("active");

  // Re-bind click events for newly rendered items
  dropdown.querySelectorAll(".suggestion-item").forEach(item => {
    item.onclick = (e) => {
      const delBtn = e.target.closest(".suggestion-del-btn");
      if (delBtn) {
        e.stopPropagation();
        handleSuggestionDelete(inputEl, item.dataset.value);
      } else {
        const value = item.dataset.value;
        const fieldId = inputEl.id;

        if (fieldId === "edit-tags") {
          // Append for tags
          const currentTags = inputEl.value.split(",").map(t => t.trim()).filter(t => t);
          if (!currentTags.includes(value)) {
            currentTags.push(value);
            inputEl.value = currentTags.join(", ") + ", ";
          }
        } else {
          inputEl.value = value;
          // Trigger any related UI updates (like filtering the library)
          inputEl.dispatchEvent(new Event("input"));
        }
        dropdown.classList.remove("active");
        inputEl.focus();
      }
    };
  });
}

function handleSuggestionDelete(inputEl, value) {
  const fieldId = inputEl.id;
  const fieldType = fieldId === "lib-search-input" ? "search" : fieldId.replace("edit-", "");
  const ignored = JSON.parse(localStorage.getItem(`ignored-${fieldType}`) || "[]");
  if (!ignored.includes(value)) {
    ignored.push(value);
    localStorage.setItem(`ignored-${fieldType}`, JSON.stringify(ignored));
  }
  updateSuggestions(fieldId);
}

export function renderLibrary() {
  if (!elements.songGrid) return;

  // Ensure every song in the master library has an original index for tracking 
  // AND synchronize category/categories to ensure UI consistency
  state.songLibrary.forEach((s, i) => {
    s.originalIndex = i;

    // Sync category (singular) and categories (plural) for consistency
    if (s.category && (!s.categories || s.categories.length === 0 || s.categories[0] !== s.category)) {
      s.categories = [s.category];
    } else if (!s.category && s.categories && s.categories.length > 0) {
      s.category = s.categories[0];
    }
  });

  elements.songGrid.innerHTML = "";

  const query = (elements.libSearchInput?.value || "").toLowerCase().trim();
  const genreFilter = elements.libGenreFilter?.value || "all";
  const sortBy = elements.libSortSelect?.value || "dateNew";
  const currentTab = document.querySelector(".nav-item.active")?.id.replace("nav-", "") || "library";

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
      (s.category && s.category.toLowerCase().includes(query)) ||
      (s.tags && s.tags.some(t => t.toLowerCase().includes(query)))
    );
  }

  // Genre Filter
  if (genreFilter !== "all" && genreFilter !== "") {
    filtered = filtered.filter(s => s.genre === genreFilter);
  }

  // Category Filter
  const categoryFilter = elements.libCategoryFilter?.value || "all";
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

  // Update Global Filtered State
  state.filteredTracks = filtered;

  if (filtered.length === 0) {
    elements.songGrid.innerHTML = `<div class="empty-state" style="grid-column: 1/-1; text-align: center; padding: 40px; color: var(--text-dim);">결과가 없습니다.</div>`;
    return;
  }

  filtered.forEach(song => {
    addSongCard(song, song.originalIndex);
  });

  updateThumbnailOverlay();
  syncDockMetadata();
}

/**
 * Synchronizes the player dock UI with current track metadata
 */
export function syncDockMetadata() {
  if (!state.currentTrack) return;

  const song = state.currentTrack;
  if (elements.dockTitle) elements.dockTitle.textContent = song.title;
  if (elements.dockArtist) elements.dockArtist.textContent = song.artist || "Unknown Artist";
  if (elements.dockThumbImg) {
    elements.dockThumbImg.src = getThumbnailUrl(song.thumbnail, song);
  }
}

function addSongCard(song, index) {
  const card = document.createElement("article");
  card.className = `song-card ${state.viewMode === "list" ? "list-view-item" : ""}`;
  card.dataset.path = song.path;
  card.dataset.index = index; // Store original index correctly
  
  const thumbUrl = getThumbnailUrl(song.thumbnail, song);
  const isList = state.viewMode === "list";

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
    
    ${isList ? `
      <div class="col-info">
        <div class="song-name"><span>${song.title || '제목 정보 없음'}</span></div>
        <div class="song-artist-badge ${!song.artist ? 'no-info' : ''}">${song.artist || '가수 정보 없음'}</div>
      </div>
      <div class="status-badge-container"></div>
      <div class="col-genre">
        ${(song.category || (song.categories && song.categories.length > 0 ? song.categories[0] : ""))
        ? `<div class="category-list"><span class="category-badge">${song.category || song.categories[0]}</span></div>`
        : ''}
        <div class="genre-list">
          <span class="genre-badge ${!song.genre ? 'no-info' : ''}">${(song.genre || '미분류').toUpperCase()}</span>
        </div>
      </div>
      <div class="col-tags">
        <div class="tag-container ${!song.tags || song.tags.length === 0 ? 'no-info' : ''}">
          ${song.tags && song.tags.length > 0
        ? song.tags.map(t => `<span class="tag-badge">${t}</span>`).join('')
        : '<span class="tag-no-info">태그 없음</span>'}
        </div>
      </div>
      <div class="col-duration">
        <span class="duration-text">${song.duration || '--:--'}</span>
      </div>
    ` : `
      <div class="song-info-content grid-layout">
        <div class="metadata-stack">
          <div class="song-name"><span>${song.title || '제목 정보 없음'}</span></div>
          <div class="song-artist-badge ${!song.artist ? 'no-info' : ''}">${song.artist || '가수 정보 없음'}</div>
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
    if (elements.contextMenu && elements.contextMenu.classList.contains("active")) {
      elements.contextMenu.classList.remove("active");
      e.stopPropagation();
      e.preventDefault();
      return;
    }

    // e.stopPropagation(); // Allow propagation for unified selection tracking
    e.preventDefault();
    const { selectTrack } = await import('./player.js');
    selectTrack(index);
  };

  card.addEventListener("click", handlePlayClick);

  card.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    showSongContextMenu(e, song, index);
  });

  elements.songGrid.appendChild(card);
}

export function updateThumbnailOverlay() {
  document.querySelectorAll(".song-card").forEach((card) => {
    const cardIndex = parseInt(card.dataset.index);
    const isActive = state.currentTrack && state.currentTrack.path === card.dataset.path;
    const isSelected = state.selectedTrackIndex === cardIndex;

    card.classList.toggle("active", isActive);
    card.classList.toggle("selected", isSelected);

    // Visual feedback: dim non-selected items
    card.style.opacity = (state.selectedTrackIndex === -1 || isSelected) ? "1" : "0.6";

    const overlay = card.querySelector(".thumb-overlay");
    if (overlay) {
      overlay.classList.toggle("active", isActive || isSelected);
      overlay.classList.toggle("playing", isActive && state.isPlaying);
      overlay.classList.toggle("loading", isActive && state.isLoading);
      overlay.classList.toggle("paused", isActive && !state.isPlaying && !state.isLoading);

      // Visual feedback for 2-step selection: 
      // If selected but NOT playing, show a distinct "ready" highlight
      overlay.classList.toggle("selected-ready", isSelected && !isActive);
    }
  });

  // btnStartTrack logic removed

  if (elements.thumbOverlay) {
    const hasTrack = !!state.currentTrack;
    elements.thumbOverlay.classList.toggle("active", hasTrack);
    elements.thumbOverlay.classList.toggle("playing", state.isPlaying);
    elements.thumbOverlay.classList.toggle("loading", state.isLoading);
    elements.thumbOverlay.classList.toggle("paused", !state.isPlaying && !state.isLoading && hasTrack);
  }
}

export function updatePlayButton() {
  if (elements.btnNext) {
    elements.btnNext.onclick = async () => {
      const { handleNextTrack } = await import('./player.js');
      handleNextTrack();
    };
  }

  if (elements.btnPrev) {
    elements.btnPrev.onclick = async () => {
      const { handlePrevTrack } = await import('./player.js');
      handlePrevTrack();
    };
  }

  if (elements.togglePlayBtn) {
    elements.togglePlayBtn.classList.toggle("is-playing", state.isPlaying);
  }
}

export function updateGenreDropdowns() {
  const categories = [...new Set(state.songLibrary.map(s => s.genre).filter(c => c))];
  const customCategories = categories.filter(c => !DEFAULT_CATEGORIES.some(dc => dc.val === c));

  const options = [
    { val: "all", text: "전체 장르" },
    ...DEFAULT_CATEGORIES,
    ...customCategories.map(c => ({ val: c, text: c })),
    { val: "etc", text: "기타" }
  ];

  renderDropdownOptions("lib-genre-dropdown", options, (val) => {
    if (elements.libGenreFilter) elements.libGenreFilter.value = val;
    renderLibrary();
  });

  // Meta Modal Categories
  renderDropdownOptions("edit-genre-dropdown", [
    ...DEFAULT_CATEGORIES,
    ...customCategories.map(c => ({ val: c, text: c })),
    { val: "etc", text: "직접 입력" }
  ], (val) => {
    const editCatSelect = document.getElementById("edit-genre-select");
    const editCatCustom = document.getElementById("edit-genre-custom");
    if (editCatSelect) editCatSelect.value = val;
    if (editCatCustom) editCatCustom.style.display = (val === "etc") ? "block" : "none";
  });
}

export function updateCategoryDropdown() {
  const allCats = [...new Set(state.songLibrary.flatMap(s => {
    if (s.category) return [s.category];
    if (s.categories) return s.categories;
    return [];
  }).filter(c => c))];

  const options = [
    { val: "all", text: "전체 카테고리" },
    ...allCats.map(c => ({ val: c, text: c }))
  ];

  renderDropdownOptions("lib-category-dropdown", options, (val) => {
    if (elements.libCategoryFilter) elements.libCategoryFilter.value = val;
    renderLibrary();
  });
}

/**
 * Initializes and updates the library Sort dropdown
 */
export function updateSortDropdown() {
  renderDropdownOptions("lib-sort-dropdown", SORT_OPTIONS, (val) => {
    if (elements.libSortSelect) elements.libSortSelect.value = val;
    renderLibrary();
  });
}

export function renderDropdownOptions(id, opts, cb) {
  const el = document.getElementById(id);
  if (!el) return;
  const container = el.querySelector(".select-options");
  const selectedText = el.querySelector(".selected-text");

  container.innerHTML = opts.map(o => `<div class="option-item" data-value="${o.val}">${o.text}</div>`).join("");

  container.querySelectorAll(".option-item").forEach(opt => {
    opt.onclick = (e) => {
      e.stopPropagation();
      if (selectedText) selectedText.textContent = opt.textContent;
      el.classList.remove("active");
      cb(opt.dataset.value);
    };
  });
}

function showSongContextMenu(e, song, originalIndex) {
  if (!elements.contextMenu) return;
  state.editingSongIndex = originalIndex;

  // Boundary check to prevent menu from overflowing viewport
  const menuWidth = 160;   // Estimated menu width
  const menuHeight = 200;  // Estimated max menu height
  let x = e.clientX;
  let y = e.clientY;
  const winW = window.innerWidth;
  const winH = window.innerHeight;

  if (x + menuWidth > winW) x = winW - menuWidth - 10;
  if (y + menuHeight > winH) y = winH - menuHeight - 10;
  if (x < 10) x = 10;
  if (y < 10) y = 10;

  elements.contextMenu.style.top = `${y}px`;
  elements.contextMenu.style.left = `${x}px`;
  elements.contextMenu.classList.add("active");

  const menuSeparate = document.getElementById("menu-separate");
  const menuDeleteMr = document.getElementById("menu-delete-mr");

  // Initial state: hide until checked
  if (menuDeleteMr) menuDeleteMr.style.display = "none";
  if (menuSeparate) menuSeparate.style.display = "none";

  checkMrSeparated(song.path).then(isSeparated => {
    if (menuDeleteMr) {
      menuDeleteMr.style.display = isSeparated ? "block" : "none";
      menuDeleteMr.onclick = async () => {
        elements.contextMenu.classList.remove("active");
        try {
          const { invoke } = window.__TAURI__.core;
          
          // 1. 백엔드에서 안전하게 중단 및 삭제 수행 (백엔드 내부에서 stop_playback 로직 포함됨)
          await invoke("delete_mr", { path: song.path });

          // 2. 라이브러리 상태 업데이트 (원본 데이터 갱신)
          const masterTrack = state.songLibrary.find(s => s.path === song.path);
          if (masterTrack) masterTrack.isMr = false;
          await saveLibrary(state.songLibrary);

          // 3. 현재 재생 중인 곡이었다면 UI 초기화
          if (state.currentTrack && state.currentTrack.path === song.path) {
            state.isPlaying = false;
            state.currentProgressMs = 0;
            state.targetProgressMs = 0;
            if (elements.playbackBar) elements.playbackBar.value = 0;
            if (elements.progressFill) elements.progressFill.style.width = "0%";
            if (elements.timeCurrent) elements.timeCurrent.textContent = "0:00";

            updateThumbnailOverlay();
            updatePlayButton();
          }

          showNotification("MR 파일이 삭제되었습니다. 원본 곡으로 재생됩니다.", "success");
        } catch (err) {
          console.error("MR Delete failed:", err);
          showNotification("MR 삭제 중 오류가 발생했습니다: " + err, "error");
        } finally {
          // 어떤 상황에서도 UI는 최신 상태로 갱신
          renderLibrary();
        }
      };
    }

    if (menuSeparate) {
      const activeTask = state.activeTasks[song.path];
      const isSeparating = activeTask && activeTask.status !== "Finished";

      if (isSeparated) {
        menuSeparate.style.display = "none";
      } else {
        menuSeparate.style.display = "block";
        if (isSeparating) {
          menuSeparate.textContent = "분리 취소";
          menuSeparate.onclick = () => {
            elements.contextMenu.classList.remove("active");
            if (window.cancelTask) window.cancelTask(song.path);
          };
        } else {
          menuSeparate.textContent = "MR 분리";
          menuSeparate.onclick = async () => {
            elements.contextMenu.classList.remove("active");
            try {
              const { startMrSeparation } = await import('./audio.js');
              await startMrSeparation(song.path);
            } catch (err) {
              console.error("Separation trigger failed:", err);
            }
          };
        }
      }
    }
  });

  // Internal bind to global select logic
  const menuPlay = document.getElementById("menu-play");
  if (menuPlay) {
    const isCurrent = state.currentTrack && state.currentTrack.path === song.path;
    menuPlay.textContent = (isCurrent && state.isPlaying) ? "일시정지" : "재생";

    menuPlay.onclick = async () => {
      elements.contextMenu.classList.remove("active");
      const { selectTrack, handlePlaybackToggle } = await import('./player.js');

      if (isCurrent) {
        await handlePlaybackToggle();
      } else {
        await selectTrack(originalIndex);
      }
    };
  }

  document.getElementById("menu-edit").onclick = () => {
    openEditModal(song, originalIndex);
    elements.contextMenu.classList.remove("active");
  };

  document.getElementById("menu-delete").onclick = () => {
    deleteSong(originalIndex);
    elements.contextMenu.classList.remove("active");
  };
}


function openEditModal(song, index) {
  state.editingSongIndex = index;

  // Reset scroll position of modal body
  const modalBody = elements.metadataModal?.querySelector(".modal-body");
  if (modalBody) modalBody.scrollTop = 0;

  document.getElementById("edit-title").value = song.title || "";
  document.getElementById("edit-artist").value = song.artist || "";
  document.getElementById("edit-tags").value = (song.tags || []).join(", ");
  document.getElementById("edit-category").value = song.category || (song.categories && song.categories[0]) || "";

  const currentGenre = song.genre || "etc";
  const isDefault = DEFAULT_CATEGORIES.some(c => c.val === currentGenre);
  const editCatSelect = document.getElementById("edit-genre-select");
  const editCatCustom = document.getElementById("edit-genre-custom");

  if (isDefault) {
    if (editCatSelect) editCatSelect.value = currentGenre;
    if (editCatCustom) editCatCustom.style.display = "none";
  } else {
    if (editCatSelect) editCatSelect.value = "etc";
    if (editCatCustom) {
      editCatCustom.style.display = "block";
      editCatCustom.value = currentGenre;
    }
  }

  // Sync Dropdown UI
  const dropdown = document.getElementById("edit-genre-dropdown");
  if (dropdown) {
    const selectedText = dropdown.querySelector(".selected-text");
    const options = dropdown.querySelectorAll(".option-item");
    options.forEach(opt => {
      opt.classList.remove("selected");
      if (opt.dataset.value === (isDefault ? currentGenre : "etc")) {
        opt.classList.add("selected");
        if (selectedText) selectedText.textContent = opt.textContent;
      }
    });
  }

  // MR Checkbox: check if song is already marked as MR or has separated files
  const mrCheckbox = document.getElementById("edit-is-mr");
  const mrText = document.querySelector(".mr-checkbox-text");
  if (mrCheckbox) {
    mrCheckbox.checked = !!song.isMr;
    mrCheckbox.disabled = false;
    if (mrText) mrText.textContent = "이 곡은 이미 MR(인스트루먼탈)입니다";

    // If MR files exist on disk (AI separated), lock the checkbox
    checkMrSeparated(song.path).then(isSeparated => {
      if (isSeparated) {
        mrCheckbox.checked = true;
        mrCheckbox.disabled = true;
        if (mrText) mrText.textContent = "AI 분리 완료 (MR 삭제로 해제)";
      }
    });
  }

  // 곡별 볼륨 슬라이더 초기화
  if (elements.editVolume) {
    const vol = song.volume ?? 80;
    elements.editVolume.value = vol;
    if (elements.editVolumeVal) elements.editVolumeVal.textContent = Math.round(vol);
  }

  elements.metadataModal.classList.add("active");
}

function deleteSong(index) {
  const song = state.songLibrary[index];
  if (!song) return;

  const confirmTitle = document.getElementById("confirm-title");
  const confirmMsg = document.getElementById("confirm-message");
  const confirmOk = document.getElementById("confirm-ok");

  if (confirmTitle) confirmTitle.textContent = "곡 삭제";
  if (confirmMsg) confirmMsg.textContent = `'${song.title}' 곡을 삭제하시겠습니까?`;

  if (confirmOk) {
    confirmOk.onclick = async () => {
      try {
        const path = song.path;
        state.songLibrary.splice(index, 1);
        await deleteSongFromDb(path);
        renderLibrary();
        elements.confirmModal.classList.remove("active");
        showNotification("곡이 삭제되었습니다.", "success");
      } catch (err) {
        showNotification("곡 삭제 중 오류가 발생했습니다.", "error");
      }
    };
  }
  elements.confirmModal.classList.add("active");
}

/**
 * Updates the AI Model status badge in Settings
 */
export function updateAiModelStatus(isReady) {
  if (!elements.aiModelStatus) return;

  if (isReady) {
    elements.aiModelStatus.textContent = "Online (Ready)";
    elements.aiModelStatus.className = "ai-status-badge status-online";
  } else {
    elements.aiModelStatus.textContent = "Offline (Need Download)";
    elements.aiModelStatus.className = "ai-status-badge status-offline";
  }
}

/**
 * Updates the GPU Recommendation banner based on hardware detection
 */
export function updateGpuStatus(gpuStatus) {
  if (!elements.cudaRecommendBanner) return;

  if (gpuStatus && gpuStatus.recommendCuda) {
    elements.cudaRecommendBanner.style.display = "flex";
    console.log("[UI] NVIDIA GPU detected but CUDA is missing. Showing recommendation banner.");
  } else {
    elements.cudaRecommendBanner.style.display = "none";
  }
}

/**
 * Updates VOCAL/LYRIC toggle states based on track requirements and global state
 */
export async function updateAiTogglesState(song = null) {
  if (!elements.toggleVocal || !elements.toggleLyric) return;

  // Use current playing track if no specific song is highlighted
  const effectiveSong = song || state.currentTrack;

  // 1. Restore Checked State from Global State (Persistence)
  elements.toggleVocal.checked = state.vocalEnabled;
  elements.toggleLyric.checked = state.lyricsEnabled;

  if (!effectiveSong) {
    // Keep enabled so user can set preferences for the next track
    elements.toggleVocal.disabled = false;
    elements.toggleLyric.disabled = false;
    elements.toggleVocal.closest(".ai-item")?.classList.remove("disabled");
    elements.toggleLyric.closest(".ai-item")?.classList.remove("disabled");
    return;
  }

  // 2. Control Disabled state ONLY if a track is present but has no MR
  const isSeparated = await checkMrSeparated(effectiveSong.path);
  elements.toggleVocal.disabled = !isSeparated;
  elements.toggleVocal.closest(".ai-item")?.classList.toggle("disabled", !isSeparated);

  // Lyrics toggle logic (Always active if track present)
  elements.toggleLyric.disabled = false;
  elements.toggleLyric.closest(".ai-item")?.classList.remove("disabled");
}

/**
 * Opens the Library Manager popup
 */
export function openLibraryManager() {
  if (!elements.managerModal) return;
  elements.managerModal.classList.add("active");

  // Reset scroll position of table container
  const container = elements.managerModal.querySelector(".table-container");
  if (container) container.scrollTop = 0;

  // Reset search and sort states
  if (elements.managerSearchInput) elements.managerSearchInput.value = "";
  document.querySelectorAll("#manager-table th").forEach(th => th.removeAttribute("data-order"));

  renderManagerTable();
}

/**
 * Renders the rows of the Library Manager table
 */
export function renderManagerTable() {
  if (!elements.managerTableBody) return;

  const searchQuery = elements.managerSearchInput ? elements.managerSearchInput.value.trim().toLowerCase() : "";
  let data = state.songLibrary.map((s, originalIndex) => ({ ...s, originalIndex }));

  // 1. Filter
  if (searchQuery) {
    data = data.filter(s =>
      (s.title || "").toLowerCase().includes(searchQuery) ||
      (s.artist || "").toLowerCase().includes(searchQuery) ||
      (s.category || "").toLowerCase().includes(searchQuery) ||
      (s.genre || "").toLowerCase().includes(searchQuery) ||
      (s.tags || []).some(t => t.toLowerCase().includes(searchQuery))
    );
  }

  // 2. Sort
  const activeHeader = document.querySelector("#manager-table th[data-order]");
  if (activeHeader) {
    const key = activeHeader.dataset.sort;
    const order = activeHeader.dataset.order;
    data.sort((a, b) => {
      let valA = (a[key] || "").toString().toLowerCase();
      let valB = (b[key] || "").toString().toLowerCase();
      const cmp = valA.localeCompare(valB, undefined, { numeric: true, sensitivity: 'base' });
      return order === "asc" ? cmp : -cmp;
    });
  }

  // 3. Render
  elements.managerTableBody.innerHTML = data.map(song => `
    <tr data-index="${song.originalIndex}">
      <td class="text-center"><input type="text" value="${song.title || ''}" data-field="title" spellcheck="false"></td>
      <td class="text-center"><input type="text" value="${song.artist || ''}" data-field="artist" spellcheck="false"></td>
      <td class="text-center"><input type="text" value="${song.category || ''}" data-field="category" spellcheck="false"></td>
      <td class="text-center"><input type="text" value="${song.genre || ''}" data-field="genre" spellcheck="false"></td>
      <td class="text-center"><input type="text" value="${(song.tags || []).join(', ')}" data-field="tags" spellcheck="false"></td>
      <td class="text-center"><input type="text" value="${song.duration || '--:--'}" readonly style="opacity: 0.5; cursor: default;"></td>
      <td class="text-center">
        <button class="btn-row-del" data-index="${song.originalIndex}">삭제</button>
      </td>
    </tr>
  `).join("");

  if (elements.managerStat) {
    elements.managerStat.textContent = `총 ${data.length}곡 등록됨`;
  }

  // Load stored widths
  applyTableWidths();
}

/**
 * Initializes table column resizing functionality
 */
export function initTableResizing() {
  const table = document.getElementById("manager-table");
  if (!table) return;

  const ths = table.querySelectorAll("th");
  const colgroup = document.getElementById("manager-table-colgroup");
  if (!colgroup) return;
  const cols = colgroup.querySelectorAll("col");

  ths.forEach((th, i) => {
    // We only attach resizers to columns that have a successor to trade width with
    if (i >= cols.length - 1) {
      const lastResizer = th.querySelector(".resizer");
      if (lastResizer) lastResizer.style.display = "none";
      return;
    }

    const resizer = th.querySelector(".resizer");
    if (!resizer) return;

    let startX, startWidthLeft, startWidthRight, totalTableWidth;
    const colLeft = cols[i];
    const colRight = cols[i + 1];

    const onMouseMove = (e) => {
      if (!startX) return;
      const dx = e.clientX - startX;

      const newWidthLeftPx = startWidthLeft + dx;
      const newWidthRightPx = startWidthRight - dx;

      // Minimum width protection (e.g., 40px)
      if (newWidthLeftPx > 40 && newWidthRightPx > 40) {
        // Apply as percentages to maintain total width at 100%
        const leftPct = (newWidthLeftPx / totalTableWidth) * 100;
        const rightPct = (newWidthRightPx / totalTableWidth) * 100;

        colLeft.style.width = leftPct + "%";
        colRight.style.width = rightPct + "%";
      }
    };

    const onMouseUp = () => {
      startX = null;
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
      document.body.classList.remove("resizing");
      saveTableWidths();
    };

    resizer.addEventListener("mousedown", (e) => {
      startX = e.clientX;
      totalTableWidth = table.offsetWidth;
      startWidthLeft = colLeft.offsetWidth;
      startWidthRight = colRight.offsetWidth;

      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", onMouseUp);
      document.body.classList.add("resizing");
      e.preventDefault();
      e.stopPropagation();
    });

    // Prevent click event from bubbling up to the th (sorting trigger)
    resizer.addEventListener("click", (e) => {
      e.stopPropagation();
    });
  });
}

function saveTableWidths() {
  const table = document.getElementById("manager-table");
  const colgroup = document.getElementById("manager-table-colgroup");
  if (!table || !colgroup) return;

  const totalWidth = table.offsetWidth;
  if (totalWidth <= 0) return;

  const cols = colgroup.querySelectorAll("col");
  const percentages = Array.from(cols).map(col => (col.offsetWidth / totalWidth) * 100);
  localStorage.setItem("lib-manager-widths-pct", JSON.stringify(percentages));
}

export function applyTableWidths() {
  const colgroup = document.getElementById("manager-table-colgroup");
  if (!colgroup) return;

  const cols = colgroup.querySelectorAll("col");
  const storedData = localStorage.getItem("lib-manager-widths-pct");

  let percentages;
  // Refined default layout for first-time users
  const defaultPercentages = [28, 14, 11, 11, 23, 7, 6];

  if (storedData) {
    try {
      percentages = JSON.parse(storedData);
      if (percentages.length !== cols.length) percentages = defaultPercentages;
    } catch (e) {
      percentages = defaultPercentages;
    }
  } else {
    percentages = defaultPercentages;
  }

  percentages.forEach((p, i) => {
    if (cols[i]) cols[i].style.width = p + "%";
  });
}

/**
 * Renders the Curation tab in Library Manager
 */
export async function renderCurationTab() {
  if (!elements.unclassifiedTagsList) return;

  elements.unclassifiedTagsList.innerHTML = '<div style="padding: 20px; text-align: center; color: #888;">데이터 분석 중...</div>';

  try {
    const { invoke } = window.__TAURI__.core;
    const tags = await invoke("get_unclassified_tags");
    console.log("[DEBUG] Unclassified Tags received:", tags);
    const sortedTags = Object.entries(tags).sort((a, b) => b[1] - a[1]);

    if (sortedTags.length === 0) {
      elements.unclassifiedTagsList.innerHTML = '<div style="padding: 20px; text-align: center; color: #888;">새로 발견된 미분류 태그가 없습니다.</div>';
      return;
    }

    elements.unclassifiedTagsList.innerHTML = sortedTags.map(([tag, hits]) => `
      <div class="unclassified-item" data-tag="${tag}">
        <span class="tag-text">${tag}</span>
        <span class="hit-count">${hits} hits</span>
      </div>
    `).join("");

    // Bind click events
    elements.unclassifiedTagsList.querySelectorAll(".unclassified-item").forEach(item => {
      item.onclick = () => {
        elements.unclassifiedTagsList.querySelectorAll(".unclassified-item").forEach(i => i.classList.remove("selected"));
        item.classList.add("selected");
        if (elements.curationOriginal) {
          elements.curationOriginal.value = item.dataset.tag;
          if (elements.curationTranslated) {
            elements.curationTranslated.value = "";
            elements.curationTranslated.focus();
          }
        }
      };
    });
  } catch (err) {
    elements.unclassifiedTagsList.innerHTML = '<div style="padding: 20px; text-align: center; color: var(--danger);">불러오기 실패</div>';
  }
}

/**
 * Sets up a ResizeObserver on the parent container to enable smooth layout transitions
 * using the FLIP (First, Last, Invert, Play) technique.
 */
export function setupGridResizeObserver() {
  const container = elements.scrollArea || (elements.songGrid ? elements.songGrid.parentElement : null);
  if (!container || !elements.songGrid) return;
  
  const ro = new ResizeObserver(entries => {
    if (state.viewMode === 'list') return;
    
    for (let entry of entries) {
      const width = entry.contentRect.width;
      if (width <= 0) continue;
      
      const columns = Math.floor((width + 24) / (200 + 24));
      
      if (columns > 0 && state.lastColumns !== columns) {
        // 1. [First] Capture current positions
        const cards = Array.from(elements.songGrid.querySelectorAll('.song-card'));
        const firstPositions = cards.map(card => {
          const rect = card.getBoundingClientRect();
          return { id: card.dataset.index, left: rect.left, top: rect.top };
        });

        // 2. [Last] Apply new layout
        state.lastColumns = columns;
        elements.songGrid.style.gridTemplateColumns = `repeat(${columns}, 200px)`;

        // 3. [Invert & Play] Trigger animation in next frame to allow layout shift
        requestAnimationFrame(() => {
          cards.forEach((card, i) => {
            const first = firstPositions[i];
            const last = card.getBoundingClientRect();

            const dx = first.left - last.left;
            const dy = first.top - last.top;

            if (dx === 0 && dy === 0) return;

            // Invert: Set to old position immediately (no transition)
            card.style.transition = 'none';
            card.style.transform = `translate(${dx}px, ${dy}px)`;

            // Force reflow
            card.offsetHeight;

            // Play: Trigger smooth move to new position
            card.style.transition = ''; // Restore CSS transition
            card.style.transform = '';
          });
        });
      }
    }
  });
  
  ro.observe(container);

  // Initial column count sync using container width
  const initialWidth = container.clientWidth;
  if (initialWidth > 0) {
    state.lastColumns = Math.floor((initialWidth + 24) / (200 + 24));
    if (state.lastColumns > 0) {
      elements.songGrid.style.gridTemplateColumns = `repeat(${state.lastColumns}, 200px)`;
    }
  }
}

/**
 * Updates the Active Tasks UI (badge count and task list)
 * @param {string|null} targetPath - Optional path for partial update
 */
export function updateTaskUI(targetPath = null) {
  const badge = elements.taskBadge || document.getElementById("task-badge");
  const list = elements.activeTasksList || document.getElementById("active-tasks-list");
  if (!list) return;

  const allTasks = Object.entries(state.activeTasks);
  const runningTasks = allTasks.filter(([_, t]) => t.status !== "Finished" && t.status !== "Cancelled" && t.status !== "Error");
  const activeCount = runningTasks.length;
  
  if (badge) {
    badge.textContent = activeCount;
    badge.style.display = activeCount > 0 ? "flex" : "none";
  }

  // 1. Partial Update: Only update progress/status if task exists in DOM
  if (targetPath) {
    const cards = list.querySelectorAll('.task-card');
    const existingCard = Array.from(cards).find(el => el.dataset.taskPath === targetPath);
    
    if (existingCard) {
      const task = state.activeTasks[targetPath];
      const bar = existingCard.querySelector(".task-progress-bar");
      const pctText = existingCard.querySelector(".task-percentage");
      const statusTextEl = existingCard.querySelector(".task-status-text");
      
      const pct = Math.round(task.percentage);
      if (bar) bar.style.width = pct + '%';
      if (pctText) pctText.textContent = pct + '%';
      if (statusTextEl) {
        const s = (task.status || "").toLowerCase();
        statusTextEl.textContent = s === "queued" ? "대기 중..." : s === "starting" ? "준비 중..." : task.status;
      }

      const badgeEl = existingCard.querySelector(".task-provider-badge");
      if (badgeEl && task.provider) {
        const rawProv = task.provider.toUpperCase();
        const isGPU = rawProv.includes("GPU") || rawProv.includes("CUDA") || rawProv.includes("DIRECTML");
        const isCPU = rawProv.includes("CPU");
        const isNetwork = rawProv.includes("NETWORK") || task.status.toLowerCase().includes("down");
        const isSystem = rawProv.includes("SYSTEM") || task.status.includes("모델");

        let pText = "AI";
        let pClass = "provider-ai";

        if (isGPU) { pText = "GPU"; pClass = "provider-gpu"; }
        else if (isCPU) { pText = "CPU"; pClass = "provider-cpu"; }
        else if (isNetwork) { pText = "NETWORK"; pClass = "provider-network"; }
        else if (isSystem) { pText = "AI"; pClass = "provider-ai"; }
        else if (task.status === "Queued") { pText = "QUEUED"; pClass = "provider-queued"; }

        badgeEl.textContent = pText;
        badgeEl.className = "task-provider-badge " + pClass;
      }
      
      const isRunning = task.status !== "Finished" && task.status !== "Cancelled" && task.status !== "Error";
      if (isRunning) return; 
    }
  }

  // 2. Full Render
  if (allTasks.length === 0) {
    list.innerHTML = '<div class="no-tasks">현재 진행 중인 작업이 없습니다.</div>';
  } else {
    list.innerHTML = allTasks.map(([path, t]) => {
      const normalize = (p) => (p ? decodeURIComponent(p).replace(/\\/g, '/').toLowerCase() : '');
      const targetNorm = normalize(path);
      const song = state.songLibrary.find(s => normalize(s.path) === targetNorm);
      
      let displayName = song ? song.title : (path ? decodeURIComponent(path).split(/[\\/]/).pop() : 'Unknown');
      const thumbnail = song ? song.thumbnail : null;
      
      if (!song && path.startsWith('http')) {
        displayName = "YouTube 오디오 추출 중...";
      }

      const pct = Math.round(t.percentage);
      const statusText = t.status === "Queued" ? "대기 중..." : t.status === "Starting" ? "준비 중..." : t.status;
      const isQueued = t.status === "Queued";
      
      const rawProvider = (t.provider || "").toUpperCase();
      const isGPU = rawProvider.includes("GPU") || rawProvider.includes("CUDA") || rawProvider.includes("DIRECTML");
      const isCPU = rawProvider.includes("CPU");
      const isSystem = rawProvider.includes("SYSTEM") || t.status.includes("모델");
      const isNetwork = rawProvider.includes("NETWORK") || t.status.toLowerCase().includes("down");

      let pText = "AI", pClass = "provider-ai";
      if (isGPU) { pText = "GPU"; pClass = "provider-gpu"; }
      else if (isCPU) { pText = "CPU"; pClass = "provider-cpu"; }
      else if (isNetwork) { pText = "NETWORK"; pClass = "provider-network"; }
      else if (isSystem) { pText = "AI"; pClass = "provider-ai"; }
      else if (t.status === "Queued") { pText = "QUEUED"; pClass = "provider-queued"; }

      return `
        <div class="task-card ${isQueued ? 'task-queued' : ''}" data-task-path="${path}">
          <div class="task-header-info">
            ${thumbnail ? `<img src="${thumbnail}" class="task-thumb" onerror="this.style.display='none'">` : `<div class="task-icon">MR</div>`}
            <div class="task-info-main">
              <span class="task-title" title="${path}">${displayName}</span>
              <div class="task-status-row-top">
                <span class="task-status-text">${statusText}</span>
                <span class="task-percentage">${isQueued ? '-' : pct + '%'}</span>
              </div>
            </div>
            <div class="task-provider-badge ${pClass}">${pText}</div>
            <button class="btn-task-cancel secondary-btn" onclick="window.cancelTask(this)" data-task-path="${path.replace(/"/g, '&quot;')}">취소</button>
          </div>
          <div class="task-progress-container">
            <div class="task-progress-bar" style="width: ${pct}%; ${isQueued ? 'background: #4b5563;' : ''}"></div>
          </div>
        </div>
      `;
    }).join("");
  }
}

/**
 * Updates the status badge of a specific song card in real-time
 * @param {string} path - The path of the song to update
 * @param {HTMLElement|null} card - Optional card element to update directly
 */
export async function updateCardStatusBadge(path, card = null) {
  const targetCard = card || document.querySelector(`.song-card[data-path="${path}"]`);
  if (!targetCard) return;

  const isList = state.viewMode === "list";
  const parent = isList ? targetCard.querySelector(".status-badge-container") : targetCard.querySelector(".thumbnail");
  if (!parent) return;

  // Clear existing badge
  const existingBadge = parent.querySelector(".status-badge");
  if (existingBadge) existingBadge.remove();

  // Find song in library for isMr info
  const song = state.songLibrary.find(s => s.path === path);
  const isSeparated = await checkMrSeparated(path);
  
  const badge = document.createElement("div");
  badge.className = "status-badge";

  const activeTask = state.activeTasks[path];
  if (activeTask && activeTask.status !== "Finished") {
    const status = (activeTask.status || "").toLowerCase();
    const isWaiting = status.includes("queued") ||
      status.includes("pending") ||
      status.includes("starting") ||
      status.includes("preparing");

    badge.classList.add(isWaiting ? "pending" : "processing");
    badge.textContent = isWaiting ? "대기중" : "분리중";
  } else if (isSeparated || (song && song.isMr)) {
    badge.classList.add("mr");
    badge.textContent = "MR";
  } else {
    return; // No badge to show
  }

  parent.appendChild(badge);
}

let sortableInstance = null;

/**
 * Initializes SortableJS on the song grid
 */
export function initSortable() {
  try {
    if (!elements.songGrid || !window.Sortable) return;

    if (sortableInstance) {
      sortableInstance.destroy();
      sortableInstance = null;
    }

    sortableInstance = new window.Sortable(elements.songGrid, {
      animation: 200,
      ghostClass: 'sortable-ghost',
      forceFallback: true,
      fallbackClass: 'sortable-fallback',
      fallbackTolerance: 5,
      scroll: true,
      bubbleScroll: true,
      swapThreshold: 0.65,
      invertSwap: true,
      disabled: true,
      onStart: () => {
        elements.songGrid.classList.add('is-dragging');
      },
      onEnd: async (evt) => {
        elements.songGrid.classList.remove('is-dragging');
        
        const { oldIndex, newIndex } = evt;
        if (oldIndex === newIndex) return;

        const cards = elements.songGrid.querySelectorAll(".song-card");
        cards.forEach((card, idx) => {
          const path = card.dataset.path;
          const song = state.songLibrary.find(s => s.path === path);
          if (song) {
            song.sortOrder = idx;
          }
        });

        state.songLibrary.sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0));

        try {
          await saveLibrary(state.songLibrary);
          showNotification("정렬 순서가 저장되었습니다.", "success");
        } catch (err) {
          console.error("Failed to save library order:", err);
          showNotification("순서 저장 중 오류가 발생했습니다.", "error");
        }
      }
    });
  } catch (err) {
    console.error("Sortable initialization failed:", err);
  }
}

export function updateSortableState() {
  if (!sortableInstance) return;

  const sortBy = elements.libSortSelect?.value || "dateNew";
  const query = (elements.libSearchInput?.value || "").toLowerCase().trim();
  const genreFilter = elements.libGenreFilter?.value || "all";
  const categoryFilter = elements.libCategoryFilter?.value || "all";
  
  const canDrag = sortBy === "custom" && !query && genreFilter === "all" && categoryFilter === "all";
  sortableInstance.option("disabled", !canDrag);
  elements.songGrid.classList.toggle("reorder-mode", canDrag);
}




