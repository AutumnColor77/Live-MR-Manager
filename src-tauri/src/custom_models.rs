//! Custom AI separation models.
//!
//! Users can register additional ONNX separation models on top of the two
//! built-in ones (`kim`, `inst_hq_3`). Because the separation engine needs to
//! know the STFT/architecture parameters for a model — and those cannot be
//! reliably inferred for an arbitrary file — each custom model is tied to an
//! **architecture preset**. The preset supplies the concrete parameters the
//! engine uses at inference time (see `crate::vocal_remover::ModelParams`).
//!
//! Registration supports (1) a local `.onnx` file picker and (2) an HTTPS URL
//! download with size cap + required SHA-256 verification
//! (see `model_commands::add_custom_model`).

use serde::{Deserialize, Serialize};

use crate::vocal_remover::{EngineKind, ModelParams};

/// A selectable architecture preset. The user picks the one that matches the
/// ONNX model they are adding.
#[derive(Debug, Clone, Serialize)]
pub struct ArchPreset {
    /// Stable key stored in the DB, e.g. `"mdx_vocal"`.
    pub key: &'static str,
    /// Human-readable label shown in the UI.
    pub label: &'static str,
    /// Short description / hint for the UI.
    pub description: &'static str,
    /// Inference path: spectrogram (Rust STFT) or raw waveform (embedded STFT).
    pub engine: EngineKind,
    pub is_mdx: bool,
    pub is_roformer: bool,
    pub is_kara: bool,
    pub n_fft: usize,
    pub hop_length: usize,
    pub target_bins: usize,
    /// Whether the model's primary output is the instrumental (MR) stem.
    pub outputs_instrumental: bool,
    /// RawWaveform only: index of the vocal stem on the output `sources` axis.
    pub vocal_source_index: usize,
}

impl ArchPreset {
    pub fn to_params(&self) -> ModelParams {
        ModelParams {
            engine: self.engine,
            is_mdx: self.is_mdx,
            is_roformer: self.is_roformer,
            is_kara: self.is_kara,
            n_fft: self.n_fft,
            hop_length: self.hop_length,
            target_bins: self.target_bins,
            outputs_instrumental: self.outputs_instrumental,
            vocal_source_index: self.vocal_source_index,
        }
    }
}

/// The supported presets. Kept in sync with the built-in heuristics in
/// `vocal_remover::separate`.
pub const PRESETS: &[ArchPreset] = &[
    ArchPreset {
        key: "mdx_vocal",
        label: "MDX-Net (보컬 추출)",
        description: "Kim Vocal 2 같은 보컬 추출 모델에 사용합니다.",
        engine: EngineKind::Spectrogram,
        is_mdx: true,
        is_roformer: false,
        is_kara: false,
        n_fft: 7680,
        hop_length: 1024,
        target_bins: 3072,
        outputs_instrumental: false,
        vocal_source_index: 0,
    },
    ArchPreset {
        key: "mdx_inst",
        label: "MDX-Net (반주/MR 추출)",
        description: "Inst HQ 계열처럼 반주(MR)를 뽑는 모델에 사용합니다.",
        engine: EngineKind::Spectrogram,
        is_mdx: true,
        is_roformer: false,
        is_kara: false,
        n_fft: 7680,
        hop_length: 1024,
        target_bins: 3072,
        outputs_instrumental: true,
        vocal_source_index: 0,
    },
    ArchPreset {
        key: "mdx_kara",
        label: "MDX-Net KARA (2048 bins)",
        description: "KARA 2 계열 모델에 사용합니다.",
        engine: EngineKind::Spectrogram,
        is_mdx: true,
        is_roformer: false,
        is_kara: true,
        n_fft: 4096,
        hop_length: 1024,
        target_bins: 2048,
        outputs_instrumental: true,
        vocal_source_index: 0,
    },
    ArchPreset {
        key: "roformer_vocal",
        label: "RoFormer (스펙트로그램 입력, 실험적)",
        description: "스펙트로그램 입력 RoFormer용입니다. 일반 Mel-Band RoFormer는 아래 프리셋을 쓰세요.",
        engine: EngineKind::Spectrogram,
        is_mdx: false,
        is_roformer: true,
        is_kara: false,
        n_fft: 2048,
        hop_length: 512,
        target_bins: 1025,
        outputs_instrumental: false,
        vocal_source_index: 0,
    },
    ArchPreset {
        key: "melband_roformer",
        label: "Mel-Band RoFormer (파형 직접 입출력, GPU 권장)",
        description: "파형을 직접 넣고 받는 Mel-Band RoFormer용입니다. GPU를 권장합니다.",
        engine: EngineKind::RawWaveform,
        is_mdx: false,
        is_roformer: true,
        is_kara: false,
        // Spectrogram params are unused on the RawWaveform path; kept as
        // benign defaults.
        n_fft: 2048,
        hop_length: 512,
        target_bins: 1025,
        outputs_instrumental: false,
        vocal_source_index: 0,
    },
];

pub fn preset_by_key(key: &str) -> Option<&'static ArchPreset> {
    PRESETS.iter().find(|p| p.key == key)
}

/// A user-registered custom model.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomModel {
    /// Unique id, e.g. `"custom_1720000000000"`.
    pub id: String,
    /// Display name.
    pub name: String,
    /// Filename stored under the app's `models` directory.
    pub filename: String,
    /// Source HTTPS URL when registered via download; empty for local-file adds.
    pub url: String,
    /// Architecture preset key.
    pub preset_key: String,
}

/// Create the CustomModels table if it does not exist. Called during DB init.
pub fn ensure_table(conn: &rusqlite::Connection) {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS CustomModels (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            filename TEXT NOT NULL,
            url TEXT NOT NULL DEFAULT '',
            preset_key TEXT NOT NULL
         );",
    )
    .ok();
}

pub fn list() -> Vec<CustomModel> {
    let db = crate::state::DB.lock();
    let mut stmt = match db.prepare("SELECT id, name, filename, url, preset_key FROM CustomModels ORDER BY name") {
        Ok(s) => s,
        Err(_) => return Vec::new(),
    };
    let rows = stmt.query_map([], |row| {
        Ok(CustomModel {
            id: row.get(0)?,
            name: row.get(1)?,
            filename: row.get(2)?,
            url: row.get(3)?,
            preset_key: row.get(4)?,
        })
    });
    match rows {
        Ok(iter) => iter.filter_map(|r| r.ok()).collect(),
        Err(_) => Vec::new(),
    }
}

pub fn get(id: &str) -> Option<CustomModel> {
    let db = crate::state::DB.lock();
    db.query_row(
        "SELECT id, name, filename, url, preset_key FROM CustomModels WHERE id = ?",
        rusqlite::params![id],
        |row| {
            Ok(CustomModel {
                id: row.get(0)?,
                name: row.get(1)?,
                filename: row.get(2)?,
                url: row.get(3)?,
                preset_key: row.get(4)?,
            })
        },
    )
    .ok()
}

pub fn insert(model: &CustomModel) -> Result<(), String> {
    let db = crate::state::DB.lock();
    db.execute(
        "INSERT OR REPLACE INTO CustomModels (id, name, filename, url, preset_key) VALUES (?, ?, ?, ?, ?)",
        rusqlite::params![model.id, model.name, model.filename, model.url, model.preset_key],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn delete(id: &str) -> Result<(), String> {
    let db = crate::state::DB.lock();
    db.execute("DELETE FROM CustomModels WHERE id = ?", rusqlite::params![id])
        .map_err(|e| e.to_string())?;
    Ok(())
}
