/**
 * src/js/lyric-drawer.js - Sliding Drawer UI Logic
 */
import { listen, invoke } from './tauri-bridge.js';
import { state } from './state.js';
import { registerAppHandler, callAppHandler } from './app-context.js';
import { getDisplayLines } from './lrc-parser.js';

let lastOverlayCurrent = null;
let lastOverlayNext = null;

function updateDrawerTrackTitle() {
    const titleEl = document.getElementById('lyric-drawer-track-title');
    if (!titleEl) return;
    titleEl.textContent = state.currentTrack?.title || '선택된 곡 없음';
}

export function syncLyricDrawerHeader() {
    updateDrawerTrackTitle();
}

export function initLyricDrawer() {
    const trigger = document.getElementById('lyric-drawer-trigger');
    const closeBtn = document.getElementById('lyric-drawer-close');
    const drawer = document.getElementById('lyric-drawer');
    const controlsWrapper = document.querySelector('.page-controls-wrapper');
    const body = document.body;

    if (!trigger) return;

    const resizer = document.getElementById('lyric-drawer-resizer');
    let isResizing = false;
    let startX, startWidth;

    const minWidth = 230;
    const initialWidth = parseInt(localStorage.getItem('lyricDrawerWidth')) || 230;

    const updateDrawerWidthVars = (width) => {
        if (!drawer) return;
        document.documentElement.style.setProperty('--lyric-drawer-width', `${width}px`);
        // Subtract 30px (safe area) from reserved width.
        // This allows the drawer to overlap the grid's padding, effectively gaining 30px of space for cards.
        const reserved = Math.max(0, width - 30);
        document.documentElement.style.setProperty('--lyric-reserved-width', `${reserved}px`);
        localStorage.setItem('lyricDrawerWidth', width);
    };

    updateDrawerWidthVars(initialWidth);

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
    };

    if (resizer) {
        resizer.onmousedown = (e) => {
            isResizing = true;
            startX = e.clientX;
            startWidth = parseInt(getComputedStyle(drawer).width);
            body.style.cursor = 'ew-resize';
            body.classList.add('is-resizing');
            e.preventDefault();
        };

        window.addEventListener('mousemove', (e) => {
            if (!isResizing) return;
            const deltaX = startX - e.clientX;
            const newWidth = Math.max(minWidth, startWidth + deltaX);
            updateDrawerWidthVars(newWidth);
        });

        window.addEventListener('mouseup', () => {
            if (isResizing) {
                isResizing = false;
                body.style.cursor = '';
                body.classList.remove('is-resizing');
            }
        });
    }

    const openDrawer = () => {
        body.classList.add('drawer-open');
        updateDrawerBounds();
        updateDrawerTrackTitle();

        // Sync with bottom toggle button if exists
        const toggle = document.getElementById('toggle-lyric');
        if (toggle && !toggle.checked) {
            toggle.checked = true;
            state.lyricsEnabled = true;
            localStorage.setItem("lyricsEnabled", true);
            // Notify audio engine that lyrics are enabled
            import('./audio.js').then(({ toggleAiFeature }) => {
                toggleAiFeature("lyric", true);
            });
        }
    };

    const closeDrawer = () => {
        body.classList.remove('drawer-open');
        updateDrawerBounds();

        // Sync with bottom toggle button if exists
        const toggle = document.getElementById('toggle-lyric');
        if (toggle && toggle.checked) {
            toggle.checked = false;
            state.lyricsEnabled = false;
            localStorage.setItem("lyricsEnabled", false);
            // Notify audio engine that lyrics are disabled
            import('./audio.js').then(({ toggleAiFeature }) => {
                toggleAiFeature("lyric", false);
            });
        }
    };

    const toggleDrawer = () => {
        if (body.classList.contains('drawer-open')) {
            closeDrawer();
        } else {
            openDrawer();
        }
    };

    trigger.onclick = toggleDrawer;

    if (closeBtn) {
        closeBtn.onclick = closeDrawer;
    }

    registerAppHandler('openLyricDrawer', openDrawer);
    registerAppHandler('closeLyricDrawer', closeDrawer);

    const goToLyricSyncForCurrentTrack = async () => {
        const currentPath = state.currentTrack?.path;
        if (!currentPath) {
            callAppHandler('switchToTab', 'alignment');
            return;
        }
        try {
            const nav = await import('./events/navigation.js');
            if (typeof nav.openAlignmentForTrack === 'function') {
                await nav.openAlignmentForTrack(currentPath, { forceLoad: true });
            } else {
                callAppHandler('switchToTab', 'alignment');
            }
        } catch (err) {
            console.error('[LyricDrawer] Failed to open alignment for current track:', err);
            callAppHandler('switchToTab', 'alignment');
        }
    };
    registerAppHandler('goToLyricSyncForCurrentTrack', goToLyricSyncForCurrentTrack);

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
    updateDrawerTrackTitle();

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
    updateDrawerTrackTitle();
    // On track change, always reset lyric drawer to top for singer-friendly flow.
    container.scrollTop = 0;
    state.currentLyricIndex = -1;

    // 가사 뷰 페이지(/lyrics-view, OBS 독)용 전체 가사 목록 푸시.
    // 인앱 표시 설정('app' 스코프)을 따라 원문/차음/번역 노출을 결정.
    invoke('update_overlay_lyrics_full', {
        lines: (segments || []).map((seg) => displayText(seg, 'app')),
    }).catch(() => {});

    if (!segments || segments.length === 0) {
        lastOverlayCurrent = null;
        lastOverlayNext = null;
        container.innerHTML = `
            <div class="drawer-empty-msg" style="padding: 40px 20px; text-align: center;">
                <div style="font-size: 2.5rem; margin-bottom: 20px; opacity: 0.5;">🎵</div>
                <p style="font-weight: 700; font-size: 1.1rem; margin-bottom: 8px;">정렬된 가사가 없습니다.</p>
                <p style="font-size: 0.85rem; opacity: 0.6; line-height: 1.6; margin-bottom: 24px;">
                    이 곡에 등록된 가사 싱크가 없습니다.<br>Lyric Sync 모드에서 가사를 정렬해 보세요.
                </p>
                <button type="button" class="primary-btn btn-md lyric-sync-cta" style="width: 100%;">
                    가사 싱크 등록하러 가기
                </button>
            </div>
        `;
        return;
    }

    container.querySelector('.lyric-sync-cta')?.addEventListener('click', () => {
        callAppHandler('goToLyricSyncForCurrentTrack');
    });

    // Reset overlay payload cache when track lyrics are replaced.
    lastOverlayCurrent = null;
    lastOverlayNext = null;

    container.innerHTML = segments.map((s, i) => `
        <div class="lyric-line-item drawer-lyric-item" data-index="${i}">
            <span class="lyric-text">${displayText(s, 'app')}</span>
        </div>
    `).join('');
}

/**
 * 설정된 표시 항목(원문/차음/번역)을 합친 텍스트. 일반 가사는 text 그대로.
 * 두 번째 줄부터는 살짝 작게 — 오버레이/드로어 모두 innerHTML로 렌더링하고
 * white-space: normal이라 `\n`은 그냥 공백으로 뭉개지므로 `<br>`로 조인.
 * `scope`는 'app'(인앱 드로어) 또는 'overlay'(OBS 오버레이) — 서로 독립적으로
 * 설정 가능하다(lrc-parser.js의 getLineVisibility).
 */
function displayText(seg, scope = 'app') {
    const lines = getDisplayLines(seg, scope).filter(Boolean);
    if (lines.length === 0) return '';
    if (lines.length === 1) return lines[0];
    const [first, ...rest] = lines;
    const restHtml = rest.map((l) => `<span style="font-size:0.7em;opacity:0.85;">${l}</span>`).join('<br>');
    return `${first}<br>${restHtml}`;
}

/**
 * Highlights and scrolls to the active lyric line
 * @param {number} currentTime 
 */
function syncLyricsWithTime(currentTime) {
    const lyrics = state.currentLyrics;
    if (!lyrics || lyrics.length === 0) {
        // [추가] 가사가 없는 곡이라면 오버레이의 가사 영역을 확실히 비움
        invoke('update_overlay_lyrics', { current: "", next: "", index: -1 }).catch(err => console.error(err));
        return;
    }

    let playingIndex = -1;
    for (let i = 0; i < lyrics.length; i++) {
        const s = lyrics[i];
        if (s.start > 0 && currentTime >= s.start && (s.end === 0 || currentTime < s.end)) {
            playingIndex = i;
        }
    }

    const current = (playingIndex !== -1) ? displayText(lyrics[playingIndex], 'overlay') : "";
    const next = (playingIndex !== -1)
        ? ((playingIndex + 1 < lyrics.length) ? displayText(lyrics[playingIndex + 1], 'overlay') : "")
        : ((lyrics.length > 0) ? displayText(lyrics[0], 'overlay') : "");

    // IMPORTANT: Don't skip overlay update only because index didn't change.
    // At song start, index can stay -1 for a while but first line still needs to appear in "next".
    const overlayPayloadChanged = current !== lastOverlayCurrent || next !== lastOverlayNext;
    if (overlayPayloadChanged) {
        // index는 가사 뷰 페이지(/lyrics-view)의 현재 줄 하이라이트용
        invoke('update_overlay_lyrics', { current, next, index: playingIndex }).catch(err => console.error(err));
        lastOverlayCurrent = current;
        lastOverlayNext = next;
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

