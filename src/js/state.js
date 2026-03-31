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
  viewMode: localStorage.getItem("viewMode") || "grid",
  isMuted: false,
  prevVolume: 80,
  activeTasks: {}, // path -> { title, percentage, status }
  
  // Interpolation / Progress State
  targetProgressMs: 0,
  currentProgressMs: 0,
  trackDurationMs: 1,
  rafId: null,
  lastRafTime: 0,
  isSeeking: false,
  filteredTracks: [], // Current view's tracks { ...song, originalIndex }
};

export const DEFAULT_CATEGORIES = [
  { val: "pop", text: "POP" },
  { val: "ballad", text: "발라드" },
  { val: "dance", text: "댄스" },
  { val: "rock", text: "락/메탈" },
  { val: "jpop", text: "J-POP" },
  { val: "kpop", text: "K-POP" }
];
