/**
 * js/events/controls.js - UI Controls (Sliders, Buttons, Playback)
 */
import { state } from '../state.js';
import { elements } from '../ui/elements.js';
import { invoke } from '../tauri-bridge.js';

let audioSettingsSaveTimer = null;

function isTextEditableTarget(target) {
  if (!target || !(target instanceof Element)) return false;
  const editable = target.closest("input, textarea, [contenteditable='true']");
  if (!editable) return false;
  if (editable instanceof HTMLInputElement) {
    const unsupportedTypes = new Set(["checkbox", "radio", "button", "submit", "reset", "range", "file", "image", "color"]);
    return !unsupportedTypes.has((editable.type || "").toLowerCase());
  }
  return true;
}

function setMenuItemState(item, enabled) {
  if (!item) return;
  item.classList.toggle("disabled", !enabled);
}

async function runInputAction(action, editable) {
  editable?.focus?.();
  switch (action) {
    case "undo":
      document.execCommand("undo");
      return;
    case "redo":
      document.execCommand("redo");
      return;
    case "cut":
      document.execCommand("cut");
      return;
    case "copy":
      document.execCommand("copy");
      return;
    case "paste": {
      const text = await navigator.clipboard.readText();
      if (editable instanceof HTMLInputElement || editable instanceof HTMLTextAreaElement) {
        const start = editable.selectionStart ?? editable.value.length;
        const end = editable.selectionEnd ?? editable.value.length;
        editable.setRangeText(text, start, end, "end");
        editable.dispatchEvent(new Event("input", { bubbles: true }));
      } else if (editable?.isContentEditable) {
        document.execCommand("insertText", false, text);
      }
      return;
    }
    case "selectAll":
      if (editable instanceof HTMLInputElement || editable instanceof HTMLTextAreaElement) {
        editable.select();
      } else if (editable?.isContentEditable) {
        const selection = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(editable);
        selection?.removeAllRanges();
        selection?.addRange(range);
      }
      return;
    default:
      return;
  }
}

function showInputContextMenu(event, editable) {
  if (!elements.contextMenu) return;

  const songMenuIds = ["menu-play", "menu-lyrics-view", "menu-separate", "menu-delete-mr", "menu-edit", "menu-delete"];
  const inputMenuIds = [
    "menu-input-separator",
    "menu-undo",
    "menu-redo",
    "menu-cut",
    "menu-copy",
    "menu-paste",
    "menu-select-all",
  ];

  songMenuIds.forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.style.display = "none";
  });
  inputMenuIds.forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.style.display = id === "menu-input-separator" ? "block" : "block";
  });

  const menuUndo = document.getElementById("menu-undo");
  const menuRedo = document.getElementById("menu-redo");
  const menuCut = document.getElementById("menu-cut");
  const menuCopy = document.getElementById("menu-copy");
  const menuPaste = document.getElementById("menu-paste");
  const menuSelectAll = document.getElementById("menu-select-all");

  const hasValue = (editable.value?.length ?? editable.textContent?.length ?? 0) > 0;
  const hasSelection =
    editable instanceof HTMLInputElement || editable instanceof HTMLTextAreaElement
      ? (editable.selectionStart ?? 0) !== (editable.selectionEnd ?? 0)
      : !!window.getSelection()?.toString();
  const readOnly = !!editable.readOnly || editable.getAttribute?.("contenteditable") === "false";

  setMenuItemState(menuUndo, !readOnly);
  setMenuItemState(menuRedo, !readOnly);
  setMenuItemState(menuCut, !readOnly && hasSelection);
  setMenuItemState(menuCopy, hasSelection);
  setMenuItemState(menuPaste, !readOnly);
  setMenuItemState(menuSelectAll, hasValue);

  const bindAction = (el, action) => {
    if (!el) return;
    el.onclick = async () => {
      if (el.classList.contains("disabled")) return;
      const { showNotification } = await import("../utils.js");
      try {
        await runInputAction(action, editable);
      } catch (err) {
        if (action === "paste") {
          showNotification("붙여넣기에 실패했습니다. (클립보드 접근 권한 확인)", "warning");
        }
      } finally {
        elements.contextMenu.classList.remove("active");
        elements.contextMenu.style.display = "none";
      }
    };
  };

  bindAction(menuUndo, "undo");
  bindAction(menuRedo, "redo");
  bindAction(menuCut, "cut");
  bindAction(menuCopy, "copy");
  bindAction(menuPaste, "paste");
  bindAction(menuSelectAll, "selectAll");

  const menuWidth = 200;
  const menuHeight = 260;
  let x = event.clientX;
  let y = event.clientY;
  const winW = window.innerWidth;
  const winH = window.innerHeight;
  if (x + menuWidth > winW) x = winW - menuWidth - 10;
  if (y + menuHeight > winH) y = winH - menuHeight - 10;
  if (x < 10) x = 10;
  if (y < 10) y = 10;

  elements.contextMenu.style.top = `${y}px`;
  elements.contextMenu.style.left = `${x}px`;
  elements.contextMenu.style.display = "flex";
  elements.contextMenu.classList.add("active");
}

function persistCurrentTrackAudioSettings(partial) {
  const currentPath = state.currentTrack?.path;
  if (!currentPath) return;

  const song = state.songLibrary.find((s) => s.path === currentPath);
  if (!song) return;

  Object.assign(song, partial);
  Object.assign(state.currentTrack, partial);

  if (audioSettingsSaveTimer) {
    clearTimeout(audioSettingsSaveTimer);
  }
  audioSettingsSaveTimer = setTimeout(async () => {
    try {
      const { saveLibrary } = await import('../audio.js');
      await saveLibrary(state.songLibrary);
    } catch (err) {
      console.error("Failed to persist per-track audio settings:", err);
    }
  }, 300);
}

export function initControlListeners() {
  document.addEventListener("contextmenu", (e) => {
    if (!isTextEditableTarget(e.target)) return;
    e.preventDefault();
    const editable = e.target.closest("input, textarea, [contenteditable='true']");
    showInputContextMenu(e, editable);
  });

  // Playback Toggle
  if (elements.togglePlayBtn) {
    elements.togglePlayBtn.onclick = async () => {
      const { handlePlaybackToggle } = await import('../player.js');
      handlePlaybackToggle();
    };
  }
  if (elements.dockThumb) {
    elements.dockThumb.onclick = async () => {
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
      const val = Number.parseFloat(e.target.value);
      if (elements.pitchVal) elements.pitchVal.textContent = val > 0 ? `+${val}` : val;
      invoke('set_pitch', { semitones: val });
      persistCurrentTrackAudioSettings({ pitch: val });
    };

    elements.pitchSlider.addEventListener("wheel", (e) => {
      e.preventDefault();
      let val = Number.parseFloat(elements.pitchSlider.value);
      const min = Number.parseFloat(elements.pitchSlider.min || "-12");
      const max = Number.parseFloat(elements.pitchSlider.max || "12");
      if (e.deltaY < 0) val += 1; else val -= 1;
      val = Math.max(min, Math.min(max, val));
      elements.pitchSlider.value = String(Math.round(val));
      elements.pitchSlider.dispatchEvent(new Event("input"));
    }, { passive: false });
    elements.pitchSlider.addEventListener("auxclick", (e) => {
      if (e.button !== 1) return;
      e.preventDefault();
      elements.pitchSlider.value = "0";
      elements.pitchSlider.dispatchEvent(new Event("input"));
    });

    if (elements.pitchVal) setupDirectInput(elements.pitchVal, elements.pitchSlider);
  }

  if (elements.tempoSlider) {
    elements.tempoSlider.oninput = (e) => {
      const val = parseFloat(e.target.value);
      if (elements.tempoVal) elements.tempoVal.textContent = `${val.toFixed(2)}x`;
      invoke('set_tempo', { ratio: val });
      persistCurrentTrackAudioSettings({ tempo: val });
    };

    elements.tempoSlider.addEventListener("wheel", (e) => {
      e.preventDefault();
      let val = parseFloat(elements.tempoSlider.value);
      const min = Number.parseFloat(elements.tempoSlider.min || "0.5");
      const max = Number.parseFloat(elements.tempoSlider.max || "2.0");
      if (e.deltaY < 0) val += 0.05; else val -= 0.05;
      val = Math.max(min, Math.min(max, val));
      elements.tempoSlider.value = val.toFixed(2);
      elements.tempoSlider.dispatchEvent(new Event("input"));
    }, { passive: false });
    elements.tempoSlider.addEventListener("auxclick", (e) => {
      if (e.button !== 1) return;
      e.preventDefault();
      elements.tempoSlider.value = "1.00";
      elements.tempoSlider.dispatchEvent(new Event("input"));
    });

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
      let val = Number.parseFloat(elements.volSlider.value);
      const min = Number.parseFloat(elements.volSlider.min || "0");
      const max = Number.parseFloat(elements.volSlider.max || "120");
      if (e.deltaY < 0) val += 2; else val -= 2;
      val = Math.max(min, Math.min(max, val));
      elements.volSlider.value = String(Math.round(val));
      elements.volSlider.dispatchEvent(new Event("input"));
    }, { passive: false });
    elements.volSlider.addEventListener("auxclick", (e) => {
      if (e.button !== 1) return;
      e.preventDefault();
      elements.volSlider.value = "100";
      elements.volSlider.dispatchEvent(new Event("input"));
    });

    if (elements.volSliderVal) setupDirectInput(elements.volSliderVal, elements.volSlider);
  }

  // Vocal Balance Control (Popover Logic)
  const labelVocal = document.getElementById("label-vocal-balance");
  const popoverVocal = document.getElementById("popover-vocal-balance");
  const vocalBalanceVal = document.getElementById("vocal-balance-val");

  if (labelVocal && popoverVocal) {
    labelVocal.onclick = (e) => {
      e.stopPropagation();
      // Only show popover if vocal toggle is enabled (per user request)
      if (elements.toggleVocal && elements.toggleVocal.disabled) return;
      popoverVocal.classList.toggle("active");
    };
  }

  if (elements.vocalBalance) {
    elements.vocalBalance.oninput = (e) => {
      const val = e.target.value;
      if (vocalBalanceVal) vocalBalanceVal.textContent = `${val}%`;
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
      const { updateThumbnailOverlay } = await import('../ui/components.js');
      
      const targetMs = (parseFloat(e.target.value) / 100) * state.trackDurationMs;
      state.targetProgressMs = targetMs;
      state.currentProgressMs = targetMs;
      
      state.isLoading = true;
      updateThumbnailOverlay();

      try {
        await seekTo(targetMs);
      } catch (err) {
        console.error("Seek failed:", err);
      } finally {
        state.isSeeking = false;
        // isLoading will be updated by playback-status event from backend, 
        // but we can force an update here just in case.
        state.isLoading = false; 
        updateThumbnailOverlay();
      }
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
  const updateViewMode = (mode) => {
    state.viewMode = mode;
    localStorage.setItem("viewMode", mode);
    
    if (elements.viewGridBtn) elements.viewGridBtn.classList.toggle("active", mode === "grid");
    if (elements.viewListBtn) elements.viewListBtn.classList.toggle("active", mode === "list");
    if (elements.viewButtonBtn) elements.viewButtonBtn.classList.toggle("active", mode === "button");

    if (elements.viewport) elements.viewport.setAttribute("data-view-mode", mode);
    
    if (elements.songGrid) {
      elements.songGrid.classList.remove("grid-mode", "list-mode", "button-mode");
      elements.songGrid.classList.add(`${mode}-mode`);
      // Force display: grid for grid/button, flex for list
      elements.songGrid.style.display = (mode === "list") ? "flex" : "grid";
    }
    
    import('../ui/library.js').then(({ renderLibrary }) => renderLibrary());
  };

  if (elements.viewGridBtn && elements.viewListBtn) {
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

    // 4. Close Vocal Balance Popover on outside click
    const vocalItem = e.target.closest(".vocal-item");
    if (!vocalItem) {
      const popover = document.getElementById("popover-vocal-balance");
      if (popover) popover.classList.remove("active");
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
    const extractYoutubeVideoId = (raw) => {
      if (!raw || typeof raw !== "string") return null;
      try {
        const parsed = new URL(raw.trim());
        const host = parsed.hostname.replace(/^www\./, "").toLowerCase();
        if (host === "youtu.be") {
          return parsed.pathname.split("/").filter(Boolean)[0] || null;
        }
        if (host.endsWith("youtube.com")) {
          if (parsed.pathname === "/watch") {
            return parsed.searchParams.get("v");
          }
          if (parsed.pathname.startsWith("/shorts/") || parsed.pathname.startsWith("/embed/")) {
            return parsed.pathname.split("/").filter(Boolean)[1] || null;
          }
        }
      } catch (_) {
        // Non-URL or invalid URL, fallback below
      }
      return null;
    };

    const normalizeYoutubeKey = (raw) => {
      const videoId = extractYoutubeVideoId(raw);
      if (videoId) return `yt:${videoId}`;
      return String(raw || "").trim().toLowerCase();
    };

    const isDuplicateYoutubeTrack = (requestedUrl, metadata) => {
      const candidateKeys = new Set([
        normalizeYoutubeKey(requestedUrl),
        normalizeYoutubeKey(metadata?.path),
      ]);

      return (state.songLibrary || []).some((song) => {
        if (!song) return false;
        if (metadata?.path && song.path === metadata.path) return true;

        const songKey = normalizeYoutubeKey(song.path);
        if (candidateKeys.has(songKey)) return true;

        return false;
      });
    };

    elements.ytFetchBtn.onclick = async () => {
      const url = elements.ytUrlInput.value.trim();
      if (!url) return;
      elements.ytFetchBtn.classList.add("loading-btn");
      elements.ytFetchBtn.disabled = true;
      try {
        const { getAudioMetadata, saveLibrary } = await import('../audio.js');
        const metadata = await getAudioMetadata(url);

        const { showNotification } = await import('../utils.js');
        if (isDuplicateYoutubeTrack(url, metadata)) {
          showNotification("이미 등록된 곡입니다.", "warning");
          return;
        }

        state.songLibrary.push(metadata);
        await saveLibrary(state.songLibrary);
        elements.ytUrlInput.value = "";
        showNotification("추가되었습니다.", "success");
        const { renderLibrary } = await import('../ui/library.js');
        renderLibrary();
      } catch (err) {
        const { showNotification } = await import('../utils.js');
        showNotification("정보를 가져오는데 실패했습니다.", "error");
      } finally {
        elements.ytFetchBtn.classList.remove("loading-btn");
        elements.ytFetchBtn.disabled = false;
      }
    };
    
    // Support Enter key on URL input
    elements.ytUrlInput.onkeydown = (e) => {
      if (e.key === "Enter") elements.ytFetchBtn.click();
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
      const enabled = e.target.checked;
      state.lyricsEnabled = enabled;
      localStorage.setItem("lyricsEnabled", enabled);
      
      const { toggleAiFeature } = await import('../audio.js');
      await toggleAiFeature("lyric", enabled);

      // Sync with Lyric Drawer
      if (enabled) {
        if (typeof window.openLyricDrawer === 'function') window.openLyricDrawer();
      } else {
        if (typeof window.closeLyricDrawer === 'function') window.closeLyricDrawer();
      }
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
      const { showNotification } = await import('../utils.js');
      try {
        await invoke("export_backup");
        showNotification("라이브러리 목록이 성공적으로 백업되었습니다.", "success");
      } catch (err) {
        if (err !== "CANCELLED") {
          showNotification("백업 중 오류가 발생했습니다: " + err, "error");
        }
      }
    };
  }
  if (elements.btnImportBackup) {
    elements.btnImportBackup.onclick = async () => {
      const { showNotification } = await import('../utils.js');
      try {
        await invoke("import_backup");
        const { loadLibrary } = await import('../audio.js');
        const { renderLibrary } = await import('../ui/library.js');
        state.songLibrary = await loadLibrary() || [];
        renderLibrary();
        showNotification("백업본에서 없는 곡들을 성공적으로 병합했습니다.", "success");
      } catch (err) {
        if (err !== "CANCELLED") {
          showNotification("복원 중 오류가 발생했습니다: " + err, "error");
        }
      }
    };
  }
  if (elements.btnRunRescue) {
    elements.btnRunRescue.onclick = async () => {
      const { showNotification } = await import('../utils.js');
      const { renderLibrary } = await import('../ui/library.js');
      
      showNotification("데이터 복구를 시작합니다. 유튜브 곡의 경우 시간이 소요될 수 있습니다.", "info");
      elements.btnRunRescue.classList.add("loading-btn");
      
      try {
        // This command may be unavailable on some builds; surface a clear error.
        const result = await invoke("run_cache_rescue");
        const { loadLibrary } = await import('../audio.js');
        const stats = typeof result === "number"
          ? { scanned: result, recovered: result, failed: 0 }
          : {
              scanned: Number(result?.scanned || 0),
              recovered: Number(result?.recovered || 0),
              failed: Number(result?.failed || 0),
            };
        showNotification(
          `복구 완료: 스캔 ${stats.scanned}곡 / 복구 ${stats.recovered}곡 / 실패 ${stats.failed}곡`,
          stats.failed > 0 ? "warning" : "success"
        );
        state.songLibrary = await loadLibrary() || [];
        renderLibrary();
      } catch (err) {
        showNotification("복구 중 오류가 발생했습니다: " + err, "error");
      } finally {
        elements.btnRunRescue.classList.remove("loading-btn");
      }
    };
  }

  if (elements.themeModeSelect) {
    const syncThemeToUi = (mode) => {
      const dropdown = document.getElementById("theme-mode-dropdown");
      if (!dropdown) return;
      const selectedText = dropdown.querySelector(".selected-text");
      const options = dropdown.querySelectorAll(".option-item");
      options.forEach((opt) => {
        const selected = opt.dataset.value === mode;
        opt.classList.toggle("selected", selected);
        if (selected && selectedText) selectedText.textContent = opt.textContent;
      });
    };

    const initialMode = state.themeMode || localStorage.getItem("themeMode") || "dark";
    elements.themeModeSelect.value = initialMode;
    syncThemeToUi(initialMode);

    elements.themeModeSelect.addEventListener("change", async (e) => {
      const allowedThemes = new Set(["dark", "light", "pink", "sky"]);
      const mode = allowedThemes.has(e.target.value) ? e.target.value : "dark";
      const applyTheme = window.applyAppTheme;
      if (typeof applyTheme === "function") {
        applyTheme(mode, { persist: true });
      } else {
        document.documentElement.setAttribute("data-theme", mode);
        localStorage.setItem("themeMode", mode);
      }
      state.themeMode = mode;
      syncThemeToUi(mode);
      if (typeof syncAllOverlayStylesToBackend === "function") {
        syncAllOverlayStylesToBackend();
      }
    });
  }

  const syncBroadcastModeToggles = (enabled) => {
    state.broadcastMode = !!enabled;
    localStorage.setItem("broadcastMode", String(!!enabled));
    if (elements.toggleBroadcastMode) elements.toggleBroadcastMode.checked = !!enabled;
    if (elements.toggleBroadcastModeActive) elements.toggleBroadcastModeActive.checked = !!enabled;
  };

  const applyBroadcastMode = async (enabled) => {
    try {
      await invoke("set_broadcast_mode", { enabled: !!enabled });
      syncBroadcastModeToggles(enabled);
    } catch (err) {
      syncBroadcastModeToggles(state.broadcastMode);
      const { showNotification } = await import('../utils.js');
      showNotification("방송 제원 보호 모드 변경 실패: " + err, "error");
    }
  };

  if (elements.toggleBroadcastMode) {
    elements.toggleBroadcastMode.onchange = (e) => applyBroadcastMode(e.target.checked);
  }
  if (elements.toggleBroadcastModeActive) {
    elements.toggleBroadcastModeActive.onchange = (e) => applyBroadcastMode(e.target.checked);
  }
  // Initialize both toggle UIs from persisted state
  syncBroadcastModeToggles(state.broadcastMode);
  const btnOpenCache = document.getElementById("btn-open-cache");
  if (btnOpenCache) {
    btnOpenCache.onclick = async () => {
      await invoke("open_cache_folder");
    };
  }

  // AI Model Selection & Actions
  const aiModelSelect = document.getElementById("ai-model-select-dropdown");
  const aiModelDesc = document.getElementById("ai-model-desc");
  const modelDescMap = {
    kim: "기본 고성능 보컬용 모델입니다. 배경 반주(MR)의 고품질 분리가 필요하다면 Inst HQ 3 모델을 권장합니다.",
    inst_hq_3: "고품질 MR 추출에 특화된 모델입니다. 보컬 분리보다는 배경 음악을 깔끔하게 추출하는 데 최적화되어 있습니다.",
  };

  const hasPendingSeparations = async () => {
    const localActive = Object.values(state.activeTasks || {}).some((task) => {
      const s = String(task?.status || "").toLowerCase();
      const done =
        s === "finished" ||
        s === "cancelled" ||
        s === "error" ||
        s.startsWith("error:") ||
        s.includes("cancel");
      return !done;
    });
    if (localActive) return true;
    try {
      const activePaths = await invoke("get_active_separations");
      return Array.isArray(activePaths) && activePaths.length > 0;
    } catch (_) {
      return localActive;
    }
  };

  const refreshModelUiState = async (modelId) => {
    const { updateAiModelStatus } = await import('../ui/components.js');
    const isReady = await invoke("check_model_ready", { modelId });
    updateAiModelStatus(isReady);
  };

  if (aiModelSelect) {
    aiModelSelect.addEventListener("click", async (e) => {
      const option = e.target.closest(".option-item");
      if (!option) return;
      const modelId = option.dataset.value;
      if (!modelId) return;

      try {
        await invoke("update_model_settings", { modelId });
        if (aiModelDesc && modelDescMap[modelId]) {
          aiModelDesc.textContent = modelDescMap[modelId];
        }
        await refreshModelUiState(modelId);
        const { showNotification } = await import('../utils.js');
        showNotification(modelId === "kim" ? "Kim Vocal 2 모델로 변경되었습니다." : "Inst HQ 3 모델로 변경되었습니다.", "info");
      } catch (err) {
        const { showNotification } = await import('../utils.js');
        showNotification("모델 변경 실패: " + err, "error");
      }
    });
  }

  if (elements.btnDownloadModel) {
    elements.btnDownloadModel.onclick = async () => {
      try {
        const modelId = await invoke("get_model_settings");
        elements.btnDownloadModel.classList.add("loading-btn");
        elements.btnDownloadModel.disabled = true;
        await invoke("download_ai_model", { modelId });
        await refreshModelUiState(modelId);
        import('../utils.js').then(m => m.showNotification("모델 다운로드 완료", "success"));
      } catch (err) {
        import('../utils.js').then(m => m.showNotification("다운로드 실패: " + err, "error"));
      } finally {
        elements.btnDownloadModel.classList.remove("loading-btn");
        elements.btnDownloadModel.disabled = false;
      }
    };
  }

  if (elements.btnDeleteModel) {
    elements.btnDeleteModel.onclick = async () => {
      try {
        if (await hasPendingSeparations()) {
          const { showNotification } = await import('../utils.js');
          showNotification("분리 작업(진행/대기열)이 있는 동안에는 모델을 삭제할 수 없습니다.", "warning");
          return;
        }

        const modelId = await invoke("get_model_settings");
        elements.btnDeleteModel.disabled = true;
        await invoke("delete_ai_model", { modelId });
        await refreshModelUiState(modelId);
        import('../utils.js').then(m => m.showNotification("모델이 삭제되었습니다.", "info"));
      } catch (err) {
        import('../utils.js').then(m => m.showNotification("삭제 실패: " + err, "error"));
      } finally {
        elements.btnDeleteModel.disabled = false;
      }
    };
  }

  // Initialize View Mode on Load (Fixes breakage on refresh)
  if (updateViewMode) {
    updateViewMode(state.viewMode || "grid");
  }

  // Overlay Customization Controls
  const overlayScale = document.getElementById('overlay-scale');
  const overlayScaleVal = document.getElementById('overlay-scale-val');
  const overlayFont = document.getElementById('overlay-font');
  const overlayColor = document.getElementById('overlay-color');
  const overlayTextColor = document.getElementById('overlay-text-color');
  const overlayBgOpacity = document.getElementById('overlay-bg-opacity');
  const overlayBgOpacityVal = document.getElementById('overlay-bg-opacity-val');
  const overlayRounding = document.getElementById('overlay-rounding');
  const overlayRoundingVal = document.getElementById('overlay-rounding-val');
  const overlayBgColor = document.getElementById('overlay-bg-color');
  const overlayColorHex = document.getElementById('overlay-color-hex');
  const overlayTextColorHex = document.getElementById('overlay-text-color-hex');
  const overlayBgColorHex = document.getElementById('overlay-bg-color-hex');
  const overlayUrlDisplay = document.getElementById('overlay-url-display');
  const lyricsOverlayUrlDisplay = document.getElementById('lyrics-overlay-url-display');
  const overlayIframe = document.getElementById('overlay-iframe');
  const overlayPreviewWrapper = document.querySelector('.overlay-preview-wrapper');
  const resizeOverlayPreview = () => {
    if (!overlayIframe || !overlayPreviewWrapper) return;
    const activeTab = document.querySelector('.preview-tab.active');
    const mode = activeTab && activeTab.dataset.previewMode === 'lyrics' ? 'lyrics' : 'info';
    const baseWidth = mode === 'lyrics' ? 1200 : 1760;
    const baseHeight = mode === 'lyrics' ? 300 : 520;
    const wrapperWidth = Math.max(1, overlayPreviewWrapper.clientWidth - 28);
    const wrapperHeight = Math.max(1, overlayPreviewWrapper.clientHeight - 28);
    const scale = Math.min(wrapperWidth / baseWidth, wrapperHeight / baseHeight, 1);

    overlayIframe.style.width = `${baseWidth}px`;
    overlayIframe.style.height = `${baseHeight}px`;
    overlayIframe.style.position = 'absolute';
    overlayIframe.style.left = '50%';
    overlayIframe.style.top = '50%';
    overlayIframe.style.transform = `translate(-50%, -50%) scale(${scale})`;
    overlayIframe.style.transformOrigin = 'center center';
    overlayIframe.style.border = 'none';
    overlayIframe.style.background = 'transparent';
  };

  const toggleOverlayForceVisible = document.getElementById('toggle-overlay-force-visible');
  const overlayAnimationDirection = document.getElementById('overlay-animation-direction');

  const setupPalette = (paletteId, colorInput, hexInput) => {
    const palette = document.getElementById(paletteId);
    if (!palette || !colorInput || !hexInput) return;

    const swatches = palette.querySelectorAll('.color-swatch');
    
    const updateSelection = (color) => {
      swatches.forEach(s => {
        if (s.dataset.color.toLowerCase() === color.toLowerCase()) {
          s.classList.add('selected');
        } else {
          s.classList.remove('selected');
        }
      });
      hexInput.value = color.replace('#', '').toLowerCase();
    };

    swatches.forEach(swatch => {
      swatch.addEventListener('click', () => {
        const color = swatch.dataset.color;
        colorInput.value = color;
        updateSelection(color);
        updateOverlaySettings();
      });
    });

    colorInput.addEventListener('input', () => {
      updateSelection(colorInput.value);
      updateOverlaySettings();
    });

    hexInput.addEventListener('input', (e) => {
      let val = e.target.value.replace(/[^0-9a-fA-F]/g, '');
      if (val.length === 6) {
        const color = `#${val}`;
        colorInput.value = color;
        updateSelection(color);
        updateOverlaySettings();
      }
    });

    return updateSelection;
  };

  const updateThemePalette = setupPalette('theme-palette', overlayColor, overlayColorHex);
  const updateTextPalette = setupPalette('text-palette', overlayTextColor, overlayTextColorHex);
  const updateBgPalette = setupPalette('bg-palette', overlayBgColor, overlayBgColorHex);

  const updateOverlaySettings = async (skipSave = false) => {
    if (!overlayScale || !overlayFont || !overlayColor || !overlayTextColor || !overlayUrlDisplay || !overlayIframe || !overlayBgOpacity || !overlayRounding || !overlayBgColor || !toggleOverlayForceVisible) return;
    
    const activeTab = document.querySelector('.preview-tab.active');
    const currentTarget = (activeTab && activeTab.dataset.previewMode === 'lyrics') ? 'lyrics' : 'info';

    const scale = parseFloat(overlayScale.value).toFixed(1);
    if (overlayScaleVal) overlayScaleVal.textContent = `${scale}x`;
    
    const font = overlayFont.value;
    const color = overlayColor.value.replace('#', '');
    const textColor = overlayTextColor.value.replace('#', '');
    
    const bgOpacity = parseFloat(overlayBgOpacity.value);
    if (overlayBgOpacityVal) overlayBgOpacityVal.textContent = `${Math.round(bgOpacity * 100)}%`;
    
    const rounding = parseFloat(overlayRounding.value);
    if (overlayRoundingVal) overlayRoundingVal.textContent = `${rounding}px`;
    
    const bgColor = overlayBgColor.value.replace('#', '');
    const isForceVisible = toggleOverlayForceVisible.checked;
    const animationDirection = overlayAnimationDirection.value || 'left';
    const themeMode = document.documentElement.getAttribute('data-theme') || 'dark';
    
    // Save to localStorage (Nested structure)
    if (!skipSave) {
      const saved = localStorage.getItem('overlay-settings');
      let config = {};
      try { config = JSON.parse(saved) || {}; } catch(e) {}
      
      config[currentTarget] = {
        scale, font, color, textColor, bgOpacity, rounding, bgColor, animationDirection
      };
      config.isForceVisible = isForceVisible;
      
      localStorage.setItem('overlay-settings', JSON.stringify(config));
    }

    // URL displays
    const infoUrl = 'http://localhost:14202/overlay-info';
    const lyricsUrl = 'http://localhost:14202/overlay-lyrics';
    if (overlayUrlDisplay) overlayUrlDisplay.textContent = infoUrl;
    if (lyricsOverlayUrlDisplay) lyricsOverlayUrlDisplay.textContent = lyricsUrl;
    
    const setupCopyBtn = (id, text) => {
      const btn = document.getElementById(id);
      if (btn && !btn.dataset.listenerAdded) {
        btn.dataset.listenerAdded = 'true';
        btn.onclick = async () => {
          try {
            await navigator.clipboard.writeText(text);
            import('../utils.js').then(m => m.showNotification("URL이 클립보드에 복사되었습니다.", "success"));
          } catch (err) { console.error("Failed to copy:", err); }
        };
      }
    };
    setupCopyBtn('btn-copy-overlay-url', infoUrl);
    setupCopyBtn('btn-copy-lyrics-overlay-url', lyricsUrl);
    
    // Ensure iframe is loaded on preview mode without reloading
    if (!overlayIframe.src.includes('preview=true')) {
        const activeTab = document.querySelector('.preview-tab.active');
        const mode = activeTab && activeTab.dataset.previewMode === 'lyrics' ? 'lyrics' : 'info';
        overlayIframe.src = mode === 'lyrics' ? `overlay-lyrics.html?preview=true` : `overlay-info.html?preview=true`;
    }
    resizeOverlayPreview();
    
    // Push the styling strictly through WebSocket (via Rust backend)
    try {
      await invoke('update_overlay_style', { 
        target: currentTarget,
        scale: parseFloat(scale), 
        font: font, 
        color: color,
        textColor: textColor,
        bgColor: bgColor,
        bgOpacity: bgOpacity,
        rounding: rounding,
        isForceVisible: isForceVisible,
        animationDirection: animationDirection,
        themeMode: themeMode
      });
    } catch (err) {
      console.error("Failed to update overlay style:", err);
    }
  };

  // [NEW] Overlay Preview Tab Toggle
  const previewTabs = document.querySelectorAll('.preview-tab');
  previewTabs.forEach(tab => {
    tab.onclick = async () => {
      previewTabs.forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      
      const mode = tab.dataset.previewMode;
      const settingsTitle = document.getElementById('overlay-settings-title');
      if (settingsTitle) {
        settingsTitle.textContent = mode === 'lyrics' ? '가사 오버레이 설정' : '곡 정보 오버레이 설정';
      }

      // Load settings for this tab from localStorage
      loadOverlaySettings();

      if (mode === 'lyrics') {
        overlayIframe.src = `overlay-lyrics.html?preview=true`;
        await invoke('update_overlay_lyrics', {
          current: "",
          next: "첫 번째 가사가 여기에 미리 표시됩니다."
        }).catch(err => console.error(err));
      } else {
        overlayIframe.src = `overlay-info.html?preview=true`;
        await invoke('update_overlay_lyrics', { current: "", next: "" }).catch(err => console.error(err));
      }
      requestAnimationFrame(resizeOverlayPreview);
    };
  });

  const loadOverlaySettings = () => {
    const saved = localStorage.getItem('overlay-settings');
    let config = {};
    try { config = JSON.parse(saved) || {}; } catch(e) {}

    const activeTab = document.querySelector('.preview-tab.active');
    const currentTarget = (activeTab && activeTab.dataset.previewMode === 'lyrics') ? 'lyrics' : 'info';
    
    // Default values if no settings exist
    const defaults = {
      scale: 1.0,
      color: currentTarget === 'lyrics' ? 'ffffff' : '3b82f6',
      textColor: 'ffffff',
      bgOpacity: 0.6,
      rounding: 20,
      bgColor: '0f0f14',
      font: 'Inter',
      animationDirection: 'left'
    };

    const settings = config[currentTarget] || {};
    const final = { ...defaults, ...settings };

    // Apply to UI elements
    if (overlayScale) overlayScale.value = final.scale;
    if (overlayColor) {
      overlayColor.value = `#${final.color}`;
      const hexInput = document.getElementById('overlay-color-hex');
      if (hexInput) hexInput.value = final.color.replace('#', '');
      if (updateThemePalette) updateThemePalette(`#${final.color}`);
    }
    if (overlayTextColor) {
      overlayTextColor.value = `#${final.textColor}`;
      const textHexInput = document.getElementById('overlay-text-color-hex');
      if (textHexInput) textHexInput.value = final.textColor.replace('#', '');
      if (updateTextPalette) updateTextPalette(`#${final.textColor}`);
    }
    if (overlayBgOpacity) overlayBgOpacity.value = final.bgOpacity;
    if (overlayRounding) overlayRounding.value = final.rounding;
    if (overlayBgColor) {
      overlayBgColor.value = `#${final.bgColor}`;
      const bgHexInput = document.getElementById('overlay-bg-color-hex');
      if (bgHexInput) bgHexInput.value = final.bgColor.replace('#', '');
      if (updateBgPalette) updateBgPalette(`#${final.bgColor}`);
    }
    
    if (config.isForceVisible !== undefined) toggleOverlayForceVisible.checked = config.isForceVisible;
    
    // Font Dropdown Sync
    if (overlayFont) {
      overlayFont.value = final.font;
      const dropdown = document.getElementById('overlay-font-dropdown');
      if (dropdown) {
        const selectedText = dropdown.querySelector('.selected-text');
        const options = dropdown.querySelectorAll('.option-item');
        options.forEach(opt => {
          if (opt.dataset.value === final.font) {
            opt.classList.add('selected');
            if (selectedText) selectedText.textContent = opt.textContent;
          } else {
            opt.classList.remove('selected');
          }
        });
      }
    }

    // Animation Direction Dropdown Sync
    if (overlayAnimationDirection) {
      overlayAnimationDirection.value = final.animationDirection;
      const dropdown = document.getElementById('overlay-animation-direction-dropdown');
      if (dropdown) {
        const selectedText = dropdown.querySelector('.selected-text');
        const options = dropdown.querySelectorAll('.option-item');
        options.forEach(opt => {
          if (opt.dataset.value === final.animationDirection) {
            opt.classList.add('selected');
            if (selectedText) selectedText.textContent = opt.textContent;
          } else {
            opt.classList.remove('selected');
          }
        });
      }
    }
    
    updateOverlaySettings(true);
  };

  const syncAllOverlayStylesToBackend = async () => {
    const saved = localStorage.getItem('overlay-settings');
    let config = {};
    try { config = JSON.parse(saved) || {}; } catch (e) {}

    const isForceVisible = config.isForceVisible === true;
    const themeMode = document.documentElement.getAttribute('data-theme') || 'dark';
    const targets = ['info', 'lyrics'];

    for (const target of targets) {
      const defaults = {
        scale: 1.0,
        color: target === 'lyrics' ? 'ffffff' : '3b82f6',
        textColor: 'ffffff',
        bgOpacity: 0.6,
        rounding: 20,
        bgColor: '0f0f14',
        font: 'Inter',
        animationDirection: 'left'
      };
      const targetSettings = config[target] || {};
      const final = { ...defaults, ...targetSettings };

      try {
        await invoke('update_overlay_style', {
          target,
          scale: parseFloat(final.scale) || 1.0,
          font: final.font || 'Inter',
          color: String(final.color || defaults.color).replace('#', ''),
          textColor: String(final.textColor || defaults.textColor).replace('#', ''),
          bgColor: String(final.bgColor || defaults.bgColor).replace('#', ''),
          bgOpacity: Number.isFinite(final.bgOpacity) ? final.bgOpacity : defaults.bgOpacity,
          rounding: Number.isFinite(final.rounding) ? final.rounding : defaults.rounding,
          isForceVisible,
          animationDirection: final.animationDirection || 'left',
          themeMode
        });
      } catch (err) {
        console.error(`Failed to sync ${target} overlay style:`, err);
      }
    }
  };

  // Attach Event Listeners
  [overlayScale, overlayBgOpacity, overlayRounding, toggleOverlayForceVisible].forEach(el => {
    if (!el) return;
    el.addEventListener('change', () => updateOverlaySettings());
    if (el.type === 'range') {
      el.addEventListener('input', () => updateOverlaySettings());
    }
  });

  if (overlayScale) {
    overlayScale.addEventListener('input', () => updateOverlaySettings());
    // Add wheel support for scale slider
    overlayScale.addEventListener("wheel", (e) => {
      e.preventDefault();
      let val = parseFloat(overlayScale.value);
      if (e.deltaY < 0) val += 0.1; else val -= 0.1;
      val = Math.max(parseFloat(overlayScale.min), Math.min(parseFloat(overlayScale.max), val));
      overlayScale.value = val.toFixed(1);
      overlayScale.dispatchEvent(new Event("input"));
    }, { passive: false });
  }
  if (overlayFont) {
    overlayFont.addEventListener('change', () => updateOverlaySettings());
  }
  if (overlayColor) overlayColor.addEventListener('input', () => updateOverlaySettings());
  if (overlayTextColor) overlayTextColor.addEventListener('input', () => updateOverlaySettings());
  if (overlayBgOpacity) {
    overlayBgOpacity.addEventListener('input', () => updateOverlaySettings());
    overlayBgOpacity.addEventListener("wheel", (e) => {
      e.preventDefault();
      let val = parseFloat(overlayBgOpacity.value);
      if (e.deltaY < 0) val += 0.1; else val -= 0.1;
      val = Math.max(parseFloat(overlayBgOpacity.min), Math.min(parseFloat(overlayBgOpacity.max), val));
      overlayBgOpacity.value = val.toFixed(1);
      overlayBgOpacity.dispatchEvent(new Event("input"));
    }, { passive: false });
  }
  if (overlayRounding) {
    overlayRounding.addEventListener('input', () => updateOverlaySettings());
    overlayRounding.addEventListener("wheel", (e) => {
      e.preventDefault();
      let val = parseFloat(overlayRounding.value);
      if (e.deltaY < 0) val += 1; else val -= 1;
      val = Math.max(parseFloat(overlayRounding.min), Math.min(parseFloat(overlayRounding.max), val));
      overlayRounding.value = val.toFixed(0);
      overlayRounding.dispatchEvent(new Event("input"));
    }, { passive: false });
  }
  if (overlayBgColor) overlayBgColor.addEventListener('input', () => updateOverlaySettings());
  if (toggleOverlayForceVisible) toggleOverlayForceVisible.addEventListener('change', () => updateOverlaySettings());
  if (overlayAnimationDirection) overlayAnimationDirection.addEventListener('change', () => updateOverlaySettings());

  // Initialize immediately
  loadOverlaySettings();
  updateOverlaySettings(true); // Skip saving on initial load
  syncAllOverlayStylesToBackend();
  requestAnimationFrame(resizeOverlayPreview);
  window.addEventListener('resize', resizeOverlayPreview);
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
