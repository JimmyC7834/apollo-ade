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

/// Resolve a root-relative id to a real file beneath `root`.
///
/// Rejects absolute ids, `..`, anything that resolves outside the root, and
/// anything that is not a regular file. Symlinks are rejected because
/// `symlink_metadata` is checked before following.
fn resolve(root: &Path, id: &str) -> Result<PathBuf, String> {
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
    // component scan missed (e.g. Windows 8.3 short names).
    let real = fs::canonicalize(&joined).map_err(|_| "not found".to_string())?;
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

fn root_of(state: &WorkspaceState) -> Result<PathBuf, String> {
    state
        .0
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| "no workspace selected".to_string())
}

#[tauri::command]
pub fn set_workspace(
    path: String,
    state: tauri::State<'_, WorkspaceState>,
) -> Result<WorkspaceInfo, String> {
    let root = fs::canonicalize(&path).map_err(|e| e.to_string())?;
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
    fn resolve_confines_to_root() {
        let dir = std::env::temp_dir().join("ade-resolve-test");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("sub")).unwrap();
        fs::write(dir.join("sub/ok.txt"), "hi").unwrap();
        fs::write(dir.join("../ade-outside.txt"), "nope").unwrap();
        let root = fs::canonicalize(&dir).unwrap();

        assert!(resolve(&root, "sub/ok.txt").is_ok());
        assert!(resolve(&root, "../ade-outside.txt").is_err());
        assert!(resolve(&root, "sub/../../ade-outside.txt").is_err());
        assert!(resolve(&root, "sub").is_err()); // directory, not a file
        assert!(resolve(&root, "sub/missing.txt").is_err());

        let _ = fs::remove_dir_all(&dir);
        let _ = fs::remove_file(dir.join("../ade-outside.txt"));
    }
}
