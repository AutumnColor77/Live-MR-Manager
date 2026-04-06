/**
 * events.js - Event initialization and Tauri listeners
 */

import { state } from './state.js';
import { elements, renderLibrary, updateThumbnailOverlay, updatePlayButton, updateAiModelStatus } from './ui.js';
import { formatTime, showNotification } from './utils.js';
import { selectTrack, highlightTrack, handlePlaybackToggle, updateProgressBar, handleNextTrack, handlePrevTrack } from './player.js';
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
  if (elements.viewControls) elements.viewControls.style.display = isMusicTab ? "flex" : "none";
  
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
    library: "Library",
    youtube: "YouTube",
    local: "My Files",
    settings: "Settings",
    tasks: "Active Tasks"
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
    
    // Middle-click to reset (0)
    elements.pitchSlider.addEventListener("auxclick", (e) => {
      if (e.button === 1) {
        elements.pitchSlider.value = 0;
        elements.pitchSlider.dispatchEvent(new Event("input"));
        elements.pitchSlider.dispatchEvent(new Event("change"));
      }
    });
    
    // Wheel Interaction
    elements.pitchSlider.addEventListener("wheel", (e) => {
      e.preventDefault();
      let val = parseInt(elements.pitchSlider.value);
      if (e.deltaY < 0) val += 1; else val -= 1;
      val = Math.max(-12, Math.min(12, val));
      elements.pitchSlider.value = val;
      elements.pitchSlider.dispatchEvent(new Event("input"));
      elements.pitchSlider.dispatchEvent(new Event("change"));
    }, { passive: false });
  }

  if (elements.pitchVal) {
    setupDirectInput(elements.pitchVal, elements.pitchSlider);
  }

  if (elements.tempoSlider) {
    elements.tempoSlider.oninput = (e) => {
      const val = e.target.value;
      elements.tempoVal.textContent = `${parseFloat(val).toFixed(2)}x`;
      setTempo(val);
      if (state.currentTrack) state.currentTrack.tempo = parseFloat(val);
    };
    elements.tempoSlider.onchange = () => saveLibrary(state.songLibrary);

    // Middle-click to reset (1.0)
    elements.tempoSlider.addEventListener("auxclick", (e) => {
      if (e.button === 1) {
        elements.tempoSlider.value = 1.0;
        elements.tempoSlider.dispatchEvent(new Event("input"));
        elements.tempoSlider.dispatchEvent(new Event("change"));
      }
    });

    // Wheel Interaction
    elements.tempoSlider.addEventListener("wheel", (e) => {
      e.preventDefault();
      let val = parseFloat(elements.tempoSlider.value);
      if (e.deltaY < 0) val += 0.05; else val -= 0.05;
      val = Math.max(0.5, Math.min(2.0, val));
      elements.tempoSlider.value = val.toFixed(2);
      elements.tempoSlider.dispatchEvent(new Event("input"));
      elements.tempoSlider.dispatchEvent(new Event("change"));
    }, { passive: false });
  }

  if (elements.tempoVal) {
    setupDirectInput(elements.tempoVal, elements.tempoSlider);
  }

  if (elements.volSlider) {
    elements.volSlider.oninput = (e) => {
      const val = e.target.value;
      setVolume(val);
      if (state.currentTrack) state.currentTrack.volume = parseFloat(val);
    };
    elements.volSlider.onchange = () => saveLibrary(state.songLibrary);

    // Middle-click to reset (80)
    elements.volSlider.addEventListener("auxclick", (e) => {
      if (e.button === 1) {
        elements.volSlider.value = 80;
        elements.volSlider.dispatchEvent(new Event("input"));
        elements.volSlider.dispatchEvent(new Event("change"));
      }
    });

    // Wheel Interaction
    elements.volSlider.addEventListener("wheel", (e) => {
      e.preventDefault();
      let val = parseInt(elements.volSlider.value);
      if (e.deltaY < 0) val += 2; else val -= 2;
      val = Math.max(0, Math.min(100, val));
      elements.volSlider.value = val;
      elements.volSlider.dispatchEvent(new Event("input"));
      elements.volSlider.dispatchEvent(new Event("change"));
    }, { passive: false });
  }

  if (elements.vocalBalance) {
    elements.vocalBalance.oninput = (e) => {
      setVocalBalance(e.target.value);
    };
  }

  // Library Search
  if (elements.libSearchInput) {
    elements.libSearchInput.addEventListener("input", () => {
      renderLibrary();
    });
  }

  // Global Audio Reset Button
  const btnReset = document.getElementById("btn-reset-audio");
  if (btnReset) {
    btnReset.onclick = () => {
      // 1. Reset Sliders only
      if (elements.pitchSlider) {
        elements.pitchSlider.value = 0;
        elements.pitchSlider.dispatchEvent(new Event("input"));
      }
      if (elements.tempoSlider) {
        elements.tempoSlider.value = 1.0;
        elements.tempoSlider.dispatchEvent(new Event("input"));
      }
      if (elements.volSlider) {
        elements.volSlider.value = 80;
        elements.volSlider.dispatchEvent(new Event("input"));
      }

      saveLibrary(state.songLibrary);
      showNotification("오디오 설정이 초기화되었습니다.", "info");
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
      
      // Update local state immediately to avoid jump
      state.targetProgressMs = posMs;
      state.currentProgressMs = posMs;
      
      await seekTo(posMs);
      state.isSeeking = false;
    };
  }

  // Play/Pause
  if (elements.togglePlayBtn) {
    elements.togglePlayBtn.onclick = handlePlaybackToggle;
  }
  
  if (elements.dockThumb) {
    elements.dockThumb.onclick = handlePlaybackToggle;
  }

  if (elements.btnNext) {
    elements.btnNext.onclick = handleNextTrack;
  }

  if (elements.btnPrev) {
    elements.btnPrev.onclick = handlePrevTrack;
  }

  // Custom Event for Song Selection
  window.addEventListener('song-select', (e) => {
    selectTrack(e.detail.index);
  });

  window.addEventListener('highlight-song', (e) => {
    highlightTrack(e.detail.index);
  });

  // Modal Save
  const modalSave = document.getElementById("modal-save");
  if (modalSave) {
    const performSave = async () => {
      if (state.editingSongIndex === -1) return;
      const song = state.songLibrary[state.editingSongIndex];
      song.title = document.getElementById("edit-title").value;
      song.artist = document.getElementById("edit-artist").value;
      song.tags = document.getElementById("edit-tags").value.split(",").map(t => t.trim()).filter(t => t);
      
      const catVal = document.getElementById("edit-category").value.trim();
      song.category = catVal;
      song.categories = catVal ? [catVal] : [];
      
      const editGenreSelect = document.getElementById("edit-genre-select");
      const genreVal = editGenreSelect ? editGenreSelect.value : "";
      const customGenreVal = document.getElementById("edit-genre-custom").value;
      song.genre = genreVal === "etc" ? customGenreVal : genreVal;
      
      await saveLibrary(state.songLibrary);
      renderLibrary();
      elements.metadataModal.classList.remove("active");
      showNotification("변경사항이 저장되었습니다.", "success");
    };

    modalSave.onclick = performSave;

    // Add Enter key listener to all metadata inputs
    ["edit-title", "edit-artist", "edit-category", "edit-genre-custom", "edit-tags"].forEach(id => {
      const input = document.getElementById(id);
      if (input) {
        input.addEventListener("keydown", (e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            performSave();
          }
        });
      }
    });
  }

  // Modal Actions
  const modalClose = document.getElementById("modal-close");
  const modalCancel = document.getElementById("modal-cancel");
  if (modalClose) modalClose.onclick = () => elements.metadataModal.classList.remove("active");
  if (modalCancel) modalCancel.onclick = () => elements.metadataModal.classList.remove("active");

  const confirmClose = document.getElementById("confirm-close-icon");
  const confirmCancel = document.getElementById("confirm-cancel");
  if (confirmClose) confirmClose.onclick = () => elements.confirmModal.classList.remove("active");
  if (confirmCancel) confirmCancel.onclick = () => elements.confirmModal.classList.remove("active");

  // Event Delegation for Custom Selects and Outside Clicks
  let lastMouseDownTarget = null;
  
  document.addEventListener("mousedown", (e) => {
    lastMouseDownTarget = e.target;
  });

  document.addEventListener("click", (e) => {
    // 1. Context Menu Close
    if (elements.contextMenu) elements.contextMenu.classList.remove("active");
    
    // 2. Modal Overlay Close (Outside click - only if started AND ended on the overlay)
    if (e.target.classList.contains("modal-overlay") && lastMouseDownTarget === e.target) {
      e.target.classList.remove("active");
    }

    // 3. Custom Select Toggle Logic
    const customSelect = e.target.closest(".custom-select");
    if (customSelect) {
      const isCurrentlyActive = customSelect.classList.contains("active");
      
      // 모든 드롭다운 일단 닫기 (상호 배타적 열기)
      document.querySelectorAll(".custom-select").forEach(el => el.classList.remove("active"));
      
      // 방금 클릭한 것이 닫혀있었다면 열기 (토글)
      if (!isCurrentlyActive) {
        customSelect.classList.add("active");
      }
    } else {
      // 드롭다운 외부 클릭 시 모든 드롭다운 닫기
      document.querySelectorAll(".custom-select").forEach(el => el.classList.remove("active"));
    }

    // Global click to deselect when clicking outside
    const card = e.target.closest(".song-card");
    const dock = e.target.closest(".control-dock");
    const modal = e.target.closest(".modal");
    const context = e.target.closest("#context-menu");
    
    if (!card && !dock && !modal && !context) {
      if (state.selectedTrackIndex !== -1) {
        state.selectedTrackIndex = -1;
        updateThumbnailOverlay();
        // Reset VOCAL/LYRIC UI (Disable) but KEEP persistence
        import('./ui.js').then(m => m.updateAiTogglesState(null));
      }
    }

    if (!e.target.closest(".suggestion-dropdown") && !e.target.closest(".input-group input")) {
      document.querySelectorAll(".suggestion-dropdown").forEach(el => el.classList.remove("active"));
    }
  });

  initAutocompleteListeners();

  // VOCAL Toggle persistence
  elements.toggleVocal?.addEventListener("change", async (e) => {
    state.vocalEnabled = e.target.checked;
    localStorage.setItem("vocalEnabled", state.vocalEnabled);
    console.log(`[STATE] Vocal Enabled: ${state.vocalEnabled}`);
    const { toggleAiFeature } = await import('./audio.js');
    await toggleAiFeature("vocal", state.vocalEnabled);
  });

  // LYRIC Toggle persistence
  elements.toggleLyric?.addEventListener("change", async (e) => {
    state.lyricsEnabled = e.target.checked;
    localStorage.setItem("lyricsEnabled", state.lyricsEnabled);
    console.log(`[STATE] Lyrics Enabled: ${state.lyricsEnabled}`);
    const { toggleAiFeature } = await import('./audio.js');
    await toggleAiFeature("lyric", state.lyricsEnabled);
  });

  // Settings Events
  const btnDownloadModel = document.getElementById("btn-download-model");
  const btnOpenCache = document.getElementById("btn-open-cache");

  if (btnDownloadModel) {
    btnDownloadModel.onclick = async () => {
      try {
        const { invoke } = window.__TAURI__.core;
        const { updateAiModelStatus } = await import('./ui.js');
        await invoke("download_ai_model");
        state.isAiModelReady = true;
        updateAiModelStatus(true);
        showNotification("AI 모델 다운로드 및 준비가 완료되었습니다.", "success");
      } catch (err) {
        showNotification("모델 다운로드 실패: " + err, "error");
      }
    };
  }

  if (btnOpenCache) {
    btnOpenCache.onclick = async () => {
      try {
        const { invoke } = window.__TAURI__.core;
        await invoke("open_cache_folder");
      } catch (err) {
        showNotification("폴더 열기 실패: " + err, "error");
      }
    };
  }

  const btnDeleteModel = document.getElementById("btn-delete-model");
  if (btnDeleteModel) {
    btnDeleteModel.onclick = () => {
      const confirmTitle = document.getElementById("confirm-title");
      const confirmMsg = document.getElementById("confirm-message");
      const confirmOk = document.getElementById("confirm-ok");
      
      if (confirmTitle) confirmTitle.textContent = "AI 모델 삭제";
      if (confirmMsg) confirmMsg.textContent = "AI 모델 파일(Kim Vocal 2)을 삭제하시겠습니까?\n삭제 후에는 다시 다운로드해야 분리 기능을 사용할 수 있습니다.";
      
      if (confirmOk) {
        confirmOk.onclick = async () => {
          try {
            const { invoke } = window.__TAURI__.core;
            await invoke("delete_ai_model");
            showNotification("AI 모델이 삭제되었습니다.", "success");
            
            elements.confirmModal.classList.remove("active");
            
            // Sync status
            updateAiModelStatus(false);
          } catch (err) {
            showNotification("모델 삭제 실패: " + err, "error");
            elements.confirmModal.classList.remove("active");
          }
        };
      }
      elements.confirmModal.classList.add("active");
    };
  }

  // --- Library Manager Events ---
  let libraryBackup = [];

  if (elements.btnOpenManager) {
    elements.btnOpenManager.onclick = () => {
      libraryBackup = JSON.parse(JSON.stringify(state.songLibrary));
      import('./ui.js').then(m => {
        m.openLibraryManager();
        m.initTableResizing();
      });
    };
  }

  const managerModalSave = document.getElementById("manager-modal-save");
  const managerModalCancel = document.getElementById("manager-modal-cancel");
  const managerModalX = document.getElementById("manager-modal-close");

  if (managerModalSave) {
    managerModalSave.onclick = async () => {
      // 1. Manually read ALL inputs from current table rows to ensure latest values are captured
      // (Handles cases where blur/change event hasn't fired yet)
      const rows = elements.managerTableBody.querySelectorAll("tr");
      rows.forEach(tr => {
        const index = parseInt(tr.dataset.index);
        const song = state.songLibrary[index];
        if (song) {
          tr.querySelectorAll("input[data-field]").forEach(input => {
            const field = input.dataset.field;
            const value = input.value.trim();
            if (field === "tags") {
              song.tags = value.split(",").map(t => t.trim()).filter(t => t);
            } else if (field === "category") {
              song.category = value;
              song.categories = value ? [value] : [];
            } else {
              song[field] = value;
            }
          });
        }
      });
      
      // 2. Persist to backend and refresh ALL UI parts
      await saveLibrary(state.songLibrary);
      renderLibrary();
      elements.managerModal.classList.remove("active");
      showNotification("라이브러리 수정 사항이 저장되었습니다.", "success");
    };
  }

  const handleCancelManager = () => {
    state.songLibrary = JSON.parse(JSON.stringify(libraryBackup));
    renderLibrary();
    elements.managerModal.classList.remove("active");
  };

  if (managerModalCancel) managerModalCancel.onclick = handleCancelManager;
  if (managerModalX) managerModalX.onclick = handleCancelManager;

  if (elements.managerSearchInput) {
    elements.managerSearchInput.oninput = () => {
      import('./ui.js').then(m => m.renderManagerTable());
    };
  }

  // Manager Table Sorting & Editing
  const managerTable = document.getElementById("manager-table");
  if (managerTable) {
    const thead = managerTable.querySelector("thead");
    const tbody = managerTable.querySelector("tbody");

    if (thead) {
      thead.onclick = (e) => {
        const th = e.target.closest("th.sortable");
        if (!th) return;
        
        const currentOrder = th.getAttribute("data-order");
        const newOrder = currentOrder === "asc" ? "desc" : "asc";
        
        thead.querySelectorAll("th").forEach(el => el.removeAttribute("data-order"));
        th.setAttribute("data-order", newOrder);
        
        import('./ui.js').then(m => m.renderManagerTable());
      };
    }

    if (tbody) {
      // Cell Edit (Local update only, no auto-save to disk)
      tbody.onchange = (e) => {
        const input = e.target.closest("input");
        if (!input) return;
        
        const tr = input.closest("tr");
        const index = parseInt(tr.dataset.index);
        const field = input.dataset.field;
        const value = input.value.trim();
        
        const song = state.songLibrary[index];
        if (!song) return;
        
        if (field === "tags") {
          song.tags = value.split(",").map(t => t.trim()).filter(t => t);
        } else {
          song[field] = value;
        }
        // No auto-save here to respect the Save/Cancel pattern
      };

      // Row Delete
      tbody.onclick = async (e) => {
        const btn = e.target.closest(".btn-row-del");
        if (!btn) return;
        
        const index = parseInt(btn.dataset.index);
        const song = state.songLibrary[index];
        if (!song) return;
        
        const confirmTitle = document.getElementById("confirm-title");
        const confirmMsg = document.getElementById("confirm-message");
        const confirmOk = document.getElementById("confirm-ok");
        
        if (confirmTitle) confirmTitle.textContent = "곡 삭제 (관리자)";
        if (confirmMsg) confirmMsg.textContent = `'${song.title}' 곡을 라이브러리에서 삭제하시겠습니까? (저장 시 반영)`;
        
        if (confirmOk) {
          confirmOk.onclick = () => {
            state.songLibrary.splice(index, 1);
            import('./ui.js').then(m => m.renderManagerTable());
            elements.confirmModal.classList.remove("active");
          };
        }
        elements.confirmModal.classList.add("active");
      };
    }
  }
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
    console.log(`[AUDIO STATUS] ${status}: ${message}`);
    
    // 1. Loading/Activity status
    if (status === "Loading" || status === "Downloading" || status === "Decoding" || status === "Pending") {
      state.isLoading = true;
    } else {
      state.isLoading = false;
    }

    // 2. Playback state updates
    if (status === "Playing") {
      state.isPlaying = true;
    } else if (status === "Finished" || status === "Error") {
      state.isPlaying = false;
      if (status === "Finished") {
        state.currentProgressMs = 0;
        state.targetProgressMs = 0;
        // Progress UI reset
        if (elements.playbackBar) elements.playbackBar.value = 0;
        if (elements.progressFill) elements.progressFill.style.width = "0%";
        if (elements.timeCurrent) elements.timeCurrent.textContent = "0:00";
      }
    }

    // 3. Visual Status Message in Dock
    if (elements.statusMsg) {
      elements.statusMsg.textContent = message || (status === "Playing" ? "Ready" : "");
      elements.statusMsg.classList.toggle("active", !!elements.statusMsg.textContent);
      
      // Auto-hide status text after 3s on successful start
      if (status === "Playing") {
        setTimeout(() => {
          if (elements.statusMsg.textContent === "Ready" || elements.statusMsg.textContent === message) {
            elements.statusMsg.textContent = "";
            elements.statusMsg.classList.remove("active");
          }
        }, 3000);
      }
    }

    if (status === "Error") {
      showNotification(message || "재생 중 오류가 발생했습니다.", "error");
    }

    // Always sync UI
    import('./ui.js').then(m => {
      m.updateThumbnailOverlay();
      m.updatePlayButton();
    });
  });

  listen("separation-progress", (event) => {
    const { path, percentage, status, provider } = event.payload;
    
    // 1. Ignore events for paths that were recently cancelled
    if (state.cancelledPaths.has(path)) {
      if (status === "Finished" || status === "Cancelled" || status === "Error") {
        state.cancelledPaths.delete(path);
      }
      return;
    }

    state.activeTasks[path] = { percentage, status, provider };
    
    if (status === "Finished" || status === "Cancelled" || status === "Error") {
      // 1. Show final state immediately
      updateTaskUI(path); 
      
      if (status === "Finished") {
        renderLibrary();
        showNotification("곡 분리 작업이 완료되었습니다.", "success");
      }
      
      // 2. Wait 2 seconds then remove from list
      setTimeout(() => {
        // Ensure it's still the SAME task (not restarted)
        if (state.activeTasks[path] && (state.activeTasks[path].status === "Finished" || state.activeTasks[path].status === "Cancelled" || state.activeTasks[path].status === "Error")) {
          delete state.activeTasks[path];
          updateTaskUI(); // Re-render to remove it
        }
      }, 2000);
    } else {
      updateTaskUI(path);
    }
  });

  listen("model-download-progress", (event) => {
    const percentage = Math.round(event.payload);
    if (elements.btnDownloadModel) {
      elements.btnDownloadModel.disabled = true;
      elements.btnDownloadModel.textContent = `다운로드 중 (${percentage}%)`;
      
      if (percentage >= 100) {
        setTimeout(() => {
          elements.btnDownloadModel.disabled = false;
          elements.btnDownloadModel.textContent = "모델 다운로드";
        }, 1500);
      }
    }
    
    // Also update overlay if visible
    const progressBar = document.getElementById("model-download-bar");
    const percentText = document.getElementById("model-download-percent");
    if (progressBar) progressBar.style.width = `${percentage}%`;
    if (percentText) percentText.textContent = `${percentage}%`;
  });

  listen("tauri://drag-drop", async (event) => {
    const paths = event.payload.paths;
    if (paths) {
      for (const path of paths) {
        const ext = path.split('.').pop().toLowerCase();
        if (["mp3", "wav", "flac", "m4a", "aac", "ogg", "wma"].includes(ext)) {
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

function updateTaskUI(targetPath = null) {
  const badge = document.getElementById("task-badge");
  const list = document.getElementById("active-tasks-list");
  if (!list) return;

  const allTasks = Object.entries(state.activeTasks);
  const runningTasks = allTasks.filter(([_, t]) => t.status !== "Finished" && t.status !== "Cancelled" && t.status !== "Error");
  const activeCount = runningTasks.length;
  
  if (badge) {
    badge.textContent = activeCount;
    badge.style.display = activeCount > 0 ? "flex" : "none";
  }

  // 1. Partial Update: Only update the progress and status if task already in DOM
  if (targetPath) {
    // Find numerically to remove some CSS selector escaping issues
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
        statusTextEl.textContent = task.status === "Queued" ? "대기 중..." : task.status === "Starting" ? "준비 중..." : task.status;
      }
      
      // Only skip full render if task is STILL RUNNING.
      // If Finished/Cancelled/Error, we want it to fall through to full render eventually
      // (though usually we handle that with updateTaskUI() call after delay)
      const isRunning = task.status !== "Finished" && task.status !== "Cancelled" && task.status !== "Error";
      if (isRunning) return; 
    }
  }

  // 2. Full Render: If new task, removed task, or no targetPath provided
  if (allTasks.length === 0) {
    list.innerHTML = '<div class="no-tasks">현재 진행 중인 작업이 없습니다.</div>';
  } else {
    list.innerHTML = allTasks.map(([path, t]) => {
      // Normalize paths for matching (handle slashes, casing, and encoding like %20)
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
      
      // Provider logic refinement
      const rawProvider = (t.provider || "").toUpperCase();
      const isGPU = rawProvider.includes("GPU") || rawProvider.includes("CUDA") || rawProvider.includes("DIRECTML");
      const isCPU = rawProvider.includes("CPU");
      const isSystem = rawProvider.includes("SYSTEM") || t.status.includes("모델");
      const isNetwork = rawProvider.includes("NETWORK") || t.status.toLowerCase().includes("down");

      let providerText = "AI";
      let providerClass = "provider-ai";

      if (isGPU) {
        providerText = "GPU";
        providerClass = "provider-gpu";
      } else if (isCPU) {
        providerText = "CPU";
        providerClass = "provider-cpu";
      } else if (isNetwork) {
        providerText = "NETWORK";
        providerClass = "provider-network";
      } else if (isSystem) {
        providerText = "AI";
        providerClass = "provider-ai";
      } else if (t.status === "Queued") {
        providerText = "QUEUED";
        providerClass = "provider-queued";
      }

      return `
        <div class="task-card ${isQueued ? 'task-queued' : ''}" data-task-path="${path}">
          <div class="task-header-info">
            ${thumbnail ? 
              `<img src="${thumbnail}" class="task-thumb" onerror="this.style.display='none'">` :
              `<div class="task-icon">MR</div>`
            }
            <div class="task-info-main">
              <span class="task-title" title="${path}">${displayName}</span>
              <div class="task-status-row-top">
                <span class="task-status-text">${statusText}</span>
                <span class="task-percentage">${isQueued ? '-' : pct + '%'}</span>
              </div>
            </div>
            <div class="task-provider-badge ${providerClass}">${providerText}</div>
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


window.cancelTask = (el) => {
  const { invoke } = window.__TAURI__.core;
  // Get path from data attribute (prevents backslash mangling in HTML)
  const path = typeof el === 'string' ? el : el.dataset.taskPath;
  
  if (!path) return;

  // 1. Immediate UI Feedback & Blacklist
  state.cancelledPaths.add(path); // Block any residual events
  if (state.activeTasks[path]) {
    delete state.activeTasks[path];
  }
  updateTaskUI(); 
  
  // 2. Non-blocking backend call
  invoke("cancel_separation", { path }).catch(err => {
    console.error("Cancellation notice failed:", err);
  });
  
  // 3. Safety: Remove from blacklist after a delay to allow re-trying
  setTimeout(() => {
    state.cancelledPaths.delete(path);
  }, 3000);
};

/**
 * Helper to setup direct number input for value displays
 */
function setupDirectInput(displayEl, sliderEl) {
  displayEl.onclick = (e) => {
    e.stopPropagation();
    if (displayEl.querySelector("input")) return;

    const input = document.createElement("input");
    input.type = "number";
    input.className = "val-input";
    input.value = parseFloat(sliderEl.value);
    input.step = sliderEl.step;
    input.min = sliderEl.min;
    input.max = sliderEl.max;

    const originalText = displayEl.textContent;
    displayEl.textContent = "";
    displayEl.appendChild(input);
    input.focus();
    input.select();

    const save = () => {
      let val = parseFloat(input.value);
      if (isNaN(val)) val = parseFloat(sliderEl.value);
      val = Math.max(parseFloat(sliderEl.min), Math.min(parseFloat(sliderEl.max), val));

      sliderEl.value = val;
      sliderEl.dispatchEvent(new Event("input"));
      sliderEl.dispatchEvent(new Event("change"));
    };

    input.onkeydown = (ev) => {
      if (ev.key === "Enter") {
        save();
      }
      if (ev.key === "Escape") {
        displayEl.textContent = originalText;
      }
    };

    input.onblur = () => {
      if (displayEl.contains(input)) save();
    };
  };
}

/**
 * Binds events for custom autocomplete/suggestion logic
 */
function initAutocompleteListeners() {
  const fields = ["lib-search-input", "edit-title", "edit-artist", "edit-category", "edit-tags"];
  
  fields.forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;

    el.addEventListener("focus", () => {
      import('./ui.js').then(m => m.updateSuggestions(el));
    });

    el.addEventListener("input", () => {
      import('./ui.js').then(m => m.updateSuggestions(el));
    });

    el.addEventListener("keydown", (e) => {
      const dropdown = document.getElementById(`${id}-suggestions`);
      if (!dropdown || !dropdown.classList.contains("active")) return;

      const items = dropdown.querySelectorAll(".suggestion-item");
      if (items.length === 0) return;

      let selectedIndex = Array.from(items).findIndex(item => item.classList.contains("selected"));

      if (e.key === "ArrowDown") {
        e.preventDefault();
        if (selectedIndex !== -1) items[selectedIndex].classList.remove("selected");
        selectedIndex = (selectedIndex + 1) % items.length;
        items[selectedIndex].classList.add("selected");
        items[selectedIndex].scrollIntoView({ block: "nearest" });
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        if (selectedIndex !== -1) items[selectedIndex].classList.remove("selected");
        selectedIndex = (selectedIndex - 1 + items.length) % items.length;
        items[selectedIndex].classList.add("selected");
        items[selectedIndex].scrollIntoView({ block: "nearest" });
      } else if (e.key === "Enter" && selectedIndex !== -1) {
        e.preventDefault();
        items[selectedIndex].click();
      } else if (e.key === "Escape") {
        dropdown.classList.remove("active");
      }
    });
  });
}
