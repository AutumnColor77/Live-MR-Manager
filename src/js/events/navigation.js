/**
 * js/events/navigation.js - Sidebar Navigation & Tabs
 */
import { state } from '../state.js';
import { elements } from '../ui/elements.js';
import { renderLibrary } from '../ui/library.js';

export function initNavigation() {
  document.querySelectorAll(".nav-item").forEach(item => {
    item.addEventListener("click", () => {
      const tabId = item.id.replace("nav-", "");
      if (tabId) switchTab(tabId);
    });
  });
}

export function switchTab(tabId) {
  state.activeView = tabId;
  
  if (elements.viewTitle) elements.viewTitle.textContent = getTabTitle(tabId);
  
  // Sync viewport data-view attribute for CSS selectors
  if (elements.viewport) {
    elements.viewport.setAttribute("data-view", tabId === "alignment" ? "alignment-viewer" : tabId);
  }
  
  if (elements.viewSubtitle) {
    const subtitle = tabId === "tasks" ? "Broadcast Safe 기능을 켜두면 AI 분리 중 연산 속도를 조절하여 방송(OBS) 프레임 드랍을 방지합니다." : "";
    elements.viewSubtitle.textContent = subtitle;
    elements.viewSubtitle.style.display = subtitle ? "block" : "none";
  }
  
  document.querySelectorAll(".nav-item").forEach(i => {
    i.classList.toggle("active", i.id === `nav-${tabId}`);
  });

  const isMusicTab = (tabId === "library" || tabId === "youtube" || tabId === "local");
  if (elements.youtubeSection) elements.youtubeSection.style.display = tabId === "youtube" ? "block" : "none";
  if (elements.localSection) elements.localSection.style.display = tabId === "local" ? "block" : "none";
  if (elements.libraryControls) elements.libraryControls.style.display = isMusicTab ? "flex" : "none";
  if (elements.viewControls) elements.viewControls.style.display = isMusicTab ? "flex" : "none";
  if (elements.broadcastTasksControl) elements.broadcastTasksControl.style.display = tabId === "tasks" ? "block" : "none";
  
  if (elements.settingsPage) elements.settingsPage.style.display = tabId === "settings" ? "block" : "none";
  if (elements.tasksPage) elements.tasksPage.style.display = tabId === "tasks" ? "block" : "none";

  // Lyric Drawer control: Only show on music tabs
  if (elements.lyricDrawerTrigger) {
    elements.lyricDrawerTrigger.style.display = isMusicTab ? "flex" : "none";
  }
  // Close drawer if moving to a non-music (system) tab
  if (!isMusicTab && document.body.classList.contains('drawer-open')) {
    document.body.classList.remove('drawer-open');
  }
  
  if (elements.songGrid) {
    const isFlexMode = (state.viewMode === "list");
    // Use !important to override CSS !important when hiding
    if (isMusicTab) {
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

  const alignmentPage = document.getElementById("alignment-page");
  if (tabId === "alignment") {
    elements.viewport?.classList.add("alignment-mode");
    if (alignmentPage) alignmentPage.style.display = "block";
    // Initialize alignment viewer if needed
    initAlignmentViewer().then(() => {
      if (alignmentViewer) alignmentViewer.resize();
    });
  } else {
    elements.viewport?.classList.remove("alignment-mode");
    if (alignmentPage) alignmentPage.style.display = "none";
  }

  if (tabId === "tasks") {
    import('../ui/components.js').then(({ updateTaskUI }) => updateTaskUI());
  }

  // Reset scroll position when switching tabs
  if (elements.scrollArea) {
    elements.scrollArea.scrollTop = 0;
  }
}

function getTabTitle(tabId) {
  const titles = {
    library: "Library",
    youtube: "YouTube",
    local: "My Files",
    settings: "Settings",
    tasks: "Active Tasks",
    alignment: "Lyric Sync"
  };
  return titles[tabId] || "Live MR Manager";
}

export let alignmentViewer = null;
async function initAlignmentViewer() {
  if (alignmentViewer) return;
  const { ForcedAlignmentViewer } = await import('../alignment-viewer.js');
  const { invoke } = await import('../tauri-bridge.js');
  
  alignmentViewer = new ForcedAlignmentViewer("alignment-viewer-root");
  // Constructor already calls setupListeners, setupCanvasListeners, and loadTrackList
}
