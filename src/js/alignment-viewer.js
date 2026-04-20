import { showNotification, getThumbnailUrl } from './utils.js';
import { invoke, listen } from './tauri-bridge.js';
import { state } from './state.js';

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
            isSyncMode: false
        };

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
                            <div id="waveform-loader" style="display: none; position: absolute; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0, 0, 0, 0.7); flex-direction: column; justify-content: center; align-items: center; z-index: 10; border-radius: 8px;">
                                <div class="loader-spinner" style="position: relative; width: 48px; height: 48px; margin-bottom: 12px;">
                                    <svg viewBox="0 0 24 24" width="48" height="48" fill="none" stroke="#4a9eff" stroke-width="3" style="animation: waveform-spin 1s linear infinite;">
                                        <circle cx="12" cy="12" r="10" stroke-opacity="0.2" />
                                        <path d="M12 2a10 10 0 0 1 10 10" />
                                    </svg>
                                </div>
                                <div id="loader-text" style="color: white; font-size: 0.9rem; font-weight: 500;">소리 데이터 준비 중...</div>
                                <div id="loader-progress" style="margin-top: 8px; color: #4a9eff; font-family: monospace; font-size: 0.8rem; display: none;">0%</div>
                                <style>
                                    @keyframes waveform-spin { 100% { transform: rotate(360deg); } }
                                </style>
                            </div>
                        </div>
                        <div class="seek-bar-container" style="padding: 0; margin-top: -2px; margin-bottom: 4px;">
                            <input type="range" id="seek-bar" class="seek-bar" value="0" step="0.1" style="width: 100%; margin: 0;">
                        </div>
                        <div class="sync-controls-panel">
                            <div class="sync-bottom-row">
                                <button id="play-btn" class="sync-ctrl-btn circle-btn" title="재생/일시정지">
                                    <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
                                </button>
                                <button id="sync-tap-btn" class="sync-ctrl-btn tap-btn">
                                    <span class="tap-label">TAP (Space)</span>
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
                            <h3>가사 정렬 결과</h3>
                            <button id="save-lrc-btn" class="sync-save-btn">저장</button>
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
        get('save-lrc-btn').onclick = () => this.saveLrc();

        const lyricsInput = get('lyrics-input');
        if (lyricsInput) {
            lyricsInput.addEventListener('input', () => this.parseLyrics());
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
                    const ms = Math.floor(this.state.currentTime * 1000);
                    // JSON.stringify에서는 BigInt를 처리할 수 없으므로 일반 Number를 사용합니다.
                    await this.invoke('seek_to', { positionMs: ms });
                }
            } catch (err) {
                console.error("Seek failed:", err);
            } finally {
                // 탐색이 완료되면 다시 재생 진행 상태를 수신할 수 있도록 변경
                setTimeout(() => { 
                    this.state.isSeeking = false; 
                }, 100);
            }
        });

        // 파형 캔버스 클릭 시 이동하는 로직 추가
        if (this.canvas) {
            this.canvas.addEventListener('mousedown', (e) => {
                if (this.state.duration <= 0) return;
                const rect = this.canvas.getBoundingClientRect();
                const x = e.clientX - rect.left;
                const ratio = Math.max(0, Math.min(1, x / rect.width));
                
                this.state.isSeeking = true;
                this.state.currentTime = ratio * this.state.duration;
                this.updateTimeDisplay();
                this.drawWaveform();
            });

            this.canvas.addEventListener('mouseup', async () => {
                if (!this.state.isSeeking) return;
                try {
                    const ms = Math.floor(this.state.currentTime * 1000);
                    await this.invoke('seek_to', { positionMs: ms });
                } catch (err) {
                    console.error("Seek failed:", err);
                } finally {
                    setTimeout(() => { 
                        this.state.isSeeking = false; 
                    }, 100);
                }
            });
        }

        window.onkeydown = (e) => {
            if (e.code === 'Space') {
                e.preventDefault();
                this.handleTap();
            }
        };
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
        if (loaderText) loaderText.innerText = '오디오 준비 중...';
        if (loaderProgress) loaderProgress.style.display = 'none';

        try {
            console.log("[Alignment] Loading audio:", path);
            // Get duration immediately from backend
            const ms = await this.invoke('play_track', { path, durationMs: 0, playNow: false });
            console.log("[Alignment] play_track success, duration:", ms);
            this.state.duration = ms / 1000;
            this.updateTimeDisplay();

            // Try to load existing LRC file (가사 우선 로드)
            try {
                const lrcContent = await this.invoke('load_lrc_file', { audioPath: path });
                if (lrcContent && lrcContent.trim()) {
                    this.parseLrcString(lrcContent);
                }
                // 파일이 없거나 비어있는 경우 기존 가사를 유지합니다.
            } catch (err) {
                console.log("[Alignment] LRC load failed or not found:", err);
                // 기존 가사를 유지하며 수동 작업을 진행할 수 있게 합니다.
            }

            this.drawWaveform();

            // Background waveform (파형 후순위 비동기 로드)
            if (loaderText) loaderText.innerText = '파형 생성 중...';
            
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
                if (loader) loader.style.display = 'none';
            });

        } catch (e) {
            console.error("[Alignment] loadAudio general failure:", e);
            this.state.isProcessing = false;
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

        // 1. Segments
        this.state.segments.forEach((seg, idx) => {
            const x1 = (seg.start / this.state.duration) * width;
            const x2 = (seg.end / this.state.duration) * width;
            this.ctx.fillStyle = (idx === this.state.currentSyncIndex - 1) ? 'rgba(74, 158, 255, 0.3)' : 'rgba(74, 158, 255, 0.1)';
            this.ctx.fillRect(x1, 0, x2 - x1, height);
        });

        // 2. Waveform
        if (this.state.waveformPoints) {
            this.ctx.beginPath();
            this.ctx.strokeStyle = 'rgba(255,255,255,0.2)';
            const points = this.state.waveformPoints;
            for (let i = 0; i < width; i++) {
                const idx = Math.floor((i / width) * points.length);
                const p = points[idx];
                if (p) {
                    this.ctx.moveTo(i, (1 + p[0]) * height / 2);
                    this.ctx.lineTo(i, (1 + p[1]) * height / 2);
                }
            }
            this.ctx.stroke();
        }

        // 3. Playhead
        if (this.state.duration > 0) {
            const px = (this.state.currentTime / this.state.duration) * width;
            this.ctx.strokeStyle = '#ef4444';
            this.ctx.lineWidth = 2;
            this.ctx.beginPath();
            this.ctx.moveTo(px, 0); this.ctx.lineTo(px, height);
            this.ctx.stroke();
        }
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

    parseLrcString(lrcContent) {
        const lines = lrcContent.split('\n');
        const segments = [];
        let rawLyrics = [];
        const timeRegex = /\[(\d{2}):(\d{2}\.\d{2,3})\]/;
        
        lines.forEach(line => {
            const match = timeRegex.exec(line);
            if (match) {
                const min = parseInt(match[1]);
                const sec = parseFloat(match[2]);
                const timeStr = match[0];
                const text = line.replace(timeStr, '').trim();
                segments.push({ text, start: min * 60 + sec, end: 0 });
                rawLyrics.push(text);
            } else if (line.trim()) {
                segments.push({ text: line.trim(), start: 0, end: 0 });
                rawLyrics.push(line.trim());
            }
        });
        
        // Calculate end times
        for (let i = 0; i < segments.length - 1; i++) {
            if (segments[i].start > 0 && segments[i+1].start > 0) {
                segments[i].end = segments[i+1].start;
            } else {
                segments[i].end = 0;
            }
        }
        if (segments.length > 0) {
            segments[segments.length - 1].end = this.state.duration > 0 ? this.state.duration : 0;
        }

        this.state.segments = segments;
        // The first line without a start time is the sync index
        let nextIdx = segments.findIndex(s => s.start === 0);
        if (nextIdx === -1) nextIdx = segments.length;
        this.state.currentSyncIndex = nextIdx;
        
        const inputElement = document.getElementById('lyrics-input');
        if (inputElement) inputElement.value = rawLyrics.join('\n');
        
        this.state.isSyncMode = true;
        this.renderLyricList();
    }

    parseLyrics() {
        const lyrics = document.getElementById('lyrics-input').value.trim();
        if (!lyrics) {
            this.state.segments = [];
            this.state.currentSyncIndex = 0;
            this.renderLyricList();
            return;
        }

        const oldSegments = this.state.segments || [];
        const newLines = lyrics.split('\n').filter(l => l.trim());
        
        const newSegments = newLines.map(text => {
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
    }

    handleTap() {
        // 일시정지 상태에서도 수동으로 찍을 수 있도록 허용 (단, 음원은 로드되어 있어야 함)
        if (this.state.duration <= 0) return;
        const idx = this.state.currentSyncIndex;
        if (idx < 0 || idx >= this.state.segments.length) return;
        
        this.state.segments[idx].start = this.state.currentTime;
        if (idx > 0 && this.state.segments[idx - 1].start > 0) {
            // If the previous segment has a valid start time, set its end time
            this.state.segments[idx - 1].end = this.state.currentTime;
        }
        this.state.segments[idx].end = this.state.duration;
        this.state.currentSyncIndex++;
        this.renderLyricList();
    }

    renderLyricList() {
        const container = document.getElementById('lyric-lines-container');
        if (!container) return;
        container.innerHTML = this.state.segments.map((s, i) => `
            <div class="lyric-line-item" data-index="${i}">
                <span class="time-range" title="이 시간으로 재생 이동">${this.formatTime(s.start)}</span>
                <span class="lyric-text" title="이 가사 위치로 탐색 및 타겟 지정">${s.text}</span>
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

    async saveLrc() {
        if (!this.state.currentPath || !this.state.segments || this.state.segments.length === 0) {
            showNotification('저장할 가사 데이터가 없습니다.', 'error');
            return;
        }
        try {
            const lrcLines = this.state.segments.map(s => {
                const min = Math.floor(s.start / 60).toString().padStart(2, '0');
                const sec = (s.start % 60).toFixed(2).padStart(5, '0');
                return `[${min}:${sec}]${s.text}`;
            });
            const content = lrcLines.join('\n');
            await this.invoke('save_lrc_file', { audioPath: this.state.currentPath, content });
            showNotification('LRC 파일이 성공적으로 저장되었습니다.', 'success');
        } catch (err) {
            console.error(err);
            showNotification('LRC 저장 실패: ' + err, 'error');
        }
    }
}
