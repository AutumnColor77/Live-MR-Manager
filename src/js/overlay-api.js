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

export async function getLanAddresses() {
  return invoke('get_lan_addresses');
}
