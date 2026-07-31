/**
 * overlay-api.js - OBS overlay command wrappers
 */

import { invoke } from './tauri-bridge.js';

export async function updateOverlayStyle(payload) {
  return invoke('update_overlay_style', payload);
}

export async function updateOverlayLyrics(payload) {
  return invoke('update_overlay_lyrics', payload);
}

/** LAN 접속 가능 여부 확인용 — 이 PC의 LAN IP 후보 목록(보통 0~1개). */
export async function getLanAddresses() {
  return invoke('get_lan_addresses');
}

/** 오버레이 서버의 LAN 노출 설정(저장된 값). 앱 재시작 시에만 실제 바인딩에 반영됨. */
export async function getOverlayLanSetting() {
  return invoke('get_overlay_lan_setting');
}

export async function setOverlayLanSetting(enabled) {
  return invoke('set_overlay_lan_setting', { enabled: !!enabled });
}
