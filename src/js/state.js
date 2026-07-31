/**
 * state.js - Centralized application state
 */

export const state = {
  songLibrary: [],
  currentTrack: null,
  isPlaying: false,
  isLoading: false,
  isAiModelReady: false,
  isSeparating: false,
  editingSongIndex: null,
  selectedTrackIndex: -1, // Currently highlighted but not playing
  viewMode: localStorage.getItem("viewMode") || "grid",
  themeMode: localStorage.getItem("themeMode") || "dark",
  masterVolume: (() => {
    const raw = parseFloat(localStorage.getItem("masterVolume") || "100");
    if (!Number.isFinite(raw)) return 100;
    return Math.max(0, Math.min(120, raw));
  })(),
  isMuted: false,
  prevVolume: 100,
  activeTasks: {}, // path -> { title, percentage, status }
  cancelledPaths: new Set(), // path blacklist for UI updates
  // AI 가사 정렬 배치 대기열 (분리된 activeTasks와 별개로 JS 주도 순차 처리,
  // alignment-queue.js가 소유). status: queued/processing/done/error/blocked
  alignmentQueue: [], // [{ path, title, status, error? }]
  playbackSequence: 0, // Latest playback request ID to handle race conditions
  
  // Interpolation / Progress State
  targetProgressMs: 0,
  currentProgressMs: 0,
  trackDurationMs: 1,
  rafId: null,
  lastRafTime: 0,
  isSeeking: false,
  filteredTracks: [], // Current view's tracks { ...song, originalIndex }
  
  // Persistent AI Settings
  vocalEnabled: localStorage.getItem("vocalEnabled") === "true", // Default to false
  lyricsEnabled: localStorage.getItem("lyricsEnabled") === "true", // Default to false
  broadcastMode: localStorage.getItem("broadcastMode") === "true",
  // 기본값 켜짐(다른 on/off 설정과 달리 값이 없으면 true) - 설정 화면 토글로 끌 수 있음.
  autoSkipIntro: localStorage.getItem("autoSkipIntro") === null
    ? true
    : localStorage.getItem("autoSkipIntro") === "true",
  mrCacheFormat: localStorage.getItem("mrCacheFormat") || "mp3",
  lastColumns: 0,
  
  // Real-time Lyrics
  currentLyrics: [],
  currentLyricIndex: -1,
};

// --- Helper Functions for UI ---
import { invoke } from './tauri-bridge.js';

export async function getAllGenres() {
  try {
    const genres = await invoke('get_genres');
    return genres.map(g => g.name);
  } catch (err) {
    console.error('Failed to load genres:', err);
    return [];
  }
}

export async function getAllCategories() {
  try {
    const categories = await invoke('get_categories');
    return categories.map(c => c.name);
  } catch (err) {
    console.error('Failed to load categories:', err);
    return [];
  }
}
