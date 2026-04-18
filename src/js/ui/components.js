/**
 * js/ui/components.js - Shared UI Components & Status Updates
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
    elements.aiEngineProvider.textContent = status.provider || "CPU";
    elements.aiEngineProvider.className = "engine-provider " + (status.provider === "CUDA" ? "cuda" : "cpu");
  }

  if (elements.cudaRecommendBanner) {
    elements.cudaRecommendBanner.style.display = (status.cuda_available && status.provider !== "CUDA") ? "flex" : "none";
  }
}

export function updateTaskUI() {
  if (!elements.taskBadge || !elements.activeTasksList) return;
  
  const tasks = Object.entries(state.activeTasks).map(([path, data]) => ({ ...data, path }));
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
            <div class="task-title">${task.title || '알 수 없는 곡'}</div>
            <div class="task-status-row">
              <span class="task-status-text">${displayStatus}</span>
              <span class="task-percentage">${percent}%</span>
            </div>
          </div>
          <div class="task-actions">
            <div class="task-provider-badge ${task.provider === 'CUDA' ? 'provider-gpu' : ''}">${task.provider || 'CPU'}</div>
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

export function updateAiTogglesState() {
  if (elements.toggleVocal) {
    elements.toggleVocal.checked = state.vocalEnabled;
  }
  if (elements.toggleLyric) {
    elements.toggleLyric.checked = state.lyricsEnabled;
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

  if (menuDeleteMr) menuDeleteMr.style.display = "none";
  if (menuSeparate) menuSeparate.style.display = "none";

  // Note: For simplicity in this refactor pass, we'll keep the logic inside showSongContextMenu
  // but eventually we should move handler setup to a separate events module.
  
  // Update: Using dynamic import for audio.js
  const menuTargetId = song.path;
  import('../audio.js').then(({ checkMrSeparated, deleteMr }) => {
    checkMrSeparated(song.path).then(isSeparated => {
      // Race condition check: make sure the menu is still for the same song
      if (state.editingSongIndex !== originalIndex) return;

      if (menuDeleteMr) {
        menuDeleteMr.style.display = isSeparated ? "block" : "none";
        menuDeleteMr.onclick = async () => {
          elements.contextMenu.classList.remove("active");
          elements.contextMenu.style.display = 'none';
          try {
            const { stopPlayback } = await import('../player.js');
            if (typeof stopPlayback === 'function') await stopPlayback();
            await deleteMr(song.path);
            
            // Update local state to reflect deletion
            const songInLib = state.library.find(s => s.path === song.path);
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
            console.error("MR Delete failed:", err);
          }
        };
      }

      if (menuSeparate) {
        if (state.activeTasks[song.path]) {
          menuSeparate.style.display = "block";
          menuSeparate.textContent = "분리 취소";
          menuSeparate.onclick = () => {
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
            elements.contextMenu.classList.remove("active");
            elements.contextMenu.style.display = 'none';
            try {
              const { startMrSeparation } = await import('../audio.js');
              await startMrSeparation(song.path);
            } catch (err) {
              console.error("Separation trigger failed:", err);
            }
          };
        }
      }
    });
  });

  if (menuPlay) {
    const isCurrent = state.currentTrack && state.currentTrack.path === song.path;
    menuPlay.textContent = (isCurrent && state.isPlaying) ? "일시정지" : "재생";

    menuPlay.onclick = async () => {
      const { selectTrack, handlePlaybackToggle } = await import('../player.js');
      if (isCurrent) {
        await handlePlaybackToggle();
      } else {
        await selectTrack(originalIndex);
      }
      elements.contextMenu.classList.remove("active");
      elements.contextMenu.style.display = 'none';
    };
  }

  document.getElementById("menu-edit").onclick = () => {
    import('./modals.js').then(({ openEditModal }) => {
       openEditModal(song, originalIndex);
    });
    elements.contextMenu.classList.remove("active");
    elements.contextMenu.style.display = 'none';
  };

  document.getElementById("menu-delete").onclick = () => {
    import('./library.js').then(({ deleteSong }) => {
      deleteSong(originalIndex);
    });
    elements.contextMenu.classList.remove("active");
    elements.contextMenu.style.display = 'none';
  };
}
export function updateCardStatusBadge(path, card = null) {
  const targetCard = card || Array.from(document.querySelectorAll('.song-card')).find(el => el.dataset.path === path);
  if (!targetCard) return;

  const isList = state.viewMode === "list";
  const parent = isList ? targetCard.querySelector(".status-badge-container") : targetCard.querySelector(".thumbnail");
  if (!parent) return;

  // Clear existing badge
  const existingBadge = parent.querySelector(".status-badge");
  if (existingBadge) existingBadge.remove();

  // Find song in library for info
  const song = state.library.find(s => s.path === path);
  
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
    elements.thumbOverlay.classList.toggle("loading", state.isLoading);
  }
}

export function updateGpuStatus(provider) {
  if (elements.aiEngineProvider) {
    elements.aiEngineProvider.textContent = provider || "CPU";
    elements.aiEngineProvider.className = "engine-provider " + (provider === "CUDA" ? "cuda" : "cpu");
  }
}
