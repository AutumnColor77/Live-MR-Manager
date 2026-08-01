/**
 * tauri-bridge.js
 * 
 * Provides a safe abstraction layer between the frontend and Tauri APIs.
 * When running in a standard browser environment, it provides Mocks to prevent crashes.
 */

const isTauri = !!window.__TAURI__;

if (!isTauri) {
  console.warn("[Tauri-Bridge] window.__TAURI__ is not defined. Running in Browser/Mock mode.");
}

/**
 * Safe invoke wrapper
 */
export async function invoke(command, args = {}) {
  if (isTauri) {
    return await window.__TAURI__.core.invoke(command, args);
  }
  
  console.log(`[Mock-Invoke] ${command}`, args);
  
  // Provide mock responses for common initialization calls
  switch (command) {
    case 'load_library':
      return [];
    case 'check_model_ready':
      return false;
    case 'get_gpu_recommendation':
      return { recommendation: "Browser Mock", gpu: "None" };
    case 'set_master_volume':
    case 'set_volume':
      return;
    case 'analyze_key_bpm':
      return { key: 'C', bpm: 120 };
    default:
      return null;
  }
}

/** Reads the version from tauri.conf.json so the UI never hardcodes it. */
export async function getAppVersion() {
  if (!isTauri) return null;
  try {
    return await window.__TAURI__.app.getVersion();
  } catch (error) {
    console.warn("[Tauri-Bridge] getVersion failed:", error);
    return null;
  }
}

/**
 * Safe event listener wrapper
 */
export async function listen(event, handler) {
  if (isTauri) {
    return await window.__TAURI__.event.listen(event, handler);
  }
  
  console.log(`[Mock-Listen] Subscribed to: ${event}`);
  return () => console.log(`[Mock-Unlisten] ${event}`);
}

/**
 * Safe window object
 */
export const appWindow = isTauri ? window.__TAURI__.window.getCurrentWindow() : {
  minimize: async () => console.log("[Mock-Window] Minimize"),
  maximize: async () => console.log("[Mock-Window] Maximize"),
  unmaximize: async () => console.log("[Mock-Window] Unmaximize"),
  isMaximized: async () => false,
  toggleMaximize: async () => console.log("[Mock-Window] Toggle Maximize"),
  close: async () => console.log("[Mock-Window] Close"),
  startDragging: async () => console.log("[Mock-Window] Start Dragging"),
  isVisible: async () => false,
  hide: async () => {},
  show: async () => {},
  setFocus: async () => {}
};

export async function toggleWindowMaximize() {
  if (!isTauri) {
    console.log("[Mock-Window] Toggle Maximize");
    return;
  }

  try {
    const maximized = await appWindow.isMaximized();
    if (maximized) {
      await appWindow.unmaximize();
    } else {
      await appWindow.maximize();
    }
  } catch (error) {
    console.warn("[Window] maximize/unmaximize failed, falling back to toggleMaximize:", error);
    await appWindow.toggleMaximize();
  }
}

/**
 * Safe emit wrapper
 */
export async function emit(event, payload) {
  if (isTauri) {
    return await window.__TAURI__.event.emit(event, payload);
  }
  console.log(`[Mock-Emit] ${event}`, payload);
}

export class WebviewWindow {
  constructor(label, options) {
    if (isTauri) {
      return new window.__TAURI__.webviewWindow.WebviewWindow(label, options);
    }
    console.log(`[Mock-WebviewWindow] Created: ${label}`, options);
  }
}

export async function getAllWindows() {
  if (isTauri) return await window.__TAURI__.window.getAllWindows();
  return [appWindow];
}

/**
 * Safe convertFileSrc wrapper
 */
export function convertFileSrc(path, protocol = 'asset') {
  if (isTauri) {
    return window.__TAURI__.core.convertFileSrc(path, protocol);
  }
  return path; // Fallback to raw path in browser
}
