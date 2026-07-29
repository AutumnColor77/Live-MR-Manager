import { describe, expect, it } from 'vitest';
import { GENRES, CATEGORIES, remapClassification, migrateLibraryTaxonomy } from '../src/js/taxonomy.js';

describe('taxonomy remapClassification', () => {
  it('maps old lowercase sound genres to Korean', () => {
    expect(remapClassification('rock', []).genre).toBe('락');
    expect(remapClassification('ballad', []).genre).toBe('발라드');
    expect(remapClassification('hiphop', []).genre).toBe('힙합');
    expect(remapClassification('rnb', []).genre).toBe('R&B/소울');
  });

  it('moves scene values out of genre into category', () => {
    const r = remapClassification('kpop', []);
    expect(r.genre).toBe('');
    expect(r.categories).toEqual(['K-POP']);
    expect(remapClassification('jpop', []).categories).toEqual(['J-POP']);
    expect(remapClassification('anime', []).categories).toEqual(['애니메이션']);
  });

  it('maps auto-fetched Korean genres (록, 인디 록, K-팝)', () => {
    expect(remapClassification('록', []).genre).toBe('락');
    expect(remapClassification('인디 록', []).genre).toBe('인디');
    const k = remapClassification('K-팝', []);
    expect(k.categories).toEqual(['K-POP']);
  });

  it('keeps already-standard values unchanged', () => {
    const r = remapClassification('힙합', ['K-POP']);
    expect(r.genre).toBe('힙합');
    expect(r.categories).toEqual(['K-POP']);
    expect(r.changed).toBe(false);
  });

  it('preserves unknown custom values as genre', () => {
    const r = remapClassification('내맘대로장르', []);
    expect(r.genre).toBe('내맘대로장르');
  });

  it('reports changed=true when values are remapped', () => {
    expect(remapClassification('rock', ['kpop']).changed).toBe(true);
    expect(remapClassification('rock', ['kpop'])).toMatchObject({ genre: '락', categories: ['K-POP'] });
  });

  it('migrateLibraryTaxonomy rewrites songs in place and counts changes', () => {
    const lib = [
      { title: 'a', genre: 'rock', categories: ['kpop'] },
      { title: 'b', genre: '힙합', categories: ['K-POP'] }, // already standard
      { title: 'c', genre: '록', curationCategory: '애니' },
    ];
    const n = migrateLibraryTaxonomy(lib);
    expect(n).toBe(2);
    expect(lib[0]).toMatchObject({ genre: '락', categories: ['K-POP'], curationCategory: 'K-POP' });
    expect(lib[1].genre).toBe('힙합');
    expect(lib[2]).toMatchObject({ genre: '락', categories: ['애니메이션'] });
  });

  it('taxonomy lists are non-empty and use Korean labels', () => {
    expect(GENRES).toContain('락');
    expect(GENRES).toContain('인디');
    expect(CATEGORIES).toContain('K-POP');
    expect(CATEGORIES).not.toContain('락');
  });
});
