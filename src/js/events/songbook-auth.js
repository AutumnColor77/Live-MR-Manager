/**
 * Songbook 로그인 — 단일 버튼 + 프로바이더 메뉴, OAuth 후 deep-link로 앱 세션 수신
 */
import {
  applySongbookChannels,
  clearSongbookChannelCache,
  songbookBase,
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

function setLoginAvatar(avatar, wrap, btn, { picture, name }) {
  if (!avatar || !btn) return;
  const show = Boolean(picture);
  if (show) {
    avatar.width = 36;
    avatar.height = 36;
    avatar.style.width = '36px';
    avatar.style.height = '36px';
    avatar.style.maxWidth = '36px';
    avatar.style.maxHeight = '36px';
    avatar.style.objectFit = 'cover';
    avatar.style.display = 'block';
    avatar.onerror = () => {
      setLoginAvatar(avatar, wrap, btn, { picture: '', name: '' });
    };
    avatar.src = picture;
    avatar.alt = name || '';
    if (wrap) {
      wrap.hidden = false;
      wrap.removeAttribute('hidden');
      wrap.style.display = 'block';
      wrap.style.width = '36px';
      wrap.style.height = '36px';
      wrap.style.overflow = 'hidden';
      wrap.style.flex = '0 0 36px';
    }
    btn.classList.add('has-avatar');
  } else {
    avatar.onerror = null;
    avatar.removeAttribute('src');
    avatar.alt = '';
    if (wrap) {
      wrap.hidden = true;
      wrap.style.display = 'none';
    }
    btn.classList.remove('has-avatar');
  }
}

function renderAuthButton(state) {
  const btn = document.getElementById('songbook-login-btn');
  const menu = document.getElementById('songbook-login-menu');
  const avatar = document.getElementById('songbook-login-avatar');
  const wrap = document.getElementById('songbook-login-avatar-wrap');
  if (!btn) return;
  const label = btn.querySelector('.songbook-login-label');
  const loggedIn = Boolean(state?.loggedIn);
  const name = state?.user?.name || state?.user?.email || '로그인됨';
  const picture = String(state?.user?.picture || '').trim();

  if (loggedIn) {
    if (label) label.textContent = name;
    btn.title = `${state.user?.email || name} · 클릭하여 로그아웃`;
    btn.dataset.loggedIn = '1';
    if (menu) menu.hidden = true;
    setLoginAvatar(avatar, wrap, btn, { picture, name });
    setSongbookSyncVisible(true);
  } else {
    if (label) label.textContent = '로그인';
    btn.title = 'Songbook 로그인';
    btn.dataset.loggedIn = '0';
    setLoginAvatar(avatar, wrap, btn, { picture: '', name: '' });
    setSongbookSyncVisible(false);
  }
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
  if (!data.user) throw new Error('no user');
  const channels = Array.isArray(data.channels) ? data.channels : [];
  const primary = applySongbookChannels(channels);
  updateSongbookChannelLabel(primary, channels);
  await invoke('set_songbook_user', {
    user: {
      id: data.user.id,
      email: data.user.email,
      name: data.user.name,
      picture: data.user.picture,
    },
  });
  return { ...data.user, channels, primaryChannel: primary };
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
        updateSongbookChannelLabel(null);
      }
    }
  } else {
    updateSongbookChannelLabel(null);
  }
  renderAuthButton(state);
  return state;
}

function desktopLoginUrl(provider) {
  return songbookDesktopConnectUrl(provider, '/me');
}

async function startProviderLogin(provider) {
  const btn = document.getElementById('songbook-login-btn');
  const desktopUrl = desktopLoginUrl(provider);
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
          await syncAuthUi(state);
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
  setMenuOpen(false);
  showNotification('Songbook 로그아웃되었습니다.', 'info');
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

  btn.addEventListener('click', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    const current = await invoke('get_songbook_auth').catch(() => null);
    if (current?.loggedIn) {
      await logoutSongbook();
      return;
    }
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

  document.addEventListener('click', (e) => {
    if (!menu || menu.hidden) return;
    const group = document.querySelector('.songbook-auth-group');
    if (group && !group.contains(e.target)) setMenuOpen(false);
  });
}
