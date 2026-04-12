use tauri::command;

#[command]
pub async fn remote_js_log(msg: String) {
    let _ = crate::audio_player::sys_log(&format!("[JS] {}", msg));
}
