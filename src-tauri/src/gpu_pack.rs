//! gpu_pack — 선택 설치형 GPU 가속 팩 (TensorRT + cuDNN/cuBLAS DLL).
//!
//! 배경: RoFormer(RawWaveform) 분리는 CPU에서 곡당 8~30분이 걸린다. DirectML은
//! 이 모델에서 GPU를 행에 빠뜨리고(887A0006), CUDA EP는 노드 5천여 개짜리
//! 미융합 그래프라 커널 실행 오버헤드에 묶여 CPU보다도 느리다. TensorRT가
//! 그래프를 융합하면 **청크당 14.1초 → 0.83초(약 17배)** 로 떨어진다(실측).
//!
//! 다만 TensorRT+cuDNN DLL은 합쳐서 ~2GB라 설치본에 넣을 수 없다. 그래서 AI
//! 모델(1.2GB)을 GitHub 릴리즈에서 받아 쓰는 기존 방식 그대로, 원하는 사용자만
//! 내려받아 `%LOCALAPPDATA%\LiveMRManager\tools\gpu\`에 두는 구조로 한다.
//! 팩이 없으면 기존 경로(CPU/DirectML)로 그대로 동작한다.

use std::path::{Path, PathBuf};

use crate::ffmpeg_tools::tools_cache_dir;

/// GPU 가속 팩 DLL이 놓이는 디렉터리.
pub fn gpu_pack_dir() -> PathBuf {
    tools_cache_dir().join("gpu")
}

/// TensorRT 엔진 캐시 위치. 엔진은 GPU 아키텍처별로 다르고 빌드에 수 분이
/// 걸리므로 재사용해야 한다(캐시 적중 시 세션 로드 150초 → 12초).
pub fn trt_engine_cache_dir() -> PathBuf {
    tools_cache_dir().join("trt_cache")
}

/// 팩 설치 여부 — TensorRT 코어와 cuDNN이 모두 있어야 의미가 있다.
/// (cuDNN이 없으면 onnxruntime_providers_cuda.dll 로딩이 Error 126으로 실패하고
///  ort가 이를 삼켜 조용히 CPU로 떨어진다 — 실제로 겪은 함정.)
pub fn is_installed() -> bool {
    let dir = gpu_pack_dir();
    required_dlls().iter().all(|f| dir.join(f).exists())
}

/// 팩이 갖춰야 하는 최소 DLL 목록.
pub fn required_dlls() -> &'static [&'static str] {
    &[
        "nvinfer_10.dll",
        "nvinfer_plugin_10.dll",
        "nvonnxparser_10.dll",
        "nvinfer_builder_resource_10.dll",
        "cudnn64_9.dll",
        "cublas64_12.dll",
        "cublasLt64_12.dll",
    ]
}

/// 설치돼 있지만 빠진 DLL 목록(진단용).
pub fn missing_dlls() -> Vec<String> {
    let dir = gpu_pack_dir();
    required_dlls()
        .iter()
        .filter(|f| !dir.join(f).exists())
        .map(|f| f.to_string())
        .collect()
}

#[cfg(windows)]
mod win {
    use std::ffi::c_void;
    extern "system" {
        pub fn LoadLibraryExW(name: *const u16, file: *mut c_void, flags: u32) -> *mut c_void;
        pub fn SetDllDirectoryW(path: *const u16) -> i32;
    }
    /// DLL의 의존성을 그 DLL이 있는 폴더에서도 찾게 한다.
    pub const LOAD_WITH_ALTERED_SEARCH_PATH: u32 = 0x0000_0008;

    pub fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }
}

/// GPU 팩 DLL을 이 프로세스에 미리 적재해 ORT가 찾을 수 있게 한다.
///
/// **PATH에 넣는 방식은 통하지 않는다** — ORT는 provider DLL을 LoadLibraryEx의
/// 제한된 검색 플래그로 열기 때문에 PATH가 검색 대상에서 빠지고, 결국
/// `Error 126: cudnn64_9.dll missing`으로 로딩이 실패한다(그리고 ort가 그 실패를
/// 삼켜 조용히 CPU로 떨어진다). 그래서 여기서는 의존 DLL을 **절대경로로 직접
/// 적재**한다. 한 번 로드된 모듈은 같은 이름으로 다시 요청될 때 Windows가
/// 재사용하므로, 이후 ORT의 provider DLL이 의존성을 정상 해결한다.
///
/// **ORT를 처음 쓰기 전에** 호출해야 한다.
pub fn register_dll_search_path() {
    let dir = gpu_pack_dir();
    if !dir.exists() {
        return;
    }

    #[cfg(windows)]
    {
        // 보조 수단: 일반 검색 경로에도 추가.
        let dir_w = win::wide(&dir.to_string_lossy());
        unsafe { win::SetDllDirectoryW(dir_w.as_ptr()) };

        // 의존성이 있는 것부터(cublas/cudnn → nvinfer) 절대경로로 적재.
        let mut loaded = 0usize;
        for name in required_dlls() {
            let path = dir.join(name);
            if !path.exists() {
                continue;
            }
            let path_w = win::wide(&path.to_string_lossy());
            let h = unsafe {
                win::LoadLibraryExW(path_w.as_ptr(), std::ptr::null_mut(), win::LOAD_WITH_ALTERED_SEARCH_PATH)
            };
            if h.is_null() {
                crate::audio_player::sys_log(&format!("[GPU-Pack] 적재 실패: {}", name));
            } else {
                loaded += 1;
            }
        }
        crate::audio_player::sys_log(&format!(
            "[GPU-Pack] DLL {}개 적재됨 ({})",
            loaded,
            dir.display()
        ));
    }
}

/// 팩 상태 요약 (설정 화면 표시용).
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GpuPackStatus {
    pub installed: bool,
    pub dir: String,
    pub missing: Vec<String>,
}

#[tauri::command]
pub fn get_gpu_pack_status() -> GpuPackStatus {
    GpuPackStatus {
        installed: is_installed(),
        dir: gpu_pack_dir().to_string_lossy().to_string(),
        missing: missing_dlls(),
    }
}

/// 팩 디렉터리를 파일 탐색기로 연다 (수동 설치 안내용).
#[tauri::command]
pub fn open_gpu_pack_dir() -> Result<(), String> {
    let dir = gpu_pack_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    open_dir(&dir)
}

fn open_dir(dir: &Path) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        std::process::Command::new("explorer")
            .arg(dir)
            .creation_flags(0x08000000)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(not(target_os = "windows"))]
    {
        std::process::Command::new("xdg-open").arg(dir).spawn().map_err(|e| e.to_string())?;
    }
    Ok(())
}
