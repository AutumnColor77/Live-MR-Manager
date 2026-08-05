/**
 * src/js/lyric-drawer.js - Sliding Drawer UI Logic
 */
import { listen, invoke } from './tauri-bridge.js';
import { state } from './state.js';
import { registerAppHandler, callAppHandler } from './app-context.js';
import { getDisplayLines, parseLrc } from './lrc-parser.js';
import { getPromoOverlayLyrics, isPromoSongPath } from './screenshot-library.js';

let lastOverlayCurrent = null;
let lastOverlayNext = null;

function getOverlaySegments(fallbackSegments) {
    const path = state.currentTrack?.path;
    if (!isPromoSongPath(path)) return fallbackSegments || [];
    const duration = (state.trackDurationMs || 0) / 1000;
    return parseLrc(getPromoOverlayLyrics(path), duration);
}

function updateDrawerTrackTitle() {
    const titleEl = document.getElementById('lyric-drawer-track-title');
    if (!titleEl) return;
    titleEl.textContent = state.currentTrack?.title || '선택된 곡 없음';
}

export function syncLyricDrawerHeader() {
    updateDrawerTrackTitle();
}

export function refreshLyricDrawerLayout() {
    const titlebarHeight = parseFloat(
        getComputedStyle(document.documentElement).getPropertyValue('--titlebar-height')
    ) || 38;

    // 타이틀바 바로 아래부터 독 위까지 세로로 꽉 채움 (라이브러리·신청목록 공통)
    document.documentElement.style.setProperty('--lyric-drawer-top', `${Math.round(titlebarHeight)}px`);
}

export function initLyricDrawer() {
    const trigger = document.getElementById('lyric-drawer-trigger');
    const closeBtn = document.getElementById('lyric-drawer-close');
    const drawer = document.getElementById('lyric-drawer');
    const body = document.body;

    if (!trigger) return;

    const resizer = document.getElementById('lyric-drawer-resizer');
    let isResizing = false;
    let startX, startWidth;

    const minWidth = 230;
    const initialWidth = parseInt(localStorage.getItem('lyricDrawerWidth')) || 230;

    const getHandleWidth = () => {
        const raw = getComputedStyle(document.documentElement).getPropertyValue('--lyric-handle-width');
        const parsed = parseFloat(raw);
        return Number.isFinite(parsed) ? parsed : 24;
    };

    const updateDrawerWidthVars = (width) => {
        if (!drawer) return;
        document.documentElement.style.setProperty('--lyric-drawer-width', `${width}px`);
        // Panel overlaps right padding by 30px; also reserve the LYRICS handle to its left.
        const layoutGap = parseFloat(
            getComputedStyle(document.documentElement).getPropertyValue('--lyric-layout-gap')
        ) || 10;
        const reserved = Math.max(0, width - 30 + getHandleWidth() + layoutGap);
        document.documentElement.style.setProperty('--lyric-reserved-width', `${reserved}px`);
        localStorage.setItem('lyricDrawerWidth', width);
    };

    updateDrawerWidthVars(initialWidth);

    const updateDrawerBounds = () => {
        refreshLyricDrawerLayout();
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

    const notifyDrawerLayoutChange = () => {
        requestAnimationFrame(() => {
            window.dispatchEvent(new Event('resize'));
        });
    };

    const openDrawer = () => {
        body.classList.add('drawer-open');
        updateDrawerBounds();
        updateDrawerTrackTitle();
        notifyDrawerLayoutChange();

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
        notifyDrawerLayoutChange();

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

    container.textContent = '';
    const frag = document.createDocumentFragment();
    segments.forEach((s, i) => {
        const item = document.createElement('div');
        item.className = 'lyric-line-item drawer-lyric-item';
        item.dataset.index = String(i);
        item.appendChild(buildLyricTextEl(s, 'app'));
        frag.appendChild(item);
    });
    container.appendChild(frag);

    // 가사 뷰 페이지(/lyrics-view, OBS 독)용 전체 가사 목록 푸시.
    // 인앱 표시 설정('app' 스코프)을 따라 원문/차음/번역 노출을 결정.
    // 가사 텍스트는 신뢰할 수 없는 입력이므로 일반 문자열로만 전송하고
    // (마크업 없음), 여러 줄은 `\n`으로만 구분 — 수신측이 안전하게 DOM으로
    // 조립한다 (overlay-lyrics.html / lyrics-view.html).
    invoke('update_overlay_lyrics_full', {
        lines: getOverlaySegments(segments).map((seg) => joinLinesForTransport(displayLines(seg, 'overlay'))),
    }).catch(() => {});
}

/**
 * 설정된 표시 항목(원문/차음/번역)을 순서대로 반환. 일반 가사는 [text] 하나.
 * `scope`는 'app'(인앱 드로어) 또는 'overlay'(OBS 오버레이) — 서로 독립적으로
 * 설정 가능하다(lrc-parser.js의 getLineVisibility).
 *
 * 보안 참고: 반환값은 항상 순수 문자열 배열이며 절대 HTML로 조립하지 않는다
 * — LRC/강제정렬/온라인 메타데이터 등 신뢰할 수 없는 출처를 포함하므로,
 * 렌더링은 항상 buildLyricTextEl(DOM 생성) 또는 joinLinesForTransport(전송용
 * `\n` 결합, 수신측이 다시 안전하게 DOM으로 조립) 경유로만 이루어져야 한다.
 */
function displayLines(seg, scope = 'app') {
    return getDisplayLines(seg, scope).filter(Boolean);
}

/** 전송용(WS/오버레이 커맨드) 결합 — `\n`으로만 구분, 마크업 없음. 수신측이
 * 이 문자열을 innerHTML에 넣으면 안 되고, split('\n') 후 DOM으로 조립해야
 * 한다 (overlay-lyrics.html의 renderLineInto, lyrics-view.html의 buildLineEl 참고). */
function joinLinesForTransport(lines) {
    return lines.join('\n');
}

/** 인앱 드로어용 `.lyric-text` 요소를 innerHTML 없이 안전하게 조립한다 — 가사
 * 텍스트가 신뢰할 수 없는 출처(LRC/강제정렬 결과)를 포함할 수 있기 때문
 * (XSS 방지). 첫 줄은 본문 크기, 나머지(원문/차음/번역)는 작고 흐리게. */
function buildLyricTextEl(seg, scope) {
    const span = document.createElement('span');
    span.className = 'lyric-text';
    const lines = displayLines(seg, scope);
    lines.forEach((line, i) => {
        if (i > 0) span.appendChild(document.createElement('br'));
        if (i === 0) {
            span.appendChild(document.createTextNode(line));
        } else {
            const sub = document.createElement('span');
            sub.className = 'lyric-subline';
            sub.textContent = line;
            span.appendChild(sub);
        }
    });
    return span;
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

    const overlayLyrics = getOverlaySegments(lyrics);
    let overlayIndex = -1;
    for (let i = 0; i < overlayLyrics.length; i++) {
        const s = overlayLyrics[i];
        if (s.start > 0 && currentTime >= s.start && (s.end === 0 || currentTime < s.end)) {
            overlayIndex = i;
        }
    }
    const current = (overlayIndex !== -1)
        ? joinLinesForTransport(displayLines(overlayLyrics[overlayIndex], 'overlay'))
        : "";
    const next = (overlayIndex !== -1)
        ? ((overlayIndex + 1 < overlayLyrics.length) ? joinLinesForTransport(displayLines(overlayLyrics[overlayIndex + 1], 'overlay')) : "")
        : ((overlayLyrics.length > 0) ? joinLinesForTransport(displayLines(overlayLyrics[0], 'overlay')) : "");

    // IMPORTANT: Don't skip overlay update only because index didn't change.
    // At song start, index can stay -1 for a while but first line still needs to appear in "next".
    const overlayPayloadChanged = current !== lastOverlayCurrent || next !== lastOverlayNext;
    if (overlayPayloadChanged) {
        // index는 가사 뷰 페이지(/lyrics-view)의 현재 줄 하이라이트용
        invoke('update_overlay_lyrics', { current, next, index: overlayIndex }).catch(err => console.error(err));
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

