const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

// DOM Elements
let ytUrlInput, ytFetchBtn, viewTitle, youtubeSearchSection, songGrid;
let localDropSection, localDropBox;
let dockTitle, dockArtist, dockThumb;
let pitchSlider, tempoSlider, pitchVal, tempoVal;
let toggleVocal, toggleLyric;
let streamStartTime, streamTimerInterval;
let isMuted = false;
let prevVolume = 80;

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

  // AI Toggles
  toggleVocal = document.querySelector("#toggle-vocal");
  toggleLyric = document.querySelector("#toggle-lyric");

  initEventListeners();
  initDragAndDrop();
  initNativeFileDrop();
  switchTab("library");
  startStreamingTimer();
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
      addSongToGrid(metadata);
      ytUrlInput.value = "";
    } catch (error) {
      console.error("Fetch failed:", error);
      showNotification("유튜브 정보를 가져오는데 실패했습니다.", "error");
    } finally {
      ytFetchBtn.disabled = false;
      ytFetchBtn.textContent = "정보 가져오기";
    }
  });


  // Real-time Audio Controls Visual Feedback
  pitchSlider.addEventListener("input", (e) => {
    const val = parseFloat(e.target.value).toFixed(1);
    pitchVal.textContent = val > 0 ? `+${val}` : val;
    updatePitch(val);
  });

  tempoSlider.addEventListener("input", (e) => {
    const val = parseFloat(e.target.value).toFixed(2);
    tempoVal.textContent = `${val}x`;
    updateTempo(val);
  });

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
}

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
        addSongToGrid({
          title: fileName,
          path: path, // Full path for playback
          thumbnail: "",
          duration: "--:--",
          source: "local"
        });
        showNotification(`파일 추가됨: ${fileName}`, "success");
      }
    });
  });
}

function processDroppedFiles(files) {
  files.forEach(file => {
    if (file.type.startsWith("audio/") || 
        file.name.endsWith(".mp3") || 
        file.name.endsWith(".wav") || 
        file.name.endsWith(".flac")) {
      
      addSongToGrid({
        title: file.name,
        thumbnail: "",
        duration: "--:--",
        source: "local"
      });
      showNotification(`추가됨: ${file.name}`, "success");
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
    local: "My Musics",
    settings: "System Settings",
    tasks: "Active Processing Tasks"
  };
  return titles[tabId] || "Live MR Manager";
}

function addSongToGrid(song) {
  const card = document.createElement("article");
  card.className = "song-card";
  card.innerHTML = `
    <div class="thumbnail">
      <img src="${song.thumbnail || '/assets/default-cover.png'}" 
           alt="${song.title}" 
           style="width:100%; height:100%; object-fit:cover;">
    </div>
    <div class="song-name">${song.title}</div>
    <div class="song-meta">
      <span class="platform-tag">${song.source.toUpperCase()}</span>
      <span>${song.duration}</span>
    </div>
  `;

  card.addEventListener("click", () => selectTrack(song));
  songGrid.prepend(card);
}

function selectTrack(song) {
  // Update Control Dock
  dockTitle.textContent = song.title;
  dockArtist.textContent = song.source === "youtube" ? "YouTube Stream" : "Local File";
  if (song.thumbnail) {
    dockThumb.style.backgroundImage = `url(${song.thumbnail})`;
    dockThumb.style.backgroundSize = "cover";
  }

  // Actual Playback Call
  if (song.path) {
    invoke("play_track", { path: song.path }).catch(err => {
      console.error("Playback failed:", err);
      showNotification("재생에 실패했습니다.", "error");
    });
  }

  showNotification(`Selected: ${song.title}`, "info");
}

function showNotification(message, type = "info") {
  console.log(`[${type.toUpperCase()}] ${message}`);
  // In a real app, implement a toast notification UI
}
