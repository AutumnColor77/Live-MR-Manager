/**
 * alignment-model.js - AI 가사 정렬 언어 선택/모델 매핑 (프론트엔드 공용)
 *
 * `get_model_list`가 반환하는 로컬 정렬 모델은 `display|경로` 문자열이며,
 * 경로에는 다운로드된 모델의 폴더명(wav2vec2-korean-lyrics /
 * wav2vec2-english-lyrics)이 들어있다. 이 파일은 그 폴더명과 사용자가 고른
 * 언어(ko/en/rap)를 매핑하는 순수 유틸리티만 담당한다 - 실제 다운로드/삭제/상태
 * 조회는 `model-api.js`의 백엔드 커맨드 래퍼를 사용한다.
 *
 * '랩/혼합(rap)'은 단일 모델이 아니라 한국어+영어 두 모델을 순차로 돌린 뒤
 * 줄마다 우세 언어(한글/라틴 글자 비율) 결과를 채택하는 듀얼 모드다.
 */

export const ALIGNMENT_LANGUAGES = {
  ko: { modelFolder: 'wav2vec2-korean-lyrics', label: '한국어' },
  en: { modelFolder: 'wav2vec2-english-lyrics', label: 'English' },
  // 듀얼 모드 — 자체 모델 없음, ko+en 둘 다 필요
  rap: { label: '랩/혼합 (한+영)' },
};

const LANG_KEY = 'alignmentLanguage';

/** 사용자가 마지막으로 고른 정렬 언어("ko"/"en"/"rap"). 기본값 "ko". */
export function getAlignmentLanguage() {
  const v = localStorage.getItem(LANG_KEY);
  return ALIGNMENT_LANGUAGES[v] ? v : 'ko';
}

export function setAlignmentLanguage(lang) {
  if (ALIGNMENT_LANGUAGES[lang]) localStorage.setItem(LANG_KEY, lang);
}

/** 이 언어 설정으로 정렬하려면 실제로 필요한 (단일 모델) 언어 목록. */
export function requiredLanguagesFor(lang) {
  return lang === 'rap' ? ['ko', 'en'] : [lang];
}

/** `get_model_list` 결과("display|path" 배열)에서 해당 언어 모델 폴더를
 *  포함하는 항목을 찾아 반환한다. 없으면 null (아직 다운로드되지 않음).
 *  rap 같은 듀얼 모드는 자체 모델이 없으므로 null — requiredLanguagesFor로
 *  풀어서 개별 조회할 것. */
export function findModelForLanguage(models, lang) {
  const spec = ALIGNMENT_LANGUAGES[lang];
  if (!spec || !spec.modelFolder) return null;
  const usable = (models || []).filter((m) => !String(m).endsWith('|none'));
  const matched = usable.find((m) => {
    const path = (m.split('|').pop() || '').replace(/\\/g, '/').toLowerCase();
    return path.includes(spec.modelFolder.toLowerCase());
  });
  return matched || null;
}

/** 한 줄 가사의 우세 스크립트 판정: 한글 글자 수 vs 라틴 글자 수.
 *  동률(비어있음 포함)은 'ko' — 한국어 모델도 라틴 단어를 보간 처리하므로
 *  안전한 기본값. */
export function dominantScriptLang(text) {
  let hangul = 0;
  let latin = 0;
  for (const c of text || '') {
    const cp = c.codePointAt(0);
    if ((cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0x3131 && cp <= 0x318e)) hangul++;
    else if ((cp >= 0x41 && cp <= 0x5a) || (cp >= 0x61 && cp <= 0x7a)) latin++;
  }
  return latin > hangul ? 'en' : 'ko';
}

const MIN_GAP_MS = 200;

/** 배치 비중 — 글자가 많은 줄이 더 오래 불린다고 본다. */
function lineWeight(text) {
  return Math.max(1, String(text || '').replace(/\s+/g, '').length);
}

/** lines를 [fromMs, toMs] 구간에 글자 수 비례로 균등 배치한다(제자리 수정). */
function distributeInGap(lines, fromMs, toMs) {
  const span = Math.max(0, toMs - fromMs);
  const total = lines.reduce((s, l) => s + lineWeight(l.text), 0);
  let cursor = fromMs;
  lines.forEach((l) => {
    const share = total > 0 ? (span * lineWeight(l.text)) / total : 0;
    l.start_ms = Math.round(cursor);
    cursor += share;
    l.end_ms = Math.round(Math.max(l.start_ms + MIN_GAP_MS, cursor));
  });
}

/** run이 [fromMs, toMs] 안에 순서대로(최소 간격 확보) 들어가 있는지. */
function runFitsGap(lines, fromMs, toMs) {
  let prev = fromMs;
  for (const l of lines) {
    if (typeof l.start_ms !== 'number') return false;
    if (l.start_ms < prev || l.start_ms > toMs) return false;
    prev = l.start_ms + MIN_GAP_MS;
  }
  return prev <= toMs + MIN_GAP_MS;
}

/**
 * 듀얼(한국어+영어) 정렬 결과를 줄 단위로 병합한다.
 *
 * 줄마다 우세 스크립트 언어의 결과를 채택한다. 두 패스는 서로 다른 Viterbi
 * 경로라 시간축이 어긋날 수 있으므로, 줄 수가 많은 쪽을 앵커로 삼고 소수
 * 언어 줄은 앵커 사이 구간에 맞춘다. 구간을 벗어나면 글자 수 비례로 재배치.
 *
 * @param {Array} koLines 한국어 모델 결과 lines ({text, start_ms, end_ms})
 * @param {Array} enLines 영어 모델 결과 lines
 */
export function mergeDualAlignmentLines(koLines, enLines) {
  const ko = Array.isArray(koLines) ? koLines : [];
  const en = Array.isArray(enLines) ? enLines : [];
  const n = Math.max(ko.length, en.length);
  const merged = [];
  for (let i = 0; i < n; i++) {
    const k = ko[i];
    const e = en[i];
    const text = (k && k.text) || (e && e.text) || '';
    const lang = dominantScriptLang(text);
    const pick = (k && e) ? (lang === 'en' ? e : k) : (k || e);
    merged.push({ ...pick, _lang: lang });
  }

  let koCount = 0;
  merged.forEach((l) => { if (l._lang === 'ko') koCount++; });
  const refLang = koCount >= merged.length - koCount ? 'ko' : 'en';

  const anchorIdx = [];
  merged.forEach((l, i) => {
    if (l._lang === refLang && typeof l.start_ms === 'number') anchorIdx.push(i);
  });

  if (anchorIdx.length > 0) {
    for (let a = 0; a <= anchorIdx.length; a++) {
      const from = a === 0 ? 0 : anchorIdx[a - 1];
      const to = a === anchorIdx.length ? merged.length : anchorIdx[a];
      const run = merged.slice(a === 0 ? 0 : from + 1, to);
      if (run.length === 0) continue;

      const prevAnchor = a === 0 ? null : merged[from];
      const nextAnchor = a === anchorIdx.length ? null : merged[to];
      const gapFrom = prevAnchor
        ? Math.max(prevAnchor.start_ms + MIN_GAP_MS, prevAnchor.end_ms || 0)
        : 0;
      const gapTo = nextAnchor
        ? nextAnchor.start_ms - MIN_GAP_MS
        : Math.max(gapFrom, (run[run.length - 1]?.end_ms) || gapFrom);

      if (gapTo <= gapFrom || !runFitsGap(run, gapFrom, gapTo)) {
        distributeInGap(run, gapFrom, Math.max(gapFrom, gapTo));
      }
    }
  }

  let prevStart = -Infinity;
  merged.forEach((line) => {
    if (typeof line.start_ms !== 'number') return;
    if (line.start_ms < prevStart) line.start_ms = prevStart;
    if (typeof line.end_ms !== 'number' || line.end_ms < line.start_ms + MIN_GAP_MS) {
      line.end_ms = line.start_ms + MIN_GAP_MS;
    }
    prevStart = line.start_ms + MIN_GAP_MS;
  });

  merged.forEach((l) => { delete l._lang; });
  return merged;
}
