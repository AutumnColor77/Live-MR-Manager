use serde::{Serialize, Deserialize};
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
    ) -> Result<PathBuf, String> {
        let exe = Self::find_yt_dlp();
        println!("Using yt-dlp at: {} for download to: {}", exe, destination.display());

        let mut child = Command::new(&exe)
            .args(&[
                "--newline",
                "--progress-template",
                "%(progress)j",
                "--no-check-certificates",
                "--no-part", // Use real extension immediately for streaming
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

        // Spawn a background task to monitor progress and wait for completion
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

            let status = child.wait().await;
            match status {
                Ok(s) if s.success() => {
                    println!("yt-dlp download finished successfully: {:?}", dest_clone);
                    let _ = window_clone.emit("youtube-download-finished", dest_clone.to_string_lossy());
                },
                Ok(s) => println!("yt-dlp download failed with status: {}", s),
                Err(e) => println!("yt-dlp wait error: {}", e),
            }
        });

        // Wait for the file to exist and have at least some bytes (for audio headers)
        let start_wait = std::time::Instant::now();
        let mut file_ready = false;
        
        while start_wait.elapsed().as_secs() < 10 {
            if destination.exists() {
                if let Ok(meta) = std::fs::metadata(&destination) {
                    if meta.len() > 8192 { // Wait for 8KB (typical header size)
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
