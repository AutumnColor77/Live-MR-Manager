/**
 * src/js/lyrics.js - LRC Lyric Loading Utility
 */

import { invoke } from './tauri-bridge.js';
export { parseLrc } from './lrc-parser.js';
import { parseLrc, parseMarkers, getIntroSkipTargetSec } from './lrc-parser.js';

export async function loadLyricsForTrack(audioPath, duration = 0) {
  try {
    const content = await invoke('load_lrc_file', { audioPath });
    if (content && content.trim()) {
      return parseLrc(content, duration);
    }
  } catch (err) {
    console.log("[Lyrics] No LRC file found or load failed:", err);
  }
  return [];
}

/**
 * Reads just the "보컬 시작 지점" marker (if any) from a track's LRC file —
 * used to auto-skip a leading intro (music-video intro, dialogue, etc.) on
 * YouTube-sourced songs. Returns null when there's no LRC file or no marker.
 */
export async function getVocalStartMarker(audioPath) {
  try {
    const content = await invoke('load_lrc_file', { audioPath });
    if (content && content.trim()) {
      return parseMarkers(content).vocalStartSec;
    }
  } catch (err) {
    console.log("[Lyrics] No LRC file found for vocal-start marker lookup:", err);
  }
  return null;
}

/**
 * 인트로 자동 건너뛰기의 목표 지점(초)을 계산한다. 보컬 시작 전에 끝나는
 * 간주(전주) 마커가 있으면 그 간주의 시작으로(전주 음악은 안 잘림), 없으면
 * 보컬 시작으로. LRC/마커가 없으면 null. (getIntroSkipTargetSec 참고)
 */
export async function getIntroSkipTarget(audioPath) {
  try {
    const content = await invoke('load_lrc_file', { audioPath });
    if (content && content.trim()) {
      return getIntroSkipTargetSec(parseMarkers(content));
    }
  } catch (err) {
    console.log("[Lyrics] No LRC file found for intro-skip lookup:", err);
  }
  return null;
}
