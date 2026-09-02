/**
 * Songbook HTTP — 릴리즈 WebView(`https://tauri.localhost`)는 서버 CORS에 없어
 * fetch가 실패합니다. Tauri에서는 Rust(reqwest)로 우회하고, 브라우저 mock은 fetch 유지.
 */
import { invoke } from './tauri-bridge.js';

const isTauri = typeof window !== 'undefined' && !!window.__TAURI__;

function normalizeHeaders(initHeaders) {
  if (!initHeaders) return {};
  if (initHeaders instanceof Headers) {
    return Object.fromEntries(initHeaders.entries());
  }
  if (Array.isArray(initHeaders)) {
    return Object.fromEntries(initHeaders);
  }
  return { ...initHeaders };
}

function extractBearerToken(headers) {
  const auth = headers.Authorization || headers.authorization || '';
  const match = /^Bearer\s+(.+)$/i.exec(String(auth).trim());
  return match ? match[1] : null;
}

function toResponse(result) {
  return {
    ok: Boolean(result?.ok),
    status: Number(result?.status) || 0,
    json: async () => {
      const raw = result?.body ?? '';
      if (!raw) return {};
      return JSON.parse(raw);
    },
    text: async () => String(result?.body ?? ''),
  };
}

/** Tauri invoke / fetch 오류를 사용자 메시지로 변환 */
export function songbookErrorMessage(err, fallback = 'Songbook 요청에 실패했습니다.') {
  if (typeof err === 'string' && err.trim()) return err.trim();
  const message = err?.message;
  if (typeof message === 'string' && message.trim()) return message.trim();
  return fallback;
}

/**
 * fetch 호환 Songbook API 클라이언트.
 * @param {string} url
 * @param {RequestInit} [init]
 */
export async function songbookFetch(url, init = {}) {
  if (!isTauri) {
    return fetch(url, init);
  }

  const headers = normalizeHeaders(init.headers);
  const method = String(init.method || 'GET').toUpperCase();
  const token = extractBearerToken(headers);
  const contentType = headers['Content-Type'] || headers['content-type'] || null;
  let body = init.body ?? null;
  if (body != null && typeof body !== 'string') {
    body = JSON.stringify(body);
  }

  const result = await invoke('songbook_http', {
    method,
    url,
    token,
    body,
    contentType,
  });
  return toResponse(result);
}
