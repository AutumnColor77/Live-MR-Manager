/**
 * js/ui/modals.js - Modal Management (Edit, Confirm, etc.)
 */
import { state } from '../state.js';
import { elements } from './elements.js';

export function openEditModal(song, index) {
  if (!elements.metadataModal) return;
  
  state.editingSongIndex = index;
  
  // Fill modal fields
  document.getElementById("edit-title").value = song.title || "";
  document.getElementById("edit-artist").value = song.artist || "";
  
  // Genre Handling
  const genreSelect = document.getElementById("edit-genre-select");
  const genreCustom = document.getElementById("edit-genre-custom");
  const genreDropdown = document.getElementById("edit-genre-dropdown");
  
  if (genreSelect && genreCustom && genreDropdown) {
    const defaultGenres = ["pop", "ballad", "dance", "rock", "jpop", "kpop", "etc"];
    const songGenre = (song.genre || "").toLowerCase();
    
    if (defaultGenres.includes(songGenre)) {
      genreSelect.value = songGenre;
      genreCustom.value = "";
      
      const selectedOption = genreDropdown.querySelector(`.option-item[data-value='${songGenre}']`);
      const selectedText = genreDropdown.querySelector(".selected-text");
      if (selectedOption && selectedText) {
        selectedText.textContent = selectedOption.textContent;
        genreDropdown.querySelectorAll(".option-item").forEach(opt => opt.classList.remove("selected"));
        selectedOption.classList.add("selected");
      }
    } else {
      genreSelect.value = "etc";
      genreCustom.value = song.genre || "";
      
      const selectedOption = genreDropdown.querySelector(".option-item[data-value='etc']");
      const selectedText = genreDropdown.querySelector(".selected-text");
      if (selectedOption && selectedText) {
        selectedText.textContent = selectedOption.textContent;
        genreDropdown.querySelectorAll(".option-item").forEach(opt => opt.classList.remove("selected"));
        selectedOption.classList.add("selected");
      }
    }
  }

  document.getElementById("edit-category").value = song.category || (song.categories && song.categories.length > 0 ? song.categories[0] : "") || "기본";
  document.getElementById("edit-tags").value = (song.tags || []).join(", ");

  // MR Checkbox initialization
  const mrCheckbox = document.getElementById("edit-is-mr");
  if (mrCheckbox) {
    const isSeparated = !!(song.is_separated || song.isSeparated);
    mrCheckbox.checked = isSeparated || !!(song.is_mr || song.isMr);
    mrCheckbox.disabled = isSeparated;
    
    // Add visual feedback for disabled state
    const label = mrCheckbox.closest(".mr-checkbox-label");
    if (label) label.classList.toggle("disabled", isSeparated);
  }

  elements.metadataModal.classList.add("active");
}

export function closeEditModal() {
  if (elements.metadataModal) {
    elements.metadataModal.classList.remove("active");
    // Reset disabled state for next open
    const mrCheckbox = document.getElementById("edit-is-mr");
    if (mrCheckbox) {
      mrCheckbox.disabled = false;
      const label = mrCheckbox.closest(".mr-checkbox-label");
      if (label) label.classList.remove("disabled");
    }
  }
  state.editingSongIndex = null;
}

export function openConfirmModal(title, message, onConfirm) {
  if (!elements.confirmModal) return;
  
  const titleEl = elements.confirmModal.querySelector("h3");
  const msgEl = elements.confirmModal.querySelector("p");
  // Prefer current button IDs, but keep legacy fallback for compatibility.
  const confirmBtn = document.getElementById("confirm-ok") || document.getElementById("confirm-yes");
  const cancelBtn = document.getElementById("confirm-cancel") || document.getElementById("confirm-no");
  
  if (!confirmBtn || !cancelBtn) {
    console.error("[openConfirmModal] Confirm/Cancel buttons not found");
    return;
  }
  
  if (titleEl) titleEl.textContent = title;
  if (msgEl) msgEl.textContent = message;
  
  confirmBtn.onclick = () => {
    onConfirm();
    closeConfirmModal();
  };
  
  cancelBtn.onclick = closeConfirmModal;
  
  elements.confirmModal.classList.add("active");
}

export function closeConfirmModal() {
  if (elements.confirmModal) elements.confirmModal.classList.remove("active");
}
