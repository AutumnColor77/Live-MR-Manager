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

  it('ignores an unknown language and keeps the previous/default value', () => {
    setAlignmentLanguage('rap');
    expect(getAlignmentLanguage()).toBe('ko');
  });

  it('exposes exactly the ko/en languages', () => {
    expect(Object.keys(ALIGNMENT_LANGUAGES).sort()).toEqual(['en', 'ko']);
  });
});

describe('findModelForLanguage', () => {
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
});
