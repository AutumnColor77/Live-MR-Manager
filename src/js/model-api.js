/**
 * model-api.js - AI model command wrappers
 */

import { invoke } from './tauri-bridge.js';

export async function getModelSettings() {
  return invoke('get_model_settings');
}

export async function updateModelSettings(modelId) {
  return invoke('update_model_settings', { modelId });
}

export async function checkModelReady(modelId) {
  return invoke('check_model_ready', { modelId });
}

export async function downloadAiModel(modelId) {
  return invoke('download_ai_model', { modelId });
}

export async function deleteAiModel(modelId) {
  return invoke('delete_ai_model', { modelId });
}

export async function getActiveSeparations() {
  return invoke('get_active_separations');
}

/** 곡별 MR 분리 기록 ({modelId, modelName, provider, completedAt} 또는 null). */
export async function getSeparationInfo(path) {
  return invoke('get_separation_info', { path });
}

// --- Custom models ---

export async function listModelPresets() {
  return invoke('list_model_presets');
}

export async function listAllModels() {
  return invoke('list_all_models');
}

export async function listCustomModels() {
  return invoke('list_custom_models');
}

export async function addCustomModel({ name, sourceKind, source, presetKey, expectedSha256 }) {
  return invoke('add_custom_model', {
    name,
    sourceKind,
    source,
    presetKey,
    expectedSha256: expectedSha256 || null,
  });
}

export async function removeCustomModel(modelId) {
  return invoke('remove_custom_model', { modelId });
}

// --- AI forced-alignment (lyric sync) models: KO/EN ---

/** [{language, displayName, sourceUrl, license, modelSizeBytes, downloaded}] */
export async function listAlignmentModels() {
  return invoke('list_alignment_models');
}

export async function downloadAlignmentModel(language) {
  return invoke('download_alignment_model', { language });
}

export async function cancelAlignmentModelDownload() {
  return invoke('cancel_alignment_model_download');
}

export async function deleteAlignmentModel(language) {
  return invoke('delete_alignment_model', { language });
}
