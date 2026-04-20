/**
 * js/ui/components.js - Shared UI Components & Status Updates
 * Cache Buster: 2026-04-19 12:10
 */
import { state } from '../state.js';
import { elements } from './elements.js';
import { invoke } from '../tauri-bridge.js';
import { getThumbnailUrl } from '../utils.js';

export function updateAiModelStatus(statusInput) {
  if (!elements.aiModelStatus) return;
  
  // Normalize status input
  const status = typeof statusInput === 'boolean' 
    ? { loaded: statusInput, downloading: false, progress: 0 } 
    : statusInput;

  elements.aiModelStatus.className = "ai-model-status";
  
  if (status.loaded) {
    elements.aiModelStatus.classList.add("loaded");
    elements.aiModelStatus.innerHTML = '<i class="fas fa-check-circle"></i> 분리 모델 로드 완료';
    if (elements.btnDownloadModel) elements.btnDownloadModel.style.display = "none";
    if (elements.btnDeleteModel) elements.btnDeleteModel.style.display = "inline-flex";
  } else if (status.downloading) {
    elements.aiModelStatus.classList.add("loading");
    elements.aiModelStatus.innerHTML = `<i class="fas fa-spinner fa-spin"></i> 모델 다운로드 중... (${status.progress || 0}%)`;
    if (elements.btnDownloadModel) elements.btnDownloadModel.style.display = "none";
    if (elements.btnDeleteModel) elements.btnDeleteModel.style.display = "none";
  } else {
    elements.aiModelStatus.innerHTML = '<i class="fas fa-exclamation-triangle"></i> 분리 모델 미설치';
    if (elements.btnDownloadModel) elements.btnDownloadModel.style.display = "inline-flex";
    if (elements.btnDeleteModel) elements.btnDeleteModel.style.display = "none";
  }

  if (elements.aiEngineProvider) {
    const isGPU = status.provider && (status.provider.includes("GPU") || status.provider.includes("CUDA") || status.provider.includes("DirectML"));
    elements.aiEngineProvider.textContent = status.provider || "CPU";
    elements.aiEngineProvider.className = "engine-provider " + (isGPU ? "cuda" : "cpu");
  }

  if (elements.cudaRecommendBanner) {
    const isGPU = status.provider && (status.provider.includes("GPU") || status.provider.includes("CUDA") || status.provider.includes("DirectML"));
    elements.cudaRecommendBanner.style.display = (status.cuda_available && !isGPU) ? "flex" : "none";
  }
}

export function updateTaskUI() {
  if (!elements.taskBadge || !elements.activeTasksList) return;
  
  const tasks = Object.entries(state.activeTasks).map(([path, data]) => {
    const song = state.songLibrary.find((s) => s.path === path);
    return {
      ...data,
      path,
      // separation-progress payload may not include rich song metadata, so hydrate from library.
      title: data.title || song?.title || "알 수 없는 곡",
      thumbnail: data.thumbnail || song?.thumbnail || "",
    };
  });
  elements.taskBadge.textContent = tasks.length;
  elements.taskBadge.style.display = tasks.length > 0 ? "flex" : "none";
  
  if (elements.broadcastTasksControl) {
    elements.broadcastTasksControl.style.display = tasks.length > 0 ? "flex" : "none";
  }
  
  if (tasks.length === 0) {
    elements.activeTasksList.innerHTML = '<div class="no-tasks">현재 진행 중인 작업이 없습니다.</div>';
    return;
  }

  elements.activeTasksList.innerHTML = tasks.map(task => {
    const percent = Math.floor(task.percentage || 0);
    const thumbUrl = task.thumbnail ? getThumbnailUrl(task.thumbnail, task) : '';
    const pStr = (task.provider || "").toUpperCase();
    const isGPU = pStr.includes("GPU") || pStr.includes("CUDA") || pStr.includes("DIRECTML");
    const providerLabel = isGPU ? "GPU" : "CPU";
    
    // Status Translation
    const statusMap = {
      "Queued": "대기 중",
      "Preparing": "준비 중",
      "Starting": "시작 중",
      "Processing": "분리 중",
      "Finished": "완료",
      "Cancelled": "취소됨",
      "Error": "오류"
    };
    const displayStatus = statusMap[task.status] || task.status || '대기 중';

    return `
      <div class="task-card" data-path="${task.path}">
        <div class="task-header-info">
          <div class="task-icon">
            ${thumbUrl ? `<img src="${thumbUrl}" class="task-thumb-img">` : '<i class="fas fa-magic"></i>'}
          </div>
          <div class="task-main-details">
            <div class="task-title">${task.title}</div>
            <div class="task-status-row">
              <span class="task-status-text">${displayStatus}</span>
              <span class="task-percentage">${percent}%</span>
            </div>
          </div>
          <div class="task-actions">
            <div class="task-provider-badge ${isGPU ? 'provider-gpu' : ''}">${providerLabel}</div>
            <button class="btn-task-cancel" onclick="window.cancelTask(this.closest('.task-card').dataset.path)">취소</button>
          </div>
        </div>
        <div class="task-progress-container">
          <div class="task-progress-bar" style="width: ${percent}%"></div>
        </div>
      </div>
    `;
  }).join("");
}

export function updateAiTogglesState(song = null) {
  if (!elements.toggleVocal) return;

  // If no song provided, find from state
  const targetSong = song || (state.selectedTrackIndex !== -1 ? state.songLibrary[state.selectedTrackIndex] : state.currentTrack);

  // Requirement: Enable ONLY if separated MR exists
  const hasSeparatedMr = targetSong && (targetSong.isSeparated || targetSong.mr_path);
  const canToggleVocal = !!hasSeparatedMr;

  elements.toggleVocal.checked = state.vocalEnabled;
  elements.toggleVocal.disabled = !canToggleVocal;

  const vocalItem = elements.toggleVocal.closest('.vocal-item');
  if (vocalItem) {
    vocalItem.classList.toggle('disabled', !canToggleVocal);
  }

  // If disabled, ensure balance popover is closed
  if (!canToggleVocal) {
    const popover = document.getElementById("popover-vocal-balance");
    if (popover) popover.classList.remove("active");
  }

  if (elements.toggleLyric) {
    const hasLyrics = !!(targetSong && targetSong.hasLyrics);
    elements.toggleLyric.checked = state.lyricsEnabled;
    elements.toggleLyric.disabled = false; // Always enabled for user guidance

    const lyricItem = elements.toggleLyric.closest('.ai-item');
    if (lyricItem) {
      lyricItem.classList.remove('disabled');
      lyricItem.title = hasLyrics ? "AI 가사 싱크 활성" : "가사 싱크를 생성해 보세요!";
    }
  }
}

export function updatePlayButton() {
  if (elements.togglePlayBtn) {
    elements.togglePlayBtn.classList.toggle("is-playing", state.isPlaying);
  }
}

export function showSongContextMenu(e, song, originalIndex) {
  if (!elements.contextMenu) {
    const errorMsg = "[Context Menu] Element not found in elements object.";
    console.error(errorMsg);
    invoke('remote_js_log', { msg: errorMsg }).catch(() => {});
    return;
  }
  state.editingSongIndex = originalIndex;

  const menuWidth = 160;
  const menuHeight = 200;
  let x = e.clientX;
  let y = e.clientY;
  const winW = window.innerWidth;
  const winH = window.innerHeight;

  const logMsg = `[Context Menu] Triggered for index ${originalIndex} at (${x}, ${y})`;
  console.log(logMsg);
  invoke('remote_js_log', { msg: logMsg }).catch(() => {});

  if (x + menuWidth > winW) x = winW - menuWidth - 10;
  if (y + menuHeight > winH) y = winH - menuHeight - 10;
  if (x < 10) x = 10;
  if (y < 10) y = 10;

  elements.contextMenu.style.top = `${y}px`;
  elements.contextMenu.style.left = `${x}px`;
  elements.contextMenu.style.display = 'flex';
  elements.contextMenu.classList.add("active");

  const menuSeparate = document.getElementById("menu-separate");
  const menuDeleteMr = document.getElementById("menu-delete-mr");
  const menuPlay = document.getElementById("menu-play");
  const menuEdit = document.getElementById("menu-edit");
  const menuDelete = document.getElementById("menu-delete");

  invoke('remote_js_log', { msg: `[Context Menu Init] menuPlay=${!!menuPlay}, menuEdit=${!!menuEdit}, menuDelete=${!!menuDelete}, menuSeparate=${!!menuSeparate}, menuDeleteMr=${!!menuDeleteMr}` }).catch(() => {});

  if (menuDeleteMr) menuDeleteMr.style.display = "none";
  if (menuSeparate) menuSeparate.style.display = "none";

  // Update: Using dynamic import for audio.js
  const menuTargetId = song.path;
  import('../audio.js').then(({ checkMrSeparated, deleteMr }) => {
    invoke('remote_js_log', { msg: `[MR Check] Starting MR check for path: ${song.path}` }).catch(() => {});
    checkMrSeparated(song.path).then(isSeparated => {
      invoke('remote_js_log', { msg: `[MR Check] Completed. isSeparated=${isSeparated}` }).catch(() => {});
      // Race condition check: make sure the menu is still for the same song
      if (state.editingSongIndex !== originalIndex) {
        invoke('remote_js_log', { msg: `[MR Check] Race condition detected. Skipping.` }).catch(() => {});
        return;
      }

      if (menuDeleteMr) {
        invoke('remote_js_log', { msg: `[MR Delete Init] Setting display=${isSeparated ? "block" : "none"}` }).catch(() => {});
        menuDeleteMr.style.display = isSeparated ? "block" : "none";
        menuDeleteMr.onclick = async () => {
          invoke('remote_js_log', { msg: `[MR Delete Click] Attempting to delete MR for: ${song.path}` }).catch(() => {});
          elements.contextMenu.classList.remove("active");
          elements.contextMenu.style.display = 'none';
          try {
            const { stopPlayback } = await import('../player.js');
            if (typeof stopPlayback === 'function') await stopPlayback();
            await deleteMr(song.path);
            invoke('remote_js_log', { msg: `[MR Delete] Successfully deleted MR` }).catch(() => {});
            
            // Update local state to reflect deletion
            const songInLib = state.songLibrary.find(s => s.path === song.path);
            if (songInLib) {
              songInLib.isSeparated = false;
              songInLib.is_separated = false;
              songInLib.isMr = false;
              songInLib.is_mr = false;
              songInLib.mr_path = null;
            }

            // Re-render library after deletion
            const { renderLibrary } = await import('./library.js');
            renderLibrary();
          } catch (err) {
            invoke('remote_js_log', { msg: `[MR Delete Error] ${err.message}` }).catch(() => {});
            console.error("MR Delete failed:", err);
          }
        };
      } else {
        invoke('remote_js_log', { msg: `[MR Delete Init] menuDeleteMr is null!` }).catch(() => {});
      }

      if (menuSeparate) {
        if (state.activeTasks[song.path]) {
          invoke('remote_js_log', { msg: `[MR Separate] Task in progress, showing cancel option` }).catch(() => {});
          menuSeparate.style.display = "block";
          menuSeparate.textContent = "분리 취소";
          menuSeparate.onclick = () => {
            invoke('remote_js_log', { msg: `[MR Separate Cancel] Cancelling separation` }).catch(() => {});
            elements.contextMenu.classList.remove("active");
            elements.contextMenu.style.display = 'none';
            // audio.js handles cancel_separation
            import('../audio.js').then(({ cancelSeparation }) => {
                cancelSeparation(song.path);
            });
          };
        } else {
          menuSeparate.style.display = isSeparated ? "none" : "block";
          menuSeparate.textContent = "MR 분리";
          menuSeparate.onclick = async () => {
            invoke('remote_js_log', { msg: `[MR Separate Start] Starting MR separation` }).catch(() => {});
            elements.contextMenu.classList.remove("active");
            elements.contextMenu.style.display = 'none';
            try {
              const { startMrSeparation } = await import('../audio.js');
              await startMrSeparation(song.path);
            } catch (err) {
              invoke('remote_js_log', { msg: `[MR Separate Error] ${err.message}` }).catch(() => {});
              console.error("Separation trigger failed:", err);
            }
          };
        }
      } else {
        invoke('remote_js_log', { msg: `[MR Separate Init] menuSeparate is null!` }).catch(() => {});
      }
    });
  }).catch(err => {
    invoke('remote_js_log', { msg: `[Audio Import Error] ${err.message}` }).catch(() => {});
  });

  if (menuPlay) {
    const isCurrent = state.currentTrack && state.currentTrack.path === song.path;
    menuPlay.textContent = (isCurrent && state.isPlaying) ? "일시정지" : "재생";

    menuPlay.onclick = async () => {
      invoke('remote_js_log', { msg: `[Menu Play] Clicked for index ${originalIndex}` }).catch(() => {});
      const { selectTrack, handlePlaybackToggle } = await import('../player.js');
      if (isCurrent) {
        await handlePlaybackToggle();
      } else {
        await selectTrack(originalIndex);
      }
      elements.contextMenu.classList.remove("active");
      elements.contextMenu.style.display = 'none';
    };
  } else {
    invoke('remote_js_log', { msg: `[Menu Play Init] menuPlay is null!` }).catch(() => {});
  }

  if (menuEdit) {
    invoke('remote_js_log', { msg: `[Menu Edit Init] Setting onclick handler` }).catch(() => {});
    menuEdit.onclick = async () => {
      invoke('remote_js_log', { msg: `[Menu Edit] Clicked for index ${originalIndex}` }).catch(() => {});
      try {
        const { openEditModal } = await import('./modals.js');
        openEditModal(song, originalIndex);
      } catch (err) {
        invoke('remote_js_log', { msg: `[Menu Edit Error] ${err.message}` }).catch(() => {});
        console.error("[Menu-Edit] Import or call failed:", err);
      }
      elements.contextMenu.classList.remove("active");
      elements.contextMenu.style.display = 'none';
    };
  } else {
    invoke('remote_js_log', { msg: `[Menu Edit Init] menuEdit is null!` }).catch(() => {});
  }

  if (menuDelete) {
    invoke('remote_js_log', { msg: `[Menu Delete Init] Setting onclick handler` }).catch(() => {});
    menuDelete.onclick = async () => {
      invoke('remote_js_log', { msg: `[Menu Delete] Clicked for index ${originalIndex}` }).catch(() => {});
      try {
        const { deleteSong } = await import('./library.js');
        await deleteSong(originalIndex);
      } catch (err) {
        invoke('remote_js_log', { msg: `[Menu Delete Error] ${err.message}` }).catch(() => {});
        console.error("[Menu-Delete] Import or call failed:", err);
      }
      elements.contextMenu.classList.remove("active");
      elements.contextMenu.style.display = 'none';
    };
  } else {
    invoke('remote_js_log', { msg: `[Menu Delete Init] menuDelete is null!` }).catch(() => {});
  }
}
export function updateCardStatusBadge(path, card = null) {
  const targetCard = card || Array.from(document.querySelectorAll('.song-card')).find(el => el.dataset.path === path);
  if (!targetCard) return;

  const mode = state.viewMode || "grid";
  let parent;
  
  if (mode === "grid") {
    parent = targetCard.querySelector(".thumbnail");
  } else {
    // List and Button modes use the wrapper inside info area
    parent = targetCard.querySelector(".status-badge-wrapper");
  }
  
  if (!parent) return;

  // Clear existing status badges
  const existingBadges = parent.querySelectorAll(".status-badge");
  existingBadges.forEach(b => b.remove());

  // Find song in library for info
  const song = state.songLibrary.find(s => s.path === path);
  
  const badge = document.createElement("div");
  badge.className = "status-badge";

  const activeTask = state.activeTasks[path];
  if (activeTask && activeTask.status !== "Finished") {
    const status = (activeTask.status || "").toLowerCase();
    const isWaiting = status.includes("queued") ||
      status.includes("pending") ||
      status.includes("starting") ||
      status.includes("preparing");

    badge.classList.add(isWaiting ? "pending" : "processing");
    badge.textContent = isWaiting ? "대기중" : "분리중";
  } else if ((song && (song.isSeparated || song.isMr || song.mr_path))) {
    badge.classList.add("mr");
    badge.textContent = "MR";
  } else {
    return; // No badge to show
  }

  parent.appendChild(badge);
}

export function updateThumbnailOverlay() {
  const cards = document.querySelectorAll(".song-card");
  cards.forEach(card => {
    const path = card.dataset.path;
    const cardIndex = parseInt(card.dataset.index);
    const isCurrent = state.currentTrack && state.currentTrack.path === path;
    const isPlaying = isCurrent && state.isPlaying;
    const isSelected = state.selectedTrackIndex === cardIndex;
    
    const overlay = card.querySelector(".thumb-overlay");
    if (overlay) {
      overlay.classList.toggle("active", isCurrent);
      overlay.classList.toggle("playing", isPlaying);
      // If this is the currently loading track, show loading state
      const isCurrentlyLoading = isCurrent && state.isLoading;
      overlay.classList.toggle("loading", isCurrentlyLoading);
    }
    
    card.classList.toggle("active", isCurrent);
    card.classList.toggle("selected", isSelected);
  });

  // Also update dock thumb overlay
  if (elements.thumbOverlay) {
    const isCurrent = !!state.currentTrack;
    elements.thumbOverlay.classList.toggle("active", isCurrent);
    elements.thumbOverlay.classList.toggle("playing", isCurrent && state.isPlaying);
    elements.thumbOverlay.classList.toggle("loading", isCurrent && state.isLoading);
  }
}

export function updateGpuStatus(provider) {
  if (elements.aiEngineProvider) {
    const pStr = (provider || "").toUpperCase();
    const isGPU = pStr.includes("GPU") || pStr.includes("CUDA") || pStr.includes("DIRECTML");
    elements.aiEngineProvider.textContent = provider || "CPU";
    elements.aiEngineProvider.className = "engine-provider " + (isGPU ? "cuda" : "cpu");
  }
}
