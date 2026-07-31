/**
 * AI 가사 정렬(강제정렬) 모델 - 언어 선택(KO/EN/랩·혼합) + 다운로드/삭제 관리.
 *
 * 다운로드는 항상 확인 다이얼로그(openConfirmModal)를 거친다: 언어, 원본
 * 출처, 라이선스(Apache-2.0), 예상 용량, "AI 초안 - 사용자가 다듬기" 품질
 * 고지를 보여준 뒤에만 `download_alignment_model`을 호출한다. 진행률은
 * 백엔드가 쏘는 `alignment-model-download-progress` 이벤트({language,
 * percentage})로 갱신한다.
 *
 * 랩/혼합(rap)은 자체 모델이 없고 한국어·영어 둘 다 필요하다. 상태 배지는
 * 두 모델 설치 여부를 합쳐 표시하고, 다운로드는 아직 없는 쪽부터 받는다.
 */
import { listen } from '../../tauri-bridge.js';
import {
  listAlignmentModels,
  downloadAlignmentModel,
  deleteAlignmentModel,
  cancelAlignmentModelDownload,
} from '../../model-api.js';
import {
  getAlignmentLanguage,
  setAlignmentLanguage,
  requiredLanguagesFor,
  ALIGNMENT_LANGUAGES,
} from '../../alignment-model.js';

let modelsCache = [];
let isDownloading = false;
let progressListenerReady = false;
/** 랩/혼합에서 순차 다운로드 중인 실제 언어(ko/en). */
let downloadingLang = null;

async function notify(message, type) {
  const { showNotification } = await import('../../utils.js');
  showNotification(message, type);
}

function formatSize(bytes) {
  if (!bytes) return '알 수 없음';
  const mb = bytes / (1024 * 1024);
  return mb >= 1024 ? `약 ${(mb / 1024).toFixed(1)}GB` : `약 ${Math.round(mb)}MB`;
}

function infoFor(lang) {
  return modelsCache.find((m) => m.language === lang) || null;
}

function setStatusBadge(el, downloading, percent, downloaded) {
  if (!el) return;
  el.classList.remove('status-online', 'status-offline', 'status-loading');
  if (downloading) {
    el.classList.add('status-loading');
    el.textContent = `다운로드 중... (${Math.floor(percent || 0)}%)`;
  } else if (downloaded) {
    el.classList.add('status-online');
    el.textContent = '모델 준비됨';
  } else {
    el.classList.add('status-offline');
    el.textContent = '미설치';
  }
}

/** 설정 카드와 가사 싱크 화면에 같은 언어 선택을 반영한다(둘 다 같은 문서). */
function applyLanguageToDropdown(selectId, textId, lang) {
  const textEl = document.getElementById(textId);
  if (textEl) textEl.textContent = ALIGNMENT_LANGUAGES[lang]?.label || '한국어';
  const select = document.getElementById(selectId);
  if (!select) return;
  select.querySelectorAll('.option-item').forEach((opt) => {
    opt.classList.toggle('selected', opt.dataset.value === lang);
  });
}

function rapStatusSummary() {
  const ko = infoFor('ko');
  const en = infoFor('en');
  const koOk = !!ko?.downloaded;
  const enOk = !!en?.downloaded;
  if (koOk && enOk) return { downloaded: true, label: '한국어·영어 모델 준비됨' };
  const missing = [];
  if (!koOk) missing.push('한국어');
  if (!enOk) missing.push('영어');
  return { downloaded: false, label: `${missing.join('·')} 미설치` };
}

export async function refreshAlignmentModelUI(downloadingOverride) {
  const statusEl = document.getElementById('align-model-status');
  const descEl = document.getElementById('align-model-desc');
  const downloadBtn = document.getElementById('btn-download-align-model');
  const deleteBtn = document.getElementById('btn-delete-align-model');

  const lang = getAlignmentLanguage();
  applyLanguageToDropdown('align-language-select-dropdown', 'selected-align-language-text', lang);
  applyLanguageToDropdown('align-viewer-language-select', 'selected-align-viewer-language-text', lang);
  if (!statusEl) return;

  try {
    modelsCache = await listAlignmentModels();
  } catch (err) {
    console.error('[AlignModel] listAlignmentModels failed:', err);
    return;
  }

  const downloading = downloadingOverride !== undefined ? downloadingOverride : isDownloading;
  const percent = typeof downloadingOverride === 'object' ? downloadingOverride.percentage : undefined;

  if (lang === 'rap') {
    const summary = rapStatusSummary();
    const anyInstalled = !!(infoFor('ko')?.downloaded || infoFor('en')?.downloaded);
    if (downloading) {
      setStatusBadge(statusEl, true, percent, false);
    } else {
      statusEl.classList.remove('status-online', 'status-offline', 'status-loading');
      statusEl.classList.add(summary.downloaded ? 'status-online' : 'status-offline');
      statusEl.textContent = summary.label;
    }
    if (downloadBtn) downloadBtn.style.display = (downloading || summary.downloaded) ? 'none' : 'inline-flex';
    if (deleteBtn) deleteBtn.style.display = (!downloading && anyInstalled) ? 'inline-flex' : 'none';
    if (descEl) {
      descEl.innerHTML =
        '한·영이 섞인 가사에 한국어·영어 모델을 각각 돌린 뒤 줄마다 맞는 쪽을 씁니다. ' +
        '정렬 시간은 대략 두 배입니다. 결과는 <strong>AI 초안</strong>이므로 다듬어 사용하세요.';
    }
    return;
  }

  const info = infoFor(lang);
  if (!info) return;

  setStatusBadge(statusEl, downloading, percent, info.downloaded);

  if (downloadBtn) downloadBtn.style.display = (downloading || info.downloaded) ? 'none' : 'inline-flex';
  if (deleteBtn) deleteBtn.style.display = (!downloading && info.downloaded) ? 'inline-flex' : 'none';

  if (descEl) {
    descEl.innerHTML =
      `${info.displayName}<br>` +
      `결과는 <strong>AI 초안</strong>이므로 다듬어 사용하세요.`;
  }
}

function confirmMessageFor(info) {
  const langLabel = info.language === 'en' ? '영어(English)' : '한국어';
  return (
    `${langLabel} 가사 정렬 모델을 다운로드합니다.\n` +
    `용량 약 ${formatSize(info.modelSizeBytes)} · 라이선스: ${info.license}\n\n` +
    `정렬 결과는 AI 초안이며, 정확한 싱크를 보장하지 않습니다.\n` +
    `다운로드를 진행할까요?`
  );
}

async function ensureProgressListener() {
  if (progressListenerReady) return;
  progressListenerReady = true;
  await listen('alignment-model-download-progress', (event) => {
    const payload = event.payload || {};
    const expected = downloadingLang || getAlignmentLanguage();
    if (payload.language !== expected) return;
    const percentage = Number(payload.percentage) || 0;
    if (percentage >= 100) {
      isDownloading = false;
      downloadingLang = null;
      refreshAlignmentModelUI();
    } else {
      refreshAlignmentModelUI({ percentage });
    }
  });
}

async function startDownload(info) {
  isDownloading = true;
  downloadingLang = info.language;
  await refreshAlignmentModelUI({ percentage: 0 });
  try {
    await downloadAlignmentModel(info.language);
    await notify('AI 가사 정렬 모델 다운로드가 완료되었습니다.', 'success');
  } catch (err) {
    const msg = String(err);
    if (!msg.includes('취소')) {
      await notify('정렬 모델 다운로드 실패: ' + msg, 'error');
    }
  } finally {
    isDownloading = false;
    downloadingLang = null;
    await refreshAlignmentModelUI();
  }
}

/** 랩/혼합에서 아직 없는 쪽 모델부터 확인 후 다운로드. */
async function startMissingRapDownloads() {
  const missing = requiredLanguagesFor('rap')
    .map((l) => infoFor(l))
    .filter((info) => info && !info.downloaded);
  if (missing.length === 0) return;

  const { openConfirmModal } = await import('../../ui/modals.js');
  const first = missing[0];
  const moreNote = missing.length > 1
    ? `\n(랩/혼합에는 ${missing.map((m) => (m.language === 'en' ? '영어' : '한국어')).join('·')} 모델이 모두 필요합니다. 이어서 안내합니다.)`
    : '';
  openConfirmModal(
    'AI 가사 정렬 모델 다운로드',
    confirmMessageFor(first) + moreNote,
    async () => {
      await startDownload(first);
      // 첫 다운로드 후 아직 남은 모델이 있으면 이어서 확인.
      await refreshAlignmentModelUI();
      const stillMissing = requiredLanguagesFor('rap')
        .map((l) => infoFor(l))
        .filter((info) => info && !info.downloaded);
      if (stillMissing.length > 0 && !isDownloading) {
        startMissingRapDownloads();
      }
    }
  );
}

export function initAlignmentModelListeners() {
  const langSelect = document.getElementById('align-language-select-dropdown');
  const downloadBtn = document.getElementById('btn-download-align-model');
  const deleteBtn = document.getElementById('btn-delete-align-model');

  if (langSelect) {
    langSelect.addEventListener('click', async (e) => {
      const option = e.target.closest('.option-item');
      if (!option) return;
      const lang = option.dataset.value;
      if (!lang) return;
      setAlignmentLanguage(lang);
      await refreshAlignmentModelUI();
    });
  }

  if (downloadBtn) {
    downloadBtn.onclick = async () => {
      if (isDownloading) return;
      if (getAlignmentLanguage() === 'rap') {
        startMissingRapDownloads();
        return;
      }
      const info = infoFor(getAlignmentLanguage());
      if (!info) return;
      const { openConfirmModal } = await import('../../ui/modals.js');
      openConfirmModal('AI 가사 정렬 모델 다운로드', confirmMessageFor(info), () => {
        startDownload(info);
      });
    };
  }

  if (deleteBtn) {
    deleteBtn.onclick = async () => {
      const lang = getAlignmentLanguage();
      const { openConfirmModal } = await import('../../ui/modals.js');

      if (lang === 'rap') {
        const installed = requiredLanguagesFor('rap')
          .map((l) => infoFor(l))
          .filter((info) => info?.downloaded);
        if (installed.length === 0) return;
        const names = installed.map((i) => (i.language === 'en' ? '영어' : '한국어')).join('·');
        openConfirmModal(
          '정렬 모델 삭제',
          `설치된 ${names} 정렬 모델을 삭제할까요?\n다시 쓰려면 새로 다운로드해야 합니다.`,
          async () => {
            deleteBtn.disabled = true;
            try {
              for (const info of installed) {
                await deleteAlignmentModel(info.language);
              }
              await notify('정렬 모델이 삭제되었습니다.', 'info');
              await refreshAlignmentModelUI();
            } catch (err) {
              await notify('삭제 실패: ' + err, 'error');
            } finally {
              deleteBtn.disabled = false;
            }
          }
        );
        return;
      }

      const info = infoFor(lang);
      if (!info) return;
      openConfirmModal(
        '정렬 모델 삭제',
        `${info.language === 'en' ? '영어' : '한국어'} 정렬 모델을 삭제할까요?\n다시 쓰려면 새로 다운로드해야 합니다.`,
        async () => {
          deleteBtn.disabled = true;
          try {
            await deleteAlignmentModel(info.language);
            await notify('정렬 모델이 삭제되었습니다.', 'info');
            await refreshAlignmentModelUI();
          } catch (err) {
            await notify('삭제 실패: ' + err, 'error');
          } finally {
            deleteBtn.disabled = false;
          }
        }
      );
    };
  }

  ensureProgressListener();
  refreshAlignmentModelUI();
}

// 다운로드 중 설정 창을 닫는 등으로도 취소할 수 있도록 노출(선택적 사용).
export function cancelActiveAlignmentModelDownload() {
  if (isDownloading) cancelAlignmentModelDownload().catch(() => {});
}
