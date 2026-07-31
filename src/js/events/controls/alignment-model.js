/**
 * AI 가사 정렬(강제정렬) 모델 - 언어 선택(KO/EN) + 다운로드/삭제 관리.
 *
 * 다운로드는 항상 확인 다이얼로그(openConfirmModal)를 거친다: 언어, 원본
 * 출처, 라이선스(Apache-2.0), 예상 용량, "AI 초안 - 사용자가 다듬기" 품질
 * 고지를 보여준 뒤에만 `download_alignment_model`을 호출한다. 진행률은
 * 백엔드가 쏘는 `alignment-model-download-progress` 이벤트({language,
 * percentage})로 갱신한다.
 */
import { listen } from '../../tauri-bridge.js';
import {
  listAlignmentModels,
  downloadAlignmentModel,
  deleteAlignmentModel,
  cancelAlignmentModelDownload,
} from '../../model-api.js';
import { getAlignmentLanguage, setAlignmentLanguage } from '../../alignment-model.js';

let modelsCache = [];
let isDownloading = false;
let progressListenerReady = false;

async function notify(message, type) {
  const { showNotification } = await import('../../utils.js');
  showNotification(message, type);
}

function formatSize(bytes) {
  if (!bytes) return '알 수 없음';
  const mb = bytes / (1024 * 1024);
  return mb >= 1024 ? `약 ${(mb / 1024).toFixed(1)}GB` : `약 ${Math.round(mb)}MB`;
}

function currentInfo() {
  const lang = getAlignmentLanguage();
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
  if (textEl) textEl.textContent = lang === 'en' ? 'English' : '한국어';
  const select = document.getElementById(selectId);
  if (!select) return;
  select.querySelectorAll('.option-item').forEach((opt) => {
    opt.classList.toggle('selected', opt.dataset.value === lang);
  });
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
  const info = currentInfo();
  if (!info) return;

  const downloading = downloadingOverride !== undefined ? downloadingOverride : isDownloading;
  setStatusBadge(statusEl, downloading, downloadingOverride?.percentage, info.downloaded);

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
    const lang = getAlignmentLanguage();
    if (payload.language !== lang) return; // 다른 언어 다운로드 진행률은 이 카드와 무관
    const percentage = Number(payload.percentage) || 0;
    if (percentage >= 100) {
      isDownloading = false;
      refreshAlignmentModelUI();
    } else {
      refreshAlignmentModelUI({ percentage });
    }
  });
}

async function startDownload(info) {
  isDownloading = true;
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
    await refreshAlignmentModelUI();
  }
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
      const info = currentInfo();
      if (!info) return;
      const { openConfirmModal } = await import('../../ui/modals.js');
      openConfirmModal('AI 가사 정렬 모델 다운로드', confirmMessageFor(info), () => {
        startDownload(info);
      });
    };
  }

  if (deleteBtn) {
    deleteBtn.onclick = async () => {
      const info = currentInfo();
      if (!info) return;
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
    };
  }

  ensureProgressListener();
  refreshAlignmentModelUI();
}

// 다운로드 중 설정 창을 닫는 등으로도 취소할 수 있도록 노출(선택적 사용).
export function cancelActiveAlignmentModelDownload() {
  if (isDownloading) cancelAlignmentModelDownload().catch(() => {});
}
