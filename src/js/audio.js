/**
 * audio.js - Backend command wrappers for Audio Engine
 */

const { invoke } = window.__TAURI__.core;
import { showNotification } from './utils.js';

export async function setVolume(volume) {
  try {
    // Explicitly send as number (f64 on backend)
    await invoke("set_volume", { volume: parseFloat(volume) });
  } catch (err) {
    console.error("Failed to set volume:", err);
  }
}

export async function setPitch(semitones) {
  try {
    await invoke("set_pitch", { semitones: parseFloat(semitones) });
  } catch (err) {
    console.error("Failed to set pitch:", err);
  }
}

export async function setTempo(ratio) {
  try {
    await invoke("set_tempo", { ratio: parseFloat(ratio) });
  } catch (err) {
    console.error("Failed to set tempo:", err);
  }
}

export async function togglePlayback() {
  try {
    return await invoke("toggle_playback");
  } catch (err) {
    console.error("Toggle playback failed:", err);
    showNotification("재생 제어 실패", "error");
    throw err;
  }
}

export async function seekTo(positionMs) {
  try {
    await invoke("seek_to", { positionMs: Math.floor(positionMs) });
  } catch (err) {
    console.error("Seek failed:", err);
  }
}

export async function playTrack(path, duration_ms = 0) {
  try {
    // play_track in backend emits events for progress/status
    await invoke("play_track", { path, duration_ms: Math.floor(duration_ms) });
  } catch (err) {
    console.error("Play track failed:", err);
    throw err;
  }
}

export async function loadLibrary() {
  return await invoke("load_library");
}

export async function saveLibrary(songs) {
  // Backend expects { songs: Vec<SongMetadata> }
  return await invoke("save_library", { songs });
}

export async function checkAiModelStatus() {
  return await invoke("check_model_ready");
}

export async function checkMrSeparated(path) {
  return await invoke("check_mr_separated", { path });
}

export async function getYoutubeMetadata(url) {
  return await invoke("get_youtube_metadata", { url });
}

export async function getAudioMetadata(path) {
  return await invoke("get_audio_metadata", { path });
}

export async function setVocalBalance(balance) {
  try {
    await invoke("set_vocal_balance", { balance: parseFloat(balance) });
  } catch (err) {
    console.error("Failed to set balance:", err);
  }
}
export async function startMrSeparation(path) {
  try {
    return await invoke("start_mr_separation", { path });
  } catch (err) {
    console.error("Separation failed:", err);
    showNotification("MR 분리 실패: " + err, "error");
    throw err;
  }
}

export async function cancelSeparation(path) {
  try {
    return await invoke("cancel_separation", { path });
  } catch (err) {
    console.error("Cancel separation failed:", err);
  }
}
