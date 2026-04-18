/**
 * js/events/modals.js - Modal Event Handlers (Save, Cancel, Search)
 */
import { state } from '../state.js';
import { elements } from '../ui/elements.js';
import { invoke } from '../tauri-bridge.js';
import { showNotification } from '../utils.js';

export function initModalListeners() {
  // Metadata Save
  const btnSave = document.getElementById("modal-save");
  if (btnSave) {
    btnSave.onclick = async () => {
      const idx = state.editingSongIndex;
      if (idx === null) return;
      
      const song = state.library[idx];
      const updated = {
        ...song,
        title: document.getElementById("edit-title").value,
        artist: document.getElementById("edit-artist").value,
        genre: document.getElementById("edit-genre-custom").value.trim() || document.getElementById("edit-genre-select").value,
        category: document.getElementById("edit-category").value,
        tags: document.getElementById("edit-tags").value.split(",").map(t => t.trim()).filter(t => t),
        thumbnail: document.getElementById("edit-thumbnail-url") ? document.getElementById("edit-thumbnail-url").value : song.thumbnail,
        volume: parseFloat(elements.editVolume.value), // Keep in 0-120 range
        original_title: document.getElementById("edit-curation-original") ? document.getElementById("edit-curation-original").value : "",
        curation_category: document.getElementById("edit-curation-category") ? document.getElementById("edit-curation-category").value : "",
        translated_title: document.getElementById("edit-curation-translated") ? document.getElementById("edit-curation-translated").value : "",
      };

      try {
        await invoke('update_song_metadata', { song: updated });
        state.library[idx] = updated;
        const { renderLibrary } = await import('../ui/library.js');
        renderLibrary();
        const { closeEditModal } = await import('../ui/modals.js');
        closeEditModal();
        showNotification("정보가 수정되었습니다.", "success");
      } catch (err) {
        showNotification("수정 실패: " + err, "error");
      }
    };
  }

  // Open Library Manager
  if (elements.btnOpenManager) {
    elements.btnOpenManager.onclick = async () => {
      const { openLibraryManager } = await import('../ui/manager.js');
      openLibraryManager();
    };
  }

  // Modal Cancel/Close
  const modalCancel = document.getElementById("modal-cancel");
  const modalClose = document.getElementById("modal-close");
  
  const closeModal = async () => {
    const { closeEditModal } = await import('../ui/modals.js');
    closeEditModal();
  };

  if (modalCancel) modalCancel.onclick = closeModal;
  if (modalClose) modalClose.onclick = closeModal;

  // Library Manager Actions
  if (elements.btnManagerSave) {
    elements.btnManagerSave.onclick = async () => {
      const { saveManagerChanges } = await import('../ui/manager.js');
      await saveManagerChanges();
      const { closeManagerModal } = await import('../ui/modals.js');
      closeManagerModal();
    };
  }
  if (elements.btnManagerCancel) {
    elements.btnManagerCancel.onclick = async () => {
      const { closeManagerModal } = await import('../ui/modals.js');
      closeManagerModal();
    };
  }

  // Online Metadata Search
  if (elements.btnMetadataSearch) {
    elements.btnMetadataSearch.onclick = async () => {
      const title = document.getElementById("edit-title").value;
      const artist = document.getElementById("edit-artist").value;
      const query = `${title} ${artist}`.trim();
      if (!query) return;

      elements.metadataSearchResultsModal.classList.add("active");
      elements.searchResultsList.innerHTML = `
        <div class="loading-container" style="text-align:center; padding:20px;">
          <div class="spinner"></div>
          <div style="margin-top:10px;">검색 중...</div>
        </div>
      `;

      try {
        const results = await invoke("search_track_metadata", { query });
        elements.searchResultsList.innerHTML = "";
        if (results.length === 0) {
          elements.searchResultsList.innerHTML = '<div style="padding:20px; text-align:center;">검색 결과가 없습니다.</div>';
          return;
        }

        results.forEach(res => {
          const item = document.createElement("div");
          item.className = "search-result-item";
          item.innerHTML = `
            <img src="${res.thumbnail || ''}" style="width:40px; height:40px; border-radius:4px; object-fit:cover;">
            <div class="res-info">
              <div class="res-title">${res.title}</div>
              <div class="res-artist">${res.artist}</div>
            </div>
          `;
          item.onclick = () => {
            document.getElementById("edit-title").value = res.title;
            document.getElementById("edit-artist").value = res.artist;
            if (res.thumbnail) document.getElementById("edit-thumbnail-url").value = res.thumbnail;
            elements.metadataSearchResultsModal.classList.remove("active");
          };
          elements.searchResultsList.appendChild(item);
        });
      } catch (err) {
        elements.searchResultsList.innerHTML = `<div style="padding:20px; color:var(--danger-color);">검색 실패: ${err}</div>`;
      }
    };
  }

  // Metadata Search Result Close
  if (elements.searchResultsClose) {
    elements.searchResultsClose.onclick = () => {
      if (elements.metadataSearchResultsModal) {
        elements.metadataSearchResultsModal.classList.remove("active");
      }
    };
  }
}
