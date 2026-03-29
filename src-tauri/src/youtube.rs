use serde::{Serialize, Deserialize};
use serde_json::Value;
use tauri::{Emitter, Window};
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

#[derive(Debug, Deserialize, Serialize, Default)]
pub struct YoutubeMetadata {
    pub id: Option<String>,
    pub title: Option<String>,
    pub duration: Option<f64>,
    pub thumbnail: Option<String>,
}

pub struct YoutubeManager;

impl YoutubeManager {
    /// Finds the best yt-dlp executable by checking common Python script paths first.
    fn find_yt_dlp() -> String {
        // 1. Check User-specific Python Scripts (often where pip updates land)
        if let Ok(appdata) = std::env::var("APPDATA") {
            let user_path = Path::new(&appdata).join("Python").join("Python313").join("Scripts").join("yt-dlp.exe");
            if user_path.exists() {
                println!("Found user-specific yt-dlp: {:?}", user_path);
                return user_path.to_string_lossy().to_string();
            }
        }

        // 2. Check System-wide Python Scripts
        let system_path = Path::new("C:\\Python313\\Scripts\\yt-dlp.exe");
        if system_path.exists() {
            println!("Found system-wide yt-dlp: {:?}", system_path);
            return system_path.to_string_lossy().to_string();
        }

        // 3. Fallback to just "yt-dlp" in PATH
        println!("Falling back to 'yt-dlp' from PATH");
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

        let v: Value = serde_json::from_slice(&output.stdout)
            .map_err(|e| {
                let raw_stdout = String::from_utf8_lossy(&output.stdout);
                println!("Failed to parse JSON. Raw output: {}", raw_stdout);
                format!("Failed to parse JSON: {}", e)
            })?;

        let metadata = YoutubeMetadata {
            id: v.get("id").and_then(|x| x.as_str()).map(|s| s.to_string()),
            title: v.get("title").and_then(|x| x.as_str()).map(|s| s.to_string()),
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
        window: &Window,
        url: &str,
        destination: PathBuf,
    ) -> Result<PathBuf, String> {
        let exe = Self::find_yt_dlp();
        println!("Using yt-dlp at: {} for download to: {}", exe, destination.display());

        let mut child = Command::new(&exe)
            .args(&[
                "--newline",
                "--progress-template",
                "%(progress)j",
                "--no-check-certificates",
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
                                } else {
                                    0.0
                                };

                                let _ = window_clone.emit("youtube-download-progress", DownloadProgress {
                                    percentage,
                                    current_chunk: downloaded as usize,
                                    total_size: total,
                                });
                            }
                        }
                    }
                }
                Err(e) => println!("Error reading yt-dlp output: {}", e),
            }
        }

        let status = child.wait().await.map_err(|e| format!("yt-dlp wait error: {}", e))?;
        if !status.success() {
            return Err("yt-dlp download failed".to_string());
        }

        Ok(destination)
    }
}
