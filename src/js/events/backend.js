/**
 * js/events/backend.js - Tauri Backend Event Listeners
 */
import { listen } from '../tauri-bridge.js';
import { state } from '../state.js';
import { updateTaskUI, updateAiModelStatus, updateCardStatusBadge } from '../ui/components.js';
import { renderLibrary } from '../ui/library.js';
import { showNotification } from '../utils.js';

export async function setupBackendListeners() {
  // Playback Progress Update
  await listen('playback-progress', (event) => {
    if (!state.isSeeking) {
      state.targetProgressMs = event.payload.position_ms;
      // Ensure duration is always updated if available
      if (event.payload.duration_ms > 0 || !state.trackDurationMs) {
        state.trackDurationMs = event.payload.duration_ms;
      }
    }
  });

  // Playback Status & Auto-Next
  await listen('playback-status', async (event) => {
    const { status, message } = event.payload;
    const s = (status || "").toLowerCase();
    
    // 1. Loading state
    if (["loading", "downloading", "decoding", "pending"].includes(s)) {
      state.isLoading = true;
    } else {
      state.isLoading = false;
    }

    // 2. Playback state
    if (s === "playing") {
      state.isPlaying = true;
      const { updateProgressBar } = await import('../player.js');
      if (!state.rafId) {
        state.lastRafTime = performance.now();
        state.rafId = requestAnimationFrame(updateProgressBar);
      }
    } else if (s === "finished" || s === "error" || s === "paused") {
      // Ignore finished/paused during seek to prevent snapback
      if (state.isSeeking && (s === "finished" || s === "paused")) return;
      
      state.isPlaying = false;
      state.rafId = null;

      if (s === "finished") {
        state.currentProgressMs = 0;
        state.targetProgressMs = 0;
        const { handleNextTrack } = await import('../player.js');
        handleNextTrack();
      }
    }

    // 3. Status Message in Dock
    const { elements } = await import('../ui/elements.js');
    if (elements.statusMsg) {
      elements.statusMsg.textContent = message || (s === "playing" ? "Ready" : "");
    }
    
    const { updateThumbnailOverlay, updatePlayButton } = await import('../ui/components.js');
    updateThumbnailOverlay();
    updatePlayButton();
  });

  // MR Separation Progress (Unified Listener)
  await listen('separation-progress', (event) => {
    const { path, percentage, status, provider, model } = event.payload;
    const s = (status || "").toLowerCase();

    if (s === "finished" || s === "cancelled" || s === "error") {
      delete state.activeTasks[path];
      
      if (s === "finished") {
        showNotification("MR 분리가 완료되었습니다.", "success");
        // Update local state flag
        const song = state.library.find(s => s.path === path);
        if (song) {
          song.isSeparated = true;
          song.is_separated = true;
          song.isMr = true;
          song.is_mr = true;
        }
      } else if (s === "error") {
        showNotification(`분리 실패: ${status}`, "error");
      }
      
      // Refresh library badges for all termination states (finished, cancelled, error)
      renderLibrary();
    } else {
      // Update or Add Task
      state.activeTasks[path] = { 
        ...state.activeTasks[path],
        percentage, 
        status, 
        provider, 
        model 
      };
    }
    
    updateTaskUI();
    
    // Also update the badge on the library card if it's visible
    updateCardStatusBadge(path);
  });

  // AI Model Status Updates
  await listen('ai_model_status_update', (event) => {
    updateAiModelStatus(event.payload);
  });

  // File Drag & Drop support
  await listen("tauri://drag-drop", async (event) => {
    const paths = event.payload.paths;
    if (paths && paths.length > 0) {
      const { getAudioMetadata, saveLibrary } = await import('../audio.js');
      const { renderLibrary } = await import('../ui/library.js');
      
      let addedCount = 0;
      for (const path of paths) {
        const ext = path.split('.').pop().toLowerCase();
        if (["mp3", "wav", "flac", "m4a", "aac", "ogg", "wma"].includes(ext)) {
          try {
            const metadata = await getAudioMetadata(path);
            metadata.source = "local";
            state.library.push(metadata);
            addedCount++;
          } catch (err) {
            console.error("Drop add failed for:", path, err);
          }
        }
      }
      
      if (addedCount > 0) {
        await saveLibrary(state.library);
        showNotification(`${addedCount}개의 파일이 추가되었습니다.`, "success");
        renderLibrary();
      }
    }
  });
}
