/**
 * 가사 싱크 데이터 — 원문 / 블럭 / 타임코드 분리 저장.
 *
 * 목적: 곡의 싱크 작업 결과(어느 시각에 어느 줄이 나오는지)를 **가사 원문 없이**
 * 저장·공유할 수 있게 한다. 가사 텍스트는 저작물이라 재배포하면 안 되지만,
 * "몇 번째 줄이 몇 초에 나온다"는 타이밍 정보 자체는 텍스트가 아니다.
 *
 * 그래서 이 포맷은 **어떤 형태로도 가사 텍스트를 담지 않는다.** 대신:
 *   - 블럭 구조(줄 수, 줄별 글자 수, 3줄 가사 여부)
 *   - 타임코드(줄별 start/end)
 *   - 마커(보컬 시작, 간주 구간)
 *   - 검증용 지문(정규화 가사의 짧은 해시)
 * 만 담는다. 받는 쪽은 자기가 이미 가진 가사에 이 타이밍을 얹는다.
 *
 * 지문(fingerprint)에 짧은 비암호학적 해시(FNV-1a 32비트)를 쓰는 건 의도적이다.
 * 목적이 "같은 가사인지 확인"일 뿐 무결성 보증이 아니고, 짧고 충돌이 잦은
 * 해시일수록 원문 복원 도구로 쓰기 어렵다(줄별 해시는 아예 저장하지 않고
 * 전체 해시 하나만 둔다 — 줄 단위 해시는 짧은 줄에서 역추적 여지가 커진다).
 */

import { isTriplet, getSyncText } from './lrc-parser.js';

/** 이 포맷의 버전. 구조가 바뀌면 올리고, 읽는 쪽에서 거부/변환 판단에 쓴다. */
export const SYNC_DATA_VERSION = 1;

/**
 * 지문 계산용 정규화 — 표기 차이(공백·대소문자·문장부호)로 같은 가사가
 * 다르다고 판정되지 않게 한다. 정렬 매칭(normalizeForMatch)과 같은 취지.
 */
function normalizeForFingerprint(text) {
  return (text || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '')
    .trim();
}

/** FNV-1a 32비트. 짧고 빠르며, 원문 복원 용도로는 쓸모없을 만큼 정보량이 작다. */
function fnv1a32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** 가사 전체의 지문. 줄 순서까지 반영해야 하므로 구분자를 넣고 이어붙인다. */
export function lyricsFingerprint(segments) {
  const joined = (segments || [])
    .map((s) => normalizeForFingerprint(getSyncText(s)))
    .join('');
  return fnv1a32(joined).toString(16).padStart(8, '0');
}

function round3(n) {
  return Math.round((Number(n) || 0) * 1000) / 1000;
}

/**
 * 세그먼트 + 마커에서 공유 가능한 싱크 데이터를 만든다. **텍스트는 담지 않는다.**
 *
 * @param segments  parseLrc가 만든 세그먼트 배열
 * @param markers   parseMarkers 결과 ({ vocalStartSec, interludes })
 * @param meta      { songKey, duration } — songKey는 곡 식별자(예: 유튜브 영상 ID)
 */
export function buildSyncData(segments, markers = {}, meta = {}) {
  const segs = Array.isArray(segments) ? segments : [];
  const lines = segs.map((s) => ({
    start: round3(s.start),
    end: round3(s.end),
    // 글자 수만 — 원문 복원은 불가능하고, 구조가 맞는지 대조하는 데는 충분하다.
    len: normalizeForFingerprint(getSyncText(s)).length,
  }));

  return {
    formatVersion: SYNC_DATA_VERSION,
    songKey: meta.songKey || '',
    duration: round3(meta.duration),
    createdAt: Math.floor(Date.now() / 1000),
    lineCount: lines.length,
    // 3줄 가사(원문/차음/번역) 곡인지 — 받는 쪽 가사 구조가 같아야 얹을 수 있다.
    triplet: segs.some((s) => isTriplet(s)),
    fingerprint: lyricsFingerprint(segs),
    lines,
    markers: {
      vocalStart: markers.vocalStartSec == null ? null : round3(markers.vocalStartSec),
      interludes: (markers.interludes || []).map((il) => [round3(il.start), round3(il.end)]),
    },
  };
}

/**
 * 받은 싱크 데이터가 내 가사에 얹을 수 있는지 판정한다.
 *
 * 반환: { ok, level, reason }
 *   level 'exact'    — 지문까지 일치. 같은 가사로 만든 데이터.
 *   level 'structure'— 줄 수·글자 수 구조는 맞지만 지문이 다름(표기가 조금 다른
 *                      가사본). 얹을 수는 있으나 사용자에게 알려야 한다.
 *   level 'none'     — 구조가 달라 얹으면 엉뚱한 줄에 붙는다. 거부.
 */
export function checkSyncDataCompatibility(segments, data) {
  const segs = Array.isArray(segments) ? segments : [];
  if (!data || typeof data !== 'object') {
    return { ok: false, level: 'none', reason: '싱크 데이터가 비어 있습니다.' };
  }
  if (data.formatVersion !== SYNC_DATA_VERSION) {
    return { ok: false, level: 'none', reason: `지원하지 않는 형식 버전입니다 (v${data.formatVersion}).` };
  }
  const lines = Array.isArray(data.lines) ? data.lines : [];
  if (lines.length === 0) {
    return { ok: false, level: 'none', reason: '타임코드가 없습니다.' };
  }
  if (lines.length !== segs.length) {
    return {
      ok: false,
      level: 'none',
      reason: `가사 줄 수가 다릅니다 (내 가사 ${segs.length}줄 / 싱크 데이터 ${lines.length}줄).`,
    };
  }
  if (!!data.triplet !== segs.some((s) => isTriplet(s))) {
    return { ok: false, level: 'none', reason: '3줄 가사 여부가 서로 다릅니다.' };
  }
  if (data.fingerprint && data.fingerprint === lyricsFingerprint(segs)) {
    return { ok: true, level: 'exact', reason: '' };
  }
  // 지문이 달라도 줄별 글자 수가 대체로 맞으면 같은 곡의 다른 표기본으로 본다.
  let mismatched = 0;
  segs.forEach((s, i) => {
    const mine = normalizeForFingerprint(getSyncText(s)).length;
    if (Math.abs(mine - (lines[i].len || 0)) > 2) mismatched++;
  });
  const ratio = mismatched / segs.length;
  if (ratio > 0.3) {
    return {
      ok: false,
      level: 'none',
      reason: `가사 내용이 많이 다릅니다 (${Math.round(ratio * 100)}% 불일치).`,
    };
  }
  return { ok: true, level: 'structure', reason: '가사 표기가 조금 달라 타이밍이 어긋날 수 있습니다.' };
}

/**
 * 싱크 데이터의 타임코드를 내 가사 세그먼트에 얹는다(제자리 수정).
 * 호환성 검사를 통과한 경우에만 적용하며, 통과 못 하면 아무것도 바꾸지 않는다.
 *
 * @param opts.overwriteSynced 이미 싱크된 줄도 덮어쓸지(기본 false — 수동 작업 보존)
 * @returns { applied, level, reason }
 */
export function applySyncData(segments, data, opts = {}) {
  const check = checkSyncDataCompatibility(segments, data);
  if (!check.ok) return { applied: 0, level: check.level, reason: check.reason };

  const overwrite = !!opts.overwriteSynced;
  let applied = 0;
  segments.forEach((seg, i) => {
    const line = data.lines[i];
    if (!line) return;
    // 기본은 미싱크 줄만 채운다 — 사용자가 직접 맞춘 타이밍을 덮지 않기 위해.
    const isUnsynced = seg.start === 0 && seg.end === 0;
    if (!overwrite && !isUnsynced) return;
    seg.start = Math.max(0, Number(line.start) || 0);
    seg.end = Math.max(seg.start + 0.05, Number(line.end) || 0);
    // 남이 만든 타이밍이라 내 곡에서 미세하게 어긋날 수 있음을 표시(정렬 결과와 동일 취급).
    seg.approx = true;
    applied++;
  });

  return { applied, level: check.level, reason: check.reason };
}
