/**
 * Songbook 신청·대기열 admin API (Bearer 세션)
 */
import { songbookBase, songbookChannelSlug } from './companion-links.js';
import { invoke } from './tauri-bridge.js';

export class SongbookAuthError extends Error {
  constructor(message = 'Unauthorized') {
    super(message);
    this.name = 'SongbookAuthError';
  }
}

function adminBase(slug) {
  return `${songbookBase()}/api/c/${encodeURIComponent(slug)}/admin`;
}

export async function getSongbookToken() {
  const raw = await invoke('get_songbook_auth').catch(() => null);
  const token = raw?.token ?? null;
  if (!token) return null;
  return token;
}

async function authHeaders() {
  const token = await getSongbookToken();
  if (!token) throw new SongbookAuthError('Not logged in');
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };
}

async function adminFetch(slug, path, init = {}) {
  const headers = new Headers(init.headers);
  const auth = await authHeaders();
  Object.entries(auth).forEach(([k, v]) => headers.set(k, v));
  if (init.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  const res = await fetch(`${adminBase(slug)}${path}`, { ...init, headers });
  const data = await res.json().catch(() => ({}));

  if (res.status === 401) {
    throw new SongbookAuthError(data.error ?? 'Unauthorized');
  }
  if (!res.ok) {
    throw new Error(data.error ?? `Request failed (${res.status})`);
  }
  return data;
}

export function getActiveChannelSlug() {
  return songbookChannelSlug();
}

export async function verifyAdminAccess(slug) {
  await adminFetch(slug, '/requests');
}

export async function fetchAdminRequests(slug) {
  const data = await adminFetch(slug, '/requests');
  return Array.isArray(data.requests) ? data.requests : [];
}

export async function fetchPublicStatus(slug) {
  const res = await fetch(`${songbookBase()}/api/c/${encodeURIComponent(slug)}/status`);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error ?? `Request failed (${res.status})`);
  }
  return data;
}

export async function fetchPublicQueue(slug) {
  const res = await fetch(`${songbookBase()}/api/c/${encodeURIComponent(slug)}/queue`);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error ?? `Request failed (${res.status})`);
  }
  return Array.isArray(data.queue) ? data.queue : [];
}

export async function patchRequestStatus(slug, id, status) {
  const data = await adminFetch(slug, `/requests/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify({ status }),
  });
  return data.request;
}

export async function clearQueue(slug) {
  const data = await adminFetch(slug, '/queue/clear', {
    method: 'POST',
    body: JSON.stringify({}),
  });
  return data.cleared ?? 0;
}

export async function reorderQueue(slug, ids) {
  await adminFetch(slug, '/queue/reorder', {
    method: 'POST',
    body: JSON.stringify({ ids }),
  });
}

export async function patchAdminSettings(slug, body) {
  await adminFetch(slug, '/settings', {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
}
