use serde::{Serialize, Deserialize};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering as AtomicOrdering};
use serde_json::Value;
use tauri::{Emitter, WebviewWindow};
use std::path::{PathBuf, Path};
use std::collections::HashMap;
use std::time::{Duration, Instant};
use tokio::process::Command;
use tokio::io::AsyncWriteExt;
use tokio_util::codec::{FramedRead, LinesCodec};
use futures::StreamExt;
use std::process::Stdio;
use once_cell::sync::Lazy;
use parking_lot::RwLock;
use crate::youtube_url::youtube_cache_bytes_ready;

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

#[derive(Debug, Deserialize, Serialize, Default, Clone)]
pub struct YoutubeMetadata {
    pub id: Option<String>,
    pub title: Option<String>,
    pub uploader: Option<String>,
    pub duration: Option<f64>,
    pub thumbnail: Option<String>,
}

pub struct YoutubeManager;

static METADATA_CACHE: Lazy<RwLock<HashMap<String, (YoutubeMetadata, Instant)>>> =
    Lazy::new(|| RwLock::new(HashMap::new()));
const METADATA_CACHE_TTL: Duration = Duration::from_secs(60 * 30);
const METADATA_TIMEOUT: Duration = Duration::from_secs(12);
const SEARCH_TIMEOUT: Duration = Duration::from_secs(45);
const YT_DLP_MAX_AGE: Duration = Duration::from_secs(7 * 24 * 60 * 60);
const STREAM_HEADER_WAIT: Duration = Duration::from_secs(60);
static YT_DLP_FORCE_REFRESH_USED: AtomicBool = AtomicBool::new(false);

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct YoutubeSearchResult {
    pub id: String,
    pub title: String,
    pub uploader: Option<String>,
    pub duration: Option<f64>,
    pub duration_label: Option<String>,
    pub thumbnail: Option<String>,
    pub url: String,
}

impl YoutubeManager {
    fn extract_video_id(url: &str) -> Option<String> {
        let trimmed = url.trim();
        if let Some(idx) = trimmed.find("youtu.be/") {
            let tail = &trimmed[idx + "youtu.be/".len()..];
            let id = tail.split(&['?', '&', '/', '#'][..]).next().unwrap_or("").trim();
            if !id.is_empty() {
                return Some(id.to_string());
            }
        }
        if let Some(idx) = trimmed.find("watch?v=") {
            let tail = &trimmed[idx + "watch?v=".len()..];
            let id = tail.split(&['&', '/', '#', '?'][..]).next().unwrap_or("").trim();
            if !id.is_empty() {
                return Some(id.to_string());
            }
        }
        if let Some(idx) = trimmed.find("/shorts/") {
            let tail = &trimmed[idx + "/shorts/".len()..];
            let id = tail.split(&['?', '&', '/', '#'][..]).next().unwrap_or("").trim();
            if !id.is_empty() {
                return Some(id.to_string());
            }
        }
        None
    }

    fn metadata_cache_key(url: &str) -> String {
        if let Some(id) = Self::extract_video_id(url) {
            return format!("yt:{}", id);
        }
        url.trim().to_string()
    }

    fn read_metadata_cache(key: &str) -> Option<YoutubeMetadata> {
        let mut cache = METADATA_CACHE.write();
        if let Some((meta, ts)) = cache.get(key) {
            if ts.elapsed() <= METADATA_CACHE_TTL {
                return Some(meta.clone());
            }
            cache.remove(key);
        }
        None
    }

    fn write_metadata_cache(key: &str, metadata: &YoutubeMetadata) {
        let mut cache = METADATA_CACHE.write();
        cache.insert(key.to_string(), (metadata.clone(), Instant::now()));
    }

    async fn fetch_oembed_metadata(url: &str, video_id: Option<&str>) -> Option<YoutubeMetadata> {
        let oembed_url = format!(
            "https://www.youtube.com/oembed?format=json&url={}",
            urlencoding::encode(url)
        );
        let response = reqwest::get(&oembed_url).await.ok()?;
        if !response.status().is_success() {
            return None;
        }
        let payload = response.json::<Value>().await.ok()?;
        let title = payload.get("title").and_then(|v| v.as_str()).map(|s| s.to_string());
        let uploader = payload
            .get("author_name")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        let thumbnail = payload
            .get("thumbnail_url")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .or_else(|| {
                video_id.map(|id| format!("https://i.ytimg.com/vi/{}/hqdefault.jpg", id))
            });

        Some(YoutubeMetadata {
            id: video_id.map(|s| s.to_string()),
            title,
            uploader,
            duration: None,
            thumbnail,
        })
    }

    fn managed_bin_name() -> &'static str {
        "yt-dlp.exe"
    }

    fn managed_cache_dir() -> PathBuf {
        crate::ffmpeg_tools::tools_cache_dir()
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

    async fn resolve_ffmpeg_location() -> Option<PathBuf> {
        crate::ffmpeg_tools::resolve_ffmpeg_dir().await
    }

    fn managed_bin_is_fresh(path: &Path) -> bool {
        let Ok(meta) = std::fs::metadata(path) else {
            return false;
        };
        let Ok(modified) = meta.modified() else {
            return false;
        };
        modified
            .elapsed()
            .map(|age| age <= YT_DLP_MAX_AGE)
            .unwrap_or(false)
    }

    async fn download_managed_yt_dlp(target: &Path) -> Option<PathBuf> {
        // Windows PyInstaller build: combined work under GPLv3+ (yt-dlp source is Unlicense).
        // Downloaded at runtime into tools cache — not shipped inside the app installer.
        // See THIRD_PARTY_NOTICES.md.
        let url = "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe";
        if let Some(parent) = target.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let tmp = target.with_extension("exe.partial");
        let response = reqwest::get(url).await.ok()?;
        if !response.status().is_success() {
            return None;
        }
        let bytes = response.bytes().await.ok()?;
        let mut file = tokio::fs::File::create(&tmp).await.ok()?;
        if file.write_all(&bytes).await.is_err() {
            let _ = tokio::fs::remove_file(&tmp).await;
            return None;
        }
        let _ = file.flush().await;
        drop(file);
        if std::fs::rename(&tmp, target).is_err() {
            let _ = std::fs::copy(&tmp, target);
            let _ = std::fs::remove_file(&tmp);
        }
        if target.exists() {
            Some(target.to_path_buf())
        } else {
            None
        }
    }

    async fn ensure_managed_yt_dlp(force: bool) -> Option<PathBuf> {
        let target = Self::managed_cache_dir().join(Self::managed_bin_name());
        if target.is_file() && !force && Self::managed_bin_is_fresh(&target) {
            return Some(target);
        }

        if force || !target.is_file() || !Self::managed_bin_is_fresh(&target) {
            let _ = crate::audio_player::sys_log(&format!(
                "[Youtube] Refreshing managed yt-dlp (force={}, exists={})",
                force,
                target.is_file()
            ));
            if let Some(p) = Self::download_managed_yt_dlp(&target).await {
                return Some(p);
            }
            if target.is_file() {
                return Some(target);
            }
        }

        for p in Self::managed_candidates() {
            if p != target && p.exists() {
                return Some(p);
            }
        }
        None
    }

    async fn refresh_managed_yt_dlp_once() -> bool {
        if YT_DLP_FORCE_REFRESH_USED.swap(true, AtomicOrdering::SeqCst) {
            return false;
        }
        Self::ensure_managed_yt_dlp(true).await.is_some()
    }

    fn is_extractor_failure(msg: &str) -> bool {
        let e = msg.to_lowercase();
        e.contains("requested format is not available")
            || e.contains("nsig")
            || e.contains("sign in to confirm")
            || e.contains("only images are available")
            || e.contains("http error 403")
            || e.contains("sabr")
            || e.contains("this video is not available")
    }

    pub fn user_facing_error(raw: &str) -> String {
        if raw.starts_with("유튜브") {
            return raw.to_string();
        }
        let lower = raw.to_lowercase();
        if lower.contains("timeout")
            || raw.contains("시간이 초과")
            || raw.contains("생성되지 않았습니다")
            || raw.contains("완전히 다운로드하지 못했습니다")
        {
            return "유튜브 오디오를 준비하는 데 시간이 초과되었습니다. 네트워크를 확인하고 다시 시도해 주세요.".into();
        }
        if lower.contains("failed to spawn")
            || lower.contains("failed to start yt-dlp")
            || raw.contains("yt-dlp 설치")
        {
            return "유튜브 도구(yt-dlp)를 실행할 수 없습니다.".into();
        }
        if Self::is_extractor_failure(raw) {
            return "유튜브가 오디오를 막았습니다. 네트워크를 바꾸거나 나중에 다시 시도해 주세요.".into();
        }
        if lower.contains("decode") || raw.contains("디코딩") {
            return "유튜브 오디오 파일을 재생할 수 없습니다. 다시 시도해 주세요.".into();
        }
        "유튜브 재생에 실패했습니다.".into()
    }

    fn youtube_player_client_arg(fallback: bool) -> &'static str {
        // Default `web` formats often 403 (SABR / nsig). TV+Android still expose HTTPS audio.
        if fallback {
            "youtube:player_client=ios,mweb,web"
        } else {
            "youtube:player_client=tv,android,web_safari"
        }
    }

    fn find_node_runtime() -> Option<String> {
        use std::os::windows::process::CommandExt;
        let output = std::process::Command::new("where.exe")
            .arg("node.exe")
            .creation_flags(0x08000000)
            .output()
            .ok()?;
        if !output.status.success() {
            return None;
        }
        let p = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let first = p.lines().next().unwrap_or("").trim();
        if first.is_empty() {
            None
        } else {
            Some(first.to_string())
        }
    }

    fn push_youtube_compat_args(args: &mut Vec<String>, fallback_clients: bool) {
        args.extend_from_slice(&[
            "--extractor-args".into(),
            Self::youtube_player_client_arg(fallback_clients).into(),
            "--retries".into(),
            "5".into(),
            "--fragment-retries".into(),
            "5".into(),
            "--no-playlist".into(),
        ]);
        if let Some(node) = Self::find_node_runtime() {
            args.extend_from_slice(&["--js-runtimes".into(), format!("node:{}", node)]);
        }
    }

    fn release_download_slot(destination: &Path, error: Option<String>) {
        let mut active = crate::audio_player::ACTIVE_DOWNLOADS.lock();
        active.remove(destination);
        let mut errors = crate::audio_player::DOWNLOAD_ERRORS.lock();
        errors.remove(destination);
        if let Some(reason) = error {
            errors.insert(destination.to_path_buf(), reason);
        }
        let mut notifiers = crate::audio_player::DOWNLOAD_FINISHED_NOTIFIER.lock();
        if let Some(n) = notifiers.remove(destination) {
            n.notify_waiters();
        }
    }

    /// Finds the best yt-dlp executable by checking managed and system paths.
    async fn find_yt_dlp() -> String {
        Self::find_yt_dlp_inner(false).await
    }

    async fn find_yt_dlp_inner(force: bool) -> String {
        // 1. Use managed binary first for stability.
        if let Some(p) = Self::ensure_managed_yt_dlp(force).await {
            return p.to_string_lossy().to_string();
        }

        // 2. Try to see if it's already in the system PATH.
        use std::os::windows::process::CommandExt;
        let output = std::process::Command::new("where.exe")
            .arg("yt-dlp")
            .creation_flags(0x08000000)
            .output();

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

        "yt-dlp".to_string()
    }

    pub async fn get_video_metadata(url: &str) -> Result<YoutubeMetadata, String> {
        let cache_key = Self::metadata_cache_key(url);
        if let Some(cached) = Self::read_metadata_cache(&cache_key) {
            let _ = crate::audio_player::sys_log("[Youtube] Metadata cache hit");
            return Ok(cached);
        }

        let exe = Self::find_yt_dlp().await;
        let _ = crate::audio_player::sys_log(&format!("[Youtube] Using yt-dlp at: {} for metadata from: {}", exe, url));
        
        let mut cmd = Command::new(&exe);
        cmd.creation_flags(0x08000000);
        let output = tokio::time::timeout(
            METADATA_TIMEOUT,
            cmd.args(&[
                "-j",
                "--no-playlist",
                "--skip-download",
                "--no-warnings",
                "--no-check-certificates",
                "--socket-timeout",
                "8",
                "--extractor-retries",
                "1",
                "--extractor-args",
                "youtube:player_client=tv,android,web_safari",
                url,
            ])
            .output(),
        )
        .await
        .map_err(|_| {
            format!(
                "yt-dlp metadata timeout after {}s",
                METADATA_TIMEOUT.as_secs()
            )
        })
        .and_then(|res| {
            res.map_err(|e| {
                let err_msg = format!("Failed to start yt-dlp ({}): {}", exe, e);
                let _ = crate::audio_player::sys_log(&err_msg);
                err_msg
            })
        });

        let output = match output {
            Ok(v) => v,
            Err(err_msg) => {
                let _ = crate::audio_player::sys_log(&format!("[Youtube] {}", err_msg));
                if (Self::is_extractor_failure(&err_msg)
                    || err_msg.contains("Failed to start")
                    || err_msg.contains("timeout"))
                    && Self::refresh_managed_yt_dlp_once().await
                {
                    return Box::pin(Self::get_video_metadata(url)).await;
                }
                if let Some(fallback) =
                    Self::fetch_oembed_metadata(url, Self::extract_video_id(url).as_deref()).await
                {
                    let _ = crate::audio_player::sys_log(
                        "[Youtube] Fallback metadata from oEmbed after yt-dlp failure",
                    );
                    Self::write_metadata_cache(&cache_key, &fallback);
                    return Ok(fallback);
                }
                return Err(err_msg);
            }
        };

        if !output.status.success() {
            let err = String::from_utf8_lossy(&output.stderr);
            let err_msg = format!("yt-dlp execution failed: {}", err);
            let _ = crate::audio_player::sys_log(&err_msg);
            if Self::is_extractor_failure(&err_msg) && Self::refresh_managed_yt_dlp_once().await {
                return Box::pin(Self::get_video_metadata(url)).await;
            }
            if let Some(fallback) =
                Self::fetch_oembed_metadata(url, Self::extract_video_id(url).as_deref()).await
            {
                let _ = crate::audio_player::sys_log(
                    "[Youtube] Fallback metadata from oEmbed after yt-dlp stderr failure",
                );
                Self::write_metadata_cache(&cache_key, &fallback);
                return Ok(fallback);
            }
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

        let metadata = Self::metadata_from_json(&v);

        let _ = crate::audio_player::sys_log(&format!("[Youtube] Successfully fetched metadata: {:?}", metadata.title));
        Self::write_metadata_cache(&cache_key, &metadata);
        Ok(metadata)
    }

    fn metadata_from_json(v: &Value) -> YoutubeMetadata {
        let id = v.get("id").and_then(|x| x.as_str()).map(|s| s.to_string());
        let thumbnail = v
            .get("thumbnail")
            .and_then(|x| x.as_str())
            .or_else(|| {
                v.get("thumbnails")
                    .and_then(|x| x.as_array())
                    .and_then(|urls| urls.last())
                    .and_then(|t| t.get("url"))
                    .and_then(|u| u.as_str())
            })
            .map(|s| s.to_string())
            .or_else(|| {
                id.as_ref()
                    .map(|vid| format!("https://i.ytimg.com/vi/{}/hqdefault.jpg", vid))
            });

        YoutubeMetadata {
            id,
            title: v
                .get("title")
                .and_then(|x| x.as_str())
                .or_else(|| v.get("fulltitle").and_then(|x| x.as_str()))
                .map(|s| s.to_string()),
            uploader: v
                .get("uploader")
                .and_then(|x| x.as_str())
                .or_else(|| v.get("channel").and_then(|x| x.as_str()))
                .map(|s| s.to_string()),
            duration: v.get("duration").and_then(|x| {
                x.as_f64()
                    .or_else(|| x.as_i64().map(|n| n as f64))
                    .or_else(|| x.as_u64().map(|n| n as f64))
            }),
            thumbnail,
        }
    }

    fn format_duration_label(secs: f64) -> String {
        if !secs.is_finite() || secs < 0.0 {
            return String::new();
        }
        let total = secs.round() as u64;
        let h = total / 3600;
        let m = (total % 3600) / 60;
        let s = total % 60;
        if h > 0 {
            format!("{}:{:02}:{:02}", h, m, s)
        } else {
            format!("{}:{:02}", m, s)
        }
    }

    /// Keyword search via yt-dlp `ytsearchN:` (no YouTube Data API key).
    pub async fn search_videos(query: &str, limit: usize) -> Result<Vec<YoutubeSearchResult>, String> {
        let q = query.trim();
        if q.is_empty() {
            return Err("검색어를 입력하세요.".into());
        }
        let limit = limit.clamp(1, 20);
        let search_arg = format!("ytsearch{}:{}", limit, q);
        let exe = Self::find_yt_dlp().await;
        let _ = crate::audio_player::sys_log(&format!(
            "[Youtube] Searching via {}: {}",
            exe, search_arg
        ));

        let mut cmd = Command::new(&exe);
        cmd.creation_flags(0x08000000);
        let output = tokio::time::timeout(
            SEARCH_TIMEOUT,
            cmd.args(&[
                "-j",
                "--flat-playlist",
                "--skip-download",
                "--no-warnings",
                "--no-check-certificates",
                "--socket-timeout",
                "10",
                "--extractor-retries",
                "1",
                &search_arg,
            ])
            .output(),
        )
        .await
        .map_err(|_| {
            format!(
                "유튜브 검색 시간이 초과되었습니다 ({}초).",
                SEARCH_TIMEOUT.as_secs()
            )
        })?
        .map_err(|e| {
            let err_msg = format!("yt-dlp 실행 실패 ({}): {}", exe, e);
            let _ = crate::audio_player::sys_log(&err_msg);
            "유튜브 검색을 시작할 수 없습니다. yt-dlp 설치 상태를 확인하세요.".to_string()
        })?;

        if !output.status.success() {
            let err = String::from_utf8_lossy(&output.stderr);
            let _ = crate::audio_player::sys_log(&format!(
                "[Youtube] search failed: {}",
                err
            ));
            return Err("유튜브 검색에 실패했습니다.".into());
        }

        let raw_stdout = String::from_utf8_lossy(&output.stdout);
        let mut results = Vec::new();
        for line in raw_stdout.lines() {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            let json_content = if let Some(start_idx) = trimmed.find('{') {
                &trimmed[start_idx..]
            } else {
                continue;
            };
            let v: Value = match serde_json::from_str(json_content) {
                Ok(v) => v,
                Err(e) => {
                    let _ = crate::audio_player::sys_log(&format!(
                        "[Youtube] search JSON skip: {}",
                        e
                    ));
                    continue;
                }
            };
            let meta = Self::metadata_from_json(&v);
            let id = match meta.id.filter(|s| !s.is_empty()) {
                Some(id) => id,
                None => continue,
            };
            let title = meta
                .title
                .filter(|s| !s.trim().is_empty())
                .unwrap_or_else(|| "제목 없음".into());
            let duration_label = meta
                .duration
                .map(Self::format_duration_label)
                .filter(|s| !s.is_empty());
            results.push(YoutubeSearchResult {
                url: format!("https://youtu.be/{}", id),
                id,
                title,
                uploader: meta.uploader,
                duration: meta.duration,
                duration_label,
                thumbnail: meta.thumbnail,
            });
            if results.len() >= limit {
                break;
            }
        }

        let _ = crate::audio_player::sys_log(&format!(
            "[Youtube] Search returned {} result(s) for {:?}",
            results.len(),
            q
        ));
        Ok(results)
    }

    fn destination_ready(path: &Path) -> bool {
        std::fs::metadata(path)
            .map(|m| youtube_cache_bytes_ready(m.len()))
            .unwrap_or(false)
    }

    pub async fn download_audio(
        window: &WebviewWindow,
        url: &str,
        destination: PathBuf,
        wait_for_full: bool,
    ) -> Result<PathBuf, String> {
        match Self::download_audio_once(window, url, destination.clone(), wait_for_full, false).await {
            Ok(path) => Ok(path),
            Err(err) => {
                let _ = crate::audio_player::sys_log(&format!("[Youtube] download failed: {}", err));
                let extractor = Self::is_extractor_failure(&err);
                if extractor && Self::refresh_managed_yt_dlp_once().await {
                    let _ = std::fs::remove_file(&destination);
                    match Self::download_audio_once(window, url, destination.clone(), wait_for_full, false)
                        .await
                    {
                        Ok(path) => return Ok(path),
                        Err(err2) => {
                            let _ = crate::audio_player::sys_log(&format!(
                                "[Youtube] download retry after yt-dlp refresh failed: {}",
                                err2
                            ));
                        }
                    }
                }
                if extractor {
                    let _ = crate::audio_player::sys_log(
                        "[Youtube] Retrying download with fallback player clients",
                    );
                    let _ = std::fs::remove_file(&destination);
                    match Self::download_audio_once(window, url, destination, wait_for_full, true)
                        .await
                    {
                        Ok(path) => return Ok(path),
                        Err(err2) => {
                            let _ = crate::audio_player::sys_log(&format!(
                                "[Youtube] fallback-client download failed: {}",
                                err2
                            ));
                            return Err(Self::user_facing_error(&err2));
                        }
                    }
                }
                Err(Self::user_facing_error(&err))
            }
        }
    }

    async fn download_audio_once(
        window: &WebviewWindow,
        url: &str,
        destination: PathBuf,
        wait_for_full: bool,
        fallback_clients: bool,
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
                if Self::destination_ready(&destination) {
                    return Ok(destination);
                }
                if let Some(reason) = crate::audio_player::DOWNLOAD_ERRORS.lock().remove(&destination) {
                    return Err(reason);
                }
                return Err("Download failed in other thread".into());
            } else {
                // Streaming: wait for header below
            }
        } else {
            // This is the primary download thread
            println!("Starting new yt-dlp download: {}", url);
            let mut cmd = Command::new(&exe);
            cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
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
            Self::push_youtube_compat_args(&mut args, fallback_clients);

            if wait_for_full {
                // High quality post-processing for separation
                args.extend_from_slice(&[
                    "-f".into(),
                    "ba".into(),
                    "-x".into(),
                    "--audio-format".into(),
                    "m4a".into(),
                ]);
            } else if fallback_clients {
                args.extend_from_slice(&["-f".into(), "bestaudio/best".into()]);
            } else {
                // Streaming friendly: no post-processing
                args.extend_from_slice(&["-f".into(), "ba[ext=m4a]/ba".into()]);
            }

            args.extend_from_slice(&[
                "-o".into(),
                {
                    match destination.to_str() {
                        Some(s) => s.to_string(),
                        None => {
                            Self::release_download_slot(&destination, Some("Invalid path".into()));
                            return Err("Invalid path".into());
                        }
                    }
                },
                url.to_string(),
            ]);
            if let Some(ffmpeg_dir) = &ffmpeg_location {
                args.extend_from_slice(&[
                    "--ffmpeg-location".into(),
                    ffmpeg_dir.to_string_lossy().to_string(),
                ]);
            }

            let mut child = match cmd
                .args(&args)
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
            {
                Ok(child) => child,
                Err(e) => {
                    let err_msg = format!("Failed to spawn yt-dlp: {}", e);
                    Self::release_download_slot(&destination, Some(err_msg.clone()));
                    return Err(err_msg);
                }
            };

            let stdout = child.stdout.take().unwrap();
            let stderr = child.stderr.take();
            let mut reader = FramedRead::new(stdout, LinesCodec::new());
            let window_clone = window.clone();
            let dest_clone = destination.clone();
            let url_clone = url.to_string();
            let wait_for_full_clone = wait_for_full;

            tokio::spawn(async move {
                let stderr_task = stderr.map(|err| {
                    tokio::spawn(async move {
                        let mut tail: Vec<String> = Vec::new();
                        let mut err_reader = FramedRead::new(err, LinesCodec::new());
                        while let Some(line_result) = err_reader.next().await {
                            if let Ok(line) = line_result {
                                let line = line.trim();
                                if !line.is_empty() {
                                    tail.push(line.to_string());
                                    if tail.len() > 8 {
                                        tail.remove(0);
                                    }
                                }
                            }
                        }
                        tail
                    })
                });

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
                let stderr_tail = if let Some(task) = stderr_task {
                    task.await.unwrap_or_default()
                } else {
                    Vec::new()
                };

                let error = if matches!(status, Ok(s) if s.success()) {
                    None
                } else if stderr_tail.is_empty() {
                    Some("yt-dlp exited without stderr output".to_string())
                } else {
                    Some(stderr_tail.join(" | "))
                };
                Self::release_download_slot(&dest_clone, error);

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
            
            if Self::destination_ready(&destination) {
                crate::audio_player::DOWNLOAD_ERRORS.lock().remove(&destination);
                return Ok(destination);
            }
            if let Some(reason) = crate::audio_player::DOWNLOAD_ERRORS.lock().remove(&destination) {
                let _ = std::fs::remove_file(&destination);
                return Err(reason);
            }
            let _ = std::fs::remove_file(&destination);
            return Err("YouTube 오디오 파일을 완전히 다운로드하지 못했습니다".into());
        } else {
            let start_wait = std::time::Instant::now();
            let mut file_ready = false;

            while start_wait.elapsed() < STREAM_HEADER_WAIT {
                if Self::destination_ready(&destination) {
                    file_ready = true;
                    break;
                }
                {
                    let errors = crate::audio_player::DOWNLOAD_ERRORS.lock();
                    if errors.contains_key(&destination) {
                        break;
                    }
                }
                {
                    let active = crate::audio_player::ACTIVE_DOWNLOADS.lock();
                    if !active.contains(&destination) {
                        break;
                    }
                }
                tokio::time::sleep(tokio::time::Duration::from_millis(200)).await;
            }

            if file_ready || Self::destination_ready(&destination) {
                crate::audio_player::DOWNLOAD_ERRORS.lock().remove(&destination);
                return Ok(destination);
            }
            if let Some(reason) = crate::audio_player::DOWNLOAD_ERRORS.lock().remove(&destination) {
                let _ = std::fs::remove_file(&destination);
                return Err(reason);
            }
            let _ = std::fs::remove_file(&destination);
            return Err("YouTube 오디오 파일이 생성되지 않았습니다 (Timeout)".into());
        }
    }
}
