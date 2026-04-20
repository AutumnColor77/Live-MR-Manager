/**
 * js/ui/core.js - Core UI Utilities & Layout Logic
 */
import { state, getAllGenres, getAllCategories } from '../state.js';
import { elements } from './elements.js';
import { invoke } from '../tauri-bridge.js';

export async function updateGenreDropdowns() {
  const genres = ["전체", ...(await getAllGenres())];
  const dropdown = document.getElementById("lib-genre-dropdown");
  if (!dropdown) return;
  
  const optionsContainer = dropdown.querySelector(".select-options");
  if (optionsContainer) {
    optionsContainer.innerHTML = genres.map(g => `
      <div class="option-item ${g === "전체" ? "selected" : ""}" data-value="${g === "전체" ? "all" : g}">${g}</div>
    `).join("");
  }
}

export async function updateCategoryDropdown() {
  const cats = ["전체", ...(await getAllCategories())];
  const dropdown = document.getElementById("lib-category-dropdown");
  if (!dropdown) return;

  const optionsContainer = dropdown.querySelector(".select-options");
  if (optionsContainer) {
    optionsContainer.innerHTML = cats.map(c => `
      <div class="option-item ${c === "전체" ? "selected" : ""}" data-value="${c === "전체" ? "all" : c}">${c}</div>
    `).join("");
  }
}

export function updateSortDropdown() {
  // Sorting options are usually static in HTML, but we can sync them if needed
}


let resizeObserver = null;

/** Matches --library-grid-gap (12) and horizontal padding 30+30 from library-common.css */
const GRID_GAP = 12;
const CARD_WIDTH = 200;
const LIBRARY_H_PADDING = 60;

function computeGridColumns(containerWidth) {
  const isDrawerOpen = document.body.classList.contains('drawer-open');
  // 30px left + (10px right if drawer open, else 30px right)
  const currentPadding = isDrawerOpen ? 40 : LIBRARY_H_PADDING;
  const inner = Math.max(0, containerWidth - currentPadding);
  const slot = CARD_WIDTH + GRID_GAP;
  // Add 2px tolerance to avoid dropping columns due to sub-pixel rounding
  const columns = Math.max(1, Math.floor((inner + GRID_GAP + 2) / slot));
  
  if (isDrawerOpen) {
    invoke('remote_js_log', { msg: `[Grid Layout] Width: ${Math.round(containerWidth)}, Padding: ${currentPadding}, Columns: ${columns}` }).catch(() => {});
  }
  
  return columns;
}

export function setupGridResizeObserver() {
  const container = elements.scrollArea || (elements.songGrid ? elements.songGrid.parentElement : null);
  if (!container || !elements.songGrid) return;
  
  if (resizeObserver) resizeObserver.disconnect();
  
  resizeObserver = new ResizeObserver(entries => {
    if (state.viewMode === 'list') return;
    
    for (let entry of entries) {
      const width = entry.contentRect.width;
      if (width <= 0) continue;
      
      const columns = computeGridColumns(width);
      const isDrawerOpen = document.body.classList.contains('drawer-open');
      
      // Re-apply if columns changed OR if drawer is open (to keep CSS vars in sync with resize)
      if (columns > 0 && (state.lastColumns !== columns || isDrawerOpen)) {
        const columnsChanged = state.lastColumns !== columns;
        let cards = [];
        let firstPositions = [];
        
        if (columnsChanged) {
          cards = Array.from(elements.songGrid.querySelectorAll('.song-card'));
          firstPositions = cards.map(card => {
            const rect = card.getBoundingClientRect();
            return { id: card.dataset.index, left: rect.left, top: rect.top };
          });
        }

        state.lastColumns = columns;
        elements.songGrid.style.gridTemplateColumns = `repeat(${columns}, ${CARD_WIDTH}px)`;
        const actualWidth = columns * CARD_WIDTH + (columns - 1) * GRID_GAP;
        document.documentElement.style.setProperty('--grid-actual-width', `${actualWidth}px`);

        if (columnsChanged && cards.length > 0) {
          requestAnimationFrame(() => {
            cards.forEach((card, i) => {
              const first = firstPositions[i];
              if (!first) return;
              const last = card.getBoundingClientRect();
              const dx = first.left - last.left;
              const dy = first.top - last.top;
              if (dx === 0 && dy === 0) return;
              card.style.transition = 'none';
              card.style.transform = `translate(${dx}px, ${dy}px)`;
              card.offsetHeight;
              card.style.transition = '';
              card.style.transform = '';
            });
          });
        }
      }
    }
  });
  
  resizeObserver.observe(container);

  // Initial column count sync
  const initialWidth = container.clientWidth;
  if (initialWidth > 0) {
    const columns = computeGridColumns(initialWidth);
    if (columns > 0) {
      state.lastColumns = columns;
      elements.songGrid.style.gridTemplateColumns = `repeat(${columns}, ${CARD_WIDTH}px)`;
      const actualWidth = columns * CARD_WIDTH + (columns - 1) * GRID_GAP;
      document.documentElement.style.setProperty('--grid-actual-width', `${actualWidth}px`);
    }
  }
}

export function initSortable() {
  if (!elements.songGrid) return;
  
  import('../libs/Sortable.min.js').then(() => {
    new window.Sortable(elements.songGrid, {
      animation: 150,
      ghostClass: 'sortable-ghost',
      filter: '.ignore-sort',
      onEnd: (evt) => {
        // Handle reorder logic if needed
      }
    });
  }).catch(err => console.error("SortableJS load failed:", err));
}
