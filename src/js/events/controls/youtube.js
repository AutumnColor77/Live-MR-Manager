/**
 * YouTube URL fetch — Phase 6부터 노래 추가 모달로 이전.
 * 레거시 export만 유지 (다른 모듈의 extractYoutubeVideoId re-export).
 */
export { extractYoutubeVideoId } from '../../youtube-utils.js';

export function initYoutubeListeners() {
  // no-op: URL 입력 UI는 add-song-modal.js
}
