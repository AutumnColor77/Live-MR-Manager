/**
 * utils.js - Formatting and common utility functions
 */

const { convertFileSrc } = window.__TAURI__.core;

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

  toast.innerHTML = `
    <div class="toast-icon">${icons[type] || icons.info}</div>
    <div class="toast-message">${msg}</div>
  `;
  container.appendChild(toast);

  // 3초 후 애니메이션과 함께 제거
  setTimeout(() => {
    toast.classList.add("removing");
    // CSS .toast.removing 의 트랜지션 시간(0.3s) 이후 엘리먼트 완전 제거
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}

