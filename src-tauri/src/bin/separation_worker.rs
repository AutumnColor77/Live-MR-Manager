use std::path::PathBuf;
use std::sync::mpsc;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::thread;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri_app_lib::vocal_remover::{InferenceEngine, WaveformRemover};

#[derive(Debug, Deserialize)]
struct WorkerRequest {
    model_path: String,
    model_id: String,
    source_path: String,
    output_dir: String,
}

#[derive(Debug, Serialize)]
struct WorkerResponse {
    vocal_path: String,
    instrumental_path: String,
    provider: String,
    model: String,
}

fn main() {
    if let Err(e) = run() {
        eprintln!("{e}");
        std::process::exit(1);
    }
}

fn run() -> Result<(), String> {
    let arg = std::env::args()
        .nth(1)
        .ok_or_else(|| "missing request json argument".to_string())?;
    let req: WorkerRequest =
        serde_json::from_str(&arg).map_err(|e| format!("invalid request json: {e}"))?;

    let model_path = PathBuf::from(req.model_path);
    let source_path = PathBuf::from(req.source_path);
    let output_dir = PathBuf::from(req.output_dir);
    let model_id = req.model_id;

    eprintln!("[WORKER] start: model_path={:?}, source_path={:?}", model_path, source_path);

    // Isolate ORT init in a thread so we can fail fast on hangs.
    let (init_tx, init_rx) = mpsc::channel();
    let init_model_path = model_path.clone();
    let init_model_id = model_id.clone();
    thread::spawn(move || {
        let result = WaveformRemover::new(&init_model_path, Some(&init_model_id))
            .map_err(|e| format!("worker init failed: {e}"));
        let _ = init_tx.send(result);
    });

    let init_timeout = std::env::var("LIVE_MR_WORKER_INIT_TIMEOUT_SECS")
        .ok()
        .and_then(|v| v.parse::<u64>().ok())
        .unwrap_or(300);
    let init_started = std::time::Instant::now();
    let engine = loop {
        match init_rx.recv_timeout(Duration::from_secs(2)) {
            Ok(v) => {
                break v?;
            }
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                let elapsed = init_started.elapsed().as_secs();
                eprintln!("[WORKER] init waiting... {}s", elapsed);
                if init_timeout > 0 && elapsed >= init_timeout.max(60) {
                    return Err(format!("worker init timeout ({}s)", init_timeout));
                }
            }
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                return Err("worker init channel disconnected".to_string());
            }
        }
    };
    eprintln!("[WORKER] init done, provider={}", engine.get_provider());

    let (sep_tx, sep_rx) = mpsc::channel();
    let source_for_thread = source_path.clone();
    let output_for_thread = output_dir.clone();
    let progress_bits = Arc::new(AtomicU32::new(f32::to_bits(-1.0)));
    let progress_bits_for_cb = progress_bits.clone();
    thread::spawn(move || {
        let result = engine
            .separate(
                &source_for_thread,
                &output_for_thread,
                Arc::new(AtomicBool::new(false)),
                Box::new(move |p| {
                    let last = f32::from_bits(progress_bits_for_cb.load(Ordering::Relaxed));
                    if (p - last).abs() >= 0.5 || p <= 0.0 || p >= 100.0 {
                        progress_bits_for_cb.store(f32::to_bits(p), Ordering::Relaxed);
                        eprintln!("PROGRESS:{:.2}", p);
                    }
                }),
            )
            .map_err(|e| format!("worker separation failed: {e}"));
        let _ = sep_tx.send((result, engine.get_provider(), engine.get_model_name()));
    });

    let sep_timeout = std::env::var("LIVE_MR_WORKER_SEP_TIMEOUT_SECS")
        .ok()
        .and_then(|v| v.parse::<u64>().ok())
        .unwrap_or(0);
    let (sep_result, provider, model_name) = if sep_timeout == 0 {
        sep_rx
            .recv()
            .map_err(|_| "worker separation channel closed".to_string())?
    } else {
        let bounded = sep_timeout.max(120);
        sep_rx
            .recv_timeout(Duration::from_secs(bounded))
            .map_err(|_| format!("worker separation timeout ({}s)", bounded))?
    };
    let (vocal, instrumental) = sep_result?;
    eprintln!("[WORKER] separation done");

    let response = WorkerResponse {
        vocal_path: vocal.to_string_lossy().to_string(),
        instrumental_path: instrumental.to_string_lossy().to_string(),
        provider,
        model: model_name,
    };

    let json = serde_json::to_string(&response).map_err(|e| format!("serialize failed: {e}"))?;
    println!("{json}");
    Ok(())
}
