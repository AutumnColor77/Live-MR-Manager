/**
 * tauri-bridge.js
 *
 * Provides a safe abstraction layer between the frontend and Tauri APIs.
 * When running in a standard browser environment, it provides Mocks to prevent crashes.
 * When promo demo mode is active, write/playback/AI commands are simulated in-memory.
 */

const isTauri = typeof window !== "undefined" && !!window.__TAURI__;

if (!isTauri) {
  if (typeof window !== "undefined") {
    console.warn("[Tauri-Bridge] window.__TAURI__ is not defined. Running in Browser/Mock mode.");
  }
}

/**
 * Safe invoke wrapper
 */
export async function invoke(command, args = {}) {
  try {
    const { tryHandleDemoInvoke } = await import("./promo-demo.js");
    const demo = await tryHandleDemoInvoke(command, args);
    if (demo.handled) return demo.value;
  } catch (err) {
    // Re-throw intentional demo errors (e.g. ALREADY_PROCESSING)
    if (err === "ALREADY_PROCESSING") throw err;
    console.warn("[Tauri-Bridge] promo demo invoke failed, falling through:", err);
  }

  if (isTauri) {
    return await window.__TAURI__.core.invoke(command, args);
  }

  console.log(`[Mock-Invoke] ${command}`, args);

  // Provide mock responses for common initialization calls
  switch (command) {
    case "load_library":
      return [];
    case "check_model_ready":
      return false;
    case "get_gpu_recommendation":
      return { recommendation: "Browser Mock", gpu: "None" };
    case "set_master_volume":
    case "set_volume":
      return;
    case "get_songbook_auth":
      return { loggedIn: false, token: null, user: null };
    case "clear_songbook_auth":
    case "set_songbook_user":
      return;
    case "analyze_key_bpm":
      return { key: "C", bpm: 120 };
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
 * Safe event listener wrapper.
 * Also wires promo-demo local events so simulated progress reaches real handlers.
 */
export async function listen(event, handler) {
  let unlistenDemo = () => {};
  let realEventBlocked = () => false;
  try {
    const promo = await import("./promo-demo.js");
    unlistenDemo = promo.subscribeDemoEvent(event, handler);
    realEventBlocked = () => promo.isDemoOwnedEvent(event);
  } catch (_) {
    /* ignore */
  }

  if (isTauri) {
    const unlistenTauri = await window.__TAURI__.event.listen(event, (payload) => {
      if (realEventBlocked()) return;
      handler(payload);
    });
    return () => {
      try { unlistenDemo(); } catch (_) {}
      try { unlistenTauri(); } catch (_) {}
    };
  }

  console.log(`[Mock-Listen] Subscribed to: ${event}`);
  return () => {
    try { unlistenDemo(); } catch (_) {}
    console.log(`[Mock-Unlisten] ${event}`);
  };
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
