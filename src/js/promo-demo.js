/**
 * promo-demo.js - In-memory simulators for full promo demo mode
 *
 * Emits the same event payloads the real backend would, so existing
 * listeners (backend.js, alignment-queue, lyric-drawer) keep working.
 */

import {
  findSessionSong,
  getPromoLyrics,
  getPromoOverlayLyrics,
  getPromoCategories,
  getPromoGenres,
  isPromoModeActive,
  isPromoSongPath,
  parsePromoDurationMs,
  setPromoLyrics,
  upsertSessionSong,
  removeSessionSong,
} from "./screenshot-library.js";
import { parseLrc } from "./lrc-parser.js";

const listeners = new Map(); // event -> Set<handler>

/** Screenshot-friendly fixed progress (~30%) for playback & AI task UIs. */
export const DEMO_SNAPSHOT_RATIO = 0.3;
const DEMO_SNAPSHOT_PERCENT = Math.round(DEMO_SNAPSHOT_RATIO * 100);

let playTimer = null;
let playPath = null;
let playPositionMs = 0;
let playDurationMs = 0;
let playPlaying = false;

/** path -> { cancelled, timers } */
const separationJobs = new Map();

function snapshotPositionMs(durationMs) {
  const d = Math.max(0, Math.floor(durationMs || 0));
  return Math.floor(d * DEMO_SNAPSHOT_RATIO);
}

function emitLocal(event, payload) {
  const set = listeners.get(event);
  if (!set) return;
  for (const handler of [...set]) {
    try {
      handler({ payload, event });
    } catch (err) {
      console.error(`[PromoDemo] listener error for ${event}:`, err);
    }
  }
}

export function subscribeDemoEvent(event, handler) {
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event).add(handler);
  return () => {
    listeners.get(event)?.delete(handler);
  };
}

export function clearDemoListeners() {
  listeners.clear();
}

function stopPlayClock() {
  if (playTimer) {
    clearInterval(playTimer);
    playTimer = null;
  }
}

function emitProgress() {
  emitLocal("playback-progress", {
    positionMs: playPositionMs,
    durationMs: playDurationMs,
    position_ms: playPositionMs,
    duration_ms: playDurationMs,
  });
}

/**
 * Pushes the demo track's overlay payload straight to the real overlay server.
 * The normal path relies on the lyric drawer reacting to progress events, so
 * driving it here keeps the OBS overlay populated for screenshots.
 */
export function buildDemoOverlayPayload(path, positionMs) {
  const song = findSessionSong(path);
  if (!song) return null;

  const durationSec = parsePromoDurationMs(song.duration) / 1000;
  const segments = parseLrc(getPromoOverlayLyrics(path), durationSec);
  const positionSec = positionMs / 1000;

  let activeIndex = -1;
  segments.forEach((segment, i) => {
    const withinEnd = segment.end === 0 || positionSec < segment.end;
    if (segment.start > 0 && positionSec >= segment.start && withinEnd) activeIndex = i;
  });

  return {
    song,
    lines: segments.map((s) => s.text),
    current: activeIndex >= 0 ? segments[activeIndex].text : "",
    next: activeIndex >= 0
      ? (segments[activeIndex + 1]?.text || "")
      : (segments[0]?.text || ""),
    index: activeIndex,
  };
}

async function pushDemoOverlay(path) {
  const payload = buildDemoOverlayPayload(path, playPositionMs);
  if (!payload) return;

  try {
    const { invoke } = await import("./tauri-bridge.js");
    await invoke("update_overlay_state", {
      title: payload.song.title,
      artist: payload.song.artist,
      thumbnail: payload.song.thumbnail,
      isPlaying: playPlaying,
    });
    await invoke("update_overlay_lyrics_full", { lines: payload.lines });
    await invoke("update_overlay_lyrics", {
      current: payload.current,
      next: payload.next,
      index: payload.index,
    });
  } catch (err) {
    console.warn("[PromoDemo] overlay push failed:", err);
  }
}

/** Keep emitting the frozen 30% position while "playing" so UI stays in sync. */
function startPlayClock() {
  stopPlayClock();
  playTimer = setInterval(() => {
    if (!playPlaying) return;
    playPositionMs = snapshotPositionMs(playDurationMs);
    emitProgress();
  }, 500);
}

export async function demoPlayTrack(path, durationMs = 0, playNow = true) {
  const song = findSessionSong(path);
  playPath = path;
  playDurationMs = durationMs > 0
    ? durationMs
    : parsePromoDurationMs(song?.duration);
  // Freeze the playhead in the lyric-populated first third for screenshots.
  playPositionMs = snapshotPositionMs(playDurationMs);
  playPlaying = !!playNow;
  emitLocal("playback-status", { status: playNow ? "Playing" : "Paused", message: "" });
  emitProgress();
  await pushDemoOverlay(path);
  if (playNow) startPlayClock();
  else stopPlayClock();
  return true;
}

export async function demoTogglePlayback() {
  if (!playPath) return false;
  playPlaying = !playPlaying;
  playPositionMs = snapshotPositionMs(playDurationMs);
  emitLocal("playback-status", {
    status: playPlaying ? "Playing" : "Paused",
    message: "",
  });
  emitProgress();
  await pushDemoOverlay(playPath);
  if (playPlaying) startPlayClock();
  else stopPlayClock();
  return playPlaying;
}

export async function demoSeekTo(_positionMs) {
  // Ignore seek targets — keep the screenshot-friendly 30% lock.
  playPositionMs = snapshotPositionMs(playDurationMs);
  emitProgress();
  await pushDemoOverlay(playPath);
}

export async function demoStopPlayback() {
  playPlaying = false;
  playPositionMs = snapshotPositionMs(playDurationMs);
  stopPlayClock();
  if (playPath) {
    emitLocal("playback-status", { status: "Stopped", message: "" });
    emitProgress();
  }
  playPath = null;
}

function cancelSeparationJob(path) {
  const job = separationJobs.get(path);
  if (!job) return false;
  job.cancelled = true;
  for (const t of job.timers) clearTimeout(t);
  separationJobs.delete(path);
  return true;
}

export async function demoStartSeparation(path, modelId) {
  if (separationJobs.has(path)) {
    throw "ALREADY_PROCESSING";
  }
  const job = { cancelled: false, timers: [], modelId: modelId || "demo-htdemucs" };
  separationJobs.set(path, job);

  const schedule = (ms, fn) => {
    const id = setTimeout(() => {
      if (job.cancelled) return;
      fn();
    }, ms);
    job.timers.push(id);
  };

  const emitSep = (percentage, status) => {
    emitLocal("separation-progress", {
      path,
      percentage,
      status,
      provider: "Demo GPU",
      model: job.modelId,
    });
  };

  // Park at ~30% Processing so task screenshots look mid-run (cancel to clear).
  emitSep(0, "Queued");
  schedule(300, () => emitSep(0, "Preparing"));
  schedule(700, () => emitSep(5, "Starting"));
  schedule(1200, () => emitSep(DEMO_SNAPSHOT_PERCENT, "Processing"));
  return true;
}

export async function demoCancelSeparation(path) {
  if (!cancelSeparationJob(path)) return false;
  emitLocal("separation-progress", {
    path,
    percentage: 0,
    status: "Cancelled",
    provider: "Demo GPU",
    model: "demo",
  });
  return true;
}

export async function demoRunForcedAlignment(audioPath, lyricsText = "") {
  // Progress contract used by alignment-queue: -1 queued, -2 preparing, 0..100
  // Hold near 30% briefly for screenshots, then finish so the queue can continue.
  emitLocal("alignment-progress", -1);
  await delay(250);
  emitLocal("alignment-progress", -2);
  await delay(400);
  emitLocal("alignment-progress", DEMO_SNAPSHOT_PERCENT);
  await delay(800);
  emitLocal("alignment-progress", 100);

  const raw = lyricsText || getPromoLyrics(audioPath);
  const plain = String(raw || "")
    .split(/\r?\n/)
    .map((l) => l.replace(/^\[[^\]]+\]\s*/, "").trim())
    .filter(Boolean);
  const source = plain.length > 0
    ? plain
    : ["데모 가사 한 줄", "두 번째 줄", "세 번째 줄", "마지막 줄"];
  const lines = source.map((text, i) => {
    const startMs = (8 + i * 5) * 1000;
    return {
      text,
      start_ms: startMs,
      end_ms: startMs + 4500,
      words: [],
    };
  });

  const song = findSessionSong(audioPath);
  if (song) {
    song.lyricSyncStatus = "synced";
    song.lyric_sync_status = "synced";
    song.hasLyrics = true;
    song.has_lyrics = true;
  }
  return { lines };
}

export async function demoCancelForcedAlignment() {
  emitLocal("alignment-progress", -1);
  return true;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Deterministic PRNG so a track's waveform never changes between renders. */
function makeRandom(seed) {
  let h = 2166136261 >>> 0;
  for (const ch of String(seed)) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 16777619);
  }
  return () => {
    h ^= h << 13; h >>>= 0;
    h ^= h >>> 17;
    h ^= h << 5; h >>>= 0;
    return h / 4294967296;
  };
}

/**
 * Sung phrases for the waveform. Uses the track's own LRC timings when the
 * lyrics are synced so the peaks line up with the sync editor's cue boxes;
 * otherwise lays out a plausible verse/chorus structure.
 */
function buildVocalPhrases(path, durationSec, rand) {
  const segments = parseLrc(getPromoLyrics(path), durationSec)
    .filter((s) => s.start > 0)
    .sort((a, b) => a.start - b.start);

  const phrases = [];
  segments.forEach((seg, i) => {
    const next = segments[i + 1];
    const syllables = Math.max(3, (seg.text || "").replace(/\s+/g, "").length * 0.8);
    const natural = Math.min(5.5, 0.9 + syllables * 0.22);
    const gap = next ? next.start - seg.start : durationSec - seg.start;
    const end = Math.min(seg.start + Math.min(natural, Math.max(1, gap - 0.35)), durationSec);
    if (end > seg.start + 0.4) phrases.push({ start: seg.start, end, syllables });
  });

  // The sample LRCs only cover the opening lines; keep singing through the
  // rest of the track (with an instrumental break) so it reads as a full song
  // rather than a few phrases followed by dead air.
  const last = phrases[phrases.length - 1];
  let t = last ? last.end + 0.6 + rand() * 1.2 : Math.min(11, durationSec * 0.07);
  const bridgeStart = durationSec * 0.62;
  const bridgeEnd = bridgeStart + 6 + rand() * 5;
  while (t < durationSec * 0.93) {
    if (t > bridgeStart && t < bridgeEnd) {
      t = bridgeEnd;
      continue;
    }
    const len = 2.2 + rand() * 2.8;
    phrases.push({
      start: t,
      end: Math.min(t + len, durationSec * 0.95),
      syllables: 6 + rand() * 8,
    });
    t += len + 0.55 + rand() * 1.8;
  }

  return phrases.map((p, i) => ({
    ...p,
    // Choruses sit louder than verses; later repeats push a bit harder.
    gain: 0.55 + 0.3 * Math.abs(Math.sin(i * 1.1)) + 0.12 * (i / Math.max(1, phrases.length)),
    rate: 2.6 + rand() * 2.2, // syllables per second
    phase: rand() * Math.PI * 2,
  }));
}

/**
 * Synthesizes a plausible [min, max] waveform summary (same contract as the
 * Rust `create_waveform_summary`: peak-normalized pairs per bucket).
 * Separated tracks render as an isolated vocal (silence between phrases);
 * un-separated tracks keep a full-mix bed with beat transients.
 */
export function buildDemoWaveform(path, durationSec, { isVocalOnly = true, buckets = 2000 } = {}) {
  const rand = makeRandom(path || "promo");
  const phrases = buildVocalPhrases(path, durationSec, rand);
  const bpm = 92 + Math.floor(rand() * 46);
  const beatSec = 60 / bpm;
  const firstVocal = phrases.length ? phrases[0].start : durationSec * 0.1;
  const outroStart = durationSec * 0.94;

  const points = [];
  let peak = 0;

  for (let i = 0; i < buckets; i++) {
    const t = ((i + 0.5) / buckets) * durationSec;
    let amp = 0;

    for (const p of phrases) {
      if (t < p.start || t > p.end) continue;
      const local = (t - p.start) / (p.end - p.start);
      // Fast attack, slower release, like a sung line.
      const shape = Math.min(1, local / 0.07) * Math.min(1, (1 - local) / 0.16);
      const syllable = 0.45 + 0.55 * Math.abs(Math.sin(Math.PI * (t - p.start) * p.rate + p.phase)) ** 1.7;
      amp = Math.max(amp, p.gain * shape * syllable);
    }

    // Breath just before a line starts.
    for (const p of phrases) {
      const lead = p.start - t;
      if (lead > 0 && lead < 0.3) amp = Math.max(amp, 0.05 + rand() * 0.03);
    }

    if (!isVocalOnly) {
      // Instrumental bed: kick/snare transients plus sustained band energy.
      const beatPos = (t % beatSec) / beatSec;
      const transient = Math.exp(-beatPos * 9) * (t < firstVocal * 0.6 ? 0.32 : 0.46);
      const bed = t < firstVocal ? 0.16 : 0.3;
      amp = Math.max(amp * 0.9 + bed * 0.55, transient + bed * 0.35);
    }

    if (t > outroStart) amp *= Math.max(0, (durationSec - t) / (durationSec - outroStart));

    const floorNoise = (isVocalOnly ? 0.012 : 0.05) + rand() * (isVocalOnly ? 0.02 : 0.035);
    const grain = 0.8 + rand() * 0.4;
    const level = Math.min(1, amp * grain + floorNoise);

    const max = level * (0.9 + rand() * 0.18);
    const min = -level * (0.76 + rand() * 0.26);
    peak = Math.max(peak, max, -min);
    points.push([min, max]);
  }

  if (peak > 0) {
    const scale = 0.97 / peak;
    for (const p of points) {
      p[0] *= scale;
      p[1] *= scale;
    }
  }
  return points;
}

export async function stopAllDemoActivity() {
  await demoStopPlayback();
  for (const path of [...separationJobs.keys()]) {
    cancelSeparationJob(path);
    emitLocal("separation-progress", {
      path,
      percentage: 0,
      status: "Cancelled",
      provider: "Demo GPU",
      model: "demo",
    });
  }
}

/**
 * Events the demo simulates itself. The real Rust audio ticker keeps emitting
 * `playback-progress` every 100ms as long as a duration is loaded, which would
 * fight the demo's frozen playhead, so those are dropped while promo mode is on.
 */
const DEMO_OWNED_EVENTS = new Set([
  "playback-progress",
  "playback-status",
  "separation-progress",
  "alignment-progress",
]);

export function isDemoOwnedEvent(event) {
  return isPromoModeActive() && DEMO_OWNED_EVENTS.has(event);
}

function shouldHandleCommand(command, args = {}) {
  if (!isPromoModeActive()) return false;

  const path =
    args.path ||
    args.audioPath ||
    args.audio_path ||
    null;

  // Always handle when promo mode is on for library/playback/AI write commands.
  const always = new Set([
    "save_library",
    "update_song_metadata",
    "delete_song",
    "load_library",
    "get_songs",
    "get_genres",
    "get_categories",
    "search_track_metadata",
    "youtube_metadata_fetcher",
    "get_audio_metadata",
    "export_backup",
    "import_backup",
    "export_library_spreadsheet",
    "import_library_spreadsheet",
    "download_ai_model",
    "delete_ai_model",
    "download_alignment_model",
    "delete_alignment_model",
    "set_mr_cache_path",
    "pick_mr_cache_folder",
    "pick_audio_files",
    "run_cache_rescue",
    "run_local_rescue",
    "analyze_key_bpm",
    "get_model_list",
    "get_model_settings",
    "list_all_models",
    "list_alignment_models",
    "check_model_ready",
    "get_active_separations",
    "get_separation_info",
    "check_mr_separated",
    "start_mr_separation",
    "cancel_separation",
    "play_track",
    "toggle_playback",
    "stop_playback",
    "seek_to",
    "set_volume",
    "set_pitch",
    "set_tempo",
    "set_master_volume",
    "set_vocal_balance",
    "toggle_ai_feature",
    "load_lrc_file",
    "save_lrc_file",
    "run_forced_alignment",
    "cancel_forced_alignment",
    "delete_mr",
    "get_waveform_summary",
    "update_custom_dictionary",
    "sync_dictionary_to_db",
    "add_category",
    "delete_category",
    "map_track_to_categories",
  ]);

  if (always.has(command)) return true;
  if (path && isPromoSongPath(path)) return true;
  return false;
}

/**
 * Handle a Tauri command in promo mode. Returns `{ handled, value }`.
 */
export async function tryHandleDemoInvoke(command, args = {}) {
  if (!shouldHandleCommand(command, args)) {
    return { handled: false };
  }

  switch (command) {
    case "get_waveform_summary": {
      const audioPath = args.audioPath || args.audio_path || args.path;
      const song = findSessionSong(audioPath);
      const durationSec = parsePromoDurationMs(song?.duration) / 1000;
      // The real command prefers the separated vocal stem when one exists.
      const isVocalOnly = !!(song?.isSeparated || song?.is_separated || song?.isMr || song?.is_mr);
      return {
        handled: true,
        value: {
          points: buildDemoWaveform(audioPath, durationSec, { isVocalOnly }),
          duration_sec: durationSec,
          durationSec,
        },
      };
    }

    case "play_track":
      await demoPlayTrack(args.path, args.durationMs || args.duration_ms || 0, args.playNow !== false);
      return { handled: true, value: playDurationMs };

    case "toggle_playback":
      return { handled: true, value: await demoTogglePlayback() };

    case "stop_playback":
      await demoStopPlayback();
      return { handled: true, value: true };

    case "seek_to":
      await demoSeekTo(args.positionMs ?? args.position_ms ?? 0);
      return { handled: true, value: true };

    case "set_volume":
    case "set_pitch":
    case "set_tempo":
    case "set_master_volume":
    case "set_vocal_balance":
    case "toggle_ai_feature":
      return { handled: true, value: true };

    case "start_mr_separation":
      await demoStartSeparation(args.path, args.modelId || args.model_id);
      return { handled: true, value: true };

    case "cancel_separation":
      await demoCancelSeparation(args.path);
      return { handled: true, value: true };

    case "check_mr_separated": {
      const song = findSessionSong(args.path);
      return {
        handled: true,
        value: !!(song?.isMr || song?.is_mr || song?.isSeparated || song?.is_separated),
      };
    }

    case "get_active_separations":
      return {
        handled: true,
        value: [...separationJobs.keys()].map((path) => ({
          path,
          percentage: 0,
          status: "Processing",
        })),
      };

    case "get_separation_info":
      return {
        handled: true,
        value: { hasMr: false, models: ["demo-htdemucs"], defaultModel: "demo-htdemucs" },
      };

    case "delete_mr": {
      const song = findSessionSong(args.path);
      if (song) {
        song.isMr = false;
        song.is_mr = false;
        song.isSeparated = false;
        song.is_separated = false;
      }
      return { handled: true, value: true };
    }

    case "load_lrc_file":
      return { handled: true, value: getPromoLyrics(args.audioPath || args.audio_path || args.path) };

    case "save_lrc_file": {
      const audioPath = args.audioPath || args.audio_path || args.path;
      setPromoLyrics(audioPath, args.content || args.lrc || "");
      const song = findSessionSong(audioPath);
      if (song) {
        song.hasLyrics = true;
        song.has_lyrics = true;
        if (!song.lyricSyncStatus || song.lyricSyncStatus === "none") {
          song.lyricSyncStatus = "unsynced";
        }
      }
      return { handled: true, value: true };
    }

    case "run_forced_alignment":
      return {
        handled: true,
        value: await demoRunForcedAlignment(
          args.audioPath || args.audio_path || args.path,
          args.lyrics || ""
        ),
      };

    case "cancel_forced_alignment":
      await demoCancelForcedAlignment();
      return { handled: true, value: true };

    case "get_model_list":
      // alignment-model.js expects "display|path" strings containing model folders.
      return {
        handled: true,
        value: [
          "Demo Korean|/demo/models/wav2vec2-korean-lyrics",
          "Demo English|/demo/models/wav2vec2-english-lyrics",
        ],
      };

    case "list_alignment_models":
      return {
        handled: true,
        value: [
          { id: "demo-ko", name: "Demo Korean", language: "ko", installed: true, folder: "wav2vec2-korean-lyrics" },
          { id: "demo-en", name: "Demo English", language: "en", installed: true, folder: "wav2vec2-english-lyrics" },
        ],
      };

    case "get_model_settings":
      return { handled: true, value: "demo-htdemucs" };

    case "list_all_models":
      return {
        handled: true,
        value: [{ id: "demo-htdemucs", name: "Demo HTDemucs", installed: true }],
      };

    case "check_model_ready":
      return { handled: true, value: true };

    case "load_library":
    case "get_songs": {
      const { state } = await import("./state.js");
      return { handled: true, value: [...(state.songLibrary || [])] };
    }

    case "save_library":
      // Session already mutates in place; ignore persistence.
      return { handled: true, value: true };

    case "update_song_metadata": {
      const song = args.song || args;
      if (song?.path) upsertSessionSong(song);
      return { handled: true, value: true };
    }

    case "delete_song":
      removeSessionSong(args.path);
      return { handled: true, value: true };

    case "get_genres":
      return {
        handled: true,
        value: getPromoGenres().map((name) => ({ name })),
      };

    case "get_categories":
      return {
        handled: true,
        value: getPromoCategories().map((name) => ({ name })),
      };

    case "add_category":
    case "delete_category":
    case "map_track_to_categories":
    case "update_custom_dictionary":
    case "sync_dictionary_to_db":
      return { handled: true, value: true };

    case "search_track_metadata":
      return {
        handled: true,
        value: [
          {
            title: "Celebrity",
            artist: "아이유",
            album: "Demo Album",
            thumbnail: "assets/images/Thumb_Music.png",
          },
          {
            title: "Dynamite",
            artist: "BTS",
            album: "Demo Album",
            thumbnail: "assets/images/Thumb_Music.png",
          },
        ],
      };

    case "youtube_metadata_fetcher":
    case "get_audio_metadata":
      return {
        handled: true,
        value: {
          path: args.url || args.path || `promo://song/new-${Date.now()}`,
          title: "데모 추가곡",
          artist: "Demo Artist",
          thumbnail: "assets/images/Thumb_Music.png",
          duration: "3:30",
          source: "youtube",
          genre: "K-POP",
          tags: ["데모"],
          categories: ["인기"],
          isMr: false,
          isSeparated: false,
          lyricSyncStatus: "none",
          hasLyrics: false,
          playCount: 0,
          dateAdded: Date.now(),
        },
      };

    case "analyze_key_bpm":
      return { handled: true, value: { key: "C", bpm: 120 } };

    case "pick_audio_files":
      return { handled: true, value: [] };

    case "export_backup":
    case "import_backup":
    case "export_library_spreadsheet":
    case "import_library_spreadsheet":
    case "download_ai_model":
    case "delete_ai_model":
    case "download_alignment_model":
    case "delete_alignment_model":
    case "set_mr_cache_path":
    case "pick_mr_cache_folder":
    case "run_cache_rescue":
    case "run_local_rescue":
      return { handled: true, value: true };

    // Overlay preview still goes to real overlay server when available —
    // not intercepted here so preview iframe can update.
    default:
      return { handled: false };
  }
}
