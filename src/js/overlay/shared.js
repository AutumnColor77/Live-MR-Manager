/**
 * Shared utilities for OBS overlay HTML pages (non-module script)
 */
(function (global) {
  function hexToRgb(hex) {
    if (!hex) return "0,0,0";
    hex = String(hex).replace('#', '');
    if (hex.length === 3) {
      hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
    }
    const r = parseInt(hex.substring(0, 2), 16) || 0;
    const g = parseInt(hex.substring(2, 4), 16) || 0;
    const b = parseInt(hex.substring(4, 6), 16) || 0;
    return `${r},${g},${b}`;
  }

  function connectWS(onMessage, port) {
    const wsPort = port || 14201;
    let host = global.location.hostname || 'localhost';
    if (host === 'tauri.localhost' || host === 'localhost.tauri' || !host) {
      host = '127.0.0.1';
    }
    const socket = new WebSocket(`ws://${host}:${wsPort}`);
    socket.onmessage = (event) => {
      try {
        onMessage(JSON.parse(event.data));
      } catch (_) {
        /* ignore malformed payloads */
      }
    };
    socket.onclose = () => {
      setTimeout(() => connectWS(onMessage, wsPort), 2000);
    };
    return socket;
  }

  function readBool(data, snakeKey, camelKey) {
    if (data[snakeKey] === true || data[camelKey] === true) return true;
    return false;
  }

  function readStyleField(style, snakeKey, camelKey, fallback) {
    if (style[snakeKey] !== undefined) return style[snakeKey];
    if (style[camelKey] !== undefined) return style[camelKey];
    return fallback;
  }

  /**
   * 앱 미리보기: 설정 배율을 유지하되, 카드+그림자가 iframe 안에 들어오도록 상한 적용.
   * OBS 실소스에는 data-preview가 없어 no-op에 가깝게 바로 return.
   */
  function applyPreviewFitScale(cardEl, userScale) {
    const root = document.documentElement;
    if (!root.hasAttribute('data-preview') || !cardEl) {
      return Number(userScale) || 1;
    }
    const desired = Math.max(0.1, Number(userScale) || 1);
    root.style.setProperty('--overlay-scale', '1');
    void cardEl.offsetWidth;

    const w = Math.max(1, cardEl.offsetWidth);
    const h = Math.max(1, cardEl.offsetHeight);
    const bodyStyle = getComputedStyle(document.body);
    const padX = (parseFloat(bodyStyle.paddingLeft) || 0) + (parseFloat(bodyStyle.paddingRight) || 0);
    const padY = (parseFloat(bodyStyle.paddingTop) || 0) + (parseFloat(bodyStyle.paddingBottom) || 0);
    const shadow = 40;
    const availW = Math.max(1, document.body.clientWidth - padX - shadow * 2);
    const availH = Math.max(1, document.body.clientHeight - padY - shadow * 2);
    const fit = Math.min(availW / w, availH / h);
    const finalScale = Math.max(0.15, Math.min(desired, fit));
    root.style.setProperty('--overlay-scale', String(finalScale));
    return finalScale;
  }

  function bindPreviewFit(cardEl, getUserScale) {
    if (!document.documentElement.hasAttribute('data-preview') || !cardEl) return () => {};
    const run = () => applyPreviewFitScale(cardEl, getUserScale());
    window.addEventListener('resize', run);
    let ro = null;
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(run);
      ro.observe(document.body);
      ro.observe(cardEl);
    }
    requestAnimationFrame(run);
    return () => {
      window.removeEventListener('resize', run);
      if (ro) ro.disconnect();
    };
  }

  global.OverlayShared = {
    hexToRgb,
    connectWS,
    readBool,
    readStyleField,
    applyPreviewFitScale,
    bindPreviewFit,
  };
})(window);
