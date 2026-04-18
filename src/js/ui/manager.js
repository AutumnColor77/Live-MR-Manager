/**
 * js/ui/manager.js - Library Manager (Table View)
 */
import { state } from '../state.js';
import { elements } from './elements.js';

export function openLibraryManager() {
  if (!elements.managerModal) return;
  elements.managerModal.classList.add("active");
  renderManagerTable();
}

export function renderManagerTable() {
  if (!elements.managerTableBody) return;
  
  const songs = state.library;
  const filtered = songs.filter(s => {
    const q = (elements.managerSearchInput ? elements.managerSearchInput.value : "").toLowerCase();
    return s.title.toLowerCase().includes(q) || (s.artist || "").toLowerCase().includes(q);
  });

  elements.managerTableBody.innerHTML = filtered.map((song, i) => `
    <tr>
      <td style="width: 40px; text-align: center;">
        <input type="checkbox" class="manager-check" data-path="${song.path}">
      </td>
      <td>${song.title}</td>
      <td>${song.artist || "-"}</td>
      <td>${song.category || "-"}</td>
      <td>${song.mr_path ? '<span class="status-badge mr">MR</span>' : "-"}</td>
      <td>
        <button class="btn-icon" onclick="editSong(${song.originalIndex})"><i class="fas fa-edit"></i></button>
      </td>
    </tr>
  `).join("");
  
  if (elements.managerStat) {
    elements.managerStat.textContent = `Total: ${songs.length} | Filtered: ${filtered.length}`;
  }
}

export function initTableResizing() {
  // This usually needs references to the table headers
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
