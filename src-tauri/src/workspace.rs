//! Root-confined workspace access.
//!
//! This module is the *only* filesystem authority in the app. The frontend
//! never sees or sends absolute paths except when choosing the root; every
//! other operation names a file by its root-relative id (forward slashes).
//!
//! Policy: one canonical root, no escaping it, no symlinks, files only,
//! UTF-8 only, 2 MiB max, and build/dependency directories are skipped.

use std::fs;
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;

use serde::Serialize;
use tauri::Manager;
use tauri_plugin_dialog::DialogExt;

const MAX_FILE_BYTES: u64 = 2 * 1024 * 1024;
const MAX_DEPTH: usize = 12;
const IGNORED: [&str; 4] = [".git", "node_modules", "target", "dist"];
const MAX_RESULTS: usize = 500;
/// Long lines are truncated in the preview: a minified bundle would otherwise
/// ship a megabyte of one line to the UI for a three-character match.
const MAX_PREVIEW_CHARS: usize = 200;

#[derive(Default)]
pub struct WorkspaceState(Mutex<Option<PathBuf>>);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceInfo {
    label: String,
    path: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    /// Root-relative path with forward slashes. Also the id used by `read_file`.
    id: String,
    name: String,
    /// "file" or "dir".
    kind: &'static str,
    depth: usize,
}

/// Canonicalize, without the Windows verbatim prefix.
///
/// `fs::canonicalize` returns `\\?\C:\...`. It compares and opens correctly, so
/// nothing internal cares — but it is also the path the user is shown as their
/// workspace, and the one a shell starts in. PowerShell reads a verbatim path
/// as a provider path and prompts with
/// `PS Microsoft.PowerShell.Core\FileSystem::\\?\C:\...`, which is what the
/// terminal actually showed before this existed.
///
/// Stripped in one place so the root and everything resolved under it are the
/// same shape: `resolve` confines by `starts_with`, and mixing the two forms
/// would make every file look like an escape.
pub(crate) fn canonical(path: &Path) -> std::io::Result<PathBuf> {
    let real = fs::canonicalize(path)?;
    #[cfg(windows)]
    {
        // Verbatim UNC (`\\?\UNC\server\share`) is left alone: its short form
        // is a different rewrite, and a network root is not worth the risk.
        if let Some(stripped) = real.to_str().and_then(|s| s.strip_prefix(r"\\?\")) {
            if !stripped.starts_with("UNC\\") {
                return Ok(PathBuf::from(stripped));
            }
        }
    }
    Ok(real)
}

/// Resolve a root-relative id to a real file beneath `root`.
///
/// Rejects absolute ids, `..`, anything that resolves outside the root, and
/// anything that is not a regular file. Symlinks are rejected because
/// `symlink_metadata` is checked before following.
pub(crate) fn resolve(root: &Path, id: &str) -> Result<PathBuf, String> {
    let candidate = Path::new(id);
    if candidate
        .components()
        .any(|c| !matches!(c, Component::Normal(_)))
    {
        return Err("invalid path".into());
    }

    let joined = root.join(candidate);
    let meta = fs::symlink_metadata(&joined).map_err(|_| "not found".to_string())?;
    if meta.file_type().is_symlink() {
        return Err("symlinks are not supported".into());
    }
    if !meta.is_file() {
        return Err("not a file".into());
    }
    if meta.len() > MAX_FILE_BYTES {
        return Err("file is larger than 2 MiB".into());
    }

    // Canonicalize last, as a belt-and-braces check against anything the
    // component scan missed (e.g. Windows 8.3 short names). Its failure is
    // deliberately *not* "not found" — the file was there a line ago, so this
    // is a permission or path problem, and callers that treat absence as a
    // legitimate answer (`git_diff`) must not treat this one that way.
    let real = canonical(&joined).map_err(|e| format!("cannot resolve path: {e}"))?;
    if !real.starts_with(root) {
        return Err("path escapes the workspace".into());
    }
    Ok(real)
}

fn walk(dir: &Path, prefix: &str, depth: usize, out: &mut Vec<Entry>) {
    if depth >= MAX_DEPTH {
        return;
    }
    let Ok(read) = fs::read_dir(dir) else {
        return;
    };

    let mut entries: Vec<_> = read.flatten().collect();
    entries.sort_by_key(|e| e.file_name());

    // Directories first, then files — the usual explorer ordering.
    for want_dir in [true, false] {
        for entry in &entries {
            let Ok(meta) = entry.metadata() else { continue };
            if meta.file_type().is_symlink() || meta.is_dir() != want_dir {
                continue;
            }
            let name = entry.file_name().to_string_lossy().into_owned();
            if want_dir && IGNORED.contains(&name.as_str()) {
                continue;
            }
            let id = if prefix.is_empty() {
                name.clone()
            } else {
                format!("{prefix}/{name}")
            };
            out.push(Entry {
                id: id.clone(),
                name,
                kind: if want_dir { "dir" } else { "file" },
                depth,
            });
            if want_dir {
                walk(&entry.path(), &id, depth + 1, out);
            }
        }
    }
}

pub(crate) fn root_of(state: &WorkspaceState) -> Result<PathBuf, String> {
    state
        .0
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| "no workspace selected".to_string())
}

/// Adopt a directory as the workspace root. The only place a root is ever set.
fn adopt(path: &Path, state: &WorkspaceState) -> Result<WorkspaceInfo, String> {
    let root = canonical(path).map_err(|e| e.to_string())?;
    if !root.is_dir() {
        return Err("not a directory".into());
    }
    let label = root
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| root.display().to_string());
    let info = WorkspaceInfo {
        label,
        path: root.display().to_string(),
    };
    *state.0.lock().unwrap() = Some(root);
    Ok(info)
}

/// Where the chosen root is remembered between launches.
fn record(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|dir| dir.join("workspace"))
        .map_err(|e| e.to_string())
}

/// Write the record `restore_workspace` reads back.
///
/// Silent on failure, deliberately: the user asked to open a folder and it is
/// open. Losing only the ability to reopen it automatically next launch is not
/// worth failing that on, and there is nothing they could do about it.
fn remember(app: &tauri::AppHandle, path: &str) {
    let Ok(file) = record(app) else { return };
    if let Some(dir) = file.parent() {
        let _ = fs::create_dir_all(dir);
    }
    let _ = fs::write(file, path);
}

/// Choose the workspace root through an OS folder dialog.
///
/// The dialog runs here rather than in the renderer, and the answer is written
/// down here too, because the renderer is the untrusted side: no command takes
/// a root from it. Choosing a folder is a user gesture through an OS dialog;
/// restoring one is not, so `restore_workspace` reads back what this wrote
/// instead of trusting a path out of `localStorage`.
#[tauri::command]
pub async fn choose_workspace(
    app: tauri::AppHandle,
    state: tauri::State<'_, WorkspaceState>,
) -> Result<Option<WorkspaceInfo>, String> {
    // `blocking_pick_folder` parks its thread until the user answers, so it is
    // put on the blocking pool rather than on an async worker.
    let dialog = app.clone();
    let picked = tauri::async_runtime::spawn_blocking(move || {
        dialog.dialog().file().blocking_pick_folder()
    })
    .await
    .map_err(|e| e.to_string())?;
    let Some(picked) = picked else {
        return Ok(None); // Dismissed.
    };
    let path = picked.into_path().map_err(|e| e.to_string())?;
    let info = adopt(&path, &state)?;
    remember(&app, &info.path);
    Ok(Some(info))
}

/// Re-select the root last chosen, by reading Rust's own record of it.
///
/// Takes no path. That is the whole point: see `choose_workspace`.
#[tauri::command]
pub fn restore_workspace(
    app: tauri::AppHandle,
    state: tauri::State<'_, WorkspaceState>,
) -> Result<WorkspaceInfo, String> {
    let recorded = fs::read_to_string(record(&app)?)
        .map_err(|_| "no workspace has been chosen on this machine".to_string())?;
    adopt(Path::new(recorded.trim()), &state)
}

/// Debug-only: set the root by path, so the app can be driven over the WebView2
/// debugging port without an OS dialog — `docs/OPEN-ISSUES.md` explains how.
/// It records the root like a real choice does, so a probe survives a reload.
///
/// Refuses in release builds, where a root named by the renderer is exactly the
/// hole `choose_workspace` exists to close.
#[tauri::command]
pub fn set_workspace(
    path: String,
    app: tauri::AppHandle,
    state: tauri::State<'_, WorkspaceState>,
) -> Result<WorkspaceInfo, String> {
    if !cfg!(debug_assertions) {
        return Err("set_workspace is a debug-build affordance".into());
    }
    let info = adopt(Path::new(&path), &state)?;
    remember(&app, &info.path);
    Ok(info)
}

#[tauri::command]
pub fn list_tree(state: tauri::State<'_, WorkspaceState>) -> Result<Vec<Entry>, String> {
    let root = root_of(&state)?;
    let mut out = Vec::new();
    walk(&root, "", 0, &mut out);
    Ok(out)
}

#[tauri::command]
pub fn read_file(id: String, state: tauri::State<'_, WorkspaceState>) -> Result<String, String> {
    let root = root_of(&state)?;
    let path = resolve(&root, &id)?;
    let bytes = fs::read(path).map_err(|e| e.to_string())?;
    String::from_utf8(bytes).map_err(|_| "file is not valid UTF-8".to_string())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PathMeta {
    name: String,
    /// Root-relative, so the renderer never learns the workspace's real path.
    path: String,
    kind: String,
    size: u64,
    mtime_ms: f64,
}

/// Metadata for a path, or `None` when it is absent.
///
/// Exists because the agent's `exists` check would otherwise have to read a
/// whole file to find out whether it is there — and pi's read tool probes five
/// Unicode variants of every path, so that is five full reads per tool call.
///
/// Absence is `Ok(None)` rather than `Err`: a missing file is an answer, not a
/// failure, and the harness distinguishes the two. Containment is the same
/// component scan `resolve` performs; directories are reported rather than
/// refused, which is the one way this is looser than `resolve` and is why it
/// grants no read.
#[tauri::command]
pub fn stat_path(
    id: String,
    state: tauri::State<'_, WorkspaceState>,
) -> Result<Option<PathMeta>, String> {
    let root = root_of(&state)?;
    let candidate = Path::new(&id);
    if candidate
        .components()
        .any(|c| !matches!(c, Component::Normal(_)))
    {
        return Err("invalid path".into());
    }

    let Ok(meta) = fs::symlink_metadata(root.join(candidate)) else {
        return Ok(None);
    };
    let file_type = meta.file_type();
    Ok(Some(PathMeta {
        name: candidate
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default(),
        path: id,
        // Symlinks are reported as such and never followed, matching `resolve`,
        // which refuses them outright.
        kind: if file_type.is_symlink() {
            "symlink"
        } else if file_type.is_dir() {
            "directory"
        } else {
            "file"
        }
        .into(),
        size: meta.len(),
        mtime_ms: meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as f64)
            .unwrap_or(0.0),
    }))
}

/// Overwrite an existing file in the workspace.
///
/// `resolve` requires the target to already exist as a regular file, so this
/// cannot create files, follow a symlink out of the root, or clobber a
/// directory. Creating new files is a separate capability the UI does not have.
#[tauri::command]
pub fn write_file(
    id: String,
    content: String,
    state: tauri::State<'_, WorkspaceState>,
) -> Result<(), String> {
    let root = root_of(&state)?;
    let path = resolve(&root, &id)?;
    if content.len() as u64 > MAX_FILE_BYTES {
        return Err("file is larger than 2 MiB".into());
    }
    fs::write(path, content).map_err(|e| e.to_string())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    /// Root-relative path of the containing file.
    id: String,
    name: String,
    /// 1-based, so the editor can reveal it directly.
    line: usize,
    preview: String,
}

/// Case-insensitive line search across the workspace.
///
/// Reuses the tree walk, so it inherits its policy exactly: ignored
/// directories, no symlinks, and the depth cap. Files that are too large or
/// not UTF-8 are skipped rather than reported as errors — an unreadable file
/// is not a search failure.
#[tauri::command]
pub fn search_workspace(
    query: String,
    state: tauri::State<'_, WorkspaceState>,
) -> Result<Vec<SearchResult>, String> {
    let root = root_of(&state)?;
    let needle = query.trim().to_lowercase();
    if needle.is_empty() {
        return Ok(Vec::new());
    }

    let mut entries = Vec::new();
    walk(&root, "", 0, &mut entries);

    let mut results = Vec::new();
    for entry in entries.iter().filter(|e| e.kind == "file") {
        if results.len() >= MAX_RESULTS {
            break;
        }
        let Ok(path) = resolve(&root, &entry.id) else {
            continue; // Too large, vanished, or otherwise not readable.
        };
        let Ok(text) = fs::read_to_string(path) else {
            continue; // Not UTF-8: skip, do not fail the whole search.
        };
        for (index, line) in text.lines().enumerate() {
            if results.len() >= MAX_RESULTS {
                break;
            }
            if !line.to_lowercase().contains(&needle) {
                continue;
            }
            let trimmed = line.trim();
            let preview = match trimmed.char_indices().nth(MAX_PREVIEW_CHARS) {
                Some((cut, _)) => format!("{}…", &trimmed[..cut]),
                None => trimmed.to_string(),
            };
            results.push(SearchResult {
                id: entry.id.clone(),
                name: entry.name.clone(),
                line: index + 1,
                preview,
            });
        }
    }
    Ok(results)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canonical_leaves_no_verbatim_prefix() {
        let real = canonical(&std::env::temp_dir()).unwrap();
        // What the user is shown and what a shell starts in.
        assert!(!real.to_string_lossy().starts_with(r"\\?\"), "{real:?}");
        assert!(real.is_dir(), "still has to open: {real:?}");
    }

    #[test]
    fn resolve_confines_to_root() {
        let dir = std::env::temp_dir().join("ade-resolve-test");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("sub")).unwrap();
        fs::write(dir.join("sub/ok.txt"), "hi").unwrap();
        fs::write(dir.join("../ade-outside.txt"), "nope").unwrap();
        // Built the same way `adopt` builds a real root: a test that mixed
        // the verbatim and stripped forms would fail every confinement check.
        let root = canonical(&dir).unwrap();

        assert!(resolve(&root, "sub/ok.txt").is_ok());
        assert!(resolve(&root, "../ade-outside.txt").is_err());
        assert!(resolve(&root, "sub/../../ade-outside.txt").is_err());
        assert!(resolve(&root, "sub").is_err()); // directory, not a file
        assert!(resolve(&root, "sub/missing.txt").is_err());

        let _ = fs::remove_dir_all(&dir);
        let _ = fs::remove_file(dir.join("../ade-outside.txt"));
    }
}
