const { invoke, convertFileSrc } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

// DOM Elements
let ytUrlInput, ytFetchBtn, viewTitle, youtubeSearchSection, songGrid;
let localDropSection, localDropBox;
let dockTitle, dockArtist, dockThumb;
let pitchSlider, tempoSlider, pitchVal, tempoVal;
let playbackBar, progressFill, timeCurrent, timeTotal;
let toggleVocal, toggleLyric;
let thumbOverlay, contextMenu, menuPlay, menuSeparate, menuEdit, menuDelete;
let libraryControls, libSearchInput, libCategoryFilter, libSortSelect;
let metadataModal, editTitle, editArtist, editCategorySelect, editCategoryCustom, editTags, editThumb, modalSave;
let confirmModal, confirmTitle, confirmMessage, confirmOk, confirmCancel, confirmCloseIcon;
let editingSongIndex = -1;
let isSeparating = false;
let streamStartTime, streamTimerInterval;

// Playback State
let isMuted = false;
let prevVolume = 80;
let isPlaying = false;
let isLoading = false;
let isAiModelReady = false;
let currentTrack = null;
let isSeeking = false;

// Interpolation State
let targetProgressMs = 0;
let currentProgressMs = 0;
let trackDurationMs = 1;
let rafId = null;
let lastRafTime = 0;

// Library State
let songLibrary = [];
let viewMode = localStorage.getItem("viewMode") || "grid";

async function loadLibrary() {
  try {
    const songs = await invoke("load_library");
    songLibrary = songs;
    renderLibrary();
  } catch (err) {
    console.error("Failed to load library:", err);
  }
}

async function saveLibrary() {
  try {
    await invoke("save_library", { songs: songLibrary });
  } catch (err) {
    console.error("Failed to save library:", err);
  }
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
  const statusIdx = document.getElementById("ai-model-status");
  const downloadBtn = document.getElementById("btn-download-model");
  const vocalToggle = document.getElementById("toggle-vocal");
  const menuSeparate = document.getElementById("menu-separate");

  if (isAiModelReady) {
    if (statusIdx) {
      statusIdx.textContent = "READY";
      statusIdx.className = "status-badge status-online";
    }
    if (downloadBtn) {
      downloadBtn.textContent = "모델 재설치";
      downloadBtn.disabled = false;
    }
    if (vocalToggle) vocalToggle.disabled = false;
    if (menuSeparate) menuSeparate.classList.remove("disabled");
  } else {
    if (statusIdx) {
      statusIdx.textContent = "REQUIRED";
      statusIdx.className = "status-badge status-offline";
    }
    if (downloadBtn) {
      downloadBtn.textContent = "모델 다운로드";
      downloadBtn.disabled = false;
    }
    if (vocalToggle) vocalToggle.disabled = true;
    if (menuSeparate) menuSeparate.classList.add("disabled");
  }
}

window.addEventListener("DOMContentLoaded", () => {
  // Primary Elements
  ytUrlInput = document.querySelector("#yt-url-input");
  ytFetchBtn = document.querySelector("#yt-fetch-btn");
  viewTitle = document.querySelector("#view-title");
  
  // Sections
  youtubeSearchSection = document.querySelector("#youtube-search");
  localDropSection = document.querySelector("#local-drop-section");
  localDropBox = document.querySelector("#local-drop-box");
  songGrid = document.querySelector("#song-grid");

  // Dock Elements
  dockTitle = document.querySelector("#dock-title");
  dockArtist = document.querySelector("#dock-artist");
  dockThumb = document.querySelector("#dock-thumb");

  // Audio Control Elements
  pitchSlider = document.querySelector("#pitch-slider");
  tempoSlider = document.querySelector("#tempo-slider");
  pitchVal = document.querySelector("#pitch-val");
  tempoVal = document.querySelector("#tempo-val");
  
  playbackBar = document.querySelector("#playback-bar");
  progressFill = document.querySelector("#progress-fill");
  timeCurrent = document.querySelector("#time-current");
  timeTotal = document.querySelector("#time-total");
  // Dock Elements Initialized (No Play Button)

  // AI Toggles
  toggleVocal = document.querySelector("#toggle-vocal");
  toggleLyric = document.querySelector("#toggle-lyric");

  // New Elements
  thumbOverlay = document.querySelector("#thumb-overlay");
  contextMenu = document.querySelector("#context-menu");
  menuPlay = document.querySelector("#menu-play");
  menuSeparate = document.querySelector("#menu-separate");
  menuEdit = document.querySelector("#menu-edit");
  menuDelete = document.querySelector("#menu-delete");

  // Library Controls
  libraryControls = document.querySelector("#library-controls");
  libSearchInput = document.querySelector("#lib-search-input");
  libCategoryFilter = document.querySelector("#lib-category-filter");
  libSortSelect = document.querySelector("#lib-sort-select");

  // Metadata Modal
  metadataModal = document.querySelector("#metadata-modal");
  editTitle = document.querySelector("#edit-title");
  editArtist = document.querySelector("#edit-artist");
  editCategorySelect = document.querySelector("#edit-category-select");
  editCategoryCustom = document.querySelector("#edit-category-custom");
  editTags = document.querySelector("#edit-tags");
  editThumb = document.querySelector("#edit-thumb");
  modalSave = document.querySelector("#modal-save");

  initEventListeners();
  initDragAndDrop();
  initNativeFileDrop();
  initPlaybackStatusListener();
  initSystemLogListener();
  initContextMenu();
  initCustomDropdowns();
  initModalListeners();
  initConfirmModalListeners();
  initViewToggle();
  initAiModelControls(); // AI 모델 관리 리스너 초기화
  switchTab("library");
  startStreamingTimer();
  
  // Load saved library on startup
  loadLibrary();
  checkAiModelStatus();

  // Check AI Runtime Environment
  invoke("check_ai_runtime")
    .then(providers => {
      console.log("%c[AI-RUNTIME] Available Accelerators:", "color: #00ffcc; font-weight: bold;", providers);
      if (providers.some(p => p.includes("GPU"))) {
        console.log("%c[AI-RUNTIME] GPU Acceleration is ENABLED.", "color: #00ff00;");
      } else {
        console.log("%c[AI-RUNTIME] Running on CPU only. Performance might be limited during separation.", "color: #ff9d00;");
      }
    })
    .catch(err => console.error("AI Runtime check failed:", err));
});

function initEventListeners() {
  // Tab Navigation
  document.querySelectorAll(".nav-item").forEach(item => {
    item.addEventListener("click", () => {
      const tabId = item.id.replace("nav-", "");
      switchTab(tabId);
      
      document.querySelectorAll(".nav-item").forEach(i => i.classList.remove("active"));
      item.classList.add("active");
    });
  });

  // YouTube Fetch
  ytFetchBtn.addEventListener("click", async () => {
    const url = ytUrlInput.value.trim();
    if (!url) return;

    ytFetchBtn.disabled = true;
    ytFetchBtn.textContent = "Processing...";

    try {
      const metadata = await invoke("get_youtube_metadata", { url });
      addToLibrary(metadata);
      showNotification("곡이 추가되었습니다", "success");
      ytUrlInput.value = "";
      await checkAiModelStatus();
    } catch (error) {
      console.error("Fetch failed:", error);
      showNotification("유튜브 정보를 가져오는데 실패했습니다", "error");
    } finally {
      ytFetchBtn.disabled = false;
      ytFetchBtn.textContent = "정보 가져오기";
    }
  });

  // Library Controls Events
  libSearchInput.addEventListener("input", renderLibrary);
  libCategoryFilter.addEventListener("change", renderLibrary);
  libSortSelect.addEventListener("change", renderLibrary);

// Playback Controls
  // Playback Controls (Thumbnail Toggle Remains)
  dockThumb.addEventListener("click", handlePlaybackToggle);

  // Real-time Audio Controls Visual Feedback
  pitchSlider.addEventListener("input", (e) => {
    const val = parseInt(e.target.value);
    pitchVal.textContent = val > 0 ? `+${val}` : val;
    updatePitch(val);
  });

  tempoSlider.addEventListener("input", (e) => {
    const val = parseFloat(e.target.value).toFixed(2);
    tempoVal.textContent = `${val}x`;
    updateTempo(val);
  });

  // Direct Input Support (Inline editing on click)
  const enableDirectInput = (element, slider, unit, min, max, isFloat, formatter) => {
    element.addEventListener("click", () => {
      if (element.classList.contains("editing")) return;
      
      const originalText = element.textContent;
      const originalValue = slider.value;
      
      element.classList.add("editing");
      element.contentEditable = true;
      element.focus();
      
      // Select all text
      const range = document.createRange();
      range.selectNodeContents(element);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);

      const finishEdit = (commit) => {
        element.contentEditable = false;
        element.classList.remove("editing");
        
        if (!commit) {
          element.textContent = originalText;
          return;
        }

        let rawVal = element.textContent.replace(unit, "").replace("+", "").trim();
        let val = isFloat ? parseFloat(rawVal) : parseInt(rawVal);

        if (!isNaN(val) && val >= min && val <= max) {
          slider.value = val;
          element.textContent = formatter ? formatter(val) : val;
          if (unit === "x") updateTempo(val);
          else updatePitch(val);
        } else {
          showNotification(`유효한 범위(${min} ~ ${max})를 입력해주세요.`, "error");
          element.textContent = originalText;
        }
      };

      const handleKey = (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          element.removeEventListener("keydown", handleKey);
          finishEdit(true);
        } else if (e.key === "Escape") {
          element.removeEventListener("keydown", handleKey);
          finishEdit(false);
        }
      };

      element.addEventListener("keydown", handleKey);

      element.addEventListener("blur", () => {
        finishEdit(true);
      }, { once: true });
    });
  };

  enableDirectInput(pitchVal, pitchSlider, "", -12, 12, false, (v) => v > 0 ? `+${v}` : v);
  enableDirectInput(tempoVal, tempoSlider, "x", 0.5, 1.5, true, (v) => `${parseFloat(v).toFixed(2)}x`);

  toggleVocal.addEventListener("change", (e) => {
    invoke("toggle_ai_feature", { feature: "vocal", enabled: e.target.checked });
  });
  
  toggleLyric.addEventListener("change", (e) => {
    invoke("toggle_ai_feature", { feature: "lyric", enabled: e.target.checked });
  });

  // Volume Control
  const volSlider = document.querySelector(".volume-slider");
  const volIcon = document.querySelector(".icon-volume");

  volSlider.addEventListener("input", (e) => {
    const val = parseInt(e.target.value);
    updateVolume(val);
    
    if (val > 0 && isMuted) {
      isMuted = false;
      volIcon.classList.remove("muted");
    } else if (val === 0 && !isMuted) {
      isMuted = true;
      volIcon.classList.add("muted");
    }
  });

  volIcon.addEventListener("click", () => {
    isMuted = !isMuted;
    
    if (isMuted) {
      prevVolume = parseInt(volSlider.value);
      volSlider.value = 0;
      volIcon.classList.add("muted");
      console.log("Audio Muted");
    } else {
      volSlider.value = prevVolume > 0 ? prevVolume : 80;
      volIcon.classList.remove("muted");
      console.log(`Audio Unmuted: ${volSlider.value}%`);
    }
  });


  // Playback Bar Seeking
  playbackBar.addEventListener("input", (e) => {
    isSeeking = true;
    const val = e.target.value;
    progressFill.style.width = `${val}%`;
  });

  playbackBar.addEventListener("change", async (e) => {
    const val = e.target.value;
    const duration = parseFloat(playbackBar.dataset.durationMs || 0);
    const seekMs = (val / 100) * duration;
    
    try {
      await invoke("seek_to", { positionMs: Math.floor(seekMs) });
    } catch (err) {
      console.error("Seek failed:", err);
    } finally {
      isSeeking = false;
    }
  });

  // Track settings sync to library
  const syncSettings = () => {
    if (currentTrack) {
      const storedSong = songLibrary.find(s => s.path === currentTrack.path);
      if (storedSong) {
        storedSong.pitch = parseInt(pitchSlider.value);
        storedSong.tempo = parseFloat(tempoSlider.value);
        storedSong.volume = parseInt(document.querySelector(".volume-slider").value);
        saveLibrary();
      }
    }
  };

  pitchSlider.addEventListener("change", syncSettings);
  tempoSlider.addEventListener("change", syncSettings);
  document.querySelector(".volume-slider").addEventListener("change", syncSettings);

  // Global click to close custom selects
  document.addEventListener("click", (e) => {
    if (!e.target.closest(".custom-select")) {
      document.querySelectorAll(".custom-select").forEach(s => s.classList.remove("active"));
    }
  });
}

// Playback Control Functions
async function handlePlaybackToggle() {
  if (!currentTrack) {
    showNotification("재생할 곡이 선택되지 않았습니다.", "info");
    return;
  }
  try {
    const newIsPlaying = await invoke("toggle_playback");
    isPlaying = newIsPlaying;
    isLoading = false; // Toggle is usually instant
    updateThumbnailOverlay();
    await checkAiModelStatus();
    
    if (isPlaying && !rafId) {
      lastRafTime = performance.now();
      rafId = requestAnimationFrame(updateProgressBar);
    } else if (!isPlaying && rafId) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }

    showNotification(isPlaying ? "재생을 재개합니다" : "재생이 일시정지되었습니다", "info");
  } catch (error) {
    console.error("Playback toggle failed:", error);
    showNotification("재생에 실패했습니다", "error");
  }
}

function updateThumbnailOverlay() {
  const isCurrentActive = !!currentTrack;

  // Update Dock Overlay
  thumbOverlay.classList.remove("loading", "playing", "paused", "active");
  if (isCurrentActive) {
    if (isLoading) {
      thumbOverlay.classList.add("active", "loading");
    } else if (!isPlaying) {
      thumbOverlay.classList.add("active", "paused");
    }
    // No "playing" state for dock as requested (hide during play)
  }

  // Update Grid Card Indicators
  document.querySelectorAll(".song-card").forEach(card => {
    const overlay = card.querySelector(".thumb-overlay");
    if (overlay) {
      overlay.classList.remove("loading", "playing", "paused", "active");
      if (isCurrentActive && card.dataset.path === currentTrack.path) {
        overlay.classList.add("active");
        if (isLoading) {
          overlay.classList.add("loading");
        } else if (isPlaying) {
          overlay.classList.add("playing");
        } else {
          overlay.classList.add("paused");
        }
      }
    }
  });
}

function initContextMenu() {
  let targetSong = null;
  let targetCard = null;

  // Global click to hide
  document.addEventListener("click", () => {
    contextMenu.style.display = "none";
  });

  menuPlay.addEventListener("click", () => {
    if (targetSong) selectTrack(targetSong);
  });

  menuDelete.addEventListener("click", () => {
    if (targetCard) {
      targetCard.remove();
      showNotification("곡이 삭제되었습니다", "success");
    }
  });

  window.showSongContextMenu = (e, song, card) => {
    e.preventDefault();
    targetSong = song;
    targetCard = card;

    contextMenu.style.display = "flex";
    contextMenu.style.left = `${e.clientX}px`;
    contextMenu.style.top = `${e.clientY}px`;
  };
}

// updatePlayPauseButton removed as the button was removed from UI


// Global invocation helpers for real-time controls
function updatePitch(val) {
  invoke("set_pitch", { semitones: parseFloat(val) }).catch(console.error);
}

function updateTempo(val) {
  invoke("set_tempo", { ratio: parseFloat(val) }).catch(console.error);
}

function updateVolume(val) {
  invoke("set_volume", { volume: parseFloat(val) }).catch(console.error);
}

function initDragAndDrop() {
  if (!localDropBox) return;

  localDropBox.addEventListener("dragenter", (e) => {
    e.preventDefault();
    localDropBox.classList.add("drag-over");
  });

  localDropBox.addEventListener("dragover", (e) => {
    e.preventDefault();
    localDropBox.classList.add("drag-over");
  });

  localDropBox.addEventListener("dragleave", (e) => {
    e.preventDefault();
    localDropBox.classList.remove("drag-over");
  });

  localDropBox.addEventListener("drop", async (e) => {
    e.preventDefault();
    localDropBox.classList.remove("drag-over");

    const files = Array.from(e.dataTransfer.files);
    if (files.length > 0) {
      processDroppedFiles(files);
    }
  });

  // 클릭 시 파일 선택창 열기 (플러스 알파)
  localDropBox.addEventListener("click", () => {
    // Tauri 파일 다이얼로그 연동 가능
    console.log("Drop box clicked - Open file picker");
  });
}

async function initNativeFileDrop() {
  await listen("tauri://drag-drop", (event) => {
    // In Tauri 2, the payload contains a 'paths' array
    const paths = event.payload.paths;
    if (paths && Array.isArray(paths)) {
      paths.forEach(path => {
        // Ext name check (simple)
        const ext = path.split('.').pop().toLowerCase();
        if (["mp3", "wav", "flac", "m4a"].includes(ext)) {
          const fileName = path.split(/[\\/]/).pop();
          
          // 백엔드에서 안정적으로 메타데이터를 가져오거나 기본값을 반환함
          invoke("get_audio_metadata", { path: path })
            .then(metadata => {
              addToLibrary(metadata);
              showNotification("곡이 추가되었습니다", "success");
            })
            .catch(err => {
              console.warn("Unexpected backend error for audio metadata:", err);
              addToLibrary({
                title: fileName,
                path: path,
                thumbnail: "",
                duration: "0:00",
                source: "local"
              });
              showNotification("곡이 추가되었습니다", "success");
            });
        }
      });
    }
  });
}

async function initSystemLogListener() {
  await listen("sys-log", (event) => {
    const message = event.payload;
    console.log(`%c[SYSTEM-LOG] %c${message}`, "color: #ff9d00; font-weight: bold;", "color: white;");
    
    // 치명적 에러인 경우 사용자에게 알림
    if (message.includes("CRITICAL ERROR") || message.includes("Failed to open audio output")) {
      showNotification(message, "error");
    }
  });
}

async function initPlaybackStatusListener() {
  await listen("playback-status", (event) => {
    const { status, message } = event.payload;
    console.log(`[Playback Status] ${status}: ${message}`);
    
    let type = "info";
    let icon = "ℹ️";
    
    if (status === "Error") {
      type = "error";
      icon = "❌";
    } else if (status === "Playing") {
      type = "success";
      icon = "🎵";
    } else if (status === "Downloading") {
      type = "info";
      icon = "📥";
    }

    if (message.toLowerCase() === "playback started") {
      showNotification("재생을 시작합니다", "success");
    } else if (status === "Error") {
      showNotification("재생에 실패했습니다", "error");
    }
    
    // Update Dock UI according to status
    if (status === "Playing") {
      isPlaying = true;
      isLoading = false;
      updateThumbnailOverlay();
      if (currentTrack) {
        dockTitle.textContent = currentTrack.title;
      }
      if (!rafId) {
        lastRafTime = performance.now();
        rafId = requestAnimationFrame(updateProgressBar);
      }
    } else if (status === "Downloading" || status === "Decoding") {
      isLoading = true;
      updateThumbnailOverlay();
    } else if (status === "Error" || status === "Stopped" || status === "Finished" || status === "Playing") {
      isPlaying = false;
      isLoading = false;
      updateThumbnailOverlay();
      
      // Hide model download overlay if it was showing
      const modelOverlay = document.getElementById("model-download-overlay");
      if (modelOverlay) modelOverlay.style.display = "none";

      if (rafId) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
    }
  });

  let lastSavedDuration = "";
  await listen("playback-progress", (event) => {
    let { positionMs, durationMs } = event.payload;
    if (!durationMs || isNaN(durationMs) || durationMs <= 0) durationMs = 1;
    if (isNaN(positionMs) || positionMs < 0) positionMs = 0;

    targetProgressMs = positionMs;
    trackDurationMs = durationMs;
    playbackBar.dataset.durationMs = durationMs;

    // 실시간 메타데이터 보정: 곡의 실제 시간 정보가 수집되면 1회에 한해 저장
    if (currentTrack && durationMs > 1000) {
      const formatted = formatTime(durationMs / 1000);
      const needsUpdate = !currentTrack.duration || 
                          currentTrack.duration === "-" || 
                          currentTrack.duration === "--:--" || 
                          currentTrack.duration === "0:00";
      
      if (needsUpdate && formatted !== "0:00" && formatted !== lastSavedDuration) {
        currentTrack.duration = formatted;
        timeTotal.textContent = formatted;
        lastSavedDuration = formatted;
        
        console.log(`[UI] Updating duration for '${currentTrack.title}': ${formatted}`);
        saveLibrary();
        renderLibrary();
      }
    }
  });

  await listen("model-download-progress", (event) => {
    const percentage = event.payload;
    const overlay = document.getElementById("model-download-overlay");
    const bar = document.getElementById("model-download-bar");
    const text = document.getElementById("model-download-percent");
    
    if (overlay && bar && text) {
      overlay.style.display = "flex";
      bar.style.width = `${percentage}%`;
      text.textContent = `${Math.round(percentage)}%`;
    }
  });
}

function updateProgressBar(timestamp) {
  if (!isPlaying) {
    rafId = null;
    return;
  }

  const delta = timestamp - lastRafTime;
  lastRafTime = timestamp;

  // Jump if seeked or huge lag gap
  const diff = targetProgressMs - currentProgressMs;
  if (Math.abs(diff) > 2000) {
    currentProgressMs = targetProgressMs;
  } else {
    // Interpolate according to tempo slider
    const tempo = parseFloat(tempoSlider.value) || 1.0;
    currentProgressMs += delta * tempo;

    // Hard clamp if drifting too far from absolute server truth
    // Only clamp if we have received at least one server update (targetProgressMs > 0)
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

function formatTime(seconds) {
  if (isNaN(seconds) || seconds < 0 || !isFinite(seconds)) return "0:00";
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

async function processDroppedFiles(files) {
  for (const file of files) {
    if (file.type.startsWith("audio/") || 
        file.name.endsWith(".mp3") || 
        file.name.endsWith(".wav") || 
        file.name.endsWith(".flac") ||
        file.name.endsWith(".m4a")) {
      
      try {
        const metadata = await invoke("get_audio_metadata", { path: file.path });
        addToLibrary(metadata);
        showNotification(`${file.name} 곡이 추가되었습니다`, "success");
      } catch (error) {
        console.error("Failed to get audio metadata:", error);
        // Fallback for metadata failure
        addToLibrary({
          title: file.name,
          thumbnail: "",
          duration: "--:--",
          source: "local",
          path: file.path
        });
      }
    }
  }
}

function startStreamingTimer() {
  streamStartTime = Date.now();
  streamTimerInterval = setInterval(() => {
    const elapsed = Date.now() - streamStartTime;
    const hours = Math.floor(elapsed / 3600000);
    const mins = Math.floor((elapsed % 3600000) / 60000);
    const secs = Math.floor((elapsed % 60000) / 1000);
    
    document.querySelector("#stream-time").textContent = 
      `${hours.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }, 1000);
}

function switchTab(tabId) {
  viewTitle.textContent = getTabTitle(tabId);
  
  // Tab Content Visibility
  const settingsPage = document.getElementById("settings-page");
  
  youtubeSearchSection.style.display = tabId === "youtube" ? "block" : "none";
  localDropSection.style.display = tabId === "local" ? "block" : "none";
  libraryControls.style.display = tabId === "library" ? "flex" : "none";
  if (settingsPage) settingsPage.style.display = tabId === "settings" ? "block" : "none";
  
  // Show song grid ONLY for library and add-song tabs
  songGrid.style.display = (tabId === "library" || tabId === "youtube" || tabId === "local") ? (viewMode === "list" ? "flex" : "grid") : "none";
  
  console.log(`[UI] Switched to tab: ${tabId}`);
}

function getTabTitle(tabId) {
  const titles = {
    library: "Music Library",
    youtube: "Add from YouTube",
    local: "Add from My Files",
    settings: "System Settings",
    tasks: "Active Processing Tasks"
  };
  return titles[tabId] || "Live MR Manager";
}

function getThumbnailUrl(path, song) {
  if (!path) return "assets/images/Thumb_Music.png";
  if (path.startsWith("http") || path.startsWith("assets/")) return path;
  
  try {
    const converted = convertFileSrc(path);
    // 윈도우 경로인 경우 명시적으로 검증 (에러 시 폴백)
    return converted;
  } catch (err) {
    console.warn(`[UI] Thumbnail conversion failed for ${path}:`, err);
    // 로컬 경로 변환 실패 시, 만약 유튜브 곡이라면 원본 URL 소스가 있는지 확인 (없으면 기본 이미지)
    return (song && song.source === "youtube") ? song.path : "assets/images/Thumb_Music.png";
  }
}

function addSongToGrid(song, originalIndex) {
  const card = document.createElement("article");
  card.className = `song-card ${viewMode === "list" ? "list-row" : ""}`;
  
  const thumbUrl = getThumbnailUrl(song.thumbnail, song);
  
  // Grid vs List consistent structure
  card.innerHTML = `
    <div class="thumbnail">
      <img src="${thumbUrl}" 
           alt="${song.title}" 
           style="width:100%; height:100%; object-fit:cover;">
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
  
  // Async check for MR separation status
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
    editingSongIndex = originalIndex;
    contextMenu.style.display = "flex";
    contextMenu.style.top = `${e.clientY}px`;
    contextMenu.style.left = `${e.clientX}px`;
    
    // Bind context menu actions
    menuPlay.onclick = () => {
      selectTrack(originalIndex);
      contextMenu.style.display = "none";
    };
    menuSeparate.onclick = async () => {
      contextMenu.style.display = "none";
      if (isSeparating) {
        showNotification("이미 다른 작업을 처리 중입니다.", "warning");
        return;
      }
      
      try {
        isSeparating = true;
        showNotification("AI MR 분리를 시작합니다. 몇 분 정도 소요될 수 있습니다.", "info");
        
        // Add loading overlay to the card
        const cardThumb = card.querySelector(".thumbnail");
        const overlay = document.createElement("div");
        overlay.className = "separating-overlay";
        overlay.innerHTML = `<div class="spinner"></div><span>분리 중...</span>`;
        cardThumb.appendChild(overlay);

        await invoke("start_mr_separation", { path: song.path });
        
        overlay.remove();
        isSeparating = false;
        showNotification("MR 분리가 완료되었습니다!", "success");
        renderLibrary(); // Re-render to show badge
      } catch (err) {
        isSeparating = false;
        showNotification(`분리 실패: ${err}`, "error");
        const overlay = card.querySelector(".separating-overlay");
        if (overlay) overlay.remove();
        console.error("Separation failed:", err);
      }
    };
    menuEdit.onclick = () => {
      showEditModal(song);
      contextMenu.style.display = "none";
    };
    menuDelete.onclick = () => {
      showConfirm("곡 삭제", `'${song.title}' 곡을 라이브러리에서 정말 삭제하시겠습니까?`, () => {
        songLibrary.splice(originalIndex, 1);
        saveLibrary();
        renderLibrary();
        showNotification("곡이 삭제되었습니다.", "info");
      });
      contextMenu.style.display = "none";
    };
  });

  songGrid.appendChild(card);
}

function showEditModal(song) {
  editTitle.value = song.title;
  editArtist.value = song.artist || "";
  editThumb.value = song.thumbnail || "";
  editTags.value = song.tags ? song.tags.join(", ") : "";
  
  // Update custom dropdown
  const categories = ["pop", "ballad", "dance", "rock", "etc"];
  const currentCat = song.category || "";
  const isPredefined = categories.includes(currentCat);
  
  const hiddenInput = document.getElementById("edit-category-select");
  const dropdown = document.getElementById("edit-category-dropdown");
  const selectedText = dropdown.querySelector(".selected-text");
  const options = dropdown.querySelectorAll(".option-item");

  hiddenInput.value = isPredefined ? currentCat : "";
  selectedText.textContent = isPredefined ? 
    [...options].find(o => o.dataset.value === currentCat)?.textContent || "카테고리 선택..." : 
    "카테고리 선택...";
    
  options.forEach(o => {
    o.classList.toggle("selected", o.dataset.value === hiddenInput.value);
  });

  editCategoryCustom.value = isPredefined ? "" : currentCat;
  metadataModal.classList.add("active");
}

function initModalListeners() {
  const closeBtn = document.querySelector("#modal-close");
  const cancelBtn = document.querySelector("#modal-cancel");

  closeBtn.onclick = () => metadataModal.classList.remove("active");
  cancelBtn.onclick = () => metadataModal.classList.remove("active");
  
  modalSave.onclick = () => {
    if (editingSongIndex === -1) return;
    
    const song = songLibrary[editingSongIndex];
    song.title = editTitle.value.trim();
    song.artist = editArtist.value.trim();
    song.thumbnail = editThumb.value.trim();
    song.tags = editTags.value.split(",").map(t => t.trim()).filter(t => t !== "");
    
    // Category: Custom entry takes priority
    song.category = editCategoryCustom.value.trim() || editCategorySelect.value;
    
    saveLibrary();
    renderLibrary();
    metadataModal.classList.remove("active");
    showNotification("곡 정보가 저장되었습니다.", "success");
  };

  metadataModal.onclick = (e) => {
    if (e.target === metadataModal) metadataModal.classList.remove("active");
  };
}

function initConfirmModalListeners() {
  confirmModal = document.getElementById("confirm-modal");
  confirmTitle = document.getElementById("confirm-title");
  confirmMessage = document.getElementById("confirm-message");
  confirmOk = document.getElementById("confirm-ok");
  confirmCancel = document.getElementById("confirm-cancel");
  confirmCloseIcon = document.getElementById("confirm-close-icon");

  const close = () => confirmModal.classList.remove("active");
  confirmCancel.onclick = close;
  confirmCloseIcon.onclick = close;
  confirmModal.onclick = (e) => {
    if (e.target === confirmModal) close();
  };
}

function showConfirm(title, message, onConfirm) {
  confirmTitle.textContent = title;
  confirmMessage.textContent = message;
  confirmModal.classList.add("active");
  
  confirmOk.onclick = () => {
    onConfirm();
    confirmModal.classList.remove("active");
  };
}

function selectTrack(index) {
  const song = songLibrary[index];
  if (!song) return;

  // Track play count
  song.playCount = (song.playCount || 0) + 1;
  saveLibrary();

  // Update Control Dock
  dockTitle.textContent = song.title;
  dockArtist.textContent = song.artist || (song.source === "youtube" ? "YouTube Stream" : "Local File");
  
  const thumbUrl = getThumbnailUrl(song.thumbnail, song);
  dockThumb.style.backgroundImage = `url("${thumbUrl}")`;
  dockThumb.style.backgroundSize = "cover";
  
  currentTrack = song;
  isPlaying = false; // Immediately stopped on backend too
  isLoading = true;
  
  // Reset Progress State for UI
  targetProgressMs = 0;
  currentProgressMs = 0;
  
  // Parse duration string (e.g., "3:45") to ms for initial duration
  if (song.duration && song.duration.includes(":")) {
    const parts = song.duration.split(":");
    const sec = (parseInt(parts[0]) * 60) + parseInt(parts[1]);
    trackDurationMs = sec * 1000;
  } else {
    trackDurationMs = 0; // Better than 1 to avoid instant full bar
  }
  
  playbackBar.value = 0;
  progressFill.style.width = "0%";
  timeCurrent.textContent = "0:00";
  timeTotal.textContent = song.duration || "--:--";
  
  updateThumbnailOverlay();

  // Load per-song settings
  if (song.pitch !== undefined) {
    pitchSlider.value = song.pitch;
    pitchVal.textContent = song.pitch > 0 ? `+${song.pitch}` : song.pitch;
    updatePitch(song.pitch);
  }
  if (song.tempo !== undefined) {
    tempoSlider.value = song.tempo;
    tempoVal.textContent = `${parseFloat(song.tempo).toFixed(2)}x`;
    updateTempo(song.tempo);
  }
  if (song.volume !== undefined) {
    document.querySelector(".volume-slider").value = song.volume;
    updateVolume(song.volume);
  }

  if (rafId) {
    cancelAnimationFrame(rafId);
    rafId = null;
  }

  if (song.path) {
    invoke("play_track", { path: song.path })
      .then(() => {
        isPlaying = true;
        isLoading = false;
        updateThumbnailOverlay();
        showNotification("재생을 시작합니다", "success");
        
        if (!rafId) {
          lastRafTime = performance.now();
          rafId = requestAnimationFrame(updateProgressBar);
        }
      })
      .catch(err => {
        console.error("Playback failed:", err);
        showNotification("재생에 실패했습니다", "error");
        currentTrack = null;
        isPlaying = false;
        isLoading = false;
        updateThumbnailOverlay();
      });
  }
}

function showNotification(message, type = "info") {
  const container = document.getElementById("notification-container");
  if (!container) return;

  const toast = document.createElement("div");
  toast.className = `toast ${type}`;
  
  const icons = {
    info: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>`,
    success: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>`,
    error: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>`,
    warning: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`
  };

  toast.innerHTML = `
    <div class="toast-icon">${icons[type] || icons.info}</div>
    <div class="toast-message">${message}</div>
  `;

  container.appendChild(toast);

  setTimeout(() => {
    toast.classList.add("removing");
    setTimeout(() => toast.remove(), 400);
  }, 4000);
}

function initViewToggle() {
  const gridBtn = document.querySelector("#view-grid");
  const listBtn = document.querySelector("#view-list");
  if (!gridBtn || !listBtn) return;

  const setView = (mode) => {
    viewMode = mode;
    localStorage.setItem("viewMode", mode);
    
    if (mode === "list") {
      songGrid.classList.add("list-view");
      listBtn.classList.add("active");
      gridBtn.classList.remove("active");
    } else {
      songGrid.classList.remove("list-view");
      gridBtn.classList.add("active");
      listBtn.classList.remove("active");
    }
    
    renderLibrary();
  };

  gridBtn.addEventListener("click", () => setView("grid"));
  listBtn.addEventListener("click", () => setView("list"));
  setView(viewMode);
}

function initAiModelControls() {
  const downloadBtn = document.getElementById("btn-download-model");
  const modalOverlay = document.getElementById("model-download-overlay");

  if (downloadBtn) {
    downloadBtn.addEventListener("click", async () => {
      try {
        downloadBtn.disabled = true;
        downloadBtn.textContent = "다운로드 중...";
        
        if (modalOverlay) modalOverlay.style.display = "flex";

        await invoke("download_ai_model");
        
        await checkAiModelStatus();
        showNotification("AI 모델 다운로드 완료!", "success");
      } catch (err) {
        showNotification(`다운로드 실패: ${err}`, "error");
        downloadBtn.disabled = false;
        updateAiUI();
      }
    });
  }
}

function addToLibrary(song) {
  if (!song) {
    console.error("Attempted to add null/undefined song to library");
    return;
  }

  // 중복 체크: 이미 존재하는 경로면 업데이트 처리
  const existingIndex = songLibrary.findIndex(s => s.path === song.path);
  if (existingIndex !== -1) {
    // 기존 데이터 보존하면서 새로운 메타데이터(시간 등) 덮어쓰기
    songLibrary[existingIndex] = { ...songLibrary[existingIndex], ...song };
    console.log(`[UI] Updated existing song: ${song.title}`);
    saveLibrary();
    renderLibrary();
    return;
  }
  
  // Initialize default settings if not present
  if (song.pitch === undefined) song.pitch = 0;
  if (song.tempo === undefined) song.tempo = 1.0;
  if (song.volume === undefined) song.volume = 80;
  if (!song.dateAdded) song.dateAdded = Date.now();

  songLibrary.push(song);
  
  // Important: Clear any search/filter before rendering the newly added song
  // to ensure it's visible in the library
  libSearchInput.value = "";
  libCategoryFilter.value = "all";
  const selectedCatText = document.querySelector("#lib-category-dropdown .selected-text");
  if (selectedCatText) selectedCatText.textContent = "전체 카테고리";
  
  renderLibrary();
  saveLibrary();
  
  // Automatically switch to library tab to show the result
  switchTab("library");
  
  // Highlight the active nav item
  document.querySelectorAll(".nav-item").forEach(i => i.classList.remove("active"));
  document.querySelector("#nav-library").classList.add("active");
}

function renderLibrary() {
  if (!songGrid) return;
  songGrid.innerHTML = "";
  
  if (!Array.isArray(songLibrary)) {
    console.error("songLibrary is not an array:", songLibrary);
    return;
  }

  console.log(`[UI] Rendering Library: ${songLibrary.length} total songs.`);
  let filtered = [...songLibrary.map((s, i) => ({ ...s, originalIndex: i }))];
  const query = libSearchInput.value.toLowerCase().trim();
  const categoryFilter = libCategoryFilter.value;
  const sortBy = libSortSelect.value;

  if (query) {
    filtered = filtered.filter(s => 
      s.title.toLowerCase().includes(query) || 
      (s.artist && s.artist.toLowerCase().includes(query)) ||
      (s.tags && s.tags.some(t => t.toLowerCase().includes(query)))
    );
  }

  if (categoryFilter !== "all") {
    filtered = filtered.filter(s => s.category === categoryFilter);
  }

  // Sorting
  filtered.sort((a, b) => {
    switch (sortBy) {
      case "title": return a.title.localeCompare(b.title);
      case "dateNew": return (b.dateAdded || 0) - (a.dateAdded || 0);
      case "dateOld": return (a.dateAdded || 0) - (b.dateAdded || 0);
      case "plays": return (b.playCount || 0) - (a.playCount || 0);
      default: return 0;
    }
  });

  filtered.forEach(song => {
    addSongToGrid(song, song.originalIndex);
  });
}

// Custom Dropdown Logic
function initCustomDropdowns() {
  // Library Category Filter
  initCustomSelect("lib-category-dropdown", "lib-category-filter", () => renderLibrary());
  
  // Library Sort Select
  initCustomSelect("lib-sort-dropdown", "lib-sort-select", () => renderLibrary());
  
  // Modal Category Select
  initCustomSelect("edit-category-dropdown", "edit-category-select");
}

function initCustomSelect(dropdownId, hiddenInputId, callback) {
  const dropdown = document.getElementById(dropdownId);
  if (!dropdown) return;
  
  const hiddenInput = document.getElementById(hiddenInputId);
  const trigger = dropdown.querySelector(".select-trigger");
  const selectedText = dropdown.querySelector(".selected-text");
  const options = dropdown.querySelectorAll(".option-item");

  trigger.onclick = (e) => {
    e.stopPropagation();
    // Close others
    document.querySelectorAll(".custom-select").forEach(s => {
      if (s !== dropdown) s.classList.remove("active");
    });
    dropdown.classList.toggle("active");
  };

  options.forEach(opt => {
    opt.onclick = (e) => {
      e.stopPropagation();
      const val = opt.dataset.value;
      const text = opt.textContent;

      hiddenInput.value = val;
      selectedText.textContent = text;
      
      options.forEach(o => o.classList.remove("selected"));
      opt.classList.add("selected");
      
      dropdown.classList.remove("active");
      if (callback) callback(val);
    };
  });
}
