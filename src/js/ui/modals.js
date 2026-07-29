/**
 * js/ui/modals.js - Modal Management (Edit, Confirm, etc.)
 */
import { state } from '../state.js';
import { elements } from './elements.js';
import { getSongCategory } from './library.js';
import { setMetaStarRating } from '../utils.js';
// 장르/카테고리 기준은 taxonomy.js 단일 소스 (docs/GENRE_CATEGORY_STANDARD.md).
import { GENRES, CATEGORIES } from '../taxonomy.js';

/** 커스텀 셀렉트(.custom-select)의 옵션 목록을 주어진 값들로 다시 만든다. */
function fillCustomSelect(dropdown, values) {
  const box = dropdown?.querySelector(".select-options");
  if (!box) return;
  box.innerHTML = [
    '<div class="option-item" data-value="">장르 선택...</div>',
    ...values.map((v) => `<div class="option-item" data-value="${v}">${v}</div>`),
  ].join("");
}

/** 커스텀 셀렉트에서 특정 값을 선택 상태로 표시. */
function selectCustomOption(dropdown, value) {
  const option = dropdown?.querySelector(`.option-item[data-value='${value}']`);
  const selectedText = dropdown?.querySelector(".selected-text");
  if (!option || !selectedText) return;
  selectedText.textContent = option.textContent;
  dropdown.querySelectorAll(".option-item").forEach((o) => o.classList.remove("selected"));
  option.classList.add("selected");
}

export function openEditModal(song, index) {
  if (!elements.metadataModal) return;

  state.editingSongIndex = index;

  // Fill modal fields
  document.getElementById("edit-title").value = song.title || "";
  document.getElementById("edit-artist").value = song.artist || "";

  // Genre Handling — 옵션은 taxonomy(GENRES)에서 만들어 노래 추가 모달과 항상 일치.
  const genreSelect = document.getElementById("edit-genre-select");
  const genreCustom = document.getElementById("edit-genre-custom");
  const genreDropdown = document.getElementById("edit-genre-dropdown");

  if (genreSelect && genreCustom && genreDropdown) {
    fillCustomSelect(genreDropdown, GENRES);
    const songGenre = (song.genre || "").trim();

    if (GENRES.includes(songGenre)) {
      genreSelect.value = songGenre;
      genreCustom.value = "";
      selectCustomOption(genreDropdown, songGenre);
    } else {
      // 표준에 없는 값(사용자 커스텀)은 '기타' + 직접 입력란에 원본 보존
      genreSelect.value = songGenre ? "기타" : "";
      genreCustom.value = songGenre;
      selectCustomOption(genreDropdown, songGenre ? "기타" : "");
    }
  }

  // 카테고리 — 표준 목록을 datalist 제안으로 제공(자유 입력도 허용).
  const catPresets = document.getElementById("edit-category-presets");
  if (catPresets) {
    catPresets.innerHTML = CATEGORIES.map((c) => `<option value="${c}"></option>`).join("");
  }
  document.getElementById("edit-category").value = getSongCategory(song) || "";
  document.getElementById("edit-tags").value = (song.tags || []).join(", ");
  const editVolume = document.getElementById("edit-volume");
  const editVolumeVal = document.getElementById("edit-volume-val");
  const editKey = document.getElementById("edit-key");
  const editBpm = document.getElementById("edit-bpm");
  if (editVolume) {
    const min = Number.parseFloat(editVolume.min || "0");
    const max = Number.parseFloat(editVolume.max || "120");
    const volume = Number.parseFloat(song.volume);
    const safeVolume = Number.isFinite(volume) ? Math.max(min, Math.min(max, volume)) : 100;
    editVolume.value = String(Math.round(safeVolume));
    if (editVolumeVal) editVolumeVal.textContent = String(Math.round(safeVolume));
  }
  if (editKey) {
    editKey.value = song.songKey || song.key || "";
  }
  if (editBpm) {
    editBpm.value = song.bpm ?? "";
  }
  const editLyricsLink = document.getElementById("edit-lyrics-link");
  if (editLyricsLink) {
    editLyricsLink.value = song.lyricsLink || song.lyrics_link || "";
  }

  // MR 분리 기록 (읽기 전용) — 분리 완료 시 캐시에 자동 저장된 모델/일시 표시.
  // 비동기 조회라 일단 숨겼다가 기록이 있으면 채워서 노출.
  const sepGroup = document.getElementById("edit-separation-info-group");
  const sepInfoEl = document.getElementById("edit-separation-info");
  if (sepGroup && sepInfoEl) {
    sepGroup.style.display = "none";
    sepInfoEl.textContent = "";
    const modalPath = song.path;
    import("../model-api.js").then(({ getSeparationInfo }) => getSeparationInfo(modalPath)).then((info) => {
      // 조회가 돌아왔을 때 모달이 다른 곡으로 바뀌었으면 무시
      const currentTitle = document.getElementById("edit-title");
      if (!info || !currentTitle) return;
      if (state.editingSongIndex === null || state.songLibrary[state.editingSongIndex]?.path !== modalPath) return;
      const when = info.completedAt
        ? new Date(info.completedAt * 1000).toLocaleString("ko-KR", { dateStyle: "medium", timeStyle: "short" })
        : "";
      const provider = info.provider ? ` · ${info.provider}` : "";
      sepInfoEl.textContent = `${info.modelName || info.modelId || "알 수 없는 모델"}${provider}${when ? ` · ${when}` : ""}`;
      sepGroup.style.display = "";
    }).catch(() => {});
  }
  setMetaStarRating("edit-difficulty-stars", "edit-difficulty-select", song.difficulty);
  setMetaStarRating("edit-proficiency-stars", "edit-proficiency-select", song.proficiency);

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
