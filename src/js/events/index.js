/**
 * js/events/index.js - Unified Event Initialization
 */
import { initNavigation, switchTab } from './navigation.js';
import { initControlListeners } from './controls/index.js';
import { initModalListeners } from './modals.js';
import { setupBackendListeners } from './backend.js';
import { initAddSongModal } from '../add-song-modal.js';
import { initSongbookAuth } from './songbook-auth.js';
import { initSongbookSync } from '../songbook-sync.js';
import { initSongbookRequestPoller } from '../songbook-request-poller.js';
import { initSongbookRequestsPage } from '../songbook-requests.js';

export { switchTab };

export async function initAllEvents() {
  initNavigation();
  initAddSongModal();
  initControlListeners();
  initModalListeners();
  initSongbookAuth();
  initSongbookSync();
  initSongbookRequestsPage();
  await initSongbookRequestPoller();
  await setupBackendListeners();
}
