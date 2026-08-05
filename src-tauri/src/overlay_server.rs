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
    pub text_color: String,
    pub bg_color: String,
    pub bg_opacity: f32,
    pub rounding: f32,
    pub animation_direction: String,
    /// 가사 오버레이 전용 글씨 크기(px). 0이면 기본값 22px.
    #[serde(default)]
    pub font_size: f32,
    /// 대기열 오버레이: 항목 추가 시 카드가 늘어나는 방향 (`up` | `both` | `down`).
    #[serde(default = "default_queue_expand_direction")]
    pub queue_expand_direction: String,
}

fn default_queue_expand_direction() -> String {
    "both".to_string()
}

impl Default for OverlayStyle {
    fn default() -> Self {
        Self {
            scale: 1.0,
            font: "Inter".to_string(),
            color: "3b82f6".to_string(),
            text_color: "ffffff".to_string(),
            bg_color: "0f0f14".to_string(),
            bg_opacity: 0.6,
            rounding: 20.0,
            animation_direction: "left".to_string(),
            font_size: 0.0,
            queue_expand_direction: default_queue_expand_direction(),
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct QueuePreviewItem {
    pub title: String,
    pub artist: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct OverlayState {
    pub title: String,
    pub artist: String,
    pub thumbnail: String,
    pub is_playing: bool,
    pub current_lyric: String,
    pub next_lyric: String,
    pub theme_mode: String,

    pub info_style: OverlayStyle,
    pub lyrics_style: OverlayStyle,
    #[serde(default)]
    pub queue_style: OverlayStyle,

    pub is_force_visible: bool,

    /// Full lyric-line list + current-line index for the performer-facing
    /// `/lyrics-view` page (separate from the 2-line broadcast overlay).
    /// Each entry may itself contain multiple sub-lines (원문/차음/번역)
    /// joined with `\n` — receivers must split on `\n` and build DOM nodes
    /// themselves; never treat these strings as HTML (they can contain
    /// untrusted lyric/title/artist text from LRC files or fetched metadata).
    #[serde(default)]
    pub lyrics_lines: Vec<String>,
    #[serde(default = "default_lyric_index")]
    pub lyric_index: i32,
    #[serde(default)]
    pub queue_up_next: Vec<QueuePreviewItem>,
    #[serde(default = "default_show_queue")]
    pub show_queue: bool,
}

fn default_lyric_index() -> i32 {
    -1
}

fn default_show_queue() -> bool {
    true
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
            theme_mode: "dark".to_string(),
            info_style: OverlayStyle::default(),
            lyrics_style: OverlayStyle {
                color: "ffffff".to_string(),
                ..OverlayStyle::default()
            },
            queue_style: OverlayStyle {
                bg_opacity: 0.85,
                font_size: 16.0,
                ..OverlayStyle::default()
            },
            is_force_visible: false,
            lyrics_lines: Vec::new(),
            lyric_index: -1,
            queue_up_next: Vec::new(),
            show_queue: true,
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
static OVERLAY_QUEUE_HTML: &str = include_str!("../../src/overlay-queue.html");
static LYRICS_VIEW_HTML: &str = include_str!("../../src/lyrics-view.html");
static OVERLAY_SHARED_JS: &str = include_str!("../../src/js/overlay/shared.js");
static APP_ICON: &[u8] = include_bytes!("../../src/assets/images/app-icon.png");

fn resolve_overlay_info_html() -> String {
    #[cfg(debug_assertions)]
    {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../src/overlay-info.html");
        if let Ok(content) = std::fs::read_to_string(&path) {
            return content;
        }
    }
    OVERLAY_INFO_HTML.to_string()
}

fn resolve_overlay_lyrics_html() -> String {
    #[cfg(debug_assertions)]
    {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../src/overlay-lyrics.html");
        if let Ok(content) = std::fs::read_to_string(&path) {
            return content;
        }
    }
    OVERLAY_LYRICS_HTML.to_string()
}

fn resolve_overlay_queue_html() -> String {
    #[cfg(debug_assertions)]
    {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../src/overlay-queue.html");
        if let Ok(content) = std::fs::read_to_string(&path) {
            return content;
        }
    }
    OVERLAY_QUEUE_HTML.to_string()
}

fn resolve_lyrics_view_html() -> String {
    #[cfg(debug_assertions)]
    {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../src/lyrics-view.html");
        if let Ok(content) = std::fs::read_to_string(&path) {
            return content;
        }
    }
    LYRICS_VIEW_HTML.to_string()
}

fn resolve_overlay_shared_js() -> String {
    #[cfg(debug_assertions)]
    {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../src/js/overlay/shared.js");
        if let Ok(content) = std::fs::read_to_string(&path) {
            return content;
        }
    }
    OVERLAY_SHARED_JS.to_string()
}

/// `allow_lan` gates whether the overlay HTTP/WS servers bind to all
/// interfaces (LAN-reachable) or just loopback. Read once from the persisted
/// setting at startup (see `cache_settings::set_overlay_lan_setting`) —
/// toggling it in Settings requires a restart to actually change the bind
/// address, which the UI must communicate.
pub async fn start_overlay_server(allow_lan: bool) {
    let bind_host = if allow_lan { "0.0.0.0" } else { "127.0.0.1" };

    // 1. Start WebSocket Data Server (Port 14201)
    let ws_addr = format!("{}:14201", bind_host);
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
    let http_addr = format!("{}:14202", bind_host);
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
                    } else if request.starts_with("GET /js/overlay/shared.js") {
                        let js = resolve_overlay_shared_js();
                        use tokio::io::AsyncWriteExt;
                        let response = format!(
                            "HTTP/1.1 200 OK\r\n\
                            Content-Type: application/javascript; charset=utf-8\r\n\
                            Content-Length: {}\r\n\
                            Access-Control-Allow-Origin: *\r\n\
                            Cache-Control: no-cache, no-store, must-revalidate\r\n\
                            Connection: close\r\n\r\n\
                            {}",
                            js.len(),
                            js
                        );
                        let _ = stream.write_all(response.as_bytes()).await;
                        let _ = stream.flush().await;
                        println!("[Overlay] Served shared.js to {}", addr);
                    } else if request.starts_with("GET /lyrics-view") {
                        // Performer-facing full-lyrics page (OBS custom dock /
                        // any browser). Must be matched before the `/lyrics`
                        // prefix branch below — keep this ordering.
                        let html = resolve_lyrics_view_html();
                        use tokio::io::AsyncWriteExt;
                        let response = format!(
                            "HTTP/1.1 200 OK\r\n\
                            Content-Type: text/html; charset=utf-8\r\n\
                            Content-Length: {}\r\n\
                            Access-Control-Allow-Origin: *\r\n\
                            Cache-Control: no-cache, no-store, must-revalidate\r\n\
                            Connection: close\r\n\r\n\
                            {}",
                            html.len(),
                            html
                        );
                        let _ = stream.write_all(response.as_bytes()).await;
                        let _ = stream.flush().await;
                        println!("[Overlay] HTTP Page served to {} (Path: /lyrics-view)", addr);
                    } else if request.starts_with("GET /queue")
                        || request.starts_with("GET /overlay-queue")
                    {
                        let html = resolve_overlay_queue_html();
                        use tokio::io::AsyncWriteExt;
                        let response = format!(
                            "HTTP/1.1 200 OK\r\n\
                            Content-Type: text/html; charset=utf-8\r\n\
                            Content-Length: {}\r\n\
                            Access-Control-Allow-Origin: *\r\n\
                            Cache-Control: no-cache, no-store, must-revalidate\r\n\
                            Connection: close\r\n\r\n\
                            {}",
                            html.len(),
                            html
                        );
                        let _ = stream.write_all(response.as_bytes()).await;
                        let _ = stream.flush().await;
                        println!("[Overlay] HTTP Page served to {} (Path: /queue)", addr);
                    } else if request.starts_with("GET /lyrics")
                        || request.starts_with("GET /overlay-lyrics")
                    {
                        let html = resolve_overlay_lyrics_html();
                        use tokio::io::AsyncWriteExt;
                        let response = format!(
                            "HTTP/1.1 200 OK\r\n\
                            Content-Type: text/html; charset=utf-8\r\n\
                            Content-Length: {}\r\n\
                            Access-Control-Allow-Origin: *\r\n\
                            Cache-Control: no-cache, no-store, must-revalidate\r\n\
                            Connection: close\r\n\r\n\
                            {}",
                            html.len(),
                            html
                        );
                        let _ = stream.write_all(response.as_bytes()).await;
                        let _ = stream.flush().await;
                        println!("[Overlay] HTTP Page served to {} (Path: /lyrics or /overlay-lyrics)", addr);
                    } else if request.starts_with("GET / ")
                        || request.starts_with("GET /overlay-info")
                    {
                        let html = resolve_overlay_info_html();
                        use tokio::io::AsyncWriteExt;
                        let response = format!(
                            "HTTP/1.1 200 OK\r\n\
                            Content-Type: text/html; charset=utf-8\r\n\
                            Content-Length: {}\r\n\
                            Access-Control-Allow-Origin: *\r\n\
                            Cache-Control: no-cache, no-store, must-revalidate\r\n\
                            Connection: close\r\n\r\n\
                            {}",
                            html.len(),
                            html
                        );
                        let _ = stream.write_all(response.as_bytes()).await;
                        let _ = stream.flush().await;
                        println!("[Overlay] HTTP Page served to {} (Path: / or /overlay-info)", addr);
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
pub async fn update_overlay_queue(items: Vec<QueuePreviewItem>, show_queue: bool) {
    let mut state = CURRENT_STATE.lock().await.clone();
    state.queue_up_next = items.into_iter().take(3).collect();
    state.show_queue = show_queue;
    broadcast_overlay_state(state).await;
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
pub async fn update_overlay_style(
    target: String,
    scale: f32,
    font: String,
    color: String,
    text_color: String,
    bg_color: String,
    bg_opacity: f32,
    rounding: f32,
    is_force_visible: bool,
    animation_direction: String,
    theme_mode: String,
    font_size: Option<f32>,
    queue_expand_direction: Option<String>,
) {
    let mut state = CURRENT_STATE.lock().await.clone();
    let expand = queue_expand_direction
        .unwrap_or_else(|| "both".to_string());
    let expand = match expand.as_str() {
        "up" | "both" | "down" => expand,
        _ => "both".to_string(),
    };
    let style = OverlayStyle {
        scale,
        font,
        color,
        text_color,
        bg_color,
        bg_opacity,
        rounding,
        animation_direction,
        font_size: font_size.unwrap_or(0.0),
        queue_expand_direction: expand,
    };
    let shared_color = style.color.clone();
    let shared_text_color = style.text_color.clone();
    let shared_bg_color = style.bg_color.clone();
    let shared_bg_opacity = style.bg_opacity;

    if target == "lyrics" {
        state.lyrics_style = style;
        state.info_style.color = shared_color;
        state.info_style.text_color = shared_text_color;
        state.info_style.bg_color = shared_bg_color;
        state.info_style.bg_opacity = shared_bg_opacity;
    } else if target == "queue" {
        // 대기열 오버레이는 독립 스타일(곡 정보/가사와 색상 공유하지 않음)
        state.queue_style = style;
    } else {
        // 곡 정보 오버레이는 font_size를 쓰지 않으므로, 가사 쪽 글씨 크기는 유지.
        let preserved_font_size = state.lyrics_style.font_size;
        state.info_style = style;
        state.lyrics_style.color = shared_color;
        state.lyrics_style.text_color = shared_text_color;
        state.lyrics_style.bg_color = shared_bg_color;
        state.lyrics_style.bg_opacity = shared_bg_opacity;
        state.lyrics_style.font_size = preserved_font_size;
    }
    state.is_force_visible = is_force_visible;
    state.theme_mode = if theme_mode.is_empty() { "dark".to_string() } else { theme_mode };
    broadcast_overlay_state(state).await;
}


#[tauri::command]
pub async fn update_overlay_lyrics(current: String, next: String, index: i32) {
    let mut state = CURRENT_STATE.lock().await.clone();
    state.current_lyric = current;
    state.next_lyric = next;
    state.lyric_index = index;
    broadcast_overlay_state(state).await;
}

/// Replaces the full lyric-line list when a track's lyrics (re)load — used
/// by the `/lyrics-view` page to render the whole song and highlight
/// `lyric_index`. Line text is untrusted (LRC/alignment output); it's stored
/// and broadcast as plain strings only, never interpreted as markup.
#[tauri::command]
pub async fn update_overlay_lyrics_full(lines: Vec<String>) {
    let mut state = CURRENT_STATE.lock().await.clone();
    state.lyrics_lines = lines;
    state.lyric_index = -1;
    broadcast_overlay_state(state).await;
}
 
 
 
 
 
 
 
 
 
 
 
 
#[tauri::command]
pub async fn get_overlay_state() -> OverlayState {
    CURRENT_STATE.lock().await.clone()
}

/// Best-effort LAN-facing IP for this PC, used by Settings to show the
/// address other devices on the same network could use to reach the overlay
/// (only meaningful when the LAN toggle is on — see `start_overlay_server`).
/// Connecting a UDP socket doesn't send any packets; it just asks the OS
/// which local interface/IP would be used to route to that target.
#[tauri::command]
pub fn get_lan_addresses() -> Vec<String> {
    use std::net::UdpSocket;

    let mut addrs = Vec::new();
    if let Ok(socket) = UdpSocket::bind("0.0.0.0:0") {
        if socket.connect("8.8.8.8:80").is_ok() {
            if let Ok(local_addr) = socket.local_addr() {
                addrs.push(local_addr.ip().to_string());
            }
        }
    }
    addrs
}
