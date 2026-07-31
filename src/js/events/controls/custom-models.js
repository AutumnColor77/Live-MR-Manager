/**
 * Custom AI separation model management (add / list / remove).
 *
 * Sources:
 * - local file: native picker on the Rust side
 * - HTTPS URL: requires SHA-256; backend enforces size cap + integrity check
 */
import {
  listModelPresets,
  listCustomModels,
  addCustomModel,
  removeCustomModel,
} from '../../model-api.js';
import { listen } from '../../tauri-bridge.js';
import { refreshModelDropdown } from './ai.js';

let presetsCache = [];
/** @type {'file' | 'url'} */
let sourceKind = 'file';
let progressListenerReady = false;

async function notify(message, type) {
  const { showNotification } = await import('../../utils.js');
  showNotification(message, type);
}

function openModal() {
  const modal = document.getElementById('custom-model-modal');
  if (modal) modal.classList.add('active');
}

function closeModal() {
  const modal = document.getElementById('custom-model-modal');
  if (modal) modal.classList.remove('active');
}

function setSourceKind(kind) {
  sourceKind = kind === 'url' ? 'url' : 'file';
  const urlFields = document.getElementById('cm-url-fields');
  const addBtn = document.getElementById('cm-add-btn');
  const tabFile = document.getElementById('cm-tab-file');
  const tabUrl = document.getElementById('cm-tab-url');
  if (urlFields) urlFields.style.display = sourceKind === 'url' ? 'flex' : 'none';
  if (addBtn) {
    addBtn.textContent = sourceKind === 'url' ? 'URL에서 다운로드하여 추가' : '모델 파일 선택하여 추가';
  }
  if (tabFile) tabFile.classList.toggle('active', sourceKind === 'file');
  if (tabUrl) tabUrl.classList.toggle('active', sourceKind === 'url');
  setProgressVisible(false);
}

function setProgressVisible(visible, pct = 0) {
  const wrap = document.getElementById('cm-download-progress-wrap');
  const bar = document.getElementById('cm-download-bar');
  const label = document.getElementById('cm-download-pct');
  if (wrap) wrap.style.display = visible ? 'block' : 'none';
  if (bar) bar.style.width = `${Math.max(0, Math.min(100, pct))}%`;
  if (label) label.textContent = `${Math.round(pct)}%`;
}

async function ensureProgressListener() {
  if (progressListenerReady) return;
  progressListenerReady = true;
  await listen('custom-model-download-progress', (event) => {
    const percentage = Number(event.payload?.percentage) || 0;
    setProgressVisible(true, percentage);
  });
}

async function populatePresets() {
  const optionsContainer = document.getElementById('cm-preset-options');
  if (!optionsContainer) return;
  try {
    presetsCache = await listModelPresets();
  } catch (err) {
    console.error('Failed to list presets:', err);
    presetsCache = [];
  }
  optionsContainer.innerHTML = presetsCache
    .map((p) => `<div class="option-item" data-value="${p.key}">${p.label}</div>`)
    .join('');
}

function updatePresetDesc(key) {
  const descEl = document.getElementById('cm-preset-desc');
  if (!descEl) return;
  const preset = presetsCache.find((p) => p.key === key);
  descEl.textContent = preset ? preset.description : '';
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function renderCustomList() {
  const listEl = document.getElementById('cm-list');
  if (!listEl) return;
  let models = [];
  try {
    models = await listCustomModels();
  } catch (err) {
    console.error('Failed to list custom models:', err);
  }
  if (!models.length) {
    listEl.innerHTML = '<div class="cm-list-empty">등록된 커스텀 모델이 없습니다.</div>';
    return;
  }
  listEl.innerHTML = models
    .map((m) => {
      const preset = presetsCache.find((p) => p.key === m.presetKey);
      const presetLabel = preset ? preset.label : m.presetKey;
      const sourceLabel = m.url ? 'HTTPS URL' : '로컬 파일';
      return `
        <div class="cm-list-row">
          <div class="cm-list-info">
            <div class="cm-list-name">${escapeHtml(m.name)}</div>
            <div class="cm-list-meta">${escapeHtml(presetLabel)} · ${sourceLabel}</div>
          </div>
          <button class="btn-ai-action danger cm-remove-btn" data-id="${escapeHtml(m.id)}">삭제</button>
        </div>`;
    })
    .join('');

  listEl.querySelectorAll('.cm-remove-btn').forEach((btn) => {
    btn.onclick = async () => {
      const id = btn.dataset.id;
      try {
        await removeCustomModel(id);
        await notify('커스텀 모델이 삭제되었습니다.', 'info');
        await renderCustomList();
        await refreshModelDropdown();
      } catch (err) {
        await notify('삭제 실패: ' + err, 'error');
      }
    };
  });
}

function resetForm() {
  const nameInput = document.getElementById('cm-name');
  const urlInput = document.getElementById('cm-url');
  const shaInput = document.getElementById('cm-sha256');
  if (nameInput) nameInput.value = '';
  if (urlInput) urlInput.value = '';
  if (shaInput) shaInput.value = '';
  setProgressVisible(false);
}

async function doAdd({ name, presetKey, source, expectedSha256 }) {
  const addBtn = document.getElementById('cm-add-btn');
  if (addBtn) addBtn.disabled = true;
  try {
    if (sourceKind === 'url') {
      await ensureProgressListener();
      setProgressVisible(true, 0);
    }
    await addCustomModel({
      name,
      sourceKind,
      source: sourceKind === 'url' ? source : '',
      presetKey,
      expectedSha256: sourceKind === 'url' ? expectedSha256 : undefined,
    });
    await notify('커스텀 모델이 추가되었습니다.', 'success');
    resetForm();
    await renderCustomList();
    await refreshModelDropdown();
  } catch (err) {
    const msg = String(err);
    if (!msg.includes('CANCELLED')) await notify('모델 추가 실패: ' + msg, 'error');
  } finally {
    if (addBtn) addBtn.disabled = false;
    if (sourceKind === 'url') setProgressVisible(false);
  }
}

export function initCustomModelListeners() {
  const openBtn = document.getElementById('btn-manage-custom-models');
  const closeBtn = document.getElementById('custom-model-close');
  const addBtn = document.getElementById('cm-add-btn');
  const nameInput = document.getElementById('cm-name');
  const presetHidden = document.getElementById('cm-preset');
  const tabFile = document.getElementById('cm-tab-file');
  const tabUrl = document.getElementById('cm-tab-url');

  if (openBtn) {
    openBtn.onclick = async () => {
      await populatePresets();
      await renderCustomList();
      updatePresetDesc(presetHidden ? presetHidden.value : '');
      setSourceKind('file');
      openModal();
    };
  }

  if (closeBtn) closeBtn.onclick = closeModal;
  if (tabFile) tabFile.onclick = () => setSourceKind('file');
  if (tabUrl) tabUrl.onclick = () => setSourceKind('url');

  if (presetHidden) {
    presetHidden.addEventListener('change', () => updatePresetDesc(presetHidden.value));
    presetHidden.addEventListener('input', () => updatePresetDesc(presetHidden.value));
  }

  if (addBtn) {
    addBtn.onclick = async () => {
      const name = (nameInput?.value || '').trim();
      const presetKey = presetHidden?.value || '';
      const url = (document.getElementById('cm-url')?.value || '').trim();
      const sha = (document.getElementById('cm-sha256')?.value || '').trim();

      if (!name) { await notify('모델 이름을 입력해주세요.', 'warning'); return; }
      if (!presetKey) { await notify('아키텍처 프리셋을 선택해주세요.', 'warning'); return; }

      if (sourceKind === 'url') {
        if (!url.startsWith('https://')) {
          await notify('HTTPS URL만 사용할 수 있습니다.', 'warning');
          return;
        }
        if (!/^[0-9a-fA-F]{64}$/.test(sha)) {
          await notify('SHA-256은 64자리 16진수여야 합니다.', 'warning');
          return;
        }
        const { openConfirmModal } = await import('../../ui/modals.js');
        openConfirmModal(
          '커스텀 모델 URL 등록',
          `다음 주소에서 모델을 받습니다.\n${url}\n\n` +
            '모델 라이선스와 사용 가능 여부는 직접 확인해 주세요.\n' +
            '계속할까요?',
          () => {
            void doAdd({ name, presetKey, source: url, expectedSha256: sha });
          },
        );
        return;
      }

      await doAdd({ name, presetKey, source: '', expectedSha256: undefined });
    };
  }
}
