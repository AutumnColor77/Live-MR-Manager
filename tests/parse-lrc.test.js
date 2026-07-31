import { describe, expect, it } from 'vitest';
import { parseLrc } from '../src/js/lrc-parser.js';

describe('parseLrc', () => {
  it('parses timestamped lines', () => {
    const lrc = `[00:12.50]첫 번째 줄\n[00:18.00]두 번째 줄`;
    const segments = parseLrc(lrc, 30);
    expect(segments).toHaveLength(2);
    expect(segments[0].text).toBe('첫 번째 줄');
    expect(segments[0].start).toBeCloseTo(12.5);
    expect(segments[1].start).toBeCloseTo(18);
    expect(segments[0].end).toBeCloseTo(18);
  });

  it('ignores metadata tags', () => {
    const lrc = `[ar:Artist]\n[00:01.00]가사`;
    const segments = parseLrc(lrc, 10);
    expect(segments).toHaveLength(1);
    expect(segments[0].text).toBe('가사');
  });

  it('parses single-digit minutes and optional fractions', () => {
    const lrc = `[1:02.34]한 자리 분\n[2:03]소수 없음`;
    const segments = parseLrc(lrc, 200);
    expect(segments).toHaveLength(2);
    expect(segments[0].start).toBeCloseTo(62.34);
    expect(segments[1].start).toBeCloseTo(123);
  });
});
