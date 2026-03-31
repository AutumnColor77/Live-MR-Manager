/**
 * events.js - Event initialization and Tauri listeners
 */

import { state } from './state.js';
import { elements, renderLibrary, updateThumbnailOverlay, updatePlayButton } from './ui.js';
import { formatTime, showNotification } from './utils.js';
import { selectTrack, handlePlaybackToggle, updateProgressBar, playNext, playPrevious } from './player.js';
import { 
  setVolume, setPitch, setTempo, seekTo, saveLibrary, 
  loadLibrary as apiLoadLibrary, getAudioMetadata, getYoutubeMetadata, setVocalBalance 
} from './audio.js';

export function initNavigation() {
  document.querySelectorAll(".nav-item").forEach(item => {
    item.addEventListener("click", () => {
      const tabId = item.id.replace("nav-", "");
      switchTab(tabId);
    });
  });
}

export function switchTab(tabId) {
  if (elements.viewTitle) elements.viewTitle.textContent = getTabTitle(tabId);
  
  document.querySelectorAll(".nav-item").forEach(i => {
    i.classList.toggle("active", i.id === `nav-${tabId}`);
  });

  const isMusicTab = (tabId === "library" || tabId === "youtube" || tabId === "local");
  if (elements.youtubeSection) elements.youtubeSection.style.display = tabId === "youtube" ? "block" : "none";
  if (elements.localSection) elements.localSection.style.display = tabId === "local" ? "block" : "none";
  if (elements.libraryControls) elements.libraryControls.style.display = isMusicTab ? "flex" : "none";
  
  const settingsPage = document.getElementById("settings-page");
  const tasksPage = document.getElementById("tasks-page");
  if (settingsPage) settingsPage.style.display = tabId === "settings" ? "block" : "none";
  if (tasksPage) tasksPage.style.display = tabId === "tasks" ? "block" : "none";
  
  if (elements.songGrid) {
    elements.songGrid.style.display = isMusicTab ? (state.viewMode === "list" ? "flex" : "grid") : "none";
    elements.songGrid.classList.toggle("list-view", state.viewMode === "list");
    if (isMusicTab) renderLibrary();
  }
}

function getTabTitle(tabId) {
  const titles = {
    library: "Music Library",
    youtube: "YouTube 추가",
    local: "내 파일 추가",
    settings: "시스템 설정",
    tasks: "처리 현황"
  };
  return titles[tabId] || "Live MR Manager";
}

export function initGlobalListeners() {
  // YouTube Fetch
  if (elements.ytFetchBtn && elements.ytUrlInput) {
    elements.ytFetchBtn.onclick = async () => {
      const url = elements.ytUrlInput.value.trim();
      if (!url) return;
      elements.ytFetchBtn.disabled = true;
      elements.ytFetchBtn.textContent = "가져오는 중...";
      try {
        const metadata = await getAudioMetadata(url);
        state.songLibrary.push(metadata);
        await saveLibrary(state.songLibrary);
        elements.ytUrlInput.value = "";
        showNotification("추가되었습니다.", "success");
        renderLibrary();
      } catch (err) {
        showNotification("정보를 가져오는데 실패했습니다.", "error");
      } finally {
        elements.ytFetchBtn.disabled = false;
        elements.ytFetchBtn.textContent = "정보 가져오기";
      }
    };
  }

  // View Switching
  if (elements.viewGridBtn && elements.viewListBtn) {
    elements.viewGridBtn.onclick = () => {
      state.viewMode = "grid";
      localStorage.setItem("viewMode", "grid");
      elements.viewGridBtn.classList.add("active");
      elements.viewListBtn.classList.remove("active");
      if (elements.songGrid) {
        elements.songGrid.classList.remove("list-view");
        elements.songGrid.style.display = "grid";
      }
      renderLibrary();
    };
    elements.viewListBtn.onclick = () => {
      state.viewMode = "list";
      localStorage.setItem("viewMode", "list");
      elements.viewListBtn.classList.add("active");
      elements.viewGridBtn.classList.remove("active");
      if (elements.songGrid) {
        elements.songGrid.classList.add("list-view");
        elements.songGrid.style.display = "flex";
      }
      renderLibrary();
    };
  }

  // Sliders
  if (elements.pitchSlider) {
    elements.pitchSlider.oninput = (e) => {
      const val = e.target.value;
      elements.pitchVal.textContent = val > 0 ? `+${val}` : val;
      setPitch(val);
      if (state.currentTrack) state.currentTrack.pitch = parseFloat(val);
    };
    elements.pitchSlider.onchange = () => saveLibrary(state.songLibrary);
  }

  if (elements.tempoSlider) {
    elements.tempoSlider.oninput = (e) => {
      const val = e.target.value;
      elements.tempoVal.textContent = `${parseFloat(val).toFixed(2)}x`;
      setTempo(val);
      if (state.currentTrack) state.currentTrack.tempo = parseFloat(val);
    };
    elements.tempoSlider.onchange = () => saveLibrary(state.songLibrary);
  }

  if (elements.volSlider) {
    elements.volSlider.oninput = (e) => {
      const val = e.target.value;
      setVolume(val);
      if (state.currentTrack) state.currentTrack.volume = parseFloat(val);
    };
    elements.volSlider.onchange = () => saveLibrary(state.songLibrary);
  }

  if (elements.vocalBalance) {
    elements.vocalBalance.oninput = (e) => {
      setVocalBalance(e.target.value);
    };
  }

  if (elements.playbackBar) {
    elements.playbackBar.oninput = (e) => {
      state.isSeeking = true;
      const pct = e.target.value;
      elements.progressFill.style.width = `${pct}%`;
      const pos = (pct / 100) * state.trackDurationMs;
      elements.timeCurrent.textContent = formatTime(pos / 1000);
    };
    elements.playbackBar.onchange = async (e) => {
      const pct = e.target.value;
      const posMs = (pct / 100) * state.trackDurationMs;
      state.currentProgressMs = posMs;
      state.targetProgressMs = posMs;
      await seekTo(posMs);
      state.isSeeking = false;
    };
  }

  // Play/Pause
  if (elements.togglePlayBtn) {
    elements.togglePlayBtn.onclick = handlePlaybackToggle;
  }
  
  if (elements.thumbOverlay) {
    elements.thumbOverlay.onclick = handlePlaybackToggle;
  }

  if (elements.btnNext) {
    elements.btnNext.onclick = playNext;
  }

  if (elements.btnPrev) {
    elements.btnPrev.onclick = playPrevious;
  }

  // Custom Event for Song Selection
  window.addEventListener('song-select', (e) => {
    selectTrack(e.detail.index);
  });

  // Modal Save
  const modalSave = document.getElementById("modal-save");
  if (modalSave) {
    modalSave.onclick = async () => {
      if (state.editingSongIndex === -1) return;
      const song = state.songLibrary[state.editingSongIndex];
      song.title = document.getElementById("edit-title").value;
      song.artist = document.getElementById("edit-artist").value;
      song.tags = document.getElementById("edit-tags").value.split(",").map(t => t.trim()).filter(t => t);
      
      const editCatSelect = document.getElementById("edit-category-select");
      const catVal = editCatSelect?.value;
      song.category = catVal === "etc" ? document.getElementById("edit-category-custom").value : catVal;
      
      await saveLibrary(state.songLibrary);
      renderLibrary();
      elements.metadataModal.classList.remove("active");
      showNotification("변경사항이 저장되었습니다.", "success");
    };
  }

  // Click outside close
  document.addEventListener("click", () => {
    if (elements.contextMenu) elements.contextMenu.classList.remove("active");
    // Close custom dropdowns
    document.querySelectorAll(".custom-select").forEach(el => el.classList.remove("active"));
  });
}

export function setupBackendListeners() {
  const { listen } = window.__TAURI__.event;
  
  listen("playback-progress", (event) => {
    if (!state.isSeeking) {
      state.targetProgressMs = event.payload.position_ms;
      // 백엔드에서 0이 오더라도 기존 값이 있다면 무시 (초기화 방지)
      if (event.payload.duration_ms > 0 || !state.trackDurationMs) {
        state.trackDurationMs = event.payload.duration_ms;
      }
      if (elements.timeTotal && state.trackDurationMs > 0) {
        elements.timeTotal.textContent = formatTime(state.trackDurationMs / 1000);
      }
    }
  });

  listen("playback-status", (event) => {
    const { status, message } = event.payload;
    if (status === "Finished") {
      state.isPlaying = false;
      updateThumbnailOverlay();
      updatePlayButton();
    } else if (status === "Error") {
      showNotification(message, "error");
      state.isLoading = false;
      updateThumbnailOverlay();
    }
  });

  listen("separation-progress", (event) => {
    const { path, percentage, status } = event.payload;
    state.activeTasks[path] = { percentage, status };
    updateTaskUI();
    if (status === "Finished") {
      renderLibrary();
      showNotification("곡 분리 작업이 완료되었습니다.", "success");
    }
  });

  listen("tauri://drag-drop", async (event) => {
    const paths = event.payload.paths;
    if (paths) {
      for (const path of paths) {
        const ext = path.split('.').pop().toLowerCase();
        if (["mp3", "wav", "flac"].includes(ext)) {
          try {
            const metadata = await getAudioMetadata(path);
            metadata.source = "local";
            state.songLibrary.push(metadata);
            await saveLibrary(state.songLibrary);
            showNotification("파일이 추가되었습니다.", "success");
            renderLibrary();
          } catch (err) {
            console.error("Drop add failed", err);
          }
        }
      }
    }
  });
}

function updateTaskUI() {
  const badge = document.getElementById("task-badge");
  const list = document.getElementById("active-tasks-list");
  if (!list) return;

  const runningTasks = Object.entries(state.activeTasks).filter(([_, t]) => t.status !== "Finished");
  const activeCount = runningTasks.length;
  
  if (badge) {
    badge.textContent = activeCount;
    badge.style.display = activeCount > 0 ? "flex" : "none";
  }

  if (activeCount === 0) {
    list.innerHTML = '<div class="no-tasks">진행 중인 작업이 없습니다.</div>';
  } else {
    list.innerHTML = runningTasks.map(([path, t]) => `
      <div class="task-card">
        <div class="task-info">
          <span class="task-title">${path.split(/[\\/]/).pop()}</span>
          <span class="task-status">${t.status} (${Math.round(t.percentage)}%)</span>
        </div>
        <div class="task-progress">
          <div class="task-progress-fill" style="width: ${t.percentage}%"></div>
        </div>
        <button class="task-cancel" onclick="window.cancelTask('${path}')">취소</button>
      </div>
    `).join("");
  }
}

window.cancelTask = async (path) => {
  const { invoke } = window.__TAURI__.core;
  await invoke("cancel_separation", { path });
  delete state.activeTasks[path];
  updateTaskUI();
};
