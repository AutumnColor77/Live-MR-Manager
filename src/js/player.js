/**
 * player.js - Playback Logic and Progress Tracking
 */

import { state } from './state.js';
import { elements, updateThumbnailOverlay, updatePlayButton, updateAiTogglesState } from './ui/index.js';
import { formatTime, showNotification, getThumbnailUrl } from './utils.js';
import {
  togglePlayback as apiTogglePlayback, playTrack as apiPlayTrack,
  setVolume, setPitch, setTempo, saveLibrary, seekTo, checkMrSeparated
} from './audio.js';
import { loadLyricsForTrack } from './lyrics.js';
import { emit, invoke, convertFileSrc as bridgeConvertFileSrc } from './tauri-bridge.js';

function parseDurationToMs(duration) {
  if (typeof duration === "number" && Number.isFinite(duration) && duration > 0) {
    return Math.floor(duration * 1000);
  }
  if (typeof duration !== "string") return 0;

  const trimmed = duration.trim();
  if (!trimmed) return 0;

  const parts = trimmed.split(":").map((p) => Number.parseInt(p, 10));
  if (parts.some((p) => Number.isNaN(p) || p < 0)) return 0;

  if (parts.length === 2) {
    const [mm, ss] = parts;
    return ((mm * 60) + ss) * 1000;
  }
  if (parts.length === 3) {
    const [hh, mm, ss] = parts;
    return ((hh * 3600) + (mm * 60) + ss) * 1000;
  }

  return 0;
}

/**
 * Highlights a track without playing it
 */
export function highlightTrack(index) {
  if (index < 0 || index >= state.songLibrary.length) return;

  // Toggle Selection
  if (state.selectedTrackIndex === index) {
    state.selectedTrackIndex = -1;
  } else {
    state.selectedTrackIndex = index;
  }

  updateThumbnailOverlay();

  // Update AI toggles state for highlight
  const song = state.selectedTrackIndex !== -1 ? state.songLibrary[state.selectedTrackIndex] : null;
  updateAiTogglesState(song);
}

export async function handlePlaybackToggle() {
  if (!state.currentTrack) {
    showNotification("재생할 곡이 선택되지 않았습니다.", "info");
    return;
  }
  try {
    const newIsPlaying = await apiTogglePlayback();
    state.isPlaying = newIsPlaying;
    state.isLoading = false;
    updateThumbnailOverlay();
    updatePlayButton();

    if (state.isPlaying) {
      if (state.currentTrack) {
        emit('track-change', {
          title: state.currentTrack.title,
          artist: state.currentTrack.artist,
          thumbnail: state.currentTrack.thumbnail
        });
        invoke('update_overlay_state', {
          title: state.currentTrack.title,
          artist: state.currentTrack.artist,
          thumbnail: state.currentTrack.thumbnail,
          isPlaying: true
        });
      }
      if (!state.rafId) {
        state.lastRafTime = performance.now();
        state.rafId = requestAnimationFrame(updateProgressBar);
      }
    } else {
      emit('playback-stop', {});
      invoke('update_overlay_state', {
        title: state.currentTrack?.title || "",
        artist: state.currentTrack?.artist || "",
        thumbnail: state.currentTrack?.thumbnail || "",
        isPlaying: false
      });
    }
  } catch (error) {
    console.error("Playback toggle failed:", error);
  }
}

export async function selectTrack(index) {
  // Increment sequence for every new request
  const mySequence = ++state.playbackSequence;

  // Guard against invalid index or empty library
  if (typeof index !== 'number' || index < 0 || index >= state.songLibrary.length) {
    console.error(`Invalid track index: ${index}`);
    state.isLoading = false;
    updateThumbnailOverlay();
    return;
  }

  const song = state.songLibrary[index];
  if (!song) {
    state.isLoading = false;
    updateThumbnailOverlay();
    return;
  }

  if (state.currentTrack && state.currentTrack.path === song.path) {
    if (state.isLoading) state.isLoading = false;
    // Always toggle (play/pause) if clicking the already current track
    handlePlaybackToggle();
    return;
  }

  console.log(`[UI] Selecting track: ${song.title}`);

  // Sync Selection Highlight immediately (Remove 2-step barrier)
  state.selectedTrackIndex = index;

  // Update State
  song.playCount = (song.playCount || 0) + 1;
  state.currentTrack = song;
  state.isPlaying = false;
  state.isLoading = true;
  state.targetProgressMs = 0;
  state.currentProgressMs = 0;

  // Load Lyrics for the selected track
  loadLyricsForTrack(song.path, parseDurationToMs(song.duration) / 1000).then(lyrics => {
    state.currentLyrics = lyrics;
    state.currentLyricIndex = -1;
    // Trigger drawer update if it's initialized
    import('./lyric-drawer.js').then(m => {
      if (m.updateLyrics) m.updateLyrics(lyrics);
      if (m.syncLyricDrawerHeader) m.syncLyricDrawerHeader();
    });
  });

  const durationHintMs = parseDurationToMs(song.duration);
  if (durationHintMs > 0) {
    state.trackDurationMs = durationHintMs;
  }

  // Sync UI immediately - dock metadata
  if (elements.dockTitle) elements.dockTitle.textContent = song.title;
  if (elements.dockArtist) elements.dockArtist.textContent = song.artist || "Unknown Artist";
  if (elements.dockThumbImg) {
    elements.dockThumbImg.src = getThumbnailUrl(song.thumbnail, song);
    elements.dockThumbImg.style.display = "block";
  }

  // Update dock progress bar immediately
  if (elements.timeTotal) elements.timeTotal.textContent = song.duration || "--:--";
  if (elements.timeCurrent) elements.timeCurrent.textContent = "0:00";
  if (elements.playbackBar) elements.playbackBar.value = 0;
  if (elements.progressFill) elements.progressFill.style.width = "0%";

  updateThumbnailOverlay();
  updatePlayButton();

  // MR이 있는 경우 보컬 토글을 자동으로 꺼짐으로 설정 (요구사항)
  if (await checkMrSeparated(song.path)) {
    state.vocalEnabled = false;
  }

  updateAiTogglesState(song);

  // Start progress bar animation immediately for loading state
  if (!state.rafId) {
    state.lastRafTime = performance.now();
    state.rafId = requestAnimationFrame(updateProgressBar);
  }

  if (elements.playbackBar) elements.playbackBar.value = 0;
  if (elements.progressFill) elements.progressFill.style.width = "0%";
  if (elements.timeCurrent) elements.timeCurrent.textContent = "0:00";
  if (elements.timeTotal) elements.timeTotal.textContent = song.duration || "--:--";

  // Apply Settings
  const p = song.pitch || 0;
  const t = song.tempo || 1.0;
  const v = song.volume || 80;

  if (elements.pitchSlider) {
    elements.pitchSlider.value = p;
    elements.pitchVal.textContent = p > 0 ? `+${p}` : p;
  }
  if (elements.tempoSlider) {
    elements.tempoSlider.value = t;
    elements.tempoVal.textContent = `${parseFloat(t).toFixed(2)}x`;
  }
  // Track volume should only sync with metadata modal slider, not master volume slider.
  const editVolSlider = document.getElementById("edit-volume");
  const editVolVal = document.getElementById("edit-volume-val");
  if (editVolSlider) editVolSlider.value = v;
  if (editVolVal) editVolVal.textContent = `${Math.round(v)}`;

  if (state.rafId) { cancelAnimationFrame(state.rafId); state.rafId = null; }

  // Safety timeout: If it takes more than 30s (for slow YT downloads), force loading off
  let loadingTimeout;
  const timeoutPromise = new Promise((_, reject) => {
    loadingTimeout = setTimeout(() => reject(new Error("Playback timed out after 30s")), 30000);
  });

  try {
    // Initial Sync: 피치, 템포 및 보컬 활성화 상태 강제 동기화
    await setPitch(p);
    await setTempo(t);
    const { toggleAiFeature } = await import('./audio.js');
    await toggleAiFeature("vocal", state.vocalEnabled);
    await setVolume(v);

    await Promise.race([
      apiPlayTrack(song.path, durationHintMs > 0 ? durationHintMs : state.trackDurationMs),
      timeoutPromise
    ]);

    state.isPlaying = true;
    console.log("[UI] Playback started successfully.");

    emit('track-change', {
      title: song.title,
      artist: song.artist,
      thumbnail: song.thumbnail
    });

    invoke('update_overlay_state', {
      title: song.title,
      artist: song.artist,
      thumbnail: song.thumbnail,
      isPlaying: true
    });

    state.lastRafTime = performance.now();
    if (!state.rafId) {
      state.rafId = requestAnimationFrame(updateProgressBar);
    }

    saveLibrary(state.songLibrary);
  } catch (err) {
    console.error("Playback failed:", err);
    state.isPlaying = false;
    showNotification("재생에 실패했습니다.", "error");
  } finally {
    clearTimeout(loadingTimeout);
    // Only reset isLoading if this is still the latest request
    if (mySequence === state.playbackSequence) {
      state.isLoading = false;
      updateThumbnailOverlay();
      updatePlayButton();
    }
  }
}

export function updateProgressBar(timestamp) {
  if (!state.isPlaying && !state.isLoading) {
    state.rafId = null;
    return;
  }

  const delta = timestamp - state.lastRafTime;
  state.lastRafTime = timestamp;

  const diff = state.targetProgressMs - state.currentProgressMs;
  if (Math.abs(diff) > 2000) {
    state.currentProgressMs = state.targetProgressMs;
  } else {
    const tempo = (elements.tempoSlider) ? parseFloat(elements.tempoSlider.value) : 1.0;
    state.currentProgressMs += delta * tempo;

    // Catch forward/backward drift
    if (state.targetProgressMs > 0) {
      if (state.currentProgressMs > state.targetProgressMs + 500) state.currentProgressMs = state.targetProgressMs + 500;
      if (state.currentProgressMs < state.targetProgressMs - 500) state.currentProgressMs = state.targetProgressMs - 500;
    }
  }

  if (!state.isSeeking && elements.playbackBar) {
    let progressVal = (state.currentProgressMs / state.trackDurationMs) * 100;
    if (isNaN(progressVal) || !isFinite(progressVal)) progressVal = 0;
    if (progressVal > 100) progressVal = 100;

    elements.playbackBar.value = progressVal;
    elements.progressFill.style.width = `${progressVal}%`;
    elements.timeCurrent.textContent = formatTime(state.currentProgressMs / 1000);
    elements.timeTotal.textContent = formatTime(state.trackDurationMs / 1000);
  }

  if (state.isPlaying || state.isLoading) {
    state.rafId = requestAnimationFrame(updateProgressBar);
  }
}

export function handleNextTrack() {
  if (state.filteredTracks.length === 0) return;

  let currentIndex = state.filteredTracks.findIndex(s => s.path === (state.currentTrack?.path));
  let nextIndex = (currentIndex + 1) % state.filteredTracks.length;

  const nextTrack = state.filteredTracks[nextIndex];
  if (nextTrack) {
    selectTrack(nextTrack.originalIndex);
  }
}

export async function handlePrevTrack() {
  let currentIndex = state.filteredTracks.findIndex(s => s.path === (state.currentTrack?.path));
  let prevIndex = (currentIndex - 1 + state.filteredTracks.length) % state.filteredTracks.length;

  const prevTrack = state.filteredTracks[prevIndex];
  if (prevTrack) {
    selectTrack(prevTrack.originalIndex);
  }
}
