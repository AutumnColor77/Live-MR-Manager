use std::path::PathBuf;
use std::fs;
use tauri::{AppHandle, Emitter, Manager};
use tauri::path::BaseDirectory;
use futures::StreamExt;
use std::io::Write;

#[allow(dead_code)]
pub struct ModelManager {
    model_dir: PathBuf,
}

#[allow(dead_code)]
impl ModelManager {
    pub fn new(handle: &AppHandle) -> Self {
        let app_dir = handle.path().app_local_data_dir().expect("Failed to get app data dir");
        let model_dir = app_dir.join("models");
        if !model_dir.exists() {
            fs::create_dir_all(&model_dir).expect("Failed to create model directory");
        }
        Self { model_dir }
    }

    pub fn get_model_path(&self, model_name: &str) -> PathBuf {
        self.model_dir.join(model_name)
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
        if path.exists() {
            println!("DEBUG: [ModelManager] Found existing model in AppData: {:?}", path);
            return Ok(path);
        }

        println!("DEBUG: [ModelManager] Downloading model: {} from {}", model_name, url);
        
        // Add User-Agent to avoid being blocked by Hugging Face (often causes 401/403)
        let client = reqwest::Client::builder()
            .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
            .build()
            .map_err(|e| format!("Failed to create HTTP client: {}", e))?;

        let response = client.get(url).send().await
            .map_err(|e| format!("Failed to send request: {}", e))?;
        
        if !response.status().is_success() {
            return Err(format!("Failed to download model: HTTP {}", response.status()));
        }

        let total_size = response.content_length().unwrap_or(0);
        let mut file = fs::File::create(&path).map_err(|e| e.to_string())?;
        let mut stream = response.bytes_stream();
        let mut downloaded: u64 = 0;

        while let Some(item) = stream.next().await {
            let chunk = item.map_err(|e| e.to_string())?;
            file.write_all(&chunk).map_err(|e| e.to_string())?;
            downloaded += chunk.len() as u64;

            if total_size > 0 {
                let percentage = (downloaded as f32 / total_size as f32) * 100.0;
                let _ = handle.emit("model-download-progress", percentage);
            }
        }

        Ok(path)
    }
}
