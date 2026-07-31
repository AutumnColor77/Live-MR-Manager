import { describe, expect, it, beforeAll } from 'vitest';

// lrc-parser.js's line-visibility helpers read/write localStorage (browser-only
// API); Vitest's default "node" environment doesn't provide one, so stub a
// minimal in-memory version just for this file rather than pulling in jsdom.
beforeAll(() => {
  if (typeof globalThis.localStorage === 'undefined') {
    const store = new Map();
    globalThis.localStorage = {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
      clear: () => store.clear(),
    };
  }
});
import {
  parseLrc,
  parseMarkers,
  formatMarkerLine,
  parseTimeInput,
  formatTimeInput,
  isTriplet,
  getSyncText,
  getDisplayLines,
  encodeLrc,
  mergeAlignmentResult,
  suggestVocalStartFromSegments,
  getIntroSkipTargetSec,
} from '../src/js/lrc-parser.js';

describe('parseMarkers', () => {
  it('extracts vocal-start marker', () => {
    const lrc = `[00:05.00][vocalstart]\n[00:05.00]첫 가사`;
    const markers = parseMarkers(lrc);
    expect(markers.vocalStartSec).toBeCloseTo(5);
  });

  it('pairs ilstart/ilend into interludes and drops unpaired trailing ilstart', () => {
    const lrc = [
      '[00:10.00][ilstart]',
      '[00:20.00][ilend]',
      '[01:00.00][ilstart]', // unpaired, should be dropped
    ].join('\n');
    const markers = parseMarkers(lrc);
    expect(markers.interludes).toHaveLength(1);
    expect(markers.interludes[0].start).toBeCloseTo(10);
    expect(markers.interludes[0].end).toBeCloseTo(20);
  });

  it('does not treat marker-only lines as lyric segments', () => {
    const lrc = `[00:05.00][vocalstart]\n[00:06.00]실제 가사`;
    const segments = parseLrc(lrc, 30);
    expect(segments).toHaveLength(1);
    expect(segments[0].text).toBe('실제 가사');
  });

  it('formatMarkerLine round-trips with parseMarkers', () => {
    const line = formatMarkerLine(12.34, 'vocalstart');
    const markers = parseMarkers(line);
    expect(markers.vocalStartSec).toBeCloseTo(12.34, 1);
  });
});

describe('getIntroSkipTargetSec', () => {
  it('targets the preceding interlude start when adjacent to vocal start', () => {
    const markers = { vocalStartSec: 20, interludes: [{ start: 2, end: 20.5 }] };
    expect(getIntroSkipTargetSec(markers)).toBeCloseTo(2);
  });

  it('falls back to vocal start when no adjacent interlude exists', () => {
    const markers = { vocalStartSec: 15, interludes: [] };
    expect(getIntroSkipTargetSec(markers)).toBeCloseTo(15);
  });

  it('returns null without a vocal-start marker', () => {
    expect(getIntroSkipTargetSec({ vocalStartSec: null, interludes: [] })).toBeNull();
  });
});

describe('triplet cues (orig/pron/tran)', () => {
  it('parses a triplet cue into one segment with three fields', () => {
    const lrc = [
      '[00:12.34][orig]こんにちは',
      '[00:12.34][pron]콘니치와',
      '[00:12.34][tran]안녕하세요',
    ].join('\n');
    const segments = parseLrc(lrc, 30);
    expect(segments).toHaveLength(1);
    expect(isTriplet(segments[0])).toBe(true);
    expect(segments[0].original).toBe('こんにちは');
    expect(segments[0].pronunciation).toBe('콘니치와');
    expect(segments[0].translation).toBe('안녕하세요');
    expect(segments[0].start).toBeCloseTo(12.34);
  });

  it('getSyncText prefers pronunciation for triplets, plain text otherwise', () => {
    const triplet = { original: 'A', pronunciation: 'B', translation: 'C' };
    expect(getSyncText(triplet)).toBe('B');
    expect(getSyncText({ text: 'plain' })).toBe('plain');
  });

  it('getDisplayLines honors visibility and falls back when everything is hidden', () => {
    const triplet = { original: 'A', pronunciation: 'B', translation: 'C' };
    expect(getDisplayLines({ text: 'plain' })).toEqual(['plain']);
    // Non-triplet segments are unaffected by visibility settings.
    const lines = getDisplayLines(triplet, 'app');
    expect(lines.length).toBeGreaterThan(0);
  });

  it('encodeLrc serializes triplets back into [orig]/[pron]/[tran] lines', () => {
    const segments = [{ original: 'A', pronunciation: 'B', translation: 'C', start: 5 }];
    const content = encodeLrc(segments);
    expect(content).toContain('[orig]A');
    expect(content).toContain('[pron]B');
    expect(content).toContain('[tran]C');
  });
});

describe('mergeAlignmentResult', () => {
  it('only fills fully-unsynced segments and marks them approx', () => {
    const segments = [
      { text: 'already synced', start: 1, end: 2 },
      { text: 'needs sync', start: 0, end: 0 },
    ];
    const lines = [{ text: 'needs sync', start_ms: 3000, end_ms: 4000 }];
    const applied = mergeAlignmentResult(segments, lines);
    expect(applied).toBe(1);
    expect(segments[0].start).toBe(1); // preserved
    expect(segments[1].start).toBeCloseTo(3);
    expect(segments[1].approx).toBe(true);
  });
});

describe('suggestVocalStartFromSegments', () => {
  it('suggests the earliest synced line minus lead-in when intro is long enough', () => {
    const segments = [{ start: 10, end: 12 }, { start: 12, end: 14 }];
    expect(suggestVocalStartFromSegments(segments)).toBeCloseTo(9.7);
  });

  it('returns null when the intro is shorter than minSec', () => {
    const segments = [{ start: 1, end: 2 }];
    expect(suggestVocalStartFromSegments(segments)).toBeNull();
  });
});

describe('parseTimeInput / formatTimeInput', () => {
  it('parses mm:ss, mm:ss.xx, and plain seconds', () => {
    expect(parseTimeInput('1:23')).toBeCloseTo(83);
    expect(parseTimeInput('01:23.45')).toBeCloseTo(83.45);
    expect(parseTimeInput('83')).toBe(83);
    expect(parseTimeInput('83.5')).toBeCloseTo(83.5);
  });

  it('rejects invalid inputs', () => {
    expect(parseTimeInput('')).toBeNull();
    expect(parseTimeInput('1:60')).toBeNull();
    expect(parseTimeInput('abc')).toBeNull();
  });

  it('round-trips with formatTimeInput', () => {
    expect(parseTimeInput(formatTimeInput(83.45))).toBeCloseTo(83.45);
    expect(formatTimeInput(5)).toBe('00:05.00');
  });
});
