use std::{
    collections::HashMap,
    net::SocketAddr,
    sync::Arc,
};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{mpsc, Mutex};
use tokio_tungstenite::tungstenite::Message;
use futures_util::{SinkExt, StreamExt};
use serde::{Serialize, Deserialize};
use once_cell::sync::Lazy;
use tauri::Emitter;


#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct OverlayStyle {
    pub scale: f32,
    pub font: String,
    pub color: String,
    pub bg_color: String,
    pub bg_opacity: f32,
    pub rounding: f32,
    pub animation_direction: String,
}

impl Default for OverlayStyle {
    fn default() -> Self {
        Self {
            scale: 1.0,
            font: "Inter".to_string(),
            color: "3b82f6".to_string(),
            bg_color: "0f0f14".to_string(),
            bg_opacity: 0.6,
            rounding: 20.0,
            animation_direction: "left".to_string(),
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct OverlayState {
    pub title: String,
    pub artist: String,
    pub thumbnail: String,
    pub is_playing: bool,
    pub current_lyric: String,
    pub next_lyric: String,

    pub info_style: OverlayStyle,
    pub lyrics_style: OverlayStyle,

    pub is_force_visible: bool,
}

impl Default for OverlayState {
    fn default() -> Self {
        Self {
            title: "Ready to Play".to_string(),
            artist: "Waiting for music...".to_string(),
            thumbnail: "".to_string(),
            is_playing: false,
            current_lyric: "".to_string(),
            next_lyric: "".to_string(),
            info_style: OverlayStyle::default(),
            lyrics_style: OverlayStyle {
                color: "ffffff".to_string(),
                ..OverlayStyle::default()
            },
            is_force_visible: false,
        }
    }
}


type PeerMap = Arc<Mutex<HashMap<SocketAddr, mpsc::UnboundedSender<Message>>>>;

static PEERS: Lazy<PeerMap> = Lazy::new(|| Arc::new(Mutex::new(HashMap::new())));
static CURRENT_STATE: Lazy<Mutex<OverlayState>> = Lazy::new(|| Mutex::new(OverlayState::default()));
static APP_HANDLE: Lazy<Mutex<Option<tauri::AppHandle>>> = Lazy::new(|| Mutex::new(None));

pub fn init(handle: tauri::AppHandle) {
    let mut h = APP_HANDLE.blocking_lock();
    *h = Some(handle);
}

static OVERLAY_INFO_HTML: &str = include_str!("../../src/overlay-info.html");
static OVERLAY_LYRICS_HTML: &str = include_str!("../../src/overlay-lyrics.html");
static APP_ICON: &[u8] = include_bytes!("../../src/assets/images/app-icon.png");

pub async fn start_overlay_server() {
    // 1. Start WebSocket Data Server (Port 14201)
    let ws_addr = "0.0.0.0:14201".to_string();
    let ws_listener = match TcpListener::bind(&ws_addr).await {
        Ok(listener) => listener,
        Err(e) => {
            crate::audio_player::sys_log(&format!(
                "[Overlay] WebSocket bind failed on {}: {}. Overlay server disabled for this run.",
                ws_addr, e
            ));
            return;
        }
    };
    println!("[Overlay] WebSocket Data Server listening on: {}", ws_addr);

    tokio::spawn(async move {
        while let Ok((stream, addr)) = ws_listener.accept().await {
            tokio::spawn(handle_ws_connection(PEERS.clone(), stream, addr));
        }
    });

    // 2. Start HTTP Page Server (Port 14202)
    let http_addr = "0.0.0.0:14202".to_string();
    let http_listener = match TcpListener::bind(&http_addr).await {
        Ok(listener) => listener,
        Err(e) => {
            crate::audio_player::sys_log(&format!(
                "[Overlay] HTTP bind failed on {}: {}. Overlay pages disabled for this run.",
                http_addr, e
            ));
            return;
        }
    };
    println!("[Overlay] HTTP Page Server listening on: {}", http_addr);

    tokio::spawn(async move {
        while let Ok((mut stream, addr)) = http_listener.accept().await {
            tokio::spawn(async move {
                use tokio::io::AsyncReadExt;
                let mut buffer = [0; 1024];
                if let Ok(n) = stream.read(&mut buffer).await {
                    let request = String::from_utf8_lossy(&buffer[..n]);
                    
                    if request.starts_with("GET /assets/images/app-icon.png") {
                        use tokio::io::AsyncWriteExt;
                        let response = format!(
                            "HTTP/1.1 200 OK\r\n\
                            Content-Type: image/png\r\n\
                            Content-Length: {}\r\n\
                            Access-Control-Allow-Origin: *\r\n\
                            Cache-Control: public, max-age=86400\r\n\
                            Connection: close\r\n\r\n",
                            APP_ICON.len()
                        );
                        let _ = stream.write_all(response.as_bytes()).await;
                        let _ = stream.write_all(APP_ICON).await;
                        let _ = stream.flush().await;
                        println!("[Overlay] Served app-icon.png to {}", addr);
                    } else if request.starts_with("GET /lyrics") {
                        use tokio::io::AsyncWriteExt;
                        let response = format!(
                            "HTTP/1.1 200 OK\r\n\
                            Content-Type: text/html; charset=utf-8\r\n\
                            Content-Length: {}\r\n\
                            Access-Control-Allow-Origin: *\r\n\
                            Cache-Control: no-cache, no-store, must-revalidate\r\n\
                            Connection: close\r\n\r\n\
                            {}",
                            OVERLAY_LYRICS_HTML.len(),
                            OVERLAY_LYRICS_HTML
                        );
                        let _ = stream.write_all(response.as_bytes()).await;
                        let _ = stream.flush().await;
                        println!("[Overlay] HTTP Page served to {} (Path: /lyrics)", addr);
                    } else if request.starts_with("GET / ") {
                        use tokio::io::AsyncWriteExt;
                        let response = format!(
                            "HTTP/1.1 200 OK\r\n\
                            Content-Type: text/html; charset=utf-8\r\n\
                            Content-Length: {}\r\n\
                            Access-Control-Allow-Origin: *\r\n\
                            Cache-Control: no-cache, no-store, must-revalidate\r\n\
                            Connection: close\r\n\r\n\
                            {}",
                            OVERLAY_INFO_HTML.len(),
                            OVERLAY_INFO_HTML
                        );
                        let _ = stream.write_all(response.as_bytes()).await;
                        let _ = stream.flush().await;
                        println!("[Overlay] HTTP Page served to {} (Path: /)", addr);
                    }
                }
            });
        }
    });
}

async fn handle_ws_connection(peers: PeerMap, raw_stream: TcpStream, addr: SocketAddr) {
    println!("[Overlay] New WS connection: {}", addr);
    
    let ws_stream = match tokio_tungstenite::accept_async(raw_stream).await {
        Ok(s) => s,
        Err(e) => {
            println!("[Overlay] WS Handshake failed for {}: {}", addr, e);
            return;
        }
    };
    
    let (tx, mut rx) = mpsc::unbounded_channel();
    peers.lock().await.insert(addr, tx.clone());

    // Send current state immediately on connection
    let state = CURRENT_STATE.lock().await.clone();
    let msg = serde_json::to_string(&state).unwrap();
    let _ = tx.send(Message::Text(msg));

    let (mut ws_sender, mut ws_receiver) = ws_stream.split();

    let mut send_task = tokio::spawn(async move {
        while let Some(msg) = rx.recv().await {
            if ws_sender.send(msg).await.is_err() {
                break;
            }
        }
    });

    let mut recv_task = tokio::spawn(async move {
        while let Some(msg) = ws_receiver.next().await {
            if let Ok(msg) = msg {
                if msg.is_close() {
                    break;
                }
            } else {
                break;
            }
        }
    });

    tokio::select! {
        _ = (&mut send_task) => recv_task.abort(),
        _ = (&mut recv_task) => send_task.abort(),
    };

    println!("[Overlay] Connection closed: {}", addr);
    peers.lock().await.remove(&addr);
}

use base64::{Engine as _, engine::general_purpose};

fn ensure_thumbnail_data_uri(thumbnail: String) -> String {
    if thumbnail.is_empty() || thumbnail.starts_with("http") || thumbnail.starts_with("data:") {
        return thumbnail;
    }

    // Handle tauri/asset protocols by stripping them if they are local-ish
    let path_str = if thumbnail.starts_with("tauri://localhost/_up_/") {
        thumbnail.replace("tauri://localhost/_up_/", "")
    } else if thumbnail.starts_with("asset://localhost/") {
         thumbnail.replace("asset://localhost/", "")
    } else {
        thumbnail.clone()
    };

    // Attempt to read local file and convert to Data URI
    if let Ok(bytes) = std::fs::read(&path_str) {
        let b64 = general_purpose::STANDARD.encode(bytes);
        let ext = std::path::Path::new(&path_str)
            .extension()
            .and_then(|s| s.to_str())
            .unwrap_or("png");
        return format!("data:image/{};base64,{}", ext, b64);
    }

    thumbnail
}

pub async fn broadcast_overlay_state(mut state: OverlayState) {
    state.thumbnail = ensure_thumbnail_data_uri(state.thumbnail);
    *CURRENT_STATE.lock().await = state.clone();
    let msg = serde_json::to_string(&state).unwrap();
    
    // Broadcast to WebSocket clients (OBS)
    let peers = PEERS.lock().await;
    for tx in peers.values() {
        let _ = tx.send(Message::Text(msg.clone()));
    }

    // Emit to Tauri windows (Internal Preview)
    if let Some(handle) = APP_HANDLE.lock().await.as_ref() {
        let _ = handle.emit("overlay-state-update", state);
    }
}



#[tauri::command]
pub async fn update_overlay_state(title: String, artist: String, thumbnail: String, is_playing: bool) {
    let mut state = CURRENT_STATE.lock().await.clone();
    state.title = title;
    state.artist = artist;
    state.thumbnail = thumbnail;
    state.is_playing = is_playing;
    broadcast_overlay_state(state).await;
}

#[tauri::command]
pub async fn update_overlay_style(target: String, scale: f32, font: String, color: String, bg_color: String, bg_opacity: f32, rounding: f32, is_force_visible: bool, animation_direction: String) {
    let mut state = CURRENT_STATE.lock().await.clone();
    let style = OverlayStyle {
        scale,
        font,
        color,
        bg_color,
        bg_opacity,
        rounding,
        animation_direction,
    };

    if target == "lyrics" {
        state.lyrics_style = style;
    } else {
        state.info_style = style;
    }
    state.is_force_visible = is_force_visible;
    broadcast_overlay_state(state).await;
}


#[tauri::command]
pub async fn update_overlay_lyrics(current: String, next: String) {
    let mut state = CURRENT_STATE.lock().await.clone();
    state.current_lyric = current;
    state.next_lyric = next;
    broadcast_overlay_state(state).await;
}
 
 
 
 
 
 
 
 
 
 
 
 
#[tauri::command]
pub async fn get_overlay_state() -> OverlayState {
    CURRENT_STATE.lock().await.clone()
}
