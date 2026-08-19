/**
 * OBS overlay customization control listeners
 */
import { updateOverlayLyrics, updateOverlayStyle, getLanAddresses, getOverlayLanSetting, setOverlayLanSetting } from '../../overlay-api.js';
import { getLineVisibility, setLineVisibility } from '../../lrc-parser.js';

let cachedLanAddress = null;

/** 3줄 가사(원문/차음/번역) 표시 항목 체크박스 - 인앱 드로어/OBS 오버레이 각각
 *  독립적으로 설정(lrc-parser.js의 getLineVisibility/setLineVisibility, scope
 *  단위로 localStorage에 저장). 체크박스 자체는 어떤 백엔드 호출도 필요 없다 -
 *  실제 반영은 lyric-drawer.js가 다음 렌더링 때 최신 설정을 읽어간다. */
function initLyricLineVisibilityControls() {
  ['app', 'overlay'].forEach((scope) => {
    const current = getLineVisibility(scope);
    ['original', 'pronunciation', 'translation'].forEach((key) => {
      const checkbox = document.getElementById(`line-vis-${scope}-${key}`);
      if (!checkbox) return;
      checkbox.checked = !!current[key];
      checkbox.addEventListener('change', () => {
        setLineVisibility(scope, key, checkbox.checked);
      });
    });
  });
}

export function initOverlayListeners() {
  const overlayScale = document.getElementById('overlay-scale');
  const overlayScaleVal = document.getElementById('overlay-scale-val');
  const overlayFontSize = document.getElementById('overlay-font-size');
  const overlayFontSizeVal = document.getElementById('overlay-font-size-val');
  const overlayFontSizeRow = document.getElementById('overlay-font-size-row');
  const overlayFontSizeLabel = document.getElementById('overlay-font-size-label');
  const overlayAnimationRow = document.getElementById('overlay-animation-row');
  const overlayAnimationDirectionLabel = document.getElementById('overlay-animation-direction-label');
  const overlayQueueExpandField = document.getElementById('overlay-queue-expand-field');
  const overlayQueueExpandDirection = document.getElementById('overlay-queue-expand-direction');
  const overlayFont = document.getElementById('overlay-font');
  const overlayColor = document.getElementById('overlay-color');
  const overlayTextColor = document.getElementById('overlay-text-color');
  const overlayBgOpacity = document.getElementById('overlay-bg-opacity');
  const overlayBgOpacityVal = document.getElementById('overlay-bg-opacity-val');
  const overlayRounding = document.getElementById('overlay-rounding');
  const overlayRoundingVal = document.getElementById('overlay-rounding-val');
  const overlayBgColor = document.getElementById('overlay-bg-color');
  const overlayColorHex = document.getElementById('overlay-color-hex');
  const overlayTextColorHex = document.getElementById('overlay-text-color-hex');
  const overlayBgColorHex = document.getElementById('overlay-bg-color-hex');
  const overlayUrlDisplay = document.getElementById('overlay-url-display');
  const lyricsOverlayUrlDisplay = document.getElementById('lyrics-overlay-url-display');
  const lyricsViewUrlDisplay = document.getElementById('lyrics-view-url-display');
  const overlayIframe = document.getElementById('overlay-iframe');
  const overlayPreviewWrapper = document.querySelector('.overlay-preview-wrapper');
  const overlayPreviewStage = document.getElementById('overlay-preview-stage');
  const toggleOverlayForceVisible = document.getElementById('toggle-overlay-force-visible');
  const overlayAnimationDirection = document.getElementById('overlay-animation-direction');
  const toggleOverlayLan = document.getElementById('toggle-overlay-lan');
  const overlayLanStatus = document.getElementById('overlay-lan-status');
  const queueOverlayUrlDisplay = document.getElementById('queue-overlay-url-display');
  const overlayInfoHeaderSettings = document.getElementById('overlay-info-header-settings');
  const overlayQueueSettings = document.getElementById('overlay-queue-settings');
  const overlayDesignSettings = document.getElementById('overlay-design-settings');
  const toggleOverlayQueueVisible = document.getElementById('toggle-overlay-queue-visible');
  const toggleOverlayQueueForceVisible = document.getElementById('toggle-overlay-queue-force-visible');

  const syncCustomSelect = (dropdownId, value) => {
    const dropdown = document.getElementById(dropdownId);
    if (!dropdown || value == null) return;
    const selectedText = dropdown.querySelector('.selected-text');
    dropdown.querySelectorAll('.option-item').forEach((opt) => {
      const match = opt.dataset.value === value;
      opt.classList.toggle('selected', match);
      if (match && selectedText) selectedText.textContent = opt.textContent;
    });
  };

  const syncQueueExpandUi = (isQueue) => {
    if (overlayAnimationRow) overlayAnimationRow.classList.toggle('is-queue', isQueue);
    if (overlayQueueExpandField) overlayQueueExpandField.hidden = !isQueue;
    if (overlayAnimationDirectionLabel) {
      overlayAnimationDirectionLabel.textContent = isQueue ? '애니메이션 방향' : '등장 애니메이션 방향';
    }
    document.querySelector('.overlay-tab-container')?.classList.toggle('is-queue', isQueue);
  };
  const getPreviewMode = () => {
    const activeTab = document.querySelector('.preview-tab.active');
    const mode = activeTab?.dataset?.previewMode;
    if (mode === 'lyrics') return 'lyrics';
    if (mode === 'queue') return 'queue';
    return 'info';
  };

  const setOverlaySettingsPanelsVisibility = (mode) => {
    const isQueue = mode === 'queue';
    if (overlayInfoHeaderSettings) overlayInfoHeaderSettings.style.display = isQueue ? 'none' : 'block';
    if (overlayQueueSettings) overlayQueueSettings.style.display = isQueue ? 'block' : 'none';
    if (overlayDesignSettings) overlayDesignSettings.style.display = 'block';
    document.querySelector('.overlay-tab-container')?.setAttribute('data-preview-mode', mode);
    syncQueueExpandUi(isQueue);
  };

  const getStyleTarget = () => {
    const mode = getPreviewMode();
    if (mode === 'lyrics' || mode === 'queue') return mode;
    return 'info';
  };

  const getTargetDefaults = (target) => ({
    scale: 1.0,
    color: target === 'lyrics' ? 'ffffff' : '3b82f6',
    textColor: 'ffffff',
    bgOpacity: target === 'queue' ? 0.85 : 0.6,
    rounding: 20,
    bgColor: '0f0f14',
    font: 'Inter',
    animationDirection: 'left',
    fontSize: target === 'queue' ? 16 : 22,
    queueExpandDirection: 'both',
  });

  // 미리보기 스테이지는 대기열과 동일(1500×1000). OBS 실소스 크기는 가이드 문구 기준.
  const OBS_PREVIEW_SIZE = {
    info: { w: 1500, h: 1000 },
    lyrics: { w: 1500, h: 1000 },
    queue: { w: 1500, h: 1000 },
  };
  const PREVIEW_CARD_BASE = {
    info: { w: 400, h: 460 },
    lyrics: { w: 400, h: 460 },
    queue: { w: 400, h: 460 },
  };

  const previewSrc = (file, extra = '') => `${file}?preview=true${extra}`;

  const resizeOverlayPreview = () => {
    if (!overlayIframe || !overlayPreviewWrapper) return;
    const mode = getPreviewMode();
    const { w: canvasW, h: canvasH } = OBS_PREVIEW_SIZE[mode] || OBS_PREVIEW_SIZE.info;
    const card = PREVIEW_CARD_BASE[mode] || PREVIEW_CARD_BASE.info;
    const userScale = Math.max(0.5, parseFloat(overlayScale?.value) || 1);

    overlayPreviewWrapper.dataset.previewMode = mode;

    const pad = 80;
    const contentW = card.w * userScale + pad;
    const contentH = card.h * userScale + pad;
    const wrapperWidth = Math.max(1, overlayPreviewWrapper.clientWidth - 8);
    const wrapperHeight = Math.max(1, overlayPreviewWrapper.clientHeight - 8);
    const scale = Math.min(wrapperWidth / contentW, wrapperHeight / contentH);

    overlayIframe.style.width = `${canvasW}px`;
    overlayIframe.style.height = `${canvasH}px`;
    overlayIframe.style.position = 'absolute';
    overlayIframe.style.left = '50%';
    overlayIframe.style.top = '50%';
    overlayIframe.style.transformOrigin = 'center center';
    overlayIframe.style.transform = `translate(-50%, -50%) scale(${scale})`;
    overlayIframe.style.border = 'none';
    overlayIframe.style.background = 'transparent';
  };

  const setupPalette = (paletteId, colorInput, hexInput) => {
    const palette = document.getElementById(paletteId);
    if (!palette || !colorInput || !hexInput) return;

    const swatches = palette.querySelectorAll('.color-swatch');

    const updateSelection = (color) => {
      swatches.forEach(s => {
        if (s.dataset.color.toLowerCase() === color.toLowerCase()) {
          s.classList.add('selected');
        } else {
          s.classList.remove('selected');
        }
      });
      hexInput.value = color.replace('#', '').toLowerCase();
    };

    swatches.forEach(swatch => {
      swatch.addEventListener('click', () => {
        const color = swatch.dataset.color;
        colorInput.value = color;
        updateSelection(color);
        updateOverlaySettings();
      });
    });

    colorInput.addEventListener('input', () => {
      updateSelection(colorInput.value);
      updateOverlaySettings();
    });

    hexInput.addEventListener('input', (e) => {
      let val = e.target.value.replace(/[^0-9a-fA-F]/g, '');
      if (val.length === 6) {
        const color = `#${val}`;
        colorInput.value = color;
        updateSelection(color);
        updateOverlaySettings();
      }
    });

    return updateSelection;
  };

  const updateThemePalette = setupPalette('theme-palette', overlayColor, overlayColorHex);
  const updateTextPalette = setupPalette('text-palette', overlayTextColor, overlayTextColorHex);
  const updateBgPalette = setupPalette('bg-palette', overlayBgColor, overlayBgColorHex);

  const updateOverlaySettings = async (skipSave = false) => {
    if (!overlayScale || !overlayFont || !overlayColor || !overlayTextColor || !overlayUrlDisplay || !overlayIframe || !overlayBgOpacity || !overlayRounding || !overlayBgColor) return;

    const previewMode = getPreviewMode();
    const currentTarget = getStyleTarget();
    const usesFontSize = currentTarget === 'lyrics' || currentTarget === 'queue';

    const scale = parseFloat(overlayScale.value).toFixed(1);
    if (overlayScaleVal) overlayScaleVal.textContent = `${scale}x`;

    if (overlayFontSizeRow) overlayFontSizeRow.style.display = usesFontSize ? 'flex' : 'none';
    if (overlayFontSizeLabel) {
      overlayFontSizeLabel.textContent = currentTarget === 'queue' ? '대기열 글씨 크기' : '가사 글씨 크기';
    }
    if (overlayAnimationRow) overlayAnimationRow.style.display = 'flex';
    syncQueueExpandUi(currentTarget === 'queue');

    const fontSize = overlayFontSize
      ? (parseInt(overlayFontSize.value, 10) || (currentTarget === 'queue' ? 16 : 22))
      : 22;
    if (overlayFontSizeVal) overlayFontSizeVal.textContent = `${fontSize}px`;

    const font = overlayFont.value;
    const color = overlayColor.value.replace('#', '');
    const textColor = overlayTextColor.value.replace('#', '');

    const bgOpacity = parseFloat(overlayBgOpacity.value);
    if (overlayBgOpacityVal) overlayBgOpacityVal.textContent = `${Math.round(bgOpacity * 100)}%`;

    const rounding = parseFloat(overlayRounding.value);
    if (overlayRoundingVal) overlayRoundingVal.textContent = `${rounding}px`;

    const bgColor = overlayBgColor.value.replace('#', '');
    const isForceVisible = !!(toggleOverlayForceVisible && toggleOverlayForceVisible.checked);
    const animationDirection = overlayAnimationDirection?.value || 'left';
    const queueExpandDirection = overlayQueueExpandDirection?.value || 'both';
    const themeMode = document.documentElement.getAttribute('data-theme') || 'dark';

    if (!skipSave) {
      const saved = localStorage.getItem('overlay-settings');
      let config = {};
      try { config = JSON.parse(saved) || {}; } catch(e) {}

      config[currentTarget] = {
        scale, font, color, textColor, bgOpacity, rounding, bgColor, animationDirection, fontSize,
        ...(currentTarget === 'queue' ? { queueExpandDirection } : {}),
      };
      if (currentTarget !== 'queue') {
        config.isForceVisible = isForceVisible;
      }

      localStorage.setItem('overlay-settings', JSON.stringify(config));
    }

    // LAN 접속: 기본은 항상 localhost 표시. 토글이 켜져 있고 이 PC의 LAN
    // 주소를 찾았을 때만 그 주소로 바꿔 보여준다 (오버레이/가사 상태가
    // 네트워크에 노출된다는 점을 사용자가 명확히 인지한 상태에서만).
    const useLan = !!(toggleOverlayLan && toggleOverlayLan.checked);
    const host = (useLan && cachedLanAddress) ? cachedLanAddress : 'localhost';
    const infoUrl = `http://${host}:14202/overlay-info`;
    const lyricsUrl = `http://${host}:14202/overlay-lyrics`;
    const lyricsViewUrl = `http://${host}:14202/lyrics-view`;
    const queueUrl = `http://${host}:14202/queue`;
    if (overlayUrlDisplay) overlayUrlDisplay.textContent = infoUrl;
    if (lyricsOverlayUrlDisplay) lyricsOverlayUrlDisplay.textContent = lyricsUrl;
    if (lyricsViewUrlDisplay) lyricsViewUrlDisplay.textContent = lyricsViewUrl;
    if (queueOverlayUrlDisplay) queueOverlayUrlDisplay.textContent = queueUrl;

    if (overlayLanStatus) {
      if (useLan && !cachedLanAddress) {
        overlayLanStatus.textContent = '네트워크 주소를 찾지 못했습니다. 이 PC 주소로 표시합니다.';
      } else if (useLan) {
        overlayLanStatus.textContent =
          `켜짐 — ${cachedLanAddress} · 같은 네트워크의 다른 기기에서 접속할 수 있습니다. 공용 Wi-Fi에서는 끄세요. 앱을 다시 시작해야 적용됩니다.`;
      } else {
        overlayLanStatus.textContent = '꺼짐 — 이 PC에서만 접속할 수 있습니다.';
      }
    }

    const setupCopyBtn = (id, text) => {
      const btn = document.getElementById(id);
      if (btn) {
        btn.onclick = async () => {
          try {
            await navigator.clipboard.writeText(text);
            import('../../utils.js').then(m => m.showNotification("URL이 클립보드에 복사되었습니다.", "success"));
          } catch (err) { console.error("Failed to copy:", err); }
        };
      }
    };
    setupCopyBtn('btn-copy-overlay-url', infoUrl);
    setupCopyBtn('btn-copy-lyrics-overlay-url', lyricsUrl);
    setupCopyBtn('btn-copy-lyrics-view-url', lyricsViewUrl);
    setupCopyBtn('btn-copy-queue-overlay-url', queueUrl);

    if (!overlayIframe.src.includes('preview=true')) {
      const mode = getPreviewMode();
      if (mode === 'lyrics') {
        overlayIframe.src = previewSrc('overlay-lyrics.html');
      } else if (mode === 'queue') {
        overlayIframe.src = buildQueuePreviewSrc();
      } else {
        overlayIframe.src = previewSrc('overlay-info.html');
      }
    }
    resizeOverlayPreview();

    try {
      await updateOverlayStyle({
        target: currentTarget,
        scale: parseFloat(scale),
        font,
        color,
        textColor,
        bgColor,
        bgOpacity,
        rounding,
        isForceVisible,
        animationDirection,
        themeMode,
        fontSize: usesFontSize ? fontSize : undefined,
        queueExpandDirection: currentTarget === 'queue' ? queueExpandDirection : undefined,
      });
    } catch (err) {
      console.error("Failed to update overlay style:", err);
    }
  };

  const buildQueuePreviewSrc = () => {
    const force = toggleOverlayQueueForceVisible?.checked ? '&force=1' : '';
    return previewSrc('overlay-queue.html', force);
  };

  const previewTabs = document.querySelectorAll('.preview-tab');
  previewTabs.forEach(tab => {
    tab.onclick = async () => {
      previewTabs.forEach(t => t.classList.remove('active'));
      tab.classList.add('active');

      const mode = tab.dataset.previewMode;
      const settingsTitle = document.getElementById('overlay-settings-title');
      if (settingsTitle) {
        if (mode === 'lyrics') settingsTitle.textContent = '가사 오버레이 설정';
        else if (mode === 'queue') settingsTitle.textContent = '곡정보+대기열 오버레이';
        else settingsTitle.textContent = '곡 정보 오버레이 설정';
      }

      setOverlaySettingsPanelsVisibility(mode === 'queue' ? 'queue' : (mode === 'lyrics' ? 'lyrics' : 'info'));

      if (mode === 'lyrics') {
        loadOverlaySettings();
        overlayIframe.src = previewSrc('overlay-lyrics.html');
        await updateOverlayLyrics({
          current: '',
          next: '첫 번째 가사가 여기에 미리 표시됩니다.',
          index: -1,
        }).catch((err) => console.error(err));
      } else if (mode === 'queue') {
        loadOverlaySettings();
        overlayIframe.src = buildQueuePreviewSrc();
      } else {
        loadOverlaySettings();
        overlayIframe.src = previewSrc('overlay-info.html');
        await updateOverlayLyrics({ current: '', next: '', index: -1 }).catch((err) => console.error(err));
      }
      requestAnimationFrame(resizeOverlayPreview);
    };
  });

  const loadOverlaySettings = () => {
    const saved = localStorage.getItem('overlay-settings');
    let config = {};
    try { config = JSON.parse(saved) || {}; } catch(e) {}

    const currentTarget = getStyleTarget();
    const defaults = getTargetDefaults(currentTarget);
    const settings = config[currentTarget] || {};
    const final = { ...defaults, ...settings };
    const usesFontSize = currentTarget === 'lyrics' || currentTarget === 'queue';

    if (overlayFontSizeRow) overlayFontSizeRow.style.display = usesFontSize ? 'flex' : 'none';
    if (overlayFontSizeLabel) {
      overlayFontSizeLabel.textContent = currentTarget === 'queue' ? '대기열 글씨 크기' : '가사 글씨 크기';
    }
    if (overlayAnimationRow) overlayAnimationRow.style.display = 'flex';
    if (overlayFontSize) overlayFontSize.value = final.fontSize || defaults.fontSize;

    if (overlayScale) overlayScale.value = final.scale;
    if (overlayColor) {
      overlayColor.value = `#${final.color}`;
      const hexInput = document.getElementById('overlay-color-hex');
      if (hexInput) hexInput.value = final.color.replace('#', '');
      if (updateThemePalette) updateThemePalette(`#${final.color}`);
    }
    if (overlayTextColor) {
      overlayTextColor.value = `#${final.textColor}`;
      const textHexInput = document.getElementById('overlay-text-color-hex');
      if (textHexInput) textHexInput.value = final.textColor.replace('#', '');
      if (updateTextPalette) updateTextPalette(`#${final.textColor}`);
    }
    if (overlayBgOpacity) overlayBgOpacity.value = final.bgOpacity;
    if (overlayRounding) overlayRounding.value = final.rounding;
    if (overlayBgColor) {
      overlayBgColor.value = `#${final.bgColor}`;
      const bgHexInput = document.getElementById('overlay-bg-color-hex');
      if (bgHexInput) bgHexInput.value = final.bgColor.replace('#', '');
      if (updateBgPalette) updateBgPalette(`#${final.bgColor}`);
    }

    if (toggleOverlayForceVisible && config.isForceVisible !== undefined) {
      toggleOverlayForceVisible.checked = config.isForceVisible;
    }

    if (overlayFont) {
      overlayFont.value = final.font;
      const dropdown = document.getElementById('overlay-font-dropdown');
      if (dropdown) {
        const selectedText = dropdown.querySelector('.selected-text');
        const options = dropdown.querySelectorAll('.option-item');
        options.forEach(opt => {
          if (opt.dataset.value === final.font) {
            opt.classList.add('selected');
            if (selectedText) selectedText.textContent = opt.textContent;
          } else {
            opt.classList.remove('selected');
          }
        });
      }
    }

    if (overlayAnimationDirection) {
      overlayAnimationDirection.value = final.animationDirection;
      syncCustomSelect('overlay-animation-direction-dropdown', final.animationDirection);
    }

    if (overlayQueueExpandDirection) {
      const expand = final.queueExpandDirection || 'both';
      overlayQueueExpandDirection.value = expand;
      syncCustomSelect('overlay-queue-expand-dropdown', expand);
    }

    syncQueueExpandUi(currentTarget === 'queue');

    updateOverlaySettings(true);
  };

  const syncAllOverlayStylesToBackend = async () => {
    const saved = localStorage.getItem('overlay-settings');
    let config = {};
    try { config = JSON.parse(saved) || {}; } catch (e) {}

    const isForceVisible = config.isForceVisible === true;
    const themeMode = document.documentElement.getAttribute('data-theme') || 'dark';
    const targets = ['info', 'lyrics', 'queue'];

    for (const target of targets) {
      const defaults = getTargetDefaults(target);
      const targetSettings = config[target] || {};
      const final = { ...defaults, ...targetSettings };
      const usesFontSize = target === 'lyrics' || target === 'queue';

      try {
        await updateOverlayStyle({
          target,
          scale: parseFloat(final.scale) || 1.0,
          font: final.font || 'Inter',
          color: String(final.color || defaults.color).replace('#', ''),
          textColor: String(final.textColor || defaults.textColor).replace('#', ''),
          bgColor: String(final.bgColor || defaults.bgColor).replace('#', ''),
          bgOpacity: Number.isFinite(final.bgOpacity) ? final.bgOpacity : defaults.bgOpacity,
          rounding: Number.isFinite(final.rounding) ? final.rounding : defaults.rounding,
          isForceVisible,
          animationDirection: final.animationDirection || 'left',
          themeMode,
          fontSize: usesFontSize ? (parseInt(final.fontSize, 10) || defaults.fontSize) : undefined,
          queueExpandDirection: target === 'queue' ? (final.queueExpandDirection || 'both') : undefined,
        });
      } catch (err) {
        console.error(`Failed to sync ${target} overlay style:`, err);
      }
    }
  };

  [overlayScale, overlayBgOpacity, overlayRounding, toggleOverlayForceVisible].forEach(el => {
    if (!el) return;
    el.addEventListener('change', () => updateOverlaySettings());
    if (el.type === 'range') {
      el.addEventListener('input', () => updateOverlaySettings());
    }
  });

  if (overlayScale) {
    overlayScale.addEventListener('input', () => updateOverlaySettings());
    overlayScale.addEventListener("wheel", (e) => {
      e.preventDefault();
      let val = parseFloat(overlayScale.value);
      if (e.deltaY < 0) val += 0.1; else val -= 0.1;
      val = Math.max(parseFloat(overlayScale.min), Math.min(parseFloat(overlayScale.max), val));
      overlayScale.value = val.toFixed(1);
      overlayScale.dispatchEvent(new Event("input"));
    }, { passive: false });
  }
  if (overlayFontSize) {
    overlayFontSize.addEventListener('input', () => updateOverlaySettings());
    overlayFontSize.addEventListener("wheel", (e) => {
      e.preventDefault();
      let val = parseInt(overlayFontSize.value, 10);
      if (e.deltaY < 0) val += 1; else val -= 1;
      val = Math.max(parseInt(overlayFontSize.min, 10), Math.min(parseInt(overlayFontSize.max, 10), val));
      overlayFontSize.value = val;
      overlayFontSize.dispatchEvent(new Event("input"));
    }, { passive: false });
  }
  if (overlayFont) overlayFont.addEventListener('change', () => updateOverlaySettings());
  if (overlayColor) overlayColor.addEventListener('input', () => updateOverlaySettings());
  if (overlayTextColor) overlayTextColor.addEventListener('input', () => updateOverlaySettings());
  if (overlayBgOpacity) {
    overlayBgOpacity.addEventListener('input', () => updateOverlaySettings());
    overlayBgOpacity.addEventListener("wheel", (e) => {
      e.preventDefault();
      let val = parseFloat(overlayBgOpacity.value);
      if (e.deltaY < 0) val += 0.1; else val -= 0.1;
      val = Math.max(parseFloat(overlayBgOpacity.min), Math.min(parseFloat(overlayBgOpacity.max), val));
      overlayBgOpacity.value = val.toFixed(1);
      overlayBgOpacity.dispatchEvent(new Event("input"));
    }, { passive: false });
  }
  if (overlayRounding) {
    overlayRounding.addEventListener('input', () => updateOverlaySettings());
    overlayRounding.addEventListener("wheel", (e) => {
      e.preventDefault();
      let val = parseFloat(overlayRounding.value);
      if (e.deltaY < 0) val += 1; else val -= 1;
      val = Math.max(parseFloat(overlayRounding.min), Math.min(parseFloat(overlayRounding.max), val));
      overlayRounding.value = val.toFixed(0);
      overlayRounding.dispatchEvent(new Event("input"));
    }, { passive: false });
  }
  if (overlayBgColor) overlayBgColor.addEventListener('input', () => updateOverlaySettings());
  if (toggleOverlayForceVisible) toggleOverlayForceVisible.addEventListener('change', () => updateOverlaySettings());

  if (toggleOverlayQueueVisible) {
    import('../../playback-queue.js').then(({ isOverlayQueueVisible, setOverlayQueueVisible }) => {
      toggleOverlayQueueVisible.checked = isOverlayQueueVisible();
      toggleOverlayQueueVisible.addEventListener('change', () => {
        setOverlayQueueVisible(toggleOverlayQueueVisible.checked);
      });
    });
  }

  if (toggleOverlayQueueForceVisible) {
    toggleOverlayQueueForceVisible.addEventListener('change', () => {
      if (getPreviewMode() === 'queue' && overlayIframe) {
        overlayIframe.src = buildQueuePreviewSrc();
        requestAnimationFrame(resizeOverlayPreview);
      }
    });
  }

  if (overlayAnimationDirection) overlayAnimationDirection.addEventListener('change', () => updateOverlaySettings());
  if (overlayQueueExpandDirection) overlayQueueExpandDirection.addEventListener('change', () => updateOverlaySettings());

  // LAN 노출 토글 — 기본 꺼짐(로컬호스트만). 실제 서버 바인딩 반영은 앱
  // 재시작 시에만 이뤄지므로(overlay_server::start_overlay_server), 저장된
  // 설정을 그대로 보여주고 변경 시 재시작 필요 안내를 띄운다.
  const initOverlayLanToggle = async () => {
    if (!toggleOverlayLan) return;
    let persisted = false;
    try {
      persisted = !!(await getOverlayLanSetting());
    } catch (err) {
      console.error('Failed to load LAN setting:', err);
    }
    toggleOverlayLan.checked = persisted;
    updateOverlaySettings(true);

    toggleOverlayLan.addEventListener('change', async () => {
      const enabled = toggleOverlayLan.checked;
      const { showNotification } = await import('../../utils.js');
      try {
        await setOverlayLanSetting(enabled);
        updateOverlaySettings(true);
        showNotification(
          enabled
            ? 'LAN 접속을 켰습니다. 앱을 다시 시작해야 다른 기기에서 접속할 수 있습니다.'
            : 'LAN 접속을 껐습니다. 앱을 다시 시작해야 적용됩니다.',
          'warning'
        );
      } catch (err) {
        console.error('Failed to save LAN setting:', err);
        toggleOverlayLan.checked = !enabled;
        updateOverlaySettings(true);
        showNotification('LAN 설정 변경 실패: ' + err, 'error');
      }
    });

    getLanAddresses()
      .then((addresses) => {
        cachedLanAddress = (addresses && addresses[0]) || null;
        updateOverlaySettings(true);
      })
      .catch((err) => console.error('Failed to get LAN address:', err));
  };

  loadOverlaySettings();
  setOverlaySettingsPanelsVisibility(getPreviewMode());
  updateOverlaySettings(true);
  syncAllOverlayStylesToBackend();
  initLyricLineVisibilityControls();
  initOverlayLanToggle();
  requestAnimationFrame(resizeOverlayPreview);
  window.addEventListener('resize', resizeOverlayPreview);

  // Sidebar collapse / split-pane reflow — wrapper size can change without window resize
  if (overlayPreviewWrapper && typeof ResizeObserver !== 'undefined') {
    const previewResizeObserver = new ResizeObserver(() => {
      requestAnimationFrame(resizeOverlayPreview);
    });
    previewResizeObserver.observe(overlayPreviewWrapper);
  }

  return { syncAllOverlayStylesToBackend };
}
