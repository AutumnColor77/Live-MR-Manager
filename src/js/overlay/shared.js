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
    // 앱 내부 창(Tauri는 tauri.localhost/asset 호스트로 페이지를 띄움)에서는
    // 오버레이 서버가 같은 PC에 있으므로 localhost로 붙는다. OBS/브라우저에서
    // http로 열었을 때는 그 호스트(LAN IP 포함)를 그대로 사용.
    if (!host || host === 'tauri.localhost' || host.endsWith('.localhost')) {
      host = 'localhost';
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

  global.OverlayShared = {
    hexToRgb,
    connectWS,
    readBool,
    readStyleField,
  };
})(window);
