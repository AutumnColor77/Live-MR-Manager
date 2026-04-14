/**
 * main.js - Entry point for Live-MR-Manager
 */

import { state } from './js/state.js';
import { elements, initDomReferences, renderLibrary, updateGenreDropdowns, updateCategoryDropdown, updateSortDropdown, updateAiModelStatus, updateGpuStatus, setupGridResizeObserver, initSortable } from './js/ui.js';
import { initNavigation, initGlobalListeners, setupBackendListeners, switchTab } from './js/events.js';
import { loadLibrary, checkAiModelStatus } from './js/audio.js';
import { showNotification } from './js/utils.js';

import { invoke, appWindow } from './js/tauri-bridge.js';

async function initApp() {
  console.log("[App] Initializing...");
  
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
  initNavigation();
  initGlobalListeners();
  setupBackendListeners();

  // 4. Set Initial UI State
  const initialTab = "library";
  switchTab(initialTab);
  
  updateGenreDropdowns();
  updateCategoryDropdown();
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
