/**
 * js/ui/components.js - Shared UI Components & Status Updates
 * Cache Buster: 2026-04-19 12:10
 */
import { state } from '../state.js';
import { elements } from './elements.js';
import { getAppHandler } from '../app-context.js';
import { invoke } from '../tauri-bridge.js';
import { getThumbnailUrl } from '../utils.js';
import { extractYoutubeVideoId } from '../youtube-utils.js';

export function updateBroadcastTasksControlVisibility() {
  if (!elements.broadcastTasksControl) return;
  const isVisibleTab =
    state.activeView === "library" ||
    state.activeView === "tasks";
  const hasActiveTasks = Object.keys(state.activeTasks || {}).length > 0;
  const hasAlignQueue = (state.alignmentQueue || []).some(
    (i) => i.status === 'queued' || i.status === 'processing'
  );
  elements.broadcastTasksControl.style.display = (isVisibleTab && (hasActiveTasks || hasAlignQueue)) ? "block" : "none";
}

function isSeparatedSong(song) {
  if (!song) return false;
  return !!(song.isSeparated || song.is_separated || song.isMr || song.is_mr || song.mr_path);
}

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

const TASK_SECTION_COLLAPSED_KEY = 'taskSectionCollapsed';

function getTaskSectionCollapsed() {
  try {
    return JSON.parse(localStorage.getItem(TASK_SECTION_COLLAPSED_KEY) || '{}') || {};
  } catch (_) {
    return {};
  }
}

function setTaskSectionCollapsed(map) {
  localStorage.setItem(TASK_SECTION_COLLAPSED_KEY, JSON.stringify(map || {}));
}

function ensureTaskSectionToggles() {
  const collapsed = getTaskSectionCollapsed();
  [
    { toggleId: 'task-section-sep-toggle', bodyId: 'task-section-sep-body', key: 'separation' },
    { toggleId: 'task-section-align-toggle', bodyId: 'task-section-align-body', key: 'alignment' },
  ].forEach(({ toggleId, bodyId, key }) => {
    const toggle = document.getElementById(toggleId);
    const body = document.getElementById(bodyId);
    if (!toggle || !body || toggle.dataset.bound === '1') return;
    toggle.dataset.bound = '1';
    const apply = (isCollapsed) => {
      body.hidden = !!isCollapsed;
      toggle.setAttribute('aria-expanded', isCollapsed ? 'false' : 'true');
      const chevron = toggle.querySelector('.task-section-chevron');
      if (chevron) chevron.textContent = isCollapsed ? '▸' : '▾';
    };
    apply(!!collapsed[key]);
    toggle.addEventListener('click', (e) => {
      e.preventDefault();
      const next = getTaskSectionCollapsed();
      next[key] = !next[key];
      setTaskSectionCollapsed(next);
      apply(!!next[key]);
    });
  });

  const clearAlignBtn = document.getElementById('btn-clear-alignment-queue');
  if (clearAlignBtn && clearAlignBtn.dataset.bound !== '1') {
    clearAlignBtn.dataset.bound = '1';
    clearAlignBtn.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      const hasProcessing = (state.alignmentQueue || []).some((i) => i.status === 'processing');
      const doClear = async () => {
        const { clearAlignmentQueue } = await import('../alignment-queue.js');
        await clearAlignmentQueue();
      };
      if (hasProcessing) {
        const { openConfirmModal } = await import('./modals.js');
        openConfirmModal(
          '대기열 전체 지우기',
          '진행 중인 정렬이 있습니다. 취소하고 대기열을 모두 지울까요?',
          () => { doClear(); }
        );
      } else {
        await doClear();
      }
    });
  }

  const clearSepBtn = document.getElementById('btn-clear-separation-queue');
  if (clearSepBtn && clearSepBtn.dataset.bound !== '1') {
    clearSepBtn.dataset.bound = '1';
    clearSepBtn.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      const paths = Object.keys(state.activeTasks || {});
      if (paths.length === 0) return;
      const hasProcessing = paths.some((path) => {
        const s = String(state.activeTasks[path]?.status || '').toLowerCase();
        return s.includes('process') || s.includes('prepar') || s.includes('start');
      });
      const doClear = async () => {
        const { clearSeparationQueue } = await import('../audio.js');
        await clearSeparationQueue();
      };
      if (hasProcessing) {
        const { openConfirmModal } = await import('./modals.js');
        openConfirmModal(
          '대기열 전체 지우기',
          '진행 중인 분리가 있습니다. 취소하고 대기열을 모두 지울까요?',
          () => { doClear(); }
        );
      } else {
        await doClear();
      }
    });
  }
}

function upsertTaskCards(listEl, tasks, { emptyText, onCancel, formatStatus, showProvider }) {
  if (!listEl) return;

  if (!tasks.length) {
    listEl.innerHTML = `<div class="no-tasks">${emptyText}</div>`;
    return;
  }

  const createTaskCard = (task) => {
    const card = document.createElement('div');
    card.className = 'task-card';
    card.dataset.path = task.path;
    card.innerHTML = `
      <div class="task-header-info">
        <div class="task-icon"></div>
        <div class="task-main-details">
          <div class="task-title"></div>
          <div class="task-status-row">
            <span class="task-status-text"></span>
            <span class="task-percentage"></span>
          </div>
        </div>
        <div class="task-actions">
          <div class="task-provider-badge" ${showProvider ? '' : 'hidden'}></div>
          <button class="btn-task-cancel">취소</button>
        </div>
      </div>
      <div class="task-progress-container">
        <div class="task-progress-bar"></div>
      </div>
    `;
    const cancelBtn = card.querySelector('.btn-task-cancel');
    if (cancelBtn) {
      cancelBtn.addEventListener('click', () => onCancel(card.dataset.path, task));
    }
    return card;
  };

  const updateTaskCard = (card, task) => {
    const vm = formatStatus(task);
    card.dataset.path = task.path;
    const icon = card.querySelector('.task-icon');
    if (icon) {
      const prevThumb = card.dataset.thumbUrl || '';
      if (prevThumb !== vm.thumbUrl) {
        icon.innerHTML = vm.thumbUrl
          ? `<img src="${vm.thumbUrl}" class="task-thumb-img">`
          : '<i class="fas fa-magic"></i>';
        card.dataset.thumbUrl = vm.thumbUrl;
      }
    }
    const title = card.querySelector('.task-title');
    if (title) title.textContent = task.title;
    const status = card.querySelector('.task-status-text');
    if (status) status.textContent = vm.displayStatus;
    const percentage = card.querySelector('.task-percentage');
    if (percentage) {
      percentage.textContent = vm.hidePercent ? '' : `${vm.percent}%`;
      percentage.hidden = !!vm.hidePercent;
    }
    const badge = card.querySelector('.task-provider-badge');
    if (badge && showProvider) {
      badge.hidden = false;
      badge.textContent = vm.providerLabel;
      badge.classList.toggle('provider-gpu', vm.isGPU);
    }
    const progressBar = card.querySelector('.task-progress-bar');
    if (progressBar) {
      progressBar.classList.toggle('indeterminate', !!vm.indeterminate);
      if (!vm.indeterminate) progressBar.style.width = `${vm.percent}%`;
      else progressBar.style.width = '';
    }
    const cancelBtn = card.querySelector('.btn-task-cancel');
    if (cancelBtn) {
      const terminal = !!vm.terminal;
      cancelBtn.textContent = terminal ? '지우기' : '취소';
      cancelBtn.disabled = !!vm.disableCancel;
    }
  };

  const existingCards = new Map(
    Array.from(listEl.querySelectorAll('.task-card')).map((card) => [card.dataset.path, card])
  );
  const nextPaths = new Set(tasks.map((t) => t.path));
  const emptyState = listEl.querySelector('.no-tasks');
  if (emptyState) emptyState.remove();

  existingCards.forEach((card, path) => {
    if (!nextPaths.has(path)) {
      card.remove();
      existingCards.delete(path);
    }
  });

  tasks.forEach((task, index) => {
    let card = existingCards.get(task.path);
    if (!card) {
      card = createTaskCard(task);
      existingCards.set(task.path, card);
    }
    updateTaskCard(card, task);
    const currentAtIndex = listEl.children[index];
    if (currentAtIndex !== card) {
      listEl.insertBefore(card, currentAtIndex || null);
    }
  });
}

export function updateTaskUI() {
  ensureTaskSectionToggles();

  const sepList = elements.activeTasksList || document.getElementById('active-tasks-list');
  const alignList = document.getElementById('alignment-tasks-list');
  if (!elements.taskBadge && !sepList && !alignList) return;

  const sepTasks = Object.entries(state.activeTasks || {}).map(([path, data]) => {
    const song = state.songLibrary.find((s) => s.path === path);
    return {
      ...data,
      path,
      title: data.title || song?.title || '알 수 없는 곡',
      thumbnail: data.thumbnail || song?.thumbnail || '',
    };
  });

  const alignTasks = (state.alignmentQueue || []).map((item) => {
    const song = state.songLibrary.find((s) => s.path === item.path);
    return {
      ...item,
      title: item.title || song?.title || '알 수 없는 곡',
      thumbnail: item.thumbnail || song?.thumbnail || '',
    };
  });

  const activeSepCount = sepTasks.filter((t) => {
    const s = (t.status || '').toLowerCase();
    return s !== 'finished' && s !== 'cancelled' && s !== 'error';
  }).length;
  const activeAlignCount = alignTasks.filter((t) =>
    t.status === 'queued' || t.status === 'processing'
  ).length;
  const badgeCount = activeSepCount + activeAlignCount;

  if (elements.taskBadge) {
    elements.taskBadge.textContent = badgeCount;
    elements.taskBadge.style.display = badgeCount > 0 ? 'flex' : 'none';
  }

  const sepCountEl = document.getElementById('task-section-sep-count');
  if (sepCountEl) sepCountEl.textContent = String(sepTasks.length);
  const alignCountEl = document.getElementById('task-section-align-count');
  if (alignCountEl) alignCountEl.textContent = String(alignTasks.length);

  const clearAlignBtn = document.getElementById('btn-clear-alignment-queue');
  if (clearAlignBtn) clearAlignBtn.hidden = alignTasks.length === 0;
  const clearSepBtn = document.getElementById('btn-clear-separation-queue');
  if (clearSepBtn) clearSepBtn.hidden = sepTasks.length === 0;

  updateBroadcastTasksControlVisibility();

  const sepStatusMap = {
    Queued: '대기 중',
    Preparing: '준비 중',
    Starting: '시작 중',
    Processing: '분리 중',
    Finished: '완료',
    Cancelled: '취소됨',
    Error: '오류',
  };

  upsertTaskCards(sepList, sepTasks, {
    emptyText: '현재 진행 중인 분리가 없습니다.',
    showProvider: true,
    onCancel: (path) => {
      const cancelTask = getAppHandler('cancelTask');
      if (typeof cancelTask === 'function') cancelTask(path);
    },
    formatStatus: (task) => {
      const percent = Math.floor(task.percentage || 0);
      const thumbUrl = task.thumbnail ? getThumbnailUrl(task.thumbnail, task) : '';
      const pStr = (task.provider || '').toUpperCase();
      const isGPU = pStr.includes('GPU') || pStr.includes('CUDA') || pStr.includes('DIRECTML');
      const statusKey = task.status || '';
      const displayStatus = sepStatusMap[statusKey] || statusKey || '대기 중';
      const terminal = ['Finished', 'Cancelled', 'Error'].includes(statusKey);
      return {
        percent,
        thumbUrl,
        isGPU,
        providerLabel: isGPU ? 'GPU' : 'CPU',
        displayStatus,
        hidePercent: terminal,
        indeterminate: statusKey === 'Preparing' || statusKey === 'Starting',
        terminal,
        disableCancel: false,
      };
    },
  });

  upsertTaskCards(alignList, alignTasks, {
    emptyText: '현재 진행 중인 정렬이 없습니다.',
    showProvider: false,
    onCancel: async (path, task) => {
      const { cancelAlignmentQueueItem } = await import('../alignment-queue.js');
      await cancelAlignmentQueueItem(path);
      // 완료/오류 항목은 cancel이 목록에서 제거. processing은 상태 전환 대기.
      if (task && task.status !== 'processing' && task.status !== 'queued') {
        updateTaskUI();
      }
    },
    formatStatus: (task) => {
      const thumbUrl = task.thumbnail ? getThumbnailUrl(task.thumbnail, task) : '';
      const percent = Math.floor(task.percentage || 0);
      let displayStatus = '대기 중';
      let hidePercent = true;
      let indeterminate = false;
      let terminal = false;
      switch (task.status) {
        case 'queued':
          displayStatus = '대기 중';
          break;
        case 'processing':
          if (task.phase === 'preparing') {
            displayStatus = '준비 중 (모델 로드)';
            indeterminate = true;
          } else {
            displayStatus = task.passLabel ? `정렬 중 (${task.passLabel})` : '정렬 중';
            hidePercent = false;
          }
          break;
        case 'done':
          displayStatus = task.note ? `완료 (${task.note})` : '완료';
          terminal = true;
          break;
        case 'error':
        case 'awaiting-model':
          displayStatus = task.error || '오류';
          terminal = true;
          break;
        case 'cancelled':
          displayStatus = '취소됨';
          terminal = true;
          break;
        case 'no-lyrics':
          displayStatus = '가사 없음';
          terminal = true;
          break;
        default:
          displayStatus = task.status || '대기 중';
      }
      return {
        percent,
        thumbUrl,
        isGPU: false,
        providerLabel: '',
        displayStatus,
        hidePercent,
        indeterminate,
        terminal,
        disableCancel: false,
      };
    },
  });
}

export function updateAiTogglesState(song = null) {
  if (!elements.toggleVocal) return;

  // If no song provided, find from state
  const targetSong = song || (state.selectedTrackIndex !== -1 ? state.songLibrary[state.selectedTrackIndex] : state.currentTrack);

  // Requirement: Enable ONLY if separated MR exists.
  // Accept both camel/snake flags and URL variants (youtu.be / youtube.com).
  let hasSeparatedMr = isSeparatedSong(targetSong);
  if (!hasSeparatedMr && targetSong?.path) {
    const targetId = extractYoutubeVideoId(targetSong.path);
    if (targetId) {
      hasSeparatedMr = state.songLibrary.some((s) => {
        if (!isSeparatedSong(s)) return false;
        return extractYoutubeVideoId(s.path) === targetId;
      });
    }
  }
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
  const menuHeight = 280;
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
  const menuAddToRequests = document.getElementById("menu-add-to-requests");
  const menuLyricsView = document.getElementById("menu-lyrics-view");
  const menuEdit = document.getElementById("menu-edit");
  const menuDelete = document.getElementById("menu-delete");
  const inputSeparator = document.getElementById("menu-input-separator");
  const menuUndo = document.getElementById("menu-undo");
  const menuRedo = document.getElementById("menu-redo");
  const menuCut = document.getElementById("menu-cut");
  const menuCopy = document.getElementById("menu-copy");
  const menuPaste = document.getElementById("menu-paste");
  const menuSelectAll = document.getElementById("menu-select-all");

  // Song context: show song actions, hide text-input actions.
  [menuPlay, menuAddToRequests, menuLyricsView, menuSeparate, menuDeleteMr, menuEdit, menuDelete].forEach((el) => {
    if (el) el.style.display = "block";
  });
  [inputSeparator, menuUndo, menuRedo, menuCut, menuCopy, menuPaste, menuSelectAll].forEach((el) => {
    if (el) el.style.display = "none";
  });

  invoke('remote_js_log', { msg: `[Context Menu Init] menuPlay=${!!menuPlay}, menuLyricsView=${!!menuLyricsView}, menuEdit=${!!menuEdit}, menuDelete=${!!menuDelete}, menuSeparate=${!!menuSeparate}, menuDeleteMr=${!!menuDeleteMr}` }).catch(() => {});

  if (menuDeleteMr) menuDeleteMr.style.display = "none";
  if (menuSeparate) {
    menuSeparate.style.display = "none";
    menuSeparate.classList.remove("disabled");
  }

  // Update: Using dynamic import for audio.js
  const menuTargetId = song.path;
  import('../audio.js').then(({ checkMrSeparated, deleteMr }) => {
    invoke('remote_js_log', { msg: `[MR Check] Starting MR check for path: ${song.path}` }).catch(() => {});
    checkMrSeparated(song.path).then(isSeparated => {
      const separatedFlag = !!(song.isSeparated || song.is_separated || isSeparated);
      // Distinguish "original instrumental(MR)" from "AI-separated".
      const isManualMr = !!(song.isMr || song.is_mr) && !separatedFlag;
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
            await stopPlayback();
            await deleteMr(song.path);
            clearMrPresenceCache(song.path);
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
          if (isManualMr) {
            menuSeparate.classList.add("disabled");
            menuSeparate.onclick = null;
          } else {
            menuSeparate.classList.remove("disabled");
            menuSeparate.onclick = () => {
              invoke('remote_js_log', { msg: `[MR Separate Cancel] Cancelling separation` }).catch(() => {});
              elements.contextMenu.classList.remove("active");
              elements.contextMenu.style.display = 'none';
              // audio.js handles cancel_separation
              import('../audio.js').then(({ cancelSeparation }) => {
                  cancelSeparation(song.path);
              });
            };
          }
        } else {
          menuSeparate.style.display = isSeparated ? "none" : "block";
          menuSeparate.textContent = "MR 분리";
          if (isManualMr) {
            menuSeparate.style.display = "block";
            menuSeparate.classList.add("disabled");
            menuSeparate.onclick = null;
          } else {
            menuSeparate.classList.remove("disabled");
            menuSeparate.onclick = async () => {
              invoke('remote_js_log', { msg: `[MR Separate] Opening mode picker` }).catch(() => {});
              elements.contextMenu.classList.remove("active");
              elements.contextMenu.style.display = 'none';
              try {
                // 바로 분리하지 않고 속도/품질(모델) 선택 모달을 먼저 띄운다.
                const { openSeparationModeModal } = await import('../separation-mode-modal.js');
                openSeparationModeModal(song);
              } catch (err) {
                invoke('remote_js_log', { msg: `[MR Separate Error] ${err.message}` }).catch(() => {});
                console.error("Separation trigger failed:", err);
              }
            };
          }
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

  if (menuAddToRequests) {
    menuAddToRequests.onclick = async () => {
      elements.contextMenu.classList.remove("active");
      elements.contextMenu.style.display = 'none';
      try {
        const { addLibrarySongsToRequests } = await import('../library-songbook-queue.js');
        await addLibrarySongsToRequests([song]);
      } catch (err) {
        console.error('[Menu AddToRequests]', err);
      }
    };
  }

  if (menuLyricsView) {
    menuLyricsView.onclick = () => {
      invoke('remote_js_log', { msg: `[Menu LyricsView] Clicked for index ${originalIndex}` }).catch(() => {});
      elements.contextMenu.classList.remove("active");
      elements.contextMenu.style.display = 'none';
      import('../lyric-drawer.js').then(({ focusLyricDrawerOnTrack }) => {
        focusLyricDrawerOnTrack(song);
      }).catch(() => {});
      const openLyricDrawer = getAppHandler('openLyricDrawer');
      if (typeof openLyricDrawer === "function") {
        openLyricDrawer();
      } else {
        document.body.classList.add("drawer-open");
      }
    };
  } else {
    invoke('remote_js_log', { msg: `[Menu LyricsView Init] menuLyricsView is null!` }).catch(() => {});
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
const mrPresenceChecked = new Set();

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
  } else if (song && (song.isSeparated || song.is_separated || song.isMr || song.is_mr || song.mr_path)) {
    badge.classList.add("mr");
    badge.textContent = "MR";
  } else if (song && !mrPresenceChecked.has(path)) {
    mrPresenceChecked.add(path);
    invoke("check_mr_separated", { path })
      .then((separated) => {
        if (!separated) return;
        song.isSeparated = true;
        song.is_separated = true;
        updateCardStatusBadge(path, targetCard);
      })
      .catch(() => {});
    return;
  } else {
    return; // No badge to show
  }

  parent.appendChild(badge);
}

/** Call after MR delete so cards can re-probe cache on next render. */
export function clearMrPresenceCache(path) {
  if (path) mrPresenceChecked.delete(path);
  else mrPresenceChecked.clear();
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
