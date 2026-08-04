/**
 * screenshot-library.js - Promo/screenshot demo session (in-memory only)
 *
 * Typing `#promo` toggles a full interactive demo library for marketing.
 * Never persisted to DB / backup / export.
 */

export const PROMO_SECRET_KEY = "#promo";

let promoModeActive = false;
/** @type {object[]|null} */
let sessionSongs = null;
/** @type {object[]|null} */
let originalLibraryBackup = null;
/** @type {Map<string, string>} path -> LRC text */
const sessionLyrics = new Map();

const DEMO_THUMB = "assets/images/Thumb_Music.png";

/** Square album artwork resolved from Apple Music. */
const PROMO_ALBUM_ART = Object.freeze({
  dynamite: "https://is1-ssl.mzstatic.com/image/thumb/Music126/v4/03/8d/0e/038d0e52-e96d-f386-b8eb-9f77fa013543/195497146918_Cover.jpg/600x600bb.jpg",
  springDay: "https://is1-ssl.mzstatic.com/image/thumb/Music116/v4/ce/fb/eb/cefbebd4-d53b-8d6c-33cf-2ee55408bd79/8804775077494_Cover.jpg/600x600bb.jpg",
  throughTheNight: "https://is1-ssl.mzstatic.com/image/thumb/Music114/v4/dc/12/fe/dc12fe03-172b-a843-0d96-12819fa05b6c/cover-.jpg/600x600bb.jpg",
  celebrity: "https://is1-ssl.mzstatic.com/image/thumb/Music125/v4/35/9f/83/359f83b3-1423-3153-1641-98e948b7fc65/cover_-_EDAM_5_LILAC.jpg/600x600bb.jpg",
  loveDive: "https://is1-ssl.mzstatic.com/image/thumb/Music112/v4/67/f8/16/67f8164a-bfc2-f29b-e241-800426a968ef/cover_KM0015013_1.jpg/600x600bb.jpg",
  afterLike: "https://is1-ssl.mzstatic.com/image/thumb/Music122/v4/f0/5f/11/f05f1119-8992-ba35-1e97-20213a637870/cover_KM0015998_1.jpg/600x600bb.jpg",
  nextLevel: "https://is1-ssl.mzstatic.com/image/thumb/Music125/v4/60/8d/ac/608dacc2-d6d6-462d-26f0-d693e4364751/artwork.jpg/600x600bb.jpg",
  supernova: "https://is1-ssl.mzstatic.com/image/thumb/Music221/v4/d5/3f/af/d53faff0-5395-5520-f450-8ca8bedf057b/888735949180.png/600x600bb.jpg",
  anySong: "https://is1-ssl.mzstatic.com/image/thumb/Music114/v4/14/1e/87/141e87bd-a541-e26a-bc74-c586d3e68d75/ZICO_cover_4000px.jpg/600x600bb.jpg",
  eight: "https://is1-ssl.mzstatic.com/image/thumb/Music125/v4/6b/65/4d/6b654d71-ed85-c6c4-8fe2-ef3d8e9f2ee0/cover_-.jpg/600x600bb.jpg",
  ditto: "https://is1-ssl.mzstatic.com/image/thumb/Music112/v4/f6/29/42/f629426e-92fe-535c-cbe4-76e70850819b/196922287107_Cover.jpg/600x600bb.jpg",
  apt: "https://is1-ssl.mzstatic.com/image/thumb/Music221/v4/d8/3c/e4/d83ce45f-3d8c-ba71-aaec-a98e8eeabe7d/075679628138_cover.jpg/600x600bb.jpg",
});

/** Curated popular Korean tracks for screenshot demos. */
export const PROMO_SONGS = Object.freeze([
  {
    path: "promo://song/01-dynamite",
    title: "Dynamite",
    artist: "BTS",
    genre: "K-POP",
    categories: ["인기"],
    tags: ["아이돌", "댄스"],
    duration: "3:19",
    source: "youtube",
    thumbnail: PROMO_ALBUM_ART.dynamite,
    isMr: true,
    isSeparated: true,
    lyricSyncStatus: "synced",
    hasLyrics: true,
    playCount: 42,
    dateAdded: 1_700_000_000_000,
    pitch: 0,
    tempo: 1.0,
    volume: 80,
  },
  {
    path: "promo://song/02-spring-day",
    title: "봄날",
    artist: "BTS",
    genre: "K-POP",
    categories: ["감성"],
    tags: ["아이돌", "발라드"],
    duration: "4:34",
    source: "youtube",
    thumbnail: PROMO_ALBUM_ART.springDay,
    isMr: true,
    isSeparated: true,
    lyricSyncStatus: "synced",
    hasLyrics: true,
    playCount: 38,
    dateAdded: 1_700_000_100_000,
    pitch: 0,
    tempo: 1.0,
    volume: 80,
  },
  {
    path: "promo://song/03-through-the-night",
    title: "밤편지",
    artist: "아이유",
    genre: "Ballad",
    categories: ["감성"],
    tags: ["솔로", "힐링"],
    duration: "4:13",
    source: "local",
    thumbnail: PROMO_ALBUM_ART.throughTheNight,
    isMr: true,
    isSeparated: true,
    lyricSyncStatus: "synced",
    hasLyrics: true,
    playCount: 55,
    dateAdded: 1_700_000_200_000,
    pitch: 0,
    tempo: 1.0,
    volume: 80,
  },
  {
    path: "promo://song/04-celebrity",
    title: "Celebrity",
    artist: "아이유",
    genre: "K-POP",
    categories: ["인기"],
    tags: ["솔로", "팝"],
    duration: "3:15",
    source: "youtube",
    thumbnail: PROMO_ALBUM_ART.celebrity,
    isMr: false,
    isSeparated: false,
    lyricSyncStatus: "unsynced",
    hasLyrics: true,
    playCount: 29,
    dateAdded: 1_700_000_300_000,
    pitch: 0,
    tempo: 1.0,
    volume: 80,
  },
  {
    path: "promo://song/05-love-dive",
    title: "LOVE DIVE",
    artist: "IVE",
    genre: "K-POP",
    categories: ["인기"],
    tags: ["아이돌", "댄스"],
    duration: "2:57",
    source: "youtube",
    thumbnail: PROMO_ALBUM_ART.loveDive,
    isMr: true,
    isSeparated: true,
    lyricSyncStatus: "synced",
    hasLyrics: true,
    playCount: 47,
    dateAdded: 1_700_000_400_000,
    pitch: 0,
    tempo: 1.0,
    volume: 80,
  },
  {
    path: "promo://song/06-after-like",
    title: "After LIKE",
    artist: "IVE",
    genre: "K-POP",
    categories: ["인기"],
    tags: ["아이돌", "댄스"],
    duration: "2:56",
    source: "youtube",
    thumbnail: PROMO_ALBUM_ART.afterLike,
    isMr: true,
    isSeparated: true,
    lyricSyncStatus: "synced",
    hasLyrics: true,
    playCount: 33,
    dateAdded: 1_700_000_500_000,
    pitch: 0,
    tempo: 1.0,
    volume: 80,
  },
  {
    path: "promo://song/07-next-level",
    title: "Next Level",
    artist: "aespa",
    genre: "K-POP",
    categories: ["인기"],
    tags: ["아이돌", "댄스"],
    duration: "3:41",
    source: "youtube",
    thumbnail: PROMO_ALBUM_ART.nextLevel,
    isMr: false,
    isSeparated: false,
    lyricSyncStatus: "unsynced",
    hasLyrics: true,
    playCount: 31,
    dateAdded: 1_700_000_600_000,
    pitch: 0,
    tempo: 1.0,
    volume: 80,
  },
  {
    path: "promo://song/08-supernova",
    title: "Supernova",
    artist: "aespa",
    genre: "K-POP",
    categories: ["인기"],
    tags: ["아이돌", "댄스"],
    duration: "2:58",
    source: "youtube",
    thumbnail: PROMO_ALBUM_ART.supernova,
    isMr: true,
    isSeparated: true,
    lyricSyncStatus: "synced",
    hasLyrics: true,
    playCount: 40,
    dateAdded: 1_700_000_700_000,
    pitch: 0,
    tempo: 1.0,
    volume: 80,
  },
  {
    path: "promo://song/09-any-song",
    title: "아무노래",
    artist: "지코",
    genre: "Hip-Hop",
    categories: ["인기"],
    tags: ["힙합", "챌린지"],
    duration: "3:47",
    source: "local",
    thumbnail: PROMO_ALBUM_ART.anySong,
    isMr: true,
    isSeparated: true,
    lyricSyncStatus: "synced",
    hasLyrics: true,
    playCount: 36,
    dateAdded: 1_700_000_800_000,
    pitch: 0,
    tempo: 1.0,
    volume: 80,
  },
  {
    path: "promo://song/10-eight",
    title: "에잇 (Prod. & Feat. SUGA of BTS)",
    artist: "아이유",
    genre: "Ballad",
    categories: ["감성"],
    tags: ["콜라보", "힐링"],
    duration: "2:47",
    source: "youtube",
    thumbnail: PROMO_ALBUM_ART.eight,
    isMr: false,
    isSeparated: false,
    lyricSyncStatus: "none",
    hasLyrics: false,
    playCount: 22,
    dateAdded: 1_700_000_900_000,
    pitch: 0,
    tempo: 1.0,
    volume: 80,
  },
  {
    path: "promo://song/11-ditto",
    title: "Ditto",
    artist: "NewJeans",
    genre: "K-POP",
    categories: ["인기"],
    tags: ["아이돌", "감성"],
    duration: "3:05",
    source: "youtube",
    thumbnail: PROMO_ALBUM_ART.ditto,
    isMr: true,
    isSeparated: true,
    lyricSyncStatus: "synced",
    hasLyrics: true,
    playCount: 51,
    dateAdded: 1_700_001_000_000,
    pitch: 0,
    tempo: 1.0,
    volume: 80,
  },
  {
    path: "promo://song/12-apt",
    title: "APT.",
    artist: "로제, Bruno Mars",
    genre: "K-POP",
    categories: ["인기"],
    tags: ["콜라보", "팝"],
    duration: "2:49",
    source: "youtube",
    thumbnail: PROMO_ALBUM_ART.apt,
    isMr: true,
    isSeparated: true,
    lyricSyncStatus: "synced",
    hasLyrics: true,
    playCount: 60,
    dateAdded: 1_700_001_100_000,
    pitch: 0,
    tempo: 1.0,
    volume: 80,
  },
]);

/** Sample LRC bodies keyed by path. Synced songs have timestamps; unsynced have plain lines. */
export const PROMO_LYRICS_TEMPLATES = Object.freeze({
  "promo://song/01-dynamite": `[00:12.00]Cos ah ah I'm in the stars tonight
[00:16.00]So watch me bring the fire and set the night alight
[00:22.00]Shoes on, get up off the floor
[00:26.00]Dance with me and we'll be forevermore
[00:32.00]Oh light it up like dynamite`,
  "promo://song/02-spring-day": `[00:18.00]보고 싶다
[00:22.00]이렇게 말하니까 더 보고 싶다
[00:28.00]너희 사진을 보고 있어도
[00:34.00]보고 싶다
[00:40.00]너무 야속한 시간`,
  "promo://song/03-through-the-night": `[00:20.00]이 밤 그날의 반딧불을
[00:26.00]당신의 창 가까이 보낼게요
[00:34.00]음 사랑한다는 말이에요
[00:42.00]나 우리의 첫 입맞춤을 떠올려
[00:50.00]그럼 언제든 눈을 감고 미소 짓게 돼`,
  "promo://song/04-celebrity": `세계의 네온 아래
나는 또 다른 내가 돼
Everybody say Celebrity
빛나는 이름 뒤에`,
  "promo://song/05-love-dive": `[00:10.00]네 맘에 dive in
[00:14.00]숨 참고 love dive
[00:18.00]Babe 숨이 막힐 듯한 너
[00:24.00]내게로 와
[00:28.00]Lalala love dive`,
  "promo://song/06-after-like": `[00:08.00]You got me looking for attention
[00:14.00]After like after like
[00:20.00]맘이 붕 떠서 감각이 없어
[00:26.00]After like after like`,
  "promo://song/07-next-level": `I'm on the Next Level yeah
절대적 그 규칙들을 비웃어
내 손을 잡아 더 높이
Jump up to the next`,
  "promo://song/08-supernova": `[00:12.00]Supernova
[00:16.00]붐 카타스트로피
[00:22.00]내 심장이 터질 것만 같아
[00:28.00]Uh uh supernova`,
  "promo://song/09-any-song": `[00:15.00]왜들 그리 다운돼있어
[00:20.00]뭐가 문제야 say something
[00:26.00]아무노래나 일단 틀어
[00:32.00]아무거나 신나는 걸로`,
  "promo://song/11-ditto": `[00:14.00]Stay in the middle
[00:18.00]Like you a little
[00:22.00]Don't want no riddle
[00:28.00]말해줘 say it back
[00:34.00]Oh say it ditto`,
  "promo://song/12-apt": `[00:10.00]아파트 apartment
[00:14.00]아파트 apartment
[00:18.00]Uh uh uh uh
[00:22.00]아파트 apartment
[00:28.00]Kissy face kissy face`,
});

function cloneSong(song) {
  return {
    ...song,
    tags: Array.isArray(song.tags) ? [...song.tags] : [],
    categories: Array.isArray(song.categories) ? [...song.categories] : [],
  };
}

function formatLrcTime(sec) {
  const m = Math.floor(sec / 60);
  const s = Math.max(0, sec - m * 60);
  return `[${String(m).padStart(2, "0")}:${s.toFixed(2).padStart(5, "0")}]`;
}

const PROMO_LRC_LINE = /^\[(\d{1,2}):(\d{2}(?:\.\d{1,3})?)\]\s*(.+)$/;

/**
 * Keeps the hand-written opening LRC intact and fills any remaining gap up to
 * the 30% demo snapshot. Plain-text templates intentionally stay plain so the
 * unsynced-song examples continue to demonstrate their original state.
 */
export function buildPromoSyncLrc(template, duration) {
  const source = String(template || "");
  const parsed = source.split(/\r?\n/).map((raw) => {
    const match = PROMO_LRC_LINE.exec(raw.trim());
    if (!match) return null;
    return {
      time: Number(match[1]) * 60 + Number(match[2]),
      text: match[3].trim(),
    };
  }).filter(Boolean);

  if (parsed.length < 2 || parsed.length !== source.split(/\r?\n/).filter((line) => line.trim()).length) {
    return source;
  }

  const durationSec = parsePromoDurationMs(duration) / 1000;
  const coverageEnd = durationSec * 0.3;
  const gaps = parsed.slice(1).map((line, i) => line.time - parsed[i].time).filter((gap) => gap > 0);
  const averageGap = gaps.length
    ? gaps.reduce((sum, gap) => sum + gap, 0) / gaps.length
    : 4;
  const step = Math.min(7, Math.max(3.5, averageGap));
  const out = [...parsed];
  let nextTime = parsed.at(-1).time + step;
  let textIndex = 0;

  while (nextTime <= coverageEnd) {
    out.push({
      time: nextTime,
      text: parsed[textIndex % parsed.length].text,
    });
    textIndex += 1;
    nextTime += step;
  }

  // Ensure the active line reaches the snapshot even when the last regular
  // interval falls just short of it.
  if (out.at(-1).time < coverageEnd - 1) {
    out.push({
      time: Math.max(out.at(-1).time + 0.5, coverageEnd - 0.5),
      text: parsed[textIndex % parsed.length].text,
    });
  }

  return out.map((line) => `${formatLrcTime(line.time)}${line.text}`).join("\n");
}

/**
 * The lyrics overlay only renders the current and next line. These two-line
 * excerpts are positioned around the fixed 30% promo playback snapshot.
 */
export const PROMO_OVERLAY_LINES = Object.freeze({
  "promo://song/01-dynamite": ["Cos ah ah I'm in the stars tonight", "Oh light it up like dynamite"],
  "promo://song/02-spring-day": ["보고 싶다", "이렇게 말하니까 더 보고 싶다"],
  "promo://song/03-through-the-night": ["이 밤 그날의 반딧불을", "당신의 창 가까이 보낼게요"],
  "promo://song/04-celebrity": ["Everybody say Celebrity", "빛나는 이름 뒤에"],
  "promo://song/05-love-dive": ["네 맘에 dive in", "숨 참고 love dive"],
  "promo://song/06-after-like": ["You got me looking for attention", "After like after like"],
  "promo://song/07-next-level": ["I'm on the Next Level yeah", "절대적 그 규칙들을 비웃어"],
  "promo://song/08-supernova": ["Supernova", "붐 카타스트로피"],
  "promo://song/09-any-song": ["왜들 그리 다운돼있어", "뭐가 문제야 say something"],
  "promo://song/10-eight": ["우리는 오렌지 태양 아래", "그림자 없이 함께 춤을 춰"],
  "promo://song/11-ditto": ["Stay in the middle", "Like you a little"],
  "promo://song/12-apt": ["아파트 apartment", "아파트 apartment"],
});

export function buildPromoOverlayLrc(path, duration) {
  const lines = PROMO_OVERLAY_LINES[path];
  if (!lines) return "";
  const durationSec = parsePromoDurationMs(duration) / 1000;
  return [
    `${formatLrcTime(durationSec * 0.26)}${lines[0]}`,
    `${formatLrcTime(durationSec * 0.34)}${lines[1]}`,
  ].join("\n");
}

function seedSessionLyrics(songs) {
  sessionLyrics.clear();
  for (const song of songs) {
    // Sync editor / LRC file covers the populated first 30% of synced tracks.
    const body = buildPromoSyncLrc(PROMO_LYRICS_TEMPLATES[song.path], song.duration);
    if (body) sessionLyrics.set(song.path, body);
  }
}

/** Fill both AI task sections with five screenshot-ready demo entries. */
export function seedPromoAiQueues(state, songs = PROMO_SONGS) {
  const byIndex = (indexes) => indexes.map((i) => songs[i]).filter(Boolean);
  const separationSongs = byIndex([3, 6, 9, 7, 8]);
  const alignmentSongs = byIndex([0, 1, 2, 4, 10]);

  state.activeTasks = Object.fromEntries(separationSongs.map((song, i) => [
    song.path,
    {
      title: song.title,
      thumbnail: song.thumbnail,
      percentage: i === 0 ? 30 : 0,
      status: i === 0 ? "Processing" : "Queued",
      provider: "Demo GPU",
      model: "demo-htdemucs",
    },
  ]));

  state.alignmentQueue = alignmentSongs.map((song, i) => ({
    path: song.path,
    title: song.title,
    thumbnail: song.thumbnail,
    status: i === 0 ? "processing" : "queued",
    phase: i === 0 ? "aligning" : "queued",
    percentage: i === 0 ? 30 : 0,
    passLabel: i === 0 ? "1차 정렬" : "",
  }));
}

/** Exact match after trim; case-insensitive for the keyword portion. */
export function isPromoSecretKey(query) {
  const normalized = String(query || "").trim().toLowerCase();
  return normalized === PROMO_SECRET_KEY.toLowerCase();
}

export function isPromoModeActive() {
  return promoModeActive;
}

export function isPromoSongPath(path) {
  return typeof path === "string" && path.startsWith("promo://");
}

/** Shallow copies of the frozen templates (does not touch the live session). */
export function getPromoSongs() {
  return PROMO_SONGS.map(cloneSong);
}

export function getSessionSongs() {
  return sessionSongs;
}

export function findSessionSong(path) {
  if (!sessionSongs) return null;
  return sessionSongs.find((s) => s.path === path) || null;
}

/** Alignment-sync / LRC-file body (sample verses). */
export function getPromoLyrics(path) {
  if (!path) return "";
  if (sessionLyrics.has(path)) return sessionLyrics.get(path);
  const song = PROMO_SONGS.find((s) => s.path === path);
  return buildPromoSyncLrc(PROMO_LYRICS_TEMPLATES[path], song?.duration);
}

/** Overlay-only: two chorus lines timed around the 30% playback snapshot. */
export function getPromoOverlayLyrics(path) {
  if (!path) return "";
  const song = findSessionSong(path) || PROMO_SONGS.find((s) => s.path === path);
  return buildPromoOverlayLrc(path, song?.duration);
}

export function setPromoLyrics(path, content) {
  if (!path) return;
  sessionLyrics.set(path, String(content || ""));
}

export function getPromoGenres() {
  const songs = sessionSongs || PROMO_SONGS;
  return [...new Set(songs.map((s) => s.genre).filter(Boolean))];
}

export function getPromoCategories() {
  const songs = sessionSongs || PROMO_SONGS;
  const set = new Set();
  for (const s of songs) {
    (s.categories || []).forEach((c) => set.add(c));
    if (s.category) set.add(s.category);
  }
  return [...set];
}

export function parsePromoDurationMs(duration) {
  if (typeof duration === "number" && Number.isFinite(duration) && duration > 0) {
    return Math.floor(duration * 1000);
  }
  if (typeof duration !== "string") return 180000;
  const parts = duration.trim().split(":").map((p) => Number.parseInt(p, 10));
  if (parts.some((p) => Number.isNaN(p) || p < 0)) return 180000;
  if (parts.length === 2) return ((parts[0] * 60) + parts[1]) * 1000;
  if (parts.length === 3) return ((parts[0] * 3600) + (parts[1] * 60) + parts[2]) * 1000;
  return 180000;
}

/**
 * Enter promo mode: swap state.songLibrary with a mutable session copy.
 * Real library is kept in memory and restored on exit.
 */
export async function activatePromoSession() {
  if (promoModeActive) return true;
  const { state } = await import("./state.js");
  const { stopAllDemoActivity } = await import("./promo-demo.js");

  await stopAllDemoActivity();
  // Silence real playback first: its 100ms progress ticker keeps running while
  // a duration is loaded and would compete with the demo playhead.
  try {
    const { invoke } = await import("./tauri-bridge.js");
    await invoke("stop_playback");
  } catch (err) {
    console.warn("[Promo] stop_playback before activation failed:", err);
  }
  originalLibraryBackup = Array.isArray(state.songLibrary) ? [...state.songLibrary] : [];
  sessionSongs = PROMO_SONGS.map(cloneSong);
  seedSessionLyrics(sessionSongs);
  state.songLibrary = sessionSongs;
  seedPromoAiQueues(state, sessionSongs);
  state.selectedLibraryPaths.clear();
  state.librarySelectMode = false;
  state.currentTrack = null;
  state.isPlaying = false;
  state.isLoading = false;
  state.currentLyrics = [];
  state.currentLyricIndex = -1;
  state.filteredTracks = [];
  promoModeActive = true;
  return true;
}

/** Leave promo mode and restore the real library. */
export async function deactivatePromoSession() {
  if (!promoModeActive) return false;
  const { state } = await import("./state.js");
  const { stopAllDemoActivity } = await import("./promo-demo.js");

  await stopAllDemoActivity();
  state.songLibrary = originalLibraryBackup || [];
  originalLibraryBackup = null;
  sessionSongs = null;
  sessionLyrics.clear();
  state.activeTasks = {};
  state.alignmentQueue = [];
  state.selectedLibraryPaths.clear();
  state.librarySelectMode = false;
  state.currentTrack = null;
  state.isPlaying = false;
  state.isLoading = false;
  state.currentLyrics = [];
  state.currentLyricIndex = -1;
  state.selectedTrackIndex = -1;
  state.filteredTracks = [];
  promoModeActive = false;
  return false;
}

export async function setPromoModeActive(active) {
  if (active) return activatePromoSession();
  return deactivatePromoSession();
}

/** Flip promo mode and return the new active state. */
export async function togglePromoMode() {
  if (promoModeActive) {
    await deactivatePromoSession();
    return false;
  }
  await activatePromoSession();
  return true;
}

/** Upsert a song into the live promo session (add-song demo). */
export function upsertSessionSong(song) {
  if (!sessionSongs || !song?.path) return null;
  const idx = sessionSongs.findIndex((s) => s.path === song.path);
  const next = cloneSong(song);
  if (idx >= 0) sessionSongs[idx] = { ...sessionSongs[idx], ...next };
  else sessionSongs.push(next);
  return next;
}

export function removeSessionSong(path) {
  if (!sessionSongs) return false;
  const idx = sessionSongs.findIndex((s) => s.path === path);
  if (idx < 0) return false;
  sessionSongs.splice(idx, 1);
  sessionLyrics.delete(path);
  return true;
}
