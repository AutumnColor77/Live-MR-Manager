/**
 * taxonomy.js — 장르/카테고리 단일 소스 (곡 추가·편집·필터 공용)
 *
 * 기준 (docs/GENRE_CATEGORY_STANDARD.md):
 *  - 장르(Genre)    = 음악 스타일/사운드. "무엇처럼 들리는가". 예: 락, 힙합, 댄스.
 *  - 카테고리(Category) = 씬/시장/출신. "어디 음악인가". 예: K-POP, J-POP, 애니.
 * 저장 값 = 표시 라벨(한국어)로 통일한다(예전엔 소문자 키 kpop/ballad와
 * 자동수집 한국어 록/K-팝이 섞여 있었다). 예전 값은 remapClassification이
 * 새 기준으로 옮긴다.
 */

// 장르 — 음악 스타일. 저장 값 === 표시 라벨.
export const GENRES = [
    '발라드', '댄스', '팝', '락', '메탈', '힙합', 'R&B/소울', '인디',
    '재즈', 'EDM', '포크/어쿠스틱', '클래식', '트로트', '펑크', 'CCM', '기타',
];

// 카테고리 — 씬/시장/출신.
export const CATEGORIES = [
    'K-POP', 'J-POP', 'POP(해외)', '애니메이션', '보컬로이드', '게임',
    'OST', '뮤지컬', '국악/전통', '라이브/커버', '기타',
];

const GENRE_SET = new Set(GENRES);
const CATEGORY_SET = new Set(CATEGORIES);

// 예전 값(소문자 키 / 자동수집 한국어) → 새 기준. `genre` 또는 `category`로
// 옮긴다(예전 장르에 kpop 같은 '씬' 값이 들어 있던 것을 카테고리로 이동).
const REMAP = {
    // 예전 소문자 장르 키 → 사운드 장르
    ballad: { genre: '발라드' }, dance: { genre: '댄스' }, pop: { genre: '팝' },
    rock: { genre: '락' }, metal: { genre: '메탈' }, hiphop: { genre: '힙합' },
    rnb: { genre: 'R&B/소울' }, 'r&b': { genre: 'R&B/소울' }, soul: { genre: 'R&B/소울' },
    indie: { genre: '인디' }, jazz: { genre: '재즈' }, edm: { genre: 'EDM' },
    electronic: { genre: 'EDM' }, folk: { genre: '포크/어쿠스틱' }, acoustic: { genre: '포크/어쿠스틱' },
    classical: { genre: '클래식' }, trot: { genre: '트로트' }, punk: { genre: '펑크' },
    ccm: { genre: 'CCM' }, etc: { genre: '기타' },
    // 예전 소문자 값이지만 사실은 '씬' → 카테고리로 이동
    kpop: { category: 'K-POP' }, jpop: { category: 'J-POP' }, anime: { category: '애니메이션' },
    vocaloid: { category: '보컬로이드' }, ost: { category: 'OST' }, game: { category: '게임' },
    musical: { category: '뮤지컬' },
    // 자동수집 한국어 장르명 → 매핑
    '록': { genre: '락' }, '팝 록': { genre: '락' }, '얼터너티브 록': { genre: '락' },
    '하드 록': { genre: '락' }, '메탈': { genre: '메탈' }, '헤비메탈': { genre: '메탈' },
    '힙합': { genre: '힙합' }, '랩': { genre: '힙합' }, '알앤비': { genre: 'R&B/소울' },
    '알앤비/소울': { genre: 'R&B/소울' }, '소울': { genre: 'R&B/소울' },
    '인디 록': { genre: '인디' }, '인디': { genre: '인디' }, '인디팝': { genre: '인디' },
    '재즈': { genre: '재즈' }, '클래식': { genre: '클래식' }, '클래식 음악': { genre: '클래식' },
    '트로트': { genre: '트로트' }, '발라드': { genre: '발라드' }, '댄스': { genre: '댄스' },
    '팝': { genre: '팝' }, '일렉트로닉': { genre: 'EDM' }, '일렉트로니카': { genre: 'EDM' },
    '어쿠스틱': { genre: '포크/어쿠스틱' }, '포크': { genre: '포크/어쿠스틱' }, '펑크': { genre: '펑크' },
    // 자동수집/자유입력 카테고리성 한국어 → 카테고리
    'k-팝': { category: 'K-POP' }, '케이팝': { category: 'K-POP' },
    'j-팝': { category: 'J-POP' }, '제이팝': { category: 'J-POP' },
    '애니': { category: '애니메이션' }, '애니메이션': { category: '애니메이션' },
    '애니송': { category: '애니메이션' }, '보컬로이드': { category: '보컬로이드' },
    '게임': { category: '게임' }, 'ost': { category: 'OST' }, '오에스티': { category: 'OST' },
    '뮤지컬': { category: '뮤지컬' }, '국악': { category: '국악/전통' }, '전통': { category: '국악/전통' },
};

/** 한 값을 새 기준으로 해석 — { genre?, category? }. 이미 표준이면 그대로,
 *  매핑에 없으면(사용자 커스텀) 원본을 그대로 장르로 취급. */
function classifyOne(raw) {
    const v = String(raw || '').trim();
    if (!v) return {};
    if (GENRE_SET.has(v)) return { genre: v };
    if (CATEGORY_SET.has(v)) return { category: v };
    const hit = REMAP[v.toLowerCase()] || REMAP[v];
    if (hit) return { ...hit };
    return { genre: v, custom: true }; // 모르는 값 — 장르 자리에 그대로 보존
}

/**
 * 곡의 예전 장르/카테고리 값을 새 기준으로 재매핑.
 * @returns { genre: string, categories: string[], changed: boolean }
 */
export function remapClassification(oldGenre, oldCategories) {
    let genre = '';
    const cats = [];
    const pushCat = (c) => { if (c && !cats.includes(c)) cats.push(c); };

    // 장르 필드 해석
    const g = classifyOne(oldGenre);
    if (g.genre) genre = g.genre;
    else if (g.category) pushCat(g.category); // 예전 장르에 씬 값이 있었음

    // 카테고리 필드(들) 해석
    (Array.isArray(oldCategories) ? oldCategories : [oldCategories]).forEach((c) => {
        const r = classifyOne(c);
        if (r.category) pushCat(r.category);
        else if (r.genre && !r.custom && !genre) genre = r.genre; // 씬 자리에 사운드가 있었고 장르가 비었으면 채움
        else if (r.genre && r.custom) pushCat(c); // 모르는 값은 카테고리로 보존
    });

    const origCats = (Array.isArray(oldCategories) ? oldCategories : []).map((x) => String(x || '').trim()).filter(Boolean);
    const changed = genre !== String(oldGenre || '').trim()
        || cats.length !== origCats.length
        || cats.some((c, i) => c !== origCats[i]);
    return { genre, categories: cats, changed };
}

/**
 * 라이브러리 전체를 새 기준으로 일괄 재매핑(인메모리). 바뀐 곡 수를 반환하며,
 * 각 곡의 genre/categories/curationCategory를 갱신한다. 저장은 호출부 담당.
 */
export function migrateLibraryTaxonomy(library) {
    if (!Array.isArray(library)) return 0;
    let count = 0;
    library.forEach((song) => {
        if (!song) return;
        const cats = song.categories || (song.curationCategory ? [song.curationCategory] : []);
        const { genre, categories, changed } = remapClassification(song.genre, cats);
        if (!changed) return;
        song.genre = genre || undefined;
        song.categories = categories;
        song.curationCategory = categories[0] || null;
        song.curation_category = song.curationCategory;
        count++;
    });
    return count;
}
