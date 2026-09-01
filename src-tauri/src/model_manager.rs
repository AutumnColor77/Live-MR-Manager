use std::path::{Path, PathBuf};
use std::fs;
use tauri::{AppHandle, Emitter, Manager};
use tauri::path::BaseDirectory;
use futures::StreamExt;
use std::io::Write;
use sha2::{Digest, Sha256};

use crate::vocal_remover::ModelParams;

#[derive(Debug, Clone)]
pub struct ModelSpec {
    pub id: String,
    pub name: String,
    pub url: String,
    pub sha256: Option<String>,
    /// Explicit architecture params for custom models. `None` for built-in
    /// models, which are detected from their filename by the engine.
    pub params: Option<ModelParams>,
}

#[derive(Debug, Clone)]
pub struct ModelResolution {
    pub spec: ModelSpec,
    pub path: PathBuf,
    pub source: String,
}

#[allow(dead_code)]
pub struct ModelManager {
    model_dir: PathBuf,
}

#[allow(dead_code)]
impl ModelManager {
    pub fn spec_from_id(model_id: &str) -> Result<ModelSpec, String> {
        if let Some((id, name, url, sha256)) = crate::state::MODELS.iter().find(|(id, _, _, _)| *id == model_id) {
            return Ok(ModelSpec {
                id: id.to_string(),
                name: name.to_string(),
                url: url.to_string(),
                sha256: Some(sha256.to_string()),
                params: None,
            });
        }

        // Fall back to user-registered custom models.
        if let Some(custom) = crate::custom_models::get(model_id) {
            let preset = crate::custom_models::preset_by_key(&custom.preset_key)
                .ok_or_else(|| format!("Unknown architecture preset: {}", custom.preset_key))?;
            return Ok(ModelSpec {
                id: custom.id,
                name: custom.filename,
                url: custom.url,
                sha256: None,
                params: Some(preset.to_params()),
            });
        }

        Err(format!("Unknown model ID: {}", model_id))
    }

    pub fn fallback_spec(primary_id: &str) -> Option<ModelSpec> {
        crate::state::MODELS.iter()
            .find(|(id, _, _, _)| *id != primary_id)
            .map(|(id, name, url, sha256)| ModelSpec {
                id: id.to_string(),
                name: name.to_string(),
                url: url.to_string(),
                sha256: Some(sha256.to_string()),
                params: None,
            })
    }

    fn min_expected_size_bytes(model_name: &str) -> u64 {
        match model_name {
            // based on observed production artifacts in this app
            "Kim_Vocal_2.onnx" => 55 * 1024 * 1024,
            "UVR-MDX-NET-Inst_HQ_3.onnx" => 55 * 1024 * 1024,
            _ => 10 * 1024 * 1024,
        }
    }

    fn expected_sha256_for(model_name: &str) -> Option<&'static str> {
        crate::state::MODELS
            .iter()
            .find(|(_, name, _, _)| *name == model_name)
            .map(|(_, _, _, sha)| *sha)
    }

    fn hash_marker_path(model_path: &Path) -> PathBuf {
        model_path.with_extension("onnx.sha256")
    }

    fn file_sha256_hex(path: &Path) -> Result<String, String> {
        let bytes = fs::read(path).map_err(|e| e.to_string())?;
        Ok(format!("{:x}", Sha256::digest(&bytes)))
    }

    fn hash_marker_matches(path: &Path, expected: &str) -> bool {
        fs::read_to_string(Self::hash_marker_path(path))
            .map(|h| h.trim().eq_ignore_ascii_case(expected))
            .unwrap_or(false)
    }

    fn write_hash_marker(path: &Path, expected: &str) {
        let _ = fs::write(Self::hash_marker_path(path), expected);
    }

    fn looks_valid_model_file_for(path: &PathBuf, model_name: &str, expected_sha: Option<&str>) -> bool {
        let min_size_bytes = Self::min_expected_size_bytes(model_name);
        if !path
            .metadata()
            .map(|m| m.len() >= min_size_bytes)
            .unwrap_or(false)
        {
            return false;
        }
        let Some(expected) = expected_sha.or_else(|| Self::expected_sha256_for(model_name)) else {
            return true;
        };
        if Self::hash_marker_matches(path, expected) {
            return true;
        }
        match Self::file_sha256_hex(path) {
            Ok(actual) if actual.eq_ignore_ascii_case(expected) => {
                Self::write_hash_marker(path, expected);
                true
            }
            _ => false,
        }
    }

    pub fn new(handle: &AppHandle) -> Self {
        let paths = handle.state::<crate::state::AppPaths>();
        let model_dir = paths.models.clone();
        Self { model_dir }
    }

    pub fn get_model_path(&self, model_name: &str) -> PathBuf {
        self.model_dir.join(model_name)
    }

    pub fn resolve_model_path(&self, handle: &AppHandle, spec: &ModelSpec) -> Option<ModelResolution> {
        if let Ok(resource_path) = handle.path().resolve(format!("resources/{}", spec.name), BaseDirectory::Resource) {
            if resource_path.exists() {
                return Some(ModelResolution {
                    spec: spec.clone(),
                    path: resource_path,
                    source: "bundled".to_string(),
                });
            }
        }

        let appdata_path = self.get_model_path(&spec.name);
        if appdata_path.exists()
            && Self::looks_valid_model_file_for(&appdata_path, &spec.name, spec.sha256.as_deref())
        {
            return Some(ModelResolution {
                spec: spec.clone(),
                path: appdata_path,
                source: "appdata".to_string(),
            });
        }

        None
    }

    pub async fn ensure_model_by_id(&self, handle: &AppHandle, model_id: &str) -> Result<ModelResolution, String> {
        let spec = Self::spec_from_id(model_id)?;
        if let Some(resolved) = self.resolve_model_path(handle, &spec) {
            return Ok(resolved);
        }

        let path = self.ensure_model(handle, &spec.name, &spec.url).await?;
        Ok(ModelResolution {
            spec,
            path,
            source: "downloaded".to_string(),
        })
    }

    pub async fn ensure_model(&self, handle: &AppHandle, model_name: &str, url: &str) -> Result<PathBuf, String> {
        // 1. Check Bundled Resources (for packaged app)
        // Note: resources are mapped to "resources/*" in tauri.conf.json
        if let Ok(resource_path) = handle.path().resolve(format!("resources/{}", model_name), BaseDirectory::Resource) {
            if resource_path.exists() {
                println!("DEBUG: [ModelManager] Found bundled model at {:?}", resource_path);
                return Ok(resource_path);
            }
        }

        // 2. Check AppData (fallback or downloaded)
        let path = self.get_model_path(model_name);
        if path.exists() && Self::looks_valid_model_file_for(&path, model_name, Self::expected_sha256_for(model_name)) {
            println!("DEBUG: [ModelManager] Found existing model in AppData: {:?}", path);
            return Ok(path);
        } else if path.exists() {
            let _ = crate::audio_player::sys_log(&format!(
                "[ModelManager] Existing model looks invalid/partial. Re-downloading: {:?}",
                path
            ));
            let _ = fs::remove_file(&path);
        }

        println!("DEBUG: [ModelManager] Downloading model: {} from {}", model_name, url);

        if !url.is_empty() {
            crate::ipc_validate::validate_public_https_url(url)?;
        }

        let client = reqwest::Client::builder()
            .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
            .build()
            .map_err(|e| format!("Failed to create HTTP client: {}", e))?;

        let response = client.get(url).send().await
            .map_err(|e| {
                let err_msg = format!("Failed to send request: {}", e);
                let _ = crate::audio_player::sys_log(&format!("[ModelManager] [Error] {}", err_msg));
                err_msg
            })?;
        
        if !response.status().is_success() {
            let err_msg = format!("Failed to download model: HTTP {}", response.status());
            let _ = crate::audio_player::sys_log(&format!("[ModelManager] [Error] {}", err_msg));
            return Err(err_msg);
        }

        let total_size = response.content_length().unwrap_or(0);
        let tmp = path.with_extension("onnx.partial");
        let _ = fs::remove_file(&tmp);
        let mut file = fs::File::create(&tmp).map_err(|e| {
            let err_msg = format!("Failed to create model file: {}", e);
            let _ = crate::audio_player::sys_log(&format!("[ModelManager] [Error] {}", err_msg));
            err_msg
        })?;
        let mut stream = response.bytes_stream();
        let mut downloaded: u64 = 0;
        let mut hasher = Sha256::new();

        while let Some(item) = stream.next().await {
            let chunk = item.map_err(|e| e.to_string())?;
            hasher.update(&chunk);
            file.write_all(&chunk).map_err(|e| e.to_string())?;
            downloaded += chunk.len() as u64;

            if total_size > 0 {
                let percentage = (downloaded as f32 / total_size as f32) * 100.0;
                let _ = handle.emit("model-download-progress", percentage);
            }
        }
        drop(file);

        if let Some(expected) = Self::expected_sha256_for(model_name) {
            let actual = format!("{:x}", hasher.finalize());
            if !actual.eq_ignore_ascii_case(expected) {
                let _ = fs::remove_file(&tmp);
                return Err(format!(
                    "모델 무결성 검증 실패 (expected {expected}, got {actual})"
                ));
            }
        }

        if fs::rename(&tmp, &path).is_err() {
            fs::copy(&tmp, &path).map_err(|e| e.to_string())?;
            let _ = fs::remove_file(&tmp);
        }
        if let Some(expected) = Self::expected_sha256_for(model_name) {
            Self::write_hash_marker(&path, expected);
        }

        Ok(path)
    }
}
