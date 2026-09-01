/**
 * utils.js - Formatting and common utility functions
 */

import { convertFileSrc, invoke } from './tauri-bridge.js';

/** Escape untrusted text for HTML text and quoted attributes. */
export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function formatTime(sec) {
  if (isNaN(sec) || sec < 0) return "0:00";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export function getThumbnailUrl(path, song) {
  if (!path) return "assets/images/Thumb_Music.png";
  if (path.startsWith("http")) return path;
  try { 
    return convertFileSrc(path); 
  } catch (e) { 
    return (song && song.source === "youtube") ? song.path : "assets/images/Thumb_Music.png"; 
  }
}

export function showNotification(msg, type = "info") {
  // 터미널 디버깅을 위해 백엔드로 로그 전송
  const logPrefix = `[Notification:${type.toUpperCase()}]`;
  console.log(`${logPrefix} ${msg}`);
  invoke("remote_js_log", { msg: `${logPrefix} ${msg}` }).catch(() => {});

  const container = document.getElementById("notification-container");
  if (!container) return;

  const toast = document.createElement("div");
  // CSS에 정의된 .toast 및 타입별 클래스(info, success, error, warning) 적용
  toast.className = `toast ${type}`;
  
  // 프리미엄 아이콘 (SVG) 구성
  const icons = {
    info: `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>`,
    success: `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>`,
    warning: `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`,
    error: `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>`
  };

  const icon = document.createElement('div');
  icon.className = 'toast-icon';
  icon.innerHTML = icons[type] || icons.info;

  const message = document.createElement('div');
  message.className = 'toast-message';
  message.textContent = String(msg ?? '');

  toast.appendChild(icon);
  toast.appendChild(message);
  container.appendChild(toast);

  // 3초 후 애니메이션과 함께 제거
  setTimeout(() => {
    toast.classList.add("removing");
    // CSS .toast.removing 의 트랜지션 시간(0.3s) 이후 엘리먼트 완전 제거
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}

const DISMISSED_UPDATE_KEY = "dismissedAppUpdateVersion";

export function showUpdateAvailable(info) {
  if (!info?.hasUpdate) return;

  const latest = info.latestVersion || info.latest_version;
  const current = info.currentVersion || info.current_version;
  const releaseUrl = info.releaseUrl || info.release_url;
  if (!latest) return;

  if (localStorage.getItem(DISMISSED_UPDATE_KEY) === latest) return;

  const container = document.getElementById("notification-container");
  if (!container) return;

  const existing = container.querySelector(".toast.update-available");
  if (existing) existing.remove();

  const toast = document.createElement("div");
  toast.className = "toast info update-available";
  toast.innerHTML = `
    <div class="toast-icon">
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
        <polyline points="7 10 12 15 17 10"/>
        <line x1="12" y1="15" x2="12" y2="3"/>
      </svg>
    </div>
    <div class="toast-body">
      <div class="toast-message"></div>
      <div class="toast-actions">
        <button type="button" class="toast-btn primary" data-action="download">다운로드</button>
        <button type="button" class="toast-btn" data-action="dismiss">나중에</button>
      </div>
    </div>
  `;
  const msgEl = toast.querySelector('.toast-message');
  if (msgEl) {
    msgEl.textContent = `새 버전 v${latest}이(가) 있습니다. (현재 v${current})`;
  }

  toast.querySelector('[data-action="download"]')?.addEventListener("click", async () => {
    try {
      await invoke("open_app_update_page", { url: releaseUrl || "" });
    } catch (err) {
      console.error("[Updater] Failed to open release page:", err);
      showNotification("릴리스 페이지를 열지 못했습니다.", "error");
    }
  });

  toast.querySelector('[data-action="dismiss"]')?.addEventListener("click", () => {
    localStorage.setItem(DISMISSED_UPDATE_KEY, latest);
    toast.classList.add("removing");
    setTimeout(() => toast.remove(), 300);
  });

  container.appendChild(toast);
  invoke("remote_js_log", { msg: `[Updater] Notified user: v${latest} available` }).catch(() => {});
}

export const RATING_MAX = 5;

/** 1–5 → ★★★☆☆ HTML, 빈 값 → 미설정 */
export function ratingStarsHtml(count) {
  const n = Number.parseInt(count, 10);
  if (!Number.isFinite(n) || n < 1 || n > RATING_MAX) {
    return '<span class="rating-stars rating-stars-unset">미설정</span>';
  }
  const filled = '★'.repeat(n);
  const empty = '☆'.repeat(RATING_MAX - n);
  return `<span class="rating-stars" aria-label="${n}점"><span class="rating-stars-filled">${filled}</span><span class="rating-stars-empty">${empty}</span></span>`;
}

function updateMetaStarRatingUI(container, value) {
  const n = Number.parseInt(value, 10);
  const valid = Number.isFinite(n) && n >= 1 && n <= RATING_MAX;
  container.querySelectorAll('.meta-star').forEach((btn) => {
    const starN = Number.parseInt(btn.dataset.value, 10);
    const on = valid && starN <= n;
    btn.classList.toggle('is-on', on);
    btn.textContent = on ? '★' : '☆';
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  });
}

function bindMetaStarRating(container, hidden) {
  if (container.dataset.bound === '1') return;
  container.dataset.bound = '1';

  const preview = (hoverValue) => updateMetaStarRatingUI(container, hoverValue);
  const restore = () => updateMetaStarRatingUI(container, hidden.value);

  container.querySelectorAll('.meta-star').forEach((btn) => {
    btn.addEventListener('click', () => {
      hidden.value = btn.dataset.value ?? '';
      restore();
      hidden.dispatchEvent(new Event('input', { bubbles: true }));
      hidden.dispatchEvent(new Event('change', { bubbles: true }));
    });
    btn.addEventListener('mouseenter', () => preview(btn.dataset.value ?? ''));
  });

  container.addEventListener('mouseleave', restore);
}

/** 곡 편집 모달 — 난이도/숙련도 별 클릭 선택 초기화 */
export function initMetaStarRatings(root = document) {
  root.querySelectorAll('.meta-star-rating').forEach((container) => {
    const hiddenId = container.dataset.input;
    if (!hiddenId) return;
    const hidden = document.getElementById(hiddenId);
    if (!hidden) return;
    bindMetaStarRating(container, hidden);
    updateMetaStarRatingUI(container, hidden.value);
  });
}

export function setMetaStarRating(containerId, hiddenId, value) {
  const container = document.getElementById(containerId);
  const hidden = document.getElementById(hiddenId);
  if (!container || !hidden) return;

  const val = value != null && value !== '' ? String(value) : '';
  hidden.value = val;
  bindMetaStarRating(container, hidden);
  updateMetaStarRatingUI(container, val);
}

