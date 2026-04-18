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
  
  const thumbInput = document.getElementById("edit-thumbnail-url");
  if (thumbInput) thumbInput.value = song.thumbnail || "";
  
  // Volume slider initialization
  if (elements.editVolume) {
    elements.editVolume.value = song.volume !== undefined ? song.volume : 100;
    if (elements.editVolumeVal) elements.editVolumeVal.textContent = elements.editVolume.value + "%";
  }

  // Curation fields
  // Curation fields for the Edit Modal
  if (elements.editCurationOriginal) elements.editCurationOriginal.value = song.original_title || "";
  if (elements.editCurationCategory) elements.editCurationCategory.value = song.curation_category || "";
  if (elements.editCurationTranslated) elements.editCurationTranslated.value = song.translated_title || "";

  elements.metadataModal.classList.add("active");
}

export function closeEditModal() {
  if (elements.metadataModal) elements.metadataModal.classList.remove("active");
  state.editingSongIndex = null;
}

export function openConfirmModal(title, message, onConfirm) {
  if (!elements.confirmModal) return;
  
  const titleEl = elements.confirmModal.querySelector("h3");
  const msgEl = elements.confirmModal.querySelector("p");
  const confirmBtn = document.getElementById("confirm-yes");
  const cancelBtn = document.getElementById("confirm-no");
  
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
