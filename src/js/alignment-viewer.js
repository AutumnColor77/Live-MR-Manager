import { showNotification } from './utils.js';
import { invoke, listen } from './tauri-bridge.js';

/**
 * ForcedAlignmentViewer (v15 Refactored)
 * A modular controller that orchestrates Audio engine, UI rendering, and AI services.
 * Strictly preserves the premium design specified by the user.
 */
export class ForcedAlignmentViewer {
    constructor(containerId) {
        this.container = document.getElementById(containerId);
        
        // --- State Management ---
        this.state = {
            audioContext: new (window.AudioContext || window.webkitAudioContext)(),
            audioBuffer: null,
            duration: 0,
            currentTime: 0,
            isPlaying: false,
            alignmentData: null,
            segments: [],
            isProcessing: false,
            progress: 0
        };

        this.tuningParams = {
            blank: 0.0,
            rep: 0.0,
            penalty: -0.05
        };

        this.animationId = null;

        // --- Initialize ---
        this.initUI();
        
        // Using safe bridge
        this.invoke = invoke;
        this.setupListeners();
        this.setupCanvasListeners();
        this.loadTrackList();
        this.loadModelList();

        window.addEventListener('resize', () => this.resizeCanvas());
    }

    /**
     * 1. View: Initialize HTML based on the v15 CSS Specification
     */
    initUI() {
        if (!this.container) return;
        this.container.innerHTML = `
            <div class="alignment-container">
                <!-- Left: Lyrics Input & Model Selection -->
                <aside class="lyric-input-column">
                    <div class="alignment-card">
                        <section>
                            <span class="alignment-label">가사 입력 (원고)</span>
                            <div class="track-select-row">
                                <span class="alignment-sub-label">모델:</span>
                                <select id="model-select" class="track-select">
                                    <option value="">모델을 스캔 중...</option>
                                </select>
                            </div>
                            <div class="track-select-row">
                                <span class="alignment-sub-label">음원:</span>
                                <select id="track-select" class="track-select">
                                    <option value="">음원을 선택하세요...</option>
                                </select>
                                <button id="refresh-tracks-btn" class="run-btn" style="min-width: 32px; padding: 0;">↻</button>
                            </div>
                        </section>

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
난 아무도 아무것도 기억이 없네

빗속을 뛰었던것 같고 
울었던것 같고 
너에게 애원한것 같고 
울었던것 같고 
난 아무도 아무것도 기억이 없네</textarea>

                        <div style="display: flex; gap: 8px; margin-top: 8px;">
                            <button id="run-alignment-btn" class="run-btn primary-btn" style="flex: 1; height: 40px; font-size: 1rem;">
                                AI 가사 정렬 시작
                            </button>
                        </div>

                        <div class="alignment-status-card">
                            <div style="display: flex; justify-content: space-between; font-size: 0.8rem; font-weight: 700;">
                                <span>정렬 상태</span>
                                <span id="progress-val">0%</span>
                            </div>
                            <div class="progress-track">
                                <div id="scan-progress-bar" class="progress-fill"></div>
                            </div>
                        </div>
                    </div>
                </aside>

                <!-- Center: Primary Timeline Visualization -->
                <main class="alignment-main">
                    <div class="alignment-card waveform-card">
                        <div class="card-header">
                            <h3>오디오 타임라인 정렬</h3>
                        </div>
                        
                        <div class="waveform-canvas-container">
                            <canvas id="waveform-canvas"></canvas>
                        </div>

                        <div class="player-controls-mini">
                            <div class="seekbar-row">
                                <input type="range" id="seek-bar" class="mini-seekbar" min="0" max="100" value="0">
                            </div>

                            <div class="player-actions-bar">
                                <div id="play-btn" class="play-circle-btn">
                                    <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
                                        <path d="M8 5v14l11-7z" />
                                    </svg>
                                </div>
                                <div class="time-display" id="time-display">0:00 / 0:00</div>
                            </div>
                        </div>

                        <!-- New Tuning Section -->
                        <div class="vad-tuning-section">
                            <div class="tuning-group">
                                <span class="alignment-sub-label">공백(Blank) 패널티: <b id="blank-val">0.00</b></span>
                                <input type="range" id="blank-slider" class="mini-seekbar" min="-10.0" max="10.0" step="0.5" value="0.00">
                            </div>
                            <div class="tuning-group">
                                <span class="alignment-sub-label">반복(Rep) 억제: <b id="rep-val">0.00</b></span>
                                <input type="range" id="rep-slider" class="mini-seekbar" min="-20.0" max="0.0" step="0.5" value="0.00">
                            </div>
                        </div>
                    </div>

                    <!-- Detail Analysis Panel (Integrated below waveform) -->
                    <div id="analysis-panel" class="alignment-card analysis-card" style="margin-top: 16px;">
                        <div class="card-header" style="flex-direction: row; justify-content: space-between; padding-bottom: 20px;">
                            <h3 style="font-size: 1rem;">AI 정밀 분석 및 보정</h3>
                            <div class="analysis-controls" style="display: flex; gap: 20px; align-items: center;">
                                <div class="tuning-group" style="min-width: 160px;">
                                    <span class="alignment-sub-label">전이 패널티: <b id="penalty-val">-0.05</b></span>
                                    <input type="range" id="penalty-slider" class="mini-seekbar" min="-50.0" max="0" step="0.1" value="-0.05">
                                </div>
                                <button id="re-align-btn" class="run-btn" style="height: 32px; padding: 0 12px; font-size: 0.75rem; background: rgba(79, 70, 229, 0.2); border: 1px solid rgba(79, 70, 229, 0.4);">
                                    재정렬
                                </button>
                            </div>
                        </div>
                        <div class="analysis-table-container">
                            <table class="comparison-table">
                                <thead>
                                    <tr>
                                        <th>원본</th>
                                        <th>AI 인식</th>
                                        <th>상태</th>
                                    </tr>
                                </thead>
                                <tbody id="analysis-table-body">
                                    <!-- Comparison data injected here -->
                                </tbody>
                            </table>
                        </div>
                    </div>
                </main>

                <!-- Right: Result Lyrics List -->
                <aside class="lyric-sidebar">
                    <div class="alignment-card">
                        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;">
                            <span class="alignment-label">정렬 결과</span>
                            <button id="add-line-btn" class="run-btn" style="padding: 4px 10px; font-size: 0.75rem;">+ 줄 추가</button>
                        </div>
                        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
                            <span id="line-count" class="alignment-sub-label">0 lines</span>
                        </div>
                        <div id="lyric-lines-container" class="lyric-lines-list">
                            <div style="color: #64748b; font-size: 0.9rem; text-align: center; margin-top: 40px;">음원과 가사를 선택하고 실행하세요.</div>
                        </div>
                    </div>
                </aside>
            </div>
        `;
        
        this.canvas = document.getElementById('waveform-canvas');
        this.ctx = this.canvas.getContext('2d');
        this.resizeCanvas();
    }

    /**
     * 2. Interaction: Centralized Event Subscriptions
     */
    setupListeners() {
        document.getElementById('refresh-tracks-btn').onclick = () => this.loadTrackList();
        document.getElementById('run-alignment-btn').onclick = () => this.handleRunAlignment();
        document.getElementById('add-line-btn').onclick = () => this.handleAddLine();
        document.getElementById('play-btn').onclick = () => this.togglePlayback();
        document.getElementById('seek-bar').oninput = (e) => this.handleSeek(e.target.value);
        
        // Immediate Linkage: Load audio when track is selected
        document.getElementById('track-select').onchange = (e) => {
            if (e.target.value) this.loadAudio(e.target.value);
        };

        // Tuning sliders
        document.getElementById('blank-slider').oninput = (e) => {
            const val = parseFloat(e.target.value);
            this.tuningParams.blank = val;
            document.getElementById('blank-val').innerText = val.toFixed(2);
            this.handlePenaltyChange();
        };
        document.getElementById('rep-slider').oninput = (e) => {
            const val = parseFloat(e.target.value);
            this.tuningParams.rep = val;
            document.getElementById('rep-val').innerText = val.toFixed(2);
            this.handlePenaltyChange();
        };

        // Tauri Backend Listeners
        listen('alignment-progress', (event) => {
            const val = typeof event.payload === 'number' ? event.payload : (event.payload?.progress ?? 0);
            this.updateProgress(val);
        });

        // Penalty slider (Real-time update with debounce)
        document.getElementById('penalty-slider').oninput = (e) => {
            const val = parseFloat(e.target.value);
            this.tuningParams.penalty = val;
            document.getElementById('penalty-val').innerText = val.toFixed(2);
            this.handlePenaltyChange();
        };

        // Re-align button in panel
        document.getElementById('re-align-btn').onclick = () => this.handleRunAlignment();
    }

    /**
     * 3. Service Layer: Tauri Command Communication
     */
    async loadModelList() {
        const select = document.getElementById('model-select');
        if (!select) return;
        select.innerHTML = '<option value="">스캔 중...</option>';
        try {
            const models = await this.invoke('get_model_list');
            select.innerHTML = '';
            if (!models || models.length === 0) {
                select.innerHTML = '<option value="">모델 없음</option>';
                return;
            }
            for (const entry of models) {
                const pipeIdx = entry.indexOf('|');
                const label    = pipeIdx >= 0 ? entry.slice(0, pipeIdx)    : entry;
                const filename = pipeIdx >= 0 ? entry.slice(pipeIdx + 1)   : entry;
                const opt = new Option(label, filename);
                select.appendChild(opt);
            }
        } catch (err) {
            console.error('[Alignment] loadModelList error:', err);
            select.innerHTML = `<option value="">오류: ${err}</option>`;
        }
    }

    // Debounce timer for slider
    penaltyTimer = null;

    async handlePenaltyChange() {
        if (this.penaltyTimer) clearTimeout(this.penaltyTimer);
        
        this.penaltyTimer = setTimeout(async () => {
            if (!this.state.alignmentData) return; // Need at least one run first
            
            try {
                console.log(`[Alignment] Requesting real-time tuning: penalty=\${this.tuningParams.penalty}, blank=\${this.tuningParams.blank}, rep=\${this.tuningParams.rep}`);
                // Use the fast tuning command
                const result = await this.invoke('apply_alignment_tuning', { 
                    penalty: parseFloat(this.tuningParams.penalty),
                    blankPenalty: parseFloat(this.tuningParams.blank),
                    repPenalty: parseFloat(this.tuningParams.rep)
                });
                
                // Update internal state and UI results (but NOT progress or loading state)
                this.state.alignmentData = result;
                this.state.segments = (result.lines || []).map(l => ({
                    start: l.start_ms / 1000.0,
                    end: l.end_ms / 1000.0,
                    text: l.text
                }));
                
                this.renderLyricList();
                this.renderAnalysisTable();
                this.drawWaveform();
            } catch (err) {
                console.error('[Alignment] Tuning failed:', err);
                // Silent fail for real-time slider to avoid notification spam
            }
        }, 80); // 80ms debounce for smoothness
    }

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
                // '07 숙취' 자동 선택 로직 추가
                if (t.name.includes('07 숙취')) {
                    opt.selected = true;
                    this.loadAudio(opt.value);
                }
                select.appendChild(opt);
            }
            if (select.options.length === 1) {
                select.innerHTML = '<option value="">보컬 파일 없음</option>';
            }
        } catch (err) {
            console.error('[Alignment] loadTrackList error:', err);
            select.innerHTML = `<option value="">오류: ${err}</option>`;
        }
    }

    async handleRunAlignment() {
        // --- Cancellation Handling ---
        if (this.state.isProcessing) {
            try {
                await this.invoke('cancel_forced_alignment');
                showNotification('정렬 작업 중단 중...', 'info');
            } catch (err) {
                console.error('Cancel failed:', err);
            }
            return;
        }

        const trackPath = document.getElementById('track-select').value;
        const lyrics = document.getElementById('lyrics-input').value;
        const modelName = document.getElementById('model-select').value;

        if (!trackPath || !lyrics.trim()) {
            showNotification('음원과 가사를 모두 선택/입력해주세요.', 'error');
            return;
        }

        try {
            this.state.isProcessing = true;
            this.updateButtonState();
            this.updateProgress(0);
            
            // Sync argument names with Rust alignment.rs:run_forced_alignment
            const result = await this.invoke('run_forced_alignment', {
                audioPath: trackPath,
                lyrics: lyrics,
                modelName: modelName,
                language: "ko",
                blankPenalty: parseFloat(this.tuningParams.blank),
                repPenalty: parseFloat(this.tuningParams.rep),
                transPenalty: parseFloat(this.tuningParams.penalty)
            });

            this.state.alignmentData = result;
            this.state.segments = (result.lines || []).map(l => ({
                start: l.start_ms / 1000.0,
                end: l.end_ms / 1000.0,
                text: l.text
            }));
            
            this.updateProgress(100);
            this.renderLyricList();
            this.renderAnalysisTable();
            showNotification('가사 정렬이 완료되었습니다.', 'success');
        } catch (err) {
            console.error('[Alignment Error] run_forced_alignment failed:', err);
            if (typeof err === 'string' && err.includes('취소')) {
                showNotification('정렬 작업이 중단되었습니다.', 'info');
            } else {
                showNotification(`정렬 실패: ${err}`, 'error');
            }
        } finally {
            this.state.isProcessing = false;
            this.updateButtonState();
        }
    }

    renderAnalysisTable() {
        const panel = document.getElementById('analysis-panel');
        const body = document.getElementById('analysis-table-body');
        if (!panel || !body || !this.state.alignmentData) return;

        panel.style.display = 'block';
        body.innerHTML = '';

        (this.state.alignmentData.lines || []).forEach(line => {
            const tr = document.createElement('tr');
            const original = line.text;
            const extracted = line.extracted_text || '(인식 불가)';
            const startSec = (line.start_ms / 1000).toFixed(2);
            const endSec = (line.end_ms / 1000).toFixed(2);
            
            let statusBadge = '<span class="badge badge-match">MATCH</span>';
            if (original.replace(/\s/g, '') !== extracted.replace(/\s/g, '')) {
                statusBadge = '<span class="badge badge-diff">DIFF</span>';
            }
            if (line.end_ms - line.start_ms > 10000) {
                statusBadge = '<span class="badge badge-error">LONG</span>';
            }

            tr.innerHTML = `
                <td style="color: white; font-weight: 500;">${original}</td>
                <td style="color: #94a3b8;">${extracted}</td>
                <td style="font-family: monospace; color: #818cf8;">${startSec}s - ${endSec}s</td>
                <td>${statusBadge}</td>
            `;

            tr.style.cursor = 'pointer';
            tr.onclick = () => this.seekToMs(line.start_ms);
            body.appendChild(tr);
        });
    }

    async seekToMs(ms) {
        if (!window.__TAURI__) return;
        try {
            await this.invoke('seek_to', { positionMs: BigInt(ms) });
        } catch (e) {
            console.error('Seek failed:', e);
        }
    }

    handleOpenCalibration() {
        showNotification('이제 하단 [AI 정밀 분석] 패널을 사용하세요.', 'info');
        const panel = document.getElementById('analysis-panel');
        if (panel) {
            panel.style.display = 'block';
            panel.scrollIntoView({ behavior: 'smooth' });
        }
    }

    /**
     * 4. Audio Engine: Bit-perfect playback & state sync
     */
    async loadAudio(path) {
        try {
            // convertFileSrc 대신 read_audio_file 사용 (%25 인코딩 폴더 문제 우회)
            const bytes = await this.invoke('read_audio_file', { path });
            const uint8 = new Uint8Array(bytes);
            const arrayBuffer = uint8.buffer;
            this.state.audioBuffer = await this.state.audioContext.decodeAudioData(arrayBuffer);
            this.state.duration = this.state.audioBuffer.duration;
            this.updateTimeDisplay();
            this.drawWaveform();
        } catch (err) {
            console.error('Audio load error:', err);
            showNotification(`오디오 로드 실패: ${err}`, 'error');
        }
    }

    togglePlayback() {
        if (!this.state.audioBuffer) return;
        this.state.isPlaying ? this.pause() : this.play();
    }

    play() {
        this.resumeContext();
        this.source = this.state.audioContext.createBufferSource();
        this.source.buffer = this.state.audioBuffer;
        this.source.connect(this.state.audioContext.destination);
        
        const offset = this.state.currentTime;
        this.source.start(0, offset);
        this.startTime = this.state.audioContext.currentTime - offset;
        this.state.isPlaying = true;
        
        const playBtn = document.getElementById('play-btn');
        if (playBtn) playBtn.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>';
        
        this.animate();
    }

    pause() {
        if (this.source) {
            this.source.stop();
            this.source = null;
        }
        this.state.isPlaying = false;
        
        const playBtn = document.getElementById('play-btn');
        if (playBtn) playBtn.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
        
        cancelAnimationFrame(this.animationId);
    }

    /**
     * 5. Renderer & Interactive UI: High-performance Drawing & Side-sync
     */
    animate() {
        if (!this.state.isPlaying) return;
        this.state.currentTime = this.state.audioContext.currentTime - this.startTime;
        this.updateTimeDisplay();
        this.syncSidebar();
        
        if (this.state.currentTime >= this.state.duration) {
            this.handlePlaybackEnd();
            return;
        }
        this.animationId = requestAnimationFrame(() => this.animate());
    }

    syncSidebar() {
        const cur = this.state.currentTime;
        const segments = this.state.segments;
        
        const activeIdx = segments.findIndex(s => cur >= s.start && cur <= s.end);
        
        document.querySelectorAll('.lyric-line-item').forEach((item, idx) => {
            if (idx === activeIdx) {
                if (!item.classList.contains('active')) {
                    item.classList.add('active');
                    item.scrollIntoView({ behavior: 'smooth', block: 'center' });
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
            div.className = 'lyric-line-item';
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
        if (!this.state.audioBuffer) return;
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

    /**
     * 5. Renderer & Interactive UI: High-performance Drawing & Drag-logic
     */
    drawWaveform() {
        if (!this.state.audioBuffer || !this.ctx) return;
        const { width, height } = this.canvas;
        const data = this.state.audioBuffer.getChannelData(0);
        const step = Math.ceil(data.length / width);
        
        this.ctx.clearRect(0, 0, width, height);

        // A. Draw Segments (Background Blocks)
        this.state.segments.forEach((seg, idx) => {
            const xStart = (seg.start / this.state.duration) * width;
            const xEnd = (seg.end / this.state.duration) * width;
            
            this.ctx.fillStyle = (this.state.currentTime >= seg.start && this.state.currentTime <= seg.end) 
                ? 'rgba(74, 158, 255, 0.3)' 
                : 'rgba(74, 158, 255, 0.1)';
            this.ctx.fillRect(xStart, 0, xEnd - xStart, height);
            
            // Draw boundaries
            this.ctx.strokeStyle = 'rgba(74, 158, 255, 0.5)';
            this.ctx.beginPath();
            this.ctx.moveTo(xStart, 0); this.ctx.lineTo(xStart, height);
            this.ctx.moveTo(xEnd, 0);   this.ctx.lineTo(xEnd, height);
            this.ctx.stroke();
        });

        // B. Draw Waveform (Foreground)
        this.ctx.beginPath();
        this.ctx.strokeStyle = 'rgba(255, 255, 255, 0.7)';
        this.ctx.lineWidth = 1;
        for (let i = 0; i < width; i++) {
            let min = 1.0; let max = -1.0;
            for (let j = 0; j < step; j++) {
                const datum = data[(i * step) + j];
                if (datum < min) min = datum;
                if (datum > max) max = datum;
            }
            this.ctx.moveTo(i, (1 + min) * height / 2);
            this.ctx.lineTo(i, (1 + max) * height / 2);
        }
        this.ctx.stroke();

        // C. Playhead
        const xPlay = (this.state.currentTime / this.state.duration) * width;
        this.ctx.strokeStyle = '#fff';
        this.ctx.lineWidth = 2;
        this.ctx.beginPath();
        this.ctx.moveTo(xPlay, 0); this.ctx.lineTo(xPlay, height);
        this.ctx.stroke();
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

    animate() {
        if (!this.state.isPlaying) {
            this.drawWaveform(); // Keep drawing segments while paused
            return;
        }
        this.state.currentTime = this.state.audioContext.currentTime - this.startTime;
        this.updateTimeDisplay();
        this.syncSidebar();
        this.drawWaveform();
        
        if (this.state.currentTime >= this.state.duration) {
            this.handlePlaybackEnd();
            return;
        }
        this.animationId = requestAnimationFrame(() => this.animate());
    }

    updateTimeDisplay() {
        const timeEl = document.getElementById('time-display');
        if (!timeEl) return;
        const cur = this.formatTime(this.state.currentTime);
        const total = this.formatTime(this.state.duration);
        timeEl.innerText = `${cur} / ${total}`;
        
        const seekBar = document.getElementById('seek-bar');
        if (seekBar) {
            const progress = (this.state.currentTime / this.state.duration) * 100;
            seekBar.value = progress;
        }
    }

    updateProgress(percent) {
        const fill = document.getElementById('align-ai-progress-fill');
        const text = document.getElementById('align-ai-progress-text');
        
        if (fill) fill.style.width = `${percent}%`;
        if (text) text.innerText = `${Math.round(percent)}%`;
    }

    updateButtonState() {
        const btn = document.getElementById('run-alignment-btn');
        const wrapper = document.getElementById('align-progress-wrapper');
        
        if (this.state.isProcessing) {
            if (btn) {
                btn.innerText = '정렬 중단 (Cancel)';
                btn.classList.add('cancel-state');
                btn.style.background = 'rgba(239, 68, 68, 0.2)';
                btn.style.borderColor = 'rgba(239, 68, 68, 0.4)';
                btn.style.color = '#f87171';
            }
            if (wrapper) wrapper.style.display = 'block';
        } else {
            if (btn) {
                btn.innerText = 'AI 가사 정렬 시작';
                btn.classList.remove('cancel-state');
                btn.style.background = '';
                btn.style.borderColor = '';
                btn.style.color = '';
            }
            if (wrapper) wrapper.style.display = 'none';
        }
    }

    // --- Helpers ---
    formatTime(sec) {
        const m = Math.floor(sec / 60);
        const s = (sec % 60).toFixed(2);
        return `${m}:${s.padStart(5, '0')}`;
    }

    resizeCanvas() {
        if (!this.canvas) return;
        const rect = this.canvas.parentElement.getBoundingClientRect();
        this.canvas.width = rect.width;
        this.canvas.height = rect.height;
        this.drawWaveform();
    }

    handleSeek(progress) {
        const time = (progress / 100) * this.state.duration;
        this.state.currentTime = time;
        if (this.state.isPlaying) {
            this.pause();
            this.play();
        } else {
            this.updateTimeDisplay();
            this.drawWaveform();
        }
    }

    handlePlaybackEnd() {
        this.state.currentTime = 0;
        this.pause();
        this.updateTimeDisplay();
        this.drawWaveform();
    }

    async resumeContext() {
        if (this.state.audioContext.state === 'suspended') {
            await this.state.audioContext.resume();
        }
    }
}
