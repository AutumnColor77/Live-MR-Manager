/**
 * ui.js - DOM Rendering and UI Logic
 */

import { state, DEFAULT_CATEGORIES, SORT_OPTIONS } from './state.js';
import { getThumbnailUrl, showNotification } from './utils.js';
import { checkMrSeparated, saveLibrary } from './audio.js';

const { invoke } = window.__TAURI__.core;

// DOM Cache
export const elements = {
  songGrid: null,
  libSearchInput: null,
  libCategoryFilter: null,
  libSortSelect: null,
  viewTitle: null,
  youtubeSection: null,
  localSection: null,
  libraryControls: null,
  dockTitle: null,
  dockArtist: null,
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
  btnStartTrack: null,
  statusMsg: null,
};

export function initDomReferences() {
  elements.songGrid = document.getElementById("song-grid");
  elements.viewTitle = document.getElementById("view-title");
  elements.libSearchInput = document.getElementById("lib-search-input");
  elements.libCategoryFilter = document.getElementById("lib-category-filter");
  elements.libSortSelect = document.getElementById("lib-sort-select");
  elements.libraryControls = document.getElementById("library-controls");
  elements.youtubeSection = document.getElementById("youtube-search");
  elements.localSection = document.getElementById("local-drop-section");
  
  elements.dockTitle = document.getElementById("dock-title");
  elements.dockArtist = document.getElementById("dock-artist");
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
  
  elements.contextMenu = document.getElementById("context-menu");
  elements.metadataModal = document.getElementById("metadata-modal");
  elements.confirmModal = document.getElementById("confirm-modal");
  
  elements.volSlider = document.querySelector(".volume-slider");
  elements.vocalBalance = document.getElementById("vocal-balance");
  elements.viewGridBtn = document.getElementById("view-grid");
  elements.viewListBtn = document.getElementById("view-list");
  elements.ytFetchBtn = document.getElementById("yt-fetch-btn");
  elements.ytUrlInput = document.getElementById("yt-url-input");
  elements.btnPrev = document.getElementById("btn-prev");
  elements.btnNext = document.getElementById("btn-next");
  elements.aiModelStatus = document.getElementById("ai-model-status");
  elements.btnStartTrack = document.getElementById("btn-start-track");
  elements.statusMsg = document.getElementById("system-status-msg");
  elements.toggleVocal = document.getElementById("toggle-vocal");
  elements.toggleLyric = document.getElementById("toggle-lyric");
}

export function renderLibrary() {
  if (!elements.songGrid) return;
  
  // Ensure every song in the master library has an original index for tracking
  state.songLibrary.forEach((s, i) => { s.originalIndex = i; });

  elements.songGrid.innerHTML = "";

  const query = (elements.libSearchInput?.value || "").toLowerCase().trim();
  const categoryFilter = elements.libCategoryFilter?.value || "all";
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
      (s.tags && s.tags.some(t => t.toLowerCase().includes(query)))
    );
  }

  // Category Filter
  if (categoryFilter !== "all" && categoryFilter !== "") {
    filtered = filtered.filter(s => s.category === categoryFilter);
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
      <div class="song-info-content list-layout">
        <div class="col col-info">
          <div class="song-name">${song.title || '제목 정보 없음'}</div>
          <div class="song-artist-badge ${!song.artist ? 'no-info' : ''}">${song.artist || '가수 정보 없음'}</div>
        </div>
        <div class="col col-category">
          <span class="category-badge ${!song.category ? 'no-info' : ''}">${(song.category || '전체').toUpperCase()}</span>
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
      </div>
    ` : `
      <div class="song-info-content grid-layout">
        <div class="song-name">${song.title || '제목 정보 없음'}</div>
        <div class="song-artist-badge ${!song.artist ? 'no-info' : ''}">${song.artist || '가수 정보 없음'}</div>
        <div class="song-meta">
          <span class="category-badge ${!song.category ? 'no-info' : ''}">${(song.category || '전체').toUpperCase()}</span>
          <span class="duration-text">${song.duration || '--:--'}</span>
        </div>
        <div class="tag-container ${!song.tags || song.tags.length === 0 ? 'no-info' : ''}">
          ${song.tags && song.tags.length > 0 
            ? song.tags.map(t => `<span class="tag-badge">${t}</span>`).join('') 
            : '<span class="tag-no-info">태그 정보 없음</span>'}
        </div>
      </div>
    `}
  `;
  
  // Async MR Badge check
  checkMrSeparated(song.path).then(isSeparated => {
    if (isSeparated) {
      const thumb = card.querySelector(".thumbnail");
      if (thumb && !thumb.querySelector(".mr-badge")) {
        const badge = document.createElement("div");
        badge.className = "mr-badge";
        badge.textContent = "MR";
        thumb.appendChild(badge);
      }
    }
  });

  // Integrated click handler: Play immediately on card or thumbnail click
  const handlePlayClick = async (e) => {
    // e.stopPropagation(); // Allow propagation for unified selection tracking
    e.preventDefault();
    const { selectTrack } = await import('./player.js');
    selectTrack(index);
  };

  const thumb = card.querySelector(".thumbnail");
  if (thumb) thumb.addEventListener("click", handlePlayClick);
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

export function updateCategoryDropdowns() {
  const categories = [...new Set(state.songLibrary.map(s => s.category).filter(c => c))];
  const customCategories = categories.filter(c => !DEFAULT_CATEGORIES.some(dc => dc.val === c));
  
  const options = [
    { val: "all", text: "전체 카테고리" },
    ...DEFAULT_CATEGORIES,
    ...customCategories.map(c => ({ val: c, text: c })),
    { val: "etc", text: "기타" }
  ];

  renderDropdownOptions("lib-category-dropdown", options, (val) => {
    if (elements.libCategoryFilter) elements.libCategoryFilter.value = val;
    renderLibrary();
  });

  // Meta Modal Categories
  renderDropdownOptions("edit-category-dropdown", [
    ...DEFAULT_CATEGORIES,
    ...customCategories.map(c => ({ val: c, text: c })),
    { val: "etc", text: "직접 입력" }
  ], (val) => {
    const editCatSelect = document.getElementById("edit-category-select");
    const editCatCustom = document.getElementById("edit-category-custom");
    if (editCatSelect) editCatSelect.value = val;
    if (editCatCustom) editCatCustom.style.display = (val === "etc") ? "block" : "none";
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
  
  elements.contextMenu.style.top = `${e.clientY}px`;
  elements.contextMenu.style.left = `${e.clientX}px`;
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
          await invoke("delete_mr", { path: song.path });
          renderLibrary();
          showNotification("MR 파일이 삭제되었습니다.", "success");
        } catch (err) {
          console.error("MR Delete failed:", err);
        }
      };
    }
    
    if (menuSeparate) {
      menuSeparate.style.display = isSeparated ? "none" : "block";
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
  });

  // Internal bind to global select logic
  document.getElementById("menu-play").onclick = () => {
    window.dispatchEvent(new CustomEvent('song-select', { detail: { index: originalIndex } }));
    elements.contextMenu.classList.remove("active");
  };
  
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
  document.getElementById("edit-title").value = song.title || "";
  document.getElementById("edit-artist").value = song.artist || "";
  document.getElementById("edit-tags").value = (song.tags || []).join(", ");
  
  const currentCategory = song.category || "etc";
  const isDefault = DEFAULT_CATEGORIES.some(c => c.val === currentCategory);
  const editCatSelect = document.getElementById("edit-category-select");
  const editCatCustom = document.getElementById("edit-category-custom");
  
  if (isDefault) {
    if (editCatSelect) editCatSelect.value = currentCategory;
    if (editCatCustom) editCatCustom.style.display = "none";
  } else {
    if (editCatSelect) editCatSelect.value = "etc";
    if (editCatCustom) {
      editCatCustom.style.display = "block";
      editCatCustom.value = currentCategory;
    }
  }

  // Sync Dropdown UI
  const dropdown = document.getElementById("edit-category-dropdown");
  if (dropdown) {
    const selectedText = dropdown.querySelector(".selected-text");
    const options = dropdown.querySelectorAll(".option-item");
    options.forEach(opt => {
      opt.classList.remove("selected");
      if (opt.dataset.value === (isDefault ? currentCategory : "etc")) {
        opt.classList.add("selected");
        if (selectedText) selectedText.textContent = opt.textContent;
      }
    });
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
    confirmOk.onclick = () => {
      state.songLibrary.splice(index, 1);
      saveLibrary(state.songLibrary);
      renderLibrary();
      elements.confirmModal.classList.remove("active");
      showNotification("곡이 삭제되었습니다.", "success");
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
    elements.aiModelStatus.className = "status-badge status-online";
  } else {
    elements.aiModelStatus.textContent = "Offline (Need Download)";
    elements.aiModelStatus.className = "status-badge status-offline";
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
