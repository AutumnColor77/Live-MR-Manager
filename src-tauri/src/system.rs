use tauri::{AppHandle, Manager, WebviewWindow, State};
use cpal::traits::{HostTrait, DeviceTrait};
use crate::types::SongMetadata;
use crate::library;

#[tauri::command]
pub fn get_app_paths(handle: AppHandle) -> crate::state::AppPaths { 
    handle.state::<crate::state::AppPaths>().inner().clone() 
}

#[tauri::command]
pub async fn get_audio_devices() -> Result<Vec<String>, String> {
    let host = cpal::default_host();
    let devices = host.output_devices().map_err(|e| e.to_string())?;
    let mut names = Vec::new();
    for d in devices {
        if let Ok(desc) = d.description() {
            let config = d.default_output_config().map(|c| format!("{}Hz, {}ch", u32::from(c.sample_rate()), c.channels())).unwrap_or_else(|_| "N/A".into());
            names.push(format!("{} ({})", desc.name(), config));
        }
    }
    Ok(names)
}

#[tauri::command]
pub async fn open_cache_folder(window: WebviewWindow) -> Result<(), String> {
    let path = window.state::<crate::state::AppPaths>().separated.clone();
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        std::process::Command::new("explorer").arg(path.to_string_lossy().to_string()).creation_flags(0x08000000).spawn().ok();
    }
    Ok(())
}

#[tauri::command]
pub async fn export_backup(paths: State<'_, crate::state::AppPaths>) -> Result<(), String> {
    if let Some(path) = rfd::AsyncFileDialog::new()
        .add_filter("JSON", &["json"])
        .set_file_name("LiveMR_Backup.json")
        .save_file()
        .await
    {
        let songs = library::get_songs_internal(paths.inner().clone()).await?;
        let json = serde_json::to_string_pretty(&songs).map_err(|e| e.to_string())?;
        std::fs::write(path.path(), json).map_err(|e| e.to_string())?;
        Ok(())
    } else {
        Err("CANCELLED".into())
    }
}

#[tauri::command]
pub async fn import_backup(_app: AppHandle, paths: State<'_, crate::state::AppPaths>) -> Result<(), String> {
    if let Some(path) = rfd::AsyncFileDialog::new()
        .add_filter("JSON", &["json"])
        .pick_file()
        .await
    {
        let json = std::fs::read_to_string(path.path()).map_err(|e| e.to_string())?;
        let backup_songs: Vec<SongMetadata> = serde_json::from_str(&json).map_err(|e| e.to_string())?;
        
        let mut current_songs = library::get_songs_internal(paths.inner().clone()).await?;
        let current_paths: std::collections::HashSet<String> = current_songs.iter().map(|s| s.path.clone()).collect();
        
        for song in backup_songs {
            if !current_paths.contains(&song.path) {
                current_songs.push(song);
            }
        }
        
        library::save_library_internal(current_songs).await?;
        Ok(())
    } else {
        Err("CANCELLED".into())
    }
}
#[tauri::command]
pub async fn remote_js_log(msg: String) {
    let _ = crate::audio_player::sys_log(&format!("[JS] {}", msg));
}
