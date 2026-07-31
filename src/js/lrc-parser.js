/**
 * lrc-parser.js - Pure LRC parsing (no Tauri dependency)
 */

// Standalone time-region markers (vocal start point, instrumental interlude
// bounds). Unlike section tags these don't own a lyric line, so they're
// encoded as their own marker-only lines, e.g. `[00:12.34][vocalstart]`, and
// parsed separately from `parseLrc()`'s segment list via `parseMarkers()`.
const MARKER_TAGS = ['vocalstart', 'ilstart', 'ilend'];
const markerAlternation = MARKER_TAGS.join('|');
const markerLineRegex = new RegExp(`^\\[(\\d{1,2}):(\\d{2}(?:\\.\\d{1,3})?)\\]\\[(${markerAlternation})\\]\\s*$`);
const markerOnlyRegex = new RegExp(`^\\[(${markerAlternation})\\]\\s*$`);

function isMarkerOnlyLine(timeStrippedRest) {
  return markerOnlyRegex.test(timeStrippedRest.trim());
}

/**
 * Extracts the vocal-start anchor and instrumental-interlude regions from
 * raw LRC text. Returns `{ vocalStartSec: number|null, interludes: {start,end}[] }`.
 * `ilstart`/`ilend` markers are paired in chronological order; an unpaired
 * trailing `ilstart` (e.g. file edited by hand) is dropped rather than
 * producing a broken open-ended region.
 */
export function parseMarkers(lrcContent) {
  const result = { vocalStartSec: null, interludes: [] };
  if (!lrcContent) return result;

  const lines = lrcContent.replace(/\r\n/g, '\n').split('\n');
  const ilStarts = [];
  const ilEnds = [];

  lines.forEach((line) => {
    const match = markerLineRegex.exec(line.trim());
    if (!match) return;
    const time = parseInt(match[1], 10) * 60 + parseFloat(match[2]);
    const tag = match[3];
    if (tag === 'vocalstart') {
      result.vocalStartSec = time;
    } else if (tag === 'ilstart') {
      ilStarts.push(time);
    } else if (tag === 'ilend') {
      ilEnds.push(time);
    }
  });

  ilStarts.sort((a, b) => a - b);
  ilEnds.sort((a, b) => a - b);
  const pairCount = Math.min(ilStarts.length, ilEnds.length);
  for (let i = 0; i < pairCount; i++) {
    if (ilEnds[i] > ilStarts[i]) {
      result.interludes.push({ start: ilStarts[i], end: ilEnds[i] });
    }
  }
  return result;
}

export function formatMarkerLine(sec, tag) {
  const min = Math.floor(sec / 60).toString().padStart(2, '0');
  const s = (sec % 60).toFixed(2).padStart(5, '0');
  return `[${min}:${s}][${tag}]`;
}

/**
 * 마커 시간 입력 파싱. 마커 목록에서 직접 시각을 고쳐 쓸 때 사용.
 * `mm:ss`, `mm:ss.xx`, 초 단독("83", "83.5") 모두 허용. 무효 입력은 null.
 */
export function parseTimeInput(str) {
  const t = (str || '').trim();
  if (!t) return null;
  const colon = /^(\d{1,3}):(\d{1,2}(?:\.\d{1,3})?)$/.exec(t);
  if (colon) {
    const sec = Number(colon[2]);
    if (sec >= 60) return null;
    return Number(colon[1]) * 60 + sec;
  }
  const plain = /^\d+(?:\.\d{1,3})?$/.exec(t);
  if (plain) return Number(t);
  return null;
}

/** 마커 시간 표시 포맷 — `mm:ss.xx` (parseTimeInput과 라운드트립). */
export function formatTimeInput(sec) {
  if (typeof sec !== 'number' || !Number.isFinite(sec) || sec < 0) return '';
  const min = Math.floor(sec / 60).toString().padStart(2, '0');
  const s = (sec % 60).toFixed(2).padStart(5, '0');
  return `${min}:${s}`;
}

function normalizeLyricText(text = '') {
  return text
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/\u00A0/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

// Triplet cues (원문/차음/번역 — original/pronunciation/translation), used for
// e.g. Japanese lyrics where one sung moment needs three lines: the original
// script, a Hangul phonetic reading, and a Korean translation. Unlike section
// tags these three lines share ONE timestamp and collapse into a single
// segment. Encoded as three consecutive tagged lines:
//   [00:12.34][orig]<original>
//   [00:12.34][pron]<pronunciation>
//   [00:12.34][tran]<translation>
// Grouping keys off seeing `orig` (always starts a new cue) rather than
// timestamp equality, since unsynced cues all sit at `00:00.00` and would
// otherwise collide into one group.
const TRIPLET_FIELD_BY_TAG = { orig: 'original', pron: 'pronunciation', tran: 'translation' };
const tripletTagRegex = /^\[(orig|pron|tran)\]([\s\S]*)$/;

export function isTriplet(seg) {
  return !!(seg && (seg.original !== undefined || seg.pronunciation !== undefined || seg.translation !== undefined));
}

/** The text sync tools (tap/grid/AI-align) should match against — pronunciation for
 * triplet cues (closest to the actual sung audio), plain `text` otherwise. */
export function getSyncText(seg) {
  if (!seg) return '';
  return isTriplet(seg) ? (seg.pronunciation || '') : (seg.text || '');
}

// Per-surface triplet line visibility. 'app' covers the sync editor preview
// + the in-app lyric drawer; 'overlay' covers the OBS-facing overlay only —
// letting users show e.g. only 차음 on stream while keeping 원문+차음 in-app,
// or any other combination of 원문/차음/번역 per surface.
const LINE_VISIBILITY_KEY_PREFIX = 'lyricsLineVisibility_';
const DEFAULT_LINE_VISIBILITY = { original: true, pronunciation: true, translation: false };

export function getLineVisibility(scope = 'app') {
  const raw = localStorage.getItem(LINE_VISIBILITY_KEY_PREFIX + scope);
  if (!raw) return { ...DEFAULT_LINE_VISIBILITY };
  try {
    return { ...DEFAULT_LINE_VISIBILITY, ...JSON.parse(raw) };
  } catch (e) {
    return { ...DEFAULT_LINE_VISIBILITY };
  }
}

export function setLineVisibility(scope, key, value) {
  const current = getLineVisibility(scope);
  current[key] = value;
  localStorage.setItem(LINE_VISIBILITY_KEY_PREFIX + scope, JSON.stringify(current));
}

/** Back-compat helpers for the sync editor's single "번역 보기" quick toggle —
 * scoped to 'app' since that toggle only ever affected the in-app preview. */
export function getShowTranslation(scope = 'app') {
  return getLineVisibility(scope).translation;
}

export function setShowTranslation(show, scope = 'app') {
  setLineVisibility(scope, 'translation', show);
}

/** Builds the display lines for a segment per-surface visibility settings.
 * Plain (non-triplet) segments always just return their `text`. If a triplet
 * cue's visible set is empty (user turned everything off for this surface),
 * falls back to the pronunciation line (or whatever's available) rather than
 * rendering nothing. */
export function getDisplayLines(seg, scope = 'app') {
  if (!isTriplet(seg)) return [seg?.text || ''];
  const vis = getLineVisibility(scope);
  const lines = [];
  if (vis.original && seg.original) lines.push(seg.original);
  if (vis.pronunciation && seg.pronunciation) lines.push(seg.pronunciation);
  if (vis.translation && seg.translation) lines.push(seg.translation);
  if (lines.length === 0) {
    const fallback = seg.pronunciation || seg.original || seg.translation || '';
    if (fallback) lines.push(fallback);
  }
  return lines;
}

/**
 * 정렬된 세그먼트로부터 "노래 시작(보컬 시작)" 후보 시각을 계산한다.
 * MV 인트로(영상/대사) 다음에 실제 노래가 시작하는 지점 = 가장 이른 싱크
 * 줄의 시작 시각. 약간의 리드인을 빼고(leadIn), 인트로가 유의미하게 길 때만
 * (minSec 이상) 제안한다. 제안할 값이 없으면 null.
 *  - `minSec`: 이보다 짧은 인트로는 굳이 마커를 만들 필요 없어 무시(기본 3s).
 *  - `leadIn`: 첫 발음 직전 아주 앞에서부터 시작하도록 빼는 여유(기본 0.3s).
 */
export function suggestVocalStartFromSegments(segments, { minSec = 3, leadIn = 0.3 } = {}) {
  if (!Array.isArray(segments)) return null;
  let earliest = Infinity;
  for (const s of segments) {
    const start = s && s.start;
    if (typeof start === 'number' && start > 0 && start < earliest) earliest = start;
  }
  if (!Number.isFinite(earliest) || earliest < minSec) return null;
  return Math.max(0, earliest - leadIn);
}

/**
 * 인트로 자동 건너뛰기용 목표 지점을 계산한다. 보컬 시작 앞에 붙은
 * 간주(전주) 마커가 있으면 그 간주의 시작으로(전주 자체는 안 스킵), 없으면
 * 보컬 시작으로. LRC/마커가 없으면 null. (getIntroSkipTargetSec 참고)
 *
 * @param markers parseMarkers 결과 ({vocalStartSec, interludes})
 * @param toleranceSec 간주 끝이 보컬 시작보다 아주 늦어도 인접으로 인정할 여유(기본 1s)
 */
export function getIntroSkipTargetSec(markers, toleranceSec = 1) {
  if (!markers || typeof markers.vocalStartSec !== 'number') return null;
  const vocalStart = markers.vocalStartSec;
  let target = vocalStart;
  (markers.interludes || []).forEach((il) => {
    if (!il || typeof il.start !== 'number' || typeof il.end !== 'number') return;
    // 보컬 시작 이전(허용 오차 이내)에 끝나는 간주 = 전주. 가장 이른 시작 채택.
    if (il.start < vocalStart && il.end <= vocalStart + toleranceSec && il.start < target) {
      target = il.start;
    }
  });
  return target;
}

/**
 * 정렬 결과 매칭용 텍스트 정규화.
 *
 * 백엔드(alignment.rs::clean_lyrics)는 정렬 전 가사에서 대괄호/괄호 메타데이터
 * ([Chorus]/(Intro))를 지우고 `?!.,-+_~` 등을 공백으로 치환하며, 토크나이저
 * 자체가 문장부호·특수기호를 걸러낸다. 그래서 백엔드가 돌려주는 줄 텍스트는 원본
 * LRC 세그먼트 텍스트와 문장부호가 달라, 안전한 문장부호 없는 축약형으로
 * 감싸 준다: `don't`, `baby,`, `faith-departed` 같은 것도 정확히 일치하지 않아
 * 정렬이 병합되지 않았던 것과 같은 규칙으로 정규화해 비교한다:
 * 소문자화 → 괄호 메타 제거 → 글자/숫자 외 문자를 공백으로 → 공백 정리.
 */
function normalizeForMatch(s) {
  return (s || '')
    .toLowerCase()
    .replace(/[\[(<][^\])>]*[\])>]/g, ' ') // 대괄호/괄호/꺾쇠 메타 제거(백엔드와 동일)
    .replace(/[^\p{L}\p{N}]+/gu, ' ')      // 글자·숫자 외(문장부호·따옴표·기호) → 공백
    .trim()
    .replace(/\s+/g, ' ');
}

/**
 * Merges AI forced-alignment results into lyric segments. Non-destructive:
 * only segments that are still fully unsynced (start===0 && end===0) are
 * filled in, matched to alignment lines by sync text (차음 for triplets),
 * and marked `approx: true` so the UI can flag them for manual review.
 * Shared by the interactive editor (alignment-viewer.js) and the headless
 * batch queue (alignment-queue.js) — keep both paths on this one function.
 * Returns the number of segments updated.
 */
export function mergeAlignmentResult(segments, lines) {
  if (!Array.isArray(segments) || !Array.isArray(lines) || lines.length === 0) return 0;
  const used = new Array(lines.length).fill(false);
  const lineKeys = lines.map((l) => normalizeForMatch(l.text));
  let appliedCount = 0;
  segments.forEach((seg) => {
    if (!(seg.start === 0 && seg.end === 0)) return; // 이미 싱크된 줄은 보존
    const text = getSyncText(seg).trim();
    if (!text) return;
    const key = normalizeForMatch(text);
    if (!key) return;
    const idx = lineKeys.findIndex((lk, i) => !used[i] && lk === key);
    if (idx === -1) return;
    used[idx] = true;
    const line = lines[idx];
    seg.start = Math.max(0, line.start_ms / 1000);
    seg.end = Math.max(seg.start + 0.05, line.end_ms / 1000);
    seg.approx = true;
    appliedCount++;
  });
  return appliedCount;
}

/**
 * Serializes lyric segments (+ optional standalone marker lines) to LRC text.
 *
 * 각 줄은 **세그먼트 순서 그대로** 기록한다 — 시간순으로 정렬하면 미싱크
 * 줄(전부 00:00.00)이 저장할 때마다 파일 맨 위로 몰려 부분 싱크된 곡의
 * 가사 순서가 다시 로드될 때 뒤섞이는 버그가 있었다. parseLrc는 파일 순서를
 * 세그먼트 순서로 그대로 따르므로 원래 텍스트 순서가 그대로 보존된다.
 * 마커 줄([vocalstart]/[ilstart]/[ilend])은 파싱시 위치와 무관하므로
 * (parseMarkers가 전체 스캔, parseLrc는 마커 전용 줄을 무시) 파일 끝에
 * 시간순으로 붙인다.
 *
 * @param segments 세그먼트 배열 ({text|original/pronunciation/translation, start})
 * @param markerLines 마커 문자열 배열 (formatMarkerLine 결과), 시간순 정렬됨
 */
export function encodeLrc(segments, markerLines = []) {
  const lines = [];
  (segments || []).forEach((s) => {
    const min = Math.floor(s.start / 60).toString().padStart(2, '0');
    const sec = (s.start % 60).toFixed(2).padStart(5, '0');
    const ts = `[${min}:${sec}]`;
    if (isTriplet(s)) {
      lines.push(`${ts}[orig]${s.original || ''}`);
      lines.push(`${ts}[pron]${s.pronunciation || ''}`);
      lines.push(`${ts}[tran]${s.translation || ''}`);
    } else if ((s.text || '').trim()) {
      lines.push(`${ts}${s.text}`);
    }
  });
  (markerLines || []).forEach((m) => lines.push(m));
  return lines.join('\n');
}

export function parseLrc(lrcContent, duration = 0) {
  if (!lrcContent) return [];

  const lines = lrcContent.replace(/\r\n/g, '\n').split('\n');
  const segments = [];
  // NOTE: 1-2자리 분(mm) + 선택적 소수점 초를 허용 (긴 곡/외부 도구 호환).
  const timeRegex = /\[(\d{1,2}):(\d{2}(?:\.\d{1,3})?)\]/;
  const metadataRegex = /^\[[a-zA-Z]{2,8}\s*:[^\]]*\]$/;

  let pendingTriplet = null;
  const flushTriplet = () => {
    if (pendingTriplet) {
      pendingTriplet.text = pendingTriplet.original;
      segments.push(pendingTriplet);
      pendingTriplet = null;
    }
  };

  lines.forEach((line) => {
    const match = timeRegex.exec(line);
    if (match) {
      const min = parseInt(match[1], 10);
      const sec = parseFloat(match[2]);
      const start = min * 60 + sec;
      const timeStr = match[0];
      const rest = line.replace(timeStr, '');
      if (isMarkerOnlyLine(rest)) return; // vocalstart/ilstart/ilend — not a lyric line

      const tripletMatch = tripletTagRegex.exec(rest.trimStart());
      if (tripletMatch) {
        const field = TRIPLET_FIELD_BY_TAG[tripletMatch[1]];
        const text = normalizeLyricText(tripletMatch[2]);
        if (tripletMatch[1] === 'orig' || !pendingTriplet) {
          flushTriplet();
          pendingTriplet = { original: '', pronunciation: '', translation: '', start, end: 0 };
        }
        pendingTriplet[field] = text;
        pendingTriplet.start = start;
        return;
      }

      flushTriplet();
      const text = normalizeLyricText(rest);
      if (text) {
        segments.push({ text, start, end: 0 });
      }
    } else if (line.trim()) {
      flushTriplet();
      const normalized = normalizeLyricText(line);
      if (!normalized) return;
      if (metadataRegex.test(normalized)) return;
      segments.push({ text: normalized, start: 0, end: 0 });
    }
  });
  flushTriplet();

  for (let i = 0; i < segments.length - 1; i++) {
    if (segments[i].start > 0 && segments[i + 1].start > 0) {
      segments[i].end = segments[i + 1].start;
    } else {
      segments[i].end = 0;
    }
  }

  if (segments.length > 0) {
    segments[segments.length - 1].end = duration > 0 ? duration : 0;
  }

  return segments;
}
