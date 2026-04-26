import { showNotification, getThumbnailUrl } from './utils.js';
import { invoke, listen } from './tauri-bridge.js';
import { state } from './state.js';
import { parseLrc } from './lyrics.js';

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
            selectedTarget: null
        };
        this.autoSaveTimer = null;
        this.autoSaveDelayMs = 1000;
        this.isDirty = false;
        this.isAutoSaving = false;
        this.lastSavedAt = null;

        this.initUI();
        this.setupListeners();
        this.parseLyrics();
        this.setupBackendListeners();
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
                            <div class="card-header" style="margin-bottom: 12px;">
                                <h3>가사 원고</h3>
                            </div>
                            <textarea id="lyrics-input" class="lyrics-textarea" placeholder="가사를 입력하세요..."></textarea>
                        </section>
                    </div>
                </aside>

                <main class="alignment-main">
                    <div class="alignment-card waveform-card">
                        <div class="card-header">
                            <h3>오디오 타임라인</h3>
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
                                <button id="play-btn" class="sync-ctrl-btn circle-btn" title="재생/일시정지">
                                    <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
                                </button>
                                <button id="sync-tap-btn" class="sync-ctrl-btn tap-btn">
                                    <span class="tap-label">싱크 맞추기 (Space)</span>
                                </button>
                                <div class="time-container">
                                    <span id="time-display" style="font-family:monospace; color:#94a3b8; font-size:0.85rem;">00:00 / 00:00</span>
                                </div>
                            </div>
                        </div>
                    </div>
                </main>

                <aside class="lyric-sidebar">
                    <div class="alignment-card">
                        <div class="card-header" style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px;">
                            <h3>가사 싱크 결과</h3>
                            <div style="display:flex; gap:8px;">
                                <span id="sync-save-status" class="sync-save-status" style="min-width:52px; text-align:right; font-size:0.78rem; color:#94a3b8;">저장됨</span>
                                <button id="reset-sync-btn" class="sync-reset-btn">초기화</button>
                            </div>
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
        get('alignment-track-search').oninput = (e) => this.renderTrackList(e.target.value);

        get('play-btn').onclick = () => this.togglePlayback();
        get('sync-tap-btn').onclick = () => this.handleTap();
        get('reset-sync-btn').onclick = () => {
            if (confirm('모든 싱크 데이터를 초기화하시겠습니까?')) {
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
            }
        };

        const lyricsInput = get('lyrics-input');
        if (lyricsInput) {
            lyricsInput.addEventListener('input', () => this.parseLyrics());
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
                    this.seekTo(targetTime);
                } else {
                    if (this.state.duration <= 0) return;
                    const rect = this.canvas.getBoundingClientRect();
                    const x = e.clientX - rect.left;
                    const targetTime = this.xToTime(x);
                    this.seekTo(targetTime);
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
            } else if (e.code === 'Space') {
                // Global spacebar tap
                e.preventDefault();
                this.handleTap();
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
                    await this.seekTo(this.state.currentTime);
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
        await this.flushAutoSaveIfNeeded();
        this.state.currentPath = path;
        this.state.isProcessing = true;
        this.state.currentTime = 0;
        this.state.duration = 0;
        this.state.waveformPoints = null; // 파형 초기화
        this.drawWaveform();

        const loader = document.getElementById('waveform-loader');
        const loaderText = document.getElementById('loader-text');
        const loaderProgress = document.getElementById('loader-progress');

        if (loader) loader.style.display = 'flex';

        if (loaderProgress) loaderProgress.style.display = 'none';

        try {
            // Keep bottom shared playback area consistent with library-selected behavior.
            const matchedIndex = (state.songLibrary || []).findIndex((song) => song.path === path);
            const matchedSong = matchedIndex >= 0 ? state.songLibrary[matchedIndex] : null;
            if (matchedSong) {
                state.currentTrack = matchedSong;
                state.selectedTrackIndex = matchedIndex;
                state.isPlaying = false;
                state.isLoading = true;
                state.vocalEnabled = true;

                const elemsMod = await import('./ui/elements.js');
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
                if (ui.updateThumbnailOverlay) ui.updateThumbnailOverlay();
                if (ui.updateAiTogglesState) ui.updateAiTogglesState(matchedSong);
                if (ui.updatePlayButton) ui.updatePlayButton();

                // In lyric sync workflow, always monitor with vocals enabled.
                const audio = await import('./audio.js');
                if (audio.toggleAiFeature) {
                    await audio.toggleAiFeature("vocal", true);
                }
            }

            console.log("[Alignment] Loading audio:", path);
            // Get duration immediately from backend
            const ms = await this.invoke('play_track', { path, durationMs: 0, playNow: false });
            console.log("[Alignment] play_track success, duration:", ms);
            this.state.duration = ms / 1000;
            this.updateTimeDisplay();

            // 가사 데이터 초기화
            this.state.segments = [];
            this.state.currentSyncIndex = 0;
            this.state.isSyncMode = false;
            const inputElement = document.getElementById('lyrics-input');
            if (inputElement) inputElement.value = '';
            this.renderLyricList();
            this.isDirty = false;
            this.updateSaveStatus('저장됨');

            // Try to load existing LRC file
            try {
                const lrcContent = await this.invoke('load_lrc_file', { audioPath: path });
                if (lrcContent && lrcContent.trim()) {
                    const parsedSegments = parseLrc(lrcContent, this.state.duration);
                    // Clean up imported lyrics: remove meaningless blank lines and trim noisy spacing.
                    const normalizedSegments = parsedSegments
                        .map((seg) => ({
                            ...seg,
                            text: (seg.text || '').replace(/\s+/g, ' ').trim()
                        }))
                        .filter((seg) => seg.text.length > 0);

                    this.state.segments = normalizedSegments;

                    const rawLyrics = this.state.segments.map(s => s.text);
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

            this.drawWaveform();

            // Background waveform (파형 후순위 비동기 로드)


            const waveformPath = path;
            this.invoke('get_waveform_summary', { audioPath: waveformPath }).then(summary => {
                console.log("[Alignment] Waveform load success:", summary ? summary.points.length : 0);
                if (summary) {
                    this.state.waveformPoints = summary.points;
                    if (!this.state.duration) {
                        this.state.duration = summary.duration_sec;
                        this.updateTimeDisplay();
                    }
                    this.drawWaveform();
                }
            }).catch(e => {
                console.error("[Alignment] Waveform load failed:", e);
                showNotification('파형 로드 실패: ' + e, 'warning');
            })
                .finally(() => {
                    this.state.isProcessing = false;
                    state.isLoading = false;
                    import('./ui/components.js').then((ui) => {
                        if (ui.updateThumbnailOverlay) ui.updateThumbnailOverlay();
                        if (ui.updatePlayButton) ui.updatePlayButton();
                    });
                    if (loader) loader.style.display = 'none';
                });

        } catch (e) {
            console.error("[Alignment] loadAudio general failure:", e);
            this.state.isProcessing = false;
            state.isLoading = false;
            import('./ui/components.js').then((ui) => {
                if (ui.updateThumbnailOverlay) ui.updateThumbnailOverlay();
                if (ui.updatePlayButton) ui.updatePlayButton();
            });
            if (loader) loader.style.display = 'none';
            showNotification('오디오 로드 실패: ' + e, 'error');
        }
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

    async seekTo(time) {
        if (!this.state.currentPath || this.state.duration <= 0) return;

        this.state.currentTime = Math.max(0, Math.min(this.state.duration, time));
        this.updateTimeDisplay();

        try {
            // Seek 중 백엔드의 이전 재생 위치 이벤트에 의해 UI가 튕기는 것을 방지
            this.state.isSeeking = true;
            if (this._seekTimeout) clearTimeout(this._seekTimeout);

            await this.invoke('seek_to', {
                positionMs: Math.floor(this.state.currentTime * 1000)
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

        const theme = document.documentElement.getAttribute('data-theme') || 'dark';
        const isLightLikeTheme = theme === 'light' || theme === 'pink' || theme === 'sky';
        const palette = isLightLikeTheme
            ? {
                segmentFillActive: 'rgba(154, 107, 63, 0.24)',
                segmentFillIdle: 'rgba(154, 107, 63, 0.1)',
                segmentBorder: 'rgba(154, 107, 63, 0.45)',
                segmentHover: 'rgba(154, 107, 63, 0.8)',
                waveformStroke: 'rgba(79, 64, 50, 0.55)',
            }
            : {
                segmentFillActive: 'rgba(74, 158, 255, 0.3)',
                segmentFillIdle: 'rgba(74, 158, 255, 0.1)',
                segmentBorder: 'rgba(74, 158, 255, 0.3)',
                segmentHover: '#4a9eff',
                waveformStroke: 'rgba(255,255,255,0.2)',
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

            // Selected Boundary Highlight (Yellow)
            const st = this.state.selectedTarget;
            if (st && st.index === idx) {
                this.ctx.strokeStyle = '#fbbf24'; // Amber/Yellow
                this.ctx.lineWidth = 3;
                const bx = st.type === 'start' ? x1 : x2;
                this.ctx.beginPath();
                this.ctx.moveTo(bx, 0);
                this.ctx.lineTo(bx, height);
                this.ctx.stroke();

                // Show timestamp tooltip-like text
                this.ctx.fillStyle = '#fbbf24';
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

        const filtered = this.tracks ? this.tracks.filter(t => {
            const searchStr = `${t.title || ''} ${t.artist || ''}`.toLowerCase();
            return !query || searchStr.includes(query.toLowerCase());
        }) : [];

        if (filtered.length === 0) {
            container.innerHTML = `<div style="text-align:center; padding:20px; color:#64748b;">음원이 없습니다.</div>`;
            return;
        }

        container.innerHTML = filtered.map(t => {
            const title = t.title || 'Unknown Title';
            const artist = t.artist || 'Unknown Artist';
            const thumbnail = t.thumbnail || '';
            const path = t.path; // 원본 파일 경로

            const thumbUrl = getThumbnailUrl(thumbnail, t);

            return `
                <div class="track-item" data-path="${path.replace(/"/g, '&quot;')}">
                    <div class="track-thumb">
                        ${thumbUrl ? `<img src="${thumbUrl}" alt="">` : `<div class="thumb-placeholder">♪</div>`}
                    </div>
                    <div class="track-info">
                        <div class="track-name" title="${title.replace(/"/g, '&quot;')}">${title}</div>
                        <div class="track-artist" title="${artist.replace(/"/g, '&quot;')}">${artist}</div>
                    </div>
                </div>
            `;
        }).join('');

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

        const newSegments = newLines.map((text) => {
            // 1순위: 텍스트가 완전히 동일한 기존 라인을 찾아 시간 복사
            const exactMatch = oldSegments.find(s => s.text === text && !s._used);
            if (exactMatch) {
                exactMatch._used = true;
                return { text, start: exactMatch.start, end: exactMatch.end };
            }
            return { text, start: 0, end: 0 };
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

    renderLyricList() {
        const container = document.getElementById('lyric-lines-container');
        if (!container) return;
        container.innerHTML = this.state.segments.map((s, i) => `
            <div class="lyric-line-item" data-index="${i}">
                <span class="time-range" title="이 시간으로 재생 이동">${this.formatTime(s.start)}</span>
                <span class="lyric-text" title="이 가사 위치로 탐색 및 타겟 지정">${(s.text && s.text.trim()) ? s.text : '&nbsp;'}</span>
            </div>
        `).join('');

        // 클릭 이벤트 추가 (기능 분리: 이동 vs 타겟 지정)
        container.querySelectorAll('.lyric-line-item').forEach((item) => {
            item.onclick = async (e) => {
                const idx = parseInt(item.getAttribute('data-index'));
                const targetTime = this.state.segments[idx].start;

                // 가사나 시간을 클릭하면 해당 위치로 이동 (시간이 0보다 클 때)
                if (targetTime > 0) {
                    this.state.currentTime = targetTime;
                    this.updateTimeDisplay();
                    this.drawWaveform();
                    try {
                        await this.invoke('seek_to', { positionMs: Math.floor(targetTime * 1000) });
                    } catch (err) {
                        console.error("Seek failed:", err);
                    }
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
            const lrcLines = syncableSegments.map(s => {
                const min = Math.floor(s.start / 60).toString().padStart(2, '0');
                const sec = (s.start % 60).toFixed(2).padStart(5, '0');
                return `[${min}:${sec}]${s.text}`;
            });
            const content = lrcLines.join('\n');
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
