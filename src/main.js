/**
 * main.js - Entry point for Live-MR-Manager
 */

import { state } from './js/state.js';
import { 
  initDomReferences, renderLibrary, updateGenreDropdowns, 
  updateCategoryDropdown, updateSortDropdown, updateAiModelStatus, 
  updateAiTogglesState, updateGpuStatus, setupGridResizeObserver, initSortable, elements
} from './js/ui/index.js';
import { initAllEvents, switchTab } from './js/events/index.js';
import { loadLibrary, checkAiModelStatus } from './js/audio.js';
import { showNotification } from './js/utils.js';

import { invoke, appWindow } from './js/tauri-bridge.js';

async function initApp() {
  console.log("[App] Initializing...");

  // Register permanent error listeners to bridge JS errors to terminal
  window.addEventListener('error', (event) => {
    invoke('remote_js_log', { msg: `[Error] ${event.message} at ${event.filename}:${event.lineno}` }).catch(() => {});
  });
  window.addEventListener('unhandledrejection', (event) => {
    invoke('remote_js_log', { msg: `[Unhandled Promise] ${event.reason ? event.reason.toString() : 'Unknown'}` }).catch(() => {});
  });
  
  // Fix manual input font/layout shift (fallback for locked CSS)
  const style = document.createElement('style');
  style.textContent = `
    .val-input {
      font-family: 'SUITE', sans-serif !important;
      font-size: 0.65rem !important;
      font-weight: 800 !important;
      width: 100% !important;
      height: 100% !important;
      text-align: center !important;
      border: none !important;
      background: transparent !important;
      color: #fff !important;
      outline: none !important;
      margin: 0 !important;
      padding: 0 !important;
      -moz-appearance: textfield;
      appearance: none;
    }
    
    /* Chrome, Safari, Edge, Opera */
    .val-input::-webkit-outer-spin-button,
    .val-input::-webkit-inner-spin-button {
      -webkit-appearance: none;
      margin: 0;
    }
  `;
  document.head.appendChild(style);

  // Inject Premium Modal Design (Glassmorphism & 2-Column Grid Layout)
  const modalStyle = document.createElement('style');
  modalStyle.textContent = `
    /* 1. 모달 배경 및 컨테이너 글래스모피즘 디자인 */
    .modal-overlay {
      background: rgba(0, 0, 0, 0.65) !important;
      backdrop-filter: blur(12px) !important;
      -webkit-backdrop-filter: blur(12px) !important;
    }
    
    .modal-content {
      background: rgba(26, 26, 29, 0.95) !important;
      border: 1px solid rgba(255, 255, 255, 0.1) !important;
      border-radius: 24px !important;
      box-shadow: 0 25px 50px rgba(0, 0, 0, 0.5), inset 0 1px 0 rgba(255, 255, 255, 0.1) !important;
      padding: 30px !important;
      max-width: 450px !important;
      width: 90% !important;
      transform: translateY(20px);
      opacity: 0;
      animation: modalFadeIn 0.4s cubic-bezier(0.16, 1, 0.3, 1) forwards;
    }
    
    @keyframes modalFadeIn {
      from { transform: translateY(20px); opacity: 0; }
      to { transform: translateY(0); opacity: 1; }
    }

    /* 2. 메타데이터 모달 전용 2단 그리드 레이아웃 (스마트 정렬) */
    #metadata-modal .modal-content {
      max-width: 650px !important; /* 2단 배열을 위해 너비 확장 */
    }
    
    #metadata-modal .modal-body, 
    #metadata-modal form {
      display: grid !important;
      grid-template-columns: repeat(2, 1fr) !important;
      column-gap: 24px !important;
      row-gap: 16px !important;
    }
    
    /* 긴 항목(제목, 가수, 태그, 썸네일)을 묶고 있는 부모 div를 전체 너비로 확장 */
    .modal-content div:has(> #edit-title),
    .modal-content div:has(> #edit-artist),
    .modal-content div:has(> #edit-tags) {
      grid-column: 1 / -1 !important;
    }

    /* 3. 모달 내부 텍스트 및 라벨 세부 디자인 */
    .modal-content h2, .modal-content h3 {
      font-size: 1.4rem !important;
      font-weight: 800 !important;
      color: #fff !important;
      margin-top: 0 !important;
      margin-bottom: 0 !important;
      grid-column: 1 / -1 !important; /* 그리드 내부에 제목이 섞여있을 경우 대비 */
    }

    .modal-content label {
      display: block !important;
      font-size: 0.85rem !important;
      font-weight: 700 !important;
      color: #4a9eff !important;
      margin-bottom: 8px !important;
      text-transform: uppercase !important;
      letter-spacing: 0.05em !important;
    }

    /* 4. 입력창(Input, Select, Textarea) 공통 스타일링 */
    .modal-content input[type="text"],
    .modal-content input[type="number"],
    .modal-content select,
    .modal-content textarea {
      width: 100% !important;
      background: rgba(0, 0, 0, 0.3) !important;
      border: 1px solid rgba(255, 255, 255, 0.08) !important;
      border-radius: 12px !important;
      padding: 12px 16px !important;
      color: #fff !important;
      font-family: 'SUITE', sans-serif !important;
      font-size: 0.95rem !important;
      transition: all 0.3s cubic-bezier(0.16, 1, 0.3, 1) !important;
      box-sizing: border-box !important;
    }

    .modal-content input:focus,
    .modal-content select:focus,
    .modal-content textarea:focus {
      border-color: #4a9eff !important;
      box-shadow: 0 0 0 3px rgba(74, 158, 255, 0.2) !important;
      outline: none !important;
      background: rgba(0, 0, 0, 0.5) !important;
    }

    /* 5. 하단 버튼 그룹 디자인 */
    .modal-actions, .modal-footer, .button-group {
      display: flex !important;
      justify-content: flex-end !important;
      gap: 12px !important;
      margin-top: 16px !important;
      padding-top: 24px !important;
      border-top: 1px solid rgba(255, 255, 255, 0.06) !important;
      grid-column: 1 / -1 !important;
    }

    .modal-content button {
      padding: 10px 24px !important;
      border-radius: 10px !important;
      font-weight: 800 !important;
      font-size: 0.95rem !important;
      cursor: pointer !important;
      transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1) !important;
      border: none !important;
      font-family: 'SUITE', sans-serif !important;
    }

    /* 저장 / 확인 계열 버튼 (블루) */
    .modal-content button.save-btn, 
    .modal-content button.confirm-btn,
    .modal-content button[id*="save"],
    .modal-content button[id*="confirm"],
    .modal-content button[id*="ok"] {
      background: #4a9eff !important;
      color: #fff !important;
      box-shadow: 0 4px 15px rgba(74, 158, 255, 0.3) !important;
    }

    .modal-content button.save-btn:hover,
    .modal-content button.confirm-btn:hover,
    .modal-content button[id*="save"]:hover,
    .modal-content button[id*="confirm"]:hover,
    .modal-content button[id*="ok"]:hover {
      background: #3b82f6 !important;
      box-shadow: 0 6px 20px rgba(74, 158, 255, 0.4) !important;
      transform: translateY(-2px) !important;
    }

    /* 취소 / 닫기 계열 버튼 (다크 그레이) */
    .modal-content button.cancel-btn,
    .modal-content button[id*="cancel"],
    .modal-content button[id*="no"] {
      background: rgba(255, 255, 255, 0.08) !important;
      color: #e2e8f0 !important;
    }

    .modal-content button.cancel-btn:hover,
    .modal-content button[id*="cancel"]:hover,
    .modal-content button[id*="close"]:hover,
    .modal-content button[id*="no"]:hover {
      background: rgba(255, 255, 255, 0.15) !important;
      color: #fff !important;
    }
  `;
  document.head.appendChild(modalStyle);

  // 0. Initialize Metadata Context (Dictionary)
  try {
    await invoke('init_metadata_context');
    await invoke('sync_dictionary_to_db');
    console.log("[App] Metadata context initialized and synced to DB.");
  } catch (err) {
    console.error("[App] Initial metadata sync failed:", err);
  }
  
  // 1. Initialize DOM references
  initDomReferences();
  
  // 2. Load Data
  try {
    const savedLibrary = await loadLibrary();
    state.songLibrary = savedLibrary || [];
    console.log(`[App] Loaded ${state.songLibrary.length} songs.`);
  } catch (err) {
    console.error("Failed to load library:", err);
    showNotification("라이브러리를 불러오는데 실패했습니다.", "error");
  }

  // 3. Initialize Event Listeners
  initAllEvents();

  // 4. Set Initial UI State
  const initialTab = "library";
  switchTab(initialTab);
  
  await updateGenreDropdowns();
  await updateCategoryDropdown();
  updateSortDropdown();
  
  // Initialize View Mode UI based on saved state
  if (elements.songGrid) {
    elements.songGrid.classList.toggle("list-view", state.viewMode === "list");
    elements.songGrid.style.display = (state.viewMode === "list") ? "flex" : "grid";
  }

  const gridBtn = document.getElementById("view-grid");
  const listBtn = document.getElementById("view-list");
  if (gridBtn && listBtn) {
    gridBtn.classList.toggle("active", state.viewMode === "grid");
    listBtn.classList.toggle("active", state.viewMode === "list");
  }

  // Check AI Model
  try {
    state.isAiModelReady = await checkAiModelStatus();
    updateAiModelStatus(state.isAiModelReady);
    console.log(`[App] AI Model Ready: ${state.isAiModelReady}`);
  } catch (err) {
    console.error("AI Model check failed", err);
    updateAiModelStatus(false);
  }

  // 6. Check GPU Recommendation (NVIDIA/CUDA)
  try {
    const gpuStatus = await invoke("get_gpu_recommendation");
    updateGpuStatus(gpuStatus);
  } catch (err) {
    console.error("GPU Status check failed", err);
  }

  // Initial volume sync
  if (elements.volSlider) {
    elements.volSlider.value = state.masterVolume;
    if (elements.volSliderVal) elements.volSliderVal.textContent = state.masterVolume;
  }
  await invoke("set_master_volume", { volume: state.masterVolume });
  await invoke("set_volume", { volume: parseFloat(state.prevVolume) });

  // Setup custom titlebar
  setupTitlebar();

  // Setup Smooth Grid Resize
  setupGridResizeObserver();
  
  // Initialize Drag & Drop
  initSortable();

  // Initialize Lyric Drawer
  const { initLyricDrawer } = await import('./js/lyric-drawer.js');
  initLyricDrawer();

  // Initialize AI Toggles State (Disabled by default if no selection)
  updateAiTogglesState(null);

  console.log("[App] Initialization Complete.");
}

function setupTitlebar() {
  // appWindow is imported from tauri-bridge.js

  document.getElementById('titlebar-minimize')?.addEventListener('click', async () => {
    try { await appWindow.minimize(); } catch (e) { console.error(e); }
  });

  document.getElementById('titlebar-maximize')?.addEventListener('click', async () => {
    try { await appWindow.toggleMaximize(); } catch (e) { console.error(e); }
  });

  document.getElementById('titlebar-close')?.addEventListener('click', async () => {
    try { await appWindow.close(); } catch (e) { console.error(e); }
  });
}

// Start
window.addEventListener("DOMContentLoaded", initApp);

// Export for some legacy inline listeners if any (though we aim for zero)
window.state = state;
