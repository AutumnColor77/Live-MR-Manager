import { describe, expect, it } from 'vitest';
import { filterSongLibrary, getLyricSyncStatus } from '../src/js/library-filters.js';

const sampleSongs = [
  { title: 'Alpha', artist: 'A', source: 'youtube', genre: 'POP', dateAdded: 2, playCount: 1, path: 'a' },
  { title: 'Beta', artist: 'B', source: 'local', genre: 'Ballad', dateAdded: 1, playCount: 5, path: 'b' },
  { title: 'Gamma', artist: 'C', source: 'youtube', genre: 'POP', dateAdded: 3, playCount: 2, path: 'c' },
];

describe('filterSongLibrary', () => {
  it('filters by tab', () => {
    const youtubeOnly = filterSongLibrary(sampleSongs, { currentTab: 'youtube' });
    expect(youtubeOnly).toHaveLength(2);
    expect(youtubeOnly.map((s) => s.title).sort()).toEqual(['Alpha', 'Gamma']);
  });

  it('filters by sourceFilter chip (overrides library tab)', () => {
    const localOnly = filterSongLibrary(sampleSongs, {
      currentTab: 'library',
      sourceFilter: 'local',
    });
    expect(localOnly).toHaveLength(1);
    expect(localOnly[0].title).toBe('Beta');
  });

  it('filters by search query', () => {
    const result = filterSongLibrary(sampleSongs, { query: 'beta' });
    expect(result).toHaveLength(1);
    expect(result[0].title).toBe('Beta');
  });

  it('sorts by play count', () => {
    const result = filterSongLibrary(sampleSongs, { sortBy: 'plays' });
    expect(result[0].title).toBe('Beta');
  });

  it('filters by lyric sync status', () => {
    const songs = [
      { title: 'Synced', path: 's', lyricSyncStatus: 'synced' },
      { title: 'Unsynced', path: 'u', lyricSyncStatus: 'unsynced' },
      { title: 'None', path: 'n', lyricSyncStatus: 'none' },
    ];
    expect(filterSongLibrary(songs, { syncFilter: 'synced' })).toHaveLength(1);
    expect(filterSongLibrary(songs, { syncFilter: 'unsynced' })[0].title).toBe('Unsynced');
    expect(filterSongLibrary(songs, { syncFilter: 'all' })).toHaveLength(3);
  });
});

describe('getLyricSyncStatus', () => {
  it('reads the backend-provided status field (camelCase or snake_case)', () => {
    expect(getLyricSyncStatus({ lyricSyncStatus: 'synced' })).toBe('synced');
    expect(getLyricSyncStatus({ lyric_sync_status: 'unsynced' })).toBe('unsynced');
  });

  it('falls back to hasLyrics when the status field is missing', () => {
    expect(getLyricSyncStatus({ hasLyrics: true })).toBe('unsynced');
    expect(getLyricSyncStatus({ hasLyrics: false })).toBe('none');
    expect(getLyricSyncStatus({})).toBe('none');
  });
});
