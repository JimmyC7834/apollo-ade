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
/// Hidden from the explorer's tree. `.ade` holds the agent's own session
/// transcripts, which are ours rather than the user's project.
const IGNORED: [&str; 5] = [".git", "node_modules", "target", "dist", ".ade"];
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

/// Where a root-relative id lands, with the component scan already done.
///
/// Extracted when the session store needed four more commands that all make the
/// same argument: no `..`, no absolute ids, nothing outside the root. It does
/// *not* require the path to exist, which is the whole reason `resolve` cannot
/// be reused — every caller here creates something.
///
/// The returned path is not yet safe to write to: `..` cannot appear, but a
/// symlinked *directory* along the way still can, so callers canonicalise the
/// parent afterwards. That check has to happen after `create_dir_all`, which is
/// why it is not folded in here.
pub(crate) fn contained(root: &Path, id: &str) -> Result<PathBuf, String> {
    let candidate = Path::new(id);
    if candidate
        .components()
        .any(|c| !matches!(c, Component::Normal(_)))
    {
        return Err("invalid path".into());
    }
    Ok(root.join(candidate))
}

/// The parent directory that will actually be written to, created and checked.
fn writable_parent(root: &Path, target: &Path) -> Result<(), String> {
    let parent = target.parent().ok_or_else(|| "invalid path".to_string())?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let real_parent = canonical(parent).map_err(|e| e.to_string())?;
    if !real_parent.starts_with(root) {
        return Err("refusing to write outside the workspace".into());
    }
    Ok(())
}

/// Append text to a file, creating it and its parents when absent.
///
/// Exists for the session store, which is append-only by design: rewriting the
/// whole JSONL file on every entry would make the cost of a turn grow with the
/// length of the conversation.
///
/// **The 2 MiB cap applies to the appended chunk, not the file.** A session
/// transcript is the one thing here that grows without bound, and refusing to
/// extend it once it passed a size limit would lose the conversation rather
/// than truncate it.
#[tauri::command]
pub fn agent_append_file(
    id: String,
    content: String,
    state: tauri::State<'_, WorkspaceState>,
) -> Result<(), String> {
    use std::io::Write;

    let root = root_of(&state)?;
    let target = contained(&root, &id)?;
    if content.len() as u64 > MAX_FILE_BYTES {
        return Err("append is larger than 2 MiB".into());
    }
    writable_parent(&root, &target)?;

    if let Ok(meta) = fs::symlink_metadata(&target) {
        if meta.file_type().is_symlink() {
            return Err("symlinks are not supported".into());
        }
        if !meta.is_file() {
            return Err("not a file".into());
        }
    }

    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&target)
        .map_err(|e| e.to_string())?;
    file.write_all(content.as_bytes()).map_err(|e| e.to_string())
}

/// Create a directory and its parents.
#[tauri::command]
pub fn agent_create_dir(
    id: String,
    state: tauri::State<'_, WorkspaceState>,
) -> Result<(), String> {
    let root = root_of(&state)?;
    let target = contained(&root, &id)?;
    fs::create_dir_all(&target).map_err(|e| e.to_string())?;
    // Canonicalise the directory itself rather than its parent: this *is* the
    // thing being created, and a symlinked ancestor would otherwise pass.
    let real = canonical(&target).map_err(|e| e.to_string())?;
    if !real.starts_with(&root) {
        return Err("refusing to create outside the workspace".into());
    }
    Ok(())
}

/// Direct children of a directory, without following symlinks.
///
/// Unlike `list_tree` this does not recurse and does not skip `IGNORED`
/// directories — it answers a question about one directory rather than
/// producing a view of the project, and the session store asks it about a
/// directory whose name begins with a dot.
///
/// An absent directory is an error rather than an empty list: "there is nothing
/// here" and "there is no here" lead to different next moves.
#[tauri::command]
pub fn agent_list_dir(
    id: String,
    state: tauri::State<'_, WorkspaceState>,
) -> Result<Vec<PathMeta>, String> {
    let root = root_of(&state)?;
    let target = contained(&root, &id)?;

    let mut out = Vec::new();
    for entry in fs::read_dir(&target).map_err(|_| "not found".to_string())? {
        let Ok(entry) = entry else { continue };
        let Ok(meta) = entry.metadata() else { continue };
        let name = entry.file_name().to_string_lossy().into_owned();
        let file_type = entry.file_type().map_err(|e| e.to_string())?;
        out.push(PathMeta {
            path: if id.is_empty() {
                name.clone()
            } else {
                format!("{id}/{name}")
            },
            name,
            kind: if file_type.is_symlink() {
                "symlink"
            } else if meta.is_dir() {
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
        });
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

/// Read up to `max_lines` UTF-8 lines.
///
/// Separate from `read_file` because that one goes through `resolve`, which
/// refuses anything over 2 MiB — and the session transcript is exactly the file
/// that will pass 2 MiB in a long conversation. Reading it back line by line
/// also keeps a large session out of the renderer's memory in one lump.
#[tauri::command]
pub fn read_text_lines(
    id: String,
    max_lines: Option<usize>,
    state: tauri::State<'_, WorkspaceState>,
) -> Result<Vec<String>, String> {
    use std::io::{BufRead, BufReader};

    let root = root_of(&state)?;
    let target = contained(&root, &id)?;

    let meta = fs::symlink_metadata(&target).map_err(|_| "not found".to_string())?;
    if meta.file_type().is_symlink() {
        return Err("symlinks are not supported".into());
    }
    if !meta.is_file() {
        return Err("not a file".into());
    }

    let file = fs::File::open(&target).map_err(|e| e.to_string())?;
    let limit = max_lines.unwrap_or(usize::MAX);
    let mut lines = Vec::new();
    for line in BufReader::new(file).lines().take(limit) {
        lines.push(line.map_err(|_| "file is not valid UTF-8".to_string())?);
    }
    Ok(lines)
}

/// Create or overwrite a file for the agent, inside the root.
///
/// Separate from `write_file` because that one routes through `resolve`, which
/// requires the target to already exist — the editor can only save files it
/// opened, and that restriction is right for the editor. An agent has to be
/// able to create.
///
/// The containment argument is therefore made here rather than inherited:
///
/// - every component must be `Normal`, so `..` and absolute paths are refused
///   before anything touches the disk;
/// - the *parent* is canonicalised and must still be inside the root, which is
///   what stops a symlinked directory being used as a way out;
/// - an existing target that is a symlink or not a regular file is refused,
///   so this cannot clobber a directory or write through a link.
///
/// **This is the floor from the permission gate ticket, and it is enforced
/// regardless of what the gate in TypeScript decided.** A renderer that has
/// been talked into writing outside the root still cannot.
#[tauri::command]
pub fn agent_write_file(
    id: String,
    content: String,
    state: tauri::State<'_, WorkspaceState>,
) -> Result<(), String> {
    let root = root_of(&state)?;
    let candidate = Path::new(&id);
    if candidate
        .components()
        .any(|c| !matches!(c, Component::Normal(_)))
    {
        return Err("invalid path".into());
    }
    if content.len() as u64 > MAX_FILE_BYTES {
        return Err("file is larger than 2 MiB".into());
    }

    let target = root.join(candidate);
    let parent = target.parent().ok_or_else(|| "invalid path".to_string())?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;

    // Canonicalise after creating, so the check sees the directory that will
    // actually be written to rather than one that may not exist yet.
    let real_parent = canonical(parent).map_err(|e| e.to_string())?;
    if !real_parent.starts_with(&root) {
        return Err("refusing to write outside the workspace".into());
    }

    if let Ok(meta) = fs::symlink_metadata(&target) {
        if meta.file_type().is_symlink() {
            return Err("symlinks are not supported".into());
        }
        if !meta.is_file() {
            return Err("not a file".into());
        }
    }

    fs::write(&target, content).map_err(|e| e.to_string())
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

    /// The session store's four commands all share `contained`, so this is the
    /// one place their containment argument is made. `resolve` cannot be reused
    /// for them — every one of them creates something, and `resolve` requires
    /// the path to already exist — so the check has to be asserted separately
    /// rather than inherited.
    #[test]
    fn contained_refuses_escapes() {
        let root = canonical(&std::env::temp_dir()).unwrap();

        assert!(contained(&root, "a/b.jsonl").is_ok());
        assert!(contained(&root, ".ade/sessions/x.jsonl").is_ok());

        for escape in ["../out.txt", "a/../../out.txt", "/abs.txt", r"..\out.txt"] {
            assert!(
                contained(&root, escape).is_err(),
                "should have refused {escape:?}"
            );
        }

        // Windows accepts a drive-qualified path as a `Prefix` component, not a
        // `Normal` one, which is the case a naive `starts_with("/")` check misses.
        #[cfg(windows)]
        assert!(contained(&root, r"C:\Windows\System32\drivers\etc\hosts").is_err());
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
