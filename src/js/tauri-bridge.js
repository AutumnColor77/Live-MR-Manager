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
    default:
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
  toggleMaximize: async () => console.log("[Mock-Window] Toggle Maximize"),
  close: async () => console.log("[Mock-Window] Close")
};

/**
 * Export core for legacy access if needed, but discouraged
 */
export const core = {
  invoke: async (cmd, args) => invoke(cmd, args)
};

export const event = {
  listen: async (evt, hnd) => listen(evt, hnd)
};

/**
 * Safe convertFileSrc wrapper
 */
export function convertFileSrc(path, protocol = 'asset') {
  if (isTauri) {
    return window.__TAURI__.core.convertFileSrc(path, protocol);
  }
  return path; // Fallback to raw path in browser
}
