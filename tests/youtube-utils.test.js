import { describe, expect, it } from 'vitest';
import {
  extractYoutubeVideoId,
  normalizeYoutubeKey,
  normalizeYoutubeUrl,
  youtubePathsMatch,
  isDuplicateYoutubeTrack,
  resolvePlayableAudioPath,
  coerceHttpMediaUrl,
  pickSongbookPushOriginalUrl,
} from '../src/js/youtube-utils.js';

describe('youtube-utils', () => {
  it('extracts id from youtu.be URL', () => {
    expect(extractYoutubeVideoId('https://youtu.be/abc123?t=10')).toBe('abc123');
  });

  it('extracts id from watch URL', () => {
    expect(extractYoutubeVideoId('https://www.youtube.com/watch?v=xyz789&list=foo')).toBe('xyz789');
  });

  it('extracts id from shorts URL', () => {
    expect(extractYoutubeVideoId('https://youtube.com/shorts/short1')).toBe('short1');
  });

  it('normalizes youtube key', () => {
    expect(normalizeYoutubeKey('https://youtu.be/abc123')).toBe('yt:abc123');
  });

  it('normalizes youtube url', () => {
    expect(normalizeYoutubeUrl('https://www.youtube.com/watch?v=abc123&list=foo')).toBe('https://youtu.be/abc123');
  });

  it('matches equivalent youtube paths', () => {
    expect(youtubePathsMatch('https://youtu.be/abc', 'https://www.youtube.com/watch?v=abc')).toBe(true);
    expect(youtubePathsMatch('https://youtu.be/abc', 'https://youtu.be/def')).toBe(false);
  });

  it('resolves songbook pull placeholders via originalUrl', () => {
    expect(
      resolvePlayableAudioPath({
        path: 'songbook:song:abc',
        source: 'songbook',
        originalUrl: 'https://youtu.be/dQw4w9WgXcQ',
      }),
    ).toBe('https://youtu.be/dQw4w9WgXcQ');
  });

  it('keeps local audio paths when originalUrl is also set', () => {
    expect(
      resolvePlayableAudioPath({
        path: 'C:\\Music\\track.mp3',
        source: 'local',
        originalUrl: 'https://youtu.be/abc',
      }),
    ).toBe('C:\\Music\\track.mp3');
  });

  it('coerces scheme-less youtube paths', () => {
    expect(coerceHttpMediaUrl('youtu.be/abc12345678')).toBe('https://youtu.be/abc12345678');
    expect(coerceHttpMediaUrl('www.youtube.com/watch?v=abc12345678')).toBe('https://youtu.be/abc12345678');
  });

  it('rejects non-youtube http(s) URLs', () => {
    expect(coerceHttpMediaUrl('https://example.com/watch')).toBeNull();
    expect(coerceHttpMediaUrl('http://127.0.0.1/secret')).toBeNull();
  });

  it('resolves karaoke_url for songbook placeholders', () => {
    expect(
      resolvePlayableAudioPath({
        path: 'songbook:song:abc',
        source: 'songbook',
        karaoke_url: 'https://youtu.be/abc12345678',
      }),
    ).toBe('https://youtu.be/abc12345678');
  });

  it('pickSongbookPushOriginalUrl accepts youtube from path only', () => {
    expect(
      pickSongbookPushOriginalUrl({
        path: 'https://www.youtube.com/watch?v=abc12345678',
        originalUrl: null,
      }),
    ).toBe('https://youtu.be/abc12345678');
  });

  it('pickSongbookPushOriginalUrl rejects local paths and non-youtube http', () => {
    expect(
      pickSongbookPushOriginalUrl({
        path: 'D:\\Music\\track.mp3',
        originalUrl: null,
      }),
    ).toBeNull();
    expect(
      pickSongbookPushOriginalUrl({
        path: 'D:\\Music\\track.mp3',
        karaoke_url: 'https://example.com/not-youtube',
      }),
    ).toBeNull();
  });
});
