/**
 * js/events/navigation.js - Sidebar Navigation & Tabs
 */
import { state } from '../state.js';
import { elements } from '../ui/elements.js';
import { renderLibrary } from '../ui/library.js';
import { updateBroadcastTasksControlVisibility } from '../ui/components.js';
import { setupGridResizeObserver } from '../ui/core.js';

const SIDEBAR_COLLAPSED_KEY = "sidebarCollapsed";

function applySidebarCollapsed(collapsed) {
  const sidebar = document.querySelector(".sidebar");
  const toggleBtn = document.getElementById("btn-sidebar-toggle");
  if (!sidebar) return;

  sidebar.classList.toggle("collapsed", collapsed);
  document.body.classList.toggle("sidebar-collapsed", collapsed);

  state.lastColumns = 0;
  requestAnimationFrame(() => setupGridResizeObserver());

  if (toggleBtn) {
    const label = collapsed ? "사이드바 펼치기" : "사이드바 접기";
    toggleBtn.title = label;
    toggleBtn.setAttribute("aria-label", label);
    toggleBtn.setAttribute("aria-expanded", collapsed ? "false" : "true");
  }
}

function initSidebarCollapse() {
  const collapsed = localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "true";
  applySidebarCollapsed(collapsed);

  const toggleBtn = document.getElementById("btn-sidebar-toggle");
  if (!toggleBtn) return;

  toggleBtn.addEventListener("click", () => {
    const sidebar = document.querySelector(".sidebar");
    const next = !sidebar?.classList.contains("collapsed");
    applySidebarCollapsed(next);
    localStorage.setItem(SIDEBAR_COLLAPSED_KEY, next ? "true" : "false");
  });
}

export function initNavigation() {
  initSidebarCollapse();

  document.querySelectorAll(".nav-item").forEach(item => {
    item.addEventListener("click", () => {
      const tabId = item.id.replace("nav-", "");
      if (tabId === "overlay") {
        switchTab("overlay");
        return;
      }
      if (tabId) switchTab(tabId);
    });
  });

  const navOverlay = document.getElementById("nav-overlay");
  const btnCopyOverlayUrl = document.getElementById("btn-copy-overlay-url");

  if (navOverlay) {
    navOverlay.addEventListener("click", () => switchTab("overlay"));
  }

  if (btnCopyOverlayUrl) {
    btnCopyOverlayUrl.addEventListener("click", () => {
      const displayEl = document.getElementById("overlay-url-display");
      const url = (displayEl && displayEl.textContent) ? displayEl.textContent : "http://localhost:14202/overlay-info";
      navigator.clipboard.writeText(url).then(() => {
        import('../utils.js').then(u => u.showNotification("URL이 클립보드에 복사되었습니다.", "success"));
      });
    });
  }
}

export function switchTab(tabId, options = {}) {
  // Legacy local nav → library with source filter. YouTube is a real search page again.
  if (tabId === "local") {
    state.sourceFilter = "local";
    syncSourceFilterChips();
    tabId = "library";
  }

  state.activeView = tabId;

  if (elements.viewTitle) elements.viewTitle.textContent = getTabTitle(tabId);

  if (elements.viewport) {
    elements.viewport.setAttribute("data-view", tabId === "alignment" ? "alignment-viewer" : tabId);
  }

  if (elements.viewSubtitle) {
    const subtitle = getTabSubtitle(tabId);
    elements.viewSubtitle.textContent = subtitle;
    elements.viewSubtitle.style.display = subtitle ? "block" : "none";
  }

  document.querySelectorAll(".nav-item").forEach(i => {
    i.classList.toggle("active", i.id === `nav-${tabId}`);
  });

  const isMusicTab = tabId === "library";
  const isYoutubeTab = tabId === "youtube";
  const isRequestsTab = tabId === "requests";
  const showLyricDrawer = isMusicTab || isRequestsTab;
  if (elements.libraryControls) elements.libraryControls.style.display = isMusicTab ? "flex" : "none";
  if (elements.youtubeControls) elements.youtubeControls.style.display = isYoutubeTab ? "flex" : "none";
  if (elements.viewControls) elements.viewControls.style.display = isMusicTab ? "flex" : "none";
  updateBroadcastTasksControlVisibility();

  if (elements.settingsPage) elements.settingsPage.style.display = tabId === "settings" ? "block" : "none";
  if (elements.tasksPage) elements.tasksPage.style.display = tabId === "tasks" ? "block" : "none";
  if (elements.overlayPage) elements.overlayPage.style.display = tabId === "overlay" ? "block" : "none";
  if (elements.youtubePage) elements.youtubePage.style.display = isYoutubeTab ? "block" : "none";
  if (elements.requestsPage) elements.requestsPage.style.display = isRequestsTab ? "block" : "none";

  if (isRequestsTab) {
    import('../songbook-requests.js').then(({ onRequestsTabShown, initSongbookRequestsPage }) => {
      initSongbookRequestsPage();
      onRequestsTabShown();
    });
  } else {
    import('../songbook-requests.js').then(({ onRequestsTabHidden }) => {
      onRequestsTabHidden();
    }).catch(() => {});
  }

  if (elements.lyricDrawerTrigger) {
    elements.lyricDrawerTrigger.style.display = showLyricDrawer ? "flex" : "none";
  }
  if (!showLyricDrawer && document.body.classList.contains('drawer-open')) {
    document.body.classList.remove('drawer-open');
  }
  import('../lyric-drawer.js').then(({ refreshLyricDrawerLayout }) => {
    refreshLyricDrawerLayout();
  }).catch(() => {});

  if (elements.songGrid) {
    const isFlexMode = (state.viewMode === "list");
    if (isMusicTab) {
      elements.songGrid.style.removeProperty("display");
      elements.songGrid.style.display = isFlexMode ? "flex" : "grid";
    } else {
      elements.songGrid.style.setProperty("display", "none", "important");
    }

    elements.songGrid.classList.toggle("list-mode", state.viewMode === "list");
    elements.songGrid.classList.toggle("button-view", state.viewMode === "button");

    if (elements.viewport) {
      elements.viewport.setAttribute("data-view-mode", state.viewMode);
    }
    if (isMusicTab) renderLibrary();
  }

  if (isYoutubeTab) {
    import('../youtube-search.js').then(({ focusYoutubeSearch }) => {
      focusYoutubeSearch();
    });
  } else {
    import('../youtube-search.js').then(({ stopYoutubePreview }) => {
      stopYoutubePreview?.();
    }).catch(() => {});
  }

  const alignmentPage = document.getElementById("alignment-page");
  if (tabId === "alignment") {
    elements.viewport?.classList.add("alignment-mode");
    if (alignmentPage) alignmentPage.style.display = "block";
    initAlignmentViewer().then(() => {
      if (alignmentViewer) {
        alignmentViewer.resize();
        if (!options.skipAlignmentAutoLoad && state.currentTrack) {
          const alreadyOpen = alignmentViewer.state.currentPath === state.currentTrack.path;
          if (!alreadyOpen) {
            alignmentViewer.loadAudio(state.currentTrack.path);
          }
          const nameEl = document.getElementById('selected-track-name');
          if (nameEl) nameEl.innerText = state.currentTrack.title || "Unknown Title";
        }
      }
    });
  } else {
    if (alignmentViewer && typeof alignmentViewer.flushAutoSaveIfNeeded === 'function') {
      alignmentViewer.flushAutoSaveIfNeeded().catch((err) => {
        console.error('[Alignment] Auto-save flush failed on tab switch:', err);
      });
    }
    elements.viewport?.classList.remove("alignment-mode");
    if (alignmentPage) alignmentPage.style.display = "none";
  }

  if (tabId === "overlay") {
    const iframe = document.getElementById("overlay-iframe");
    if (iframe && !iframe.src) {
      iframe.src = "overlay-info.html?preview=true";
    }
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        window.dispatchEvent(new Event("resize"));
      });
    });
  }

  if (tabId === "tasks") {
    import('../ui/components.js').then(({ updateTaskUI }) => updateTaskUI());
  }

  if (elements.scrollArea) {
    elements.scrollArea.scrollTop = 0;
  }
}

export function syncSourceFilterChips() {
  const filter = state.sourceFilter || "all";
  document.querySelectorAll(".source-filter-chip").forEach((chip) => {
    chip.classList.toggle("active", chip.dataset.source === filter);
  });
}

export async function openAlignmentForTrack(path, options = {}) {
  const forceLoad = options.forceLoad === true;
  await initAlignmentViewer();

  if (alignmentViewer && path && (forceLoad || alignmentViewer.state.currentPath !== path)) {
    const loadPromise = alignmentViewer.loadAudio(path);
    switchTab("alignment", { skipAlignmentAutoLoad: true });
    await loadPromise;
  } else {
    switchTab("alignment");
  }

  const track = (state.songLibrary || []).find(t => t.path === path);
  const nameEl = document.getElementById('selected-track-name');
  if (nameEl) {
    nameEl.innerText = (track && track.title) ? track.title : "Unknown Title";
  }
}

function getTabTitle(tabId) {
  const titles = {
    library: "라이브러리",
    youtube: "유튜브 검색",
    requests: "신청목록",
    settings: "설정",
    overlay: "OBS 오버레이",
    tasks: "AI 프로세싱",
    alignment: "가사 싱크"
  };
  return titles[tabId] || "라이브러리";
}

function getTabSubtitle(tabId) {
  const subtitles = {
    library: "라이브러리의 모든 곡을 관리하고 재생합니다. 사이드바의 「노래 추가」로 URL·파일을 등록하세요.",
    youtube: "제목·아티스트로 유튜브를 검색해 라이브러리에 추가합니다. URL이 있으면 「노래 추가」를 사용하세요.",
    requests: "시청자 신청 대기열을 운영합니다.",
    settings: "애플리케이션 설정을 관리합니다.",
    overlay: "방송에 송출될 오버레이의 실시간 미리보기입니다.",
    tasks: "AI 작업 진행 상태를 확인합니다.",
    alignment: "가사 싱크를 조정하고 저장합니다."
  };
  return subtitles[tabId] || "";
}

export let alignmentViewer = null;
async function initAlignmentViewer() {
  if (alignmentViewer) return;
  const { ForcedAlignmentViewer } = await import('../alignment-viewer.js');

  alignmentViewer = new ForcedAlignmentViewer("alignment-viewer-root");
}
