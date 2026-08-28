/**
 * alignment-queue.js - AI 가사 정렬 배치 대기열 (헤드리스 순차 처리)
 *
 * 라이브러리에서 여러 곡을 선택해 일괄 정렬을 요청하면, 여기서 한 곡씩
 * 순서대로 처리한다: LRC 로드 -> 미싱크 가사 추출 -> run_forced_alignment ->
 * 결과 병합(mergeAlignmentResult, 오디오와 동일 규칙) -> LRC 저장.
 *
 * 반드시 한 곡씩 순서 처리해야 한다 - 백엔드의 `alignment-progress` 이벤트에는
 * 곡 식별자가 없어서 "지금 processing 중인 항목 = 이 이벤트의 주인"이라는
 * 가정으로 진행률을 그대로 갱신하기 때문. (백엔드 쪽도 ALIGNMENT_QUEUE_LOCK으로
 * 직렬화되므로, 어차피 동시 실행 결과가 꼬이지는 않는다.)
 *
 * 모델 에셋 다운로드는 이 큐의 책임이 아니다: 사용자가 설정에서 고른 언어
 * (getAlignmentLanguage)에 해당하는 모델이 아직 다운로드되어 있지 않으면
 * 항목을 "awaiting-model"로 표시하고 건너뛴다 - 랩/혼합(rap)은 한국어·영어
 * 둘 다 필요하다. 실제 다운로드는 설정 화면의 AI 가사 정렬 모델 카드
 * (events/controls/alignment-model.js)에서 확인 다이얼로그를 거쳐 수행한다.
 */
import { invoke, listen } from './tauri-bridge.js';
import { state } from './state.js';
import { parseLrc, mergeAlignmentResult, getSyncText, encodeLrc, parseMarkers, formatMarkerLine } from './lrc-parser.js';
import {
  getAlignmentLanguage,
  findModelForLanguage,
  requiredLanguagesFor,
  mergeDualAlignmentLines,
  ALIGNMENT_LANGUAGES,
} from './alignment-model.js';

let isRunning = false;
let listenerReady = false;

// 각 항목이 정렬에 성공적으로 완료됐을 때 (path, alignmentLines)로 호출되는
// 리스너들. 예: 싱크 에디터가 지금 열어둔 곡이 큐에서 처리되면 결과를 즉시
// 반영(in-memory 병합, approx 표시 보존)하는 데 쓰인다.
const itemCompleteListeners = [];
export function onAlignmentItemComplete(cb) {
  if (typeof cb === 'function') itemCompleteListeners.push(cb);
}
function notifyItemComplete(path, lines) {
  itemCompleteListeners.forEach((cb) => {
    try { cb(path, lines); } catch (e) { console.error('[AlignQueue] complete listener failed:', e); }
  });
}

/** 대기열이 처리 중이거나 대기 중인 항목이 있는지. */
export function isAlignmentBusy() {
  return state.alignmentQueue.some((i) => i.status === 'queued' || i.status === 'processing');
}

function notifyQueueChanged() {
  import('./ui/components.js').then((m) => {
    if (m.updateTaskUI) m.updateTaskUI();
  }).catch(() => {});
  // 다른 UI(예: "AI 자동 정렬" 버튼의 배지/카운트 표시)도 큐 상태 변화에
  // 반응할 수 있도록 전역 이벤트로 알림.
  try { window.dispatchEvent(new CustomEvent('alignment-queue-changed')); } catch (e) { /* no-op */ }
}

function currentProcessingItem() {
  return state.alignmentQueue.find((item) => item.status === 'processing') || null;
}

async function ensureProgressListener() {
  if (listenerReady) return;
  listenerReady = true;
  await listen('alignment-progress', (event) => {
    const item = currentProcessingItem();
    if (!item) return; // 백엔드의 단발 정렬 진행률(뷰어 등) - 이 큐와 무관
    const p = Number(event.payload);
    if (p === -1) {
      // 백엔드가 이전 정렬 락을 기다리는 중 - 이미 "대기 중"으로 표시돼 있음.
      item.phase = 'queued';
      notifyQueueChanged();
      return;
    }
    if (p === -2) {
      // 전처리/모델 로드 중 — 0%로 보이면 "멈춘 것"처럼 보이므로 preparing으로 표시.
      item.phase = 'preparing';
      item.percentage = 0;
      notifyQueueChanged();
      return;
    }
    if (Number.isFinite(p)) {
      // 듀얼(랩/혼합) 모드는 패스마다 offset/scale을 걸어 전체 0~100%로 이어 보이게.
      item.phase = 'aligning';
      const scaled = (item.progressOffset || 0) + p * (item.progressScale || 1);
      item.percentage = Math.max(0, Math.min(100, scaled));
      notifyQueueChanged();
    }
  });
}

/** 원본 LRC에서 마커 줄([vocalstart]/[ilstart]/[ilend])만 추려 보존용으로
 *  반환한다. 인코딩은 공용 encodeLrc(lrc-parser.js) 사용 시 그대로 뒤에 붙인다. */
function extractMarkerLines(lrcContent) {
  const markers = parseMarkers(lrcContent);
  const lines = [];
  if (typeof markers.vocalStartSec === 'number') {
    lines.push(formatMarkerLine(markers.vocalStartSec, 'vocalstart'));
  }
  markers.interludes.forEach((il) => {
    lines.push(formatMarkerLine(il.start, 'ilstart'));
    lines.push(formatMarkerLine(il.end, 'ilend'));
  });
  return lines;
}

/** 선택한 정렬 언어에 필요한 설치 모델들을 언어별로 반환.
 *  단일 언어는 1개, 랩/혼합은 ko+en 2개. 하나라도 없으면 null.
 *  반환: [{lang, model}] */
async function resolveAlignmentModels() {
  let models = [];
  try {
    models = await invoke('get_model_list');
  } catch (err) {
    console.error('[AlignQueue] get_model_list failed:', err);
    return null;
  }
  const langs = requiredLanguagesFor(getAlignmentLanguage());
  const resolved = [];
  for (const lang of langs) {
    const model = findModelForLanguage(models, lang);
    if (!model) return null;
    resolved.push({ lang, model });
  }
  return resolved;
}

function missingModelErrorMessage(language) {
  if (language === 'rap') {
    return '랩/혼합 정렬에는 한국어·영어 모델이 모두 필요합니다. 설정에서 두 모델을 다운로드한 뒤 다시 시도해 주세요.';
  }
  const label = ALIGNMENT_LANGUAGES[language]?.label || language;
  return `${label} 정렬 모델이 설치되어 있지 않습니다. 설정에서 모델을 다운로드한 뒤 다시 시도해 주세요.`;
}

async function processOne(item) {
  // 1. LRC 로드 + 파싱
  let lrcContent = '';
  try {
    lrcContent = await invoke('load_lrc_file', { audioPath: item.path });
  } catch (err) {
    // 파일 없음 - 가사 자체가 없는 곡
  }
  if (!lrcContent || !lrcContent.trim()) {
    item.status = 'no-lyrics';
    return;
  }
  const segments = parseLrc(lrcContent, 0);
  const allTexts = segments.map((s) => getSyncText(s).trim()).filter((t) => t.length > 0);
  const hasUnsynced = segments.some(
    (s) => s.start === 0 && s.end === 0 && getSyncText(s).trim().length > 0
  );
  if (allTexts.length === 0) {
    item.status = 'no-lyrics';
    return;
  }
  if (!hasUnsynced) {
    // 가사는 있지만 이미 전부 싱크됨 - 할 일 없음, 완료로 처리
    item.status = 'done';
    item.percentage = 100;
    item.phase = 'done';
    item.note = '이미 싱크됨';
    return;
  }

  // 2. 모델 확인 (없으면 이 항목만 실패시키지 않고 "모델 대기" 상태로 표시)
  //    랩/혼합 모드는 한국어+영어 모델이 둘 다 있어야 한다.
  const language = getAlignmentLanguage();
  const modelSpecs = await resolveAlignmentModels();
  if (!modelSpecs) {
    item.status = 'awaiting-model';
    item.error = missingModelErrorMessage(language);
    return;
  }

  // 3. 강제정렬 실행 (백엔드 쪽이 단발 정렬 실행과의 동시성도 직렬화함)
  //    단일 언어는 1패스, 랩/혼합은 언어별 2패스 후 줄 단위 병합.
  const lyrics = allTexts.join('\n');
  const passResults = [];
  for (let pi = 0; pi < modelSpecs.length; pi++) {
    const { lang, model } = modelSpecs[pi];
    item.progressOffset = (100 / modelSpecs.length) * pi;
    item.progressScale = 1 / modelSpecs.length;
    item.passLabel = modelSpecs.length > 1 ? `${pi + 1}/${modelSpecs.length}` : null;
    notifyQueueChanged();
    const result = await invoke('run_forced_alignment', {
      audioPath: item.path,
      lyrics,
      modelName: model,
      language: lang,
    });
    passResults.push((result && result.lines) || []);
  }
  item.progressOffset = 0;
  item.progressScale = 1;
  item.passLabel = null;

  const lines = passResults.length === 2
    ? mergeDualAlignmentLines(passResults[0], passResults[1])
    : (passResults[0] || []);
  const appliedCount = mergeAlignmentResult(segments, lines);
  if (appliedCount === 0) {
    item.status = 'error';
    item.error = 'AI가 정렬한 줄과 일치하는 미싱크 가사를 찾지 못했습니다.';
    return;
  }

  // 4. 저장 (마커 줄 보존)
  const content = encodeLrc(segments, extractMarkerLines(lrcContent));
  await invoke('save_lrc_file', { audioPath: item.path, content });

  // 라이브러리 카드의 가사 보유/싱크 상태 즉시 갱신
  const song = state.songLibrary.find((s) => s.path === item.path);
  if (song) {
    song.hasLyrics = true; song.has_lyrics = true;
    song.lyricSyncStatus = 'synced'; song.lyric_sync_status = 'synced';
  }

  item.status = 'done';
  item.percentage = 100;
  item.phase = 'done';
  item.note = `${appliedCount}줄 반영됨`;

  import('./ui/library.js').then((m) => m.renderLibrary?.()).catch(() => {});
  import('./utils.js').then((m) => m.showNotification?.(`「${song?.title || item.title || '곡'}」 가사 정렬이 완료되었습니다.`, 'success')).catch(() => {});

  // 이 곡이 지금 가사 싱크 에디터에 열려 있으면 결과를 즉시 반영.
  notifyItemComplete(item.path, lines);
}

async function runQueue() {
  if (isRunning) return;
  isRunning = true;
  await ensureProgressListener();
  try {
    for (;;) {
      const item = state.alignmentQueue.find((i) => i.status === 'queued');
      if (!item) break;
      item.status = 'processing';
      item.phase = 'preparing';
      item.percentage = 0;
      notifyQueueChanged();
      try {
        await processOne(item);
      } catch (err) {
        const msg = String(err);
        if (msg.includes('취소')) {
          item.status = 'cancelled';
        } else {
          console.error('[AlignQueue] item failed:', item.path, err);
          item.status = 'error';
          item.error = msg;
        }
      }
      notifyQueueChanged();
      if (item.status === 'done') {
        // 100% 게이지 상태를 잠시 보여준 뒤 대기열에서 제거
        await new Promise((r) => setTimeout(r, 600));
        const idx = state.alignmentQueue.findIndex((i) => i.path === item.path);
        if (idx !== -1) {
          state.alignmentQueue.splice(idx, 1);
          notifyQueueChanged();
        }
      }
    }
  } finally {
    isRunning = false;
  }
}

/** 여러 곡을 정렬 대기열에 추가하고 (미실행 중이면) 순서 처리를 시작한다.
 *  실제로 새로 추가된 개수를 반환. */
export function enqueueAlignment(paths) {
  const active = new Set(
    state.alignmentQueue
      .filter((i) => i.status === 'queued' || i.status === 'processing')
      .map((i) => i.path)
  );
  let added = 0;
  (paths || []).forEach((path) => {
    if (!path || active.has(path)) return;
    // 같은 곡의 지난 실행 결과(done/error 등)가 남아있으면 치우고 다시 등록.
    const staleIdx = state.alignmentQueue.findIndex((i) => i.path === path);
    if (staleIdx !== -1) state.alignmentQueue.splice(staleIdx, 1);
    const song = state.songLibrary.find((s) => s.path === path);
    state.alignmentQueue.push({
      path,
      title: song?.title || path,
      thumbnail: song?.thumbnail || '',
      status: 'queued',
      phase: 'queued',
      percentage: 0,
    });
    active.add(path);
    added++;
  });
  if (added > 0) {
    notifyQueueChanged();
    runQueue();
  }
  return added;
}

/** 정렬 대기열 전체 지우기 - 처리 중인 항목이 있으면 취소하고, 대기/완료/
 *  오류 항목을 모두 목록에서 제거한다. */
export async function clearAlignmentQueue() {
  const processing = state.alignmentQueue.find((i) => i.status === 'processing');
  if (processing) {
    try {
      await invoke('cancel_forced_alignment');
    } catch (err) {
      console.error('[AlignQueue] cancel during clear failed:', err);
    }
  }
  state.alignmentQueue.length = 0;
  notifyQueueChanged();
}

/** 대기열 항목 취소/제거. queued는 즉시 제거(백엔드 호출 없음), processing은
 *  전역 취소 커맨드 호출(현재 정렬은 항상 1개라 안전). done/error 등 완료
 *  상태도 목록에서 치우는 용도. */
export async function cancelAlignmentQueueItem(path) {
  const idx = state.alignmentQueue.findIndex((i) => i.path === path);
  if (idx === -1) return;
  const item = state.alignmentQueue[idx];
  if (item.status === 'processing') {
    try {
      await invoke('cancel_forced_alignment');
    } catch (err) {
      console.error('[AlignQueue] cancel failed:', err);
    }
    // 실제 상태 전환은 runQueue의 에러 처리(취소 메시지)에서 일어남.
  } else {
    state.alignmentQueue.splice(idx, 1);
    notifyQueueChanged();
  }
}
