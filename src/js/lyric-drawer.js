/**
 * src/js/lyric-drawer.js - Sliding Drawer UI Logic
 */
import { listen } from './tauri-bridge.js';
import { state } from './state.js';

export function initLyricDrawer() {
    const trigger = document.getElementById('lyric-drawer-trigger');
    const closeBtn = document.getElementById('lyric-drawer-close');
    const drawer = document.getElementById('lyric-drawer');
    const controlsWrapper = document.querySelector('.page-controls-wrapper');
    const body = document.body;

    if (!trigger) return;

    const updateDrawerWidthVars = () => {
        if (!drawer) return;
        const drawerWidth = Math.ceil(drawer.getBoundingClientRect().width);
        if (drawerWidth > 0) {
            document.documentElement.style.setProperty('--lyric-drawer-width', `${drawerWidth}px`);
        }
    };

    const updateDrawerBounds = () => {
        const titlebarHeight = parseFloat(
            getComputedStyle(document.documentElement).getPropertyValue('--titlebar-height')
        ) || 38;

        let drawerTop = titlebarHeight + 120;

        if (controlsWrapper) {
            const wrapperRect = controlsWrapper.getBoundingClientRect();
            if (wrapperRect.height > 0) {
                drawerTop = Math.max(titlebarHeight, wrapperRect.bottom);
            }
        }

        document.documentElement.style.setProperty('--lyric-drawer-top', `${Math.round(drawerTop)}px`);
        updateDrawerWidthVars();
    };

    const toggleDrawer = () => {
        body.classList.toggle('drawer-open');
        updateDrawerBounds();
    };

    trigger.onclick = toggleDrawer;

    if (closeBtn) {
        closeBtn.onclick = () => {
            body.classList.remove('drawer-open');
            updateDrawerBounds();
        };
    }

    // Optional: Close drawer on Escape key
    window.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && body.classList.contains('drawer-open')) {
            body.classList.remove('drawer-open');
            updateDrawerBounds();
        }
    });

    window.addEventListener('resize', updateDrawerBounds);
    window.addEventListener('scroll', updateDrawerBounds, { passive: true });
    updateDrawerBounds();

    // Setup real-time sync listener
    listen('playback-progress', (event) => {
        const positionMs = event.payload.positionMs ?? event.payload.position_ms ?? 0;
        const currentTime = positionMs / 1000;
        syncLyricsWithTime(currentTime);
    });

    console.log('[LyricDrawer] Initialized');
}

/**
 * Updates the drawer content with new segments
 * @param {Array} segments 
 */
export function updateLyrics(segments) {
    const container = document.querySelector('#lyric-drawer .drawer-content');
    if (!container) return;

    if (!segments || segments.length === 0) {
        container.innerHTML = `
            <div class="drawer-empty-msg">
                <p>정렬된 가사가 없습니다.</p>
                <p style="font-size: 0.85rem; opacity: 0.6; margin-top: 10px;">
                    Lyric Sync 모드에서<br>가사 싱크를 생성하세요.
                </p>
            </div>
        `;
        return;
    }

    container.innerHTML = segments.map((s, i) => `
        <div class="lyric-line-item drawer-lyric-item" data-index="${i}">
            <span class="lyric-text">${s.text}</span>
        </div>
    `).join('');
}

/**
 * Highlights and scrolls to the active lyric line
 * @param {number} currentTime 
 */
function syncLyricsWithTime(currentTime) {
    const lyrics = state.currentLyrics;
    if (!lyrics || lyrics.length === 0) return;

    let playingIndex = -1;
    for (let i = 0; i < lyrics.length; i++) {
        const s = lyrics[i];
        if (s.start > 0 && currentTime >= s.start && (s.end === 0 || currentTime < s.end)) {
            playingIndex = i;
        }
    }

    if (playingIndex === state.currentLyricIndex) return;
    state.currentLyricIndex = playingIndex;

    const container = document.querySelector('#lyric-drawer .drawer-content');
    if (!container) return;

    const items = container.querySelectorAll('.drawer-lyric-item');
    items.forEach((item, i) => {
        if (i === playingIndex) {
            item.classList.add('active');
            item.scrollIntoView({ behavior: 'smooth', block: 'center' });
        } else {
            item.classList.remove('active');
        }
    });
}

