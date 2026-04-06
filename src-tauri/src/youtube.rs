use serde::{Serialize, Deserialize};
use std::sync::Arc;
use serde_json::Value;
use tauri::{Emitter, WebviewWindow};
use std::path::{PathBuf, Path};
use tokio::process::Command;
use tokio_util::codec::{FramedRead, LinesCodec};
use futures::StreamExt;
use std::process::Stdio;

#[derive(Debug, Clone, Serialize)]
pub struct DownloadProgress {
    pub percentage: f32,
    pub current_chunk: usize,
    pub total_size: Option<u64>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct SeparationProgress {
    pub path: String,
    pub percentage: f32,
    pub status: String,
    pub provider: String,
}

#[derive(Debug, Deserialize, Serialize, Default)]
pub struct YoutubeMetadata {
    pub id: Option<String>,
    pub title: Option<String>,
    pub uploader: Option<String>,
    pub duration: Option<f64>,
    pub thumbnail: Option<String>,
}

pub struct YoutubeManager;

impl YoutubeManager {
    /// Finds the best yt-dlp executable by checking common Python script paths first.
    fn find_yt_dlp() -> String {
        // 1. Try to see if it's already in the system PATH (highest priority for user-installed ones)
        let check_path = if cfg!(windows) {
            std::process::Command::new("where.exe").arg("yt-dlp").output()
        } else {
            std::process::Command::new("which").arg("yt-dlp").output()
        };

        if let Ok(output) = check_path {
            if output.status.success() {
                let p = String::from_utf8_lossy(&output.stdout).trim().to_string();
                if !p.is_empty() {
                    let first_path = p.lines().next().unwrap_or(&p).to_string();
                    println!("Found yt-dlp in PATH: {}", first_path);
                    return first_path;
                }
            }
        }

        // 2. Check common Python Script paths as backup
        let appdata_paths = vec![
            std::env::var("APPDATA").ok(),
            std::env::var("LOCALAPPDATA").ok(),
        ];

        for base in appdata_paths.into_iter().flatten() {
            // Check major Python versions (3.10 to 3.13)
            for ver in &["Python313", "Python312", "Python311", "Python310"] {
                let p = Path::new(&base).join("Python").join(ver).join("Scripts").join("yt-dlp.exe");
                if p.exists() {
                    println!("Found Python-specific yt-dlp: {:?}", p);
                    return p.to_string_lossy().to_string();
                }
            }
            
            // Check direct Scripts folder in LocalAppData (some pip installs end up here)
            let direct_p = Path::new(&base).join("Programs").join("Python").join("Python313").join("Scripts").join("yt-dlp.exe");
            if direct_p.exists() {
                return direct_p.to_string_lossy().to_string();
            }
        }

        "yt-dlp".to_string()
    }

    pub async fn get_video_metadata(url: &str) -> Result<YoutubeMetadata, String> {
        let exe = Self::find_yt_dlp();
        println!("Using yt-dlp at: {} for metadata from: {}", exe, url);
        
        let output = Command::new(&exe)
            .args(&["-j", "--no-playlist", "--no-check-certificates", url])
            .output()
            .await
            .map_err(|e| {
                println!("Failed to start yt-dlp ({}): {}", exe, e);
                format!("Failed to execute yt-dlp: {}", e)
            })?;

        if !output.status.success() {
            let err = String::from_utf8_lossy(&output.stderr);
            println!("yt-dlp stderr: {}", err);
            return Err(format!("yt-dlp error: {}", err));
        }

        let raw_stdout = String::from_utf8_lossy(&output.stdout);
        let json_content = if let Some(start_idx) = raw_stdout.find('{') {
            &raw_stdout[start_idx..]
        } else {
            &raw_stdout
        };

        let v: Value = serde_json::from_str(json_content)
            .map_err(|e| {
                println!("Failed to parse JSON. Raw output: {}", raw_stdout);
                format!("Failed to parse JSON: {}", e)
            })?;

        let metadata = YoutubeMetadata {
            id: v.get("id").and_then(|x| x.as_str()).map(|s| s.to_string()),
            title: v.get("title").and_then(|x| x.as_str()).map(|s| s.to_string()),
            uploader: v.get("uploader").and_then(|x| x.as_str()).map(|s| s.to_string()),
            duration: v.get("duration").and_then(|x| x.as_f64()),
            thumbnail: v.get("thumbnail").and_then(|x| x.as_str())
                .or_else(|| {
                    v.get("thumbnails")
                        .and_then(|x| x.as_array())
                        .and_then(|urls| urls.last())
                        .and_then(|t| t.get("url"))
                        .and_then(|u| u.as_str())
                })
                .map(|s| s.to_string()),
        };

        Ok(metadata)
    }

    pub async fn download_audio(
        window: &WebviewWindow,
        url: &str,
        destination: PathBuf,
        wait_for_full: bool,
    ) -> Result<PathBuf, String> {
        let exe = Self::find_yt_dlp();
        
        // 1. Check if already downloading (Synchronization)
        let notifier = {
            let mut active = crate::audio_player::ACTIVE_DOWNLOADS.lock();
            if active.contains(&destination) {
                // Return notifier to wait on existing process
                let mut notifiers = crate::audio_player::DOWNLOAD_FINISHED_NOTIFIER.lock();
                Some(notifiers.entry(destination.clone()).or_insert_with(|| Arc::new(tokio::sync::Notify::new())).clone())
            } else {
                active.insert(destination.clone());
                None
            }
        };

        if let Some(n) = notifier {
            println!("Download already in progress for {:?}, waiting...", destination);
            if wait_for_full {
                n.notified().await;
                return if destination.exists() { Ok(destination) } else { Err("Download failed in other thread".into()) };
            } else {
                // If streaming, still check for header
            }
        } else {
            // This is the primary download thread
            println!("Starting new yt-dlp download: {}", url);
            let mut child = Command::new(&exe)
                .args(&[
                    "--newline",
                    "--progress-template",
                    "%(progress)j",
                    "--no-check-certificates",
                    "--no-part", 
                    "--buffer-size", "16K",
                    "-f", "ba",
                    "-x",
                    "--audio-format", "m4a",
                    "-o", destination.to_str().ok_or("Invalid path")?,
                    url
                ])
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
                .map_err(|e| format!("Failed to spawn yt-dlp: {}", e))?;

            let stdout = child.stdout.take().unwrap();
            let mut reader = FramedRead::new(stdout, LinesCodec::new());
            let window_clone = window.clone();
            let dest_clone = destination.clone();
            let url_clone = url.to_string();
            let wait_for_full_clone = wait_for_full;

            tokio::spawn(async move {
                while let Some(line_result) = reader.next().await {
                    match line_result {
                        Ok(line) => {
                            if let Ok(progress) = serde_json::from_str::<Value>(&line) {
                                if let Some(status) = progress.get("status").and_then(|s| s.as_str()) {
                                    if status == "downloading" {
                                        let downloaded = progress.get("downloaded_bytes").and_then(|b| b.as_u64()).unwrap_or(0);
                                        let total = progress.get("total_bytes")
                                            .or_else(|| progress.get("total_bytes_estimate"))
                                            .and_then(|b| b.as_u64());
                                        
                                        let percentage = if let Some(t) = total {
                                            (downloaded as f32 / t as f32) * 100.0
                                        } else { 0.0 };

                                        let _ = window_clone.emit("youtube-download-progress", DownloadProgress {
                                            percentage,
                                            current_chunk: downloaded as usize,
                                            total_size: total,
                                        });

                                        if wait_for_full_clone {
                                            let _ = window_clone.emit("separation-progress", SeparationProgress {
                                                path: url_clone.clone(),
                                                percentage,
                                                status: format!("Downloading... ({:.1}%)", percentage),
                                                provider: "NETWORK".into(),
                                            });
                                        }
                                    }
                                }
                            }
                        }
                        Err(_) => {}
                    }
                }

                let status = child.wait().await;
                
                {
                    let mut active = crate::audio_player::ACTIVE_DOWNLOADS.lock();
                    active.remove(&dest_clone);
                    
                    // Notify all waiters
                    let mut notifiers = crate::audio_player::DOWNLOAD_FINISHED_NOTIFIER.lock();
                    if let Some(n) = notifiers.remove(&dest_clone) {
                        n.notify_waiters();
                    }
                }

                match status {
                    Ok(s) if s.success() => {
                        let _ = window_clone.emit("youtube-download-finished", dest_clone.to_string_lossy());
                    },
                    _ => {}
                }
            });
        }

        // 2. Wait logic (Full or Streaming)
        if wait_for_full {
            // Need to re-acquire notifier if we are the primary but someone else might have joined
            let n = {
                let mut notifiers = crate::audio_player::DOWNLOAD_FINISHED_NOTIFIER.lock();
                notifiers.entry(destination.clone()).or_insert_with(|| Arc::new(tokio::sync::Notify::new())).clone()
            };
            
            // Wait for completion via notification
            let start = std::time::Instant::now();
            while start.elapsed().as_secs() < 300 { // 5 min max for full download
                {
                    let active = crate::audio_player::ACTIVE_DOWNLOADS.lock();
                    if !active.contains(&destination) { break; }
                }
                tokio::select! {
                    _ = n.notified() => break,
                    _ = tokio::time::sleep(tokio::time::Duration::from_millis(500)) => {}
                }
            }
            
            if destination.exists() { return Ok(destination); }
            return Err("YouTube 오디오 파일을 완전히 다운로드하지 못했습니다".into());
        } else {
            // Streaming mode: wait for headers (8KB)
            let start_wait = std::time::Instant::now();
            let mut file_ready = false;
            
            // Increased to 30s as metadata extraction can be slow
            while start_wait.elapsed().as_secs() < 30 {
                {
                    // If the download thread finished (meaning it succeeded or failed completely), stop waiting
                    let active = crate::audio_player::ACTIVE_DOWNLOADS.lock();
                    if !active.contains(&destination) { break; }
                }
                
                if destination.exists() {
                    if let Ok(meta) = std::fs::metadata(&destination) {
                        if meta.len() > 8192 {
                            file_ready = true;
                            break;
                        }
                    }
                }
                tokio::time::sleep(tokio::time::Duration::from_millis(200)).await;
            }

            if !file_ready && !destination.exists() {
                return Err("YouTube 오디오 파일이 생성되지 않았습니다 (Timeout)".into());
            }
            Ok(destination)
        }
    }
}
