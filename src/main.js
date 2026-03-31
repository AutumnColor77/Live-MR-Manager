const { invoke, convertFileSrc } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

// --- DOM Elements ---
let ytUrlInput, ytFetchBtn, viewTitle, youtubeSection, songGrid;
let localSection, localDropBox;
let dockTitle, dockArtist, dockThumb;
let pitchSlider, tempoSlider, pitchVal, tempoVal;
let playbackBar, progressFill, timeCurrent, timeTotal;
let toggleVocal, toggleLyric;
let thumbOverlay, contextMenu, menuPlay, menuSeparate, menuEdit, menuDelete;
let libraryControls, libSearchInput, libCategoryFilter, libSortSelect;
let metadataModal, editTitle, editArtist, editCategorySelect, editCategoryCustom, editTags, modalSave;
let confirmModal, confirmTitle, confirmMessage, confirmOk, confirmCancel, confirmCloseIcon;

// --- Global State ---
let songLibrary = [];
let currentTrack = null;
let isPlaying = false;
let isLoading = false;
let isAiModelReady = false;
let isSeparating = false;
let editingSongIndex = -1;
let viewMode = localStorage.getItem("viewMode") || "grid";
let isMuted = false;
let prevVolume = 80;
let activeTasks = {}; // path -> { title, percentage, status }

// Interpolation State
let targetProgressMs = 0;
let currentProgressMs = 0;
let trackDurationMs = 1;
let rafId = null;
let lastRafTime = 0;
let isSeeking = false;

const DEFAULT_CATEGORIES = [
  { val: "pop", text: "POP" },
  { val: "ballad", text: "발라드" },
  { val: "dance", text: "댄스" },
  { val: "rock", text: "락/메탈" },
  { val: "jpop", text: "J-POP" },
  { val: "kpop", text: "K-POP" }
];

// --- Core Backend Functions ---
async function loadLibrary() {
  try {
    console.log("[UI] Loading library from backend...");
    const songs = await invoke("load_library");
    songLibrary = Array.isArray(songs) ? songs : [];
    console.log(`[UI] Loaded ${songLibrary.length} songs.`);
    updateCategoryDropdowns();
    renderLibrary();
  } catch (err) {
    console.error("Failed to load library:", err);
    showNotification("라이브러리를 불러오는데 실패했습니다.", "error");
  }
}

async function saveLibrary() {
  try {
    await invoke("save_library", { songs: songLibrary });
    console.log("[UI] Library saved to backend.");
  } catch (err) {
    console.error("Failed to save library:", err);
    showNotification("라이브러리 저장 실패", "error");
  }
}

function addToLibrary(song) {
  if (!song.dateAdded) song.dateAdded = Date.now();
  songLibrary.push(song);
  saveLibrary();
  updateCategoryDropdowns();
  renderLibrary();
}

async function checkAiModelStatus() {
  try {
    isAiModelReady = await invoke("check_model_ready");
    updateAiUI();
  } catch (err) {
    console.error("AI 모델 상태 체크 실패:", err);
  }
}

function updateAiUI() {
  const statusBadge = document.getElementById("ai-model-status") || document.querySelector(".status-indicator");
  const downloadBtn = document.getElementById("btn-download-model");
  
  if (isAiModelReady) {
    if (statusBadge) {
      statusBadge.textContent = "READY";
      statusBadge.className = "status-badge status-online";
    }
    if (downloadBtn) {
      downloadBtn.textContent = "모델 재설치";
      downloadBtn.disabled = false;
    }
  } else {
    if (statusBadge) {
      statusBadge.textContent = "REQUIRED";
      statusBadge.className = "status-badge status-offline";
    }
    if (downloadBtn) {
      downloadBtn.textContent = "모델 다운로드";
      downloadBtn.disabled = false;
    }
  }
}

// --- UI Rendering ---
function renderLibrary() {
  if (!songGrid) return;
  songGrid.innerHTML = "";
  
  if (!Array.isArray(songLibrary)) {
    console.error("songLibrary is not an array:", songLibrary);
    return;
  }

  const currentTab = document.querySelector(".nav-item.active")?.id.replace("nav-", "") || "library";
  console.log(`[UI] Rendering Library for tab: ${currentTab}. Total songs: ${songLibrary.length}`);
  
  let filtered = [...songLibrary.map((s, i) => ({ ...s, originalIndex: i }))];
  
  // Tab-based Source Filtering
  if (currentTab === "youtube") {
    filtered = filtered.filter(s => s.source === "youtube");
  } else if (currentTab === "local") {
    filtered = filtered.filter(s => s.source === "local");
  }

  // Search & Category Filtering
  const query = (libSearchInput?.value || "").toLowerCase().trim();
  const categoryFilter = libCategoryFilter?.value || "all";
  const sortBy = libSortSelect?.value || "dateNew";

  if (query) {
    filtered = filtered.filter(s => 
      s.title.toLowerCase().includes(query) || 
      (s.artist && s.artist.toLowerCase().includes(query)) ||
      (s.tags && s.tags.some(t => t.toLowerCase().includes(query)))
    );
  }

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

  if (filtered.length === 0) {
    songGrid.innerHTML = `<div class="empty-state" style="grid-column: 1/-1; text-align: center; padding: 40px; color: var(--text-dim);">검색 결과가 없거나 라이브러리가 비어있습니다.</div>`;
    return;
  }

  filtered.forEach(song => {
    addSongToGrid(song, song.originalIndex);
  });
  
  updateThumbnailOverlay();
}

function addSongToGrid(song, originalIndex) {
  const card = document.createElement("article");
  card.className = `song-card ${viewMode === "list" ? "list-row" : ""}`;
  
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
    <div class="song-info-content">
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
  `;
  
  // MR Separated Badge Check
  invoke("check_mr_separated", { path: song.path })
    .then(isSeparated => {
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

  card.dataset.path = song.path;

  card.addEventListener("click", () => {
    if (currentTrack && currentTrack.path === song.path) {
      handlePlaybackToggle();
    } else {
      selectTrack(originalIndex);
    }
  });

  card.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    showSongContextMenu(e, song, originalIndex);
  });

  songGrid.appendChild(card);
}

// --- Tab & Navigation ---
function switchTab(tabId) {
  if (viewTitle) viewTitle.textContent = getTabTitle(tabId);
  
  // Update Navigation UI
  document.querySelectorAll(".nav-item").forEach(i => {
    i.classList.toggle("active", i.id === `nav-${tabId}`);
  });

  // Tab Content Visibility Matching global variables
  if (youtubeSection) youtubeSection.style.display = tabId === "youtube" ? "block" : "none";
  if (localSection) localSection.style.display = tabId === "local" ? "block" : "none";
  
  // Show library controls and grid in library, youtube, and local tabs
  const isMusicTab = (tabId === "library" || tabId === "youtube" || tabId === "local");
  if (libraryControls) libraryControls.style.display = isMusicTab ? "flex" : "none";
  
  const settingsPage = document.getElementById("settings-page");
  const tasksPage = document.getElementById("tasks-page");
  if (settingsPage) settingsPage.style.display = tabId === "settings" ? "block" : "none";
  if (tasksPage) tasksPage.style.display = tabId === "tasks" ? "block" : "none";
  
  if (songGrid) {
    songGrid.style.display = isMusicTab ? (viewMode === "list" ? "flex" : "grid") : "none";
  }

  if (viewTitle) {
    if (tabId === "library") viewTitle.textContent = "Music Library";
    else if (tabId === "youtube") viewTitle.textContent = "YouTube 추가";
    else if (tabId === "local") viewTitle.textContent = "내 파일 추가";
    else if (tabId === "tasks") viewTitle.textContent = "처리 현황";
    else if (tabId === "settings") viewTitle.textContent = "시스템 설정";
  }

  // Clear filters when switching between major music tabs
  if (tabId === "library" || tabId === "youtube" || tabId === "local") {
    libSearchInput.value = "";
    libCategoryFilter.value = "all";
    const selectedCatText = document.querySelector("#lib-category-dropdown .selected-text");
    if (selectedCatText) selectedCatText.textContent = "전체 카테고리";
    renderLibrary();
  }
}

function getTabTitle(tabId) {
  const titles = {
    library: "Music Library",
    youtube: "Add from YouTube",
    local: "Add from My Files",
    settings: "System Settings",
    tasks: "Active Tasks"
  };
  return titles[tabId] || "Live MR Manager";
}

// --- Playback Controls ---
async function handlePlaybackToggle() {
  if (!currentTrack) {
    showNotification("재생할 곡이 선택되지 않았습니다.", "info");
    return;
  }
  try {
    const newIsPlaying = await invoke("toggle_playback");
    isPlaying = newIsPlaying;
    isLoading = false;
    updateThumbnailOverlay();
    
    if (isPlaying && !rafId) {
      lastRafTime = performance.now();
      rafId = requestAnimationFrame(updateProgressBar);
    }
    showNotification(isPlaying ? "재생을 재개합니다" : "재생이 일시정지되었습니다", "info");
  } catch (error) {
    console.error("Playback toggle failed:", error);
    showNotification("재생에 실패했습니다", "error");
  }
}

async function selectTrack(index) {
  const song = songLibrary[index];
  if (!song) return;

  console.log(`[UI] Selecting track: ${song.title}`);
  
  // Track play count
  song.playCount = (song.playCount || 0) + 1;
  saveLibrary();

  // Update Control Dock
  dockTitle.textContent = song.title;
  dockArtist.textContent = song.artist || "Unknown Artist";
  
  const thumbImg = document.querySelector(".dock-thumb img");
  if (thumbImg) thumbImg.src = getThumbnailUrl(song.thumbnail, song);
  
  currentTrack = song;
  isPlaying = false;
  isLoading = true;
  
  // Reset Progress State for UI
  targetProgressMs = 0;
  currentProgressMs = 0;
  
  if (song.duration && song.duration.includes(":")) {
    const parts = song.duration.split(":");
    const sec = (parseInt(parts[0]) * 60) + (parseInt(parts[1]) || 0);
    trackDurationMs = sec * 1000;
  } else {
    trackDurationMs = 1;
  }
  
  playbackBar.value = 0;
  progressFill.style.width = "0%";
  timeCurrent.textContent = "0:00";
  timeTotal.textContent = song.duration || "--:--";
  
  updateThumbnailOverlay();

  // Apply stored settings
  const p = song.pitch || 0;
  const t = song.tempo || 1.0;
  const v = song.volume || 80;
  
  pitchSlider.value = p;
  pitchVal.textContent = p > 0 ? `+${p}` : p;
  tempoSlider.value = t;
  tempoVal.textContent = `${parseFloat(t).toFixed(2)}x`;
  const volSliderInput = document.querySelector(".volume-slider");
  if (volSliderInput) volSliderInput.value = v;

  // Reset internal progress
  targetProgressMs = 0;
  currentProgressMs = 0;
  lastRafTime = performance.now();

  if (rafId) { cancelAnimationFrame(rafId); rafId = null; }

  try {
    // Initial volume/pitch/tempo Sync
    await invoke("set_pitch", { semitones: parseFloat(p) });
    await invoke("set_tempo", { ratio: parseFloat(t) });
    await invoke("set_volume", { volume: parseFloat(v) });

    await invoke("play_track", { path: song.path });
    isPlaying = true;
    isLoading = false;
    updateThumbnailOverlay();
    
    // Safety: ensure volume is set again after sink might have been re-created in backend
    setTimeout(() => invoke("set_volume", { volume: parseFloat(v) }), 100);

    if (!rafId) {
      lastRafTime = performance.now();
      rafId = requestAnimationFrame(updateProgressBar);
    }
  } catch (err) {
    console.error("Playback failed:", err);
    showNotification("재생에 실패했습니다.", "error");
    isLoading = false;
    isPlaying = false;
    updateThumbnailOverlay();
  }
}

function updateProgressBar(timestamp) {
  if (!isPlaying) { rafId = null; return; }

  const delta = timestamp - lastRafTime;
  lastRafTime = timestamp;

  const diff = targetProgressMs - currentProgressMs;
  if (Math.abs(diff) > 2000) {
    currentProgressMs = targetProgressMs;
  } else {
    const tempo = parseFloat(tempoSlider.value) || 1.0;
    currentProgressMs += delta * tempo;
    if (targetProgressMs > 0) {
      if (currentProgressMs > targetProgressMs + 500) currentProgressMs = targetProgressMs + 500;
      if (currentProgressMs < targetProgressMs - 500) currentProgressMs = targetProgressMs - 500;
    }
  }

  if (!isSeeking) {
    let progressVal = (currentProgressMs / trackDurationMs) * 100;
    if (isNaN(progressVal) || !isFinite(progressVal)) progressVal = 0;
    if (progressVal > 100) progressVal = 100;

    playbackBar.value = progressVal;
    progressFill.style.width = `${progressVal}%`;
    timeCurrent.textContent = formatTime(currentProgressMs / 1000);
    timeTotal.textContent = formatTime(trackDurationMs / 1000);
  }

  rafId = requestAnimationFrame(updateProgressBar);
}

// --- Context Menu & Modals ---
function showSongContextMenu(e, song, originalIndex) {
  editingSongIndex = originalIndex;
  contextMenu.style.top = `${e.clientY}px`;
  contextMenu.style.left = `${e.clientX}px`;
  contextMenu.classList.add("active");
  
  menuPlay.onclick = () => { selectTrack(originalIndex); contextMenu.classList.remove("active"); };
  menuEdit.onclick = () => { openEditModal(song, originalIndex); contextMenu.classList.remove("active"); };
  menuDelete.onclick = () => { deleteSong(originalIndex); contextMenu.classList.remove("active"); };
}

function openEditModal(song, index) {
  editingSongIndex = index;
  editTitle.value = song.title || "";
  editArtist.value = song.artist || "";
  editTags.value = (song.tags || []).join(", ");
  
  const currentCategory = song.category || "etc";
  const isDefault = DEFAULT_CATEGORIES.some(c => c.val === currentCategory);
  
  if (isDefault) {
    editCategorySelect.value = currentCategory;
    editCategoryCustom.style.display = "none";
  } else {
    editCategorySelect.value = "etc";
    editCategoryCustom.style.display = "block";
    editCategoryCustom.value = currentCategory;
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
        selectedText.textContent = opt.textContent;
      }
    });
  }
  metadataModal.classList.add("active");
}

function deleteSong(index) {
  const song = songLibrary[index];
  if (!song) return;

  confirmTitle.textContent = "곡 삭제";
  confirmMessage.textContent = `'${song.title}' 곡을 삭제하시겠습니까?`;
  confirmOk.onclick = () => {
    songLibrary.splice(index, 1);
    saveLibrary();
    renderLibrary();
    confirmModal.classList.remove("active");
    showNotification("곡이 삭제되었습니다.", "success");
  };
  confirmModal.classList.add("active");
}

// --- Initialization & Event Listeners ---
document.addEventListener("DOMContentLoaded", () => {
  // Assign DOM Elements Matching index.html
  ytUrlInput = document.getElementById("yt-url-input");
  ytFetchBtn = document.getElementById("yt-fetch-btn");
  viewTitle = document.getElementById("view-title");
  youtubeSection = document.getElementById("youtube-search");
  songGrid = document.getElementById("song-grid");
  localSection = document.getElementById("local-drop-section");
  localDropBox = document.getElementById("local-drop-box");

  dockTitle = document.getElementById("dock-title");
  dockArtist = document.getElementById("dock-artist");
  dockThumb = document.querySelector(".dock-thumb img");
  
  pitchSlider = document.getElementById("pitch-slider");
  tempoSlider = document.getElementById("tempo-slider");
  pitchVal = document.getElementById("pitch-val");
  tempoVal = document.getElementById("tempo-val");
  
  playbackBar = document.getElementById("playback-bar");
  progressFill = document.getElementById("progress-fill");
  timeCurrent = document.getElementById("time-current");
  timeTotal = document.getElementById("time-total");

  toggleVocal = document.getElementById("toggle-vocal");
  toggleLyric = document.getElementById("toggle-lyric");

  thumbOverlay = document.getElementById("thumb-overlay");
  contextMenu = document.getElementById("context-menu");
  menuPlay = document.getElementById("menu-play");
  menuSeparate = document.getElementById("menu-separate");
  menuEdit = document.getElementById("menu-edit");
  menuDelete = document.getElementById("menu-delete");

  libraryControls = document.getElementById("library-controls");
  libSearchInput = document.getElementById("lib-search-input");
  libCategoryFilter = document.getElementById("lib-category-filter");
  libSortSelect = document.getElementById("lib-sort-select");

  metadataModal = document.getElementById("metadata-modal"); // Updated to match index.html
  editTitle = document.getElementById("edit-title");
  editArtist = document.getElementById("edit-artist");
  editCategorySelect = document.getElementById("edit-category-select");
  editCategoryCustom = document.getElementById("edit-category-custom");
  editTags = document.getElementById("edit-tags");
  modalSave = document.getElementById("modal-save"); // Updated
  
  confirmModal = document.getElementById("confirm-modal");
  confirmTitle = document.getElementById("confirm-title");
  confirmMessage = document.getElementById("confirm-message");
  confirmOk = document.getElementById("confirm-ok");
  confirmCancel = document.getElementById("confirm-cancel");
  confirmCloseIcon = document.getElementById("confirm-close-icon"); // Updated

  initNavigation();
  initPlaybackControls();
  initEventListeners();
  initLocalDrop();
  initMetadataModal();
  initConfirmModalListeners();
  initCustomDropdowns();
  initAiModelControls();
  initViewToggle();
  initFolderControls();

  // Load Initial Data
  loadLibrary();
  checkAiModelStatus();
  listenForEvents();

  // Global click to close UI
  document.addEventListener("click", () => {
    if (contextMenu && contextMenu.classList.contains("active")) {
      contextMenu.classList.remove("active");
    }
    document.querySelectorAll(".active").forEach(el => {
      if (el.classList.contains("custom-select")) el.classList.remove("active");
    });
  });
});

function initNavigation() {
  document.querySelectorAll(".nav-item").forEach(item => {
    item.addEventListener("click", () => {
      const tabId = item.id.replace("nav-", "");
      switchTab(tabId);
    });
  });
}

function initEventListeners() {
  if (ytFetchBtn) ytFetchBtn.addEventListener("click", fetchYoutube);
  if (ytUrlInput) ytUrlInput.addEventListener("keypress", (e) => { if (e.key === "Enter") fetchYoutube(); });
  
  if (libSearchInput) libSearchInput.addEventListener("input", renderLibrary);
  if (libCategoryFilter) libCategoryFilter.addEventListener("change", renderLibrary);
  if (libSortSelect) libSortSelect.addEventListener("change", renderLibrary);

  const volSlider = document.querySelector(".volume-slider");
  const volIcon = document.querySelector(".icon-volume");
  if (volSlider) {
    volSlider.addEventListener("input", (e) => {
      const val = parseInt(e.target.value);
      invoke("set_volume", { volume: parseFloat(val) });
      if (val === 0) volIcon.classList.add("muted");
      else volIcon.classList.remove("muted");
    });
  }

  if (playbackBar) {
    playbackBar.addEventListener("input", (e) => { isSeeking = true; progressFill.style.width = `${e.target.value}%`; });
    playbackBar.addEventListener("change", async (e) => {
      const seekMs = (e.target.value / 100) * trackDurationMs;
      await invoke("seek_to", { positionMs: Math.floor(seekMs) });
      isSeeking = false;
    });
  }

  if (pitchSlider) {
    pitchSlider.addEventListener("input", (e) => {
      pitchVal.textContent = e.target.value > 0 ? `+${e.target.value}` : e.target.value;
      invoke("set_pitch", { semitones: parseFloat(e.target.value) });
    });
  }

  if (tempoSlider) {
    tempoSlider.addEventListener("input", (e) => {
      tempoVal.textContent = `${parseFloat(e.target.value).toFixed(2)}x`;
      invoke("set_tempo", { ratio: parseFloat(e.target.value) });
    });
  }
  
  if (dockThumb) dockThumb.addEventListener("click", handlePlaybackToggle);
}

function initMetadataModal() {
  const cancelBtn = document.getElementById("modal-cancel");
  const closeBtn = document.getElementById("modal-close");
  if (cancelBtn) cancelBtn.onclick = () => metadataModal.classList.remove("active");
  if (closeBtn) closeBtn.onclick = () => metadataModal.classList.remove("active");
  if (modalSave) {
    modalSave.onclick = async () => {
      if (editingSongIndex === -1) return;
      const song = songLibrary[editingSongIndex];
      song.title = editTitle.value.trim();
      song.artist = editArtist.value.trim();
      song.tags = editTags.value.split(",").map(t => t.trim()).filter(t => t !== "");
      const selCat = editCategorySelect.value;
      song.category = (selCat === "etc") ? editCategoryCustom.value.trim() : selCat;
      
      await saveLibrary();
      updateCategoryDropdowns();
      renderLibrary();
      metadataModal.classList.remove("active");
      showNotification("저장되었습니다.", "success");
    };
  }
}

function initConfirmModalListeners() {
  if (confirmCancel) confirmCancel.onclick = () => confirmModal.classList.remove("active");
  if (confirmCloseIcon) confirmCloseIcon.onclick = () => confirmModal.classList.remove("active");
}

function listenForEvents() {
  listen("playback-progress", (event) => {
    if (isSeeking) return;
    targetProgressMs = event.payload.positionMs;
    trackDurationMs = event.payload.durationMs || 1;
    if (currentTrack && trackDurationMs > 1000 && (!currentTrack.duration || currentTrack.duration === "0:00" || currentTrack.duration === "--:--")) {
       currentTrack.duration = formatTime(trackDurationMs/1000);
       saveLibrary();
       renderLibrary();
    }
  });

  listen("tauri://drag-drop", (event) => {
    const paths = event.payload.paths;
    if (paths) {
      paths.forEach(path => {
        const ext = path.split('.').pop().toLowerCase();
        if (["mp3", "wav", "flac", "m4a"].includes(ext)) {
          invoke("get_audio_metadata", { path }).then(m => {
            m.source = "local";
            addToLibrary(m);
            showNotification("곡이 추가되었습니다.", "success");
          }).catch(e => console.error("Drop meta fail", e));
        }
      });
    }
  });
}

// --- Helpers ---
function formatTime(sec) {
  if (isNaN(sec) || sec < 0) return "0:00";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function getThumbnailUrl(path, song) {
  if (!path) return "assets/images/Thumb_Music.png";
  if (path.startsWith("http")) return path;
  try { return convertFileSrc(path); } 
  catch (e) { return (song && song.source === "youtube") ? song.path : "assets/images/Thumb_Music.png"; }
}

function updateCategoryDropdowns() {
  const libCategories = [...new Set(songLibrary.map(s => s.category).filter(c => c))];
  const customCategories = libCategories.filter(c => !DEFAULT_CATEGORIES.some(dc => dc.val === c));
  
  const options = [
    { val: "all", text: "전체 카테고리" },
    ...DEFAULT_CATEGORIES,
    ...customCategories.map(c => ({ val: c, text: c })),
    { val: "etc", text: "기타" }
  ];

  renderDropdownOptions("lib-category-dropdown", options, (val) => {
    libCategoryFilter.value = val;
    renderLibrary();
  });

  renderDropdownOptions("edit-category-dropdown", [
    ...DEFAULT_CATEGORIES,
    ...customCategories.map(c => ({ val: c, text: c })),
    { val: "etc", text: "직접 입력" }
  ], (val) => {
    editCategorySelect.value = val;
    editCategoryCustom.style.display = (val === "etc") ? "block" : "none";
  });
}

function renderDropdownOptions(id, opts, cb) {
  const el = document.getElementById(id);
  if (!el) return;
  const container = el.querySelector(".select-options");
  const selectedText = el.querySelector(".selected-text");
  container.innerHTML = opts.map(o => `<div class="option-item" data-value="${o.val}">${o.text}</div>`).join("");
  container.querySelectorAll(".option-item").forEach(opt => {
    opt.onclick = (e) => {
      e.stopPropagation();
      selectedText.textContent = opt.textContent;
      el.classList.remove("active");
      cb(opt.dataset.value);
    };
  });
}

function initCustomDropdowns() {
  document.querySelectorAll(".custom-select").forEach(el => {
    const trigger = el.querySelector(".select-trigger");
    if (trigger) trigger.onclick = (e) => {
      e.stopPropagation();
      document.querySelectorAll(".custom-select").forEach(s => { if (s !== el) s.classList.remove("active"); });
      el.classList.toggle("active");
    };
  });
  initCustomSelect("lib-sort-dropdown", "lib-sort-select", () => renderLibrary());
}

function initCustomSelect(id, inputId, cb) {
  const el = document.getElementById(id);
  if (!el) return;
  const input = document.getElementById(inputId);
  const trigger = el.querySelector(".select-trigger");
  const selectedText = el.querySelector(".selected-text");
  
  el.querySelectorAll(".option-item").forEach(opt => {
    opt.onclick = (e) => {
      e.stopPropagation();
      input.value = opt.dataset.value;
      selectedText.textContent = opt.textContent;
      el.classList.remove("active");
      cb(opt.dataset.value);
    };
  });
}

function updateThumbnailOverlay() {
  const isCurrentActive = !!currentTrack;
  if (thumbOverlay) {
    thumbOverlay.classList.toggle("active", isCurrentActive);
    thumbOverlay.classList.toggle("loading", isLoading);
    thumbOverlay.classList.toggle("playing", isPlaying && !isLoading);
    thumbOverlay.classList.toggle("paused", !isPlaying && !isLoading);
  }
  document.querySelectorAll(".song-card").forEach(card => {
    const overlay = card.querySelector(".thumb-overlay");
    const active = isCurrentActive && card.dataset.path === currentTrack.path;
    if (overlay) {
      overlay.classList.toggle("active", active);
      overlay.classList.toggle("playing", active && isPlaying && !isLoading);
      overlay.classList.toggle("paused", active && !isPlaying && !isLoading);
      overlay.classList.toggle("loading", active && isLoading);
    }
  });
}

async function fetchYoutube() {
  const url = ytUrlInput.value.trim();
  if (!url) return;
  ytFetchBtn.disabled = true;
  ytFetchBtn.textContent = "가져오기...";
  try {
    const m = await invoke("get_youtube_metadata", { url });
    m.source = "youtube";
    addToLibrary(m);
    showNotification("곡이 추가됨", "success");
    ytUrlInput.value = "";
  } catch (e) { showNotification("실패했습니다.", "error"); }
  finally { ytFetchBtn.disabled = false; ytFetchBtn.textContent = "정보 가져오기"; }
}

function initLocalDrop() {
  if (!localDropBox) return;
  localDropBox.addEventListener("dragover", (e) => { e.preventDefault(); localDropBox.classList.add("drag-over"); });
  localDropBox.addEventListener("dragleave", () => localDropBox.classList.remove("drag-over"));
  localDropBox.addEventListener("click", () => showNotification("파일을 드래그해서 추가하세요.", "info"));
}

function initViewToggle() {
  const g = document.getElementById("view-grid"), l = document.getElementById("view-list");
  if (!g || !l) return;
  const set = (m) => {
    viewMode = m; localStorage.setItem("viewMode", m);
    if (songGrid) songGrid.classList.toggle("list-view", m === "list");
    g.classList.toggle("active", m === "grid");
    l.classList.toggle("active", m === "list");
    renderLibrary();
  };
  g.onclick = () => set("grid");
  l.onclick = () => set("list");
  set(viewMode);
}

function initAiModelControls() {
  const btn = document.getElementById("btn-download-model");
  if (btn) btn.onclick = async () => {
    btn.disabled = true; btn.textContent = "다운로드 중...";
    const overlay = document.getElementById("model-download-overlay");
    if (overlay) overlay.style.display = "flex";
    try { await invoke("download_ai_model"); await checkAiModelStatus(); showNotification("완료!", "success"); }
    catch (e) { showNotification("실패!", "error"); }
  };
}

function initFolderControls() {
  const btn = document.getElementById("btn-open-cache");
  if (btn) btn.onclick = () => invoke("open_cache_folder").catch(e => showNotification("폴더 열기 실패", "error"));
}

function initPlaybackControls() {}
