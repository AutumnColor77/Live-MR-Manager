import { showNotification, getThumbnailUrl, escapeHtml } from './utils.js';
import { invoke, listen } from './tauri-bridge.js';
import { state } from './state.js';
import { parseLrc } from './lyrics.js';
import { getLyricSyncStatus } from './library-filters.js';
import {
    parseMarkers,
    formatMarkerLine,
    formatTimeInput,
    parseTimeInput,
    suggestVocalStartFromSegments,
    encodeLrc,
    mergeAlignmentResult,
    getSyncText,
    isTriplet,
    getDisplayLines,
    getShowTranslation,
    setShowTranslation,
} from './lrc-parser.js';

const SYNC_STATUS_LABEL = { synced: '싱크 완료', unsynced: '미싱크', none: '가사 없음' };
const FOLLOW_PLAYHEAD_KEY = 'alignmentFollowPlayhead';
const TRACK_GROUP_COLLAPSED_KEY = 'alignmentTrackGroupCollapsed';

export class ForcedAlignmentViewer {
    constructor(containerId) {
        this.container = document.getElementById(containerId);
        this.invoke = invoke;

        this.state = {
            duration: 0,
            currentTime: 0,
            isPlaying: false,
            segments: [],
            waveformPoints: null,
            isProcessing: false,
            isSeeking: false,
            currentSyncIndex: -1,
            isSyncMode: false,
            zoomLevel: 1.0,
            scrollTime: 0,
            isPanning: false,
            lastPanX: 0,
            isScrolling: false,
            isResizing: false,
            resizeTarget: null,
            hoveringTarget: null,
            selectedTarget: null,
            // 보컬 시작/간주 구간 마커. loadAudio에서 LRC로부터 채워지고,
            // saveLrc에서 다시 [vocalstart]/[ilstart]/[ilend] 줄로 직렬화된다.
            markers: { vocalStartSec: null, interludes: [] },
            // 원문/차음/번역 3줄을 하나의 싱크 단위로 묶는 수동 입력 모드.
            tripletMode: false,
            // 확대 상태에서 재생 위치 선을 화면 중앙에 유지.
            followPlayhead: localStorage.getItem(FOLLOW_PLAYHEAD_KEY) !== 'false',
            // 보컬 시작 제안(AI 정렬/파형). 출처를 구분해 서로 덮어쓰지 않게 한다.
            suggestedVocalStartSec: null,
            suggestedVocalStartSource: null,
        };
        this.trackFilterStatus = 'all';
        this._trackSearchTimer = null;
        this.autoSaveTimer = null;
        this.autoSaveDelayMs = 1000;
        this.isDirty = false;
        this.isAutoSaving = false;
        this.lastSavedAt = null;

        this.initUI();
        this.setupListeners();
        this.parseLyrics();
        this.renderMarkerList();
        this.setupBackendListeners();
        this.setupAlignmentQueueIntegration();
        this.loadTrackList();

        window.addEventListener('resize', () => this.resize());
    }

    initUI() {
        if (!this.container) return;
        this.container.innerHTML = `
            <div class="alignment-container">
                <aside class="lyric-input-column">
                    <div class="alignment-card">
                        <section>
                            <div class="card-header" style="margin-bottom: 12px;">
                                <h3>음원 선택</h3>
                            </div>
                            <div class="track-select-row">
                                <button id="open-track-modal-btn" class="track-select-btn">
                                    <span id="selected-track-name">음원을 선택하세요...</span>
                                    <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M7 10l5 5 5-5z"/></svg>
                                </button>
                            </div>
                        </section>
                        <section style="flex:1; display:flex; flex-direction:column; min-height:0;">
                            <div class="card-header lyrics-input-header" style="margin-bottom: 8px;">
                                <h3>가사 원고</h3>
                                <label class="align-check-label" title="원문 / 한글 차음 / 번역이 3줄 1세트로 반복되는 가사를 붙여넣을 때 켜세요. 같은 타임스탬프의 [orig]/[pron]/[tran] 3줄로 저장됩니다.">
                                    <input type="checkbox" id="triplet-mode-toggle" class="align-checkbox">
                                    <span>3줄 모드</span>
                                </label>
                            </div>
                            <textarea id="lyrics-input" class="lyrics-textarea" placeholder="가사를 입력하세요..."></textarea>
                        </section>
                    </div>
                </aside>

                <main class="alignment-main">
                    <div class="alignment-card waveform-card">
                        <div class="card-header waveform-card-header">
                            <h3>오디오 타임라인</h3>
                            <label class="align-check-label" title="확대 상태에서 재생 위치가 항상 화면 중앙에 오도록 파형을 따라갑니다">
                                <input type="checkbox" id="follow-playhead-toggle" class="align-checkbox">
                                <span>타임바 따라가기</span>
                            </label>
                        </div>
                        <div class="waveform-canvas-container" style="position: relative;">
                            <canvas id="waveform-canvas"></canvas>
                            <div id="waveform-loader" style="display: none; position: absolute; top: 0; left: 0; width: 100%; height: 100%; background: var(--overlay-bg); flex-direction: column; justify-content: center; align-items: center; z-index: 10; border-radius: 8px;">
                                <div class="loader-spinner" style="position: relative; width: 48px; height: 48px; margin-bottom: 12px;">
                                    <svg viewBox="0 0 24 24" width="48" height="48" fill="none" stroke="var(--accent-primary)" stroke-width="3" style="animation: waveform-spin 1s linear infinite;">
                                        <circle cx="12" cy="12" r="10" stroke-opacity="0.2" />
                                        <path d="M12 2a10 10 0 0 1 10 10" />
                                    </svg>
                                </div>
                                <div id="loader-text" style="color: var(--text-main); font-size: 0.9rem; font-weight: 500;"></div>
                                <div id="loader-progress" style="margin-top: 8px; color: var(--accent-primary); font-family: monospace; font-size: 0.8rem; display: none;">0%</div>
                                <style>
                                    @keyframes waveform-spin { 100% { transform: rotate(360deg); } }
                                </style>
                            </div>
                             <!-- Floating Zoom Controls -->
                             <div class="waveform-zoom-controls">
                                 <button id="zoom-out-btn" class="zoom-btn" title="축소 (Ctrl + Wheel Down)">-</button>
                                 <button id="zoom-in-btn" class="zoom-btn" title="확대 (Ctrl + Wheel Up)">+</button>
                             </div>

                             <!-- Waveform Scrollbar (Bottom edge) -->
                             <div class="waveform-scrollbar-wrapper">
                                 <div id="waveform-scrollbar-track" class="waveform-scrollbar-track">
                                     <div id="waveform-scrollbar-thumb" class="waveform-scrollbar-thumb"></div>
                                 </div>
                             </div>
                        </div>

                        <div class="seek-bar-container" style="padding: 0; margin-top: 4px; margin-bottom: 4px;">
                            <input type="range" id="seek-bar" class="seek-bar" value="0" step="0.1" style="width: 100%; margin: 0;">
                        </div>
                        <div class="sync-controls-panel">
                            <div class="sync-bottom-row">
                                <button id="play-btn" class="sync-ctrl-btn circle-btn" title="재생/일시정지 (Space)">
                                    <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
                                </button>
                                <button id="sync-tap-btn" class="sync-ctrl-btn tap-btn">
                                    <span class="tap-label">싱크 맞추기 (Enter)</span>
                                </button>
                                <div class="time-container">
                                    <span id="time-display" style="font-family:monospace; color:#94a3b8; font-size:0.85rem;">00:00 / 00:00</span>
                                </div>
                            </div>
                            <div class="marker-controls-row">
                                <button id="mark-vocalstart-btn" class="marker-btn" title="현재 재생 위치를 보컬 시작 지점으로 지정 (V)">보컬 시작 지정 (V)</button>
                                <button id="mark-ilstart-btn" class="marker-btn" title="현재 재생 위치를 간주 시작으로 지정 (M)">간주 시작 (M)</button>
                                <button id="mark-ilend-btn" class="marker-btn" title="현재 재생 위치를 간주 종료로 지정 (열린 간주가 있을 때 M)">간주 종료</button>
                                <!-- BPM 그리드 배치는 UI에서만 숨긴 상태다. hidden을 지우고
                                     .marker-controls-row 열 수를 4로 되돌리면 다시 노출된다. -->
                                <button id="bpm-grid-btn" class="marker-btn" hidden title="미싱크 가사를 BPM 박자 간격으로 대략 배치합니다. 라이브러리에 BPM이 있으면 분석을 건너뛰고, 없으면 먼저 분석합니다. 이미 싱크된 줄과 간주 구간은 건드리지 않습니다.">BPM 그리드 배치</button>
                            </div>
                            <div id="vocal-start-suggestion" class="vocal-start-suggestion" hidden>
                                <span id="vocal-start-suggestion-label" class="vocal-start-suggestion-label"></span>
                                <button type="button" id="vocal-start-suggestion-apply" class="marker-btn">적용</button>
                                <button type="button" id="vocal-start-suggestion-dismiss" class="marker-btn marker-btn-icon" title="제안 닫기">×</button>
                            </div>
                            <div id="marker-list-panel" class="marker-list-panel"></div>
                        </div>
                        <div class="sync-controls-panel ai-align-panel">
                            <div class="ai-align-row">
                                <button id="ai-align-btn" class="sync-ctrl-btn tap-btn" title="분리된 보컬 트랙과 AI 음성 인식 모델로 미싱크 가사의 시간을 추정 (결과는 AI 초안)">
                                    <span class="tap-label">AI 자동 정렬</span>
                                </button>
                                <div class="custom-select" id="align-viewer-language-select" title="정렬에 사용할 언어 모델 (설정과 연동됩니다)">
                                    <div class="select-trigger">
                                        <span class="selected-text" id="selected-align-viewer-language-text">한국어</span>
                                        <span class="select-arrow"></span>
                                    </div>
                                    <div class="select-options">
                                        <div class="option-item selected" data-value="ko">한국어</div>
                                        <div class="option-item" data-value="en">English</div>
                                        <div class="option-item" data-value="rap">랩/혼합 (한+영)</div>
                                    </div>
                                </div>
                                <button id="ai-align-cancel-btn" class="marker-btn" style="display:none;" title="진행 중인 AI 정렬 취소">취소</button>
                            </div>
                            <span id="ai-align-status" class="marker-summary"></span>
                        </div>
                    </div>
                </main>

                <aside class="lyric-sidebar">
                    <div class="alignment-card">
                        <div class="card-header" style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px;">
                            <h3>가사 싱크 결과</h3>
                            <div style="display:flex; gap:8px; align-items:center;">
                                <button id="toggle-translation-btn" class="sync-reset-btn" title="번역 줄 표시 여부 토글. 인앱 가사창(드로어)에도 동일하게 적용됩니다. OBS 오버레이 표시 항목은 설정 화면에서 별도로 조정하세요.">번역</button>
                                <button id="reset-sync-btn" class="sync-reset-btn">초기화</button>
                            </div>
                            <span id="sync-save-status" class="sync-save-status">저장됨</span>
                        </div>
                        <div id="lyric-lines-container" class="lyric-lines-list">
                            <div style="color:#475569; text-align:center; padding-top:40px;">정렬을 시작하세요.</div>
                        </div>
                    </div>
                </aside>
            </div>
        `;
        this.canvas = document.getElementById('waveform-canvas');
        this.ctx = this.canvas ? this.canvas.getContext('2d') : null;
    }

    setupListeners() {
        const get = (id) => document.getElementById(id);
        get('open-track-modal-btn').onclick = () => this.openTrackModal();
        get('alignment-track-close').onclick = () => this.closeTrackModal();
        get('alignment-track-modal').onclick = (e) => {
            if (e.target === get('alignment-track-modal')) this.closeTrackModal();
        };
        get('alignment-track-search').oninput = (e) => {
            const value = e.target.value;
            if (this._trackSearchTimer) clearTimeout(this._trackSearchTimer);
            this._trackSearchTimer = setTimeout(() => this.renderTrackList(value), 150);
        };
        const filterChips = document.getElementById('alignment-track-filter-chips');
        if (filterChips) {
            filterChips.querySelectorAll('.track-filter-chip').forEach((chip) => {
                chip.onclick = () => {
                    filterChips.querySelectorAll('.track-filter-chip').forEach((c) => c.classList.remove('active'));
                    chip.classList.add('active');
                    this.trackFilterStatus = chip.dataset.status || 'all';
                    this.renderTrackList(get('alignment-track-search').value);
                };
            });
        }

        get('play-btn').onclick = () => this.togglePlayback();
        get('sync-tap-btn').onclick = () => this.handleTap();
        get('mark-vocalstart-btn').onclick = () => this.setMarker('vocalstart');
        get('mark-ilstart-btn').onclick = () => this.setMarker('ilstart');
        get('mark-ilend-btn').onclick = () => this.setMarker('ilend');
        get('bpm-grid-btn').onclick = () => this.runBpmGridPlacement();
        get('ai-align-btn').onclick = () => this.runAiAlignment();
        get('ai-align-cancel-btn').onclick = () => this.cancelAiAlignment();

        const followToggle = get('follow-playhead-toggle');
        if (followToggle) {
            followToggle.checked = !!this.state.followPlayhead;
            followToggle.onchange = (e) => {
                this.state.followPlayhead = !!e.target.checked;
                localStorage.setItem(FOLLOW_PLAYHEAD_KEY, String(this.state.followPlayhead));
            };
        }

        const applySuggestion = get('vocal-start-suggestion-apply');
        const dismissSuggestion = get('vocal-start-suggestion-dismiss');
        if (applySuggestion) {
            applySuggestion.onclick = () => this.acceptVocalStartSuggestion();
        }
        if (dismissSuggestion) {
            dismissSuggestion.onclick = () => this.clearVocalStartSuggestion();
        }

        // 정렬 언어 드롭다운: 설정 화면의 선택값과 같은 저장소를 공유한다.
        const langSelect = get('align-viewer-language-select');
        if (langSelect) {
            langSelect.addEventListener('click', async (e) => {
                const option = e.target.closest('.option-item');
                if (!option || !option.dataset.value) return;
                const { setAlignmentLanguage } = await import('./alignment-model.js');
                setAlignmentLanguage(option.dataset.value);
                try {
                    const mod = await import('./events/controls/alignment-model.js');
                    await mod.refreshAlignmentModelUI();
                } catch (err) {
                    console.error('[Alignment] Failed to refresh model UI:', err);
                    this.syncAlignLanguageUI();
                }
            });
        }
        this.syncAlignLanguageUI();
        get('toggle-translation-btn').onclick = () => {
            setShowTranslation(!getShowTranslation());
            this.renderLyricList();
        };
        get('reset-sync-btn').onclick = async () => {
            const { openConfirmModal } = await import('./ui/modals.js');
            openConfirmModal('싱크 초기화', '모든 싱크 데이터를 초기화하시겠습니까?', () => {
                this.state.segments.forEach(s => {
                    s.start = 0;
                    s.end = 0;
                });
                this.state.currentSyncIndex = 0;
                this.state.selectedTarget = null;
                this.renderLyricList();
                this.drawWaveform();
                showNotification('싱크 데이터가 초기화되었습니다.', 'info');
                this.markDirtyAndScheduleSave();
            });
        };

        const lyricsInput = get('lyrics-input');
        if (lyricsInput) {
            lyricsInput.addEventListener('input', () => this.parseLyrics());
        }

        const tripletToggle = get('triplet-mode-toggle');
        if (tripletToggle) {
            tripletToggle.addEventListener('change', () => {
                this.state.tripletMode = tripletToggle.checked;
                this.updateLyricsPlaceholder();
                this.parseLyrics();
            });
        }

        // Zoom Controls
        get('zoom-in-btn').onclick = () => this.handleZoom(1.5);
        get('zoom-out-btn').onclick = () => this.handleZoom(1 / 1.5);

        // Waveform Events (Zoom & Pan)
        this.canvas.addEventListener('wheel', (e) => {
            if (e.ctrlKey) {
                e.preventDefault();
                const zoomFactor = e.deltaY < 0 ? 1.2 : 1 / 1.2;
                this.handleZoom(zoomFactor, e.offsetX);
            }
        }, { passive: false });
        this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());

        this.canvas.addEventListener('mousedown', (e) => {
            if (e.button === 0) {
                if (this.state.hoveringTarget) {
                    this.state.isResizing = true;
                    this.state.resizeTarget = this.state.hoveringTarget;
                    this.state.selectedTarget = this.state.hoveringTarget;

                    const seg = this.state.segments[this.state.selectedTarget.index];
                    const targetTime = this.state.selectedTarget.type === 'start' ? seg.start : seg.end;
                    this.seekTo(targetTime, { keepPaused: true });
                } else {
                    if (this.state.duration <= 0) return;
                    const rect = this.canvas.getBoundingClientRect();
                    const x = e.clientX - rect.left;
                    const targetTime = this.xToTime(x);
                    this.seekTo(targetTime, { keepPaused: true });
                    this.state.selectedTarget = null;
                }
                this.drawWaveform();
            } else if (e.button === 2) { // Right click for panning
                this.state.isPanning = true;
                this.state.lastPanX = e.clientX;
                this.canvas.style.cursor = 'grabbing';
            }
        });

        this.canvas.addEventListener('mousemove', (e) => {
            if (this.state.isPanning || this.state.isScrolling || this.state.isResizing) return;

            const x = e.offsetX;
            const hitThreshold = 8; // Pixels
            let found = null;

            this.state.segments.forEach((seg, idx) => {
                const xStart = this.timeToX(seg.start);
                const xEnd = this.timeToX(seg.end);

                if (Math.abs(x - xStart) < hitThreshold) found = { index: idx, type: 'start' };
                else if (Math.abs(x - xEnd) < hitThreshold) found = { index: idx, type: 'end' };
            });

            this.state.hoveringTarget = found;
            this.canvas.style.cursor = found ? 'col-resize' : 'default';
            this.drawWaveform(); // Redraw to show boundary highlight
        });

        window.addEventListener('mousemove', (e) => {
            if (this.state.isResizing && this.state.resizeTarget) {
                const rect = this.canvas.getBoundingClientRect();
                const x = e.clientX - rect.left;
                const newTime = Math.max(0, Math.min(this.state.duration, this.xToTime(x)));

                const idx = this.state.resizeTarget.index;
                const seg = this.state.segments[idx];
                
                if (this.state.resizeTarget.type === 'start') {
                    const finalTime = Math.min(newTime, seg.end - 0.05);
                    seg.start = finalTime;
                    
                    // 앞 가사의 종료 지점도 함께 이동
                    if (idx > 0) {
                        this.state.segments[idx - 1].end = finalTime;
                    }
                } else {
                    const finalTime = Math.max(newTime, seg.start + 0.05);
                    seg.end = finalTime;
                    
                    // 다음 가사의 시작 지점도 함께 이동
                    if (idx < this.state.segments.length - 1) {
                        this.state.segments[idx + 1].start = finalTime;
                    }
                }

                this.drawWaveform();
                this.renderLyricList();
                this.markDirtyAndScheduleSave();
            }

            if (this.state.isPanning) {
                const dx = e.clientX - this.state.lastPanX;
                this.state.lastPanX = e.clientX;

                const visibleDuration = this.state.duration / this.state.zoomLevel;
                const timePerPixel = visibleDuration / this.canvas.width;
                const deltaTime = dx * timePerPixel;

                this.state.scrollTime = Math.max(0, Math.min(this.state.duration - visibleDuration, this.state.scrollTime - deltaTime));
                this.drawWaveform();
            }
        });

        window.addEventListener('mouseup', () => {
            const wasResizing = this.state.isResizing;
            if (this.state.isPanning) {
                this.state.isPanning = false;
                this.canvas.style.cursor = 'default';
            }
            this.state.isScrolling = false;
            this.state.isResizing = false;
            this.state.resizeTarget = null;
            if (wasResizing) {
                this.markDirtyAndScheduleSave();
            }
        });

        window.addEventListener('keydown', (e) => {
            // Ignore if typing in input/textarea
            if (e.target.tagName === 'TEXTAREA' || e.target.tagName === 'INPUT') return;
            // 가사 싱크 탭이 보일 때만 단축키 동작
            if (!document.querySelector('.viewport')?.classList.contains('alignment-mode')) return;

            if (this.state.selectedTarget) {
                const seg = this.state.segments[this.state.selectedTarget.index];
                if (!seg) return;

                const step = e.shiftKey ? 0.1 : 0.01;
                let changed = false;

                if (e.key === 'ArrowLeft') {
                    if (this.state.selectedTarget.type === 'start') {
                        seg.start = Math.max(0, seg.start - step);
                    } else {
                        seg.end = Math.max(seg.start + 0.05, seg.end - step);
                    }
                    changed = true;
                } else if (e.key === 'ArrowRight') {
                    if (this.state.selectedTarget.type === 'start') {
                        seg.start = Math.min(seg.end - 0.05, seg.start + step);
                    } else {
                        seg.end = Math.min(this.state.duration, seg.end + step);
                    }
                    changed = true;
                } else if (e.key === 'Escape' || e.key === 'Enter') {
                    this.state.selectedTarget = null;
                    changed = true;
                }

                if (changed) {
                    e.preventDefault();
                    this.drawWaveform();
                    this.renderLyricList();
                    if (e.key !== 'Escape' && e.key !== 'Enter') {
                        this.markDirtyAndScheduleSave();
                    }
                }
                return;
            }

            if (e.key === 'Enter') {
                e.preventDefault();
                this.handleTap();
            } else if (e.key === 'v' || e.key === 'V') {
                e.preventDefault();
                this.setMarker('vocalstart');
            } else if (e.key === 'm' || e.key === 'M') {
                e.preventDefault();
                // 열린 간주(끝 미지정)가 있으면 종료, 없으면 새 간주 시작
                const open = (this.state.markers.interludes || []).some((il) => il.end === null);
                this.setMarker(open ? 'ilend' : 'ilstart');
            }
        });

        // Scrollbar Interaction
        const thumb = get('waveform-scrollbar-thumb');
        const track = get('waveform-scrollbar-track');
        if (thumb && track) {
            thumb.onmousedown = (e) => {
                e.preventDefault();
                this.state.isScrolling = true;
                this.state.lastScrollX = e.clientX;
            };

            window.addEventListener('mousemove', (e) => {
                if (this.state.isScrolling && this.state.duration > 0) {
                    const rect = track.getBoundingClientRect();
                    const deltaX = e.clientX - rect.left;
                    const percent = Math.max(0, Math.min(1, deltaX / rect.width));

                    const visibleDuration = this.state.duration / this.state.zoomLevel;
                    this.state.scrollTime = Math.max(0, Math.min(this.state.duration - visibleDuration, percent * this.state.duration));
                    this.drawWaveform();
                }
            });
        }


        const bar = get('seek-bar');

        // 드래그 중 실시간 업데이트 (파형 및 시간)
        bar.addEventListener('input', (e) => {
            this.state.isSeeking = true;
            if (this.state.duration > 0) {
                this.state.currentTime = (parseFloat(e.target.value) / 100) * this.state.duration;
                this.updateTimeDisplay();
                this.drawWaveform(); // 파형에도 즉시 반영
            }
        });

        // 드래그 종료 시 탐색(Seek) 요청
        bar.addEventListener('change', async () => {
            try {
                if (this.state.duration > 0) {
                    await this.seekTo(this.state.currentTime, { keepPaused: true });
                }
            } catch (err) {
                console.error("Seek failed:", err);
            } finally {
                setTimeout(() => {
                    this.state.isSeeking = false;
                }, 100);
            }
        });
    }

    async setupBackendListeners() {
        if (!window.__TAURI__) return;

        // CRITICAL: Clean up ANY existing global listeners to prevent "Event Storms"
        // If the user navigates away and back, we must kill the old ghosts.
        if (window._alignmentUnlistenProgress) {
            const unlisten = await window._alignmentUnlistenProgress;
            unlisten();
            window._alignmentUnlistenProgress = null;
        }
        if (window._alignmentUnlistenStatus) {
            const unlisten = await window._alignmentUnlistenStatus;
            unlisten();
            window._alignmentUnlistenStatus = null;
        }

        // Now setup fresh, single listeners
        window._alignmentUnlistenProgress = listen('playback-progress', (event) => {
            // Rust struct may serialize to CamelCase or snake_case depending on serde config.
            const positionMs = event.payload.positionMs ?? event.payload.position_ms ?? 0;
            const durationMs = event.payload.durationMs ?? event.payload.duration_ms ?? 0;

            if (this.state.isSeeking) return; // Only block when user is dragging

            // Update duration only if we have a valid one
            if (durationMs > 0) {
                this.state.duration = durationMs / 1000;
            }
            this.state.currentTime = positionMs / 1000;

            this.followPlayheadIfNeeded();
            this.updateTimeDisplay();
            this.drawWaveform();
            this.syncSidebar();
        });

        window._alignmentUnlistenStatus = listen('playback-status', (event) => {
            const { status } = event.payload;
            this.state.isPlaying = (status && status.toLowerCase() === 'playing');
            this.updatePlayButton();
        });

        // 유튜브 다운로드 진행률 리스너 추가
        window._alignmentUnlistenDownload = listen('youtube-download-progress', (event) => {
            if (!this.state.isProcessing) return;
            const { percentage } = event.payload;
            const loaderText = document.getElementById('loader-text');
            const loaderProgress = document.getElementById('loader-progress');

            if (loaderText) loaderText.innerText = '유튜브 음원 다운로드 중...';
            if (loaderProgress) {
                loaderProgress.style.display = 'block';
                loaderProgress.innerText = `${Math.floor(percentage)}%`;
            }
        });
    }

    async loadAudio(path) {
        if (!path) return;

        // 같은 경로가 이미 로딩 중이면 재사용해 이중 play_track/파형 생성을 막는다.
        if (this._loadingPath === path && this._loadPromise) {
            return this._loadPromise;
        }

        const mySeq = (this.state.loadSeq = (this.state.loadSeq || 0) + 1);
        const isStale = () => mySeq !== this.state.loadSeq;

        const run = async () => {
        await this.flushAutoSaveIfNeeded();
        if (isStale()) return;

        this.state.currentPath = path;
        this.state.isProcessing = true;
        this.state.currentTime = 0;
        this.state.duration = 0;
        this.state.waveformPoints = null; // 파형 초기화
        this.clearVocalStartSuggestion();
        this.drawWaveform();

        const loader = document.getElementById('waveform-loader');
        const loaderText = document.getElementById('loader-text');
        const loaderProgress = document.getElementById('loader-progress');

        if (loader) loader.style.display = 'flex';
        if (loaderText) loaderText.innerText = '음원 불러오는 중...';
        if (loaderProgress) loaderProgress.style.display = 'none';

        // 파형은 play_track/LRC와 병렬로 시작. 이전엔 둘을 기다린 뒤에야 요청했다.
        // 로더는 파형이 끝날 때까지 유지한다(생성에 수 초 걸리는 캐시 미스 대비).
        const waveformPromise = this.invoke('get_waveform_summary', { audioPath: path })
            .then((summary) => {
                if (isStale()) return;
                console.log("[Alignment] Waveform load success:", summary ? summary.points.length : 0);
                if (summary) {
                    this.state.waveformPoints = summary.points;
                    if (!this.state.duration && summary.duration_sec) {
                        this.state.duration = summary.duration_sec;
                        this.updateTimeDisplay();
                    }
                    this.drawWaveform();
                }
            })
            .catch((e) => {
                if (isStale()) return;
                console.error("[Alignment] Waveform load failed:", e);
                showNotification('파형 로드 실패: ' + e, 'warning');
            })
            .finally(() => {
                if (isStale()) return;
                if (loader) loader.style.display = 'none';
            });

        // 음원·가사가 준비된 시점. 파형만 남았으므로 로더 문구만 바꾸고 계속 띄운다.
        const finishPlaybackUi = () => {
            if (isStale()) return;
            this.state.isProcessing = false;
            state.isLoading = false;
            import('./ui/components.js').then((ui) => {
                if (isStale()) return;
                if (ui.updateThumbnailOverlay) ui.updateThumbnailOverlay();
                if (ui.updatePlayButton) ui.updatePlayButton();
            });
            if (loaderText) loaderText.innerText = '파형 분석 중...';
            if (loaderProgress) loaderProgress.style.display = 'none';
        };

        try {
            // Keep bottom shared playback area consistent with library-selected behavior.
            const matchedIndex = (state.songLibrary || []).findIndex((song) => song.path === path);
            const matchedSong = matchedIndex >= 0 ? state.songLibrary[matchedIndex] : null;
            if (matchedSong) {
                state.currentTrack = matchedSong;
                state.selectedTrackIndex = matchedIndex;
                state.lyricTargetPath = path;
                state.isPlaying = false;
                state.isLoading = true;
                state.vocalEnabled = true;

                const elemsMod = await import('./ui/elements.js');
                if (isStale()) return;
                const elements = elemsMod.elements || {};
                if (elements.dockTitle) elements.dockTitle.textContent = matchedSong.title || '제목 정보 없음';
                if (elements.dockArtist) elements.dockArtist.textContent = matchedSong.artist || '가수 정보 없음';
                if (elements.dockThumbImg) {
                    elements.dockThumbImg.src = getThumbnailUrl(matchedSong.thumbnail, matchedSong);
                    elements.dockThumbImg.style.display = 'block';
                }
                if (elements.timeCurrent) elements.timeCurrent.textContent = '0:00';
                if (elements.timeTotal) elements.timeTotal.textContent = matchedSong.duration || '--:--';
                if (elements.playbackBar) elements.playbackBar.value = 0;
                if (elements.progressFill) elements.progressFill.style.width = '0%';

                const ui = await import('./ui/components.js');
                if (isStale()) return;
                if (ui.updateThumbnailOverlay) ui.updateThumbnailOverlay();
                if (ui.updateAiTogglesState) ui.updateAiTogglesState(matchedSong);
                if (ui.updatePlayButton) ui.updatePlayButton();

                // In lyric sync workflow, always monitor with vocals enabled.
                const audio = await import('./audio.js');
                if (isStale()) return;
                if (audio.toggleAiFeature) {
                    await audio.toggleAiFeature("vocal", true);
                }
                if (isStale()) return;
            }

            console.log("[Alignment] Loading audio:", path);
            // Get duration immediately from backend
            const ms = await this.invoke('play_track', { path, durationMs: 0, playNow: false });
            if (isStale()) return;
            console.log("[Alignment] play_track success, duration:", ms);
            this.state.duration = ms / 1000;
            this.updateTimeDisplay();

            // 가사 데이터 초기화
            this.state.segments = [];
            this.state.currentSyncIndex = 0;
            this.state.isSyncMode = false;
            this.state.tripletMode = false;
            const tripletToggleReset = document.getElementById('triplet-mode-toggle');
            if (tripletToggleReset) tripletToggleReset.checked = false;
            this.updateLyricsPlaceholder();
            const inputElement = document.getElementById('lyrics-input');
            if (inputElement) inputElement.value = '';
            this.renderLyricList();
            this.isDirty = false;
            this.updateSaveStatus('저장됨');

            // Try to load existing LRC file
            this.state.markers = { vocalStartSec: null, interludes: [] };
            try {
                const lrcContent = await this.invoke('load_lrc_file', { audioPath: path });
                if (isStale()) return;
                if (lrcContent && lrcContent.trim()) {
                    this.state.markers = parseMarkers(lrcContent);

                    const parsedSegments = parseLrc(lrcContent, this.state.duration);
                    // Clean up imported lyrics: remove meaningless blank lines and trim noisy spacing.
                    const normalizedSegments = parsedSegments
                        .map((seg) => {
                            const cleanText = (seg.text || '').replace(/\s+/g, ' ').trim();
                            if (isTriplet(seg)) {
                                return {
                                    ...seg,
                                    text: cleanText,
                                    original: cleanText,
                                    pronunciation: (seg.pronunciation || '').replace(/\s+/g, ' ').trim(),
                                    translation: (seg.translation || '').replace(/\s+/g, ' ').trim(),
                                };
                            }
                            return { ...seg, text: cleanText };
                        })
                        .filter((seg) => seg.text.length > 0);

                    this.state.segments = normalizedSegments;

                    // 저장된 파일에 3줄 큐가 있으면 트리플렛 모드를 자동으로 켠다.
                    this.state.tripletMode = normalizedSegments.some((seg) => isTriplet(seg));
                    const tripletToggleEl = document.getElementById('triplet-mode-toggle');
                    if (tripletToggleEl) tripletToggleEl.checked = this.state.tripletMode;
                    this.updateLyricsPlaceholder();

                    const rawLyrics = [];
                    this.state.segments.forEach((s) => {
                        if (isTriplet(s)) {
                            rawLyrics.push(s.original || '', s.pronunciation || '', s.translation || '');
                        } else {
                            rawLyrics.push(s.text);
                        }
                    });
                    if (inputElement) inputElement.value = rawLyrics.join('\n');

                    let nextIdx = this.state.segments.findIndex(s => s.start === 0);
                    if (nextIdx === -1) nextIdx = this.state.segments.length;
                    this.state.currentSyncIndex = nextIdx;

                    this.state.isSyncMode = true;
                    this.renderLyricList();
                    this.isDirty = false;
                    this.updateSaveStatus('저장됨');
                }
            } catch (err) {
                console.log("[Alignment] LRC load failed or not found:", err);
            }
            this.renderMarkerList();
            this.clearVocalStartSuggestion();
            this.updateAiAlignButtonState();

            if (isStale()) return;
            this.drawWaveform();

            // play_track + LRC가 끝난 시점. 로더는 파형이 끝날 때까지 남는다.
            finishPlaybackUi();
            await waveformPromise;

        } catch (e) {
            if (isStale()) return;
            console.error("[Alignment] loadAudio general failure:", e);
            finishPlaybackUi();
            showNotification('오디오 로드 실패: ' + e, 'error');
            await waveformPromise;
        }
        };

        this._loadingPath = path;
        this._loadPromise = run().finally(() => {
            if (this._loadingPath === path) {
                this._loadingPath = null;
                this._loadPromise = null;
            }
        });
        return this._loadPromise;
    }

    /** 확대 상태에서 재생 위치 선이 화면 중앙에 오도록 scrollTime을 연속 추적. */
    followPlayheadIfNeeded() {
        if (!this.state.followPlayhead || !this.state.isPlaying) return;
        if (this.state.zoomLevel <= 1.01 || this.state.duration <= 0) return;
        if (this.state.isPanning || this.state.isScrolling || this.state.isSeeking) return;
        const visibleDuration = this.state.duration / this.state.zoomLevel;
        const maxScroll = Math.max(0, this.state.duration - visibleDuration);
        const centered = this.state.currentTime - visibleDuration / 2;
        this.state.scrollTime = Math.max(0, Math.min(maxScroll, centered));
    }

    updateTimeDisplay() {
        const bar = document.getElementById('seek-bar');
        const display = document.getElementById('time-display');
        if (bar && !this.state.isSeeking) {
            bar.value = this.state.duration > 0 ? (this.state.currentTime / this.state.duration) * 100 : 0;
        }
        if (display) {
            display.innerText = `${this.formatTime(this.state.currentTime)} / ${this.formatTime(this.state.duration)}`;
        }
        this.drawWaveform();
    }

    /** `keepPaused`를 주면 정지 상태에서 탐색해도 재생이 시작되지 않는다
     *  (파형을 눌러 마커 위치를 잡는 동안 곡이 계속 튀어나오던 문제). */
    async seekTo(time, { keepPaused = false } = {}) {
        if (!this.state.currentPath || this.state.duration <= 0) return;

        this.state.currentTime = Math.max(0, Math.min(this.state.duration, time));
        this.updateTimeDisplay();

        try {
            // Seek 중 백엔드의 이전 재생 위치 이벤트에 의해 UI가 튕기는 것을 방지
            this.state.isSeeking = true;
            if (this._seekTimeout) clearTimeout(this._seekTimeout);

            await this.invoke('seek_to', {
                positionMs: Math.floor(this.state.currentTime * 1000),
                resume: keepPaused ? this.state.isPlaying : true
            });
        } catch (err) {
            console.error("[Alignment] seekTo error:", err);
        } finally {
            // 연속 클릭 시 타이머 초기화 및 백엔드 지연 고려하여 400ms로 설정
            this._seekTimeout = setTimeout(() => { this.state.isSeeking = false; }, 400);
        }
    }

    timeToX(time) {
        if (!this.canvas || this.state.duration <= 0) return 0;
        const visibleDuration = this.state.duration / this.state.zoomLevel;
        return ((time - this.state.scrollTime) / visibleDuration) * this.canvas.width;
    }

    xToTime(x) {
        if (!this.canvas || this.state.duration <= 0) return 0;
        const visibleDuration = this.state.duration / this.state.zoomLevel;
        return (x / this.canvas.width) * visibleDuration + this.state.scrollTime;
    }

    updateScrollbar() {
        const thumb = document.getElementById('waveform-scrollbar-thumb');
        if (!thumb || this.state.duration <= 0) return;

        const thumbWidth = (1 / this.state.zoomLevel) * 100;
        const thumbLeft = (this.state.scrollTime / this.state.duration) * 100;

        thumb.style.width = `${Math.max(thumbWidth, 2)}%`;
        thumb.style.left = `${thumbLeft}%`;
    }

    updatePlayButton() {
        const btn = document.getElementById('play-btn');
        if (!btn) return;
        btn.innerHTML = this.state.isPlaying
            ? '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>'
            : '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
    }

    drawWaveform() {
        if (!this.ctx || !this.canvas) return;
        const { width, height } = this.canvas;
        this.ctx.clearRect(0, 0, width, height);

        if (this.state.duration <= 0) return;

        const rootStyle = getComputedStyle(document.documentElement);
        const cssVar = (name, fallback) => {
            const v = rootStyle.getPropertyValue(name).trim();
            return v || fallback;
        };
        const palette = {
            // Task/segment box colors should follow active app theme tokens.
            segmentFillActive: cssVar('--align-item-active-bg', 'rgba(74, 158, 255, 0.3)'),
            segmentFillIdle: cssVar('--align-item-bg', 'rgba(74, 158, 255, 0.1)'),
            segmentBorder: cssVar('--align-item-border', 'rgba(74, 158, 255, 0.3)'),
            segmentHover: cssVar('--align-item-hover-border', '#4a9eff'),
            waveformStroke: cssVar('--align-track-placeholder', 'rgba(255,255,255,0.2)'),
            selectedBoundary: cssVar('--warn-strong', '#fbbf24'),
        };

        this.updateScrollbar();

        const visibleDuration = this.state.duration / this.state.zoomLevel;
        const startTime = this.state.scrollTime;
        const endTime = startTime + visibleDuration;

        // 1. Segments
        this.state.segments.forEach((seg, idx) => {
            if (seg.end < startTime || seg.start > endTime) return;
            const x1 = this.timeToX(seg.start);
            const x2 = this.timeToX(seg.end);

            // Fill background
            this.ctx.fillStyle = (idx === this.state.currentSyncIndex - 1) ? palette.segmentFillActive : palette.segmentFillIdle;
            this.ctx.fillRect(Math.max(0, x1), 0, Math.min(width, x2) - Math.max(0, x1), height);

            // Default subtle boundary lines
            this.ctx.strokeStyle = palette.segmentBorder;
            this.ctx.lineWidth = 1;
            [x1, x2].forEach(bx => {
                if (bx >= 0 && bx <= width) {
                    this.ctx.beginPath();
                    this.ctx.moveTo(bx, 0);
                    this.ctx.lineTo(bx, height);
                    this.ctx.stroke();
                }
            });

            // Boundary Highlighting (on hover)
            const ht = this.state.hoveringTarget;
            if (ht && ht.index === idx) {
                this.ctx.strokeStyle = palette.segmentHover;
                this.ctx.lineWidth = 2;
                const bx = ht.type === 'start' ? x1 : x2;
                this.ctx.beginPath();
                this.ctx.moveTo(bx, 0);
                this.ctx.lineTo(bx, height);
                this.ctx.stroke();
            }

            // Selected Boundary Highlight (Amber, theme-aware)
            const st = this.state.selectedTarget;
            if (st && st.index === idx) {
                this.ctx.strokeStyle = palette.selectedBoundary;
                this.ctx.lineWidth = 3;
                const bx = st.type === 'start' ? x1 : x2;
                this.ctx.beginPath();
                this.ctx.moveTo(bx, 0);
                this.ctx.lineTo(bx, height);
                this.ctx.stroke();

                // Show timestamp tooltip-like text
                this.ctx.fillStyle = palette.selectedBoundary;
                this.ctx.font = 'bold 12px Inter';
                const timeStr = (st.type === 'start' ? seg.start : seg.end).toFixed(2) + 's';
                this.ctx.fillText(timeStr, bx + 5, 20);
            }
        });

        // 2. Waveform
        if (this.state.waveformPoints) {
            this.ctx.beginPath();
            this.ctx.strokeStyle = palette.waveformStroke;
            const points = this.state.waveformPoints;
            for (let i = 0; i < width; i++) {
                const targetTime = this.xToTime(i);
                const idx = Math.floor((targetTime / this.state.duration) * points.length);
                if (idx >= 0 && idx < points.length) {
                    const p = points[idx];
                    if (p) {
                        this.ctx.moveTo(i, (1 + p[0] * 0.8) * height / 2);
                        this.ctx.lineTo(i, (1 + p[1] * 0.8) * height / 2);
                    }
                }
            }
            this.ctx.stroke();
        }

        // 3. Playhead
        if (this.state.currentTime >= startTime && this.state.currentTime <= endTime) {
            const px = this.timeToX(this.state.currentTime);
            this.ctx.strokeStyle = '#ef4444';
            this.ctx.lineWidth = 2;
            this.ctx.beginPath();
            this.ctx.moveTo(px, 0);
            this.ctx.lineTo(px, height);
            this.ctx.stroke();
        }
    }

    handleZoom(factor, mouseX = null) {
        if (this.state.duration <= 0) return;

        const oldZoom = this.state.zoomLevel;
        const newZoom = Math.max(1, Math.min(200, oldZoom * factor));
        if (oldZoom === newZoom) return;

        const focusX = mouseX !== null ? mouseX : this.canvas.width / 2;
        const focusTime = this.xToTime(focusX);

        this.state.zoomLevel = newZoom;
        const newVisibleDuration = this.state.duration / newZoom;
        let newScrollTime = focusTime - (focusX / this.canvas.width) * newVisibleDuration;

        this.state.scrollTime = Math.max(0, Math.min(this.state.duration - newVisibleDuration, newScrollTime));
        this.drawWaveform();
    }

    // --- Helpers & Others ---

    async loadTrackList() {
        try {
            // 이제 분리된 오디오 목록 대신 라이브러리의 전체 원본 음원을 불러옵니다.
            this.tracks = state.songLibrary || [];

            // If currently selected track is in the list, update its display
            if (this.state.currentPath) {
                const track = this.tracks.find(t => t.path === this.state.currentPath);
                if (track) {
                    const nameEl = document.getElementById('selected-track-name');
                    if (nameEl) nameEl.innerText = track.title || "Unknown Title";
                }
            }
        } catch (e) { console.error(e); }
    }

    openTrackModal() {
        const modal = document.getElementById('alignment-track-modal');
        if (modal) {
            modal.classList.add('active');
            document.getElementById('alignment-track-search').value = '';
            this.loadTrackList(); // 모달을 열 때마다 메인 라이브러리의 최신 목록으로 갱신
            this.renderTrackList();
            setTimeout(() => document.getElementById('alignment-track-search').focus(), 100);
        }
    }

    closeTrackModal() {
        const modal = document.getElementById('alignment-track-modal');
        if (modal) modal.classList.remove('active');
    }

    renderTrackList(query = '') {
        const container = document.getElementById('alignment-track-list');
        if (!container) return;

        const statusFilter = this.trackFilterStatus || 'all';
        const filtered = this.tracks ? this.tracks.filter(t => {
            const searchStr = `${t.title || ''} ${t.artist || ''}`.toLowerCase();
            const matchesQuery = !query || searchStr.includes(query.toLowerCase());
            const matchesStatus = statusFilter === 'all' || getLyricSyncStatus(t) === statusFilter;
            return matchesQuery && matchesStatus;
        }) : [];

        if (filtered.length === 0) {
            container.innerHTML = `<div style="text-align:center; padding:20px; color:#64748b;">음원이 없습니다.</div>`;
            return;
        }

        const collapsed = this.getTrackGroupCollapsed();

        const renderItem = (t) => {
            const title = escapeHtml(t.title || 'Unknown Title');
            const artist = escapeHtml(t.artist || 'Unknown Artist');
            const path = escapeHtml(t.path || '');
            const syncStatus = getLyricSyncStatus(t);
            const thumbUrl = escapeHtml(getThumbnailUrl(t.thumbnail || '', t));
            const isCurrent = t.path === this.state.currentPath;

            return `
                <div class="track-item${isCurrent ? ' is-current' : ''}" data-path="${path}">
                    <div class="track-thumb">
                        ${thumbUrl ? `<img src="${thumbUrl}" alt="">` : `<div class="thumb-placeholder">♪</div>`}
                    </div>
                    <div class="track-info">
                        <div class="track-name" title="${title}">${title}</div>
                        <div class="track-artist" title="${artist}">${artist}</div>
                    </div>
                    <span class="sync-status-badge sync-status-${syncStatus}">${SYNC_STATUS_LABEL[syncStatus] || syncStatus}</span>
                </div>
            `;
        };

        if (statusFilter === 'all') {
            const groups = [
                { key: 'unsynced', label: '미싱크' },
                { key: 'synced', label: '싱크 완료' },
                { key: 'none', label: '가사 없음' },
            ];
            container.innerHTML = groups.map(({ key, label }) => {
                const items = filtered.filter((t) => getLyricSyncStatus(t) === key);
                if (items.length === 0) return '';
                const isCollapsed = !!collapsed[key];
                return `
                    <div class="track-group" data-group="${key}">
                        <button type="button" class="track-group-header${isCollapsed ? ' is-collapsed' : ''}" data-group="${key}">
                            <span class="track-group-chevron" aria-hidden="true">${isCollapsed ? '▸' : '▾'}</span>
                            <span>${label}</span>
                            <span class="track-group-count">${items.length}</span>
                        </button>
                        <div class="track-group-body"${isCollapsed ? ' hidden' : ''}>
                            ${items.map(renderItem).join('')}
                        </div>
                    </div>
                `;
            }).join('');

            container.querySelectorAll('.track-group-header').forEach((header) => {
                header.onclick = (e) => {
                    e.preventDefault();
                    const key = header.dataset.group;
                    const next = this.getTrackGroupCollapsed();
                    next[key] = !next[key];
                    this.setTrackGroupCollapsed(next);
                    this.renderTrackList(query);
                };
            });
        } else {
            container.innerHTML = filtered.map(renderItem).join('');
        }

        container.querySelectorAll('.track-item').forEach(item => {
            item.onclick = () => {
                const path = item.getAttribute('data-path');
                const name = item.querySelector('.track-name').innerText;
                document.getElementById('selected-track-name').innerText = name;
                this.loadAudio(path);
                this.closeTrackModal();
            };
        });
    }

    getTrackGroupCollapsed() {
        try {
            return JSON.parse(localStorage.getItem(TRACK_GROUP_COLLAPSED_KEY) || '{}') || {};
        } catch (_) {
            return {};
        }
    }

    setTrackGroupCollapsed(map) {
        localStorage.setItem(TRACK_GROUP_COLLAPSED_KEY, JSON.stringify(map || {}));
    }

    togglePlayback() { this.invoke('toggle_playback'); }

    formatTime(sec) {
        if (sec === undefined || sec === null || isNaN(sec)) return "--:--.-";
        const m = Math.floor(Math.abs(sec) / 60);
        const s = (Math.abs(sec) % 60).toFixed(1);
        return `${m.toString().padStart(2, '0')}:${s.padStart(4, '0')}`;
    }

    resize() {
        if (!this.canvas) return;
        const rect = this.canvas.parentElement.getBoundingClientRect();
        this.canvas.width = rect.width;
        this.canvas.height = rect.height;
        this.drawWaveform();
    }

    // Removed parseLrcString as it is now handled by centralized lyrics.js utility

    updateLyricsPlaceholder() {
        const input = document.getElementById('lyrics-input');
        if (!input) return;
        input.placeholder = this.state.tripletMode
            ? '원문\n차음(발음)\n번역\n원문\n차음\n번역\n… (3줄 1세트)'
            : '가사를 입력하세요...';
    }

    escapeHtml(s) {
        return String(s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    parseLyrics() {
        const rawLyrics = (document.getElementById('lyrics-input').value || '').replace(/\r\n/g, '\n');
        const lines = rawLyrics.split('\n');
        const hasAnyText = lines.some(l => l.trim().length > 0);

        if (!hasAnyText) {
            this.state.segments = [];
            this.state.currentSyncIndex = 0;
            this.renderLyricList();
            this.markDirtyAndScheduleSave();
            return;
        }

        const oldSegments = this.state.segments || [];
        // Ignore meaningless blank lines from pasted/original lyric text.
        const newLines = lines
            .map((line) => line.trim())
            .filter((line) => line.length > 0);

        // 3줄 모드: 원문/차음/번역이 3줄 1세트로 반복되는 가사를 하나의 큐로 묶음.
        // 3의 배수가 아니면 마지막 불완전 세트는 있는 줄만 채우고 관대하게 처리.
        let newCues;
        if (this.state.tripletMode) {
            newCues = [];
            for (let i = 0; i < newLines.length; i += 3) {
                const original = newLines[i] || '';
                if (!original) continue;
                newCues.push({
                    text: original,
                    original,
                    pronunciation: newLines[i + 1] || '',
                    translation: newLines[i + 2] || '',
                });
            }
        } else {
            newCues = newLines.map((text) => ({ text }));
        }

        // 트리플렛은 원문(original) 기준으로, 일반 줄은 text 기준으로 동일 여부 판단.
        const sameIdentity = (a, b) => {
            if (isTriplet(a) || isTriplet(b)) {
                return isTriplet(a) && isTriplet(b) && a.original === b.original;
            }
            return a.text === b.text;
        };

        const newSegments = newCues.map((cue) => {
            // 1순위: 동일한 기존 큐를 찾아 시간 복사
            const exactMatch = oldSegments.find(s => sameIdentity(cue, s) && !s._used);
            if (exactMatch) {
                exactMatch._used = true;
                return { ...cue, start: exactMatch.start, end: exactMatch.end };
            }
            return { ...cue, start: 0, end: 0 };
        });

        // 2순위: 텍스트가 수정되었으나 같은 줄 번호(인덱스)에 있던 시간 복사 (오타 수정 대응)
        newSegments.forEach((seg, i) => {
            if (seg.start === 0 && oldSegments[i] && !oldSegments[i]._used) {
                seg.start = oldSegments[i].start;
                seg.end = oldSegments[i].end;
                oldSegments[i]._used = true;
            }
        });

        // 임시 플래그 정리
        oldSegments.forEach(s => delete s._used);

        this.state.segments = newSegments;
        this.state.isSyncMode = true;

        // 싱크 인덱스가 초기값이면 0으로 설정
        if (this.state.currentSyncIndex < 0) {
            this.state.currentSyncIndex = 0;
        }
        // 이미 탭이 진행된 상태라면 싱크 인덱스 유지 보정
        else if (this.state.currentSyncIndex > this.state.segments.length) {
            this.state.currentSyncIndex = this.state.segments.length;
        }

        this.renderLyricList();
        this.markDirtyAndScheduleSave();
    }

    handleTap() {
        // 일시정지 상태에서도 수동으로 찍을 수 있도록 허용 (단, 음원은 로드되어 있어야 함)
        if (this.state.duration <= 0) return;
        let idx = this.state.currentSyncIndex;
        while (idx < this.state.segments.length && !(this.state.segments[idx].text || '').trim()) {
            idx++;
        }
        this.state.currentSyncIndex = idx;
        if (idx < 0 || idx >= this.state.segments.length) return;

        this.state.segments[idx].start = this.state.currentTime;
        if (idx > 0 && this.state.segments[idx - 1].start > 0) {
            // If the previous segment has a valid start time, set its end time
            this.state.segments[idx - 1].end = this.state.currentTime;
        }
        this.state.segments[idx].end = this.state.duration;
        this.state.currentSyncIndex++;
        this.renderLyricList();
        this.markDirtyAndScheduleSave();
    }

    /** 현재 재생 위치를 보컬 시작/간주 시작/간주 종료 마커로 지정.
     *  간주는 시작-종료를 각각 눌러 쌓고, 등록 순서대로 짝지어진다(오래된
     *  미짝 ilstart가 남아있으면 이번 ilend와 짝지음). */
    setMarker(tag) {
        if (this.state.duration <= 0) {
            showNotification('음원을 먼저 불러오세요.', 'warning');
            return;
        }
        const t = this.state.currentTime;
        const m = this.state.markers;
        if (tag === 'vocalstart') {
            m.vocalStartSec = t;
            this.clearVocalStartSuggestion();
        } else if (tag === 'ilstart') {
            m.interludes.push({ start: t, end: null });
        } else if (tag === 'ilend') {
            const open = [...m.interludes].reverse().find((il) => il.end === null);
            if (open) {
                open.end = t;
            } else {
                m.interludes.push({ start: Math.max(0, t - 0.01), end: t });
            }
        }
        this.onMarkersChanged();
        this.markDirtyAndScheduleSave();
    }

    removeMarker(tag, index = 0) {
        if (tag === 'vocalstart') {
            this.state.markers.vocalStartSec = null;
        } else if (tag === 'interlude') {
            this.state.markers.interludes.splice(index, 1);
        }
        this.onMarkersChanged();
        this.markDirtyAndScheduleSave();
    }

    onMarkersChanged() {
        this.renderMarkerList();
        this.drawWaveform();
    }

    renderMarkerList() {
        const el = document.getElementById('marker-list-panel');
        if (!el) return;
        const m = this.state.markers || { vocalStartSec: null, interludes: [] };
        const rows = [];

        if (typeof m.vocalStartSec === 'number') {
            rows.push({
                kind: 'vocalstart',
                index: 0,
                badge: '1',
                label: '보컬 시작',
                start: m.vocalStartSec,
                end: null,
            });
        }

        (m.interludes || []).forEach((il, i) => {
            rows.push({
                kind: 'interlude',
                index: i,
                badge: String(rows.length + 1),
                label: typeof il.end === 'number' ? '간주' : '간주 (미완료)',
                start: il.start,
                end: il.end,
            });
        });

        if (rows.length === 0) {
            el.innerHTML = `<div class="marker-list-empty">마커 없음</div>`;
            return;
        }

        el.innerHTML = rows.map((row) => {
            const endInput = row.kind === 'interlude'
                ? `<input class="marker-time-input" data-field="end" data-kind="${row.kind}" data-index="${row.index}" value="${typeof row.end === 'number' ? formatTimeInput(row.end) : ''}" placeholder="끝" title="끝 시각 (mm:ss.xx)">`
                : '';
            return `
                <div class="marker-list-row" data-kind="${row.kind}" data-index="${row.index}" title="클릭하면 해당 위치로 이동·확대">
                    <span class="marker-list-badge">${row.badge}</span>
                    <span class="marker-list-label">${row.label}</span>
                    <input class="marker-time-input" data-field="start" data-kind="${row.kind}" data-index="${row.index}" value="${formatTimeInput(row.start)}" title="시작 시각 (mm:ss.xx)">
                    ${endInput}
                    <button type="button" class="marker-list-delete" data-kind="${row.kind}" data-index="${row.index}" title="삭제">×</button>
                </div>
            `;
        }).join('');

        el.querySelectorAll('.marker-list-row').forEach((rowEl) => {
            rowEl.onclick = (e) => {
                if (e.target.closest('.marker-time-input') || e.target.closest('.marker-list-delete')) return;
                const kind = rowEl.dataset.kind;
                const index = Number(rowEl.dataset.index);
                this.focusMarkerOnWaveform(kind, index);
            };
        });

        el.querySelectorAll('.marker-list-delete').forEach((btn) => {
            btn.onclick = (e) => {
                e.stopPropagation();
                this.removeMarker(btn.dataset.kind, Number(btn.dataset.index));
            };
        });

        el.querySelectorAll('.marker-time-input').forEach((input) => {
            input.onclick = (e) => e.stopPropagation();
            input.onkeydown = (e) => e.stopPropagation();
            input.onchange = () => this.commitMarkerTimeEdit(input);
            input.onblur = () => this.commitMarkerTimeEdit(input);
        });
    }

    commitMarkerTimeEdit(input) {
        const kind = input.dataset.kind;
        const index = Number(input.dataset.index);
        const field = input.dataset.field;
        const parsed = parseTimeInput(input.value);
        const m = this.state.markers;
        const clamp = (sec) => Math.max(0, this.state.duration > 0 ? Math.min(this.state.duration, sec) : sec);

        if (parsed === null) {
            // 무효 입력은 원값 복원
            if (kind === 'vocalstart') {
                input.value = formatTimeInput(m.vocalStartSec);
            } else if (kind === 'interlude' && m.interludes[index]) {
                const il = m.interludes[index];
                input.value = field === 'end'
                    ? (typeof il.end === 'number' ? formatTimeInput(il.end) : '')
                    : formatTimeInput(il.start);
            }
            return;
        }

        const sec = clamp(parsed);
        if (kind === 'vocalstart') {
            m.vocalStartSec = sec;
            this.clearVocalStartSuggestion();
        } else if (kind === 'interlude' && m.interludes[index]) {
            const il = m.interludes[index];
            if (field === 'start') {
                il.start = sec;
                if (typeof il.end === 'number' && il.end <= il.start) {
                    il.end = Math.min(this.state.duration || il.start + 0.01, il.start + 0.01);
                }
            } else {
                il.end = Math.max(il.start + 0.01, sec);
            }
            m.interludes.sort((a, b) => (a.start || 0) - (b.start || 0));
        }
        this.onMarkersChanged();
        this.markDirtyAndScheduleSave();
    }

    /** 마커 구간이 화면 절반을 차지하도록 줌·스크롤 후 해당 시각으로 이동. */
    focusMarkerOnWaveform(kind, index) {
        const m = this.state.markers;
        let start = null;
        let end = null;
        if (kind === 'vocalstart' && typeof m.vocalStartSec === 'number') {
            start = m.vocalStartSec;
            end = m.vocalStartSec + 1;
        } else if (kind === 'interlude' && m.interludes[index]) {
            const il = m.interludes[index];
            start = il.start;
            end = typeof il.end === 'number' ? il.end : il.start + 1;
        }
        if (typeof start !== 'number' || this.state.duration <= 0) return;

        const span = Math.max(0.5, end - start);
        const targetVisible = Math.min(this.state.duration, Math.max(span * 2, this.state.duration / 8));
        this.state.zoomLevel = Math.max(1, this.state.duration / targetVisible);
        const visibleDuration = this.state.duration / this.state.zoomLevel;
        const maxScroll = Math.max(0, this.state.duration - visibleDuration);
        this.state.scrollTime = Math.max(0, Math.min(maxScroll, start - visibleDuration * 0.25));
        this.seekTo(start, { keepPaused: true });
        this.drawWaveform();
    }

    offerVocalStartSuggestion(source = 'ai') {
        if (typeof this.state.markers.vocalStartSec === 'number') return;
        // AI 제안이 있으면 파형 폴백이 덮어쓰지 않는다.
        if (this.state.suggestedVocalStartSource === 'ai' && source !== 'ai') return;
        const suggested = suggestVocalStartFromSegments(this.state.segments);
        if (suggested === null) return;
        this.state.suggestedVocalStartSec = suggested;
        this.state.suggestedVocalStartSource = source;
        this.renderVocalStartSuggestion();
    }

    acceptVocalStartSuggestion() {
        if (typeof this.state.suggestedVocalStartSec !== 'number') return;
        this.state.markers.vocalStartSec = this.state.suggestedVocalStartSec;
        this.clearVocalStartSuggestion();
        this.onMarkersChanged();
        this.markDirtyAndScheduleSave();
        showNotification('보컬 시작 지점을 적용했습니다.', 'success');
    }

    clearVocalStartSuggestion() {
        this.state.suggestedVocalStartSec = null;
        this.state.suggestedVocalStartSource = null;
        this.renderVocalStartSuggestion();
    }

    renderVocalStartSuggestion() {
        const bar = document.getElementById('vocal-start-suggestion');
        const label = document.getElementById('vocal-start-suggestion-label');
        if (!bar || !label) return;
        const sec = this.state.suggestedVocalStartSec;
        if (typeof sec !== 'number') {
            bar.hidden = true;
            return;
        }
        const sourceLabel = this.state.suggestedVocalStartSource === 'ai'
            ? 'AI 감지: 노래 시작'
            : '자동 감지: 보컬 시작';
        label.textContent = `${sourceLabel} ${formatTimeInput(sec)}`;
        bar.hidden = false;
    }

    /**
     * BPM 그리드 기반 대략 배치. 이미 싱크된 줄(start>0)과 간주 구간 안에
     * 놓이는 위치는 건드리지 않는다 - 각 미싱크 줄을 순서대로 다음 사용
     * 가능한 박자 칸(60/BPM초 간격, 첫 온셋을 그리드 원점으로)에 배정하고,
     * 그 칸이 간주 구간과 겹치면 간주 뒤로 넘겨서 계속 진행한다. 정밀한
     * 정렬이 아니라 "대충 훑고 지나가며 수동 보정을 줄이는" 용도.
     */
    async runBpmGridPlacement() {
        if (!this.state.currentPath) {
            showNotification('음원을 먼저 선택하세요.', 'warning');
            return;
        }
        const unsyncedCount = this.state.segments.filter((s) => s.start === 0 && (s.text || '').trim()).length;
        if (unsyncedCount === 0) {
            showNotification('배치할 미싱크 가사가 없습니다.', 'info');
            return;
        }
        const btn = document.getElementById('bpm-grid-btn');
        const song = (state.songLibrary || []).find((s) => s.path === this.state.currentPath);
        const knownBpm = Number(song?.bpm);
        const hasKnownBpm = Number.isFinite(knownBpm) && knownBpm > 0;

        if (btn) {
            btn.disabled = true;
            btn.textContent = hasKnownBpm ? '그리드 배치 중...' : 'BPM 분석 중...';
        }
        try {
            let bpm = knownBpm;
            let gridOrigin = typeof this.state.markers.vocalStartSec === 'number'
                ? this.state.markers.vocalStartSec
                : 0;

            // 라이브러리에 BPM이 이미 있으면 분석 단계를 건너뛴다.
            if (!hasKnownBpm) {
                const analysis = await this.invoke('analyze_key_bpm', { path: this.state.currentPath });
                if (!analysis || !analysis.bpm || analysis.bpm <= 0) {
                    showNotification('BPM을 분석하지 못했습니다.', 'error');
                    return;
                }
                bpm = analysis.bpm;
                if (typeof analysis.first_onset_sec === 'number') {
                    gridOrigin = analysis.first_onset_sec;
                }
            }

            const beatSec = 60 / bpm;
            const interludes = (this.state.markers.interludes || [])
                .filter((il) => typeof il.start === 'number' && typeof il.end === 'number')
                .sort((a, b) => a.start - b.start);

            const inInterlude = (t) => interludes.find((il) => t >= il.start && t < il.end);

            // 이미 싱크된 줄이 점유한 시간을 피해서, 다음으로 비어있는 그리드 칸을 찾는다.
            const occupied = this.state.segments
                .filter((s) => s.start > 0)
                .map((s) => s.start)
                .sort((a, b) => a - b);

            let cursor = gridOrigin;
            const isOccupied = (t) => occupied.some((o) => Math.abs(o - t) < beatSec * 0.5);

            let placedCount = 0;
            this.state.segments.forEach((seg) => {
                if (seg.start > 0 || !(seg.text || '').trim()) return; // 이미 싱크됨 - 보존
                // 그리드 칸을 하나씩 전진하며 점유/간주 구간을 건너뜀.
                for (let guard = 0; guard < 10000; guard++) {
                    const il = inInterlude(cursor);
                    if (il) {
                        cursor = il.end;
                        continue;
                    }
                    if (isOccupied(cursor) || cursor >= this.state.duration) {
                        cursor += beatSec;
                        continue;
                    }
                    break;
                }
                seg.start = cursor;
                seg.approx = true;
                placedCount++;
                cursor += beatSec;
            });

            // end 재계산 (마지막 줄만 duration까지, 나머지는 다음 줄 시작까지).
            for (let i = 0; i < this.state.segments.length - 1; i++) {
                if (this.state.segments[i].start > 0 && this.state.segments[i + 1].start > 0) {
                    this.state.segments[i].end = this.state.segments[i + 1].start;
                }
            }
            if (this.state.segments.length > 0) {
                const last = this.state.segments[this.state.segments.length - 1];
                if (last.start > 0) last.end = this.state.duration > 0 ? this.state.duration : last.start + beatSec;
            }

            // 보컬 시작 마커가 아직 없으면 제안만 띄운다(원클릭 적용).
            // AI 제안이 이미 있으면 파형/그리드 폴백이 덮지 않는다.
            this.offerVocalStartSuggestion('waveform');

            this.renderLyricList();
            this.renderMarkerList();
            this.markDirtyAndScheduleSave();
            const bpmLabel = Number.isInteger(bpm) ? String(bpm) : bpm.toFixed(1);
            showNotification(`BPM ${bpmLabel} 그리드로 ${placedCount}줄 대략 배치했습니다. 필요한 부분만 수동 보정하세요.`, 'success');
        } catch (err) {
            console.error('[Alignment] BPM grid placement failed:', err);
            showNotification('BPM 그리드 배치 실패: ' + err, 'error');
        } finally {
            if (btn) { btn.disabled = false; btn.textContent = 'BPM 그리드 배치'; }
        }
    }

    /**
     * Wires this editor into the headless batch queue (`alignment-queue.js`,
     * Phase C) so the interactive "AI 자동 정렬" button and multi-select
     * batch runs share one code path and one backend serialization lock.
     * The queue-changed event keeps this button's busy/label state in sync
     * even when the running item was queued from elsewhere; the completion
     * callback merges results into the segments already open in the editor
     * (in-memory) without requiring the user to reselect the track.
     */
    setupAlignmentQueueIntegration() {
        window.addEventListener('alignment-queue-changed', () => this.updateAiAlignButtonState());
        import('./alignment-queue.js').then((m) => {
            if (m.onAlignmentItemComplete) {
                m.onAlignmentItemComplete((path, lines) => this.onQueueAlignmentDone(path, lines));
            }
        }).catch((err) => console.error('[Alignment] Failed to attach queue listener:', err));
    }

    /** Reflects the current track's alignment-queue status (if any) onto the
     *  "AI 자동 정렬" button - disabled + progress label while queued/processing,
     *  idle otherwise. Safe to call anytime (no-ops without a loaded track). */
    updateAiAlignButtonState() {
        const btn = document.getElementById('ai-align-btn');
        const cancelBtn = document.getElementById('ai-align-cancel-btn');
        if (!btn) return;
        const item = (state.alignmentQueue || []).find((i) => i.path === this.state.currentPath);
        const busy = !!item && (item.status === 'queued' || item.status === 'processing');
        btn.disabled = busy || !this.state.currentPath;
        const label = busy
            ? (item.status === 'queued' ? '대기열 등록됨' : `AI 정렬 중... (${Math.floor(item.percentage || 0)}%)`)
            : 'AI 자동 정렬';
        const labelEl = btn.querySelector('.tap-label');
        if (labelEl) labelEl.textContent = label;
        else btn.textContent = label;
        if (cancelBtn) cancelBtn.style.display = busy ? 'inline-flex' : 'none';
    }

    /** 뷰어의 정렬 언어 드롭다운 표시를 저장된 선택값에 맞춘다. */
    async syncAlignLanguageUI() {
        const wrap = document.getElementById('align-viewer-language-select');
        if (!wrap) return;
        const { getAlignmentLanguage, ALIGNMENT_LANGUAGES } = await import('./alignment-model.js');
        const lang = getAlignmentLanguage();
        const textEl = document.getElementById('selected-align-viewer-language-text');
        if (textEl) textEl.textContent = ALIGNMENT_LANGUAGES[lang]?.label || '한국어';
        wrap.querySelectorAll('.option-item').forEach((opt) => {
            opt.classList.toggle('selected', opt.dataset.value === lang);
        });
    }

    /** Cancels the current track's queued/processing AI alignment run
     *  (queued items are removed locally; a processing item is cancelled via
     *  the backend's global `cancel_forced_alignment`, safe since only one
     *  alignment ever runs at a time behind `ALIGNMENT_QUEUE_LOCK`). */
    async cancelAiAlignment() {
        if (!this.state.currentPath) return;
        try {
            const { cancelAlignmentQueueItem } = await import('./alignment-queue.js');
            await cancelAlignmentQueueItem(this.state.currentPath);
        } catch (err) {
            console.error('[Alignment] Cancel failed:', err);
        } finally {
            this.updateAiAlignButtonState();
        }
    }

    /**
     * Applies a batch-queue alignment result to the segments currently open
     * in the editor, iff it's for the track that's still open (a bulk run
     * covering other tracks would otherwise silently corrupt whatever the
     * user has open right now). Non-destructive - only still-unsynced
     * segments get filled in (`mergeAlignmentResult`), exactly like the BPM
     * grid tool, so manually-tapped/dragged lines are never overwritten.
     */
    onQueueAlignmentDone(path, lines) {
        if (!path || path !== this.state.currentPath) return;
        this.updateAiAlignButtonState();
        if (!Array.isArray(lines) || lines.length === 0) return;
        const applied = mergeAlignmentResult(this.state.segments, lines);
        if (applied > 0) {
            this.renderLyricList();
            this.renderMarkerList();
            this.offerVocalStartSuggestion('ai');
            this.drawWaveform();
            // The queue already wrote the merged result to the LRC file for
            // us - stay clean rather than re-triggering an identical autosave.
            this.isDirty = false;
            this.updateSaveStatus('저장됨');
            showNotification(`AI 정렬 결과 ${applied}줄이 반영되었습니다. 결과는 AI 초안이니 필요한 부분만 검토해 다듬어 주세요.`, 'success');
        }
    }

    /** Builds the download-confirmation copy for a not-yet-downloaded
     *  alignment model - language, upstream source, license, approximate
     *  size, and the "AI draft, needs user polish" quality notice - mirroring
     *  the settings-page download card (`events/controls/alignment-model.js`)
     *  so the same disclosure is shown no matter which entry point the user
     *  downloads from. */
    formatAlignmentModelConfirm(info) {
        const langLabel = info.language === 'en' ? '영어(English)' : '한국어';
        const mb = (info.modelSizeBytes || 0) / (1024 * 1024);
        const sizeLabel = mb >= 1024 ? `약 ${(mb / 1024).toFixed(1)}GB` : `약 ${Math.round(mb)}MB`;
        return (
            `${langLabel} 가사 정렬 모델을 다운로드합니다.\n` +
            `출처: ${info.sourceUrl}\n` +
            `라이선스: ${info.license}\n` +
            `예상 용량: ${sizeLabel}\n\n` +
            `AI 초안, 사용자가 다듬기 - 정렬 결과는 참고용 초안이며 정확한 싱크를 보장하지 않습니다.\n` +
            `다운로드를 진행할까요?`
        );
    }

    /** 아직 없는 정렬 모델 하나를 확인 다이얼로그로 받은 뒤 true/false 반환.
     *  다운로드 중에는 `#ai-align-status`에 진행률(%)을 표시한다. */
    async offerAlignmentModelDownload(info) {
        if (!info || info.downloaded) return true;
        const { openConfirmModal } = await import('./ui/modals.js');
        return new Promise((resolve) => {
            let settled = false;
            let unlisten = null;
            const settle = (ok) => {
                if (settled) return;
                settled = true;
                if (typeof unlisten === 'function') {
                    try { unlisten(); } catch (_) {}
                    unlisten = null;
                }
                resolve(ok);
            };

            openConfirmModal('AI 가사 정렬 모델 다운로드', this.formatAlignmentModelConfirm(info), async () => {
                const statusEl = document.getElementById('ai-align-status');
                const langLabel = info.language === 'en' ? '영어' : '한국어';
                const setStatus = (pct) => {
                    if (!statusEl) return;
                    const n = Math.max(0, Math.min(100, Math.floor(Number(pct) || 0)));
                    statusEl.textContent = `${langLabel} 모델 다운로드 중... (${n}%)`;
                };
                setStatus(0);

                try {
                    const { listen } = await import('./tauri-bridge.js');
                    unlisten = await listen('alignment-model-download-progress', (event) => {
                        const payload = event.payload || {};
                        if (payload.language && payload.language !== info.language) return;
                        setStatus(payload.percentage);
                    });
                } catch (err) {
                    console.warn('[Alignment] progress listener failed:', err);
                }

                try {
                    const { downloadAlignmentModel } = await import('./model-api.js');
                    await downloadAlignmentModel(info.language);
                    if (statusEl) statusEl.textContent = `${langLabel} 모델 다운로드 완료`;
                    settle(true);
                } catch (err) {
                    const msg = String(err);
                    if (!msg.includes('취소')) {
                        showNotification('정렬 모델 다운로드 실패: ' + msg, 'error');
                    }
                    settle(false);
                } finally {
                    if (typeof unlisten === 'function') {
                        try { unlisten(); } catch (_) {}
                        unlisten = null;
                    }
                    // 다음 단계(정렬 시작/추가 다운로드) 문구가 바로 덮어쓰도록 잠시 후 비움.
                    setTimeout(() => {
                        if (statusEl && /다운로드/.test(statusEl.textContent || '')) {
                            statusEl.textContent = '';
                        }
                    }, 800);
                }
            });

            // openConfirmModal은 취소 콜백이 없어, 닫기 경로를 감싸 거절로 처리.
            const wrapCancel = (el) => {
                if (!el) return;
                const prev = el.onclick;
                el.onclick = (e) => {
                    if (typeof prev === 'function') prev.call(el, e);
                    settle(false);
                };
            };
            wrapCancel(document.getElementById('confirm-cancel') || document.getElementById('confirm-no'));
            wrapCancel(document.getElementById('confirm-close-icon'));
            const modal = document.getElementById('confirm-modal');
            if (modal) {
                const prev = modal.onclick;
                modal.onclick = (e) => {
                    if (typeof prev === 'function') prev.call(modal, e);
                    if (e.target === modal) settle(false);
                };
            }
        });
    }

    /** Saves the current LRC (so the queue reads up-to-date unsynced lines),
     *  then enqueues this track on the shared batch queue (`alignment-queue.js`).
     *  Sharing the queue - rather than calling `run_forced_alignment` directly -
     *  means the interactive editor and any bulk run are naturally serialized
     *  through the same backend lock and never race each other. */
    async enqueueCurrentTrackAlignment() {
        await this.flushAutoSaveIfNeeded();
        await this.saveLrc(true);
        const { enqueueAlignment, isAlignmentBusy } = await import('./alignment-queue.js');
        const wasBusy = isAlignmentBusy();
        const added = enqueueAlignment([this.state.currentPath]);
        const { getAlignmentLanguage } = await import('./alignment-model.js');
        const rapNote = getAlignmentLanguage() === 'rap'
            ? ' (랩/혼합: 한국어·영어 모델을 순서대로 돌리므로 시간이 더 걸립니다)'
            : '';
        showNotification(
            added > 0
                ? (wasBusy
                    ? '다른 정렬이 진행 중이라 대기열에 추가했습니다. 완료되면 자동으로 결과가 반영돼요.'
                    : `AI 자동 정렬을 시작했습니다. 완료되면 자동으로 결과가 반영돼요.${rapNote}`)
                : '이 곡은 이미 정렬 대기열에 있거나 처리 중입니다.',
            added > 0 ? 'success' : 'info'
        );
        this.updateAiAlignButtonState();
    }

    /**
     * Entry point for the "AI 자동 정렬" button: guards on having something
     * to align, resolves the user's chosen language's model status, shows
     * the Apache-2.0/source/size/quality confirmation dialog before ever
     * downloading anything for the first time (mirrors the settings-page
     * flow), then hands off to the shared batch queue. Only still-unsynced
     * lines are ever targeted - existing manual timings are untouched.
     * 랩/혼합(rap)은 한국어·영어 모델이 모두 필요하다.
     */
    async runAiAlignment() {
        if (!this.state.currentPath) {
            showNotification('음원을 먼저 선택하세요.', 'warning');
            return;
        }
        const unsyncedCount = (this.state.segments || []).filter(
            (s) => s.start === 0 && s.end === 0 && getSyncText(s).trim()
        ).length;
        if (unsyncedCount === 0) {
            showNotification('AI로 정렬할 미싱크 가사가 없습니다.', 'info');
            return;
        }

        try {
            const { getAlignmentLanguage, requiredLanguagesFor } = await import('./alignment-model.js');
            const { listAlignmentModels } = await import('./model-api.js');
            const language = getAlignmentLanguage();
            const needed = requiredLanguagesFor(language);

            let models;
            try {
                models = await listAlignmentModels();
            } catch (err) {
                showNotification('정렬 모델 목록을 불러오지 못했습니다: ' + err, 'error');
                return;
            }

            for (const requiredLang of needed) {
                const info = (models || []).find((m) => m.language === requiredLang);
                if (!info) {
                    showNotification('알 수 없는 정렬 언어입니다. 설정에서 언어를 다시 선택해주세요.', 'error');
                    return;
                }
                if (info.downloaded) continue;
                const ok = await this.offerAlignmentModelDownload(info);
                if (!ok) return;
                try {
                    models = await listAlignmentModels();
                } catch (_) { /* keep previous list */ }
            }

            await this.enqueueCurrentTrackAlignment();
        } catch (err) {
            console.error('[Alignment] AI align failed:', err);
            showNotification('AI 정렬 준비 실패: ' + err, 'error');
        }
    }

    renderLyricList() {
        const container = document.getElementById('lyric-lines-container');
        if (!container) return;
        const toggleBtn = document.getElementById('toggle-translation-btn');
        if (toggleBtn) {
            const showing = getShowTranslation();
            toggleBtn.textContent = '번역';
            toggleBtn.classList.toggle('active-toggle', showing);
            toggleBtn.setAttribute('aria-pressed', showing ? 'true' : 'false');
        }
        container.innerHTML = this.state.segments.map((s, i) => {
            if (isTriplet(s)) {
                const displayLines = getDisplayLines(s);
                const html = displayLines.length
                    ? displayLines.map((l, li) => `<span class="triplet-line triplet-line-${li}">${this.escapeHtml(l)}</span>`).join('')
                    : '&nbsp;';
                return `
            <div class="lyric-line-item" data-index="${i}">
                <span class="time-range" title="이 시간으로 재생 이동">${this.formatTime(s.start)}</span>
                <span class="lyric-text triplet-text" title="이 가사 위치로 탐색 및 타겟 지정">${html}</span>
            </div>
        `;
            }
            return `
            <div class="lyric-line-item" data-index="${i}">
                <span class="time-range" title="이 시간으로 재생 이동">${this.formatTime(s.start)}</span>
                <span class="lyric-text" title="이 가사 위치로 탐색 및 타겟 지정">${(s.text && s.text.trim()) ? this.escapeHtml(s.text) : '&nbsp;'}</span>
            </div>
        `;
        }).join('');

        // 클릭 이벤트 추가 (기능 분리: 이동 vs 타겟 지정)
        container.querySelectorAll('.lyric-line-item').forEach((item) => {
            item.onclick = async (e) => {
                const idx = parseInt(item.getAttribute('data-index'));
                const targetTime = this.state.segments[idx].start;

                // 가사나 시간을 클릭하면 해당 위치로 이동 (시간이 0보다 클 때)
                if (targetTime > 0) {
                    await this.seekTo(targetTime, { keepPaused: true });
                }

                if (targetTime > 0) {
                    // 시간이 찍혀 있는(이동 가능한) 가사를 클릭했다면, 자연스럽게 다음 가사부터 스탬프를 찍도록 대기
                    this.state.currentSyncIndex = Math.min(idx + 1, this.state.segments.length);
                } else {
                    // 아직 시간이 없는 가사를 클릭하면 그 가사부터 스탬프를 찍도록 지정
                    this.state.currentSyncIndex = idx;
                }

                this.syncSidebar(true);
            };
        });

        // Force an immediate sync and scroll
        this.syncSidebar(true);
    }

    syncSidebar(forceScroll = false) {
        if (!this.state.segments || this.state.segments.length === 0) return;

        let playingIndex = -1;
        // 1. Find the currently playing segment
        for (let i = 0; i < this.state.segments.length; i++) {
            const s = this.state.segments[i];
            if (s.start > 0 && this.state.currentTime >= s.start && (s.end === 0 || this.state.currentTime < s.end)) {
                playingIndex = i;
            }
        }

        const syncIndex = this.state.currentSyncIndex;

        const container = document.getElementById('lyric-lines-container');
        if (!container) return;

        const items = container.querySelectorAll('.lyric-line-item');
        let shouldScroll = forceScroll;

        items.forEach((item, i) => {
            // 재생 중인 가사 하이라이트 (active)
            if (i === playingIndex) {
                if (!item.classList.contains('active')) {
                    item.classList.add('active');
                    shouldScroll = true;
                }
            } else {
                item.classList.remove('active');
            }

            // 앞으로 찍을 가사 하이라이트 (syncing)
            if (i === syncIndex) {
                if (!item.classList.contains('syncing')) {
                    item.classList.add('syncing');
                    shouldScroll = true;
                }
            } else {
                item.classList.remove('syncing');
            }
        });

        if (shouldScroll) {
            // 탭 할 가사 위치(syncing)가 있으면 거기로, 없으면 재생 중(active) 위치로 스크롤
            const targetClass = syncIndex !== -1 && syncIndex < this.state.segments.length ? '.syncing' : '.active';
            const targetItem = container.querySelector(`.lyric-line-item${targetClass}`);
            if (targetItem) {
                targetItem.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }
        }
    }

    updateSaveStatus(text, isError = false) {
        const el = document.getElementById('sync-save-status');
        if (!el) return;
        el.textContent = text;
        el.style.color = isError ? '#f87171' : '#94a3b8';
    }

    markDirtyAndScheduleSave() {
        if (!this.state.currentPath) return;
        this.isDirty = true;
        this.updateSaveStatus('저장 대기...');
        if (this.autoSaveTimer) {
            clearTimeout(this.autoSaveTimer);
        }
        this.autoSaveTimer = setTimeout(() => {
            this.autoSaveTimer = null;
            this.saveLrc(true);
        }, this.autoSaveDelayMs);
    }

    async flushAutoSaveIfNeeded() {
        if (this.autoSaveTimer) {
            clearTimeout(this.autoSaveTimer);
            this.autoSaveTimer = null;
        }
        if (this.isDirty) {
            await this.saveLrc(true);
        }
    }

    async saveLrc(silent = false) {
        const syncableSegments = (this.state.segments || []).filter(s => (s.text || '').trim().length > 0);
        if (!this.state.currentPath || syncableSegments.length === 0) {
            if (!silent) showNotification('저장할 가사 데이터가 없습니다.', 'error');
            return;
        }
        if (this.isAutoSaving) return;
        try {
            this.isAutoSaving = true;
            this.updateSaveStatus('저장 중...');
            const markerLines = [];
            const m = this.state.markers || {};
            if (typeof m.vocalStartSec === 'number') {
                markerLines.push(formatMarkerLine(m.vocalStartSec, 'vocalstart'));
            }
            (m.interludes || []).forEach((il) => {
                if (typeof il.start === 'number' && typeof il.end === 'number') {
                    markerLines.push(formatMarkerLine(il.start, 'ilstart'));
                    markerLines.push(formatMarkerLine(il.end, 'ilend'));
                }
            });
            const content = encodeLrc(syncableSegments, markerLines);
            await this.invoke('save_lrc_file', { audioPath: this.state.currentPath, content });

            // Reflect lyric availability immediately without requiring track re-selection.
            const targetPath = this.state.currentPath;
            const targetSong = state.songLibrary.find(song => song.path === targetPath);
            if (targetSong) {
                targetSong.hasLyrics = true;
                targetSong.has_lyrics = true;
            }
            if (state.currentTrack && state.currentTrack.path === targetPath) {
                state.currentTrack.hasLyrics = true;
                state.currentTrack.has_lyrics = true;
            }

            // Refresh currently loaded lyric data for drawer/overlay right away.
            const parsedLyrics = parseLrc(content, this.state.duration || 0);
            state.currentLyrics = parsedLyrics;
            state.currentLyricIndex = -1;
            import('./lyric-drawer.js').then(m => {
                if (m.updateLyrics) m.updateLyrics(parsedLyrics);
            });
            import('./ui/components.js').then(m => {
                if (m.updateAiTogglesState) m.updateAiTogglesState();
            });

            this.isDirty = false;
            this.lastSavedAt = Date.now();
            this.updateSaveStatus('저장됨');
            if (!silent) showNotification('가사 싱크 저장 완료', 'success');
        } catch (err) {
            console.error(err);
            this.updateSaveStatus('저장 실패', true);
            showNotification('LRC 저장 실패: ' + err, 'error');
        } finally {
            this.isAutoSaving = false;
        }
    }
}
