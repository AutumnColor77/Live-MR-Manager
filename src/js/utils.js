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
  toast.className = `notification toast-${type}`;
  toast.innerHTML = `
    <div class="notification-icon">${type === 'error' ? '❌' : type === 'warning' ? '⚠️' : 'ℹ️'}</div>
    <div class="notification-content">${msg}</div>
  `;
  container.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = "0";
    toast.style.transform = "translateX(20px)";
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}
