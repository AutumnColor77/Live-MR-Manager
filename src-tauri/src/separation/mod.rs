use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use std::collections::HashMap;
use once_cell::sync::Lazy;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
// use tauri::{Emitter, WebviewWindow, Manager, AppHandle};
// use std::path::{Path, PathBuf};

use crate::vocal_remover::InferenceEngine;
// use crate::audio_player::{Status, PlaybackStatus, sys_log};

// AI Engine Management
pub static ROFORMER_ENGINE: Lazy<Mutex<Option<Arc<dyn InferenceEngine>>>> = Lazy::new(|| Mutex::new(None));
pub static AI_QUEUE_LOCK: Lazy<tokio::sync::Mutex<()>> = Lazy::new(|| tokio::sync::Mutex::new(()));
pub static ACTIVE_SEPARATIONS: Lazy<Mutex<HashMap<String, Arc<AtomicBool>>>> = Lazy::new(|| Mutex::new(HashMap::new()));
pub static BROADCAST_MODE: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SeparationProgress {
    pub path: String,
    pub percentage: f32,
    pub status: String,
    pub provider: String,
}

pub mod task;
