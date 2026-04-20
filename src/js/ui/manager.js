/**
 * js/ui/manager.js - Library Manager (Table View)
 */
import { state } from '../state.js';
import { elements } from './elements.js';

export function openLibraryManager() {
  if (!elements.managerModal) return;
  elements.managerModal.classList.add("active");
  
  // Reset tabs to default (Song List)
  const tabBtns = document.querySelectorAll(".manager-tab-btn");
  const tabBodies = document.querySelectorAll(".manager-body");
  
  tabBtns.forEach(b => b.classList.toggle("active", b.dataset.tab === "list"));
  tabBodies.forEach(c => {
    const isList = c.id === "manager-tab-list";
    c.classList.toggle("active", isList);
    c.style.display = isList ? "flex" : "none";
  });

  renderManagerTable();
  initTableResizing();
  initManagerEvents();
}

export function initManagerEvents() {
  // 1. Search Input
  if (elements.managerSearchInput) {
    elements.managerSearchInput.oninput = () => renderManagerTable();
  }

  // 2. Tab Switching
  const tabBtns = document.querySelectorAll(".manager-tab-btn");
  tabBtns.forEach(btn => {
    btn.onclick = (e) => {
      const target = btn.dataset.tab;
      
      // UI State: Buttons
      tabBtns.forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      
      // Content State: Bodies
      document.querySelectorAll(".manager-body").forEach(c => {
        c.classList.remove("active");
        c.style.display = "none"; // Hard reset
      });
      
      const targetContent = document.getElementById(`manager-tab-${target}`);
      if (targetContent) {
        targetContent.classList.add("active");
        targetContent.style.display = "flex"; // Hard show
      }
      
      if (target === "curation") {
        updateUnmappedTags();
      }
    };
  });

  // 3. Table Actions (Event Delegation)
  if (elements.managerTableBody) {
    elements.managerTableBody.onclick = async (e) => {
      // Row Delete
      const delBtn = e.target.closest(".btn-row-del");
      if (delBtn) {
        const index = parseInt(delBtn.dataset.index);
        const { performDeleteSong, renderLibrary } = await import('./library.js');
        const { openConfirmModal } = await import('./modals.js');
        const { showNotification } = await import('../utils.js');
        const song = state.songLibrary[index];

        openConfirmModal("곡 삭제", `'${song.title}' 곡을 삭제하시겠습니까?`, async () => {
          try {
            await performDeleteSong(index);
            renderManagerTable();
            renderLibrary();
            showNotification("곡이 삭제되었습니다.", "success");
          } catch (err) {
            showNotification("곡 삭제 실패", "error");
          }
        });
      }
    };
  }

  // 4. Select All Logic
  const selectAllBtn = document.getElementById("manager-select-all");
  if (selectAllBtn) {
    selectAllBtn.onchange = (e) => {
      const isChecked = e.target.checked;
      const checks = elements.managerTableBody.querySelectorAll(".manager-check");
      checks.forEach(c => c.checked = isChecked);
    };
  }

  // 5. Delete Selected Logic
  const btnDelSelected = document.getElementById("btn-manager-del-selected");
  if (btnDelSelected) {
    btnDelSelected.onclick = async () => {
      const checkedBoxes = elements.managerTableBody.querySelectorAll(".manager-check:checked");
      if (checkedBoxes.length === 0) {
        import('../utils.js').then(m => m.showNotification("선택된 곡이 없습니다.", "warning"));
        return;
      }

      const { openConfirmModal } = await import('./modals.js');
      openConfirmModal("선택 삭제", `정말로 선택한 ${checkedBoxes.length}곡을 삭제하시겠습니까?`, async () => {
        const { performDeleteSong, renderLibrary } = await import('./library.js');
        const { showNotification } = await import('../utils.js');
        
        // Delete from largest index to smallest to maintain array integrity
        const indices = Array.from(checkedBoxes).map(cb => {
          const tr = cb.closest("tr");
          return parseInt(tr.dataset.index);
        }).sort((a, b) => b - a);

        try {
          for (const index of indices) {
            await performDeleteSong(index);
          }
          
          if (selectAllBtn) selectAllBtn.checked = false;
          renderManagerTable();
          renderLibrary();
          showNotification(`${checkedBoxes.length}곡이 삭제되었습니다.`, "success");
        } catch (err) {
          showNotification("일부 곡 삭제 중 오류가 발생했습니다.", "error");
        }
      });
    };
  }

  // 6. Bulk Save Logic
  const btnSave = document.getElementById("manager-modal-save");
  if (btnSave) {
    btnSave.onclick = async () => {
      const { invoke } = await import('../tauri-bridge.js');
      const { showNotification } = await import('../utils.js');
      const { renderLibrary } = await import('./library.js');
      
      const rows = elements.managerTableBody.querySelectorAll("tr");
      const updates = [];

      rows.forEach(row => {
        const path = row.querySelector(".manager-check").dataset.path;
        const song = state.songLibrary.find(s => s.path === path);
        if (!song) return;

        const inputs = row.querySelectorAll("input[data-field]");
        let changed = false;

        inputs.forEach(input => {
          const field = input.dataset.field;
          let val = input.value.trim();
          
          if (field === "tags") {
            const newTags = val.split(',').map(t => t.trim()).filter(t => t);
            const oldTags = song.tags || [];
            if (JSON.stringify(newTags) !== JSON.stringify(oldTags)) {
              song.tags = newTags;
              changed = true;
            }
          } else {
            if (song[field] !== val) {
              song[field] = val;
              changed = true;
            }
          }
        });

        if (changed) {
          updates.push(invoke("update_song_metadata", { song }));
        }
      });

      try {
        await Promise.all(updates);
        
        // REFRESH FROM BACKEND: This is crucial!
        const { loadLibrary } = await import('../audio.js');
        const freshSongs = await loadLibrary();
        state.songLibrary = freshSongs;
        
        showNotification(`${updates.length}개의 곡 정보가 저장되었습니다.`, "success");
        elements.managerModal.classList.remove("active");
        renderLibrary();
      } catch (err) {
        showNotification("저장 중 오류가 발생했습니다: " + err, "error");
      }
    };
  }

  // 7. Curation Actions
  const btnRefresh = document.getElementById("btn-refresh-unmapped");
  const btnCopy = document.getElementById("btn-copy-unmapped");
  const btnSaveMap = document.getElementById("btn-save-mapping");

  if (btnRefresh) {
    btnRefresh.onclick = () => updateUnmappedTags();
  }
  if (btnCopy) {
    btnCopy.onclick = () => {
      const list = elements.unclassifiedTagsList;
      if (!list) return;
      // Extract only .tag-name text, excluding .tag-count
      const text = Array.from(list.querySelectorAll(".tag-name"))
        .map(t => t.textContent.trim())
        .join("\n");
      navigator.clipboard.writeText(text);
      import('../utils.js').then(m => m.showNotification("태그 목록이 클립보드에 복사되었습니다.", "info"));
    };
  }
  if (btnSaveMap) {
    btnSaveMap.onclick = async () => {
      const original = elements.curationOriginal ? elements.curationOriginal.value.trim() : "";
      const category = elements.curationCategory ? elements.curationCategory.value : "";
      const translated = elements.curationTranslated ? elements.curationTranslated.value.trim() : "";

      if (!original || !translated) {
        import('../utils.js').then(m => m.showNotification("원문과 번역문을 모두 입력해주세요.", "warning"));
        return;
      }

      const { invoke } = await import('../tauri-bridge.js');
      try {
        await invoke("update_custom_dictionary", { original, category, translated });
        import('../utils.js').then(m => m.showNotification("사전에 등록되었습니다.", "success"));
        if (elements.curationOriginal) elements.curationOriginal.value = "";
        if (elements.curationTranslated) elements.curationTranslated.value = "";
        updateUnmappedTags();
      } catch (err) {
        import('../utils.js').then(m => m.showNotification("등록 실패: " + err, "error"));
      }
    };
  }
}

async function updateUnmappedTags() {
  const { invoke } = await import('../tauri-bridge.js');
  const { showNotification } = await import('../utils.js');
  
  if (!elements.unclassifiedTagsList) return;

  try {
    // tags is a HashMap<String, usize> -> { "tag": count }
    const tags = await invoke("get_unclassified_tags");
    
    // Convert to array and sort by count descending
    const tagEntries = Object.entries(tags).sort((a, b) => b[1] - a[1]);

    if (tagEntries.length === 0) {
      elements.unclassifiedTagsList.innerHTML = `<div style="padding: 20px; text-align: center; color: #888;">미분류 태그가 없습니다.</div>`;
      return;
    }

    elements.unclassifiedTagsList.innerHTML = tagEntries.map(([name, count]) => `
      <div class="tag-item" title="Frequency: ${count}">
        <span class="tag-name">${name}</span>
        <span class="tag-count" style="font-size: 0.75rem; opacity: 0.5; margin-left: 6px;">(${count})</span>
      </div>
    `).join("");
    
    // Clicking a tag fills the "Original" field
    elements.unclassifiedTagsList.querySelectorAll(".tag-item").forEach(item => {
      item.onclick = () => {
        const tagName = item.querySelector(".tag-name").textContent.trim();
        if (elements.curationOriginal) elements.curationOriginal.value = tagName;
      };
    });
  } catch (err) {
    console.error("[Curation] Failed to fetch tags:", err);
    showNotification("태그 목록을 불러오지 못했습니다.", "error");
    elements.unclassifiedTagsList.innerHTML = `<div style="padding: 20px; text-align: center; color: #ff6b6b;">데이터 로드 실패</div>`;
  }
}

export function renderManagerTable() {
  if (!elements.managerTableBody) return;

  const songs = state.songLibrary;
  const filtered = songs.filter(s => {
    const q = (elements.managerSearchInput ? elements.managerSearchInput.value : "").toLowerCase();
    return s.title.toLowerCase().includes(q) || (s.artist || "").toLowerCase().includes(q);
  });

  elements.managerTableBody.innerHTML = filtered.map((song) => {
    const originalIndex = songs.indexOf(song);
    const tagsStr = (song.tags || []).join(', ');
    const genreStr = song.genre || '-';
    const durationMs = song.duration_ms || 0;
    const durationStr = durationMs > 0 ? formatDuration(durationMs) : '-';

    return `
    <tr data-index="${originalIndex}">
      <td style="width: 40px; text-align: center;">
        <input type="checkbox" class="manager-check" data-path="${song.path}">
      </td>
      <td>
        <input type="text" data-field="title" value="${escapeHtml(song.title)}" data-index="${originalIndex}">
      </td>
      <td>
        <input type="text" data-field="artist" value="${escapeHtml(song.artist || '')}" data-index="${originalIndex}">
      </td>
      <td>
        <input type="text" data-field="category" value="${escapeHtml(song.category || '')}" data-index="${originalIndex}">
      </td>
      <td>
        <input type="text" data-field="genre" value="${escapeHtml(genreStr)}" data-index="${originalIndex}">
      </td>
      <td>
        <input type="text" data-field="tags" value="${escapeHtml(tagsStr)}" data-index="${originalIndex}">
      </td>
      <td style="text-align: center;">${durationStr}</td>
      <td style="text-align: center;">
        <button class="btn-row-del" data-index="${originalIndex}">삭제</button>
      </td>
    </tr>
  `;
  }).join("");

  if (elements.managerStat) {
    elements.managerStat.textContent = `Total: ${songs.length} | Filtered: ${filtered.length}`;
  }

  // Reset Select All checkbox
  const selectAllBtn = document.getElementById("manager-select-all");
  if (selectAllBtn) selectAllBtn.checked = false;
}

function formatDuration(ms) {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

function escapeHtml(text) {
  if (!text) return '';
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

export function initTableResizing() {
  const ths = document.querySelectorAll("#manager-table th");
  ths.forEach(th => {
    const resizer = th.querySelector(".resizer");
    if (!resizer) return;

    resizer.addEventListener("mousedown", (e) => {
      const startX = e.pageX;
      const startWidth = th.offsetWidth;

      const onMouseMove = (moveEvent) => {
        th.style.width = (startWidth + (moveEvent.pageX - startX)) + "px";
      };

      const onMouseUp = () => {
        document.removeEventListener("mousemove", onMouseMove);
        document.removeEventListener("mouseup", onMouseUp);
      };

      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", onMouseUp);
    });
  });
}

export function saveManagerChanges() {
  const rows = elements.managerTableBody.querySelectorAll("tr");
  rows.forEach(tr => {
    const index = parseInt(tr.dataset.index);
    const song = state.songLibrary[index];
    if (song) {
      tr.querySelectorAll("input[data-field]").forEach(input => {
        const field = input.dataset.field;
        const value = input.value.trim();
        if (field === "tags") {
          song.tags = value.split(",").map(t => t.trim()).filter(t => t);
        } else if (field === "genre") {
          song.genre = value;
        } else if (field === "category") {
          song.category = value;
        } else {
          song[field] = value;
        }
      });
    }
  });
}

export function closeManagerModal() {
  if (elements.managerModal) {
    elements.managerModal.classList.remove("active");
  }
}