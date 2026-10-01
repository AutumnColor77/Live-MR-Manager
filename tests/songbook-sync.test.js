import { describe, expect, it } from 'vitest';
import {
  applyRemoteMetaToLocal,
  buildSongbookMetaPatch,
  forgetSongbookDeletions,
  pushTags,
  rememberSongbookDeletion,
  remoteSongsToDisable,
} from '../src/js/songbook-sync.js';

function localKey(title, artist) {
  return `${String(title).trim().toLowerCase()}\0${String(artist).trim().toLowerCase()}`;
}

function matchedRemote(overrides = {}) {
  return {
    id: 'remote-1',
    title: '밤편지',
    artist: '아이유',
    category: '',
    genre: '미분류',
    tags: [],
    songKey: null,
    bpm: null,
    difficulty: null,
    donationAmount: null,
    originalUrl: 'https://example.com/night',
    enabled: true,
    ...overrides,
  };
}

describe('remoteSongsToDisable', () => {
  const localKeys = new Set([localKey('밤편지', '아이유')]);

  it('does not hide a web-origin song missing from the local library', () => {
    const webOnly = {
      id: 'web-1',
      title: '좋은 날',
      artist: '아이유',
      enabled: true,
      origin: 'web',
    };
    expect(remoteSongsToDisable([webOnly], localKeys)).toEqual([]);
  });

  it('hides push songs and songs with no origin when they are not local', () => {
    const pushSong = {
      id: 'push-1',
      title: '좋은 날',
      artist: '아이유',
      enabled: true,
      origin: 'push',
    };
    const legacySong = {
      id: 'legacy-1',
      title: '팔레트',
      artist: '아이유',
      enabled: true,
    };
    const alreadyHidden = {
      id: 'hidden-1',
      title: '스물셋',
      artist: '아이유',
      enabled: false,
      origin: 'push',
    };
    const kept = remoteSongsToDisable([pushSong, legacySong, alreadyHidden], localKeys);
    expect(kept.map((song) => song.id)).toEqual(['push-1', 'legacy-1']);
  });

  it('hides a web-origin song the user deleted in the app', () => {
    localStorage.removeItem('songbook_deleted_keys');
    rememberSongbookDeletion({ title: '좋은 날', artist: '아이유' });
    const deleted = forgetSongbookDeletions([]);
    const webDeleted = {
      id: 'web-deleted',
      title: '좋은 날',
      artist: '아이유',
      enabled: true,
      origin: 'web',
    };
    const webKept = {
      id: 'web-kept',
      title: '스물셋',
      artist: '아이유',
      enabled: true,
      origin: 'web',
    };
    const hidden = remoteSongsToDisable([webDeleted, webKept], localKeys, deleted);
    expect(hidden.map((song) => song.id)).toEqual(['web-deleted']);

    rememberSongbookDeletion({ title: '밤편지', artist: '아이유' });
    const stillLocal = forgetSongbookDeletions([{ title: '밤편지', artist: '아이유' }]);
    expect(stillLocal.has(localKey('밤편지', '아이유'))).toBe(false);
    expect(stillLocal.has(localKey('좋은 날', '아이유'))).toBe(true);
  });
});

describe('buildSongbookMetaPatch originalUrl', () => {
  it('omits originalUrl when the local song has no YouTube URL to send', () => {
    const remote = matchedRemote();
    const unchanged = buildSongbookMetaPatch(
      { title: '밤편지', artist: '아이유', path: 'C:\\music\\night.mp3', tags: [] },
      remote,
    );
    expect(unchanged).toBeNull();

    const patched = buildSongbookMetaPatch(
      { title: '밤편지', artist: '아이유', path: 'C:\\music\\night.mp3', tags: ['발라드'] },
      remote,
    );
    expect(patched).toBeTruthy();
    expect(patched).not.toHaveProperty('originalUrl');
    expect(patched.tags).toEqual(['발라드']);
  });

  it('sends a local YouTube URL', () => {
    const patched = buildSongbookMetaPatch(
      {
        title: '밤편지',
        artist: '아이유',
        path: 'https://www.youtube.com/watch?v=abc123xyz01',
        tags: [],
      },
      matchedRemote({ originalUrl: 'https://example.com/night' }),
    );
    expect(patched.originalUrl).toBe('https://youtu.be/abc123xyz01');
  });
});

describe('MR tag mapping', () => {
  it('adds a single MR tag when pushing an instrumental', () => {
    expect(pushTags({ isMr: true, tags: ['발라드', 'MR'] })).toEqual(['발라드', 'MR']);
    expect(pushTags({ isMr: true, tags: ['발라드'] })).toEqual(['MR', '발라드']);
    expect(pushTags({ is_mr: true, tags: ['mr'] })).toEqual(['mr']);
  });

  it('turns isMr on when the remote song has an MR tag and leaves it when the tag is absent', () => {
    const withTag = applyRemoteMetaToLocal(
      { title: '밤편지', artist: '아이유', isMr: false, tags: [] },
      { title: '밤편지', artist: '아이유', tags: ['MR'] },
    );
    expect(withTag.isMr).toBe(true);
    expect(withTag.is_mr).toBe(true);

    const kept = applyRemoteMetaToLocal(
      { title: '밤편지', artist: '아이유', isMr: true, is_mr: true, tags: ['MR'] },
      { title: '밤편지', artist: '아이유', tags: ['발라드'] },
    );
    expect(kept.isMr).toBe(true);
    expect(kept.is_mr).toBe(true);

    const stillOff = applyRemoteMetaToLocal(
      { title: '밤편지', artist: '아이유', isMr: false, tags: [] },
      { title: '밤편지', artist: '아이유', tags: [] },
    );
    expect(stillOff.isMr).toBe(false);
  });
});
