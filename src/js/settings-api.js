/**
 * settings-api.js - Settings, backup, and system command wrappers
 */

import { invoke } from './tauri-bridge.js';

export async function exportBackup() {
  return invoke('export_backup');
}

export async function importBackup() {
  return invoke('import_backup');
}

export async function exportLibrarySpreadsheet(templateOnly = false) {
  return invoke('export_library_spreadsheet', { templateOnly });
}

export async function importLibrarySpreadsheet() {
  return invoke('import_library_spreadsheet');
}

export async function runCacheRescue() {
  return invoke('run_cache_rescue');
}

export async function setBroadcastMode(enabled) {
  return invoke('set_broadcast_mode', { enabled: !!enabled });
}

export async function getMrCacheFormat() {
  return invoke('get_mr_cache_format');
}

export async function setMrCacheFormat(format) {
  return invoke('set_mr_cache_format', { format });
}

export async function openCacheFolder() {
  return invoke('open_cache_folder');
}

// --- MR separated-audio cache path (local disk by default; writable network
// share allowed with a performance warning). Changes require an app restart
// to take effect — see cache_settings.rs on the Rust side. ---

export async function getMrCachePathInfo() {
  return invoke('get_mr_cache_path_info');
}

export async function checkMrCachePath(path) {
  return invoke('check_mr_cache_path', { path });
}

export async function setMrCachePath(path) {
  return invoke('set_mr_cache_path', { path: path || null });
}

export async function pickMrCacheFolder() {
  return invoke('pick_mr_cache_folder');
}

export async function openAppPage(url) {
  return invoke('open_app_update_page', { url });
}

export async function checkForAppUpdate() {
  return invoke('check_for_app_update');
}
