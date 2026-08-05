//! The global profiles file — the one thing this app reads from outside the
//! workspace root.
//!
//! `workspace.rs` is the filesystem authority for the *project*, and it refuses
//! everything above the root on purpose. Decision 4 of
//! `docs/wayfinder/pi-harness/tickets/04-profile-data-model.md` puts a second
//! profiles file beside it in the user's config directory, which is outside that
//! root by definition — so it needs its own door.
//!
//! The door is deliberately narrow: **one fixed path, read-only, no argument.**
//! The renderer cannot name a file, so this grants no ability to read anything
//! else; it is a single hard-coded location rather than a second filesystem.

use std::fs;
use std::path::PathBuf;

use tauri::Manager;

/// Generous for a config file and small enough that a wrong path cannot be used
/// to pull something large into the renderer.
const MAX_BYTES: u64 = 256 * 1024;

fn global_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|dir| dir.join("profiles.json"))
        .map_err(|e| e.to_string())
}

/// The global profiles file, or `None` when it does not exist.
///
/// Absence is an answer, not a failure: no file is the normal state, and the
/// built-in profiles are what the app runs on until someone writes one.
#[tauri::command]
pub fn read_global_profiles(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let path = global_path(&app)?;
    let Ok(meta) = fs::symlink_metadata(&path) else {
        return Ok(None);
    };
    // Matching `workspace.rs`: a symlink is refused rather than followed, so
    // this path cannot be turned into a window onto another file.
    if meta.file_type().is_symlink() {
        return Err("symlinks are not supported".into());
    }
    if !meta.is_file() {
        return Err("not a file".into());
    }
    if meta.len() > MAX_BYTES {
        return Err("profiles.json is larger than 256 KiB".into());
    }
    fs::read_to_string(&path)
        .map(Some)
        .map_err(|e| e.to_string())
}

/// Where that file goes, so the app can tell the user rather than make them
/// guess. A feature whose configuration lives at an unnamed path is a feature
/// nobody finds.
#[tauri::command]
pub fn global_profiles_path(app: tauri::AppHandle) -> Result<String, String> {
    global_path(&app).map(|path| path.display().to_string())
}
