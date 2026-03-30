const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

// DOM Elements
let ytUrlInput, ytFetchBtn, viewTitle, youtubeSearchSection, songGrid;
let localDropSection, localDropBox;
let dockTitle, dockArtist, dockThumb;
let pitchSlider, tempoSlider, pitchVal, tempoVal;
let playbackBar, progressFill, timeCurrent, timeTotal;
let toggleVocal, toggleLyric;
let thumbOverlay, contextMenu, menuPlay, menuDelete;
let streamStartTime, streamTimerInterval;

// Playback State
let isMuted = false;
let prevVolume = 80;
let isPlaying = false;
let isLoading = false;
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
  menuDelete = document.querySelector("#menu-delete");

  initEventListeners();
  initDragAndDrop();
  initNativeFileDrop();
  initPlaybackStatusListener();
  initSystemLogListener();
  initContextMenu();
  initViewToggle();
  switchTab("library");
  startStreamingTimer();
  
  // Load saved library on startup
  loadLibrary();
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
    } catch (error) {
      console.error("Fetch failed:", error);
      showNotification("곡 추가에 실패했습니다", "error");
    } finally {
      ytFetchBtn.disabled = false;
      ytFetchBtn.textContent = "정보 가져오기";
    }
  });

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

  // Channel Settings
  document.querySelector("#stream-title-input").addEventListener("change", (e) => {
    console.log(`Stream Title Updated: ${e.target.value}`);
    // invoke("update_stream_settings", { title: e.target.value })
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
  await listen("tauri-file-dropped", (event) => {
    const paths = event.payload;
    paths.forEach(path => {
      // Ext name check (simple)
      const ext = path.split('.').pop().toLowerCase();
      if (["mp3", "wav", "flac"].includes(ext)) {
        const fileName = path.split(/[\\/]/).pop();
        addToLibrary({
          title: fileName,
          path: path, // Full path for playback
          thumbnail: "",
          duration: "--:--",
          source: "local"
        });
        showNotification("곡이 추가되었습니다", "success");
      }
    });
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
    } else if (status === "Error" || status === "Stopped") {
      isPlaying = false;
      isLoading = false;
      updateThumbnailOverlay();
      if (rafId) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
    }
  });

  await listen("playback-progress", (event) => {
    let { positionMs, durationMs } = event.payload;
    if (!durationMs || isNaN(durationMs) || durationMs <= 0) durationMs = 1;
    if (isNaN(positionMs) || positionMs < 0) positionMs = 0;

    targetProgressMs = positionMs;
    trackDurationMs = durationMs;
    playbackBar.dataset.durationMs = durationMs;
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

function processDroppedFiles(files) {
  files.forEach(file => {
    if (file.type.startsWith("audio/") || 
        file.name.endsWith(".mp3") || 
        file.name.endsWith(".wav") || 
        file.name.endsWith(".flac")) {
      
      addToLibrary({
        title: file.name,
        thumbnail: "",
        duration: "--:--",
        source: "local",
        path: file.path || file.name // Note: Web API file.path might be empty depending on environment
      });
      showNotification("곡이 추가되었습니다", "success");
    }
  });
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
  youtubeSearchSection.style.display = tabId === "youtube" ? "block" : "none";
  localDropSection.style.display = tabId === "local" ? "block" : "none";
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

function addSongToGrid(song) {
  const card = document.createElement("article");
  card.className = "song-card";
  
  // Grid vs List consistent structure
  card.innerHTML = `
    <div class="thumbnail">
      <img src="${song.thumbnail || 'assets/images/Thumb_Music.png'}" 
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
      <div class="song-name">${song.title}</div>
      <div class="song-meta">
        <span class="platform-tag">${song.source.toUpperCase()}</span>
        <span>${song.duration}</span>
      </div>
    </div>
  `;
  card.dataset.path = song.path;

  card.addEventListener("click", () => {
    if (currentTrack && currentTrack.path === song.path) {
      handlePlaybackToggle();
    } else {
      selectTrack(song);
    }
  });

  card.addEventListener("contextmenu", (e) => {
    window.showSongContextMenu(e, song, card);
  });

  songGrid.prepend(card);
}

function selectTrack(song) {
  // Update Control Dock
  dockTitle.textContent = song.title;
  dockArtist.textContent = song.source === "youtube" ? "YouTube Stream" : "Local File";
  if (song.thumbnail) {
    dockThumb.style.backgroundImage = `url(${song.thumbnail})`;
    dockThumb.style.backgroundSize = "cover";
  } else {
    dockThumb.style.backgroundImage = `url('assets/images/Thumb_Music.png')`;
  }
  
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
        
        // Ensure RAF is running even if listener hasn't started it yet
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
  if (!container) {
    console.log(`[${type.toUpperCase()}] ${message}`);
    return;
  }

  const toast = document.createElement("div");
  toast.className = `toast ${type}`;
  
  const icons = {
    info: "ℹ️",
    success: "✅",
    error: "❌",
    warning: "⚠️"
  };

  toast.innerHTML = `
    <span class="toast-icon">${icons[type] || "🔔"}</span>
    <span class="toast-message">${message}</span>
  `;

  container.appendChild(toast);

  // Auto remove after 4 seconds
  setTimeout(() => {
    toast.classList.add("removing");
    setTimeout(() => toast.remove(), 300);
  }, 4000);
}

function initViewToggle() {
  const gridBtn = document.querySelector("#view-grid");
  const listBtn = document.querySelector("#view-list");

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

  // Initial set
  setView(viewMode);
}

function addToLibrary(song) {
  // Initialize default settings if not present
  if (song.pitch === undefined) song.pitch = 0;
  if (song.tempo === undefined) song.tempo = 1.0;
  if (song.volume === undefined) song.volume = 80;

  songLibrary.push(song);
  renderLibrary();
  saveLibrary();
}

function renderLibrary() {
  songGrid.innerHTML = "";
  songLibrary.forEach(song => {
    addSongToGrid(song);
  });
}
