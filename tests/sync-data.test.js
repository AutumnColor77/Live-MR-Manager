import { describe, expect, it } from 'vitest';
import {
  buildSyncData,
  applySyncData,
  checkSyncDataCompatibility,
  lyricsFingerprint,
  SYNC_DATA_VERSION,
} from '../src/js/sync-data.js';

const seg = (text, start = 0, end = 0) => ({ text, start, end });

const sampleSegments = () => [
  seg('왔다네 정말로', 5, 8),
  seg('아무도 안 믿었던', 8, 11),
  seg('사랑의 종말론', 11, 14),
];

describe('buildSyncData', () => {
  it('원문 텍스트를 어떤 필드에도 담지 않는다', () => {
    const data = buildSyncData(sampleSegments(), {}, { songKey: 'yt:abc', duration: 200 });
    const json = JSON.stringify(data);
    // 저작권 회피의 핵심 — 직렬화 결과에 가사 조각이 남으면 안 된다.
    expect(json).not.toContain('왔다네');
    expect(json).not.toContain('종말론');
    expect(json).not.toContain('믿었던');
  });

  it('블럭 구조와 타임코드를 분리해 담는다', () => {
    const data = buildSyncData(sampleSegments(), {}, { songKey: 'yt:abc', duration: 200.4567 });
    expect(data.formatVersion).toBe(SYNC_DATA_VERSION);
    expect(data.songKey).toBe('yt:abc');
    expect(data.duration).toBe(200.457);
    expect(data.lineCount).toBe(3);
    expect(data.lines).toHaveLength(3);
    expect(data.lines[0]).toEqual({ start: 5, end: 8, len: expect.any(Number) });
    expect(data.lines[0].len).toBeGreaterThan(0);
    expect(data.triplet).toBe(false);
  });

  it('마커(보컬 시작·간주)를 함께 담는다 — 타이밍이라 공유해도 안전', () => {
    const markers = { vocalStartSec: 10.2, interludes: [{ start: 0, end: 9.8 }, { start: 100, end: 110 }] };
    const data = buildSyncData(sampleSegments(), markers, {});
    expect(data.markers.vocalStart).toBe(10.2);
    expect(data.markers.interludes).toEqual([[0, 9.8], [100, 110]]);
  });

  it('3줄 가사 곡을 표시한다', () => {
    const triplet = [{ original: '原文', pronunciation: '겐분', translation: '원문', text: '原文', start: 1, end: 2 }];
    expect(buildSyncData(triplet, {}, {}).triplet).toBe(true);
  });
});

describe('lyricsFingerprint', () => {
  it('표기 차이(공백·문장부호·대소문자)는 같은 지문으로 본다', () => {
    const a = [seg('Don\'t stop, believing!')];
    const b = [seg('dont stop believing')];
    expect(lyricsFingerprint(a)).toBe(lyricsFingerprint(b));
  });

  it('줄 순서가 바뀌면 다른 지문', () => {
    const a = [seg('가나다'), seg('라마바')];
    const b = [seg('라마바'), seg('가나다')];
    expect(lyricsFingerprint(a)).not.toBe(lyricsFingerprint(b));
  });
});

describe('checkSyncDataCompatibility', () => {
  it('같은 가사면 exact', () => {
    const data = buildSyncData(sampleSegments(), {}, {});
    const r = checkSyncDataCompatibility(sampleSegments(), data);
    expect(r).toMatchObject({ ok: true, level: 'exact' });
  });

  it('줄 수가 다르면 거부한다 — 얹으면 엉뚱한 줄에 붙는다', () => {
    const data = buildSyncData(sampleSegments(), {}, {});
    const mine = [seg('왔다네 정말로'), seg('아무도 안 믿었던')];
    const r = checkSyncDataCompatibility(mine, data);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('줄 수가 다릅니다');
  });

  it('표기가 조금 다른 가사본은 structure로 허용하되 경고한다', () => {
    const data = buildSyncData(sampleSegments(), {}, {});
    const mine = [seg('왔다네 정말루'), seg('아무도 안 믿었떤'), seg('사랑의 종말론')];
    const r = checkSyncDataCompatibility(mine, data);
    expect(r).toMatchObject({ ok: true, level: 'structure' });
    expect(r.reason).not.toBe('');
  });

  it('내용이 많이 다르면 거부한다', () => {
    const data = buildSyncData(sampleSegments(), {}, {});
    const mine = [seg('전혀 다른 가사입니다 정말로'), seg('두번째도 완전히 다름 아주 길게'), seg('세번째 역시 상관없는 내용')];
    const r = checkSyncDataCompatibility(mine, data);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('다릅니다');
  });

  it('3줄 가사 여부가 다르면 거부한다', () => {
    const data = buildSyncData(sampleSegments(), {}, {});
    const mine = [
      { original: 'a', pronunciation: 'b', translation: 'c', text: 'a', start: 0, end: 0 },
      seg('x'), seg('y'),
    ];
    expect(checkSyncDataCompatibility(mine, data).ok).toBe(false);
  });

  it('형식 버전이 다르면 거부한다', () => {
    const data = buildSyncData(sampleSegments(), {}, {});
    data.formatVersion = 999;
    expect(checkSyncDataCompatibility(sampleSegments(), data).ok).toBe(false);
  });
});

describe('applySyncData', () => {
  it('미싱크 줄에 타임코드를 얹고 approx로 표시한다', () => {
    const data = buildSyncData(sampleSegments(), {}, {});
    const mine = [seg('왔다네 정말로'), seg('아무도 안 믿었던'), seg('사랑의 종말론')];
    const r = applySyncData(mine, data);
    expect(r.applied).toBe(3);
    expect(mine[0].start).toBe(5);
    expect(mine[0].end).toBe(8);
    // 남이 만든 타이밍이라 미세하게 어긋날 수 있음을 표시
    expect(mine[0].approx).toBe(true);
  });

  it('이미 싱크된 줄은 기본적으로 보존한다', () => {
    const data = buildSyncData(sampleSegments(), {}, {});
    const mine = [seg('왔다네 정말로', 99, 100), seg('아무도 안 믿었던'), seg('사랑의 종말론')];
    const r = applySyncData(mine, data);
    expect(r.applied).toBe(2);
    expect(mine[0].start).toBe(99, '수동 작업을 덮어쓰면 안 됨');
  });

  it('overwriteSynced로 전체 덮어쓸 수 있다', () => {
    const data = buildSyncData(sampleSegments(), {}, {});
    const mine = [seg('왔다네 정말로', 99, 100), seg('아무도 안 믿었던'), seg('사랑의 종말론')];
    const r = applySyncData(mine, data, { overwriteSynced: true });
    expect(r.applied).toBe(3);
    expect(mine[0].start).toBe(5);
  });

  it('호환되지 않으면 아무것도 바꾸지 않는다', () => {
    const data = buildSyncData(sampleSegments(), {}, {});
    const mine = [seg('한 줄뿐')];
    const before = JSON.stringify(mine);
    const r = applySyncData(mine, data);
    expect(r.applied).toBe(0);
    expect(JSON.stringify(mine)).toBe(before);
  });

  it('왕복(build → apply)이 원래 타임코드를 복원한다', () => {
    const original = sampleSegments();
    const data = buildSyncData(original, {}, {});
    const mine = original.map((s) => seg(s.text));
    applySyncData(mine, data);
    mine.forEach((m, i) => {
      expect(m.start).toBeCloseTo(original[i].start, 3);
      expect(m.end).toBeCloseTo(original[i].end, 3);
    });
  });
});
