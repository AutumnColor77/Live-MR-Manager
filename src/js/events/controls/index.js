/**
 * Unified control event initialization
 */
import { initContextMenuListener } from './shared.js';
import { initPlaybackListeners } from './playback.js';
import { initYoutubeListeners } from './youtube.js';
import { initAiListeners } from './ai.js';
import { initCustomModelListeners } from './custom-models.js';
import { initAlignmentModelListeners } from './alignment-model.js';
import { createViewModeUpdater, initLibraryListeners } from './library.js';
import { initSettingsListeners } from './settings.js';
import { initOverlayListeners } from './overlay.js';

export function initControlListeners() {
  initContextMenuListener();
  initPlaybackListeners();
  const updateViewMode = createViewModeUpdater();
  initLibraryListeners(updateViewMode);
  initYoutubeListeners();
  initAiListeners();
  initCustomModelListeners();
  initAlignmentModelListeners();

  const overlayApi = initOverlayListeners();
  initSettingsListeners({
    syncAllOverlayStylesToBackend: overlayApi?.syncAllOverlayStylesToBackend,
  });
}
