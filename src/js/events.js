/**
 * events.js - Event initialization and Tauri listeners
 */

import { state } from './state.js';
import { elements, renderLibrary, updateThumbnailOverlay, updatePlayButton, updateAiModelStatus, updateTaskUI, updateCardStatusBadge, renderDropdownOptions } from './ui.js';
import { formatTime, showNotification } from './utils.js';
import { invoke, listen } from './tauri-bridge.js';
import { selectTrack, highlightTrack, handlePlaybackToggle, updateProgressBar, handleNextTrack, handlePrevTrack } from './player.js';
import { 
  setVolume, setPitch, setTempo, seekTo, saveLibrary, 
  loadLibrary as apiLoadLibrary, getAudioMetadata, getYoutubeMetadata, setVocalBalance, setMasterVolume 
} from './audio.js';
import { ForcedAlignmentViewer } from './alignment-viewer.js';

let alignmentViewer = null;

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
  
  // Sync viewport data-view attribute for CSS selectors
  if (elements.viewport) {
    elements.viewport.setAttribute("data-view", tabId === "alignment" ? "alignment-viewer" : tabId);
  }
  
  if (elements.viewSubtitle) {
    elements.viewSubtitle.textContent = tabId === "tasks" ? "Broadcast Safe 기능을 켜두면 AI 분리 중 연산 속도를 조절하여 방송(OBS) 프레임 드랍을 방지합니다." : "";
    elements.viewSubtitle.style.display = tabId === "tasks" ? "block" : "none";
  }
  
  document.querySelectorAll(".nav-item").forEach(i => {
    i.classList.toggle("active", i.id === `nav-${tabId}`);
  });

  const isMusicTab = (tabId === "library" || tabId === "youtube" || tabId === "local");
  if (elements.youtubeSection) elements.youtubeSection.style.display = tabId === "youtube" ? "block" : "none";
  if (elements.localSection) elements.localSection.style.display = tabId === "local" ? "block" : "none";
  if (elements.libraryControls) elements.libraryControls.style.display = isMusicTab ? "flex" : "none";
  if (elements.viewControls) elements.viewControls.style.display = isMusicTab ? "flex" : "none";
  if (elements.broadcastTasksControl) elements.broadcastTasksControl.style.display = tabId === "tasks" ? "block" : "none";
  
  const settingsPage = document.getElementById("settings-page");
  const tasksPage = document.getElementById("tasks-page");
  if (settingsPage) settingsPage.style.display = tabId === "settings" ? "block" : "none";
  if (tasksPage) tasksPage.style.display = tabId === "tasks" ? "block" : "none";
  
  if (elements.songGrid) {
    elements.songGrid.style.display = isMusicTab ? (state.viewMode === "list" ? "flex" : "grid") : "none";
    elements.songGrid.classList.toggle("list-view", state.viewMode === "list");
    if (isMusicTab) renderLibrary();
  }

  if (tabId === "alignment") {
    elements.viewport?.classList.add("alignment-mode");
    const alignmentPage = document.getElementById("alignment-page");
    if (alignmentPage) alignmentPage.style.display = "block";
    if (!alignmentViewer) {
      alignmentViewer = new ForcedAlignmentViewer("alignment-viewer-root");
      // Using safe bridge
      alignmentViewer.invoke = invoke;
      alignmentViewer.setupListeners();
      alignmentViewer.setupCanvasListeners();
      alignmentViewer.loadTrackList();
      alignmentViewer.loadModelList();
    }
  } else {
    elements.viewport?.classList.remove("alignment-mode");
    const alignmentPage = document.getElementById("alignment-page");
    if (alignmentPage) alignmentPage.style.display = "none";
  }

  if (tabId === "tasks") {
    updateTaskUI();
  }

  // Reset scroll position when switching tabs
  if (elements.scrollArea) {
    elements.scrollArea.scrollTop = 0;
  }
}

function getTabTitle(tabId) {
  const titles = {
    library: "Library",
    youtube: "YouTube",
    local: "My Files",
    settings: "Settings",
    tasks: "Active Tasks",
    alignment: "Lyric Alignment"
  };
  return titles[tabId] || "Live MR Manager";
}

export function initGlobalListeners() {
  // YouTube Fetch
  if (elements.ytFetchBtn && elements.ytUrlInput) {
    elements.ytFetchBtn.onclick = async () => {
      const url = elements.ytUrlInput.value.trim();
      if (!url) return;
      elements.ytFetchBtn.classList.add("loading-btn");
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
        elements.ytFetchBtn.classList.remove("loading-btn");
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

  // Global Keydown Handler (Escape to Close Modals)
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      // 1. Close any active modals
      const activeModal = document.querySelector(".modal-overlay.active");
      if (activeModal) {
        activeModal.classList.remove("active");
      }
      
      // 2. Close active context menu
      if (elements.contextMenu && elements.contextMenu.classList.contains("active")) {
        elements.contextMenu.classList.remove("active");
      }
    }
  });

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

  // Audio Reset (Pitch/Tempo Only)
  if (elements.btnResetAudio) {
    elements.btnResetAudio.onclick = () => {
      if (elements.pitchSlider) {
        elements.pitchSlider.value = 0;
        elements.pitchVal.textContent = "0";
        setPitch(0);
      }
      if (elements.tempoSlider) {
        elements.tempoSlider.value = 1.0;
        elements.tempoVal.textContent = "1.00x";
        setTempo(1.0);
      }
      saveLibrary(state.songLibrary);
    };
  }

  if (elements.tempoVal) {
    setupDirectInput(elements.tempoVal, elements.tempoSlider);
  }

  if (elements.volSlider) {
    elements.volSlider.oninput = (e) => {
      const val = e.target.value;
      if (elements.volSliderVal) elements.volSliderVal.textContent = val;
      setMasterVolume(val);
      state.masterVolume = parseFloat(val);
      localStorage.setItem("masterVolume", val);
    };

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

  if (elements.volSliderVal) {
    setupDirectInput(elements.volSliderVal, elements.volSlider);
  }

  if (elements.editVolume) {
    elements.editVolume.oninput = (e) => {
      const val = e.target.value;
      if (elements.editVolumeVal) elements.editVolumeVal.textContent = val;
      
      // Only apply real-time volume if we are editing the currently playing track
      if (state.currentTrack && state.editingSongIndex !== -1) {
        const songToEdit = state.songLibrary[state.editingSongIndex];
        if (songToEdit && songToEdit.path === state.currentTrack.path) {
          setVolume(val);
        }
      }
    };
    
    // Wheel Interaction for Edit Modal Volume
    elements.editVolume.addEventListener("wheel", (e) => {
      e.preventDefault();
      let val = parseInt(elements.editVolume.value);
      if (e.deltaY < 0) val += 2; else val -= 2;
      val = Math.max(0, Math.min(100, val));
      elements.editVolume.value = val;
      elements.editVolume.dispatchEvent(new Event("input"));
    }, { passive: false });
  }

  if (elements.editVolumeVal) {
    setupDirectInput(elements.editVolumeVal, elements.editVolume);
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
      
      // Show loading spinner immediately for better responsiveness
      state.isLoading = true;
      updateThumbnailOverlay();
      
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
      
      // MR (Instrumental) flag
      const mrCheckbox = document.getElementById("edit-is-mr");
      if (mrCheckbox) {
        song.isMr = mrCheckbox.checked;
      }
      
      // 곡별 볼륨 저장
      const editVolume = document.getElementById("edit-volume");
      if (editVolume) {
        song.volume = parseFloat(editVolume.value);
      }
      
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
  
  // Metadata Search Result Modal Close
  if (elements.searchResultsClose) {
    elements.searchResultsClose.onclick = () => elements.metadataSearchResultsModal.classList.remove("active");
  }

  // 온라인 검색 실행 버튼
  if (elements.btnMetadataSearch) {
    elements.btnMetadataSearch.onclick = async () => {
      const title = document.getElementById("edit-title").value;
      const artist = document.getElementById("edit-artist").value;
      const query = `${title} ${artist}`.trim();
      if (!query) return;

      // 1. 모달 즉시 표시 및 로딩 상태 렌더링
      elements.metadataSearchResultsModal.classList.add("active");
      elements.searchResultsList.innerHTML = `
        <div class="loading-container">
          <div class="spinner"></div>
          <div>온라인에서 곡 정보를 검색 중입니다...</div>
        </div>
      `;

      try {
        // Access invoke from bridge
        const results = await invoke("search_track_metadata", { query });
        
        elements.searchResultsList.innerHTML = "";
        if (results.length === 0) {
          elements.searchResultsList.innerHTML = '<div class="loading-container" style="color: #666;">검색 결과가 없습니다.</div>';
        } else {
          results.forEach(res => {
            const item = document.createElement("div");
            item.className = "search-result-item";
            
            const isUnknownGenre = !res.genre || res.genre.toLowerCase() === "unknown" || res.genre.toLowerCase() === "unknown genre";
            const genreHtml = !isUnknownGenre ? 
              `<div class="track-genre-preview">${res.genre}</div>` : "";
            
            const tagsHtml = res.tags && res.tags.length > 0 ? 
              `<div class="track-tags-preview">${res.tags.map(t => `<span class="tag-badge-mini">${t}</span>`).join("")}</div>` : 
              "";

            item.innerHTML = `
              <div class="search-result-info">
                <div class="track-name">${res.name}</div>
                <div class="artist-name">${res.artist}</div>
                ${genreHtml}
              </div>
              ${tagsHtml}
            `;
            item.onclick = async () => {
              elements.metadataSearchResultsModal.classList.remove("active");
              await finalizeMetadataSelection(res.artist, res.name);
            };
            elements.searchResultsList.appendChild(item);
          });
        }
      } catch (err) {
        elements.searchResultsList.innerHTML = '<div class="loading-container" style="color: var(--accent-red);">검색 중 오류가 발생했습니다.</div>';
        showNotification("검색 중 오류가 발생했습니다.", "error");
      }
    };
  }

  async function finalizeMetadataSelection(artist, track) {
    elements.btnMetadataSearch.classList.add("loading-btn");
    try {
      const metadata = await invoke("fetch_and_process_tags", { artist, track });
      
      document.getElementById("edit-title").value = track;
      document.getElementById("edit-artist").value = artist;
      
      const tagsEl = document.getElementById("edit-tags");
      if (tagsEl) tagsEl.value = metadata.tags.join(", ");
      
      const genreSelect = document.getElementById("edit-genre-select");
      const genreCustom = document.getElementById("edit-genre-custom");
      
      // 장르 매핑 (간소화하여 커스텀 입력기에 결과값 넣기)
      if (genreSelect) genreSelect.value = "etc";
      if (genreCustom) {
        genreCustom.style.display = "block";
        // 'Unknown' 계열의 값은 빈 값으로 처리하여 UI에서 '미분류'로 보이게 함
        const genreVal = (metadata.genre || "").toLowerCase();
        const isUnknown = genreVal === "unknown" || genreVal === "unknown genre" || genreVal === "";
        genreCustom.value = isUnknown ? "" : metadata.genre;
      }
      
      // 드롭다운 텍스트 업데이트
      const dropdown = document.getElementById("edit-genre-dropdown");
      if (dropdown) {
        const selectedText = dropdown.querySelector(".selected-text");
        if (selectedText) selectedText.textContent = "직접 입력 (검색됨)";
      }
      
      showNotification("메타데이터가 업데이트되었습니다.", "success");
    } catch (err) {
      showNotification("태그 정보를 가져오는데 실패했습니다.", "error");
    } finally {
      elements.btnMetadataSearch.classList.remove("loading-btn");
    }
  }

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
    if (e.target.checked) {
      showNotification("가사 기능은 현재 준비 중입니다.", "info");
      e.target.checked = false; // 다시 꺼짐 상태로
      state.lyricsEnabled = false;
      localStorage.setItem("lyricsEnabled", "false");
    } else {
      state.lyricsEnabled = false;
      localStorage.setItem("lyricsEnabled", "false");
    }
    
    const { toggleAiFeature } = await import('./audio.js');
    await toggleAiFeature("lyric", state.lyricsEnabled);
  });

  // BROADCAST MODE Toggle persistence (Settings & Active Tasks UI)
  const syncBroadcastToggles = () => {
    if (elements.toggleBroadcastMode) elements.toggleBroadcastMode.checked = state.broadcastMode;
    if (elements.toggleBroadcastModeActive) elements.toggleBroadcastModeActive.checked = state.broadcastMode;
  };

  const handleBroadcastChange = async (enabled) => {
    state.broadcastMode = enabled;
    localStorage.setItem("broadcastMode", state.broadcastMode);
    syncBroadcastToggles();
    console.log(`[STATE] Broadcast Mode: ${state.broadcastMode}`);
    try {
      await invoke("set_broadcast_mode", { enabled: state.broadcastMode });
      showNotification(state.broadcastMode ? "방송 보호 모드가 활성화되었습니다." : "방송 보호 모드가 해제되었습니다.", "info");
    } catch (err) {
      console.error("Failed to set broadcast mode:", err);
    }
  };

  if (elements.toggleBroadcastMode) {
    elements.toggleBroadcastMode.checked = state.broadcastMode;
    elements.toggleBroadcastMode.addEventListener("change", (e) => handleBroadcastChange(e.target.checked));
  }
  if (elements.toggleBroadcastModeActive) {
    elements.toggleBroadcastModeActive.checked = state.broadcastMode;
    elements.toggleBroadcastModeActive.addEventListener("change", (e) => handleBroadcastChange(e.target.checked));
  }
  
  // Initial Sync to Backend
  invoke("set_broadcast_mode", { enabled: state.broadcastMode }).catch(console.error);

  // Settings Events
  const btnExportBackup = document.getElementById("btn-export-backup");
  const btnImportBackup = document.getElementById("btn-import-backup");

  if (btnExportBackup) {
    btnExportBackup.onclick = async () => {
      try {
        // Access invoke from bridge
        btnExportBackup.disabled = true;
        btnExportBackup.textContent = "백업 중...";
        await invoke("export_backup");
        showNotification("라이브러리 목록이 성공적으로 백업되었습니다.", "success");
      } catch (err) {
        if (err !== "CANCELLED") {
          showNotification("백업 중 오류가 발생했습니다: " + err, "error");
        }
      } finally {
        btnExportBackup.disabled = false;
        btnExportBackup.textContent = "목록 백업";
      }
    };
  }

  if (btnImportBackup) {
    btnImportBackup.onclick = async () => {
      try {
        // Access invoke from bridge
        btnImportBackup.disabled = true;
        btnImportBackup.textContent = "복원 중...";
        await invoke("import_backup");
        
        // Refresh local state and UI
        const { loadLibrary } = await import('./audio.js');
        state.songLibrary = await loadLibrary();
        renderLibrary();
        
        showNotification("백업본에서 없는 곡들을 성공적으로 병합했습니다.", "success");
      } catch (err) {
        if (err !== "CANCELLED") {
          showNotification("복원 중 오류가 발생했습니다: " + err, "error");
        }
      } finally {
        btnImportBackup.disabled = false;
        btnImportBackup.textContent = "목록 복원";
      }
    };
  }

  const btnDownloadModel = document.getElementById("btn-download-model");
  const btnOpenCache = document.getElementById("btn-open-cache");

  if (btnDownloadModel) {
    btnDownloadModel.onclick = async () => {
      try {
        const { updateAiModelStatus } = await import('./ui.js');
        const modelId = await invoke("get_model_settings");
        
        btnDownloadModel.disabled = true;
        btnDownloadModel.textContent = "다운로드 중...";
        
        await invoke("download_ai_model", { modelId: modelId });
        state.isAiModelReady = true;
        updateAiModelStatus(true);
        showNotification("AI 모델 다운로드 및 준비가 완료되었습니다.", "success");
      } catch (err) {
        showNotification("모델 다운로드 실패: " + err, "error");
      } finally {
        btnDownloadModel.disabled = false;
        btnDownloadModel.textContent = "모델 다운로드";
      }
    };
  }

  if (btnOpenCache) {
    btnOpenCache.onclick = async () => {
      try {
        // Access invoke from bridge
        await invoke("open_cache_folder");
      } catch (err) {
        showNotification("폴더 열기 실패: " + err, "error");
      }
    };
  }

  const btnDeleteModel = document.getElementById("btn-delete-model");
  if (btnDeleteModel) {
    btnDeleteModel.onclick = async () => {
      const modelId = await invoke("get_model_settings");
      const modelName = modelId === "kim" ? "Kim Vocal 2" : "Inst HQ 3";

      const confirmTitle = document.getElementById("confirm-title");
      const confirmMsg = document.getElementById("confirm-message");
      const confirmOk = document.getElementById("confirm-ok");
      
      if (confirmTitle) confirmTitle.textContent = "AI 모델 삭제";
      if (confirmMsg) confirmMsg.textContent = `${modelName} 모델 파일을 삭제하시겠습니까?\n삭제 후에는 다시 다운로드해야 분리 기능을 사용할 수 있습니다.`;
      
      if (confirmOk) {
        confirmOk.onclick = async () => {
          try {
            await invoke("delete_ai_model", { modelId: modelId });
            showNotification(`${modelName} 모델이 삭제되었습니다.`, "success");
            elements.confirmModal.classList.remove("active");
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

  // --- AI 모델 선택 드롭다운 처리 ---
  renderDropdownOptions("ai-model-select-dropdown", [
    { val: "kim", text: "Kim Vocal 2 (기본/빠름)" },
    { val: "inst_hq_3", text: "Inst HQ 3 (고품질 반주/MR)" }
  ], async (val) => {
    try {
      await invoke("update_model_settings", { modelId: val });
      const { updateAiModelStatus } = await import('./ui.js');
      
      // 모델 설명 업데이트
      const descEl = document.getElementById("ai-model-desc");
      if (descEl) {
        descEl.textContent = val === "kim" 
          ? "기본 고성능 보컬용 모델입니다. 배경 반주(MR)의 고품질 분리가 필요하다면 Inst HQ 3 모델을 권장합니다."
          : "고품질 MR 추출에 특화된 모델입니다. 보컬 분리보다는 배경 음악을 깔끔하게 추출하는 데 최적화되어 있습니다.";
      }

      // 상태 확인 및 업데이트
      const isReady = await invoke("check_model_ready", { modelId: val });
      state.isAiModelReady = isReady;
      updateAiModelStatus(isReady);
      
      showNotification(`${val === "kim" ? "Kim Vocal 2" : "Inst HQ 3"} 모델로 변경되었습니다.`, "info");
    } catch (err) {
      console.error("Failed to switch model:", err);
    }
  });

  // 초기 모델 상태 동기화
  const syncInitialModel = async () => {
    try {
      const activeModelId = await invoke("get_model_settings").catch(() => "kim");
      const dropdown = document.getElementById("ai-model-select-dropdown");
      if (dropdown) {
        const selectedText = dropdown.querySelector(".selected-text");
        const options = dropdown.querySelectorAll(".option-item");
        options.forEach(opt => {
          opt.classList.toggle("selected", opt.dataset.value === activeModelId);
          if (opt.dataset.value === activeModelId && selectedText) {
            selectedText.textContent = opt.textContent;
          }
        });

        // 설명 업데이트
        const descEl = document.getElementById("ai-model-desc");
        if (descEl) {
          descEl.textContent = activeModelId === "kim" 
            ? "기본 고성능 보컬용 모델입니다. 배경 반주(MR)의 고품질 분리가 필요하다면 Inst HQ 3 모델을 권장합니다."
            : "고품질 MR 추출에 특화된 모델입니다. 보컬 분리보다는 배경 음악을 깔끔하게 추출하는 데 최적화되어 있습니다.";
        }
      }
    } catch (err) {
      console.error("Initial model sync failed:", err);
    }
  };
  
  syncInitialModel();

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
  // --- Library Manager Tab Switching ---
  document.querySelectorAll(".manager-tab-btn").forEach(btn => {
    btn.onclick = () => {
      const tabId = btn.dataset.tab;
      document.querySelectorAll(".manager-tab-btn").forEach(b => b.classList.toggle("active", b === btn));
      document.querySelectorAll(".manager-body").forEach(body => {
        body.classList.toggle("active", body.id === `manager-tab-${tabId}`);
      });
      
      if (tabId === "curation") {
        import('./ui.js').then(m => m.renderCurationTab());
      } else {
        import('./ui.js').then(m => m.renderManagerTable());
      }
    };
  });

  // --- Curation Tab Actions ---
  const btnSaveMapping = document.getElementById("btn-save-mapping");
  const btnRefreshUnmapped = document.getElementById("btn-refresh-unmapped");
  const btnCopyUnmapped = document.getElementById("btn-copy-unmapped");

  if (btnSaveMapping) {
    btnSaveMapping.onclick = async () => {
      const original = document.getElementById("curation-original").value.trim();
      const translated = document.getElementById("curation-translated").value.trim();
      const category = document.getElementById("curation-category").value;

      if (!original || !translated) {
        showNotification("원본과 번역어를 모두 입력하세요.", "error");
        return;
      }

      btnSaveMapping.disabled = true;
      btnSaveMapping.textContent = "저장 중...";
      try {
        // Access invoke from bridge
        await invoke("update_custom_dictionary", { category, original, translated });
        showNotification("사전이 업데이트되었습니다.", "success");
        
        // 시각적 피드백 추가
        btnSaveMapping.classList.add("btn-success");
        btnSaveMapping.textContent = "저장 완료!";
        
        // 폼 초기화
        document.getElementById("curation-original").value = "";
        document.getElementById("curation-translated").value = "";
        
        // 1.5초 후 버튼 상태 복구
        setTimeout(() => {
          btnSaveMapping.classList.remove("btn-success");
          btnSaveMapping.textContent = "사전에 등록";
        }, 1500);

        // 리스트 새로고침
        import('./ui.js').then(m => {
          m.renderCurationTab();
          m.renderLibrary();
        });
      } catch (err) {
        showNotification("저장 실패: " + err, "error");
        btnSaveMapping.textContent = "사전에 등록"; // 오류 시에도 텍스트 복구
      } finally {
        btnSaveMapping.disabled = false;
      }
    };
  }

  if (btnRefreshUnmapped) {
    btnRefreshUnmapped.onclick = () => {
      import('./ui.js').then(m => m.renderCurationTab());
    };
  }

  if (btnCopyUnmapped) {
    btnCopyUnmapped.onclick = async () => {
      try {
        const tagsMap = await invoke("get_unclassified_tags");
        const tags = Object.keys(tagsMap);
        if (tags.length === 0) {
          showNotification("복사할 태그가 없습니다.", "info");
          return;
        }
        const text = tags.join("\n");
        await navigator.clipboard.writeText(text);
        showNotification("미분류 태그 목록이 클립보드에 복사되었습니다.", "success");
      } catch (err) {
        showNotification("복사 실패", "error");
      }
    };
  }
  }
}


export function setupBackendListeners() {
  // listen is imported from tauri-bridge.js
  
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
    const s = (status || "").toLowerCase();
    if (s === "loading" || s === "downloading" || s === "decoding" || s === "pending") {
      state.isLoading = true;
    } else {
      state.isLoading = false;
    }

    // 2. Playback state updates
    if (s === "playing") {
      state.isPlaying = true;
    } else if (s === "finished" || s === "error") {
      state.isPlaying = false;
      if (s === "finished") {
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
      elements.statusMsg.textContent = message || (s === "playing" ? "Ready" : "");
      elements.statusMsg.classList.toggle("active", !!elements.statusMsg.textContent);
      
      // Auto-hide status text after 3s on successful start
      if (s === "playing") {
        setTimeout(() => {
          if (elements.statusMsg.textContent === "Ready" || elements.statusMsg.textContent === message) {
            elements.statusMsg.textContent = "";
            elements.statusMsg.classList.remove("active");
          }
        }, 3000);
      }
    }

    if (s === "error") {
      showNotification(message || "재생 중 오류가 발생했습니다.", "error");
    }

    // Always sync UI
    import('./ui.js').then(m => {
      m.updateThumbnailOverlay();
      m.updatePlayButton();
    });
  });

  listen("separation-progress", (event) => {
    const { path, percentage, status, provider, model } = event.payload;
    
    // 1. Ignore events for paths that were recently cancelled
    if (state.cancelledPaths.has(path)) {
      if (status === "Finished" || status === "Cancelled" || status === "Error") {
        state.cancelledPaths.delete(path);
      }
      return;
    }

    state.activeTasks[path] = { percentage, status, provider, model };
    
    if (status === "Finished" || status === "Cancelled" || status === "Error") {
      // 1. Show final state immediately
      updateTaskUI(path); 
      updateCardStatusBadge(path);
      
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
      updateCardStatusBadge(path);
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

  // Restore active tasks from backend (survives page reload / HMR)
  (async () => {
    try {
      // invoke is imported from tauri-bridge.js
      const activePaths = await invoke("get_active_separations");
      if (activePaths && activePaths.length > 0) {
        activePaths.forEach(path => {
          if (!state.activeTasks[path]) {
            state.activeTasks[path] = { percentage: 0, status: "Processing", provider: "restoring" };
          }
        });
        updateTaskUI();
        renderLibrary();
        console.log(`[App] Restored ${activePaths.length} active task(s) from backend.`);
      }
    } catch (err) {
      console.error("[App] Failed to restore active tasks:", err);
    }
  })();
}

function tempFix_removeOldUpdateTaskUI() {
  // This chunk replaces the old code with nothing (or a comment)
}


window.cancelTask = (el) => {
  // invoke is imported from tauri-bridge.js
  // Get path from data attribute (prevents backslash mangling in HTML)
  const path = typeof el === 'string' ? el : el.dataset.taskPath;
  
  if (!path) return;

  // 1. Immediate UI Feedback & Blacklist
  state.cancelledPaths.add(path); // Block any residual events
  if (state.activeTasks[path]) {
    delete state.activeTasks[path];
  }
  updateTaskUI(); 
  renderLibrary(); // 메인 화면의 딱지 등 상태 업데이트를 위해 추가
  
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
