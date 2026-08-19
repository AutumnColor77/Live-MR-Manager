/**
 * player.js - Playback Logic and Progress Tracking
 */

import { state } from './state.js';
import { elements } from './ui/elements.js';
import { updateThumbnailOverlay, updatePlayButton, updateAiTogglesState } from './ui/components.js';
import { formatTime, showNotification, getThumbnailUrl } from './utils.js';
import {
  togglePlayback as apiTogglePlayback, playTrack as apiPlayTrack,
  setVolume, setPitch, setTempo, saveLibrary, seekTo, checkMrSeparated,
  stopPlayback as apiStopPlayback
} from './audio.js';
import { loadLyricsForTrack, getIntroSkipTarget } from './lyrics.js';
import { emit, invoke, convertFileSrc as bridgeConvertFileSrc } from './tauri-bridge.js';

function isYoutubePath(path) {
  if (!path || typeof path !== "string") return false;
  const p = path.trim().toLowerCase();
  return p.startsWith("http") && (p.includes("youtube.com") || p.includes("youtu.be"));
}

function songNeedsMetadataEnrichment(song) {
  if (!song) return false;
  const duration = (song.duration || "").trim();
  return !song.thumbnail?.trim() || !duration || duration === "0:00";
}

/** CSV 등 최소 정보만 있는 곡 — 재생 시 유튜브 메타데이터를 보강 (제목·아티스트는 유지) */
async function enrichSongMetadataIfNeeded(song) {
  if (!isYoutubePath(song?.path) || !songNeedsMetadataEnrichment(song)) return;

  try {
    const { getYoutubeMetadata, saveLibrary } = await import('./audio.js');
    const meta = await getYoutubeMetadata(song.path);
    if (!meta) return;

    if (!song.thumbnail?.trim() && meta.thumbnail) song.thumbnail = meta.thumbnail;
    const duration = (song.duration || "").trim();
    if ((!duration || duration === "0:00") && meta.duration) song.duration = meta.duration;
    if (!song.artist?.trim() && meta.artist) song.artist = meta.artist;
    if (!song.originalUrl?.trim() && !song.original_url?.trim()) {
      song.originalUrl = song.path;
      song.original_url = song.path;
    }

    await saveLibrary(state.songLibrary);

    if (state.currentTrack?.path !== song.path) return;

    if (elements.dockThumbImg && song.thumbnail) {
      elements.dockThumbImg.src = getThumbnailUrl(song.thumbnail, song);
    }
    const enrichedDurationMs = parseDurationToMs(song.duration);
    if (enrichedDurationMs > 0) {
      state.trackDurationMs = enrichedDurationMs;
      if (elements.timeTotal) elements.timeTotal.textContent = song.duration;
    }
    if (elements.dockArtist && song.artist) {
      elements.dockArtist.textContent = song.artist;
    }
    updateThumbnailOverlay();
    const { renderLibrary } = await import('./ui/library.js');
    renderLibrary();
  } catch (err) {
    console.warn("[Metadata] enrichment skipped:", err);
  }
}

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
 * Highlights a track without playing it (internal use)
 */
function highlightTrack(index) {
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

export async function stopPlayback() {
  try {
    await apiStopPlayback();
    state.isPlaying = false;
    state.isLoading = false;
    state.currentTrack = null;
    state.currentProgressMs = 0;
    state.targetProgressMs = 0;
    if (state.rafId) {
      cancelAnimationFrame(state.rafId);
      state.rafId = null;
    }
    updateThumbnailOverlay();
    updatePlayButton();
    emit('playback-stop', {});
    invoke('update_overlay_state', {
      title: "",
      artist: "",
      thumbnail: "",
      isPlaying: false
    });
  } catch (error) {
    console.error("Stop playback failed:", error);
    throw error;
  }
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

export async function selectTrack(index, options = {}) {
  const playNow = options.playNow !== false;
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
    if (playNow) {
      handlePlaybackToggle();
    }
    return;
  }

  console.log(`[UI] Selecting track: ${song.title}${playNow ? '' : ' (paused)'}`);

  // CSV 등으로 최소 정보만 등록된 곡 — 재생과 병렬로 메타데이터 보강
  enrichSongMetadataIfNeeded(song);

  // Sync Selection Highlight immediately (Remove 2-step barrier)
  state.selectedTrackIndex = index;
  state.suppressPlaybackErrorToast = false;
  state.ignoreStalePlaybackEvents = false;
  state.playbackInvokePending = true;

  // Update State
  if (playNow) {
    song.playCount = (song.playCount || 0) + 1;
  }
  state.currentTrack = song;
  state.isPlaying = false;
  state.isLoading = true;
  state.targetProgressMs = 0;
  state.currentProgressMs = 0;

  // Load Lyrics for the selected track
  loadLyricsForTrack(song.path, parseDurationToMs(song.duration) / 1000).then(lyrics => {
    if (mySequence !== state.playbackSequence) return;
    state.currentLyrics = lyrics;
    state.currentLyricIndex = -1;
    // Trigger drawer update if it's initialized
    import('./lyric-drawer.js').then(m => {
      if (mySequence !== state.playbackSequence) return;
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
  const mrSeparated = await checkMrSeparated(song.path);
  if (mySequence !== state.playbackSequence) return;
  if (mrSeparated) {
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

  // Safety timeout: YouTube needs metadata + yt-dlp; local files stay at 30s.
  const playTimeoutMs = isYoutubePath(song.path) ? 90000 : 30000;
  let loadingTimeout;
  const timeoutPromise = new Promise((_, reject) => {
    loadingTimeout = setTimeout(
      () => reject(new Error(`Playback timed out after ${playTimeoutMs / 1000}s`)),
      playTimeoutMs,
    );
  });

  try {
    // Initial Sync: 피치, 템포 및 보컬 활성화 상태 강제 동기화
    await setPitch(p);
    await setTempo(t);
    const { toggleAiFeature } = await import('./audio.js');
    await toggleAiFeature("vocal", state.vocalEnabled);
    await setVolume(v);

    await Promise.race([
      apiPlayTrack(song.path, durationHintMs > 0 ? durationHintMs : state.trackDurationMs, playNow),
      timeoutPromise
    ]);

    state.isPlaying = playNow;
    console.log(playNow ? "[UI] Playback started successfully." : "[UI] Track loaded paused.");

    // 인트로 자동 건너뛰기: 이 곡의 LRC에 등록된 "보컬 시작" 마커가 있으면
    // 재생 시작 직후 그 지점(또는 그 앞의 전주 시작)으로 넘어간다. 재생을
    // 막지 않도록 완전히 비동기로 처리하고, 그 사이 다른 곡으로 넘어갔으면
    // (playbackSequence 변경) 조용히 무시.
    if (playNow && state.autoSkipIntro) {
      getIntroSkipTarget(song.path).then((target) => {
        if (mySequence !== state.playbackSequence) return;
        if (typeof target === 'number' && target > 1.5) {
          seekTo(target * 1000);
        }
      }).catch((err) => console.log('[Player] Intro-skip lookup failed:', err));
    }

    emit('track-change', {
      title: song.title,
      artist: song.artist,
      thumbnail: song.thumbnail
    });

    invoke('update_overlay_state', {
      title: song.title,
      artist: song.artist,
      thumbnail: song.thumbnail,
      isPlaying: playNow
    });

    if (playNow) {
      state.lastRafTime = performance.now();
      if (!state.rafId) {
        state.rafId = requestAnimationFrame(updateProgressBar);
      }
      saveLibrary(state.songLibrary);
    }
  } catch (err) {
    console.error("Playback failed:", err);
    state.isPlaying = false;
    const raw = typeof err === "string"
      ? err
      : (err?.message || err?.toString?.() || "알 수 없는 오류");
    const timedOut = String(raw).toLowerCase().includes("timed out");
    if (timedOut) {
      state.ignoreStalePlaybackEvents = true;
      state.playbackSequence += 1;
      apiStopPlayback().catch(() => {});
    }
    state.suppressPlaybackErrorToast = true;
    state.playbackInvokePending = false;
    const detail = timedOut
      ? (isYoutubePath(song.path)
        ? "유튜브 오디오를 준비하는 데 시간이 초과되었습니다. 네트워크를 확인하고 다시 시도해 주세요."
        : "재생 준비 시간이 초과되었습니다.")
      : raw;
    showNotification(`재생에 실패했습니다: ${detail}`, "error");
  } finally {
    clearTimeout(loadingTimeout);
    // Only reset isLoading if this is still the latest request
    if (mySequence === state.playbackSequence) {
      state.isLoading = false;
      state.playbackInvokePending = false;
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

export async function handleNextTrack() {
  const { navigatePlaybackQueue } = await import('./playback-queue.js');
  if (await navigatePlaybackQueue('next')) return;

  if (state.filteredTracks.length === 0) return;

  let currentIndex = state.filteredTracks.findIndex(s => s.path === (state.currentTrack?.path));
  let nextIndex = (currentIndex + 1) % state.filteredTracks.length;

  const nextTrack = state.filteredTracks[nextIndex];
  if (nextTrack) {
    selectTrack(nextTrack.originalIndex);
  }
}

export async function handlePrevTrack() {
  const { navigatePlaybackQueue } = await import('./playback-queue.js');
  if (await navigatePlaybackQueue('prev')) return;

  if (state.filteredTracks.length === 0) return;

  let currentIndex = state.filteredTracks.findIndex(s => s.path === (state.currentTrack?.path));
  let prevIndex = (currentIndex - 1 + state.filteredTracks.length) % state.filteredTracks.length;

  const prevTrack = state.filteredTracks[prevIndex];
  if (prevTrack) {
    selectTrack(prevTrack.originalIndex);
  }
}
