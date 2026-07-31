import { describe, expect, it, beforeAll, beforeEach } from 'vitest';

// alignment-model.js's language preference reads/writes localStorage
// (browser-only API); Vitest's default "node" environment doesn't provide
// one, so stub a minimal in-memory version just for this file rather than
// pulling in jsdom (same approach as lrc-parser-markers-triplets.test.js).
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
  ALIGNMENT_LANGUAGES,
  getAlignmentLanguage,
  setAlignmentLanguage,
  findModelForLanguage,
  requiredLanguagesFor,
  dominantScriptLang,
  mergeDualAlignmentLines,
} from '../src/js/alignment-model.js';

describe('alignment language preference', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('defaults to Korean when nothing is stored', () => {
    expect(getAlignmentLanguage()).toBe('ko');
  });

  it('persists a valid language selection', () => {
    setAlignmentLanguage('en');
    expect(getAlignmentLanguage()).toBe('en');
  });

  it('accepts rap as a persistable language', () => {
    setAlignmentLanguage('rap');
    expect(getAlignmentLanguage()).toBe('rap');
  });

  it('ignores an unknown language and keeps the previous/default value', () => {
    setAlignmentLanguage('zz');
    expect(getAlignmentLanguage()).toBe('ko');
  });

  it('exposes ko/en/rap languages', () => {
    expect(Object.keys(ALIGNMENT_LANGUAGES).sort()).toEqual(['en', 'ko', 'rap']);
  });
});

describe('findModelForLanguage / requiredLanguagesFor', () => {
  const models = [
    'Engine A: Wav2Vec2-Large|C:/models/wav2vec2-large',
    '한국어 가사 정렬 모델 (KO)|C:/models/wav2vec2-korean-lyrics',
    '영어 가사 정렬 모델 (EN)|C:/models/wav2vec2-english-lyrics',
  ];

  it('finds the Korean model by folder name', () => {
    expect(findModelForLanguage(models, 'ko')).toBe(models[1]);
  });

  it('finds the English model by folder name', () => {
    expect(findModelForLanguage(models, 'en')).toBe(models[2]);
  });

  it('returns null when no model is downloaded for the language', () => {
    expect(findModelForLanguage(['Engine A|C:/models/wav2vec2-large'], 'en')).toBeNull();
  });

  it('ignores the sentinel "no models available" entry', () => {
    expect(findModelForLanguage(['사용 가능한 모델 없음|none'], 'ko')).toBeNull();
  });

  it('handles Windows-style backslash paths', () => {
    const winModels = ['한국어 가사 정렬 모델 (KO)|C:\\models\\wav2vec2-korean-lyrics'];
    expect(findModelForLanguage(winModels, 'ko')).toBe(winModels[0]);
  });

  it('rap dual mode has no model of its own and expands to ko+en', () => {
    expect(findModelForLanguage(models, 'rap')).toBeNull();
    expect(requiredLanguagesFor('rap')).toEqual(['ko', 'en']);
    expect(requiredLanguagesFor('ko')).toEqual(['ko']);
    expect(requiredLanguagesFor('en')).toEqual(['en']);
  });
});

describe('dominantScriptLang', () => {
  it('classifies lines by hangul vs latin letter count', () => {
    expect(dominantScriptLang('난 벨라스케스, 밀레, 엘 fuckin 그레코')).toBe('ko');
    expect(dominantScriptLang("I'm a born hater, Dali, Ban, Picasso")).toBe('en');
    expect(dominantScriptLang('yeah 나쁜 놈들 다 hands up')).toBe('en');
  });

  it('ties and empty text default to ko (safe fallback)', () => {
    expect(dominantScriptLang('')).toBe('ko');
    expect(dominantScriptLang('123 !!')).toBe('ko');
  });
});

describe('mergeDualAlignmentLines (랩/혼합 줄별 병합)', () => {
  it('picks per-line result from the dominant-language model', () => {
    const ko = [
      { text: '난 벨라스케스 밀레', start_ms: 1000, end_ms: 3000 },
      { text: 'I did it my way', start_ms: 3000, end_ms: 5000 },
    ];
    const en = [
      { text: '난 벨라스케스 밀레', start_ms: 900, end_ms: 2800 },
      { text: 'I did it my way', start_ms: 4000, end_ms: 6000 },
    ];
    const merged = mergeDualAlignmentLines(ko, en);
    expect(merged[0].start_ms).toBe(1000);
    expect(merged[1].start_ms).toBe(4000);
  });

  it('repairs monotonicity without stacking lines on one timestamp', () => {
    const ko = [
      { text: '한국어 줄', start_ms: 10000, end_ms: 12000 },
      { text: 'english line', start_ms: 12000, end_ms: 14000 },
    ];
    const en = [
      { text: '한국어 줄', start_ms: 1000, end_ms: 2000 },
      { text: 'english line', start_ms: 8000, end_ms: 9000 },
    ];
    const merged = mergeDualAlignmentLines(ko, en);
    expect(merged[0].start_ms).toBe(10000);
    expect(merged[1].start_ms).toBeGreaterThan(merged[0].start_ms);
    expect(merged[1].end_ms).toBeGreaterThanOrEqual(merged[1].start_ms + 200);
  });

  it('드리프트한 소수 언어 패스가 정확한 다수 언어 줄을 끌어당기지 않는다', () => {
    const koPass = [
      { text: '왔다네 정말로', start_ms: 18480, end_ms: 21000 },
      { text: '아무도 안 믿었던', start_ms: 21060, end_ms: 26000 },
      { text: '사랑의 종말론', start_ms: 26860, end_ms: 29000 },
      { text: "It's over tonight", start_ms: 29500, end_ms: 30000 },
      { text: 'God mercy', start_ms: 30000, end_ms: 30500 },
      { text: 'Where the hell', start_ms: 30500, end_ms: 31000 },
      { text: 'Did you hear that', start_ms: 31000, end_ms: 31500 },
      { text: 'You heard that', start_ms: 31500, end_ms: 32000 },
      { text: "What's it sound", start_ms: 32000, end_ms: 32500 },
      { text: 'Back in the day', start_ms: 32500, end_ms: 33000 },
      { text: '한 사람당 하나의', start_ms: 52540, end_ms: 55000 },
      { text: '사랑이 있었대', start_ms: 55450, end_ms: 58000 },
      { text: '내일이면', start_ms: 58260, end_ms: 60000 },
      { text: '인류가 잃어버릴', start_ms: 60770, end_ms: 63000 },
      { text: '멸종위기사랑', start_ms: 63880, end_ms: 66000 },
    ];
    const enPass = koPass.map((l) => ({ ...l }));
    const drifted = {
      "It's over tonight": 28000,
      'God mercy': 34600,
      'Where the hell': 47360,
      'Did you hear that': 55740,
      'You heard that': 60960,
      "What's it sound": 64100,
      'Back in the day': 66960,
    };
    enPass.forEach((l) => {
      if (drifted[l.text] != null) {
        l.start_ms = drifted[l.text];
        l.end_ms = l.start_ms + 1500;
      }
    });

    const merged = mergeDualAlignmentLines(koPass, enPass);
    const starts = merged.map((l) => l.start_ms);
    expect(new Set(starts).size).toBe(starts.length);
    for (let i = 1; i < starts.length; i++) {
      expect(starts[i]).toBeGreaterThan(starts[i - 1]);
    }

    const byText = Object.fromEntries(merged.map((l) => [l.text, l.start_ms]));
    expect(byText['한 사람당 하나의']).toBe(52540);
    expect(byText['멸종위기사랑']).toBe(63880);
    expect(byText['왔다네 정말로']).toBe(18480);

    Object.keys(drifted).forEach((t) => {
      expect(byText[t]).toBeGreaterThan(26860);
      expect(byText[t]).toBeLessThan(52540);
    });
  });

  it('handles length mismatch by falling back to whichever side exists', () => {
    const ko = [{ text: '가', start_ms: 1000, end_ms: 2000 }];
    const en = [];
    const merged = mergeDualAlignmentLines(ko, en);
    expect(merged).toHaveLength(1);
    expect(merged[0].start_ms).toBe(1000);
  });
});
