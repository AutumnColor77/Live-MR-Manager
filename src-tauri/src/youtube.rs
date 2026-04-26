use serde::{Serialize, Deserialize};
use std::sync::Arc;
use serde_json::Value;
use tauri::{Emitter, WebviewWindow};
use std::path::{PathBuf, Path};
#[cfg(target_os = "windows")]
use std::io::Cursor;
use tokio::process::Command;
use tokio::io::AsyncWriteExt;
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
    fn managed_bin_name() -> &'static str {
        #[cfg(target_os = "windows")]
        {
            "yt-dlp.exe"
        }
        #[cfg(target_os = "macos")]
        {
            "yt-dlp_macos"
        }
        #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
        {
            "yt-dlp"
        }
    }

    fn managed_cache_dir() -> PathBuf {
        #[cfg(target_os = "windows")]
        {
            if let Ok(base) = std::env::var("LOCALAPPDATA").or_else(|_| std::env::var("APPDATA")) {
                return Path::new(&base).join("LiveMRManager").join("tools");
            }
        }
        #[cfg(not(target_os = "windows"))]
        {
            if let Ok(home) = std::env::var("HOME") {
                return Path::new(&home).join(".cache").join("live-mr-manager").join("tools");
            }
        }
        std::env::temp_dir().join("live-mr-manager-tools")
    }

    fn managed_candidates() -> Vec<PathBuf> {
        let mut candidates = Vec::new();
        let file_name = Self::managed_bin_name();
        candidates.push(Self::managed_cache_dir().join(file_name));
        if let Ok(exe) = std::env::current_exe() {
            if let Some(exe_dir) = exe.parent() {
                candidates.push(exe_dir.join("resources").join("tools").join(file_name));
                candidates.push(exe_dir.join("tools").join(file_name));
            }
        }
        candidates
    }

    fn ffmpeg_candidate_names() -> &'static [&'static str] {
        #[cfg(target_os = "windows")]
        {
            &["ffmpeg.exe"]
        }
        #[cfg(not(target_os = "windows"))]
        {
            &["ffmpeg"]
        }
    }

    fn managed_ffmpeg_path() -> PathBuf {
        let name = if cfg!(target_os = "windows") { "ffmpeg.exe" } else { "ffmpeg" };
        Self::managed_cache_dir().join(name)
    }

    async fn ensure_managed_ffmpeg() -> Option<PathBuf> {
        let target = Self::managed_ffmpeg_path();
        if target.exists() {
            return Some(target);
        }
        if let Some(parent) = target.parent() {
            let _ = std::fs::create_dir_all(parent);
        }

        #[cfg(target_os = "windows")]
        {
            let zip_url = "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip";
            let response = reqwest::get(zip_url).await.ok()?;
            if !response.status().is_success() {
                return None;
            }
            let bytes = response.bytes().await.ok()?;
            let cursor = Cursor::new(bytes);
            let mut archive = zip::ZipArchive::new(cursor).ok()?;

            for i in 0..archive.len() {
                let mut entry = match archive.by_index(i) {
                    Ok(v) => v,
                    Err(_) => continue,
                };
                if !entry.is_file() {
                    continue;
                }
                let name = entry.name().replace('\\', "/").to_lowercase();
                if name.ends_with("/ffmpeg.exe") {
                    let mut content = Vec::new();
                    if std::io::Read::read_to_end(&mut entry, &mut content).is_err() {
                        continue;
                    }
                    if std::fs::write(&target, &content).is_err() {
                        continue;
                    }
                    if target.exists() {
                        return Some(target);
                    }
                }
            }
            None
        }
        #[cfg(target_os = "macos")]
        {
            let bin_url = "https://evermeet.cx/ffmpeg/getrelease/ffmpeg";
            let response = reqwest::get(bin_url).await.ok()?;
            if !response.status().is_success() {
                return None;
            }
            let bytes = response.bytes().await.ok()?;
            let mut out = tokio::fs::File::create(&target).await.ok()?;
            if out.write_all(&bytes).await.is_err() {
                return None;
            }
            let _ = out.flush().await;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                if let Ok(meta) = std::fs::metadata(&target) {
                    let mut perms = meta.permissions();
                    perms.set_mode(0o755);
                    let _ = std::fs::set_permissions(&target, perms);
                }
            }
            if target.exists() {
                Some(target)
            } else {
                None
            }
        }
        #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
        {
            None
        }
    }

    fn find_managed_ffmpeg_dir() -> Option<PathBuf> {
        for dir in [Self::managed_cache_dir(), std::env::current_exe().ok()?.parent()?.join("resources").join("tools")] {
            for name in Self::ffmpeg_candidate_names() {
                let p = dir.join(name);
                if p.exists() {
                    return Some(dir);
                }
            }
        }
        None
    }

    fn find_system_ffmpeg() -> Option<PathBuf> {
        #[cfg(windows)]
        {
            let output = {
                use std::os::windows::process::CommandExt;
                std::process::Command::new("where.exe")
                    .arg("ffmpeg")
                    .creation_flags(0x08000000)
                    .output()
                    .ok()?
            };
            if output.status.success() {
                let p = String::from_utf8_lossy(&output.stdout).trim().to_string();
                if !p.is_empty() {
                    return Some(PathBuf::from(p.lines().next().unwrap_or(&p)));
                }
            }
            None
        }
        #[cfg(not(windows))]
        {
            let output = std::process::Command::new("which").arg("ffmpeg").output().ok()?;
            if output.status.success() {
                let p = String::from_utf8_lossy(&output.stdout).trim().to_string();
                if !p.is_empty() {
                    return Some(PathBuf::from(p.lines().next().unwrap_or(&p)));
                }
            }
            #[cfg(target_os = "macos")]
            {
                for p in ["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg"] {
                    let path = PathBuf::from(p);
                    if path.exists() {
                        return Some(path);
                    }
                }
            }
            None
        }
    }

    async fn resolve_ffmpeg_location() -> Option<PathBuf> {
        if let Some(p) = Self::ensure_managed_ffmpeg().await {
            return p.parent().map(|d| d.to_path_buf());
        }
        if let Some(dir) = Self::find_managed_ffmpeg_dir() {
            return Some(dir);
        }
        Self::find_system_ffmpeg().and_then(|p| p.parent().map(|d| d.to_path_buf()))
    }

    async fn ensure_managed_yt_dlp() -> Option<PathBuf> {
        for p in Self::managed_candidates() {
            if p.exists() {
                return Some(p);
            }
        }

        let url = {
            #[cfg(target_os = "windows")]
            {
                "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe"
            }
            #[cfg(target_os = "macos")]
            {
                "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos"
            }
            #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
            {
                "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp"
            }
        };

        let target = Self::managed_cache_dir().join(Self::managed_bin_name());
        if let Some(parent) = target.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let response = reqwest::get(url).await.ok()?;
        if !response.status().is_success() {
            return None;
        }
        let bytes = response.bytes().await.ok()?;
        let mut file = tokio::fs::File::create(&target).await.ok()?;
        if file.write_all(&bytes).await.is_err() {
            return None;
        }
        let _ = file.flush().await;

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if let Ok(meta) = std::fs::metadata(&target) {
                let mut perms = meta.permissions();
                perms.set_mode(0o755);
                let _ = std::fs::set_permissions(&target, perms);
            }
        }

        if target.exists() {
            Some(target)
        } else {
            None
        }
    }

    /// Finds the best yt-dlp executable by checking managed and system paths.
    async fn find_yt_dlp() -> String {
        // 1. Use managed binary first for stability.
        if let Some(p) = Self::ensure_managed_yt_dlp().await {
            return p.to_string_lossy().to_string();
        }

        // 2. Try to see if it's already in the system PATH.
        #[cfg(windows)]
        let output = {
            use std::os::windows::process::CommandExt;
            std::process::Command::new("where.exe")
                .arg("yt-dlp")
                .creation_flags(0x08000000)
                .output()
        };
        #[cfg(not(windows))]
        let output = std::process::Command::new("which").arg("yt-dlp").output();

        if let Ok(output) = output {
            if output.status.success() {
                let p = String::from_utf8_lossy(&output.stdout).trim().to_string();
                if !p.is_empty() {
                    let first_path = p.lines().next().unwrap_or(&p).to_string();
                    println!("Found yt-dlp in PATH: {}", first_path);
                    return first_path;
                }
            }
        }

        // 3. Check common Python Script paths as backup
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

        #[cfg(target_os = "macos")]
        {
            for p in ["/opt/homebrew/bin/yt-dlp", "/usr/local/bin/yt-dlp"] {
                let path = Path::new(p);
                if path.exists() {
                    return path.to_string_lossy().to_string();
                }
            }
        }

        "yt-dlp".to_string()
    }

    pub async fn get_video_metadata(url: &str) -> Result<YoutubeMetadata, String> {
        let exe = Self::find_yt_dlp().await;
        let _ = crate::audio_player::sys_log(&format!("[Youtube] Using yt-dlp at: {} for metadata from: {}", exe, url));
        
        let mut cmd = Command::new(&exe);
        #[cfg(windows)]
        {
            cmd.creation_flags(0x08000000);
        }
        let output = cmd
            .args(&["-j", "--no-playlist", "--no-warnings", "--no-check-certificates", url])
            .output()
            .await
            .map_err(|e| {
                let err_msg = format!("Failed to start yt-dlp ({}): {}", exe, e);
                let _ = crate::audio_player::sys_log(&err_msg);
                err_msg
            })?;

        if !output.status.success() {
            let err = String::from_utf8_lossy(&output.stderr);
            let err_msg = format!("yt-dlp execution failed: {}", err);
            let _ = crate::audio_player::sys_log(&err_msg);
            return Err(err_msg);
        }

        let raw_stdout = String::from_utf8_lossy(&output.stdout);
        let json_content = if let Some(start_idx) = raw_stdout.find('{') {
            &raw_stdout[start_idx..]
        } else {
            &raw_stdout
        };

        if json_content.trim().is_empty() {
            let _ = crate::audio_player::sys_log("[Youtube] yt-dlp returned empty output");
            return Err("yt-dlp returned empty output".into());
        }

        let v: Value = serde_json::from_str(json_content)
            .map_err(|e| {
                let err_msg = format!("Failed to parse yt-dlp JSON: {}", e);
                let _ = crate::audio_player::sys_log(&format!("{} | Raw output: {}", err_msg, raw_stdout));
                err_msg
            })?;

        let metadata = YoutubeMetadata {
            id: v.get("id").and_then(|x| x.as_str()).map(|s| s.to_string()),
            title: v.get("title").and_then(|x| x.as_str())
                .or_else(|| v.get("fulltitle").and_then(|x| x.as_str()))
                .map(|s| s.to_string()),
            uploader: v.get("uploader").and_then(|x| x.as_str())
                .or_else(|| v.get("channel").and_then(|x| x.as_str()))
                .map(|s| s.to_string()),
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

        let _ = crate::audio_player::sys_log(&format!("[Youtube] Successfully fetched metadata: {:?}", metadata.title));
        Ok(metadata)
    }

    pub async fn download_audio(
        window: &WebviewWindow,
        url: &str,
        destination: PathBuf,
        wait_for_full: bool,
    ) -> Result<PathBuf, String> {
        let exe = Self::find_yt_dlp().await;
        let ffmpeg_location = Self::resolve_ffmpeg_location().await;
        if let Some(ffmpeg_dir) = &ffmpeg_location {
            let _ = crate::audio_player::sys_log(&format!(
                "[Youtube] Using ffmpeg location: {}",
                ffmpeg_dir.to_string_lossy()
            ));
        } else {
            let _ = crate::audio_player::sys_log("[Youtube] ffmpeg not found in managed/system locations");
        }
        
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
            let mut cmd = Command::new(&exe);
            #[cfg(windows)]
            {
                cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
            }
            let mut args: Vec<String> = vec![
                "--newline".into(),
                "--progress-template".into(),
                "%(progress)j".into(),
                "--no-check-certificates".into(),
                "--no-part".into(),
                "--no-warnings".into(),
                "--buffer-size".into(),
                "16K".into(),
            ];

            if wait_for_full {
                // High quality post-processing for separation
                args.extend_from_slice(&[
                    "-f".into(),
                    "ba".into(),
                    "-x".into(),
                    "--audio-format".into(),
                    "m4a".into(),
                ]);
            } else {
                // Streaming friendly: no post-processing
                args.extend_from_slice(&["-f".into(), "ba[ext=m4a]/ba".into()]);
            }

            args.extend_from_slice(&[
                "-o".into(),
                destination.to_str().ok_or("Invalid path")?.to_string(),
                url.to_string(),
            ]);
            if let Some(ffmpeg_dir) = &ffmpeg_location {
                args.extend_from_slice(&[
                    "--ffmpeg-location".into(),
                    ffmpeg_dir.to_string_lossy().to_string(),
                ]);
            }

            let mut child = cmd
                .args(&args)
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
