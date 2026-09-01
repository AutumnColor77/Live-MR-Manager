/**
 * update-check.js - GitHub release update notifications
 */

import { listen, invoke } from './tauri-bridge.js';
import { showUpdateAvailable } from './utils.js';

export function initUpdateChecker() {
  listen('app-update-available', (event) => {
    showUpdateAvailable(event.payload);
  }).catch((err) => {
    console.warn('[Updater] Event listener failed:', err);
  });

  // Rust starts fetching at app setup; peek reuses cache or waits for in-flight check.
  invoke('peek_app_update')
    .then((info) => {
      if (info?.hasUpdate) showUpdateAvailable(info);
    })
    .catch((err) => {
      console.warn('[Updater] Startup peek failed:', err);
    });
}
