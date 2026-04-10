/**
 * main.js - Entry point for Live-MR-Manager
 */

import { state } from './js/state.js';
import { elements, initDomReferences, renderLibrary, updateGenreDropdowns, updateCategoryDropdown, updateSortDropdown, updateAiModelStatus, updateGpuStatus, setupGridResizeObserver } from './js/ui.js';
import { initNavigation, initGlobalListeners, setupBackendListeners, switchTab } from './js/events.js';
import { loadLibrary, checkAiModelStatus } from './js/audio.js';
import { showNotification } from './js/utils.js';

const { invoke } = window.__TAURI__.core;

async function initApp() {
  console.log("[App] Initializing...");
  
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
  await invoke("set_volume", { volume: parseFloat(state.prevVolume) });

  // Setup custom titlebar
  setupTitlebar();

  // Setup Smooth Grid Resize
  setupGridResizeObserver();

  console.log("[App] Initialization Complete.");
}

function setupTitlebar() {
  const { getCurrentWindow } = window.__TAURI__.window;
  const appWindow = getCurrentWindow();

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
