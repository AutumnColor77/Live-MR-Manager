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
  editingSongIndex: -1,
  selectedTrackIndex: -1, // Currently highlighted but not playing
  viewMode: localStorage.getItem("viewMode") || "grid",
  isMuted: false,
  prevVolume: 80,
  activeTasks: {}, // path -> { title, percentage, status }
  cancelledPaths: new Set(), // path blacklist for UI updates
  
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
  lastColumns: 0,
};

export const DEFAULT_CATEGORIES = [
  { val: "pop", text: "POP" },
  { val: "ballad", text: "발라드" },
  { val: "dance", text: "댄스" },
  { val: "rock", text: "락/메탈" },
  { val: "jpop", text: "J-POP" },
  { val: "kpop", text: "K-POP" }
];

export const SORT_OPTIONS = [
  { val: "dateNew", text: "최근 추가순" },
  { val: "dateOld", text: "오래된순" },
  { val: "title", text: "제목순 (A-Z)" },
  { val: "plays", text: "재생 횟수순" }
];
