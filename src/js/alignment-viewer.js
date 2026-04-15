import { showNotification } from './utils.js';
import { invoke, listen, convertFileSrc } from './tauri-bridge.js';

/**
 * ForcedAlignmentViewer (v15 Refactored)
 * A modular controller that orchestrates Audio engine, UI rendering, and AI services.
 * Strictly preserves the premium design specified by the user.
 */
export class ForcedAlignmentViewer {
    constructor(containerId) {
        this.container = document.getElementById(containerId);
        
        this.invoke = invoke;
        
        // --- State Management ---
        this.state = {
            duration: 0,
            currentTime: 0,
            isPlaying: false,
            alignmentData: null,
            segments: [],
            isProcessing: false,
            progress: 0,
            isSyncMode: false,
            currentSyncIndex: -1,
            waveformPoints: null // Cached points for fast drawing
        };

        this.unlistenProgress = null;
        this.unlistenStatus = null;
        this.animationId = null;

        // --- Initialize ---
        this.initUI();
        this.setupListeners(); // Async
        this.setupCanvasListeners();
        this.loadTrackList();

        // 윈도우 리사이즈
        window.addEventListener('resize', () => this.resizeCanvas());
        
        // Ensure canvas is ready after layout calc
        setTimeout(() => this.resizeCanvas(), 200);
    }

    async setupListeners() {
        // 백엔드 오디오 진행 이벤트 구독
        this.unlistenProgress = await listen('playback-progress', (e) => {
            if (this.state.isSeeking) return; // 탐색 중에는 업데이트 무시
            const { positionMs, durationMs } = e.payload;
            this.state.currentTime = positionMs / 1000;
            this.state.duration = durationMs / 1000;
            this.updateTimeDisplay();
            this.drawWaveform();
        });

        // 백엔드 재생 상태 이벤트 구독
        this.unlistenStatus = await listen('playback-status', (e) => {
            const { status } = e.payload;
            this.state.isPlaying = (status === 'playing');
            this.updatePlayButton();
        });
    }

    async onDestroy() {
        // 리스너 해제
        if (this.unlistenProgress) {
            const unlisten = await this.unlistenProgress;
            unlisten();
        }
        if (this.unlistenStatus) {
            const unlisten = await this.unlistenStatus;
            unlisten();
        }
    }

    /**
     * 1. View: Initialize HTML based on the v15 CSS Specification
     */
    initUI() {
        if (!this.container) return;
        this.container.innerHTML = `
            <div class="alignment-container">
                <!-- Left: Lyrics Input & Audio Selection -->
                <aside class="lyric-input-column">
                    <div class="alignment-card">
                        <section>
                            <span class="alignment-label">음원 선택</span>
                            <div class="track-select-row">
                                <select id="track-select" class="track-select">
                                    <option value="">음원을 선택하세요...</option>
                                </select>
                                <button id="refresh-tracks-btn" class="run-btn" style="min-width: 32px; padding: 0;">↻</button>
                            </div>
                        </section>

                        <section style="flex: 1; display: flex; flex-direction: column; min-height: 0;">
                            <span class="alignment-label">가사 입력 (원고)</span>
                            <textarea id="lyrics-input" class="lyrics-textarea" placeholder="이곳에 노래 가사를 입력하세요...">한 낮에 내리는 햇살.
머리는 어지럽고
어제의 내가 난 기억이 나질 않네

담배를 피워물고 거울앞에 서면
유령처럼 낯선 거울속의 나

희미하게 기억나는건
술잔속에 비치는 어여쁜 너의 미소

빗속을 뛰었던것 같고 
울었던것 같고 소리친것 같은데
너에게 애원한것 같고 
울었던것 같고 소리친것 같은데 
난 아무도 아무것도 기억이 없네

희미하게 기억나는건
술잔속에 비치는 어여쁜 너의 미소

빗속을 뛰었던것 같고 
울었던것 같고 소리친것 같은데
너에게 애원한것 같고 
울었던것 같고 소리친것 같은데 
난 아무도 아무것도 기억이 없네</textarea>
                        </section>
                    </div>
                </aside>

                <!-- Center: Waveform & Manual Sync Controls -->
                <main class="alignment-main">
                    <div class="alignment-card waveform-card">
                        <div class="card-header">
                            <h3>오디오 타임라인 (수동 정렬)</h3>
                        </div>
                        
                        <div class="waveform-canvas-container">
                            <canvas id="waveform-canvas"></canvas>
                        </div>

                        <!-- Manual Sync Control Bar -->
                        <div class="sync-controls-panel">
                            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;">
                                <div id="sync-status-text" style="color: var(--accent-blue); font-weight: 800; font-size: 0.8rem; text-transform: uppercase;">Manual Sync Mode</div>
                                <div id="time-display" style="font-family: 'JetBrains Mono', monospace; color: #94a3b8; font-size: 0.85rem;">00:00 / 00:00</div>
                            </div>
                            
                            <div class="sync-buttons">
                                <button id="play-btn" class="run-btn" style="width: 48px; background: rgba(255,255,255,0.08); display: flex; align-items: center; justify-content: center;">
                                    <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
                                </button>
                                <button id="manual-sync-btn" class="run-btn primary-btn" style="flex: 2; height: 48px; background: var(--accent-blue); font-weight: 800;">
                                    수동 정렬 시작
                                </button>
                                <button id="sync-tap-btn" class="run-btn" style="flex: 1; height: 48px; background: #6366f1; font-weight: 800; display: none; animation: pulse-border 2s infinite;">
                                    TAP (Space)
                                </button>
                            </div>
                            
                            <input type="range" id="seek-bar" class="seek-bar" value="0">
                        </div>
                    </div>
                </main>

                <!-- Right: Result Lyrics List -->
                <aside class="lyric-sidebar">
                    <div class="alignment-card">
                        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;">
                            <span class="alignment-label">정렬 결과 (LRC)</span>
                            <button id="add-line-btn" class="run-btn" style="padding: 4px 10px; font-size: 0.7rem;">+ 줄 추가</button>
                        </div>
                        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
                            <span id="line-count" class="alignment-sub-label">0 lines</span>
                            <button id="save-lrc-btn" class="run-btn primary-btn" style="display: none; padding: 4px 12px; font-size: 0.75rem; background: #10b981;">LRC 저장</button>
                        </div>
                        <div id="lyric-lines-container" class="lyric-lines-list">
                            <div style="color: #475569; font-size: 0.9rem; text-align: center; margin-top: 50px;">
                                가사를 입력하고<br><b>[수동 정렬 시작]</b>을 클릭하세요.
                            </div>
                        </div>
                    </div>
                </aside>
            </div>
        `;
        
        this.canvas = document.getElementById('waveform-canvas');
        if (this.canvas) {
            this.ctx = this.canvas.getContext('2d');
            setTimeout(() => this.resizeCanvas(), 50); // Give layout a moment to settle
        }
    }

    /**
     * 2. Interaction: Centralized Event Subscriptions
     */
    setupListeners() {
        document.getElementById('refresh-tracks-btn').onclick = () => this.loadTrackList();
        document.getElementById('add-line-btn').onclick = () => this.handleAddLine();
        document.getElementById('play-btn').onclick = () => this.togglePlayback();
        
        const seekBar = document.getElementById('seek-bar');
        seekBar.oninput = (e) => this.handleSeek(e.target.value);
        seekBar.onchange = () => this.finishSeek();

        document.getElementById('manual-sync-btn').onclick = () => this.handleManualSyncInit();
        document.getElementById('sync-tap-btn').onclick = () => this.handleSyncTap();
        document.getElementById('save-lrc-btn').onclick = () => this.saveLyrics();
        
        // Manual sync hotkey (Space)
        window.addEventListener('keydown', (e) => {
            if (e.code === 'Space' && this.state.isSyncMode) {
                e.preventDefault();
                this.handleSyncTap();
            }
        });
        
        document.getElementById('track-select').onchange = (e) => {
            if (e.target.value) this.loadAudio(e.target.value);
        };
    }

    /**
     * 3. Service Layer: Audio & Track Management
     */
    async loadTrackList() {
        const select = document.getElementById('track-select');
        if (!select) return;
        select.innerHTML = '<option value="">스캔 중...</option>';
        try {
            const tracks = await this.invoke('get_separated_audio_list');
            select.innerHTML = '<option value="">음원을 선택하세요...</option>';
            if (!tracks || tracks.length === 0) {
                select.innerHTML = '<option value="">분리된 음원 없음</option>';
                return;
            }
            for (const t of tracks) {
                if (!t.has_vocal) continue;
                const opt = new Option(t.name, t.folder_path + '/vocal.wav');
                if (t.name.includes('07 숙취')) {
                    opt.selected = true;
                    this.loadAudio(opt.value);
                }
                select.appendChild(opt);
            }
            if (select.options.length === 1 && select.options[0].value === "") {
                select.innerHTML = '<option value="">보컬 파일 없음</option>';
            }
        } catch (err) {
            console.error('[Alignment] loadTrackList error:', err);
            select.innerHTML = `<option value="">오류: ${err}</option>`;
        }
    }

    async seekToMs(ms) {
        if (!window.__TAURI__) return;
        try {
            await this.invoke('seek_to', { positionMs: BigInt(ms) });
        } catch (e) {
            console.error('Seek failed:', e);
        }
    }

    /**
     * 4. Audio Engine: Backend-Integrated Playback & State Sync
     */
    async loadAudio(path) {
        try {
            this.state.waveformPoints = null;
            this.drawWaveform();

            // 1. 파형 데이터 즉시 요청 (백엔드 요약본)
            this.invoke('get_waveform_summary', { audio_path: path }).then(summary => {
                this.state.waveformPoints = summary.points;
                this.state.duration = summary.duration_sec || this.state.duration;
                this.updateTimeDisplay();
                this.drawWaveform();
            }).catch(e => console.error('Waveform summary error:', e));

            // 2. 백엔드 오디오 로드
            // 정렬 모듈에서는 일관성을 위해 play_track을 호출
            this.state.currentTime = 0;
            // Note: play_track internally handles MR mixing if exists
            await this.invoke('play_track', { path: path, durationMs: 0 });
            
            // 시각적 피드백을 위해 하단 도크 알림 발송 가능 (생략 가능)
            console.log(`[Alignment] Backend audio prepared for: ${path}`);
        } catch (err) {
            console.error('Audio load error:', err);
            showNotification(`오디오 로드 실패: ${err}`, 'error');
        }
    }

    updatePlayButton() {
        const playBtn = document.getElementById('play-btn');
        if (!playBtn) return;
        if (this.state.isPlaying) {
            playBtn.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>';
        } else {
            playBtn.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
        }
    }

    togglePlayback() {
        this.invoke('toggle_playback').catch(e => {
            console.error('Toggle playback failed:', e);
            showNotification('재생 제어 실패', 'error');
        });
    }

    handleSeek(pct) {
        this.state.isSeeking = true;
        const targetTime = (pct / 100) * this.state.duration;
        this.state.currentTime = targetTime;
        this.updateTimeDisplay();
        this.drawWaveform();
        
        // 실시간 탐색 성능을 위해 쓰로틀링 없이 즉시 연동 (백엔드 부담 확인 필요)
        const posMs = Math.floor(targetTime * 1000);
        this.invoke('seek_to', { positionMs: posMs }).catch(() => {});
    }

    finishSeek() {
        this.state.isSeeking = false;
    }

    /**
     * 5. Renderer & Interactive UI: High-performance Drawing & Side-sync
     */
    animate() {
        // Now handled by 'timeupdate' event, but can be used for smooth UI if needed
    }

    syncSidebar() {
        const cur = this.state.currentTime;
        const segments = this.state.segments;
        const container = document.getElementById('lyric-lines-container');
        if (!container) return;
        
        let activeIdx = -1;
        if (this.state.isSyncMode) {
            activeIdx = this.state.currentSyncIndex;
        } else {
            activeIdx = segments.findIndex(s => cur >= s.start && cur <= s.end);
        }
        
        const items = container.querySelectorAll('.lyric-line-item');
        items.forEach((item, idx) => {
            if (idx === activeIdx) {
                if (!item.classList.contains('active')) {
                    item.classList.add('active');
                    // Manual container scroll instead of scrollIntoView to prevent window scroll
                    const containerHeight = container.offsetHeight;
                    const itemTop = item.offsetTop;
                    const itemHeight = item.offsetHeight;
                    container.scrollTo({
                        top: itemTop - (containerHeight / 2) + (itemHeight / 2),
                        behavior: 'smooth'
                    });
                }
            } else {
                item.classList.remove('active');
            }
        });
    }

    renderLyricList() {
        const container = document.getElementById('lyric-lines-container');
        if (!container) return;
        container.innerHTML = '';
        
        this.state.segments.forEach((seg, idx) => {
            const div = document.createElement('div');
            const isSyncing = this.state.isSyncMode && idx === this.state.currentSyncIndex;
            div.className = `lyric-line-item \${isSyncing ? 'syncing' : ''}`;
            div.innerHTML = `
                <div style="display: flex; justify-content: space-between; align-items: center;">
                    <div class="time-range">${this.formatTime(seg.start)} - ${this.formatTime(seg.end)}</div>
                    <button class="del-line-btn" data-index="${idx}" style="background:transparent; border:none; color:#ef4444; font-size:1.1rem; cursor:pointer; opacity:0; transition:opacity 0.2s;">&times;</button>
                </div>
                <div class="lyric-text" data-index="${idx}">${seg.text}</div>
            `;
            
            // Interaction: Show delete button on hover
            div.onmouseenter = () => div.querySelector('.del-line-btn').style.opacity = '1';
            div.onmouseleave = () => div.querySelector('.del-line-btn').style.opacity = '0';
            
            // Interaction: Delete line
            div.querySelector('.del-line-btn').onclick = (e) => {
                e.stopPropagation();
                this.state.segments.splice(idx, 1);
                this.renderLyricList();
                this.drawWaveform();
            };
            
            // Interaction: Seek on click
            div.onclick = (e) => {
                if (e.target.contentEditable === "true") return;
                this.handleSeek((seg.start / this.state.duration) * 100);
            };

            // Interaction: Double click to edit
            const textEl = div.querySelector('.lyric-text');
            textEl.ondblclick = (e) => {
                e.stopPropagation();
                textEl.contentEditable = "true";
                textEl.focus();
            };

            textEl.onblur = () => {
                textEl.contentEditable = "false";
                this.state.segments[idx].text = textEl.innerText.trim();
            };

            textEl.onkeydown = (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    textEl.blur();
                }
            };

            container.appendChild(div);
        });
        document.getElementById('line-count').innerText = `${this.state.segments.length} lines`;
    }

    handleAddLine() {
        if (!this.state.audioTag.src) return;
        const lastEnd = this.state.segments.length > 0 ? this.state.segments[this.state.segments.length - 1].end : 0;
        const newStart = lastEnd;
        const newEnd = Math.min(newStart + 2, this.state.duration);
        
        this.state.segments.push({
            start: newStart,
            end: newEnd,
            text: '새 가사 줄'
        });
        this.renderLyricList();
        this.drawWaveform();
    }

    // --- Manual Sync Logic ---
    
    handleManualSyncInit() {
        if (this.state.isSyncMode) {
            this.state.isSyncMode = false;
            document.getElementById('manual-sync-btn').innerText = '수동 정렬 시작';
            document.getElementById('manual-sync-btn').style.background = 'rgba(16, 185, 129, 0.1)';
            document.getElementById('sync-tap-btn').style.display = 'none';
            return;
        }

        const lyrics = document.getElementById('lyrics-input').value.trim();
        if (!lyrics) {
            showNotification('가사를 먼저 입력해주세요.', 'error');
            return;
        }

        const lines = lyrics.split('\n').map(l => l.trim()).filter(l => l.length > 0);
        this.state.segments = lines.map(text => ({
            start: 0,
            end: 0,
            text: text
        }));

        this.state.isSyncMode = true;
        this.state.currentSyncIndex = 0;
        
        document.getElementById('manual-sync-btn').innerText = '수동 정렬 중단';
        document.getElementById('manual-sync-btn').style.background = 'rgba(239, 68, 68, 0.2)';
        document.getElementById('sync-tap-btn').style.display = 'block';
        document.getElementById('save-lrc-btn').style.display = 'block';
        
        this.renderLyricList();
        this.drawWaveform();
        showNotification('수동 정렬 모드 활성화. 재생 중 Space를 눌러 시작점을 찍으세요.', 'info');
    }

    handleSyncTap() {
        if (!this.state.isSyncMode || !this.state.isPlaying) return;
        
        const idx = this.state.currentSyncIndex;
        if (idx >= this.state.segments.length) {
            showNotification('모든 정렬이 완료되었습니다.', 'success');
            return;
        }

        const currentTime = this.state.currentTime;
        this.state.segments[idx].start = currentTime;
        if (idx > 0) this.state.segments[idx - 1].end = currentTime;
        this.state.segments[idx].end = this.state.duration;

        this.state.currentSyncIndex++;
        this.renderLyricList();
        this.drawWaveform();
        this.syncSidebar();
    }

    async saveLyrics() {
        if (this.state.segments.length === 0) return;
        const trackPath = document.getElementById('track-select').value;
        if (!trackPath) return showNotification('음원을 선택해주세요.', 'error');

        try {
            let lrc = '';
            this.state.segments.forEach(seg => {
                const t = seg.start * 1000;
                const m = Math.floor(t / 60000);
                const s = Math.floor((t % 60000) / 1000);
                const ms = Math.floor((t % 1000) / 10);
                lrc += `[${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}.${ms.toString().padStart(2, '0')}] ${seg.text}\n`;
            });

            await this.invoke('save_lrc_file', { audioPath: trackPath, content: lrc });
            showNotification('LRC 파일이 저장되었습니다.', 'success');
        } catch (err) {
            showNotification(`저장 실패: ${err}`, 'error');
        }
    }

    /**
     * 5. Renderer & Interactive UI: High-performance Drawing & Drag-logic
     */
    drawWaveform() {
        if (!this.ctx) return;
        const { width, height } = this.canvas;
        this.ctx.clearRect(0, 0, width, height);

        // A. Draw Segments (Background Blocks)
        if (this.state.duration > 0) {
            this.state.segments.forEach((seg, idx) => {
                const xStart = (seg.start / this.state.duration) * width;
                const xEnd = (seg.end / this.state.duration) * width;
                
                this.ctx.fillStyle = (this.state.currentTime >= seg.start && this.state.currentTime <= seg.end) 
                    ? 'rgba(74, 158, 255, 0.3)' 
                    : 'rgba(74, 158, 255, 0.1)';
                this.ctx.fillRect(xStart, 0, xEnd - xStart, height);
                
                this.ctx.strokeStyle = 'rgba(74, 158, 255, 0.5)';
                this.ctx.beginPath();
                this.ctx.moveTo(xStart, 0); this.ctx.lineTo(xStart, height);
                this.ctx.moveTo(xEnd, 0);   this.ctx.lineTo(xEnd, height);
                this.ctx.stroke();
            });
        }

        // B. Draw Waveform (Fast! Using pre-calc buckets from backend)
        if (this.state.waveformPoints) {
            const points = this.state.waveformPoints;
            this.ctx.beginPath();
            this.ctx.strokeStyle = 'rgba(255, 255, 255, 0.7)';
            this.ctx.lineWidth = 1;
            
            for (let i = 0; i < width; i++) {
                const pointIdx = Math.floor((i / width) * points.length);
                const p = points[pointIdx]; // p is [min, max] tuple from Rust
                if (!p) continue;
                // Apply scaling (0.8) to keep peaks within visual bounds
                const scale = 0.8;
                this.ctx.moveTo(i, (1 + p[0] * scale) * height / 2);
                this.ctx.lineTo(i, (1 + p[1] * scale) * height / 2);
            }
            this.ctx.stroke();
        }

        // C. Playhead
        if (this.state.duration > 0) {
            const xPlay = (this.state.currentTime / this.state.duration) * width;
            this.ctx.strokeStyle = '#ff4a4a';
            this.ctx.lineWidth = 2;
            this.ctx.beginPath();
            this.ctx.moveTo(xPlay, 0);
            this.ctx.lineTo(xPlay, height);
            this.ctx.stroke();
        }
    }

    setupCanvasListeners() {
        let isDragging = false;
        let dragTarget = null; // { idx, type: 'start'|'end' }

        this.canvas.onmousedown = (e) => {
            const rect = this.canvas.getBoundingClientRect();
            const x = e.clientX - rect.left;
            const time = (x / rect.width) * this.state.duration;
            
            // Find if we clicked near a boundary (threshold 10px)
            const threshold = 10;
            for (let i = 0; i < this.state.segments.length; i++) {
                const seg = this.state.segments[i];
                const xStart = (seg.start / this.state.duration) * rect.width;
                const xEnd = (seg.end / this.state.duration) * rect.width;
                
                if (Math.abs(x - xStart) < threshold) {
                    isDragging = true; dragTarget = { idx: i, type: 'start' }; break;
                }
                if (Math.abs(x - xEnd) < threshold) {
                    isDragging = true; dragTarget = { idx: i, type: 'end' }; break;
                }
            }
        };

        window.onmousemove = (e) => {
            if (!isDragging || !dragTarget) return;
            const rect = this.canvas.getBoundingClientRect();
            const x = Math.max(0, Math.min(e.clientX - rect.left, rect.width));
            const newTime = (x / rect.width) * this.state.duration;
            
            const seg = this.state.segments[dragTarget.idx];
            
            // --- Overlap Prevention Logic ---
            if (dragTarget.type === 'start') {
                const minTime = dragTarget.idx > 0 ? this.state.segments[dragTarget.idx - 1].end : 0;
                const maxTime = seg.end - 0.01;
                seg.start = Math.max(minTime, Math.min(newTime, maxTime));
            } else {
                const minTime = seg.start + 0.01;
                const maxTime = dragTarget.idx < this.state.segments.length - 1 
                    ? this.state.segments[dragTarget.idx + 1].start 
                    : this.state.duration;
                seg.end = Math.max(minTime, Math.min(newTime, maxTime));
            }
            
            this.drawWaveform();
            this.renderLyricList(); // Update timestamps in sidebar
        };

        window.onmouseup = () => {
            isDragging = false; dragTarget = null;
        };
    }

    // --- Helpers ---
    formatTime(sec) {
        if (!sec || isNaN(sec)) return '00:00';
        const m = Math.floor(sec / 60);
        const s = Math.floor(sec % 60);
        return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
    }

    resizeCanvas() {
        if (!this.canvas || !this.canvas.parentElement) return;
        const rect = this.canvas.parentElement.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) {
            // Retry if layout not ready
            setTimeout(() => this.resizeCanvas(), 100);
            return;
        }
        this.canvas.width = rect.width;
        this.canvas.height = rect.height;
        this.drawWaveform();
    }

    handleSeek(value) {
        if (!this.state.audioTag.src) return;
        const time = (value / 100) * this.state.duration;
        this.state.audioTag.currentTime = time;
        this.state.currentTime = time;
        this.updateTimeDisplay();
        this.drawWaveform();
    }

    handlePlaybackEnd() {
        this.state.currentTime = 0;
        this.pause();
        this.updateTimeDisplay();
        this.drawWaveform();
    }

    updateTimeDisplay() {
        const display = document.getElementById('time-display');
        const seekBar = document.getElementById('seek-bar');
        if (display) {
            display.innerText = `${this.formatTime(this.state.currentTime)} / ${this.formatTime(this.state.duration)}`;
        }
        if (seekBar && !this.state.isSeeking) {
            const pct = this.state.duration > 0 ? (this.state.currentTime / this.state.duration) * 100 : 0;
            seekBar.value = pct;
        }
        this.syncSidebar();
    }
}
