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
import { loadLibrary, checkAiModelStatus, cancelSeparation } from './js/audio.js';
import { showNotification } from './js/utils.js';

import { invoke, appWindow } from './js/tauri-bridge.js';

const THEME_STORAGE_KEY = 'themeMode';
const THEME_OPTIONS = new Set(['dark', 'light', 'pink', 'sky']);

function normalizeTheme(value) {
  return THEME_OPTIONS.has(value) ? value : 'dark';
}

function applyPlatformClass() {
  const ua = navigator.userAgent || "";
  const platform = navigator.platform || "";
  const isMac = /Mac/i.test(platform) || /Mac OS X/i.test(ua);
  const isWindows = /Win/i.test(platform) || /Windows/i.test(ua);
  const root = document.documentElement;
  root.classList.toggle("platform-macos", isMac);
  root.classList.toggle("platform-windows", isWindows);
}

export function applyTheme(theme, { persist = true } = {}) {
  const nextTheme = normalizeTheme(theme);
  document.documentElement.setAttribute('data-theme', nextTheme);
  state.themeMode = nextTheme;
  if (persist) {
    localStorage.setItem(THEME_STORAGE_KEY, nextTheme);
  }
  return nextTheme;
}

function syncThemeDropdown(theme) {
  const hiddenInput = document.getElementById('theme-mode-select');
  const dropdown = document.getElementById('theme-mode-dropdown');
  if (!hiddenInput || !dropdown) return;

  hiddenInput.value = theme;
  const selectedText = dropdown.querySelector('.selected-text');
  const options = dropdown.querySelectorAll('.option-item');
  options.forEach((opt) => {
    const selected = opt.dataset.value === theme;
    opt.classList.toggle('selected', selected);
    if (selected && selectedText) {
      selectedText.textContent = opt.textContent;
    }
  });
}

function initTheme() {
  const stored = localStorage.getItem(THEME_STORAGE_KEY);
  const appliedTheme = applyTheme(stored || state.themeMode || 'dark', { persist: true });
  syncThemeDropdown(appliedTheme);
}

// Expose navigation to global for cross-module usage
window.switchToTab = switchTab;
window.applyAppTheme = applyTheme;

// Register permanent error listeners to bridge JS errors to terminal IMMEDIATELY
window.addEventListener('error', (event) => {
  console.error("[Fatal Error]", event.error || event.message);
  invoke('remote_js_log', { msg: `[JS Error] ${event.message} at ${event.filename}:${event.lineno}` }).catch(() => {});
});
window.addEventListener('unhandledrejection', (event) => {
  console.error("[Fatal Promise Error]", event.reason);
  invoke('remote_js_log', { msg: `[JS Unhandled Promise] ${event.reason ? event.reason.toString() : 'Unknown'}` }).catch(() => {});
});

console.log("[JS] main.js loaded and executing...");

async function initApp() {
  console.log("[App] Initializing...");
  applyPlatformClass();
  initTheme();

  // 0. Setup custom titlebar immediately (Don't wait for backend)
  setupTitlebar();

  // Expose task cancellation to global window for UI components
  window.cancelTask = cancelSeparation;
  
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
      color: var(--text-main) !important;
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

  // (Removed hardcoded modalStyle injection to allow modals.css to take precedence)


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
  }

  // 3. Initialize Event Listeners
  try {
    initAllEvents();
  } catch (err) {
    console.error("Failed to initialize events:", err);
  }

  // 4. Set Initial UI State
  try {
    const initialTab = "library";
    switchTab(initialTab);
    
    await updateGenreDropdowns();
    await updateCategoryDropdown();
    updateSortDropdown();
  } catch (err) {
    console.error("Failed to set initial UI state:", err);
  }
  
  // 5. Initialize View Mode UI
  try {
    if (elements.songGrid) {
      elements.songGrid.classList.toggle("list-view", state.viewMode === "list");
      elements.songGrid.style.display = (state.viewMode === "list") ? "flex" : "grid";
    }
  } catch (err) {}

  // 6. Check AI Model & GPU
  try {
    state.isAiModelReady = await checkAiModelStatus();
    updateAiModelStatus(state.isAiModelReady);
    const gpuStatus = await invoke("get_gpu_recommendation");
    updateGpuStatus(gpuStatus);
  } catch (err) {}

  // 7. Initial volume sync
  try {
    if (elements.volSlider) {
      const min = Number.parseFloat(elements.volSlider.min || "0");
      const max = Number.parseFloat(elements.volSlider.max || "120");
      const normalized = Math.max(min, Math.min(max, Number(state.masterVolume)));
      state.masterVolume = normalized;
      elements.volSlider.value = normalized;
      if (elements.volSliderVal) elements.volSliderVal.textContent = `${normalized}%`;
    }
    await invoke("set_master_volume", { volume: state.masterVolume });
  } catch (err) {}

  // 8. Setup Smooth Grid Resize & DragDrop
  try {
    setupGridResizeObserver();
    initSortable();
  } catch (err) {}

  // 9. Initialize Lyric Drawer (Last, to prevent blocking)
  try {
    import('./js/lyric-drawer.js').then(({ initLyricDrawer }) => {
      initLyricDrawer();
    }).catch(err => console.error("Lyric Drawer init failed:", err));
  } catch (err) {}

  // 10. Final UI Sync
  try {
    updateAiTogglesState(null);
  } catch (err) {}

  console.log("[App] Initialization Complete.");
}

function setupTitlebar() {
  // appWindow is imported from tauri-bridge.js
  console.log("[Titlebar] Setting up event listeners...");

  document.getElementById('titlebar-minimize')?.addEventListener('click', async () => {
    console.log("[Titlebar] Minimize clicked");
    try { await appWindow.minimize(); } catch (e) { console.error(e); }
  });

  document.getElementById('titlebar-maximize')?.addEventListener('click', async () => {
    console.log("[Titlebar] Maximize/Restore clicked");
    try { await appWindow.toggleMaximize(); } catch (e) { console.error(e); }
  });

  document.getElementById('titlebar-close')?.addEventListener('click', async () => {
    console.log("[Titlebar] Close clicked");
    try { await appWindow.close(); } catch (e) { console.error(e); }
  });
}

function blockNativeContextMenu() {
  // Keep app-like UX by suppressing the browser's default right-click menu.
  // Custom in-app context menus still work because we only prevent default.
  document.addEventListener("contextmenu", (event) => {
    event.preventDefault();
  });
}

// Start
window.addEventListener("DOMContentLoaded", async () => {
  blockNativeContextMenu();
  await initApp();
});

// Export for some legacy inline listeners if any (though we aim for zero)
window.state = state;
