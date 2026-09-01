use tauri::Manager;
pub use crate::types::{Status, PlaybackStatus, PlaybackProgress, AppState, SongMetadata};

mod types;
mod youtube;
pub use lmrm_logic::youtube_url;
mod model_manager;
mod custom_models;
pub mod vocal_remover;
pub mod audio_player;
mod separation;
pub mod state;
mod alignment;
mod metadata_fetcher;
pub mod audio;
pub mod onnx_engine;
mod library;
mod key_bpm;
mod audio_commands;
mod mr_cache;
mod mr_encode;
mod ffmpeg_tools;
mod model_commands;
mod system;
mod spreadsheet;
mod rescue;
mod overlay_server;
mod cache_settings;
mod updater;
mod songbook_auth;
mod env_config;
pub use lmrm_logic::ipc_validate;

fn focus_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

pub fn run() {
    env_config::load_env_files();
    let mut builder = tauri::Builder::default();

    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            focus_main_window(app);
            crate::songbook_auth::handle_deep_link_urls(app, &argv);
        }));
    }

    builder
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_deep_link::init())
        .setup(|app| {
            if let Some(window) = app.get_webview_window("main") {
                *crate::state::MAIN_WINDOW.lock() = Some(window);
            }

            let paths = crate::state::AppPaths::from_handle(app.handle());
            let overlay_allow_lan = crate::state::AppConfig::load(&paths.root).overlay_allow_lan;
            *crate::state::APP_PATHS.lock() = Some(paths.clone());
            app.manage(paths);
            crate::audio_player::sys_log("[App] Startup complete");
            let _ = &*crate::state::DB;
            crate::mr_cache::load_persisted_format();

            crate::audio_commands::start_playback_progress_loop(app.handle().clone());

            crate::overlay_server::init(app.handle().clone());
            tauri::async_runtime::spawn(crate::overlay_server::start_overlay_server(overlay_allow_lan));

            crate::updater::start_update_checker(app.handle().clone());

            #[cfg(desktop)]
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                let handle = app.handle().clone();
                if let Err(err) = app.deep_link().register_all() {
                    crate::audio_player::sys_log(&format!(
                        "[SongbookAuth] deep-link register_all: {err}"
                    ));
                }
                app.deep_link().on_open_url(move |event| {
                    let urls: Vec<String> =
                        event.urls().into_iter().map(|u| u.to_string()).collect();
                    crate::songbook_auth::handle_deep_link_urls(&handle, &urls);
                });
                if let Ok(Some(urls)) = app.deep_link().get_current() {
                    let urls: Vec<String> = urls.into_iter().map(|u| u.to_string()).collect();
                    crate::songbook_auth::handle_deep_link_urls(app.handle(), &urls);
                }
            }

            tauri::async_runtime::spawn(async {
                if let Some(path) = crate::ffmpeg_tools::ensure_managed_ffmpeg().await {
                    crate::audio_player::sys_log(&format!(
                        "[Tools] ffmpeg ready at {}",
                        path.to_string_lossy()
                    ));
                }
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            audio_commands::get_model_settings, audio_commands::update_model_settings,
            audio_commands::play_track, audio_commands::toggle_playback, audio_commands::stop_playback, audio_commands::seek_to, audio_commands::set_pitch, audio_commands::set_tempo, audio_commands::set_volume, audio_commands::set_master_volume,
            audio_commands::set_vocal_balance, audio_commands::toggle_ai_feature,
            model_commands::check_mr_separated,
            model_commands::get_separation_info,
            model_commands::delete_mr,
            model_commands::start_mr_separation,
            model_commands::youtube_metadata_fetcher,
            model_commands::search_youtube,
            audio_commands::youtube_preview_audio,
            model_commands::list_model_presets,
            model_commands::list_all_models,
            model_commands::list_custom_models,
            model_commands::add_custom_model,
            model_commands::remove_custom_model,
            library::get_audio_metadata, audio_commands::get_playback_state,
            model_commands::check_ai_runtime, model_commands::check_model_ready, model_commands::download_ai_model,
            library::save_library, library::load_library, library::get_songs, library::get_categories, library::get_genres,
            library::get_track_count,
            model_commands::cancel_separation,
            model_commands::set_broadcast_mode,
            model_commands::get_mr_cache_format,
            model_commands::set_mr_cache_format,
            system::get_audio_devices,
            system::open_cache_folder,
            model_commands::delete_ai_model,
            model_commands::get_gpu_recommendation,
            library::add_category, library::delete_category,
            library::delete_song, library::map_track_to_categories,
            system::get_app_paths,
            system::export_backup,
            system::import_backup,
            system::export_library_spreadsheet,
            system::import_library_spreadsheet,
            system::pick_audio_files,
            rescue::run_cache_rescue,
            rescue::run_local_rescue,
            model_commands::get_active_separations,
            audio_commands::get_ai_engine_status,
            library::update_song_metadata,
            key_bpm::analyze_key_bpm,
            audio_commands::get_alignment_sync_state,
            alignment::get_separated_audio_list, alignment::run_forced_alignment,
            alignment::cancel_forced_alignment, alignment::read_audio_file,
            alignment::apply_alignment_tuning,
            alignment::get_waveform_summary, alignment::get_model_list,
            alignment::save_lrc_file, alignment::load_lrc_file,
            alignment::list_alignment_models, alignment::download_alignment_model,
            alignment::cancel_alignment_model_download, alignment::delete_alignment_model,
            system::remote_js_log,
            updater::check_for_app_update,
            updater::peek_app_update,
            updater::open_app_update_page,
            metadata_fetcher::search_track_metadata, metadata_fetcher::fetch_and_process_tags,
            metadata_fetcher::init_metadata_context, metadata_fetcher::get_unclassified_tags,
            metadata_fetcher::update_custom_dictionary, metadata_fetcher::sync_dictionary_to_db,
            overlay_server::update_overlay_state,
            overlay_server::update_overlay_queue,
            overlay_server::update_overlay_style,
            overlay_server::update_overlay_lyrics,
            overlay_server::update_overlay_lyrics_full,
            overlay_server::get_overlay_state,
            overlay_server::get_lan_addresses,
            cache_settings::get_mr_cache_path_info,
            cache_settings::check_mr_cache_path,
            cache_settings::set_mr_cache_path,
            cache_settings::pick_mr_cache_folder,
            cache_settings::get_overlay_lan_setting,
            cache_settings::set_overlay_lan_setting,
            songbook_auth::get_songbook_auth,
            songbook_auth::begin_songbook_oauth,
            songbook_auth::set_songbook_user,
            songbook_auth::clear_songbook_auth
        ])

        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
