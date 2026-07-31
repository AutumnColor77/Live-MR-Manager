//! MR separation cache file names, format preference, and path resolution.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU8, Ordering};

pub const VOCAL_MP3: &str = "vocal.mp3";
pub const INST_MP3: &str = "inst.mp3";
pub const VOCAL_WAV: &str = "vocal.wav";
pub const INST_WAV: &str = "inst.wav";

const FORMAT_MP3: u8 = 0;
const FORMAT_WAV: u8 = 1;

const SETTINGS_KEY: &str = "mr_cache_format";

/// Default: MP3 320 kbps (smaller/faster cache writes).
static MR_CACHE_FORMAT: AtomicU8 = AtomicU8::new(FORMAT_MP3);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MrCacheFormat {
    Mp3,
    Wav,
}

impl MrCacheFormat {
    pub fn as_str(self) -> &'static str {
        match self {
            MrCacheFormat::Mp3 => "mp3",
            MrCacheFormat::Wav => "wav",
        }
    }

    pub fn from_str(s: &str) -> Option<Self> {
        match s.trim().to_lowercase().as_str() {
            "mp3" => Some(Self::Mp3),
            "wav" => Some(Self::Wav),
            _ => None,
        }
    }

    pub fn vocal_filename(self) -> &'static str {
        match self {
            MrCacheFormat::Mp3 => VOCAL_MP3,
            MrCacheFormat::Wav => VOCAL_WAV,
        }
    }

    pub fn inst_filename(self) -> &'static str {
        match self {
            MrCacheFormat::Mp3 => INST_MP3,
            MrCacheFormat::Wav => INST_WAV,
        }
    }
}

pub fn current_format() -> MrCacheFormat {
    match MR_CACHE_FORMAT.load(Ordering::Relaxed) {
        FORMAT_WAV => MrCacheFormat::Wav,
        _ => MrCacheFormat::Mp3,
    }
}

fn store_format(format: MrCacheFormat) {
    let code = match format {
        MrCacheFormat::Mp3 => FORMAT_MP3,
        MrCacheFormat::Wav => FORMAT_WAV,
    };
    MR_CACHE_FORMAT.store(code, Ordering::Relaxed);
}

pub fn set_format(s: &str) -> Result<(), String> {
    let format = MrCacheFormat::from_str(s)
        .ok_or_else(|| "지원하지 않는 MR 캐시 형식입니다 (mp3 또는 wav)".to_string())?;
    store_format(format);
    let db = crate::state::DB.lock();
    db.execute(
        "INSERT OR REPLACE INTO Settings (key, value) VALUES (?, ?)",
        rusqlite::params![SETTINGS_KEY, format.as_str()],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Restores the saved format at startup. Must run after the DB is initialized
/// and before any separation reads `current_format()`, otherwise the in-process
/// default (MP3) would silently win over the user's choice.
pub fn load_persisted_format() {
    let stored: Option<String> = {
        let db = crate::state::DB.lock();
        db.query_row(
            "SELECT value FROM Settings WHERE key = ?",
            rusqlite::params![SETTINGS_KEY],
            |row| row.get(0),
        )
        .ok()
    };
    if let Some(format) = stored.as_deref().and_then(MrCacheFormat::from_str) {
        store_format(format);
    }
}

pub fn mr_output_paths_for(dir: &Path, format: MrCacheFormat) -> (PathBuf, PathBuf) {
    (
        dir.join(format.vocal_filename()),
        dir.join(format.inst_filename()),
    )
}

pub fn mr_output_paths(dir: &Path) -> (PathBuf, PathBuf) {
    mr_output_paths_for(dir, current_format())
}

fn mp3_pair_paths(dir: &Path) -> (PathBuf, PathBuf) {
    (dir.join(VOCAL_MP3), dir.join(INST_MP3))
}

fn wav_pair_paths(dir: &Path) -> (PathBuf, PathBuf) {
    (dir.join(VOCAL_WAV), dir.join(INST_WAV))
}

pub fn is_inst_stem_name(name: &str) -> bool {
    matches!(name.to_ascii_lowercase().as_str(), INST_MP3 | INST_WAV)
}

/// Prefer MP3 pair, then legacy WAV.
pub fn resolve_mr_pair(dir: &Path) -> Option<(PathBuf, PathBuf)> {
    let (v, i) = mp3_pair_paths(dir);
    if v.is_file() && i.is_file() {
        return Some((v, i));
    }
    let (v, i) = wav_pair_paths(dir);
    if v.is_file() && i.is_file() {
        return Some((v, i));
    }
    None
}

pub fn mr_pair_exists(dir: &Path) -> bool {
    resolve_mr_pair(dir).is_some()
}

pub fn resolve_vocal(dir: &Path) -> Option<PathBuf> {
    let mp3 = dir.join(VOCAL_MP3);
    if mp3.is_file() {
        return Some(mp3);
    }
    let wav = dir.join(VOCAL_WAV);
    if wav.is_file() {
        return Some(wav);
    }
    None
}

pub fn resolve_inst(dir: &Path) -> Option<PathBuf> {
    let mp3 = dir.join(INST_MP3);
    if mp3.is_file() {
        return Some(mp3);
    }
    let wav = dir.join(INST_WAV);
    if wav.is_file() {
        return Some(wav);
    }
    None
}

pub fn delete_mr_stems(dir: &Path) -> std::io::Result<()> {
    for name in [VOCAL_MP3, INST_MP3, VOCAL_WAV, INST_WAV] {
        let p = dir.join(name);
        if p.is_file() {
            std::fs::remove_file(p)?;
        }
    }
    Ok(())
}
