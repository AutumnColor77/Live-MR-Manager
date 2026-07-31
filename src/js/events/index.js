/**
 * js/events/index.js - Unified Event Initialization
 */
import { initNavigation, switchTab } from './navigation.js';
import { initControlListeners } from './controls/index.js';
import { initModalListeners } from './modals.js';
import { initMelomingListeners } from './meloming.js';
import { setupBackendListeners } from './backend.js';
import { initAddSongModal } from '../add-song-modal.js';

export { switchTab };

export async function initAllEvents() {
  initNavigation();
  initAddSongModal();
  initControlListeners();
  initModalListeners();
  await initMelomingListeners();
  await setupBackendListeners();
}
