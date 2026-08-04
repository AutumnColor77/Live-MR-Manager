import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import {
  PROMO_SECRET_KEY,
  PROMO_SONGS,
  activatePromoSession,
  deactivatePromoSession,
  getPromoLyrics,
  getPromoOverlayLyrics,
  getPromoSongs,
  isPromoModeActive,
  isPromoSecretKey,
  isPromoSongPath,
  setPromoModeActive,
  togglePromoMode,
  upsertSessionSong,
  removeSessionSong,
  findSessionSong,
} from '../src/js/screenshot-library.js';
import { filterSongLibrary } from '../src/js/library-filters.js';
import {
  clearDemoListeners,
  stopAllDemoActivity,
  subscribeDemoEvent,
  tryHandleDemoInvoke,
  demoPlayTrack,
  demoTogglePlayback,
  demoSeekTo,
  demoStartSeparation,
  demoCancelSeparation,
  demoRunForcedAlignment,
  isDemoOwnedEvent,
} from '../src/js/promo-demo.js';

describe('isPromoSecretKey', () => {
  it('matches the exact secret key', () => {
    expect(isPromoSecretKey(PROMO_SECRET_KEY)).toBe(true);
    expect(isPromoSecretKey('#promo')).toBe(true);
  });

  it('trims whitespace and ignores case', () => {
    expect(isPromoSecretKey('  #Promo  ')).toBe(true);
    expect(isPromoSecretKey('#PROMO')).toBe(true);
  });

  it('rejects partial or unrelated queries', () => {
    expect(isPromoSecretKey('#prom')).toBe(false);
    expect(isPromoSecretKey('promo')).toBe(false);
    expect(isPromoSecretKey('#promo mode')).toBe(false);
    expect(isPromoSecretKey('')).toBe(false);
    expect(isPromoSecretKey(null)).toBe(false);
  });
});

describe('promo session lifecycle', () => {
  beforeEach(async () => {
    await deactivatePromoSession();
    clearDemoListeners();
  });

  afterEach(async () => {
    await stopAllDemoActivity();
    await deactivatePromoSession();
    clearDemoListeners();
  });

  it('activates and deactivates via toggle', async () => {
    expect(isPromoModeActive()).toBe(false);
    expect(await togglePromoMode()).toBe(true);
    expect(isPromoModeActive()).toBe(true);
    expect(await togglePromoMode()).toBe(false);
    expect(isPromoModeActive()).toBe(false);
  });

  it('setPromoModeActive forces a specific state', async () => {
    await setPromoModeActive(true);
    expect(isPromoModeActive()).toBe(true);
    await setPromoModeActive(false);
    expect(isPromoModeActive()).toBe(false);
  });

  it('swaps state.songLibrary with a mutable session and restores it', async () => {
    const { state } = await import('../src/js/state.js');
    const original = [{ path: 'real://a', title: 'Real' }];
    state.songLibrary = original;

    await activatePromoSession();
    expect(state.songLibrary).toHaveLength(12);
    expect(state.songLibrary[0].path.startsWith('promo://')).toBe(true);
    expect(Object.keys(state.activeTasks)).toHaveLength(5);
    expect(state.alignmentQueue).toHaveLength(5);
    expect(Object.values(state.activeTasks).filter((task) => task.status === 'Processing')).toHaveLength(1);
    expect(state.alignmentQueue.filter((task) => task.status === 'processing')).toHaveLength(1);
    expect(Object.values(state.activeTasks).find((task) => task.status === 'Processing').percentage).toBe(30);
    expect(state.alignmentQueue.find((task) => task.status === 'processing').percentage).toBe(30);
    state.songLibrary[0].title = 'MUTATED SESSION';
    expect(PROMO_SONGS[0].title).not.toBe('MUTATED SESSION');

    await deactivatePromoSession();
    expect(state.songLibrary).toEqual(original);
    expect(state.activeTasks).toEqual({});
    expect(state.alignmentQueue).toEqual([]);
  });
});

describe('PROMO_SONGS', () => {
  it('contains exactly 12 curated tracks', () => {
    expect(PROMO_SONGS).toHaveLength(12);
  });

  it('has unique promo:// paths and required display fields', () => {
    const paths = PROMO_SONGS.map((s) => s.path);
    const thumbnails = PROMO_SONGS.map((s) => s.thumbnail);
    expect(new Set(paths).size).toBe(paths.length);
    expect(new Set(thumbnails).size).toBe(PROMO_SONGS.length);

    for (const song of PROMO_SONGS) {
      expect(isPromoSongPath(song.path)).toBe(true);
      expect(song.title).toBeTruthy();
      expect(song.artist).toBeTruthy();
      expect(song.genre).toBeTruthy();
      expect(song.duration).toMatch(/^\d+:\d{2}$/);
      expect(['youtube', 'local']).toContain(song.source);
      expect(Array.isArray(song.tags)).toBe(true);
      expect(song.tags.length).toBeGreaterThan(0);
      expect(['synced', 'unsynced', 'none']).toContain(song.lyricSyncStatus);
      expect(song.thumbnail).toMatch(/^https:\/\/is1-ssl\.mzstatic\.com\/image\/thumb\//);
    }
  });

  it('getPromoSongs returns shallow copies (immutable source)', () => {
    const copy = getPromoSongs();
    expect(copy).toHaveLength(12);
    copy[0].title = 'MUTATED';
    expect(PROMO_SONGS[0].title).not.toBe('MUTATED');
  });

  it('works with the existing library filter pipeline', () => {
    const filtered = filterSongLibrary(getPromoSongs(), {
      query: '아이유',
      sortBy: 'title',
    });
    expect(filtered.length).toBeGreaterThan(0);
    expect(filtered.every((s) => s.artist.includes('아이유'))).toBe(true);
    expect(filtered.every((s) => typeof s.originalIndex === 'number')).toBe(true);
  });

  it('fills synced sample lyrics through the 30% snapshot', () => {
    expect(getPromoLyrics('promo://song/01-dynamite').toLowerCase()).toContain('dynamite');
    expect(getPromoLyrics('promo://song/01-dynamite').split('\n').length).toBeGreaterThan(2);
    expect(getPromoLyrics('promo://song/04-celebrity')).toContain('Celebrity');
    expect(getPromoLyrics('promo://song/10-eight')).toBe('');

    for (const song of PROMO_SONGS.filter((item) => item.lyricSyncStatus === 'synced')) {
      const lines = getPromoLyrics(song.path).split('\n');
      const lastMatch = /^\[(\d{2}):(\d{2}\.\d{2})\]/.exec(lines.at(-1));
      expect(lastMatch).not.toBeNull();
      const lastTime = Number(lastMatch[1]) * 60 + Number(lastMatch[2]);
      const durationSec = song.duration.split(':').reduce((total, part) => total * 60 + Number(part), 0);
      expect(lastTime).toBeGreaterThanOrEqual(durationSec * 0.3 - 1);
      expect(lastTime).toBeLessThanOrEqual(durationSec * 0.3);
    }

    // Keep unsynced/no-lyrics examples available for management screenshots.
    expect(getPromoLyrics('promo://song/04-celebrity')).not.toMatch(/^\[\d{2}:/);
    expect(getPromoLyrics('promo://song/07-next-level')).not.toMatch(/^\[\d{2}:/);
  });

  it('provides two hardcoded overlay chorus lines around the 30% snapshot', () => {
    for (const song of PROMO_SONGS) {
      const lines = getPromoOverlayLyrics(song.path).split('\n');
      expect(lines).toHaveLength(2);

      const times = lines.map((line) => {
        const match = /^\[(\d{2}):(\d{2}\.\d{2})\]/.exec(line);
        expect(match).not.toBeNull();
        return Number(match[1]) * 60 + Number(match[2]);
      });
      const durationSec = song.duration.split(':').reduce((total, part) => total * 60 + Number(part), 0);
      expect(times[0] / durationSec).toBeCloseTo(0.26, 2);
      expect(times[1] / durationSec).toBeCloseTo(0.34, 2);
      expect(times[0]).toBeLessThan(durationSec * 0.3);
      expect(times[1]).toBeGreaterThan(durationSec * 0.3);
    }

    expect(getPromoOverlayLyrics('promo://song/01-dynamite').toLowerCase()).toContain('dynamite');
    expect(getPromoOverlayLyrics('promo://song/10-eight')).toContain('오렌지 태양');
  });
});

describe('isPromoSongPath', () => {
  it('detects promo scheme only', () => {
    expect(isPromoSongPath('promo://song/01')).toBe(true);
    expect(isPromoSongPath('/real/path.mp3')).toBe(false);
    expect(isPromoSongPath('')).toBe(false);
    expect(isPromoSongPath(undefined)).toBe(false);
  });
});

describe('promo demo adapter', () => {
  beforeEach(async () => {
    await deactivatePromoSession();
    clearDemoListeners();
    await activatePromoSession();
  });

  afterEach(async () => {
    await stopAllDemoActivity();
    await deactivatePromoSession();
    clearDemoListeners();
  });

  it('blocks real persistence commands and returns demo data', async () => {
    const save = await tryHandleDemoInvoke('save_library', { songs: [] });
    expect(save.handled).toBe(true);

    const del = await tryHandleDemoInvoke('delete_song', { path: 'promo://song/10-eight' });
    expect(del.handled).toBe(true);
    expect(findSessionSong('promo://song/10-eight')).toBeNull();

    const genres = await tryHandleDemoInvoke('get_genres', {});
    expect(genres.handled).toBe(true);
    expect(genres.value.some((g) => g.name === 'K-POP')).toBe(true);

    const meta = await tryHandleDemoInvoke('search_track_metadata', { query: '아이유' });
    expect(meta.handled).toBe(true);
    expect(meta.value.length).toBeGreaterThan(0);
  });

  it('simulates playback play/toggle/seek events', async () => {
    const { DEMO_SNAPSHOT_RATIO } = await import('../src/js/promo-demo.js');
    const progress = [];
    const status = [];
    subscribeDemoEvent('playback-progress', (e) => progress.push(e.payload));
    subscribeDemoEvent('playback-status', (e) => status.push(e.payload.status));

    await demoPlayTrack('promo://song/01-dynamite', 10000, true);
    expect(status.at(-1)).toMatch(/playing/i);
    expect(progress.at(-1).positionMs).toBe(Math.floor(10000 * DEMO_SNAPSHOT_RATIO));

    // Seek is ignored — screenshot lock stays at ~30%.
    await demoSeekTo(2500);
    expect(progress.at(-1).positionMs).toBe(Math.floor(10000 * DEMO_SNAPSHOT_RATIO));

    const playing = await demoTogglePlayback();
    expect(playing).toBe(false);
    expect(status.at(-1)).toMatch(/paused/i);
  });

  it('parks MR separation progress near 30%', async () => {
    vi.useFakeTimers();
    const events = [];
    subscribeDemoEvent('separation-progress', (e) => events.push(e.payload));

    const path = 'promo://song/04-celebrity';
    await demoStartSeparation(path, 'demo-htdemucs');
    await vi.advanceTimersByTimeAsync(2000);

    expect(events.some((e) => e.status === 'Processing')).toBe(true);
    expect(events.at(-1).status).toBe('Processing');
    expect(events.at(-1).percentage).toBe(30);
    expect(findSessionSong(path)?.isSeparated).toBe(false);
    vi.useRealTimers();
  });

  it('cancels an in-flight separation', async () => {
    vi.useFakeTimers();
    const events = [];
    subscribeDemoEvent('separation-progress', (e) => events.push(e.payload));

    const path = 'promo://song/07-next-level';
    await demoStartSeparation(path, 'demo');
    await vi.advanceTimersByTimeAsync(500);
    await demoCancelSeparation(path);
    expect(events.at(-1).status).toBe('Cancelled');
    vi.useRealTimers();
  });

  it('simulates forced alignment with start_ms matching lyric text', async () => {
    const result = await demoRunForcedAlignment(
      'promo://song/04-celebrity',
      '세계의 네온 아래\n나는 또 다른 내가 돼'
    );
    expect(result.lines).toHaveLength(2);
    expect(result.lines[0]).toMatchObject({
      text: '세계의 네온 아래',
      start_ms: expect.any(Number),
      end_ms: expect.any(Number),
    });
    expect(findSessionSong('promo://song/04-celebrity')?.lyricSyncStatus).toBe('synced');
  });

  it('upserts and removes session songs for edit/add/delete demos', async () => {
    upsertSessionSong({
      path: 'promo://song/custom',
      title: '커스텀',
      artist: 'Tester',
      genre: 'K-POP',
      tags: ['데모'],
      categories: ['인기'],
      duration: '3:00',
      source: 'local',
      thumbnail: 'assets/images/Thumb_Music.png',
    });
    expect(findSessionSong('promo://song/custom')?.title).toBe('커스텀');
    removeSessionSong('promo://song/custom');
    expect(findSessionSong('promo://song/custom')).toBeNull();
  });

  it('builds a realistic waveform summary aligned to lyric phrases', async () => {
    const { buildDemoWaveform } = await import('../src/js/promo-demo.js');
    const path = 'promo://song/01-dynamite';

    const res = await tryHandleDemoInvoke('get_waveform_summary', { audioPath: path });
    expect(res.handled).toBe(true);
    expect(res.value.points).toHaveLength(2000);
    expect(res.value.duration_sec).toBeCloseTo(199, 0);

    const points = res.value.points;
    const peak = Math.max(...points.map(([min, max]) => Math.max(max, -min)));
    expect(peak).toBeGreaterThan(0.9);
    expect(peak).toBeLessThanOrEqual(1);
    expect(points.every(([min, max]) => min <= 0 && max >= 0)).toBe(true);

    const levels = points.map(([min, max]) => Math.max(max, -min));
    // Grainy, not a smooth analytic curve.
    const jagged = levels.filter((v, i) => i > 0 && Math.abs(v - levels[i - 1]) > 0.005).length;
    expect(jagged).toBeGreaterThan(levels.length * 0.4);

    // Separated (vocal-only) track: sung phrases with near-silent gaps, and
    // singing continues across the whole track rather than only the intro.
    expect(levels.filter((v) => v < 0.1).length).toBeGreaterThan(100);
    expect(levels.filter((v) => v > 0.5).length).toBeGreaterThan(100);
    const lastQuarter = levels.slice(Math.floor(levels.length * 0.7), Math.floor(levels.length * 0.9));
    expect(Math.max(...lastQuarter)).toBeGreaterThan(0.4);

    // Deterministic per path.
    expect(buildDemoWaveform(path, 199, { isVocalOnly: true })).toEqual(points);

    // Un-separated track keeps a continuous full-mix bed instead.
    const mix = buildDemoWaveform('promo://song/04-celebrity', 195, { isVocalOnly: false });
    const mixLevels = mix.map(([min, max]) => Math.max(max, -min));
    const quietRatio = mixLevels.filter((v) => v < 0.1).length / mixLevels.length;
    expect(quietRatio).toBeLessThan(0.1);
  });

  it('feeds the overlay both chorus lines at the demo playhead', async () => {
    const { buildDemoOverlayPayload, DEMO_SNAPSHOT_RATIO } = await import('../src/js/promo-demo.js');
    const path = 'promo://song/01-dynamite';
    const durationMs = 199_000;

    const payload = buildDemoOverlayPayload(path, durationMs * DEMO_SNAPSHOT_RATIO);
    expect(payload.lines).toHaveLength(2);
    expect(payload.index).toBe(0);
    expect(payload.current.toLowerCase()).toContain('stars tonight');
    expect(payload.next.toLowerCase()).toContain('dynamite');
    expect(payload.song.title).toBe('Dynamite');

    expect(buildDemoOverlayPayload('/real/song.mp3', 1000)).toBeNull();
  });

  it('loads every sample line into the promo lyric drawer', async () => {
    const { loadLyricsForTrack } = await import('../src/js/lyrics.js');
    const path = 'promo://song/01-dynamite';
    const drawerLyrics = await loadLyricsForTrack(path, 199);
    const sampleLineCount = getPromoLyrics(path).split('\n').filter(Boolean).length;

    expect(drawerLyrics).toHaveLength(sampleLineCount);
    expect(drawerLyrics.length).toBeGreaterThan(2);
    expect(drawerLyrics.at(-1).start).toBeGreaterThanOrEqual(58);
  });

  it('blocks real backend events the demo simulates itself', async () => {
    expect(isDemoOwnedEvent('playback-progress')).toBe(true);
    expect(isDemoOwnedEvent('playback-status')).toBe(true);
    expect(isDemoOwnedEvent('separation-progress')).toBe(true);
    expect(isDemoOwnedEvent('alignment-progress')).toBe(true);
    expect(isDemoOwnedEvent('library-updated')).toBe(false);

    await deactivatePromoSession();
    expect(isDemoOwnedEvent('playback-progress')).toBe(false);
  });

  it('returns alignment model list in display|path format', async () => {
    const res = await tryHandleDemoInvoke('get_model_list', {});
    expect(res.handled).toBe(true);
    expect(res.value.some((m) => String(m).includes('wav2vec2-korean-lyrics'))).toBe(true);
  });
});
