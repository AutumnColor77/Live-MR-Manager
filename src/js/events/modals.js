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
      
      const song = state.songLibrary[idx];
      const updated = {
        ...song,
        title: document.getElementById("edit-title").value,
        artist: document.getElementById("edit-artist").value,
        genre: document.getElementById("edit-genre-custom").value.trim() || document.getElementById("edit-genre-select").value,
        category: document.getElementById("edit-category").value,
        tags: document.getElementById("edit-tags").value.split(",").map(t => t.trim()).filter(t => t),
        volume: parseFloat(elements.editVolume.value),
        isMr: document.getElementById("edit-is-mr").checked,
        isSeparated: document.getElementById("edit-is-mr").checked,
      };

      try {
        await invoke('update_song_metadata', { song: updated });
        state.songLibrary[idx] = updated;
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
      const { closeManagerModal } = await import('../ui/manager.js');
      closeManagerModal();
    };
  }
  if (elements.btnManagerCancel) {
    elements.btnManagerCancel.onclick = async () => {
      const { closeManagerModal } = await import('../ui/manager.js');
      closeManagerModal();
    };
  }
  if (elements.managerModalClose) {
    elements.managerModalClose.onclick = async () => {
      const { closeManagerModal } = await import('../ui/manager.js');
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
          <div style="margin-top:10px;">온라인에서 곡 정보를 검색 중입니다...</div>
        </div>
      `;

      try {
        const results = await invoke("search_track_metadata", { query });
        elements.searchResultsList.innerHTML = "";
        if (results.length === 0) {
          elements.searchResultsList.innerHTML = '<div class="loading-container" style="color: #666;">검색 결과가 없습니다.</div>';
          return;
        }

        results.forEach(res => {
          const item = document.createElement("div");
          item.className = "search-result-item";
          const isUnknownGenre = !res.genre || res.genre.toLowerCase() === "unknown" || res.genre.toLowerCase() === "unknown genre";
          const genreHtml = !isUnknownGenre
            ? `<div class="track-genre-preview">${res.genre}</div>`
            : "";
          const tagsHtml = res.tags && res.tags.length > 0
            ? `<div class="track-tags-preview">${res.tags.map(t => `<span class="tag-badge-mini">${t}</span>`).join("")}</div>`
            : "";
          item.innerHTML = `
            <div class="search-result-info">
              <div class="track-name">${res.name || res.title || ""}</div>
              <div class="artist-name">${res.artist || ""}</div>
              ${genreHtml}
            </div>
            ${tagsHtml}
          `;
          item.onclick = () => {
            document.getElementById("edit-title").value = res.name || res.title || "";
            document.getElementById("edit-artist").value = res.artist || "";
            
            // 1. 장르 정보 업데이트
            const isUnknown = !res.genre || res.genre.toLowerCase() === "unknown" || res.genre.toLowerCase() === "unknown genre";
            if (!isUnknown) {
              document.getElementById("edit-genre-custom").value = res.genre;
              const genreSelect = document.getElementById("edit-genre-select");
              if (genreSelect) genreSelect.value = ""; // 드롭다운 선택 초기화
              const genreText = document.querySelector("#edit-genre-dropdown .selected-text");
              if (genreText) genreText.textContent = "장르 선택...";
            }
            
            // 2. 태그 정보 업데이트
            if (res.tags && res.tags.length > 0) {
              document.getElementById("edit-tags").value = res.tags.join(", ");
            }
            
            // 3. 썸네일 정보 업데이트
            const coverUrl = res.thumbnail || res.image || res.cover_url || res.cover;
            if (coverUrl) {
              const thumbEl = document.getElementById("edit-thumbnail-url");
              if (thumbEl) thumbEl.value = coverUrl;
            }

            elements.metadataSearchResultsModal.classList.remove("active");
          };
          elements.searchResultsList.appendChild(item);
        });
      } catch (err) {
        elements.searchResultsList.innerHTML = '<div class="loading-container" style="color: var(--accent-red);">검색 중 오류가 발생했습니다.</div>';
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
