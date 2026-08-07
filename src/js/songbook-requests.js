/**
 * Songbook 신청목록 운영 UI
 */
import { songbookBase } from './companion-links.js';
import { createOwnChannel } from './songbook-sync.js';
import { invoke } from './tauri-bridge.js';
import { showNotification } from './utils.js';
import {
  clearQueue,
  fetchAdminRequests,
  fetchPublicStatus,
  getActiveChannelSlug,
  getSongbookToken,
  patchAdminSettings,
  patchRequestStatus,
  reorderQueue,
  SongbookAuthError,
} from './songbook-requests-api.js';
import {
  findLibrarySong,
  playQueueItem,
  syncPlaybackQueueFromRequests,
} from './playback-queue.js';
import {
  onRequestsTabHidden as markRequestsUnseen,
  onRequestsTabShown as markRequestsSeen,
  refreshSongbookRequestsNow,
} from './songbook-request-poller.js';

let initialized = false;
let pagePollTimer = null;
let busy = false;
let lastStatus = null;
let lastRequests = [];
let queueSortable = null;
let queueDragActive = false;
let lastQueueSignature = '';

function providerLoginButtonHtml(provider) {
  if (provider === 'google') {
    return `
      <button type="button" class="requests-provider-btn is-google" data-provider="google">
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
          <path fill="#EA4335" d="M12 10.2v3.6h5.1c-.2 1.2-.9 2.3-1.9 3l3.1 2.4c1.8-1.7 2.9-4.1 2.9-7 0-.7-.1-1.3-.2-1.9H12z"/>
          <path fill="#34A853" d="M6.6 14.3l-.5.4-2.2 1.7C5.6 19.1 8.6 21 12 21c2.4 0 4.4-.8 5.9-2.2l-3.1-2.4c-.8.6-1.9.9-2.8.9-2.2 0-4-1.5-4.7-3.5z"/>
          <path fill="#4A90E2" d="M4 7.6C3.4 8.8 3 10.1 3 11.5s.4 2.7 1 3.9c0 .1 2.6-2 2.6-2-.2-.5-.3-1-.3-1.5s.1-1 .3-1.5L4 7.6z"/>
          <path fill="#FBBC05" d="M12 5.7c1.3 0 2.5.5 3.4 1.3l2.6-2.6C16.4 2.9 14.4 2 12 2 8.6 2 5.6 3.9 4 6.9l2.7 2.1C7.9 7.1 9.8 5.7 12 5.7z"/>
        </svg>
        <span>Google로 로그인</span>
      </button>`;
  }
  return `
    <button type="button" class="requests-provider-btn is-naver" data-provider="naver">
      <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
        <rect width="24" height="24" rx="4" fill="#03C75A"/>
        <path fill="#fff" d="M7 6.5h3.2l3.1 5.1V6.5H17v11h-3.2l-3.1-5.1v5.1H7V6.5z"/>
      </svg>
      <span>네이버로 로그인</span>
    </button>`;
}

function bindRequestsGateLogin(root = document) {
  root.querySelectorAll('.requests-gate-actions [data-provider]').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      const provider = btn.getAttribute('data-provider');
      const { startSongbookLogin } = await import('./events/songbook-auth.js');
      await startSongbookLogin(provider);
    });
  });
}

const DUP_POLICIES = new Set(['allow', 'queue', 'played']);

function resolveDuplicatePolicy(status) {
  if (DUP_POLICIES.has(status?.duplicatePolicy)) {
    return status.duplicatePolicy;
  }
  return status?.allowDuplicateRequests === false ? 'queue' : 'allow';
}

function dupPolicyToast(policy) {
  if (policy === 'queue') return '대기열 중복만 차단합니다.';
  if (policy === 'played') return '이번 방송에서 부른 곡도 차단합니다. 대기열 비우기로 초기화됩니다.';
  return '중복 신청을 허용합니다.';
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function openExternalUrl(url) {
  if (window.__TAURI__?.core?.invoke) {
    try {
      await window.__TAURI__.core.invoke('plugin:opener|open_url', { url });
      return;
    } catch {
      /* fallback */
    }
    try {
      await invoke('open_app_update_page', { url });
      return;
    } catch {
      /* fallback */
    }
  }
  window.open(url, '_blank', 'noopener');
}

async function handleAuthExpired() {
  try {
    await invoke('clear_songbook_auth');
  } catch {
    /* ignore */
  }
  window.dispatchEvent(new CustomEvent('songbook-requests-auth-expired'));
  showNotification('세션이 만료되었습니다. 다시 로그인해 주세요.', 'error');
  renderGateState();
}

function queueActionsHtml(item) {
  const id = escapeHtml(item.id);
  const local = findLibrarySong(item.title, item.artist);
  const hasLocal = Boolean(local?.path) && !String(local.path).startsWith('songbook:song:');
  const localBadge = hasLocal
    ? '<span class="request-local-badge" title="라이브러리에 있음">MR</span>'
    : '<span class="request-local-badge missing" title="라이브러리에 없음">—</span>';

  if (item.status === 'playing') {
    return `
      <div class="request-queue-actions">
        ${localBadge}
        <button type="button" class="btn-ai-action secondary btn-sm request-act" data-act="done" data-id="${id}">완료</button>
        <button type="button" class="btn-ai-action secondary btn-sm request-act" data-act="rejected" data-id="${id}">거절</button>
      </div>`;
  }
  return `
    <div class="request-queue-actions">
      ${localBadge}
      <button type="button" class="btn-ai-action btn-sm request-act" data-act="playing" data-id="${id}" ${hasLocal ? '' : 'disabled title="라이브러리에 없는 곡"'}>재생</button>
      <button type="button" class="btn-ai-action secondary btn-sm request-act" data-act="done" data-id="${id}">완료</button>
      <button type="button" class="btn-ai-action secondary btn-sm request-act" data-act="rejected" data-id="${id}">거절</button>
    </div>`;
}

function renderDashboard(status, requests) {
  const root = document.getElementById('requests-page-root');
  if (!root) return;

  const slug = getActiveChannelSlug();
  const channelName = status?.channel?.name || slug;
  const accepting = Boolean(status?.acceptingRequests);

  const active = (requests || [])
    .filter((r) => r.status === 'pending' || r.status === 'playing')
    .sort((a, b) => {
      const ao = a.sortOrder ?? a.createdAt ?? 0;
      const bo = b.sortOrder ?? b.createdAt ?? 0;
      if (ao !== bo) return ao - bo;
      return (a.createdAt || 0) - (b.createdAt || 0);
    });

  const label = document.getElementById('requests-channel-label');
  if (label) {
    label.textContent = channelName ? `${channelName} · /c/${slug}` : '채널';
  }

  if (!document.getElementById('requests-dashboard') || !document.getElementById('requests-dup-past-toggle')) {
    root.innerHTML = `
      <div class="requests-dashboard" id="requests-dashboard">
        <section class="settings-group requests-section">
          <div class="group-header requests-section-header">
            <div class="requests-section-header-left">
              <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M22 12h-4l-3 9L9 3l-3 9H2"></path>
              </svg>
              <h3>신청 접수</h3>
            </div>
            <div id="requests-controls" class="requests-channel-actions">
              <span id="requests-channel-label" class="requests-channel-label">채널</span>
              <button type="button" id="btn-open-songbook-viewer" class="secondary-btn btn-sm" title="시청자 노래책 열기">노래책 열기</button>
            </div>
          </div>
          <div class="ai-model-card">
            <div class="ai-info-left">
              <h2 class="ai-title-large" id="requests-accepting-label">…</h2>
              <div class="ai-model-desc" id="requests-accepting-desc">시청자 페이지에서 곡 신청을 받습니다.</div>
            </div>
            <div class="ai-actions-right">
              <button type="button" id="requests-accepting-toggle" class="btn-ai-action">신청 마감하기</button>
            </div>
          </div>
        </section>

        <section class="settings-group requests-section">
          <div class="task-section-header-row group-header">
            <div class="task-section-header" style="cursor: default;">
              <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <line x1="8" y1="6" x2="21" y2="6"></line>
                <line x1="8" y1="12" x2="21" y2="12"></line>
                <line x1="8" y1="18" x2="21" y2="18"></line>
                <line x1="3" y1="6" x2="3.01" y2="6"></line>
                <line x1="3" y1="12" x2="3.01" y2="12"></line>
                <line x1="3" y1="18" x2="3.01" y2="18"></line>
              </svg>
              <h3 class="task-section-title">대기열</h3>
              <span id="requests-queue-count" class="task-section-count">0</span>
            </div>
            <div class="requests-queue-actions-bar">
              <div class="requests-dup-past-chip" id="requests-dup-past-chip" title="중복 차단이 켜져 있을 때만 사용할 수 있습니다">
                <span class="requests-dup-past-label">과거 곡도 차단</span>
                <label class="switch requests-dup-past-switch">
                  <input type="checkbox" id="requests-dup-past-toggle">
                  <span class="slider round"></span>
                </label>
              </div>
              <button type="button" id="requests-dup-toggle" class="task-section-clear">중복 신청 차단</button>
              <button type="button" id="requests-queue-clear" class="task-section-clear">대기열 비우기</button>
            </div>
          </div>
          <div id="requests-queue-list" class="requests-queue-list"></div>
        </section>
      </div>`;

    document.getElementById('requests-accepting-toggle')?.addEventListener('click', () => void toggleAccepting());
    document.getElementById('requests-dup-toggle')?.addEventListener('click', () => void toggleDuplicateBlock());
    document.getElementById('requests-dup-past-toggle')?.addEventListener('change', (e) => {
      void setDuplicatePastBlock(Boolean(e.target.checked));
    });
    document.getElementById('requests-queue-clear')?.addEventListener('click', () => void clearAllQueue());
    document.getElementById('btn-open-songbook-viewer')?.addEventListener('click', () => {
      const currentSlug = getActiveChannelSlug();
      if (!currentSlug) {
        showNotification('채널이 없습니다.', 'warning');
        return;
      }
      void openExternalUrl(`${songbookBase()}/c/${encodeURIComponent(currentSlug)}`);
    });
    document.getElementById('requests-queue-list')?.addEventListener('click', (e) => {
      const btn = e.target.closest('.request-act');
      if (!btn || busy) return;
      const id = btn.dataset.id;
      const act = btn.dataset.act;
      if (id && act) void handleRequestAction(id, act);
    });
  }

  const acceptingLabel = document.getElementById('requests-accepting-label');
  const acceptingDesc = document.getElementById('requests-accepting-desc');
  const toggle = document.getElementById('requests-accepting-toggle');
  if (acceptingLabel) {
    acceptingLabel.textContent = accepting ? '신청 받는 중' : '신청 마감';
  }
  if (acceptingDesc) {
    acceptingDesc.textContent = accepting
      ? '시청자 페이지에서 곡 신청을 받습니다.'
      : '신청이 마감되어 새 곡을 받지 않습니다.';
  }
  if (toggle) {
    toggle.textContent = accepting ? '신청 마감하기' : '신청 다시 열기';
    toggle.classList.toggle('secondary', !accepting);
  }

  const countEl = document.getElementById('requests-queue-count');
  if (countEl) countEl.textContent = String(active.length);

  const dupPolicy = resolveDuplicatePolicy(status);
  const blocking = dupPolicy !== 'allow';
  const pastBlock = dupPolicy === 'played';

  const dupToggle = document.getElementById('requests-dup-toggle');
  if (dupToggle) {
    dupToggle.textContent = blocking ? '중복 신청 허용' : '중복 신청 차단';
    dupToggle.classList.toggle('is-blocking', blocking);
    dupToggle.title = blocking
      ? '중복 신청을 다시 허용합니다'
      : '대기열에 같은 곡이 있으면 추가 신청을 막습니다';
  }

  const pastChip = document.getElementById('requests-dup-past-chip');
  const pastToggle = document.getElementById('requests-dup-past-toggle');
  if (pastChip) {
    pastChip.classList.toggle('is-disabled', !blocking);
    pastChip.title = blocking
      ? '이번 방송에서 완료한 곡도 재신청을 막습니다. 대기열 비우기로 초기화됩니다.'
      : '중복 신청 차단을 먼저 켜 주세요';
  }
  if (pastToggle) {
    pastToggle.disabled = !blocking;
    pastToggle.checked = blocking && pastBlock;
  }

  const clearBtn = document.getElementById('requests-queue-clear');
  if (clearBtn) clearBtn.disabled = false;

  // 드래그 중에는 목록 DOM을 건드리지 않음 (폴링이 드래그를 끊지 않게)
  if (queueDragActive) return;

  const list = document.getElementById('requests-queue-list');
  if (list) {
    const signature = active
      .map((r) => `${r.id}:${r.status}:${r.title}:${r.comment || ''}`)
      .join('|');
    const shouldRewrite = signature !== lastQueueSignature || !list.querySelector('.request-queue-row');
    if (active.length === 0) {
      destroyQueueSortable();
      list.innerHTML = '<div class="requests-queue-empty">대기 중인 곡이 없습니다.</div>';
      lastQueueSignature = signature;
    } else if (shouldRewrite) {
      list.innerHTML = active
        .map((item, index) => {
          const playingBadge = item.status === 'playing'
            ? '<span class="request-status-badge playing">재생중</span>'
            : '';
          const comment = item.comment
            ? `<p class="request-comment">${escapeHtml(item.comment)}</p>`
            : '';
          return `
            <div class="request-queue-row" data-id="${escapeHtml(item.id)}">
              <span class="queue-drag-handle" title="드래그하여 순서 변경" aria-hidden="true">⋮⋮</span>
              <span class="queue-index">${index + 1}</span>
              <div class="request-queue-main">
                <div class="request-queue-title-row">
                  <p class="song-name">${escapeHtml(item.title)}</p>
                  ${playingBadge}
                </div>
                <p class="song-artist">${escapeHtml(item.artist)} · ${escapeHtml(item.nickname || '익명')}</p>
                ${comment}
              </div>
              ${queueActionsHtml(item)}
            </div>`;
        })
        .join('');
      lastQueueSignature = signature;
      bindQueueSortable(list);
    } else {
      // 내용 동일 — 번호만 맞추고 Sortable 유지
      list.querySelectorAll('.request-queue-row .queue-index').forEach((el, i) => {
        el.textContent = String(i + 1);
      });
      if (!queueSortable) bindQueueSortable(list);
    }
  }
}

function destroyQueueSortable() {
  if (queueSortable) {
    try {
      queueSortable.destroy();
    } catch {
      /* ignore */
    }
    queueSortable = null;
  }
  queueDragActive = false;
}

function bindQueueSortable(list) {
  if (!list) return;
  destroyQueueSortable();

  const SortableCtor = window.Sortable;
  if (typeof SortableCtor !== 'function') {
    console.warn('[SongbookRequests] Sortable.js unavailable');
    return;
  }

  queueSortable = new SortableCtor(list, {
    animation: 150,
    draggable: '.request-queue-row',
    ghostClass: 'request-queue-ghost',
    chosenClass: 'request-queue-chosen',
    dragClass: 'request-queue-drag',
    filter: 'button, .request-act, input, label, .switch',
    preventOnFilter: true,
    // WebView2 HTML5 DnD가 불안정해서 마우스 fallback 사용
    forceFallback: true,
    fallbackOnBody: true,
    fallbackTolerance: 4,
    onStart: () => {
      queueDragActive = true;
    },
    onEnd: (evt) => {
      queueDragActive = false;
      if (evt.oldIndex == null || evt.newIndex == null || evt.oldIndex === evt.newIndex) {
        return;
      }
      void commitQueueOrder(list);
    },
  });
}

async function commitQueueOrder(list) {
  const ids = Array.from(list.querySelectorAll('.request-queue-row'))
    .map((r) => r.dataset.id || '')
    .filter(Boolean);

  list.querySelectorAll('.request-queue-row .queue-index').forEach((el, i) => {
    el.textContent = String(i + 1);
  });
  lastQueueSignature = ids
    .map((id) => {
      const req = lastRequests.find((r) => r.id === id);
      return req ? `${req.id}:${req.status}:${req.title}:${req.comment || ''}` : id;
    })
    .join('|');

  const slug = getActiveChannelSlug();
  if (!slug || busy) return;

  busy = true;
  try {
    await reorderQueue(slug, ids);
    for (let i = 0; i < ids.length; i++) {
      const req = lastRequests.find((r) => r.id === ids[i]);
      if (req) req.sortOrder = i;
    }
    syncPlaybackQueueFromRequests(lastRequests);
  } catch (err) {
    if (err instanceof SongbookAuthError) {
      showNotification('세션이 만료되었습니다. 다시 로그인해 주세요.', 'error');
      renderGateState();
      return;
    }
    showNotification(err?.message || '순서 변경에 실패했습니다.', 'error');
    lastQueueSignature = '';
    await refreshPage();
  } finally {
    busy = false;
  }
}

function renderGateState() {
  const root = document.getElementById('requests-page-root');
  if (!root) return;

  void getSongbookToken().then(async (token) => {
    const slug = getActiveChannelSlug();
    if (!token) {
      root.innerHTML = `
        <div class="requests-gate-state" id="requests-empty-state">
          <p>Songbook에 로그인하면 시청자 신청을 관리할 수 있습니다.</p>
          <div class="requests-gate-actions">
            ${providerLoginButtonHtml('google')}
            ${providerLoginButtonHtml('naver')}
          </div>
        </div>`;
      bindRequestsGateLogin(root);
      return;
    }

    if (!slug) {
      root.innerHTML = `
        <div class="requests-gate-state" id="requests-empty-state">
          <p>신청을 받으려면 Songbook 채널이 필요합니다.</p>
          <div class="requests-gate-actions">
            <button type="button" class="btn-ai-action requests-gate-btn" id="btn-requests-create-channel">채널 만들기</button>
          </div>
        </div>`;
      document.getElementById('btn-requests-create-channel')?.addEventListener('click', () => void createChannelFromRequests());
      return;
    }

    if (lastStatus) {
      renderDashboard(lastStatus, lastRequests);
    } else {
      void refreshPage();
    }
  });
}

async function confirmAsync(title, message) {
  const { openConfirmModal } = await import('./ui/modals.js');
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    openConfirmModal(title, message, () => finish(true));
    const cancelBtn = document.getElementById('confirm-cancel');
    const closeIcon = document.getElementById('confirm-close-icon');
    const modal = document.getElementById('confirm-modal');
    const wrapCancel = () => finish(false);
    if (cancelBtn) {
      cancelBtn.addEventListener('click', wrapCancel, { once: true });
    }
    if (closeIcon) {
      closeIcon.addEventListener('click', wrapCancel, { once: true });
    }
    if (modal) {
      const onBackdrop = (e) => {
        if (e.target === modal) wrapCancel();
      };
      modal.addEventListener('click', onBackdrop, { once: true });
    }
  });
}

async function createChannelFromRequests() {
  try {
    const token = await getSongbookToken();
    if (!token) throw new Error('로그인이 필요합니다.');
    const auth = await invoke('get_songbook_auth');
    const user = auth?.user;
    await createOwnChannel(token, user?.name || user?.email);
    showNotification('채널이 생성되었습니다.', 'success');
    await refreshPage();
  } catch (err) {
    showNotification(err?.message || '채널 생성에 실패했습니다.', 'error');
  }
}

async function refreshPage() {
  if (queueDragActive) return;
  const slug = getActiveChannelSlug();
  const token = await getSongbookToken();
  if (!token || !slug) {
    renderGateState();
    return;
  }

  try {
    const [status, requests] = await Promise.all([
      fetchPublicStatus(slug),
      fetchAdminRequests(slug),
    ]);
    lastStatus = status;
    lastRequests = requests;
    syncPlaybackQueueFromRequests(requests);
    renderDashboard(status, requests);
  } catch (err) {
    if (err instanceof SongbookAuthError) {
      await handleAuthExpired();
      return;
    }
    console.error('[SongbookRequests]', err);
  }
}

async function toggleAccepting() {
  if (busy || !lastStatus) return;
  const slug = getActiveChannelSlug();
  if (!slug) return;
  busy = true;
  try {
    const next = !lastStatus.acceptingRequests;
    await patchAdminSettings(slug, { acceptingRequests: next });
    showNotification(next ? '신청을 열었습니다.' : '신청을 마감했습니다.', 'success');
    await refreshPage();
    await refreshSongbookRequestsNow();
  } catch (err) {
    if (err instanceof SongbookAuthError) {
      await handleAuthExpired();
    } else {
      showNotification(err?.message || '설정 변경 실패', 'error');
    }
  } finally {
    busy = false;
  }
}

async function applyDuplicatePolicy(next) {
  if (busy || !lastStatus) return;
  const slug = getActiveChannelSlug();
  if (!slug) return;
  busy = true;
  try {
    await patchAdminSettings(slug, { duplicatePolicy: next });
    showNotification(dupPolicyToast(next), 'success');
    await refreshPage();
    await refreshSongbookRequestsNow();
  } catch (err) {
    if (err instanceof SongbookAuthError) {
      await handleAuthExpired();
    } else {
      showNotification(err?.message || '설정 변경 실패', 'error');
    }
  } finally {
    busy = false;
    // 실패/갱신 시 스위치 상태를 서버 기준으로 다시 맞춤
    const pastToggle = document.getElementById('requests-dup-past-toggle');
    if (pastToggle && lastStatus) {
      const policy = resolveDuplicatePolicy(lastStatus);
      pastToggle.checked = policy === 'played';
      pastToggle.disabled = policy === 'allow';
    }
  }
}

async function toggleDuplicateBlock() {
  if (busy || !lastStatus) return;
  const current = resolveDuplicatePolicy(lastStatus);
  const next = current === 'allow' ? 'queue' : 'allow';
  await applyDuplicatePolicy(next);
}

async function setDuplicatePastBlock(enabled) {
  if (busy || !lastStatus) return;
  const current = resolveDuplicatePolicy(lastStatus);
  if (current === 'allow') {
    const pastToggle = document.getElementById('requests-dup-past-toggle');
    if (pastToggle) pastToggle.checked = false;
    return;
  }
  const next = enabled ? 'played' : 'queue';
  if (next === current) return;
  await applyDuplicatePolicy(next);
}

async function clearAllQueue() {
  if (busy) return;
  const slug = getActiveChannelSlug();
  if (!slug) return;
  const count = (lastRequests || []).filter((r) => r.status === 'pending' || r.status === 'playing').length;
  const title = count > 0 ? '대기열 비우기' : '부른 곡 기록 초기화';
  const message = count > 0
    ? `대기열 ${count}곡을 모두 비웁니다.\n부른 곡 중복 기록도 초기화됩니다. 계속할까요?`
    : '부른 곡 중복 기록을 초기화합니다. 계속할까요?';

  const ok = await confirmAsync(title, message);
  if (!ok) return;

  busy = true;
  try {
    const cleared = await clearQueue(slug);
    showNotification(
      cleared > 0
        ? `대기열 ${cleared}곡을 비웠고, 부른 곡 기록을 초기화했습니다.`
        : '부른 곡 중복 기록을 초기화했습니다.',
      'success',
    );
    await refreshPage();
    await refreshSongbookRequestsNow();
  } catch (err) {
    if (err instanceof SongbookAuthError) {
      await handleAuthExpired();
    } else {
      showNotification(err?.message || '초기화 실패', 'error');
    }
  } finally {
    busy = false;
  }
}

async function handleRequestAction(id, act) {
  if (busy) return;
  const slug = getActiveChannelSlug();
  if (!slug) return;
  const item = (lastRequests || []).find((r) => r.id === id);
  if (!item) return;

  busy = true;
  try {
    if (act === 'playing') {
      const song = findLibrarySong(item.title, item.artist);
      if (!song?.path || String(song.path).startsWith('songbook:song:')) {
        showNotification('라이브러리에 재생 가능한 음원이 없습니다.', 'warning');
        return;
      }
      await patchRequestStatus(slug, id, 'playing');
      const { markAutoPlayedRequest } = await import('./songbook-request-poller.js');
      markAutoPlayedRequest(id);
      await playQueueItem({
        requestId: id,
        path: song.path,
        title: item.title,
        artist: item.artist,
      }, { patchPlaying: false, slug });
    } else {
      await patchRequestStatus(slug, id, act);
      const labels = { done: '완료 처리', rejected: '거절 처리' };
      showNotification(labels[act] || '처리 완료', 'success');
    }
    await refreshPage();
    await refreshSongbookRequestsNow();
  } catch (err) {
    if (err instanceof SongbookAuthError) {
      await handleAuthExpired();
    } else {
      showNotification(err?.message || '처리 실패', 'error');
    }
  } finally {
    busy = false;
  }
}

function startPagePolling() {
  if (pagePollTimer !== null) return;
  pagePollTimer = window.setInterval(() => void refreshPage(), 4000);
}

function stopPagePolling() {
  if (pagePollTimer !== null) {
    window.clearInterval(pagePollTimer);
    pagePollTimer = null;
  }
}

function onRequestsUpdated(event) {
  const detail = event?.detail;
  if (!detail || queueDragActive) return;
  lastStatus = detail.status;
  lastRequests = detail.requests;
  if (document.getElementById('requests-dashboard')) {
    renderDashboard(detail.status, detail.requests);
  }
}

export function initSongbookRequestsPage() {
  if (initialized) {
    void refreshPage();
    return;
  }
  initialized = true;

  window.addEventListener('songbook-requests-updated', onRequestsUpdated);
  window.addEventListener('songbook-auth-ready', () => void refreshPage());
  window.addEventListener('songbook-requests-auth-expired', () => renderGateState());

  bindRequestsGateLogin(document.getElementById('requests-page-root') || document);

  void refreshPage();
}

export function onRequestsTabShown() {
  markRequestsSeen();
  startPagePolling();
  void refreshPage();
}

export function onRequestsTabHidden() {
  markRequestsUnseen();
  stopPagePolling();
}
