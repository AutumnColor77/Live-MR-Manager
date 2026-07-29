/**
 * Unified control event initialization
 */
import { initContextMenuListener } from './shared.js';
import { initPlaybackListeners } from './playback.js';
import { initAiListeners } from './ai.js';
import { initCustomModelListeners } from './custom-models.js';
import { createViewModeUpdater, initLibraryListeners } from './library.js';
import { initSettingsListeners } from './settings.js';
import { initOverlayListeners } from './overlay.js';
import { initTaskSectionToggles } from '../../ui/components.js';

export function initControlListeners() {
  initContextMenuListener();
  initPlaybackListeners();
  const updateViewMode = createViewModeUpdater();
  initLibraryListeners(updateViewMode);
  // 유튜브 URL 입력은 "노래 추가" 원스톱 모달(add-song-modal.js)로 대체됨.
  initAiListeners();
  initCustomModelListeners();
  initTaskSectionToggles();

  const overlayApi = initOverlayListeners();
  initSettingsListeners({
    syncAllOverlayStylesToBackend: overlayApi?.syncAllOverlayStylesToBackend,
  });
}
