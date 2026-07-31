/**
 * Library view mode, filters, and global click listeners
 */
import { state } from '../../state.js';
import { elements } from '../../ui/elements.js';

export function initViewMode(updateViewMode) {
  if (elements.viewGridBtn) {
    elements.viewGridBtn.onclick = () => updateViewMode("grid");
  }
  if (elements.viewListBtn) {
    elements.viewListBtn.onclick = () => updateViewMode("list");
  }
  if (elements.viewButtonBtn) {
    elements.viewButtonBtn.onclick = () => updateViewMode("button");
  }
}

export function createViewModeUpdater() {
  const updateViewMode = (mode) => {
    state.viewMode = mode;
    localStorage.setItem("viewMode", mode);

    if (elements.viewGridBtn) elements.viewGridBtn.classList.toggle("active", mode === "grid");
    if (elements.viewListBtn) elements.viewListBtn.classList.toggle("active", mode === "list");
    if (elements.viewButtonBtn) elements.viewButtonBtn.classList.toggle("active", mode === "button");

    if (elements.viewport) elements.viewport.setAttribute("data-view-mode", mode);

    if (elements.songGrid) {
      elements.songGrid.classList.remove("grid-mode", "list-mode", "button-mode");
      elements.songGrid.classList.add(`${mode}-mode`);
      elements.songGrid.style.display = (mode === "list") ? "flex" : "grid";
    }

    import('../../ui/library.js').then(({ renderLibrary }) => renderLibrary());
  };

  initViewMode(updateViewMode);
  return updateViewMode;
}

export function initLibraryListeners(updateViewMode) {
  document.addEventListener("click", (e) => {
    if (elements.contextMenu && (elements.contextMenu.classList.contains("active") || elements.contextMenu.style.display === 'flex')) {
      if (!e.target.closest("#context-menu")) {
        elements.contextMenu.classList.remove("active");
        elements.contextMenu.style.display = 'none';
      }
    }

    const customSelect = e.target.closest(".custom-select");
    if (customSelect) {
      const optionItem = e.target.closest(".option-item");
      if (optionItem) {
        const value = optionItem.dataset.value;
        const hiddenInput = customSelect.querySelector("input[type='hidden']");
        const selectedText = customSelect.querySelector(".selected-text");

        if (hiddenInput) {
          hiddenInput.value = value;
          hiddenInput.dispatchEvent(new Event("input"));
          hiddenInput.dispatchEvent(new Event("change"));
        }

        if (selectedText) {
          selectedText.textContent = optionItem.textContent;
        }

        customSelect.querySelectorAll(".option-item").forEach(opt => opt.classList.remove("selected"));
        optionItem.classList.add("selected");
        customSelect.classList.remove("active");
      } else {
        const isCurrentlyActive = customSelect.classList.contains("active");
        document.querySelectorAll(".custom-select").forEach(el => el.classList.remove("active"));
        if (!isCurrentlyActive) {
          customSelect.classList.add("active");
        }
      }
    } else {
      document.querySelectorAll(".custom-select").forEach(el => el.classList.remove("active"));
    }

    const vocalItem = e.target.closest(".vocal-item");
    if (!vocalItem) {
      const popover = document.getElementById("popover-vocal-balance");
      if (popover) popover.classList.remove("active");
    }

    const card = e.target.closest(".song-card");
    const dock = e.target.closest(".control-dock");
    const modal = e.target.closest(".modal-content");

    if (!card && !dock && !modal && !customSelect) {
      if (state.selectedTrackIndex !== -1) {
        state.selectedTrackIndex = -1;
        import('../../ui/components.js').then(({ updateThumbnailOverlay }) => updateThumbnailOverlay());
      }
    }
  });

  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      const activeModal = document.querySelector(".modal-overlay.active");
      if (activeModal) activeModal.classList.remove("active");

      if (elements.contextMenu && elements.contextMenu.classList.contains("active")) {
        elements.contextMenu.classList.remove("active");
        elements.contextMenu.style.display = 'none';
      }
    }
  });

  const renderLibraryDeferred = () => {
    import('../../ui/library.js').then(({ renderLibrary }) => renderLibrary());
  };

  if (elements.libSearchInput) {
    elements.libSearchInput.addEventListener("input", renderLibraryDeferred);
  }
  if (elements.libGenreFilter) {
    elements.libGenreFilter.addEventListener("change", renderLibraryDeferred);
  }
  if (elements.libCategoryFilter) {
    elements.libCategoryFilter.addEventListener("change", renderLibraryDeferred);
  }
  if (elements.libSyncFilter) {
    elements.libSyncFilter.addEventListener("change", renderLibraryDeferred);
  }
  if (elements.libSortSelect) {
    elements.libSortSelect.addEventListener("change", renderLibraryDeferred);
  }

  if (updateViewMode) {
    updateViewMode(state.viewMode || "grid");
  }
}
