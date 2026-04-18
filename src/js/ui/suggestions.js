/**
 * js/ui/suggestions.js - Search Suggestions & Autocomplete
 */
import { elements } from './elements.js';

export function updateSuggestions(suggestions, onSelect) {
  const container = document.getElementById("search-suggestions");
  if (!container) return;
  
  if (!suggestions || suggestions.length === 0) {
    container.style.display = "none";
    return;
  }
  
  container.innerHTML = suggestions.map(s => `
    <div class="suggestion-item">
      <i class="fas fa-history"></i>
      <span>${s}</span>
    </div>
  `).join("");
  
  container.style.display = "block";
  
  const items = container.querySelectorAll(".suggestion-item");
  items.forEach((item, i) => {
    item.onclick = () => {
      onSelect(suggestions[i]);
      container.style.display = "none";
    };
  });
}
