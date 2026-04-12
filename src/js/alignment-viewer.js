import { showNotification } from './utils.js';

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
            conf: 0.3,
            noise: 0.2
        };

        this.animationId = null;

        // --- Initialize ---
        this.initUI();
        
        if (window.__TAURI__) {
            this.invoke = window.__TAURI__.core.invoke;
            this.setupListeners();
            this.setupCanvasListeners();
            this.loadTrackList();
            this.loadModelList();
        }

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

                        <textarea id="lyrics-input" class="lyrics-textarea" placeholder="이곳에 노래 가사를 입력하세요..."></textarea>

                        <button id="run-alignment-btn" class="run-btn primary-btn" style="height: 40px; font-size: 1rem;">
                            AI 가사 정렬 시작
                        </button>

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

                        <!-- VAD Tuning Section -->
                        <div class="vad-tuning-section">
                            <div class="tuning-group">
                                <span class="alignment-sub-label">음성 신뢰도 (VAD): <b id="conf-val">0.30</b></span>
                                <input type="range" id="conf-slider" class="mini-seekbar" min="0" max="1" step="0.05" value="0.30">
                            </div>
                            <div class="tuning-group">
                                <span class="alignment-sub-label">노이즈 억제: <b id="noise-val">0.20</b></span>
                                <input type="range" id="noise-slider" class="mini-seekbar" min="0" max="1" step="0.05" value="0.20">
                            </div>
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
        document.getElementById('conf-slider').oninput = (e) => {
            this.tuningParams.conf = parseFloat(e.target.value);
            document.getElementById('conf-val').innerText = this.tuningParams.conf.toFixed(2);
        };
        document.getElementById('noise-slider').oninput = (e) => {
            this.tuningParams.noise = parseFloat(e.target.value);
            document.getElementById('noise-val').innerText = this.tuningParams.noise.toFixed(2);
        };

        // Tauri Backend Listeners
        window.__TAURI__.event.listen('alignment-progress', (event) => {
            const val = typeof event.payload === 'number' ? event.payload : (event.payload?.progress ?? 0);
            this.updateProgress(val);
        });
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
        const trackPath = document.getElementById('track-select').value;
        const lyrics = document.getElementById('lyrics-input').value;
        const modelName = document.getElementById('model-select').value;

        if (!trackPath || !lyrics.trim()) {
            showNotification('음원과 가사를 모두 선택/입력해주세요.', 'error');
            return;
        }

        try {
            this.state.isProcessing = true;
            this.updateProgress(0);
            
            // Sync argument names with Rust alignment.rs:run_forced_alignment
            const result = await this.invoke('run_forced_alignment', {
                audioPath: trackPath,
                lyrics: lyrics,
                modelName: modelName,
                language: "ko",
                vadsThreshold: parseFloat(this.tuningParams.conf),
                noiseReduction: parseFloat(this.tuningParams.noise)
            });

            this.state.alignmentData = result;
            this.state.segments = (result.lines || []).map(l => ({
                start: l.start_ms / 1000.0,
                end: l.end_ms / 1000.0,
                text: l.text
            }));
            
            this.renderLyricList();
            showNotification('가사 정렬이 완료되었습니다.', 'success');
        } catch (err) {
            showNotification(`정렬 실패: ${err}`, 'error');
        } finally {
            this.state.isProcessing = false;
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

    updateProgress(val) {
        const valEl = document.getElementById('progress-val');
        const barEl = document.getElementById('scan-progress-bar');
        if (valEl) valEl.innerText = `${Math.round(val)}%`;
        if (barEl) barEl.style.width = `${val}%`;
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
