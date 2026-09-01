/**
 * Songbook 로그인 — 단일 버튼 + 프로바이더/계정 메뉴, OAuth 후 deep-link로 앱 세션 수신
 */
import {
  applySongbookChannels,
  clearSongbookChannelCache,
  getSongbookChannels,
  pickOwnChannel,
  songbookBase,
  songbookChannelSlug,
  songbookDesktopConnectUrl,
} from '../companion-links.js';
import { setSongbookSyncVisible, updateSongbookChannelLabel } from '../songbook-sync.js';
import { invoke, listen } from '../tauri-bridge.js';
import { showNotification } from '../utils.js';

async function openExternalUrl(url) {
  if (window.__TAURI__?.core?.invoke) {
    try {
      await window.__TAURI__.core.invoke('plugin:opener|open_url', { url });
      return 'opener';
    } catch (err) {
      console.warn('[SongbookAuth] opener failed, fallback', err);
    }
    try {
      await invoke('open_app_update_page', { url });
      return 'open_app_update_page';
    } catch (err) {
      console.warn('[SongbookAuth] open_app_update_page failed', err);
    }
  }
  const opened = window.open(url, '_blank', 'noopener');
  if (!opened) throw new Error('팝업이 차단되었습니다.');
  return 'window.open';
}

function setMenuOpen(open) {
  const btn = document.getElementById('songbook-login-btn');
  const menu = document.getElementById('songbook-login-menu');
  if (!menu || !btn) return;
  menu.hidden = !open;
  btn.setAttribute('aria-expanded', open ? 'true' : 'false');
}

function setMenuMode(loggedIn) {
  const menu = document.getElementById('songbook-login-menu');
  if (!menu) return;
  menu.querySelectorAll('[data-provider]').forEach((el) => {
    el.hidden = Boolean(loggedIn);
  });
  menu.querySelectorAll('[data-action]').forEach((el) => {
    el.hidden = !loggedIn;
  });
}

function normalizeMeUser(data) {
  if (!data || typeof data !== 'object') return null;
  if (data.user && typeof data.user === 'object') return data.user;
  if (data.profile && typeof data.profile === 'object') return data.profile;
  if (data.id != null || data.email) return data;
  return null;
}

function resolveDisplayName(user, channels) {
  if (user) {
    const name = String(
      user.name || user.nickname || user.displayName || user.display_name || '',
    ).trim();
    if (name) return name;
    const email = String(user.email || '').trim();
    if (email.includes('@')) return email.split('@')[0];
  }
  const list = Array.isArray(channels) ? channels : getSongbookChannels();
  const own = pickOwnChannel(list);
  if (own?.name) return String(own.name).trim();
  return '사용자';
}

function resolvePicture(user) {
  if (!user) return '';
  return String(
    user.picture
    || user.avatar
    || user.avatarUrl
    || user.avatar_url
    || user.profileImage
    || user.profile_image
    || user.image
    || '',
  ).trim();
}

function initialsFromName(name) {
  const text = String(name || '').trim();
  if (!text) return '?';
  return text.charAt(0).toUpperCase();
}

function setLoginProfile(btn, avatar, wrap, initialsEl, { picture, name }) {
  if (!btn) return;

  const displayName = name || '사용자';
  const letter = initialsFromName(displayName);
  const hasPicture = Boolean(picture);

  wrap.hidden = false;
  wrap.removeAttribute('hidden');
  wrap.style.display = 'block';

  if (hasPicture && avatar) {
    avatar.width = 28;
    avatar.height = 28;
    avatar.hidden = false;
    avatar.removeAttribute('hidden');
    avatar.style.display = 'block';
    avatar.onerror = () => {
      avatar.onerror = null;
      avatar.hidden = true;
      avatar.removeAttribute('src');
      if (initialsEl) {
        initialsEl.textContent = letter;
        initialsEl.hidden = false;
        initialsEl.removeAttribute('hidden');
      }
      btn.classList.remove('has-avatar');
    };
    avatar.src = picture;
    avatar.alt = displayName;
    if (initialsEl) {
      initialsEl.hidden = true;
      initialsEl.textContent = '';
    }
    btn.classList.add('has-avatar');
  } else {
    if (avatar) {
      avatar.onerror = null;
      avatar.removeAttribute('src');
      avatar.hidden = true;
    }
    if (initialsEl) {
      initialsEl.textContent = letter;
      initialsEl.hidden = false;
      initialsEl.removeAttribute('hidden');
    }
    btn.classList.remove('has-avatar');
  }
}

function clearLoginProfile(btn, avatar, wrap, initialsEl) {
  if (avatar) {
    avatar.onerror = null;
    avatar.removeAttribute('src');
    avatar.alt = '';
    avatar.hidden = true;
  }
  if (initialsEl) {
    initialsEl.hidden = true;
    initialsEl.textContent = '';
  }
  if (wrap) {
    wrap.hidden = true;
    wrap.style.display = 'none';
  }
  btn?.classList.remove('has-avatar', 'is-logged-in');
}

function profileFromState(state) {
  const channels = state?.user?.channels || getSongbookChannels();
  const user = state?.user;
  return {
    name: resolveDisplayName(user, channels),
    picture: resolvePicture(user),
  };
}

function renderAuthButton(state) {
  const btn = document.getElementById('songbook-login-btn');
  const avatar = document.getElementById('songbook-login-avatar');
  const wrap = document.getElementById('songbook-login-avatar-wrap');
  const initialsEl = document.getElementById('songbook-login-initials');
  if (!btn) return;
  const label = btn.querySelector('.songbook-login-label');
  const loggedIn = Boolean(state?.loggedIn);

  if (loggedIn) {
    const { name, picture } = profileFromState(state);
    btn.classList.add('is-logged-in');
    if (label) label.textContent = name;
    btn.title = `${state.user?.email || name} · 메뉴 열기`;
    btn.dataset.loggedIn = '1';
    setLoginProfile(btn, avatar, wrap, initialsEl, { picture, name });
    setSongbookSyncVisible(true);
  } else {
    clearLoginProfile(btn, avatar, wrap, initialsEl);
    if (label) label.textContent = '로그인';
    btn.title = 'Songbook 로그인';
    btn.dataset.loggedIn = '0';
    setSongbookSyncVisible(false);
  }
  setMenuMode(loggedIn);
  setMenuOpen(false);
}

async function refreshProfile(token) {
  if (!token) return null;
  const base = songbookBase();
  const res = await fetch(`${base}/api/auth/me`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.status === 401) {
    const err = new Error('AUTH_EXPIRED');
    err.code = 'AUTH_EXPIRED';
    throw err;
  }
  if (!res.ok) throw new Error(`me failed (${res.status})`);
  const data = await res.json();
  const rawUser = normalizeMeUser(data);
  if (!rawUser) throw new Error('no user');
  const userId = rawUser.id != null ? String(rawUser.id) : '';
  if (!userId && !String(rawUser.email || '').trim()) throw new Error('no user');
  const channels = Array.isArray(data.channels) ? data.channels : [];
  const primary = applySongbookChannels(channels);
  const displayName = resolveDisplayName(rawUser, channels);
  const picture = resolvePicture(rawUser);
  const persisted = {
    id: userId || String(rawUser.email || 'unknown'),
    email: String(rawUser.email || ''),
    name: displayName,
    picture,
  };
  try {
    await invoke('set_songbook_user', { user: persisted });
  } catch (err) {
    console.warn('[SongbookAuth] set_songbook_user failed (display still updated)', err);
  }
  return {
    ...rawUser,
    ...persisted,
    channels,
    primaryChannel: primary,
  };
}

function normalizeAuthPayload(payload) {
  if (!payload || typeof payload !== 'object') return payload;
  const raw = payload.payload && typeof payload.payload === 'object' ? payload.payload : payload;
  return {
    loggedIn: Boolean(raw.loggedIn ?? raw.logged_in),
    token: raw.token ?? null,
    user: raw.user ?? null,
  };
}

async function syncAuthUi(payload) {
  let state = payload ? normalizeAuthPayload(payload) : null;
  if (!state) {
    state = normalizeAuthPayload(await invoke('get_songbook_auth'));
  }
  if (state?.loggedIn && state.token) {
    try {
      const user = await refreshProfile(state.token);
      updateSongbookChannelLabel(user.primaryChannel, user.channels);
      state = { ...state, user };
    } catch (err) {
      console.warn('[SongbookAuth] profile refresh failed', err);
      if (err?.code === 'AUTH_EXPIRED' || err?.message === 'AUTH_EXPIRED') {
        await invoke('clear_songbook_auth').catch(() => {});
        clearSongbookChannelCache();
        state = { loggedIn: false, token: null, user: null };
        updateSongbookChannelLabel(null);
        showNotification('세션이 만료되었습니다. 다시 로그인해 주세요.', 'error');
      } else {
        const cached = normalizeAuthPayload(await invoke('get_songbook_auth'));
        if (cached?.user) {
          state = { ...state, user: cached.user };
        }
        updateSongbookChannelLabel(null);
      }
    }
  } else {
    updateSongbookChannelLabel(null);
  }
  renderAuthButton(state);
  const { onSongbookAuthChanged } = await import('../songbook-request-poller.js');
  onSongbookAuthChanged(Boolean(state?.loggedIn));
  if (state?.loggedIn) {
    window.dispatchEvent(new CustomEvent('songbook-auth-ready'));
  }
  return state;
}

function desktopLoginUrl(provider, state) {
  return songbookDesktopConnectUrl(provider, '/me', state);
}

async function startProviderLogin(provider) {
  const btn = document.getElementById('songbook-login-btn');
  let desktopUrl;
  try {
    const oauthState = await invoke('begin_songbook_oauth', { baseUrl: songbookBase() });
    desktopUrl = desktopLoginUrl(provider, oauthState);
  } catch (err) {
    console.error('[SongbookAuth] begin_songbook_oauth failed', err);
    showNotification('로그인을 시작하지 못했습니다.', 'error');
    return;
  }
  console.log('[SongbookAuth] opening', desktopUrl);
  if (btn) btn.disabled = true;
  setMenuOpen(false);
  try {
    await openExternalUrl(desktopUrl);
    showNotification('브라우저에서 연결 중…', 'info');
    const started = Date.now();
    const poll = window.setInterval(async () => {
      if (Date.now() - started > 120_000) {
        window.clearInterval(poll);
        return;
      }
      try {
        const state = normalizeAuthPayload(await invoke('get_songbook_auth'));
        if (state?.loggedIn) {
          window.clearInterval(poll);
          await syncAuthUi();
          showNotification('Songbook 로그인 완료', 'success');
        }
      } catch {
        /* ignore */
      }
    }, 1500);
  } catch (err) {
    console.error('[SongbookAuth] open failed', err);
    showNotification('로그인 창을 열지 못했습니다.', 'error');
  } finally {
    window.setTimeout(() => {
      if (btn) btn.disabled = false;
    }, 600);
  }
}

async function requireChannelSlug() {
  const slug = songbookChannelSlug();
  if (!slug) {
    showNotification('연결된 채널이 없습니다. 먼저 동기화로 채널을 만드세요.', 'error');
    return null;
  }
  return slug;
}

async function openSongbookAdmin() {
  const slug = await requireChannelSlug();
  if (!slug) return;
  setMenuOpen(false);
  try {
    await openExternalUrl(`${songbookBase()}/c/${encodeURIComponent(slug)}/admin`);
  } catch (err) {
    console.error('[SongbookAuth] open admin failed', err);
    showNotification('운영 페이지를 열지 못했습니다.', 'error');
  }
}

async function openMySongbook() {
  const slug = await requireChannelSlug();
  if (!slug) return;
  setMenuOpen(false);
  try {
    await openExternalUrl(`${songbookBase()}/c/${encodeURIComponent(slug)}`);
  } catch (err) {
    console.error('[SongbookAuth] open songbook failed', err);
    showNotification('노래책을 열지 못했습니다.', 'error');
  }
}

async function logoutSongbook() {
  const current = await invoke('get_songbook_auth').catch(() => null);
  const token = current?.token;
  if (token) {
    try {
      await fetch(`${songbookBase()}/api/auth/logout`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
    } catch (err) {
      console.warn('[SongbookAuth] server logout failed', err);
    }
  }
  await invoke('clear_songbook_auth');
  clearSongbookChannelCache();
  renderAuthButton({ loggedIn: false });
  setSongbookSyncVisible(false);
  updateSongbookChannelLabel(null);
  const { onSongbookAuthChanged } = await import('../songbook-request-poller.js');
  const { clearPlaybackQueue } = await import('../playback-queue.js');
  onSongbookAuthChanged(false);
  clearPlaybackQueue();
  setMenuOpen(false);
  showNotification('Songbook 로그아웃되었습니다.', 'info');
}

/** 헤더 로그인 메뉴 열기 (신청목록 게이트 등에서 호출) */
export function openSongbookAuthMenu() {
  const btn = document.getElementById('songbook-login-btn');
  const loggedIn = btn?.dataset?.loggedIn === '1';
  setMenuMode(loggedIn);
  setMenuOpen(true);
}

export async function startSongbookLogin(provider) {
  if (provider !== 'google' && provider !== 'naver') return;
  await startProviderLogin(provider);
}

export function initSongbookAuth() {
  const btn = document.getElementById('songbook-login-btn');
  const menu = document.getElementById('songbook-login-menu');
  if (!btn) {
    console.warn('[SongbookAuth] #songbook-login-btn not found');
    return;
  }
  if (btn.dataset.bound === '1') return;
  btn.dataset.bound = '1';

  void syncAuthUi();

  listen('songbook-auth-changed', (event) => {
    const payload = event?.payload ?? event;
    void syncAuthUi(payload);
  }).catch((err) => console.warn('[SongbookAuth] listen failed', err));

  listen('songbook-auth-error', (event) => {
    const payload = event?.payload ?? event;
    const message =
      (payload && typeof payload === 'object' && payload.message)
        ? String(payload.message)
        : '로그인에 실패했습니다. 다시 시도해 주세요.';
    showNotification(message, 'error');
  }).catch((err) => console.warn('[SongbookAuth] error listen failed', err));

  btn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    setMenuOpen(menu?.hidden !== false);
  });

  menu?.querySelectorAll('[data-provider]').forEach((item) => {
    item.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      const provider = item.getAttribute('data-provider');
      if (provider === 'google' || provider === 'naver') {
        await startProviderLogin(provider);
      }
    });
  });

  menu?.querySelector('[data-action="admin"]')?.addEventListener('click', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    await openSongbookAdmin();
  });

  menu?.querySelector('[data-action="songbook"]')?.addEventListener('click', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    await openMySongbook();
  });

  menu?.querySelector('[data-action="logout"]')?.addEventListener('click', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    await logoutSongbook();
  });

  document.addEventListener('click', (e) => {
    if (!menu || menu.hidden) return;
    const group = document.querySelector('.songbook-auth-group');
    if (group && !group.contains(e.target)) setMenuOpen(false);
  });
}
