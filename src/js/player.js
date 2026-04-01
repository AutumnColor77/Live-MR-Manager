/**
 * player.js - Playback Logic and Progress Tracking
 */

import { state } from './state.js';
import { elements, updateThumbnailOverlay, updatePlayButton, updateAiTogglesState } from './ui.js';
import { formatTime, showNotification, getThumbnailUrl } from './utils.js';
import { togglePlayback as apiTogglePlayback, playTrack as apiPlayTrack, setVolume, setPitch, setTempo, saveLibrary, seekTo } from './audio.js';

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
      if (!state.rafId) {
        state.lastRafTime = performance.now();
        state.rafId = requestAnimationFrame(updateProgressBar);
      }
    }
  } catch (error) {
    console.error("Playback toggle failed:", error);
  }
}

export async function selectTrack(index) {
  // Prevent duplicate requests while already loading
  if (state.isLoading) {
    console.warn("Playback request ignored: already loading.");
    return;
  }

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
  
  // Sync UI immediately
  if (elements.dockTitle) elements.dockTitle.textContent = song.title;
  if (elements.dockArtist) elements.dockArtist.textContent = song.artist || "Unknown Artist";
  if (elements.dockThumbImg) {
    elements.dockThumbImg.src = getThumbnailUrl(song.thumbnail, song);
    elements.dockThumbImg.style.display = "block";
  }
  
  updateThumbnailOverlay();
  updatePlayButton();
  updateAiTogglesState(song);
  
  // Progress Reset
  state.targetProgressMs = 0;
  state.currentProgressMs = 0;
  
  if (song.duration && song.duration.includes(":")) {
    const parts = song.duration.split(":");
    const sec = (parseInt(parts[0]) * 60) + (parseInt(parts[1]) || 0);
    state.trackDurationMs = sec * 1000;
  } else {
    state.trackDurationMs = 1;
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
  const volSliderInput = document.querySelector(".volume-slider");
  if (volSliderInput) volSliderInput.value = v;

  if (state.rafId) { cancelAnimationFrame(state.rafId); state.rafId = null; }
  
  // Safety timeout: If it takes more than 30s (for slow YT downloads), force loading off
  const timeoutPromise = new Promise((_, reject) => 
    setTimeout(() => reject(new Error("Playback timed out after 30s")), 30000)
  );

  try {
    // Initial Sync
    await setPitch(p);
    await setTempo(t);
    await setVolume(v);

    await apiPlayTrack(song.path);
    
    state.isPlaying = true;
    console.log("[UI] Playback started successfully.");
    
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
    state.isLoading = false;
    updateThumbnailOverlay();
    updatePlayButton();
  }
}

export function updateProgressBar(timestamp) {
  if (!state.isPlaying) { state.rafId = null; return; }

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

  state.rafId = requestAnimationFrame(updateProgressBar);
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
