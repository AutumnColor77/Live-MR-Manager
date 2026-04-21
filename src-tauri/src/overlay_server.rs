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

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct OverlayState {
    pub title: String,
    pub artist: String,
    pub thumbnail: String,
    pub is_playing: bool,
    pub scale: f32,
    pub font: String,
    pub color: String,
    pub bg_color: String,
    pub bg_opacity: f32,
    pub rounding: f32,
    pub is_force_visible: bool,
}

impl Default for OverlayState {
    fn default() -> Self {
        Self {
            title: "Ready to Play".to_string(),
            artist: "Waiting for music...".to_string(),
            thumbnail: "".to_string(),
            is_playing: false,
            scale: 1.0,
            font: "Inter".to_string(),
            color: "3b82f6".to_string(),
            bg_color: "0f0f14".to_string(),
            bg_opacity: 0.6,
            rounding: 20.0,
            is_force_visible: false,
        }
    }
}

type PeerMap = Arc<Mutex<HashMap<SocketAddr, mpsc::UnboundedSender<Message>>>>;

static PEERS: Lazy<PeerMap> = Lazy::new(|| Arc::new(Mutex::new(HashMap::new())));
static CURRENT_STATE: Lazy<Mutex<OverlayState>> = Lazy::new(|| Mutex::new(OverlayState::default()));

pub async fn start_overlay_server() {
    let addr = "127.0.0.1:14201".to_string();
    let listener = TcpListener::bind(&addr).await.expect("Failed to bind WebSocket server");
    println!("[Overlay] WebSocket server listening on: {}", addr);

    tokio::spawn(async move {
        while let Ok((stream, addr)) = listener.accept().await {
            tokio::spawn(handle_connection(PEERS.clone(), stream, addr));
        }
    });
}

async fn handle_connection(peers: PeerMap, raw_stream: TcpStream, addr: SocketAddr) {
    println!("[Overlay] New connection: {}", addr);

    let ws_stream = tokio_tungstenite::accept_async(raw_stream)
        .await
        .expect("Error during the websocket handshake occurred");

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

pub async fn broadcast_overlay_state(state: OverlayState) {
    *CURRENT_STATE.lock().await = state.clone();
    let msg = serde_json::to_string(&state).unwrap();
    
    let peers = PEERS.lock().await;
    for tx in peers.values() {
        let _ = tx.send(Message::Text(msg.clone()));
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
pub async fn update_overlay_style(scale: f32, font: String, color: String, bg_color: String, bg_opacity: f32, rounding: f32, is_force_visible: bool) {
    let mut state = CURRENT_STATE.lock().await.clone();
    state.scale = scale;
    state.font = font;
    state.color = color;
    state.bg_color = bg_color;
    state.bg_opacity = bg_opacity;
    state.rounding = rounding;
    state.is_force_visible = is_force_visible;
    broadcast_overlay_state(state).await;
}
