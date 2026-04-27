//! Intel mac: Microsoft ONNX Runtime prebuilt tgz (osx-x64) for `load-dynamic` `ort` builds.
//! Homebrew is often unavailable on older macOS; this downloads into app data when needed.

use std::path::{Path, PathBuf};

use flate2::read::GzDecoder;
use once_cell::sync::Lazy;
use tauri::AppHandle;
use tokio::sync::Mutex;

use crate::audio_player::sys_log;
use crate::state::AppPaths;
use crate::vocal_remover::find_intel_mac_ort_dylib;

static ORT_BOOTSTRAP_LOCK: Lazy<Mutex<()>> = Lazy::new(|| Mutex::new(()));

// Intel macOS 12: try universal2 package first to reduce architecture-specific loader issues.
const ORT_GITHUB_VERSION: &str = "1.20.0";
const ORT_TGZ_BASENAME: &str = "onnxruntime-osx-universal2-1.20.0.tgz";
const ORT_TGZ_INNER_DIR: &str = "onnxruntime-osx-universal2-1.20.0";

/// Before loading ONNX models, ensure `libonnxruntime.dylib` is present for Intel + load-dynamic.
pub async fn ensure_intel_mac_managed_ort(app: &AppHandle) -> Result<(), String> {
    #[cfg(not(all(target_os = "macos", target_arch = "x86_64")))]
    {
        return Ok(());
    }
    #[cfg(all(target_os = "macos", target_arch = "x86_64"))]
    {
        if find_intel_mac_ort_dylib().is_some() {
            return Ok(());
        }
        if let Some(p) = cached_managed_dylib(app) {
            if p.exists() {
                let staged = stage_ort_dylib_to_no_space_path(&p)?;
                std::env::set_var("ORT_DYLIB_PATH", staged.to_str().ok_or("ORT path is not valid UTF-8")?);
                sys_log(&format!(
                    "[ORT-BOOT] Using managed bundle: {} (staged: {})",
                    p.display(),
                    staged.display()
                ));
                return Ok(());
            }
        }

        let _lock = ORT_BOOTSTRAP_LOCK.lock().await;
        if find_intel_mac_ort_dylib().is_some() {
            return Ok(());
        }
        if let Some(p) = cached_managed_dylib(app) {
            if p.exists() {
                let staged = stage_ort_dylib_to_no_space_path(&p)?;
                std::env::set_var("ORT_DYLIB_PATH", staged.to_str().ok_or("ORT path is not valid UTF-8")?);
                sys_log(&format!(
                    "[ORT-BOOT] Using managed bundle: {} (staged: {})",
                    p.display(),
                    staged.display()
                ));
                return Ok(());
            }
        }

        download_and_install_impl(app).await
    }
}

fn cached_managed_dylib(app: &AppHandle) -> Option<PathBuf> {
    let paths = AppPaths::from_handle(app);
    let root = paths.root.join("tools").join("onnxruntime").join(ORT_GITHUB_VERSION);
    let lib = root.join("lib");
    if !lib.is_dir() {
        return None;
    }
    first_ort_dylib_in_lib(&lib)
}

fn first_ort_dylib_in_lib(lib: &Path) -> Option<PathBuf> {
    let entries = std::fs::read_dir(lib).ok()?;
    for entry in entries.flatten() {
        let p = entry.path();
        let name = p.file_name()?.to_string_lossy().to_string();
        if name.starts_with("libonnxruntime") && name.ends_with(".dylib") && p.is_file() {
            return Some(p);
        }
    }
    None
}

#[cfg(all(target_os = "macos", target_arch = "x86_64"))]
fn stage_ort_dylib_to_no_space_path(src: &Path) -> Result<PathBuf, String> {
    let src_name = src
        .file_name()
        .ok_or_else(|| "ORT dylib 파일명이 비어 있습니다.".to_string())?;
    let staging_dir = std::env::temp_dir()
        .join("live_mr_manager_ort")
        .join(ORT_GITHUB_VERSION);
    std::fs::create_dir_all(&staging_dir)
        .map_err(|e| format!("ORT staging 경로 생성 실패 {:?}: {e}", staging_dir))?;
    let dst = staging_dir.join(src_name);
    if !dst.exists() {
        std::fs::copy(src, &dst)
            .map_err(|e| format!("ORT dylib staging 복사 실패 {:?} -> {:?}: {e}", src, dst))?;
    }
    Ok(dst)
}

#[cfg(all(target_os = "macos", target_arch = "x86_64"))]
async fn download_and_install_impl(app: &AppHandle) -> Result<(), String> {
    let url = format!(
        "https://github.com/microsoft/onnxruntime/releases/download/v{ORT_GITHUB_VERSION}/{ORT_TGZ_BASENAME}"
    );
    sys_log(&format!("[ORT-BOOT] No system ORT; downloading {} …", ORT_TGZ_BASENAME));

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(900))
        .connect_timeout(std::time::Duration::from_secs(60))
        .build()
        .map_err(|e| format!("ORT bootstrap HTTP client: {e}"))?;

    let response = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("ONNX Runtime 다운로드 실패(네트워크). {e}"))?;

    if !response.status().is_success() {
        return Err(format!(
            "ONNX Runtime 릴리스 fetch 실패: HTTP {} — {}",
            response.status().as_u16(),
            url
        ));
    }

    let bytes = response
        .bytes()
        .await
        .map_err(|e| format!("ONNX Runtime 본문 읽기 실패. {e}"))?;

    let paths = AppPaths::from_handle(app);
    let base = paths.root.join("tools").join("onnxruntime");
    std::fs::create_dir_all(&base)
        .map_err(|e| format!("캐시 경로 생성 실패 {:?}: {e}", base))?;

    let tmp_name = format!(".extract-{}", std::process::id());
    let tmp_dir = base.join(&tmp_name);
    let _ = std::fs::remove_dir_all(&tmp_dir);
    std::fs::create_dir_all(&tmp_dir)
        .map_err(|e| format!("임시 ORT 풀기 경로 실패: {e}"))?;

    {
        let decoder = GzDecoder::new(&bytes[..]);
        let mut archive = tar::Archive::new(decoder);
        archive
            .unpack(&tmp_dir)
            .map_err(|e| format!("onnxruntime 압축 풀기 실패(손상 또는 디스크). {e}"))?;
    }

    let src_root = tmp_dir.join(ORT_TGZ_INNER_DIR);
    if !src_root.is_dir() {
        return Err(format!(
            "다운로드한 패키지에 예상 폴더가 없습니다: {:?}",
            src_root
        ));
    }

    let dest_root = base.join(ORT_GITHUB_VERSION);
    let _ = std::fs::remove_dir_all(&dest_root);
    std::fs::rename(&src_root, &dest_root)
        .map_err(|e| format!("ONNX Runtime 설치 이동 실패: {e}"))?;
    let _ = std::fs::remove_dir_all(&tmp_dir);

    let lib_dir = dest_root.join("lib");
    let Some(dy) = first_ort_dylib_in_lib(&lib_dir) else {
        return Err("설치된 lib 폴더에 libonnxruntime*.dylib이 없습니다.".into());
    };

    let staged = stage_ort_dylib_to_no_space_path(&dy)?;
    std::env::set_var(
        "ORT_DYLIB_PATH",
        staged
            .to_str()
            .ok_or_else(|| "ORT_DYLIB_PATH: UTF-8 path".to_string())?,
    );
    sys_log(&format!(
        "[ORT-BOOT] Installed and set ORT_DYLIB_PATH to {} (from {})",
        staged.display(),
        dy.display()
    ));
    Ok(())
}
