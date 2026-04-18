/**
 * js/ui/core.js - Core UI Utilities & Layout Logic
 */
import { state } from '../state.js';
import { elements } from './elements.js';

export function updateGenreDropdowns() {
  const genres = ["전체", ...state.getAllGenres()];
  const dropdown = document.getElementById("lib-genre-dropdown");
  if (!dropdown) return;
  
  const optionsContainer = dropdown.querySelector(".select-options");
  if (optionsContainer) {
    optionsContainer.innerHTML = genres.map(g => `
      <div class="option-item ${g === "전체" ? "selected" : ""}" data-value="${g === "전체" ? "all" : g}">${g}</div>
    `).join("");
  }
}

export function updateCategoryDropdown() {
  const cats = ["전체", ...state.getAllCategories()];
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
export function setupGridResizeObserver() {
  const container = elements.scrollArea || (elements.songGrid ? elements.songGrid.parentElement : null);
  if (!container || !elements.songGrid) return;
  
  if (resizeObserver) resizeObserver.disconnect();
  
  resizeObserver = new ResizeObserver(entries => {
    if (state.viewMode === 'list') return;
    
    for (let entry of entries) {
      const width = entry.contentRect.width;
      if (width <= 0) continue;
      
      const columns = Math.floor((width + 24 + 30) / (200 + 24));
      
      if (columns > 0 && state.lastColumns !== columns) {
        // 1. [First] Capture current positions
        const cards = Array.from(elements.songGrid.querySelectorAll('.song-card'));
        const firstPositions = cards.map(card => {
          const rect = card.getBoundingClientRect();
          return { id: card.dataset.index, left: rect.left, top: rect.top };
        });

        // 2. [Last] Apply new layout
        state.lastColumns = columns;
        elements.songGrid.style.gridTemplateColumns = `repeat(${columns}, 200px)`;

        // Update the global CSS variable for other components to align with the grid
        const actualWidth = (columns * 200) + ((columns - 1) * 24);
        document.documentElement.style.setProperty('--grid-actual-width', `${actualWidth}px`);

        // 3. [Invert & Play] Trigger animation in next frame to allow layout shift
        requestAnimationFrame(() => {
          cards.forEach((card, i) => {
            const first = firstPositions[i];
            const last = card.getBoundingClientRect();
            if (!first) return;

            const dx = first.left - last.left;
            const dy = first.top - last.top;

            if (dx === 0 && dy === 0) return;

            // Invert: Set to old position immediately (no transition)
            card.style.transition = 'none';
            card.style.transform = `translate(${dx}px, ${dy}px)`;

            // Force reflow
            card.offsetHeight;

            // Play: Trigger smooth move to new position
            card.style.transition = ''; // Restore CSS transition
            card.style.transform = '';
          });
        });
      }
    }
  });
  
  resizeObserver.observe(container);

  // Initial column count sync
  const initialWidth = container.clientWidth;
  if (initialWidth > 0) {
    const columns = Math.floor((initialWidth + 24 + 30) / (200 + 24));
    if (columns > 0) {
      state.lastColumns = columns;
      elements.songGrid.style.gridTemplateColumns = `repeat(${columns}, 200px)`;
      const actualWidth = (columns * 200) + ((columns - 1) * 24);
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
