/**
 * separation-mode-modal.js — MR 분리 방식(속도/품질) 선택 모달
 *
 * 컨텍스트 메뉴의 "MR 분리"가 바로 분리를 시작하는 대신 이 모달을 띄운다:
 * ⚡ 빠른 분리(Kim Vocal 2) / ✨ 고품질 분리(Inst HQ 3), 커스텀 모델이
 * 등록돼 있으면 드롭다운으로 추가 노출. 카드를 누르면 즉시 해당 모델로
 * start_mr_separation(path, modelId)이 호출된다(원탭 플로우). "다음부터 바로
 * 분리"를 켠 채 선택하면 전역 기본 모델(updateModelSettings)을 갱신하고
 * 이후로는 모달 없이 그 모델로 바로 분리한다(설정 화면 토글로 되돌릴 수 있음).
 */
import { invoke } from './tauri-bridge.js';
import { showNotification } from './utils.js';
import { getSeparationInfo } from './model-api.js';
import { state } from './state.js';

let initialized = false;
let pendingSong = null;

function modal() { return document.getElementById('separation-mode-modal'); }

function closeModal() {
    const m = modal();
    if (m) m.classList.remove('active');
    pendingSong = null;
}

/** 모달 표시 여부를 설정 화면 토글과 같은 값으로 유지한다. */
function setAskSeparationMode(enabled) {
    state.askSeparationMode = enabled;
    localStorage.setItem('askSeparationMode', String(enabled));
    const toggle = document.getElementById('toggle-ask-separation-mode');
    if (toggle) toggle.checked = enabled;
}

async function startWithModel(modelId) {
    const song = pendingSong;
    if (!song) return;
    const saveDefault = document.getElementById('separation-mode-save-default')?.checked;
    closeModal();

    if (saveDefault && modelId) {
        try {
            await invoke('update_model_settings', { modelId });
            // AI 프로세싱 설정 화면의 모델 드롭다운도 새 기본값으로 동기화.
            import('./events/controls/ai.js').then((m) => {
                if (m.refreshModelDropdown) m.refreshModelDropdown();
            }).catch(() => {});
            setAskSeparationMode(false);
            showNotification(
                '다음부터는 이 모델로 바로 분리합니다. 설정 > AI 분리 엔진에서 되돌릴 수 있어요.',
                'info'
            );
        } catch (err) {
            console.error('[SeparationMode] Failed to save default model:', err);
            showNotification('기본 분리 모델 저장에 실패했습니다.', 'error');
        }
    }

    try {
        const { startMrSeparation } = await import('./audio.js');
        await startMrSeparation(song.path, modelId);
    } catch (err) {
        console.error('[SeparationMode] Separation trigger failed:', err);
    }
}

async function refreshModalState() {
    const titleEl = document.getElementById('separation-mode-song-title');
    if (titleEl && pendingSong) {
        titleEl.textContent = `"${pendingSong.title || pendingSong.path}" 곡을 어떤 방식으로 분리할까요?`;
        // 이전 분리 기록이 있으면 참고용으로 같이 표시 (재분리 판단에 도움)
        const songPath = pendingSong.path;
        getSeparationInfo(songPath).then((info) => {
            if (!info || !pendingSong || pendingSong.path !== songPath) return;
            const when = info.completedAt
                ? new Date(info.completedAt * 1000).toLocaleDateString('ko-KR')
                : '';
            titleEl.textContent += ` (이전 분리: ${info.modelName || info.modelId}${when ? `, ${when}` : ''})`;
        }).catch(() => {});
    }
    const saveDefault = document.getElementById('separation-mode-save-default');
    if (saveDefault) saveDefault.checked = false;

    // 현재 전역 기본 모델 카드 하이라이트
    let activeId = 'kim';
    try { activeId = await invoke('get_model_settings'); } catch (_) {}
    document.querySelectorAll('#separation-mode-modal .separation-mode-card').forEach((card) => {
        card.classList.toggle('current-default', card.dataset.modelId === activeId);
    });

    // 커스텀 모델이 있으면 드롭다운 노출
    const wrap = document.getElementById('separation-mode-custom-wrap');
    const select = document.getElementById('separation-mode-custom-select');
    if (!wrap || !select) return;
    let customs = [];
    try {
        const all = await invoke('list_all_models');
        customs = (all || []).filter((m) => m.isCustom);
    } catch (_) {}
    if (customs.length === 0) {
        wrap.style.display = 'none';
        return;
    }
    wrap.style.display = 'flex';
    select.innerHTML = customs
        .map((m) => `<option value="${m.id}" ${m.id === activeId ? 'selected' : ''}>${m.name}</option>`)
        .join('');
}

function initOnce() {
    if (initialized) return;
    initialized = true;
    const m = modal();
    if (!m) return;

    document.getElementById('separation-mode-close')?.addEventListener('click', closeModal);
    m.addEventListener('click', (e) => { if (e.target === m) closeModal(); });

    m.querySelectorAll('.separation-mode-card').forEach((card) => {
        card.addEventListener('click', () => startWithModel(card.dataset.modelId));
    });

    document.getElementById('separation-mode-custom-start')?.addEventListener('click', () => {
        const select = document.getElementById('separation-mode-custom-select');
        if (select && select.value) startWithModel(select.value);
    });
}

/** 분리 방식 선택 모달을 연다. song: { path, title } */
export function openSeparationModeModal(song) {
    if (!song || !song.path) return;

    // "다음부터 바로 분리"를 켜둔 경우 묻지 않고 기본 모델로 시작.
    if (state.askSeparationMode === false) {
        import('./audio.js').then(({ startMrSeparation }) => startMrSeparation(song.path));
        return;
    }

    initOnce();
    const m = modal();
    if (!m) {
        // 모달 마크업이 없으면(비정상) 기존 동작으로 폴백 — 기본 모델로 바로 분리.
        import('./audio.js').then(({ startMrSeparation }) => startMrSeparation(song.path));
        showNotification('분리 방식 선택 UI를 찾지 못해 기본 모델로 분리합니다.', 'warning');
        return;
    }
    pendingSong = song;
    refreshModalState();
    m.classList.add('active');
}
