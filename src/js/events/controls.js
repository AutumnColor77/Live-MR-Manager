/**
 * js/events/controls.js - UI Controls (Sliders, Buttons, Playback)
 */
import { state } from '../state.js';
import { elements } from '../ui/elements.js';
import { invoke } from '../tauri-bridge.js';

export function initControlListeners() {
  // Playback Toggle
  if (elements.togglePlayBtn) {
    elements.togglePlayBtn.onclick = async () => {
      const { handlePlaybackToggle } = await import('../player.js');
      handlePlaybackToggle();
    };
  }

  // Prev/Next
  if (elements.btnPrev) {
    elements.btnPrev.onclick = async () => {
      const { handlePrevTrack } = await import('../player.js');
      handlePrevTrack();
    };
  }
  if (elements.btnNext) {
    elements.btnNext.onclick = async () => {
      const { handleNextTrack } = await import('../player.js');
      handleNextTrack();
    };
  }

  // Sliders with Wheel Support
  if (elements.pitchSlider) {
    elements.pitchSlider.oninput = (e) => {
      const val = e.target.value;
      if (elements.pitchVal) elements.pitchVal.textContent = val > 0 ? `+${val}` : val;
      invoke('set_pitch', { semitones: parseFloat(val) });
    };

    elements.pitchSlider.addEventListener("wheel", (e) => {
      e.preventDefault();
      let val = parseInt(elements.pitchSlider.value);
      if (e.deltaY < 0) val += 1; else val -= 1;
      val = Math.max(-12, Math.min(12, val));
      elements.pitchSlider.value = val;
      elements.pitchSlider.dispatchEvent(new Event("input"));
    }, { passive: false });

    if (elements.pitchVal) setupDirectInput(elements.pitchVal, elements.pitchSlider);
  }

  if (elements.tempoSlider) {
    elements.tempoSlider.oninput = (e) => {
      const val = parseFloat(e.target.value);
      if (elements.tempoVal) elements.tempoVal.textContent = `${val.toFixed(2)}x`;
      invoke('set_tempo', { ratio: val });
    };

    elements.tempoSlider.addEventListener("wheel", (e) => {
      e.preventDefault();
      let val = parseFloat(elements.tempoSlider.value);
      if (e.deltaY < 0) val += 0.05; else val -= 0.05;
      val = Math.max(0.5, Math.min(2.0, val));
      elements.tempoSlider.value = val.toFixed(2);
      elements.tempoSlider.dispatchEvent(new Event("input"));
    }, { passive: false });

    if (elements.tempoVal) setupDirectInput(elements.tempoVal, elements.tempoSlider);
  }

  if (elements.volSlider) {
    elements.volSlider.oninput = (e) => {
      const val = e.target.value;
      if (elements.volSliderVal) elements.volSliderVal.textContent = `${val}%`;
      invoke('set_master_volume', { volume: parseFloat(val) });
      state.masterVolume = parseFloat(val);
      localStorage.setItem("masterVolume", val);
    };

    elements.volSlider.addEventListener("wheel", (e) => {
      e.preventDefault();
      let val = parseInt(elements.volSlider.value);
      if (e.deltaY < 0) val += 2; else val -= 2;
      val = Math.max(0, Math.min(100, val));
      elements.volSlider.value = val;
      elements.volSlider.dispatchEvent(new Event("input"));
    }, { passive: false });

    if (elements.volSliderVal) setupDirectInput(elements.volSliderVal, elements.volSlider);
  }

  // Vocal Balance Control
  if (elements.vocalBalance) {
    elements.vocalBalance.oninput = (e) => {
      const val = e.target.value;
      invoke('set_vocal_balance', { balance: parseFloat(val) });
    };

    elements.vocalBalance.addEventListener("wheel", (e) => {
      e.preventDefault();
      let val = parseInt(elements.vocalBalance.value);
      if (e.deltaY < 0) val += 5; else val -= 5;
      val = Math.max(0, Math.min(100, val));
      elements.vocalBalance.value = val;
      elements.vocalBalance.dispatchEvent(new Event("input"));
    }, { passive: false });
  }

  // Playback Progress (Seek bar)
  if (elements.playbackBar) {
    elements.playbackBar.oninput = (e) => {
      state.isSeeking = true;
      state.currentProgressMs = (parseFloat(e.target.value) / 100) * state.trackDurationMs;
    };
    elements.playbackBar.onchange = async (e) => {
      const { seekTo } = await import('../audio.js');
      const targetMs = (parseFloat(e.target.value) / 100) * state.trackDurationMs;
      await seekTo(targetMs);
    };
  }

  // Reset Audio
  const btnReset = document.getElementById("btn-reset-audio");
  if (btnReset) {
    btnReset.onclick = () => {
       if (elements.pitchSlider) {
         elements.pitchSlider.value = 0;
         elements.pitchSlider.dispatchEvent(new Event("input"));
       }
       if (elements.tempoSlider) {
         elements.tempoSlider.value = 1.0;
         elements.tempoSlider.dispatchEvent(new Event("input"));
       }
       import('../utils.js').then(m => m.showNotification("오디오 설정이 초기화되었습니다.", "info"));
    };
  }

  // View Mode Toggles
  if (elements.viewGridBtn && elements.viewListBtn) {
    const updateViewMode = (mode) => {
      state.viewMode = mode;
      localStorage.setItem("viewMode", mode);
      
      if (elements.viewGridBtn) elements.viewGridBtn.classList.toggle("active", mode === "grid");
      if (elements.viewListBtn) elements.viewListBtn.classList.toggle("active", mode === "list");
      if (elements.viewButtonBtn) elements.viewButtonBtn.classList.toggle("active", mode === "button");

      if (elements.viewport) elements.viewport.setAttribute("data-view-mode", mode);
      
      if (elements.songGrid) {
        elements.songGrid.classList.toggle("list-view", mode === "list");
        elements.songGrid.classList.toggle("button-view", mode === "button");
        elements.songGrid.style.display = (mode === "list") ? "flex" : "grid";
      }
      
      import('../ui/library.js').then(({ renderLibrary }) => renderLibrary());
    };

    if (elements.viewGridBtn) elements.viewGridBtn.onclick = () => updateViewMode("grid");
    if (elements.viewListBtn) elements.viewListBtn.onclick = () => updateViewMode("list");
    if (elements.viewButtonBtn) elements.viewButtonBtn.onclick = () => updateViewMode("button");
  }

  // Global Click / Outside Click
  document.addEventListener("click", (e) => {
    // 1. Context Menu Close
    if (elements.contextMenu && (elements.contextMenu.classList.contains("active") || elements.contextMenu.style.display === 'flex')) {
      if (!e.target.closest("#context-menu")) {
        elements.contextMenu.classList.remove("active");
        elements.contextMenu.style.display = 'none';
      }
    }

    // 2. Custom Select Toggle & Option Choice
    const customSelect = e.target.closest(".custom-select");
    if (customSelect) {
      const optionItem = e.target.closest(".option-item");
      if (optionItem) {
        // Handle Option Choice
        const value = optionItem.dataset.value;
        const hiddenInput = customSelect.querySelector("input[type='hidden']");
        const selectedText = customSelect.querySelector(".selected-text");
        
        if (hiddenInput) {
          hiddenInput.value = value;
          hiddenInput.dispatchEvent(new Event("input"));
          hiddenInput.dispatchEvent(new Event("change"));
        }
        
        if (selectedText) {
          selectedText.textContent = optionItem.textContent;
        }
        
        customSelect.querySelectorAll(".option-item").forEach(opt => opt.classList.remove("selected"));
        optionItem.classList.add("selected");
        
        customSelect.classList.remove("active");
      } else {
        // Toggle Dropdown
        const isCurrentlyActive = customSelect.classList.contains("active");
        document.querySelectorAll(".custom-select").forEach(el => el.classList.remove("active"));
        if (!isCurrentlyActive) {
          customSelect.classList.add("active");
        }
      }
    } else {
      // Click outside custom select: close all
      document.querySelectorAll(".custom-select").forEach(el => el.classList.remove("active"));
    }

    // 3. Deselect card when clicking outside
    const card = e.target.closest(".song-card");
    const dock = e.target.closest(".control-dock");
    const modal = e.target.closest(".modal-content");
    
    if (!card && !dock && !modal && !customSelect) {
      if (state.selectedTrackIndex !== -1) {
        state.selectedTrackIndex = -1;
        import('../ui/components.js').then(({ updateThumbnailOverlay }) => updateThumbnailOverlay());
      }
    }
  });

  // YouTube Fetch
  if (elements.ytFetchBtn && elements.ytUrlInput) {
    elements.ytFetchBtn.onclick = async () => {
      const url = elements.ytUrlInput.value.trim();
      if (!url) return;
      elements.ytFetchBtn.classList.add("loading-btn");
      try {
        const { getAudioMetadata, saveLibrary } = await import('../audio.js');
        const metadata = await getAudioMetadata(url);
        state.library.push(metadata);
        await saveLibrary(state.library);
        elements.ytUrlInput.value = "";
        const { showNotification } = await import('../utils.js');
        showNotification("추가되었습니다.", "success");
        const { renderLibrary } = await import('../ui/library.js');
        renderLibrary();
      } catch (err) {
        const { showNotification } = await import('../utils.js');
        showNotification("정보를 가져오는데 실패했습니다.", "error");
      } finally {
        elements.ytFetchBtn.classList.remove("loading-btn");
      }
    };
    
    // Support Enter key on URL input
    elements.ytUrlInput.onkeydown = (e) => {
      if (e.key === "Enter") elements.ytFetchBtn.click();
    };
  }

  // Rescue Button
  const btnRunRescue = document.getElementById("btn-run-rescue");
  if (btnRunRescue) {
    btnRunRescue.onclick = async () => {
      btnRunRescue.disabled = true;
      btnRunRescue.textContent = "복구 중...";
      try {
        const count = await invoke('run_cache_rescue');
        const { showNotification } = await import('../utils.js');
        if (count > 0) {
          showNotification(`성공적으로 ${count}곡을 복구했습니다.`, "success");
          const { loadLibrary } = await import('../audio.js');
          state.library = await loadLibrary() || [];
          const { renderLibrary } = await import('../ui/library.js');
          renderLibrary();
        } else {
          showNotification("복구할 새로운 곡이 없습니다.", "info");
        }
      } catch (err) {
        const { showNotification } = await import('../utils.js');
        showNotification("복구 중 오류가 발생했습니다.", "error");
        console.error(err);
      } finally {
        btnRunRescue.disabled = false;
        btnRunRescue.textContent = "목록 자동 복구";
      }
    };
  }

  // AI Toggles
  if (elements.toggleVocal) {
    elements.toggleVocal.onchange = async (e) => {
      const isEnabled = e.target.checked;
      const { toggleAiFeature } = await import('../audio.js');
      state.vocalEnabled = isEnabled;
      localStorage.setItem("vocalEnabled", isEnabled);
      await toggleAiFeature("vocal", isEnabled);
      // No need to call updateAiTogglesState here as the browser already toggled the checkbox
    };
  }
  if (elements.toggleLyric) {
    elements.toggleLyric.onchange = async (e) => {
      const isEnabled = e.target.checked;
      state.lyricsEnabled = isEnabled;
      localStorage.setItem("lyricsEnabled", isEnabled);
      // Logic for lyrics display would go here
    };
  }

  // Global Keydown Handler (Escape to Close Modals)
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      // 1. Close any active modals
      const activeModal = document.querySelector(".modal-overlay.active");
      if (activeModal) activeModal.classList.remove("active");
      
      // 2. Close active context menu
      if (elements.contextMenu && elements.contextMenu.classList.contains("active")) {
        elements.contextMenu.classList.remove("active");
        elements.contextMenu.style.display = 'none';
      }
    }
  });

  // Filter Input Listeners
  if (elements.libSearchInput) {
    elements.libSearchInput.addEventListener("input", () => {
      import('../ui/library.js').then(({ renderLibrary }) => renderLibrary());
    });
  }
  if (elements.libGenreFilter) {
    elements.libGenreFilter.addEventListener("change", () => {
      import('../ui/library.js').then(({ renderLibrary }) => renderLibrary());
    });
  }
  if (elements.libCategoryFilter) {
    elements.libCategoryFilter.addEventListener("change", () => {
      import('../ui/library.js').then(({ renderLibrary }) => renderLibrary());
    });
  }
  if (elements.libSortSelect) {
    elements.libSortSelect.addEventListener("change", () => {
      import('../ui/library.js').then(({ renderLibrary }) => renderLibrary());
    });
  }

  // Settings Page Listeners
  if (elements.btnExportBackup) {
    elements.btnExportBackup.onclick = async () => {
      const { exportBackup } = await import('../audio.js');
      await exportBackup();
    };
  }
  if (elements.btnImportBackup) {
    elements.btnImportBackup.onclick = async () => {
      const { importBackup } = await import('../audio.js');
      await importBackup();
    };
  }
  if (elements.btnRunRescue) {
    elements.btnRunRescue.onclick = async () => {
      const { runCacheRescue, loadLibrary } = await import('../audio.js');
      const { showNotification } = await import('../utils.js');
      const { renderLibrary } = await import('../ui/library.js');
      
      showNotification("데이터 복구를 시작합니다. 유튜브 곡의 경우 시간이 소요될 수 있습니다.", "info");
      elements.btnRunRescue.classList.add("loading-btn");
      
      try {
        const count = await runCacheRescue();
        showNotification(`${count}곡의 데이터를 성공적으로 복구했습니다.`, "success");
        state.library = await loadLibrary() || [];
        renderLibrary();
      } catch (err) {
        showNotification("복구 중 오류가 발생했습니다: " + err, "error");
      } finally {
        elements.btnRunRescue.classList.remove("loading-btn");
      }
    };
  }

  if (elements.toggleBroadcastMode) {
    elements.toggleBroadcastMode.onchange = async (e) => {
      const { setBroadcastMode } = await import('../audio.js');
      await setBroadcastMode(e.target.checked);
    };
    // Initialize state
    elements.toggleBroadcastMode.checked = state.broadcastMode;
  }
  const btnOpenCache = document.getElementById("btn-open-cache");
  if (btnOpenCache) {
    btnOpenCache.onclick = async () => {
      const { openCacheFolder } = await import('../audio.js');
      await openCacheFolder();
    };
  }

  // AI Model Selection & Actions
  const aiModelSelect = document.getElementById("ai-model-select-dropdown");
  if (aiModelSelect) {
    aiModelSelect.addEventListener("change", async (e) => {
      const modelId = e.target.value;
      await invoke("update_model_settings", { modelId });
      const { checkAiModelStatus } = await import('../audio.js');
      const { updateAiModelStatus } = await import('../ui/components.js');
      const isReady = await checkAiModelStatus();
      updateAiModelStatus(isReady);
    });
  }

  if (elements.btnDownloadModel) {
    elements.btnDownloadModel.onclick = async () => {
      try {
        const modelId = await invoke("get_model_settings");
        const { downloadAiModel, checkAiModelStatus } = await import('../audio.js');
        const { updateAiModelStatus } = await import('../ui/components.js');
        
        elements.btnDownloadModel.classList.add("loading-btn");
        await downloadAiModel(modelId);
        const isReady = await checkAiModelStatus();
        updateAiModelStatus(isReady);
        import('../utils.js').then(m => m.showNotification("모델 다운로드 완료", "success"));
      } catch (err) {
        import('../utils.js').then(m => m.showNotification("다운로드 실패: " + err, "error"));
      } finally {
        elements.btnDownloadModel.classList.remove("loading-btn");
      }
    };
  }

  if (elements.btnDeleteModel) {
    elements.btnDeleteModel.onclick = async () => {
      try {
        const modelId = await invoke("get_model_settings");
        const { deleteAiModel, checkAiModelStatus } = await import('../audio.js');
        const { updateAiModelStatus } = await import('../ui/components.js');
        
        await deleteAiModel(modelId);
        const isReady = await checkAiModelStatus();
        updateAiModelStatus(isReady);
        import('../utils.js').then(m => m.showNotification("모델이 삭제되었습니다.", "info"));
      } catch (err) {
        import('../utils.js').then(m => m.showNotification("삭제 실패", "error"));
      }
    };
  }
}

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
    };

    input.onkeydown = (ev) => {
      if (ev.key === "Enter") save();
      if (ev.key === "Escape") displayEl.textContent = originalText;
    };

    input.onblur = () => {
      if (displayEl.contains(input)) save();
    };
  };
}
