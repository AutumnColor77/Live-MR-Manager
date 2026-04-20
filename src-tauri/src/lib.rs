use tauri::Manager;
pub use crate::types::{Status, PlaybackStatus, PlaybackProgress, AppState, SongMetadata};

mod types;
mod youtube;
mod model_manager;
pub mod vocal_remover;
pub mod audio_player;
mod separation;
pub mod state;
mod alignment;
mod metadata_fetcher;
pub mod audio;
pub mod onnx_engine;
mod library;
mod audio_commands;
mod model_commands;
mod system;
mod overlay_server;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            if let Some(window) = app.get_webview_window("main") {
                *crate::state::MAIN_WINDOW.lock() = Some(window);
            }

            let paths = crate::state::AppPaths::from_handle(app.handle());
            *crate::state::APP_PATHS.lock() = Some(paths.clone());
            app.manage(paths);
            let _ = &*crate::state::DB;
            
            crate::audio_commands::start_playback_progress_loop(app.handle().clone());
            
            // Start the OBS Overlay WebSocket server
            tauri::async_runtime::spawn(crate::overlay_server::start_overlay_server());
            
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            audio_commands::get_model_settings, audio_commands::update_model_settings,
            audio_commands::play_track, audio_commands::toggle_playback, audio_commands::stop_playback, audio_commands::seek_to, audio_commands::set_pitch, audio_commands::set_tempo, audio_commands::set_volume, audio_commands::set_master_volume,
            audio_commands::set_vocal_balance, audio_commands::toggle_ai_feature, 
            model_commands::check_mr_separated,
            model_commands::delete_mr, 
            model_commands::start_mr_separation, 
            model_commands::youtube_metadata_fetcher,
            library::get_audio_metadata, audio_commands::get_playback_state, 
            model_commands::check_ai_runtime, model_commands::check_model_ready, model_commands::download_ai_model, 
            library::save_library, library::load_library, library::get_songs, library::get_categories, library::get_genres, 
            library::get_track_count, 
            model_commands::cancel_separation, 
            model_commands::set_broadcast_mode,
            system::get_audio_devices, 
            system::open_cache_folder, 
            model_commands::delete_ai_model, 
            model_commands::get_gpu_recommendation, 
            library::add_category, library::delete_category,
            library::delete_song, library::map_track_to_categories, 
            system::get_app_paths, 
            system::export_backup, 
            system::import_backup, 
            model_commands::get_active_separations,
            audio_commands::get_ai_engine_status, 
            library::update_song_metadata,
            audio_commands::get_alignment_sync_state,
            alignment::get_separated_audio_list, alignment::run_forced_alignment,
            alignment::cancel_forced_alignment, alignment::read_audio_file,
            alignment::apply_alignment_tuning,
            alignment::get_waveform_summary, alignment::get_model_list,
            alignment::save_lrc_file, alignment::load_lrc_file,
            system::remote_js_log,            metadata_fetcher::search_track_metadata, metadata_fetcher::fetch_and_process_tags,
            metadata_fetcher::init_metadata_context, metadata_fetcher::get_unclassified_tags,
            metadata_fetcher::update_custom_dictionary, metadata_fetcher::sync_dictionary_to_db,
            overlay_server::update_overlay_state,
            overlay_server::update_overlay_style
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
