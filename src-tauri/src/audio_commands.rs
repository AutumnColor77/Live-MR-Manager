use tauri::{Emitter, Manager, WebviewWindow};
use std::fs::File;
use std::io::BufReader;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;
use rodio::Source;
use rodio::source::UniformSourceIterator;
use std::num::{NonZeroU16, NonZeroU32};
use crate::audio_player::{
    AUDIO_HANDLER, StreamingReader, StretchedSource, DynamicVolumeSource,
    sys_log
};
use crate::types::{Status, PlaybackStatus, PlaybackProgress, AppState};
use crate::state::DB;
use crate::youtube::YoutubeManager;
use urlencoding;

// --- Global Statics ---
pub static PLAYBACK_VERSION: AtomicU64 = AtomicU64::new(0);

#[tauri::command]
pub async fn play_track(window: WebviewWindow, path: String, duration_ms: Option<u64>, play_now: Option<bool>) -> Result<u64, String> {
    let res = play_track_internal(window.clone(), path, duration_ms, None, play_now.unwrap_or(true)).await;
    if let Err(ref e) = res {
        let _ = window.emit("playback-status", PlaybackStatus { status: Status::Error, message: e.clone() });
    }
    res
}

pub async fn play_track_internal(window: WebviewWindow, path: String, duration_ms_hint: Option<u64>, start_pos_ms: Option<u64>, play_now: bool) -> Result<u64, String> {
    let handler = match &*AUDIO_HANDLER {
        Ok(h) => h.clone(),
        Err(e) => return Err(e.clone()),
    };
    
    let target_version = PLAYBACK_VERSION.fetch_add(1, Ordering::SeqCst) + 1;
    sys_log(&format!("[DEBUG] play_track_internal Start: version={}, path={}, start_pos={:?}ms", target_version, path, start_pos_ms));
    
    struct PlaybackPreparationGuard;
    impl Drop for PlaybackPreparationGuard {
        fn drop(&mut self) {
            crate::audio_player::IS_PREPARING_PLAYBACK.store(false, Ordering::SeqCst);
        }
    }
    let _prep_guard = PlaybackPreparationGuard;
    crate::audio_player::IS_PREPARING_PLAYBACK.store(true, Ordering::SeqCst);
    
    let msg = if start_pos_ms.is_some() { "Seeking..." } else { "Preparing..." };
    let _ = window.emit("playback-status", PlaybackStatus { status: Status::Pending, message: msg.into() });

    {
        let controller = handler.controller.lock();
        controller.clear();
        sys_log("[AUDIO] Playback Step 1: Controller cleared");
    }
    
    let rate = handler.track_sample_rate.load(Ordering::Relaxed) as f64;
    let start_samples = if let Some(ms) = start_pos_ms {
        (ms as f64 * rate / 1000.0) as u64
    } else {
        0
    };
    handler.current_pos_samples.store(start_samples, Ordering::Relaxed);
    
    if let Some(d) = duration_ms_hint {
        handler.total_duration_ms.store(d, Ordering::Relaxed);
    } else {
        handler.total_duration_ms.store(0, Ordering::Relaxed);
    }
    
    let paths = window.state::<crate::state::AppPaths>();
    
    // Determine the cache directory. 
    let (vocal_path, inst_path) = if path.contains("separated") {
        let p = std::path::PathBuf::from(&path);
        if p.is_file() {
            let parent = p.parent().unwrap_or(&p);
            (parent.join("vocal.wav"), parent.join("inst.wav"))
        } else {
            // It's a directory
            (p.join("vocal.wav"), p.join("inst.wav"))
        }
    } else {
        let cache_key = urlencoding::encode(&path).to_string();
        let cache_dir = paths.separated.join(&cache_key);
        (cache_dir.join("vocal.wav"), cache_dir.join("inst.wav"))
    };
    
    let target_rate = handler.active_sample_rate;
    let target_channels = handler.active_channels;
    let target_rate_nz = NonZeroU32::new(target_rate).expect("Invalid sample rate");
    let target_channels_nz = NonZeroU16::new(target_channels).expect("Invalid channels");

    // Case 1: MR Files Exist
    if vocal_path.exists() && inst_path.exists() {
        let is_mr_active = {
            let active = crate::audio_player::ACTIVE_DOWNLOADS.lock();
            active.contains(&vocal_path) || active.contains(&inst_path)
        };
        
        if is_mr_active {
            sys_log("[AUDIO] Waiting for active MR separation download/write...");
            tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;
        }

        let mut sources = Vec::new();
        for i in 0..5 {
            if PLAYBACK_VERSION.load(Ordering::SeqCst) != target_version { return Ok(0); }
            
            match (File::open(&vocal_path), File::open(&inst_path)) {
                (Ok(v), Ok(i)) => {
                    sources.push((v, i));
                    break;
                }
                _ if i < 4 => {
                    sys_log(&format!("[AUDIO] Retry {}/5: Opening MR files ({:?})", i + 1, vocal_path));
                    tokio::time::sleep(tokio::time::Duration::from_millis(300)).await;
                }
                (Err(e1), _) => return Err(format!("Vocal 파일을 열 수 없습니다: {} (Path: {:?})", e1, vocal_path)),
                (_, Err(e2)) => return Err(format!("Inst 파일을 열 수 없습니다: {} (Path: {:?})", e2, inst_path)),
            }
        }

        let (v_file, i_file) = sources.pop().unwrap();
        
        // [FIX] Get metadata before moving files into decoders
        let i_file_size = i_file.metadata().map(|m| m.len()).unwrap_or(0);
        
        let mut v_decoder = rodio::Decoder::new(BufReader::new(v_file)).map_err(|e| e.to_string())?;
        let mut i_decoder = rodio::Decoder::new(BufReader::new(i_file)).map_err(|e| e.to_string())?;
        
        handler.track_sample_rate.store(v_decoder.sample_rate().into(), Ordering::Relaxed);

        if let Some(ms) = start_pos_ms {
            let _ = v_decoder.try_seek(Duration::from_millis(ms));
            let _ = i_decoder.try_seek(Duration::from_millis(ms));
        }
        
        let ms = if let Some(d) = i_decoder.total_duration() {
            let val = d.as_millis() as u64;
            handler.total_duration_ms.store(val, Ordering::Relaxed);
            val
        } else {
            // Fallback: Estimate duration if metadata fails
            let mut est_ms = 0;
            if i_file_size > 0 && handler.track_sample_rate.load(Ordering::Relaxed) > 0 {
                let rate = handler.track_sample_rate.load(Ordering::Relaxed) as u64;
                let est_sec = i_file_size / (rate * 2 * 2); 
                if est_sec > 0 {
                    est_ms = est_sec * 1000;
                    handler.total_duration_ms.store(est_ms, Ordering::Relaxed);
                    sys_log(&format!("[AUDIO] Estimated duration from file size: {}s", est_sec));
                }
            }
            est_ms
        };

        let mut current_duration = String::new();
        if let Ok(d_str) = DB.lock().query_row("SELECT duration FROM Tracks WHERE path = ?", rusqlite::params![&path], |row| row.get::<_, String>(0)) {
            current_duration = d_str;
        }
        if (current_duration == "0:00" || current_duration.is_empty()) && ms > 0 {
            let secs = ms / 1000;
            let new_duration = format!("{}:{:02}", secs / 60, secs % 60);
            let _ = crate::library::update_track_duration(&path, &new_duration);
            sys_log(&format!("[DB] Updated missing duration for {}: {}", path, new_duration));
        }

        let stretched_v = StretchedSource::new(v_decoder, handler.active_pitch.clone(), handler.active_tempo.clone(), Arc::new(AtomicU64::new(0)));
        let stretched_i = StretchedSource::new(i_decoder, handler.active_pitch.clone(), handler.active_tempo.clone(), handler.current_pos_samples.clone());
        
        let resampled_v = UniformSourceIterator::new(DynamicVolumeSource::new(stretched_v, handler.vocal_volume.clone()), target_channels_nz, target_rate_nz);
        let resampled_i = UniformSourceIterator::new(DynamicVolumeSource::new(stretched_i, handler.instrumental_volume.clone()), target_channels_nz, target_rate_nz);

        let mixed = resampled_i.mix(resampled_v);
        
        let final_v = PLAYBACK_VERSION.load(Ordering::SeqCst);
        if final_v != target_version { return Ok(0); }
        
        {
            let controller = handler.controller.lock();
            controller.append(mixed);
            if play_now {
                controller.play();
            } else {
                controller.pause();
            }
        }

        {
            let mut state = handler.state.lock();
            state.current_track = Some(path.clone());
            state.is_playing = play_now;
        }
        
        let status = if play_now { Status::Playing } else { Status::Paused };
        let msg = if play_now { "Playing" } else { "Prepared" };
        window.emit("playback-status", PlaybackStatus { status, message: msg.into() }).unwrap();
        sys_log("[DEBUG] Starting instantaneous playback from local MR cache.");
        return Ok(ms);
    }

    // Case 2: Fallback to Original source
    let play_path = if path.starts_with("http") {
        if start_pos_ms.is_none() {
            window.emit("playback-status", PlaybackStatus { status: Status::Downloading, message: "유튜브 오디오 준비 중...".into() }).ok();
        }
        let metadata = YoutubeManager::get_video_metadata(&path).await?;
        
        if PLAYBACK_VERSION.load(Ordering::SeqCst) != target_version { return Ok(0); }

        let temp_dir = window.state::<crate::state::AppPaths>().temp.clone();
        let final_path = temp_dir.join(format!("yt_{}.m4a", metadata.id.unwrap_or_else(|| "unknown".into())));
        
        if !final_path.exists() {
            YoutubeManager::download_audio(&window, &path, final_path.clone(), false).await?;
        } else {
            let is_yt_active = {
                let active = crate::audio_player::ACTIVE_DOWNLOADS.lock();
                active.contains(&final_path)
            };
            
            if is_yt_active {
                sys_log("[AUDIO] YouTube file is being written by another task, waiting...");
                tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;
            }
        }
        final_path
    } else {
        if start_pos_ms.is_none() {
            window.emit("playback-status", PlaybackStatus { status: Status::Decoding, message: "곡 데이터를 읽는 중...".into() }).ok();
        }
        std::path::PathBuf::from(&path)
    };

    if PLAYBACK_VERSION.load(Ordering::SeqCst) != target_version { return Ok(0); }

    if !play_path.exists() && !path.starts_with("http") {
        return Err("파일을 찾을 수 없습니다".into());
    }

    let is_yt = path.starts_with("http");
    let mut decoder_result = None;
    let mut first_error_msg = String::new();

    for i in 0..5 {
        if PLAYBACK_VERSION.load(Ordering::SeqCst) != target_version { return Ok(0); }

        let reader = match StreamingReader::new(play_path.clone(), is_yt) {
            Ok(r) => r,
            Err(e) => {
                if i < 4 {
                    tokio::time::sleep(tokio::time::Duration::from_millis(300)).await;
                    continue;
                }
                return Err(format!("파일을 열 수 없습니다: {}", e));
            }
        };

        match rodio::Decoder::new(std::io::BufReader::new(reader)) {
            Ok(d) => {
                decoder_result = Some(d);
                break;
            }
            Err(e) => {
                first_error_msg = e.to_string();
                if i < 4 {
                    sys_log(&format!("[AUDIO] Decoding retry {}/5...", i + 1));
                    tokio::time::sleep(tokio::time::Duration::from_millis(300)).await;
                } else {
                    return Err(format!("디코딩 실패: {}", e));
                }
            }
        }
    }
    
    let mut decoder = decoder_result.ok_or_else(|| format!("디코딩 실패: {}", first_error_msg))?;
    
    if PLAYBACK_VERSION.load(Ordering::SeqCst) != target_version { return Ok(0); }
    
    handler.track_sample_rate.store(decoder.sample_rate().into(), Ordering::Relaxed);
    if let Some(ms) = start_pos_ms { let _ = decoder.try_seek(Duration::from_millis(ms)); }
    
    if let Some(d) = decoder.total_duration() {
        let ms = d.as_millis() as u64;
        handler.total_duration_ms.store(ms, Ordering::Relaxed);

        let mut current_duration = String::new();
        if let Ok(d_str) = DB.lock().query_row("SELECT duration FROM Tracks WHERE path = ?", rusqlite::params![&path], |row| row.get::<_, String>(0)) {
            current_duration = d_str;
        }
        if current_duration == "0:00" || current_duration.is_empty() {
            let secs = ms / 1000;
            let new_duration = format!("{}:{:02}", secs / 60, secs % 60);
            let _ = crate::library::update_track_duration(&path, &new_duration);
            sys_log(&format!("[DB] Updated missing duration for {}: {}", path, new_duration));
        }
    }

    let stretched = StretchedSource::new(decoder, handler.active_pitch.clone(), handler.active_tempo.clone(), handler.current_pos_samples.clone());
    let dyn_vol = DynamicVolumeSource::new(stretched, handler.instrumental_volume.clone());
    let resampled = UniformSourceIterator::new(dyn_vol, target_channels_nz, target_rate_nz);
    
    let final_v = PLAYBACK_VERSION.load(Ordering::SeqCst);
    if final_v != target_version { return Ok(0); }
    
    {
        let controller = handler.controller.lock();
        controller.append(resampled);
        if play_now {
            controller.play();
        } else {
            controller.pause();
        }
    }
    
    {
        let mut state = handler.state.lock();
        state.current_track = Some(path.clone());
        state.is_playing = play_now;
    }
    
    let status = if play_now { Status::Playing } else { Status::Paused };
    let msg = if play_now { "Playing" } else { "Prepared" };
    window.emit("playback-status", PlaybackStatus { status, message: msg.into() }).unwrap();
    sys_log("[DEBUG] Starting playback (Original/Fallback)");
    Ok(handler.total_duration_ms.load(Ordering::Relaxed))
}

#[tauri::command]
pub fn set_master_volume(volume: f32) -> Result<(), String> {
    if let Ok(handler) = &*AUDIO_HANDLER {
        let controller = handler.controller.lock();
        let ratio = volume / 125.0;
        let final_vol = ratio * ratio;
        sys_log(&format!("[AUDIO] Master Volume set to: {} (ratio: {:.4})", volume, final_vol));
        controller.set_volume(final_vol);
    }
    Ok(())
}

#[tauri::command]
pub async fn toggle_playback() -> Result<bool, String> {
    let handler = AUDIO_HANDLER.as_ref().map_err(|e| e.clone())?.clone();
    
    let new_is_playing = {
        let controller = handler.controller.lock();
        if controller.is_paused() {
            controller.play();
            true
        } else {
            controller.pause();
            false
        }
    };

    {
        let mut state = handler.state.lock();
        state.is_playing = new_is_playing;
    }

    Ok(new_is_playing)
}

#[tauri::command]
pub fn get_alignment_sync_state() -> Result<PlaybackProgress, String> {
    let handler = match &*AUDIO_HANDLER {
        Ok(h) => h.clone(),
        Err(e) => return Err(e.clone()),
    };

    let rate = handler.track_sample_rate.load(Ordering::Relaxed);
    let pos_samples = handler.current_pos_samples.load(Ordering::Relaxed);
    let duration_ms = handler.total_duration_ms.load(Ordering::Relaxed);
    
    let position_ms = if rate > 0 {
        (pos_samples as f64 / rate as f64 * 1000.0) as u64
    } else {
        0
    };

    Ok(PlaybackProgress {
        position_ms,
        duration_ms,
    })
}

#[tauri::command]
pub async fn stop_playback() -> Result<(), String> {
    if let Ok(handler) = &*AUDIO_HANDLER {
        let controller = handler.controller.lock();
        controller.clear();
        let mut state = handler.state.lock();
        state.is_playing = false;
        state.current_track = None;
    }
    Ok(())
}

#[tauri::command]
pub async fn set_volume(volume: f64) -> Result<(), String> {
    let handler = AUDIO_HANDLER.as_ref().map_err(|e| e.clone())?.clone();
    let (v_enabled, balance) = {
        let mut state = handler.state.lock();
        state.volume = volume as f32;
        (state.vocal_enabled, state.vocal_balance)
    };
    
    let v_ratio = (balance / 50.0).min(1.0);
    let i_ratio = ((100.0 - balance) / 50.0).min(1.0);
    
    let vol_f = volume as f32;
    let v_vol = if v_enabled { vol_f * v_ratio } else { 0.0 };
    let i_vol = vol_f * i_ratio;

    handler.vocal_volume.store(v_vol.to_bits(), Ordering::Relaxed);
    handler.instrumental_volume.store(i_vol.to_bits(), Ordering::Relaxed);
    sys_log(&format!("[AUDIO] Track Volume set: Global={}, Vocal={:.2}, Inst={:.2} (Balance: {})", volume, v_vol, i_vol, balance));
    Ok(())
}

#[tauri::command]
pub async fn set_vocal_balance(balance: f64) -> Result<(), String> {
    let handler = AUDIO_HANDLER.as_ref().map_err(|e| e.clone())?.clone();
    let (v_enabled, global_volume) = {
        let mut state = handler.state.lock();
        state.vocal_balance = balance as f32;
        (state.vocal_enabled, state.volume)
    };

    let v_ratio = (balance as f32 / 50.0).min(1.0);
    let i_ratio = ((100.0 - balance as f32) / 50.0).min(1.0);

    let v_vol = if v_enabled { global_volume * v_ratio } else { 0.0 };
    let i_vol = global_volume * i_ratio;

    handler.vocal_volume.store(v_vol.to_bits(), Ordering::Relaxed);
    handler.instrumental_volume.store(i_vol.to_bits(), Ordering::Relaxed);
    Ok(())
}

#[tauri::command]
pub async fn set_pitch(semitones: f64) -> Result<(), String> {
    let handler = AUDIO_HANDLER.as_ref().map_err(|e| e.clone())?.clone();
    handler.active_pitch.store((semitones as f32).to_bits(), Ordering::Relaxed);
    Ok(())
}

#[tauri::command]
pub async fn set_tempo(ratio: f64) -> Result<(), String> {
    let handler = AUDIO_HANDLER.as_ref().map_err(|e| e.clone())?.clone();
    handler.active_tempo.store((ratio as f32).to_bits(), Ordering::Relaxed);
    Ok(())
}

#[tauri::command]
pub async fn seek_to(window: WebviewWindow, position_ms: u64) -> Result<(), String> {
    let handler = AUDIO_HANDLER.as_ref().map_err(|e| e.clone())?.clone();
    let (path, duration_ms) = {
        let state = handler.state.lock();
        (state.current_track.clone(), handler.total_duration_ms.load(Ordering::Relaxed))
    };

    if let Some(p) = path {
        let current_instrumental = handler.instrumental_volume.load(Ordering::Relaxed);
        let current_vocal = handler.vocal_volume.load(Ordering::Relaxed);
        
        handler.instrumental_volume.store(0f32.to_bits(), Ordering::Relaxed);
        handler.vocal_volume.store(0f32.to_bits(), Ordering::Relaxed);
        
        tokio::time::sleep(tokio::time::Duration::from_millis(60)).await;

        sys_log(&format!("[AUDIO] Seek request: {}ms for {}", position_ms, p));
        
        handler.instrumental_volume.store(current_instrumental, Ordering::Relaxed);
        handler.vocal_volume.store(current_vocal, Ordering::Relaxed);
        
        match play_track_internal(window.clone(), p.clone(), Some(duration_ms), Some(position_ms), true).await {
            Ok(_) => {},
            Err(e) => {
                sys_log(&format!("[AUDIO] Seek-Play failed: {}", e));
                let _ = window.emit("playback-status", PlaybackStatus { 
                    status: Status::Error, 
                    message: format!("Seek failed: {}", e) 
                });
                return Err(e);
            }
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn toggle_ai_feature(feature: String, enabled: bool) -> Result<(), String> {
    if let Ok(handler) = &*AUDIO_HANDLER {
        let mut state = handler.state.lock();
        match feature.as_str() {
            "vocal" => {
                state.vocal_enabled = enabled;
                let global_vol = state.volume;
                let balance = state.vocal_balance;
                let v_ratio = (balance / 50.0).min(1.0);
                let target_v_vol = if enabled { global_vol * v_ratio } else { 0.0 };
                handler.vocal_volume.store(target_v_vol.to_bits(), Ordering::Relaxed);
            },
            "lyric" => state.lyric_enabled = enabled,
            _ => {}
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn get_playback_state() -> Result<AppState, String> {
    let handler = AUDIO_HANDLER.as_ref().map_err(|e| e.clone())?.clone();
    let state = handler.state.lock().clone();
    Ok(state)
}

#[tauri::command]
pub async fn get_model_settings() -> Result<String, String> {
    let db = DB.lock();
    let res = db.query_row("SELECT value FROM Settings WHERE key = 'active_model_id'", [], |row| row.get::<_, String>(0));
    Ok(res.unwrap_or_else(|_| "kim".to_string()))
}

#[tauri::command]
pub async fn get_ai_engine_status() -> String {
    let engine = crate::separation::ROFORMER_ENGINE.lock();
    if let Some(engine) = engine.as_ref() {
        engine.get_provider()
    } else {
        "None (Idle)".to_string()
    }
}

#[tauri::command]
pub async fn update_model_settings(model_id: String) -> Result<(), String> {
    let db = DB.lock();
    db.execute("INSERT OR REPLACE INTO Settings (key, value) VALUES ('active_model_id', ?)", rusqlite::params![model_id]).map_err(|e| e.to_string())?;
    let mut engine = crate::separation::ROFORMER_ENGINE.lock();
    *engine = None;
    Ok(())
}

pub fn start_playback_progress_loop(handle: tauri::AppHandle) {
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_millis(100));
        if let Ok(handler) = &*AUDIO_HANDLER {
            let samples = handler.current_pos_samples.load(Ordering::Relaxed);
            let mut duration_ms = handler.total_duration_ms.load(Ordering::Relaxed);
            let track_rate = handler.track_sample_rate.load(Ordering::Relaxed);
            
            // Fallback: If duration is 0, try to get it from the DB
            if duration_ms == 0 {
                if let Some(track_path) = handler.state.lock().current_track.clone() {
                    if let Ok(d_str) = crate::state::DB.lock().query_row(
                        "SELECT duration FROM Tracks WHERE path = ?", 
                        rusqlite::params![track_path], 
                        |row| row.get::<_, String>(0)
                    ) {
                        let parts: Vec<&str> = d_str.split(':').collect();
                        if parts.len() == 2 {
                            let m = parts[0].parse::<u64>().unwrap_or(0);
                            let s = parts[1].parse::<u64>().unwrap_or(0);
                            duration_ms = (m * 60 + s) * 1000;
                            handler.total_duration_ms.store(duration_ms, Ordering::Relaxed);
                        }
                    }
                }
            }
            
            let pos_ms = if track_rate > 0 { 
                ((samples as u128 * 1000) / track_rate as u128) as u64
            } else { 0 };

            let is_locked = crate::audio_player::IS_PREPARING_PLAYBACK.load(Ordering::SeqCst);
            let sink_empty = handler.controller.lock().empty();
            
            if (sink_empty || (duration_ms > 0 && pos_ms >= duration_ms + 1000)) && duration_ms > 0 && !is_locked {
                let was_playing = {
                    let mut state = handler.state.lock();
                    if state.is_playing {
                        state.is_playing = false;
                        state.current_track = None;
                        true
                    } else { false }
                };
                if was_playing {
                    let _ = handle.emit("playback-status", PlaybackStatus { status: Status::Finished, message: "Finished".into() });
                }
            }

            if duration_ms > 0 {
                let _ = handle.emit("playback-progress", PlaybackProgress { position_ms: pos_ms, duration_ms });
            }
        }
    });
}

