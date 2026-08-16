//! Root-confined workspace access.
//!
//! This module is the *only* filesystem authority in the app. The frontend
//! never sees or sends absolute paths except when choosing the root; every
//! other operation names a file by its root-relative id (forward slashes).
//!
//! Policy: one canonical root, no escaping it, no symlinks, files only,
//! UTF-8 only, 2 MiB max, and build/dependency directories are skipped.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use serde::Serialize;
use tauri::Manager;
use tauri_plugin_dialog::DialogExt;

const MAX_FILE_BYTES: u64 = 2 * 1024 * 1024;
const MAX_DEPTH: usize = 12;
/// Hidden from the explorer's tree. `.ade` holds the agent's own session
/// transcripts, which are ours rather than the user's project.
/// `.skills` is here because the mount books that id for the *global* skills
/// directory. A project that really contains `<root>/.skills` would otherwise be
/// listed and searched by these ids and then read from somewhere else entirely —
/// the explorer showing one file and `read_file` opening another.
const IGNORED: [&str; 6] = [".git", "node_modules", "target", "dist", ".ade", ".skills"];
const MAX_RESULTS: usize = 500;
/// Long lines are truncated in the preview: a minified bundle would otherwise
/// ship a megabyte of one line to the UI for a three-character match.
const MAX_PREVIEW_CHARS: usize = 200;

#[derive(Default)]
pub struct WorkspaceState(Mutex<Option<PathBuf>>);

/// Which root each live session is confined to.
///
/// **Confinement used to be ambient and this is what replaces it** — see
/// `docs/adr/0002-a-root-per-session.md`, which supersedes 0001. `WorkspaceState`
/// holds one root and every command resolved against whatever it held *at the
/// moment the command ran*, so "which root am I confined to" was a property of
/// timing. Two sessions running in two folders makes that untenable: both have to
/// resolve at the same instant, and a switch under an in-flight turn is exactly
/// how the session corruption fixed on 2026-08-15 happened.
///
/// A session's root is fixed when it is registered and is never changed, which is
/// strictly stricter than what it replaces.
#[derive(Default)]
pub struct SessionRoots {
    roots: Mutex<HashMap<String, PathBuf>>,
    next: AtomicU64,
}

impl SessionRoots {
    /// Mint an id for a root and remember the pair.
    ///
    /// **Opaque means "means nothing to the renderer", not "unguessable".** A
    /// counter is enough: an id can only ever name a root the renderer itself
    /// registered, through the two doors a root has always had — an OS dialog or
    /// an index into the recents list — so guessing one grants no authority that
    /// asking for one would not.
    fn register(&self, root: PathBuf) -> String {
        let id = format!("session-{}", self.next.fetch_add(1, Ordering::Relaxed));
        self.roots.lock().unwrap().insert(id.clone(), root);
        id
    }

    fn forget(&self, id: &str) {
        self.roots.lock().unwrap().remove(id);
    }

    /// The root an id names, or a refusal.
    ///
    /// **Never falls back to the current root.** An id that has been closed, or
    /// one from a window that has gone, would otherwise write a session's files
    /// into whichever folder happened to be focused — the failure this table
    /// exists to make impossible.
    fn root(&self, id: &str) -> Result<PathBuf, String> {
        self.roots
            .lock()
            .unwrap()
            .get(id)
            .cloned()
            .ok_or_else(|| "unknown session".to_string())
    }
}

/// Who wrote which file, so a second agent in one folder is told about the first.
///
/// **Rust is the only side that can hold this** — ticket 51. It sees every
/// session's writes; a registry in the renderer would only know about the
/// sessions that particular window built, and the write path is the boundary
/// that has to hold anyway.
///
/// Three decisions, all visible in the shape of this:
///
/// - **Writes only.** Two agents reading one file is normal and harmless, and a
///   note on it would be constant noise. Nothing here is consulted by a read.
/// - **Written *this turn*.** `turn` counts each session's turns — `git_checkpoint`
///   is where a turn begins, and is called once at the start of every one — and a
///   write records the writer's turn number alongside it. The note fires only
///   while that number is still current, which is the difference between "someone
///   is working on this right now" and "someone once touched it".
/// - **Once per file per session.** `told` is never cleared. A note on every write
///   becomes a thing the model learns to skip past, and then the one that mattered
///   is skipped too.
#[derive(Default)]
pub struct Writers(Mutex<WriterState>);

#[derive(Default)]
struct WriterState {
    /// Session id → how many turns it has begun. Absent once the session closes,
    /// which is what stops a conversation nobody has open from warning anybody.
    turn: HashMap<String, u64>,
    /// Session id → what the window calls it. The note has to name the other
    /// conversation in words its reader could act on; `session-3` is not that.
    label: HashMap<String, String>,
    /// (root, root-relative path) → who wrote it last, and on which of its turns.
    wrote: HashMap<(PathBuf, String), (String, u64)>,
    /// (session, root, path) pairs already warned. Deliberately never pruned.
    told: HashSet<(String, PathBuf, String)>,
    /*
     * Ticket 52's half: enough to answer "what else has happened in this folder
     * since that checkpoint was taken". A counter rather than a clock, because
     * the question is ordering and two writes in one millisecond are ordered.
     */
    seq: u64,
    /// Checkpoint sha → the root it was taken in, and the count at the time.
    checkpoints: HashMap<String, (PathBuf, u64)>,
    /// (root, session) → the count at that session's last write there.
    last: HashMap<(PathBuf, String), u64>,
}

impl Writers {
    /// A turn is starting in this session.
    fn turn_begins(&self, session: &str) {
        *self.0.lock().unwrap().turn.entry(session.to_string()).or_default() += 1;
    }

    /// What the window calls this session, for the note to name.
    fn name(&self, session: &str, label: &str) {
        self.0
            .lock()
            .unwrap()
            .label
            .insert(session.to_string(), label.to_string());
    }

    /// Forget a session. Its turn is no longer current, so it warns nobody.
    fn closed(&self, session: &str) {
        let mut state = self.0.lock().unwrap();
        state.turn.remove(session);
        state.label.remove(session);
    }

    /// Record a write, and hand back the note it earns — if any.
    ///
    /// **Never refuses.** The write has already happened by the time this runs,
    /// and that is the decision rather than an accident of ordering: what to do
    /// about a collision belongs to the agent, and above it to the person reading
    /// the transcript.
    fn wrote(&self, root: &Path, id: &str, session: Option<&str>) -> Option<String> {
        // A sessionless write is the workbench's own — the editor saving a file —
        // and has nobody to warn and nothing to warn about.
        let session = session?;
        /*
         * The same spelling `agent_may_write` normalises to, and for the same
         * reason it does it: an id arrives as `src/a.ts`, `src.ts` or
         * `/src/a.ts` depending on which tool built it, and three spellings of one
         * file in this map is three files that never collide with each other.
         */
        let id = &normal(id);
        // The agent's own session transcripts are not the user's project, and no
        // two sessions ever write to the same one.
        if id.starts_with(".ade/") {
            return None;
        }
        let mut state = self.0.lock().unwrap();
        let key = (root.to_path_buf(), id.to_string());
        let note = match state.wrote.get(&key) {
            Some((other, turn))
                if other != session
                    && state.turn.get(other) == Some(turn)
                    && !state
                        .told
                        .contains(&(session.to_string(), key.0.clone(), key.1.clone())) =>
            {
                let who = state
                    .label
                    .get(other)
                    .cloned()
                    .unwrap_or_else(|| "another session".to_string());
                state
                    .told
                    .insert((session.to_string(), key.0.clone(), key.1.clone()));
                Some(format!(
                    concat!(
                        "Another agent session in this folder — {who} — is working on {id} in ",
                        "its current turn and wrote it before you did. Your write went through. ",
                        "The file may not still say what you last read, and whoever is reading ",
                        "this transcript may not know both of you are editing it."
                    ),
                    who = who,
                    id = id
                ))
            }
            _ => None,
        };
        let mine = state.turn.get(session).copied().unwrap_or_default();
        state.wrote.insert(key.clone(), (session.to_string(), mine));
        state.seq += 1;
        let now = state.seq;
        state.last.insert((key.0, session.to_string()), now);
        note
    }

    /// Where in the order of writes we are, for a checkpoint about to be taken.
    fn mark(&self) -> u64 {
        self.0.lock().unwrap().seq
    }

    /// A checkpoint was taken, at the point in the order of writes `mark` gave.
    ///
    /// **The mark is taken before the snapshot, not after**, and that is the whole
    /// reason it is a separate call: `git stash create` walks the tree and takes
    /// real time, and a write that lands while it runs would otherwise be counted
    /// as having happened *before* the checkpoint — so undo would revert it with
    /// no warning, which is the exact failure ticket 52 exists to prevent.
    fn checkpoint_taken(&self, root: &Path, sha: &str, session: Option<&str>, at: u64) {
        // A checkpoint with no session is not a turn's, and nothing asks about it.
        if session.is_none() {
            return;
        }
        self.0
            .lock()
            .unwrap()
            .checkpoints
            .insert(sha.to_string(), (root.to_path_buf(), at));
    }

    /// Which *other* sessions have written in that root since this checkpoint.
    ///
    /// **The question undo has to ask before it runs** — ticket 52. A checkpoint
    /// captures the whole working tree, so restoring one taken before another
    /// conversation's edits reverts those edits too, and puts the tree into a
    /// state neither conversation was ever in. This is what lets the confirmation
    /// say so, and say whose work it is.
    ///
    /// An empty list is the ordinary case, and it is what makes an uncontended
    /// undo behave exactly as it did before any of this existed.
    fn contention(&self, sha: &str, session: Option<&str>) -> Vec<String> {
        let state = self.0.lock().unwrap();
        let Some((root, taken)) = state.checkpoints.get(sha) else {
            // A checkpoint from a previous run of the app. Nothing is known about
            // what has happened since, and inventing a warning would be worse than
            // the silence — the tree is the user's own to inspect.
            return Vec::new();
        };
        let mut who: Vec<String> = state
            .last
            .iter()
            .filter(|((other_root, other), at)| {
                other_root == root && Some(other.as_str()) != session && *at > taken
            })
            .map(|((_, other), _)| {
                state
                    .label
                    .get(other)
                    .cloned()
                    .unwrap_or_else(|| "another session".to_string())
            })
            .collect();
        who.sort();
        who.dedup();
        who
    }
}

/// Which other sessions' work an undo of this checkpoint would also revert.
///
/// Never fails and never refuses: it answers a question, and the answer to it is
/// a sentence in a confirmation. See `Writers::contention`.
#[tauri::command]
pub fn checkpoint_contention(
    sha: String,
    session: Option<String>,
    writers: tauri::State<'_, Writers>,
) -> Vec<String> {
    writers.contention(&sha, session.as_deref())
}

/// Where in the order of writes to this folder we are. Read before a snapshot.
pub(crate) fn write_mark(writers: &Writers) -> u64 {
    writers.mark()
}

/// A checkpoint was taken in this root. Called by `git_checkpoint`.
pub(crate) fn checkpoint_taken(
    writers: &Writers,
    root: &Path,
    sha: &str,
    session: Option<&str>,
    at: u64,
) {
    writers.checkpoint_taken(root, sha, session, at);
}

/// A turn is beginning. Called by `git_checkpoint`, which is where one does.
pub(crate) fn turn_begins(writers: &Writers, session: Option<&str>) {
    if let Some(id) = session {
        writers.turn_begins(id);
    }
}

/// Tell Rust what the window calls a session, so a warning can name it.
///
/// A session has no name until its first prompt, which is why this is its own
/// command rather than an argument to `create_agent_session`.
#[tauri::command]
pub fn label_agent_session(session: String, label: String, writers: tauri::State<'_, Writers>) {
    writers.name(&session, &label);
}

/// Which root an agent command is against: its session's, or the current one.
///
/// `None` is the workbench's own reads — the explorer, the editor, search — which
/// belong to whichever root is focused and always did. Only the agent passes an
/// id, and once it does, nothing about which folder is focused can move it.
pub(crate) fn agent_root(
    state: &WorkspaceState,
    roots: &SessionRoots,
    session: Option<&str>,
) -> Result<PathBuf, String> {
    match session {
        Some(id) => roots.root(id),
        None => root_of(state),
    }
}

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
    resolve_within(root, id, Some(MAX_FILE_BYTES))
}

/// The same, with the size cap made a parameter.
///
/// Exists for `read_text_lines`, which is the one reader that must be allowed
/// past 2 MiB — a session transcript grows without bound and refusing to read it
/// back would lose the conversation. It used to make its own containment
/// argument and made three quarters of it: the component scan and the symlink
/// and regular-file checks, but **not** the canonicalised `starts_with`. So a
/// symlinked *directory* on the way down was followed, where every other path
/// command in this file refuses it.
///
/// Reachable only through ids the session repo builds, and an agent with a shell
/// can read outside the root anyway (ticket 02), so this was a consistency hole
/// rather than a live escape. It is closed by inheriting the argument instead of
/// writing the missing quarter a second time — one containment rule, one place.
fn resolve_within(root: &Path, id: &str, max_bytes: Option<u64>) -> Result<PathBuf, String> {
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
    if max_bytes.is_some_and(|cap| meta.len() > cap) {
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

/// The virtual directory that the global skills folder appears at.
///
/// **This is the second thing this app reads from outside the workspace root**,
/// and the first that a *tool* can reach. `profiles.rs` opens one fixed file for
/// the app itself; this opens one fixed directory for the agent, because a skill
/// is only useful if the model can read it — see decision 4 of
/// `docs/wayfinder/pi-harness/tickets/20-skills.md`.
///
/// It is a **mount, not an escape**. The renderer still names files by
/// root-relative id and still never learns an OS path; ids beginning `.skills/`
/// land under the global skills directory instead of under the root, and
/// everything else about the policy is unchanged — no `..`, no symlinks, files
/// only, 2 MiB. The prefix is fixed here, so the renderer cannot widen it.
///
/// **Read-only.** `may_write` refuses the prefix outright, so this grants the
/// agent no way to author or alter a skill. Skills are hand-written, like
/// profiles, and for the same reason: a skill the agent can rewrite is a system
/// prompt the agent can rewrite.
const SKILLS_MOUNT: &str = ".skills";

/// The part of an id that is under the mount, if it is under the mount at all.
///
/// `.skills` alone is the directory itself, which `agent_list_dir` needs.
fn under_mount(id: &str) -> Option<&str> {
    let id = id.trim_start_matches('/');
    match id.strip_prefix(SKILLS_MOUNT) {
        Some("") => Some(""),
        Some(rest) => rest.strip_prefix('/'),
        None => None,
    }
}

fn global_skills_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|dir| dir.join("skills"))
        .map_err(|e| e.to_string())
}

/// Which directory an id is read from, and what is left of the id.
///
/// The one place the mount is applied. Every read command goes through it and
/// no write command does, which is what makes "read-only" a property of the
/// code rather than of a comment.
fn read_base(
    app: &tauri::AppHandle,
    root: &Path,
    id: &str,
) -> Result<(PathBuf, String), String> {
    match under_mount(id) {
        Some(rest) => {
            let dir = global_skills_dir(app)?;
            // Canonicalised for the same reason `adopt` canonicalises the root,
            // and missing it is what broke the first build of this: `resolve`
            // confines by `starts_with`, so a base in one shape and a resolved
            // path in another makes every file under the mount look like an
            // escape. A directory that does not exist yet is left as-is — the
            // callers all fail on it anyway, with a better message.
            Ok((canonical(&dir).unwrap_or(dir), rest.to_string()))
        }
        None => Ok((root.to_path_buf(), id.to_string())),
    }
}

/// Where the global skills go, so `/skills` can say it.
///
/// Same argument as `global_profiles_path`: a directory nobody names is a
/// directory nobody uses.
#[tauri::command]
pub fn global_skills_path(app: tauri::AppHandle) -> Result<String, String> {
    global_skills_dir(&app).map(|path| path.display().to_string())
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

/// How a root is named to the renderer: its folder name and its path.
///
/// Naming is all this is. The renderer has always been *shown* paths — the
/// breadcrumb is one — and the boundary 0001 drew is about which paths it may
/// *name back*, which is still none.
fn info_of(root: &Path) -> WorkspaceInfo {
    WorkspaceInfo {
        label: root
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| root.display().to_string()),
        path: root.display().to_string(),
    }
}

/// Adopt a directory as the workspace root. The only place a root is ever set.
fn adopt(path: &Path, state: &WorkspaceState) -> Result<WorkspaceInfo, String> {
    let root = canonical(path).map_err(|e| e.to_string())?;
    if !root.is_dir() {
        return Err("not a directory".into());
    }
    let info = info_of(&root);
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

/// Where the recent-roots list lives, one canonical path per line.
fn recents_file(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|dir| dir.join("recent-workspaces"))
        .map_err(|e| e.to_string())
}

/// How many roots the list holds. Small on purpose: it is a switcher, not a
/// history, and every entry is a folder this app has been given authority over.
const MAX_RECENTS: usize = 8;

fn read_recents(app: &tauri::AppHandle) -> Vec<String> {
    let Ok(file) = recents_file(app) else {
        return Vec::new();
    };
    fs::read_to_string(file)
        .unwrap_or_default()
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(str::to_string)
        .collect()
}

/// Write the record `restore_workspace` reads back, and push the root onto the
/// recent list that `switch_workspace` indexes into.
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

    // Most recent first, no duplicates, capped.
    let mut recents = read_recents(app);
    recents.retain(|entry| entry != path);
    recents.insert(0, path.to_string());
    recents.truncate(MAX_RECENTS);
    if let Ok(list) = recents_file(app) {
        let _ = fs::write(list, recents.join("\n"));
    }
}

/// The roots this app has already been given, most recent first.
#[tauri::command]
pub fn recent_workspaces(app: tauri::AppHandle) -> Result<Vec<WorkspaceInfo>, String> {
    Ok(read_recents(&app)
        .into_iter()
        .map(|path| {
            let label = Path::new(&path)
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_else(|| path.clone());
            WorkspaceInfo { label, path }
        })
        .collect())
}

/// A root from the recent list, named by its index in that list.
///
/// Split out from `read_root` so the index arithmetic is testable without an
/// `AppHandle`: the interesting failure is an index that names nothing, and a
/// command that returned the *current* root for it would read one workspace
/// while the caller believed it was reading another.
fn recent_root(recents: &[String], index: usize) -> Result<PathBuf, String> {
    let path = recents
        .get(index)
        .ok_or_else(|| "no such recent workspace".to_string())?;
    canonical(Path::new(path)).map_err(|e| e.to_string())
}

/// Which root a read is against: the current one, or a recent one by index.
///
/// **This is the second root a command may touch, and it is deliberately
/// read-only and index-only.** The authority argument is `switch_workspace`'s,
/// unchanged: an index can only name a folder the user has already handed this
/// app through an OS dialog, and the renderer could reach every byte under it
/// by switching there anyway. Reading a session list without throwing away the
/// window's own state is the same authority spent more cheaply.
///
/// It grants nothing to the *agent*, either. `ExecutionEnv` passes no index, so
/// every path a tool names still resolves against the one current root — the
/// parameter is reachable only from the navigator's own calls.
///
/// Containment is unaffected: whatever base comes back here goes through the
/// same `resolve_within` / `contained` scan as the current root does.
fn read_root(
    app: &tauri::AppHandle,
    state: &tauri::State<'_, WorkspaceState>,
    workspace: Option<usize>,
) -> Result<PathBuf, String> {
    match workspace {
        None => root_of(state),
        Some(index) => recent_root(&read_recents(app), index),
    }
}

/// The root a *read* is against, now that a session may name one.
///
/// Three answers, in the order of who is asking: the session's root when the
/// agent asks, a recent root when the navigator asks by index, and the current
/// root when the workbench asks. The three never blend — a session id that has
/// gone stale is refused here rather than falling through to either of the
/// others, which is the whole point of the table.
fn read_root_for(
    app: &tauri::AppHandle,
    state: &tauri::State<'_, WorkspaceState>,
    roots: &tauri::State<'_, SessionRoots>,
    session: Option<&str>,
    workspace: Option<usize>,
) -> Result<PathBuf, String> {
    match session {
        Some(id) => roots.root(id),
        None => read_root(app, state, workspace),
    }
}

/// A session's id, and the root it was born in.
///
/// The root is here because the window has to draw it: ticket 49 lists live
/// sessions under their own workspace group, and a group needs a name. It is the
/// same `WorkspaceInfo` the recents list already hands over.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSessionInfo {
    id: String,
    root: WorkspaceInfo,
}

/// Register a root for a new session, and hand back the id it is known by.
///
/// The root comes from exactly where a root has always come from: the current
/// one, or an index into the recents list. No path crosses this boundary, so
/// this grants the renderer nothing that `switch_workspace` did not already.
#[tauri::command]
pub fn create_agent_session(
    workspace: Option<usize>,
    app: tauri::AppHandle,
    state: tauri::State<'_, WorkspaceState>,
    roots: tauri::State<'_, SessionRoots>,
) -> Result<AgentSessionInfo, String> {
    let root = read_root(&app, &state, workspace)?;
    Ok(AgentSessionInfo {
        root: info_of(&root),
        id: roots.register(root),
    })
}

/// Make the workbench's current root this session's root — ticket 49.
///
/// **The third door into `adopt`, and the narrowest of the three.** It takes a
/// session id rather than a path or an index, so it can only ever reach a root
/// that is already registered — which means a root this app was already given
/// through a dialog or the recents list. An unknown id is refused, exactly as it
/// is everywhere else the table is consulted.
///
/// The session's own confinement is untouched by this and by everything else:
/// its root was fixed at birth. What moves is the *workbench's* root, which is
/// what "the explorer shows the folder the visible conversation is in" means.
#[tauri::command]
pub fn focus_agent_session(
    session: String,
    state: tauri::State<'_, WorkspaceState>,
    roots: tauri::State<'_, SessionRoots>,
) -> Result<WorkspaceInfo, String> {
    let root = roots.root(&session)?;
    /*
     * **Not remembered, and that is a bug this had.** `remember` reorders the
     * recent list, and the renderer names a root by its *index* into that list —
     * so a focus change halfway through reopening a set of sessions moved the
     * folder every remaining index pointed at, and a conversation came back in
     * the wrong one. Focusing is not choosing: the list only moves when a root is
     * chosen or switched to, which is what it always meant.
     */
    adopt(&root, &state)
}

/// Forget a session's root. Safe to call for an id that is already gone.
///
/// Every command that took the id starts refusing from here on, which is what
/// makes "closed" mean something on this side rather than only in the window.
#[tauri::command]
pub fn close_agent_session(
    session: String,
    roots: tauri::State<'_, SessionRoots>,
    writers: tauri::State<'_, Writers>,
) {
    roots.forget(&session);
    // Its turn is over by definition, so it stops warning anyone from here on.
    writers.closed(&session);
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

/// Off the dispatcher, for work whose size is the workspace's rather than ours.
///
/// **Synchronous commands are serialised, and that is what this avoids.**
/// Measured in the native window: `agent_shell` answers in 2ms alone and in
/// 583ms when issued during a `search_workspace` — it waits for the search. The
/// window keeps painting throughout (38 frames in 635ms, the same as idle), so
/// this is not a frozen UI; it is every *other* command being unable to answer.
/// On this repo a search is 635ms. On a monorepo it is seconds, and for those
/// seconds no file read, no git call and no agent tool can get through.
///
/// Applied to the three whose cost is unbounded — the two tree walks and the
/// delete count. The rest are a stat or a `git` invocation and are left alone
/// deliberately: an `async` command that does nothing slow buys nothing and
/// costs a thread hop.
async fn off_thread<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn list_tree(state: tauri::State<'_, WorkspaceState>) -> Result<Vec<Entry>, String> {
    // The root is read out here, before the hop: `State` is borrowed from the
    // command and cannot cross an await, where a `PathBuf` is owned and can.
    let root = root_of(&state)?;
    off_thread(move || {
        let mut out = Vec::new();
        walk(&root, "", 0, &mut out);
        Ok(out)
    })
    .await
}

#[tauri::command]
pub fn read_file(
    id: String,
    session: Option<String>,
    workspace: Option<usize>,
    app: tauri::AppHandle,
    state: tauri::State<'_, WorkspaceState>,
    roots: tauri::State<'_, SessionRoots>,
) -> Result<String, String> {
    let root = read_root_for(&app, &state, &roots, session.as_deref(), workspace)?;
    let (base, rest) = read_base(&app, &root, &id)?;
    let path = resolve(&base, &rest)?;
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
    session: Option<String>,
    workspace: Option<usize>,
    app: tauri::AppHandle,
    state: tauri::State<'_, WorkspaceState>,
    roots: tauri::State<'_, SessionRoots>,
) -> Result<Option<PathMeta>, String> {
    let root = read_root_for(&app, &state, &roots, session.as_deref(), workspace)?;
    let (base, rest) = read_base(&app, &root, &id)?;
    let candidate = Path::new(&rest);
    if candidate
        .components()
        .any(|c| !matches!(c, Component::Normal(_)))
    {
        return Err("invalid path".into());
    }

    let Ok(meta) = fs::symlink_metadata(base.join(candidate)) else {
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

/// Root-relative paths the agent may not write, whatever the gate decided.
///
/// One entry: the project's own profiles file. A profile is the *trust act* —
/// ticket 13 settled that a tool is trusted by being in one, and ticket 03 made
/// `gatePolicy` a profile field — so an agent that can rewrite its own profile
/// can grant itself tools and turn the gate off. The floor has to hold that,
/// because everything above it is configuration the profile itself supplies.
///
/// Lowercased and forward-slashed before comparison. This is a foot-gun guard of
/// the same kind as the exec deny list, hardened one notch: it stops the direct
/// write, but an agent with a shell can still reach the file, and only ticket
/// 02's confinement bounds that.
const AGENT_PROTECTED: [&str; 1] = ["ade.profiles.json"];

/// The project skills directory, protected on the same argument.
///
/// A prefix rather than a fixed name, because a skill is a directory tree. Added
/// after review pointed out that the mount was made read-only to stop the agent
/// rewriting its own system prompt — and the *project* half had exactly the same
/// hole: a profile permits `deploy`, the agent writes
/// `.agents/skills/deploy/SKILL.md`, and after the next `/reload` its own prose
/// is in `<available_skills>` and is what `/skill deploy` runs. Project skills
/// beat global ones, so it does not even need the name to be free.
///
/// Skills are configuration in the sense `ade.profiles.json` is, and the rule is
/// already written down for that file: the agent may not write the things that
/// decide what the agent does.
///
/// `.agents/commands` joins it on exactly that rule. A prompt template is a file
/// whose body becomes the prompt when the user types its name, so an agent that
/// can write one can write the instructions it will later be given — and the
/// user typing `/deploy` is what makes it run, which is the trust act templates
/// have instead of a profile field.
const AGENT_PROTECTED_TREES: [&str; 2] = [".agents/skills/", ".agents/commands/"];

/// One spelling of a root-relative id.
///
/// Ids arrive as `src/a.ts`, `src\a.ts` or `/src/a.ts` depending on which tool
/// built them, and on Windows in whatever case the model happened to type. Every
/// comparison that treats an id as an *identity* — what may not be written, and
/// who wrote it last — goes through here, so three spellings are one file.
fn normal(id: &str) -> String {
    id.replace('\\', "/").trim_start_matches('/').to_lowercase()
}

fn agent_may_write(id: &str) -> Result<(), String> {
    let normalised = normal(id);
    if AGENT_PROTECTED.contains(&normalised.as_str()) {
        return Err("refusing to write the agent's own profile file".into());
    }
    for tree in AGENT_PROTECTED_TREES {
        // The directory itself as well as everything under it: `trim_end_matches`
        // is what makes `.agents/skills` and `.agents/skills/` the same refusal.
        if normalised.starts_with(tree) || normalised == tree.trim_end_matches('/') {
            return Err(
                "refusing to write that: it decides what the agent is told".into(),
            );
        }
    }
    may_write(&normalised)
}

/// The mount is read-only, for everyone.
///
/// Checked separately from `AGENT_PROTECTED` because it binds the *editor* too.
/// Reads under `.skills` come from the global skills directory and writes would
/// go to `<root>/.skills` — a different real file with the same id. That shadow
/// is worse than refusing: someone would open a global skill, edit it, save it,
/// and see no change.
fn may_write(id: &str) -> Result<(), String> {
    if under_mount(&id.replace('\\', "/")).is_some() {
        return Err("the global skills directory is read-only".into());
    }
    Ok(())
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
    session: Option<String>,
    state: tauri::State<'_, WorkspaceState>,
    roots: tauri::State<'_, SessionRoots>,
    writers: tauri::State<'_, Writers>,
) -> Result<Option<String>, String> {
    use std::io::Write;

    let root = agent_root(&state, &roots, session.as_deref())?;
    agent_may_write(&id)?;
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
    file.write_all(content.as_bytes()).map_err(|e| e.to_string())?;
    Ok(writers.wrote(&root, &id, session.as_deref()))
}

/// Create a directory and its parents.
#[tauri::command]
pub fn agent_create_dir(
    id: String,
    session: Option<String>,
    state: tauri::State<'_, WorkspaceState>,
    roots: tauri::State<'_, SessionRoots>,
) -> Result<(), String> {
    let root = agent_root(&state, &roots, session.as_deref())?;
    // `agent_may_write`, not `may_write`: this was the one agent write path that
    // skipped `AGENT_PROTECTED`, so `mkdir ade.profiles.json` would make the
    // profiles file uncreatable.
    agent_may_write(&id)?;
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
    session: Option<String>,
    workspace: Option<usize>,
    app: tauri::AppHandle,
    state: tauri::State<'_, WorkspaceState>,
    roots: tauri::State<'_, SessionRoots>,
) -> Result<Vec<PathMeta>, String> {
    let root = read_root_for(&app, &state, &roots, session.as_deref(), workspace)?;
    let (base, rest) = read_base(&app, &root, &id)?;
    let target = contained(&base, &rest)?;

    // `contained` refuses `..` but does not canonicalise, and `read_dir` follows a
    // symlinked *directory* — so without this, listing `.skills/link` would hand
    // back the file names of wherever `link` points. Only the names: `resolve`
    // still refuses to read them. Checked here rather than in `contained`,
    // because every other caller creates the path it is asking about.
    if let Ok(real) = canonical(&target) {
        if !real.starts_with(&base) {
            return Err("path escapes the workspace".into());
        }
    }

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
/// Separate from `read_file` because that one caps at 2 MiB — and the session
/// transcript is exactly the file that will pass 2 MiB in a long conversation.
/// Reading it back line by line also keeps a large session out of the renderer's
/// memory in one lump.
///
/// **The cap is the only thing it relaxes.** `resolve_within` with no cap is the
/// same containment argument `resolve` makes, canonicalisation included, which is
/// the part this command used to be missing.
#[tauri::command]
pub fn read_text_lines(
    id: String,
    max_lines: Option<usize>,
    session: Option<String>,
    workspace: Option<usize>,
    app: tauri::AppHandle,
    state: tauri::State<'_, WorkspaceState>,
    roots: tauri::State<'_, SessionRoots>,
) -> Result<Vec<String>, String> {
    use std::io::{BufRead, BufReader};

    let root = read_root_for(&app, &state, &roots, session.as_deref(), workspace)?;
    let target = resolve_within(&root, &id, None)?;

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
    session: Option<String>,
    state: tauri::State<'_, WorkspaceState>,
    roots: tauri::State<'_, SessionRoots>,
    writers: tauri::State<'_, Writers>,
) -> Result<Option<String>, String> {
    let root = agent_root(&state, &roots, session.as_deref())?;
    agent_may_write(&id)?;
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

    fs::write(&target, content).map_err(|e| e.to_string())?;
    // After the write, always: the note is a note, never a refusal — ticket 51.
    Ok(writers.wrote(&root, &id, session.as_deref()))
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
    may_write(&id)?;
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
pub async fn search_workspace(
    query: String,
    state: tauri::State<'_, WorkspaceState>,
) -> Result<Vec<SearchResult>, String> {
    let root = root_of(&state)?;
    off_thread(move || search_in(&root, &query)).await
}

/// The search itself. A free function so the command above is only the hop.
fn search_in(root: &Path, query: &str) -> Result<Vec<SearchResult>, String> {
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

// ---------------------------------------------------------------------------
// What the person in front of the window may do to the tree — ticket 29.
//
// Rust already exposed `agent_write_file`, `agent_append_file` and
// `agent_create_dir` and nothing at all for rename or delete, so **the agent
// could create files the human could not**. That was an omission rather than a
// posture, and these four commands close it.
//
// They use `may_write`, not `agent_may_write`. The difference is deliberate and
// is the whole reason the two functions exist separately: `ade.profiles.json`
// and `.agents/skills` are protected from the *agent* because an agent that can
// rewrite what it is told can grant itself anything. The human is the one who
// writes those files. What binds both is `contained` plus a canonicalised
// parent, which is the real boundary and is enforced here the same way.
// ---------------------------------------------------------------------------

/// Stop counting a directory here. A confirmation needs an order of magnitude,
/// not an exact figure, and a `node_modules` under the cursor should not make
/// the dialog wait on a full walk.
const MAX_COUNT: u64 = 10_000;

/// Where an entry that **already exists** lives, with the escape closed.
///
/// Neither `resolve` nor `writable_parent` fits: `resolve` requires a regular
/// file and the explorer renames and deletes directories too, and
/// `writable_parent` creates the parent, which is wrong for an operation whose
/// whole premise is that the path is already there.
///
/// Symlinks are refused rather than followed, as everywhere else here. Renaming
/// a link is harmless, but *deleting* one is the case where following it and
/// not following it differ by an entire directory tree, so the rule is stated
/// once for both.
fn existing(root: &Path, id: &str) -> Result<PathBuf, String> {
    if id.trim().is_empty() {
        // `contained(root, "")` is the root itself, and the root is not the
        // explorer's to rename or delete.
        return Err("that is the workspace itself".into());
    }
    let target = contained(root, id)?;
    let parent = target.parent().ok_or_else(|| "invalid path".to_string())?;
    let real_parent = canonical(parent).map_err(|_| "not found".to_string())?;
    if !real_parent.starts_with(root) {
        return Err("path escapes the workspace".into());
    }
    let meta = fs::symlink_metadata(&target).map_err(|_| "not found".to_string())?;
    if meta.file_type().is_symlink() {
        return Err("symlinks are not supported".into());
    }
    let name = target.file_name().ok_or_else(|| "invalid path".to_string())?;
    Ok(real_parent.join(name))
}

/// A name that may be created: contained, not taken, and inside the root.
fn creatable(root: &Path, id: &str) -> Result<PathBuf, String> {
    if id.trim().is_empty() {
        return Err("give it a name".into());
    }
    let target = contained(root, id)?;
    if fs::symlink_metadata(&target).is_ok() {
        return Err("something with that name is already there".into());
    }
    Ok(target)
}

/// Create an empty file.
///
/// `create_new`, so this can only ever bring a path into existence — two
/// windows racing on the same name must not end with one of them silently
/// truncating a file the other just wrote.
#[tauri::command]
pub fn create_file(id: String, state: tauri::State<'_, WorkspaceState>) -> Result<(), String> {
    let root = root_of(&state)?;
    may_write(&id)?;
    let target = creatable(&root, &id)?;
    writable_parent(&root, &target)?;
    fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&target)
        .map(|_| ())
        .map_err(|e| e.to_string())
}

/// Create a directory.
#[tauri::command]
pub fn create_folder(id: String, state: tauri::State<'_, WorkspaceState>) -> Result<(), String> {
    let root = root_of(&state)?;
    may_write(&id)?;
    let target = creatable(&root, &id)?;
    fs::create_dir_all(&target).map_err(|e| e.to_string())?;
    // Canonicalise the directory itself rather than its parent — it is the
    // thing created, and a symlinked ancestor would otherwise pass. Same
    // argument as `agent_create_dir`.
    let real = canonical(&target).map_err(|e| e.to_string())?;
    if !real.starts_with(&root) {
        return Err("refusing to create outside the workspace".into());
    }
    Ok(())
}

/// Move an entry to another root-relative id.
///
/// Both ends are checked, and for different reasons: the source has to exist
/// inside the root, and the destination has to be somewhere the renderer is
/// allowed to put things. Renaming *into* `.skills` would otherwise be a way to
/// write a read-only mount by the back door.
#[tauri::command]
pub fn rename_entry(
    from: String,
    to: String,
    state: tauri::State<'_, WorkspaceState>,
) -> Result<(), String> {
    let root = root_of(&state)?;
    may_write(&from)?;
    may_write(&to)?;
    let source = existing(&root, &from)?;
    if to.trim().is_empty() {
        return Err("give it a name".into());
    }
    let target = contained(&root, &to)?;

    /*
     * Changing only the case of a name is a rename, not a collision — but on a
     * case-insensitive filesystem the destination "already exists", because it
     * is the source. Canonicalising is what tells the two apart: it reports the
     * casing actually on disk, so a real collision resolves to some other path
     * and `Foo.ts` → `foo.ts` resolves right back to where it started.
     */
    let same_entry = canonical(&target).ok().as_deref() == Some(source.as_path());
    if !same_entry && fs::symlink_metadata(&target).is_ok() {
        return Err("something with that name is already there".into());
    }
    writable_parent(&root, &target)?;
    fs::rename(&source, &target).map_err(|e| e.to_string())
}

/// What a delete would take, so the confirmation can say it before it happens.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeletePlan {
    /// `"file"` or `"directory"`.
    kind: String,
    /// Entries underneath, directories included. Zero for a file.
    entries: u64,
    /// The walk hit `MAX_COUNT` — `entries` is a floor, not a total.
    capped: bool,
}

/// Everything under `dir`, counted without the tree walk's exclusions.
///
/// `walk` deliberately skips `node_modules` and friends because it is building
/// a view of the project. This is answering "what is about to be destroyed", and
/// a count that hides the largest directory in the tree would be the one number
/// in this dialog that must not be reassuring.
fn count_under(dir: &Path, total: &mut u64) {
    let Ok(read) = fs::read_dir(dir) else { return };
    for entry in read.flatten() {
        if *total >= MAX_COUNT {
            return;
        }
        *total += 1;
        // `file_type` rather than `metadata`: it does not follow a symlink, and
        // neither will the delete.
        if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            count_under(&entry.path(), total);
        }
    }
}

/// What `delete_entry` would remove. Reads only.
#[tauri::command]
pub async fn delete_plan(
    id: String,
    state: tauri::State<'_, WorkspaceState>,
) -> Result<DeletePlan, String> {
    let root = root_of(&state)?;
    // Checked here as well as in `delete_entry`, even though this only reads: a
    // path that cannot be deleted should be refused before the confirmation
    // appears, not after someone has agreed to it.
    //
    // Both of these stay *before* the hop, so a refusal is still immediate and
    // does not cost a thread. Only the counting walk goes off-thread, which is
    // the part whose size is the user's directory rather than ours.
    may_write(&id)?;
    let target = existing(&root, &id)?;
    if !target.is_dir() {
        return Ok(DeletePlan {
            kind: "file".into(),
            entries: 0,
            capped: false,
        });
    }
    off_thread(move || {
        let mut entries = 0;
        count_under(&target, &mut entries);
        Ok(DeletePlan {
            kind: "directory".into(),
            entries,
            capped: entries >= MAX_COUNT,
        })
    })
    .await
}

/// Move an entry to the OS trash.
///
/// **Trash, not unlink.** Ticket 29 asked for recoverable over confirmed, and a
/// confirmation is only as good as the attention of the person clicking it — a
/// delete that took a directory is otherwise the one action in this app with no
/// way back. `git` is not the answer here either: the files most likely to be
/// lost are the ones never committed.
#[tauri::command]
pub fn delete_entry(id: String, state: tauri::State<'_, WorkspaceState>) -> Result<(), String> {
    let root = root_of(&state)?;
    may_write(&id)?;
    let target = existing(&root, &id)?;
    trash::delete(&target).map_err(|e| format!("could not move it to the trash: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The whole of ticket 46 in one test: two roots resolving at the same
    /// instant, and a stale id that falls back to *nothing*.
    ///
    /// The fallback is the part worth asserting. An id that resolved to the
    /// current root when the table did not know it would put one session's
    /// writes into another session's folder — silently, and only when a switch
    /// happened to be in flight, which is the class of bug that made confinement
    /// per-session in the first place.
    #[test]
    fn a_session_resolves_to_the_root_it_was_born_in() {
        let roots = SessionRoots::default();
        let a = canonical(&std::env::temp_dir()).unwrap();
        let b = a.join("nested-does-not-need-to-exist");

        let first = roots.register(a.clone());
        let second = roots.register(b.clone());
        assert_ne!(first, second, "two sessions are never the same session");

        // No ordering between them: both answer, and neither disturbs the other.
        assert_eq!(roots.root(&first).unwrap(), a);
        assert_eq!(roots.root(&second).unwrap(), b);
        assert_eq!(roots.root(&first).unwrap(), a);

        assert!(roots.root("session-never-minted").is_err());

        roots.forget(&first);
        assert!(
            roots.root(&first).is_err(),
            "a closed session is refused, not resolved against whatever is focused"
        );
        assert_eq!(roots.root(&second).unwrap(), b, "closing one keeps the other");
    }

    /// `None` is the workbench, and only the workbench.
    ///
    /// Asserted through `agent_root` rather than the table alone, because the
    /// branch is where the two authorities meet: the explorer's reads follow the
    /// focused root, and an agent's never do.
    #[test]
    fn only_a_sessionless_command_follows_the_focused_root() {
        let roots = SessionRoots::default();
        let state = WorkspaceState::default();
        let here = canonical(&std::env::temp_dir()).unwrap();
        *state.0.lock().unwrap() = Some(here.clone());

        assert_eq!(agent_root(&state, &roots, None).unwrap(), here);

        let elsewhere = here.join("somewhere-else");
        let id = roots.register(elsewhere.clone());
        assert_eq!(agent_root(&state, &roots, Some(&id)).unwrap(), elsewhere);
        assert!(agent_root(&state, &roots, Some("session-gone")).is_err());
    }

    /// Ticket 51, all six of its rules in one place.
    ///
    /// Written against `Writers` directly rather than through the commands,
    /// because what is interesting is entirely the bookkeeping — the write itself
    /// is `fs::write` and is never affected by any of this.
    #[test]
    fn the_second_session_to_write_a_file_is_told_about_the_first() {
        let writers = Writers::default();
        let root = PathBuf::from("/tmp/one");
        let other = PathBuf::from("/tmp/two");
        writers.name("session-0", "Fix the sash");
        writers.turn_begins("session-0");
        writers.turn_begins("session-1");

        // Nobody has touched it, so there is nothing to say.
        assert_eq!(writers.wrote(&root, "src/a.ts", Some("session-0")), None);

        let note = writers
            .wrote(&root, "src/a.ts", Some("session-1"))
            .expect("the second writer is told");
        // It names the other conversation and the file, which is what makes it
        // something the agent can act on rather than a warning light.
        assert!(note.contains("Fix the sash"), "{note}");
        assert!(note.contains("src/a.ts"), "{note}");

        // Once per file per session. A note on every write is a note nobody reads.
        assert_eq!(writers.wrote(&root, "src/a.ts", Some("session-1")), None);
        // One session writing its own file over and over is not a collision.
        assert_eq!(writers.wrote(&root, "src/b.ts", Some("session-1")), None);
        assert_eq!(writers.wrote(&root, "src/b.ts", Some("session-1")), None);

        // Two folders are two projects. Same path, different root, no warning.
        assert_eq!(writers.wrote(&root, "src/c.ts", Some("session-0")), None);
        assert_eq!(writers.wrote(&other, "src/c.ts", Some("session-1")), None);

        // "This turn", not "ever": once the writer has moved on to another turn,
        // the collision is history rather than news.
        assert_eq!(writers.wrote(&root, "src/d.ts", Some("session-0")), None);
        writers.turn_begins("session-0");
        assert_eq!(writers.wrote(&root, "src/d.ts", Some("session-1")), None);

        // A closed session warns nobody, for the same reason.
        assert_eq!(writers.wrote(&root, "src/e.ts", Some("session-0")), None);
        writers.closed("session-0");
        assert_eq!(writers.wrote(&root, "src/e.ts", Some("session-1")), None);

        // One file, however it was spelled. Three spellings in this map would be
        // three files that never collide, and the note would never fire.
        assert_eq!(writers.wrote(&root, "src/g.ts", Some("session-1")), None);
        assert!(writers.wrote(&root, r"\src\G.TS", Some("session-0")).is_some());

        // The workbench saving a file is not an agent, and the agent's own
        // transcript is not the user's project.
        writers.turn_begins("session-2");
        assert_eq!(writers.wrote(&root, "src/f.ts", None), None);
        assert_eq!(writers.wrote(&root, ".ade/sessions/x.jsonl", Some("session-2")), None);
        assert_eq!(writers.wrote(&root, ".ade/sessions/x.jsonl", Some("session-1")), None);
    }

    /// Ticket 52: what an undo would take with it, before it takes it.
    #[test]
    fn undo_knows_whose_work_it_would_also_revert() {
        let writers = Writers::default();
        let root = PathBuf::from("/tmp/one");
        let other = PathBuf::from("/tmp/two");
        writers.name("session-0", "Fix the sash");
        writers.name("session-1", "Chase a failing check");
        writers.turn_begins("session-0");
        writers.turn_begins("session-1");

        writers.wrote(&root, "src/a.ts", Some("session-0"));
        writers.checkpoint_taken(&root, "sha-quiet", Some("session-0"), writers.mark());
        // Nothing has happened since. This is the ordinary undo, and it must stay
        // exactly as silent as it was before ticket 52 existed.
        assert!(writers.contention("sha-quiet", Some("session-0")).is_empty());

        // The session's own later writes are its own business.
        writers.wrote(&root, "src/a.ts", Some("session-0"));
        assert!(writers.contention("sha-quiet", Some("session-0")).is_empty());

        // Another conversation writes in the same folder. Now the undo would take
        // that with it, and it is named rather than merely counted.
        writers.wrote(&root, "src/b.ts", Some("session-1"));
        assert_eq!(
            writers.contention("sha-quiet", Some("session-0")),
            vec!["Chase a failing check".to_string()]
        );

        // A folder is a repository. Work in another one is not in this tree.
        writers.checkpoint_taken(&other, "sha-elsewhere", Some("session-0"), writers.mark());
        writers.wrote(&root, "src/c.ts", Some("session-1"));
        assert!(writers.contention("sha-elsewhere", Some("session-0")).is_empty());

        /*
         * **The mark is taken before the snapshot.** A write that lands while
         * `git stash create` is walking the tree must count as *after* the
         * checkpoint, or undo reverts it with nothing said — which is the whole
         * failure this ticket exists to prevent.
         */
        let at = writers.mark();
        writers.wrote(&root, "src/slow.ts", Some("session-1"));
        writers.checkpoint_taken(&root, "sha-slow", Some("session-0"), at);
        assert_eq!(
            writers.contention("sha-slow", Some("session-0")),
            vec!["Chase a failing check".to_string()]
        );

        // A checkpoint from a previous run of the app: nothing is known about what
        // has happened since, and a warning invented from that would be a guess.
        assert!(writers.contention("sha-never-seen", Some("session-0")).is_empty());
    }

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

    /// An index that names nothing must fail, not fall back.
    ///
    /// The dangerous failure is not an error — it is a read that quietly answers
    /// from the *current* root while the navigator believes it is looking at
    /// another workspace, which would draw one root's sessions under another
    /// root's name and switch you somewhere you never chose.
    #[test]
    fn a_recent_root_is_the_one_the_index_names() {
        let real = canonical(&std::env::temp_dir()).unwrap();
        let recents = vec![
            "\\\\no\\such\\place".to_string(),
            real.display().to_string(),
        ];

        assert_eq!(recent_root(&recents, 1).unwrap(), real);
        assert!(recent_root(&recents, 2).is_err(), "past the end");
        assert!(recent_root(&[], 0).is_err(), "nothing to index");
        // A recorded root that has since been deleted or unmounted is an error
        // too: `canonical` is what proves it is still there.
        assert!(recent_root(&recents, 0).is_err(), "gone from disk");
    }

    /// The agent may not edit the file that decides what the agent may do.
    /// The agent may not author a skill or a command, for the reason the mount
    /// is read-only.
    ///
    /// A profile permits `deploy`; the agent writes `.agents/skills/deploy/SKILL.md`;
    /// after `/reload` its own prose is in the system prompt and is what
    /// `/skill deploy` runs. Project skills beat global ones, so the name does
    /// not even have to be free.
    #[test]
    fn agent_cannot_write_a_skill_or_command() {
        assert!(agent_may_write(".agents/notes.md").is_ok(), "only the two trees");
        assert!(agent_may_write("agents/skills/x/SKILL.md").is_ok(), "and only at the root");

        for spelling in [
            ".agents/skills",
            ".agents/skills/deploy/SKILL.md",
            "/.agents/skills/deploy/SKILL.md",
            r".agents\skills\deploy\SKILL.md",
            ".Agents/Skills/deploy/SKILL.md",
            // A prompt template is the same hole with fewer steps: the body of
            // the file becomes the prompt the moment the user types its name.
            ".agents/commands",
            ".agents/commands/deploy.md",
            "/.agents/commands/deploy.md",
        ] {
            assert!(
                agent_may_write(spelling).is_err(),
                "should have refused {spelling:?}"
            );
        }
    }

    #[test]
    fn agent_cannot_write_its_own_profiles() {
        assert!(agent_may_write("src/main.rs").is_ok());
        assert!(agent_may_write("docs/ade.profiles.json.md").is_ok());

        for spelling in [
            "ade.profiles.json",
            "/ade.profiles.json",
            "ADE.Profiles.json",
            r"\ade.profiles.json",
        ] {
            assert!(
                agent_may_write(spelling).is_err(),
                "should have refused {spelling:?}"
            );
        }
    }

    /// The mount is a prefix match on whole segments, not on characters.
    ///
    /// `.skillsets/x` starts with `.skills` as a string and must **not** be
    /// mounted, or a project directory would silently read from somewhere else.
    #[test]
    fn mount_matches_whole_segments_only() {
        assert_eq!(under_mount(".skills"), Some(""));
        assert_eq!(under_mount("/.skills"), Some(""));
        assert_eq!(under_mount(".skills/grilling/SKILL.md"), Some("grilling/SKILL.md"));

        for outside in [
            ".skillsets/x",
            ".skills-old/x",
            "src/.skills/x",
            "skills/x",
            ".agents/skills/x",
        ] {
            assert_eq!(under_mount(outside), None, "should not mount {outside:?}");
        }
    }

    /// Read-only, and it is the code that says so rather than a comment.
    ///
    /// The editor is bound too: reads under the mount come from the config
    /// directory and a write would land in `<root>/.skills`, so permitting one
    /// would create two files with one id.
    #[test]
    fn the_mount_refuses_every_write() {
        assert!(may_write("src/main.rs").is_ok());
        assert!(may_write(".agents/skills/mine/SKILL.md").is_ok());

        for spelling in [".skills", "/.skills", ".skills/mine/SKILL.md", r"\.skills\x"] {
            assert!(may_write(spelling).is_err(), "should have refused {spelling:?}");
            assert!(agent_may_write(spelling).is_err(), "and for the agent: {spelling:?}");
        }
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

    /// Lifting the size cap must not lift anything else.
    ///
    /// `read_text_lines` is the one reader allowed past 2 MiB, and it used to buy
    /// that by making its own containment argument — which omitted the
    /// canonicalised `starts_with`. This asserts the two halves separately: the
    /// cap is the only difference, and every escape `resolve` refuses is still
    /// refused with the cap off.
    #[test]
    fn lifting_the_cap_keeps_the_confinement() {
        let dir = std::env::temp_dir().join("ade-uncapped-test");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("sub")).unwrap();
        fs::write(dir.join("sub/small.txt"), "hi").unwrap();
        // One byte over, so `resolve` refuses it and the uncapped form does not.
        fs::write(dir.join("big.txt"), vec![b'x'; (MAX_FILE_BYTES + 1) as usize]).unwrap();
        fs::write(dir.join("../ade-uncapped-outside.txt"), "nope").unwrap();
        let root = canonical(&dir).unwrap();

        assert!(resolve(&root, "big.txt").is_err(), "the cap still applies to `resolve`");
        assert!(
            resolve_within(&root, "big.txt", None).is_ok(),
            "and a session transcript can still be read back"
        );
        assert!(resolve_within(&root, "sub/small.txt", None).is_ok());

        for escape in [
            "../ade-uncapped-outside.txt",
            "sub/../../ade-uncapped-outside.txt",
            "/etc/passwd",
            r"..\ade-uncapped-outside.txt",
        ] {
            assert!(
                resolve_within(&root, escape, None).is_err(),
                "uncapped took {escape:?}"
            );
        }
        // The two non-file cases the old body did check, so they cannot regress.
        assert!(resolve_within(&root, "sub", None).is_err(), "a directory is not a file");
        assert!(resolve_within(&root, "sub/gone.txt", None).is_err());

        let _ = fs::remove_dir_all(&dir);
        let _ = fs::remove_file(dir.join("../ade-uncapped-outside.txt"));
    }

    /// Ticket 29's criterion: rename and delete refuse a path outside the root.
    ///
    /// Asserted on `existing` and `creatable` rather than on the four commands,
    /// because those two are the only way any of them reaches a path — a command
    /// needs a `tauri::State` to construct, and testing through one would test
    /// Tauri's plumbing instead of the boundary. Every escape below is refused
    /// before anything touches the disk.
    #[test]
    fn rename_and_delete_cannot_leave_the_root() {
        let dir = std::env::temp_dir().join("ade-fileops-test");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("sub")).unwrap();
        fs::write(dir.join("sub/ok.txt"), "hi").unwrap();
        fs::write(dir.join("../ade-fileops-outside.txt"), "nope").unwrap();
        let root = canonical(&dir).unwrap();

        assert!(existing(&root, "sub/ok.txt").is_ok());
        assert!(existing(&root, "sub").is_ok(), "a directory is deletable too");

        for escape in [
            "../ade-fileops-outside.txt",
            "sub/../../ade-fileops-outside.txt",
            "/etc/passwd",
            r"..\ade-fileops-outside.txt",
        ] {
            assert!(existing(&root, escape).is_err(), "existing took {escape:?}");
            assert!(creatable(&root, escape).is_err(), "creatable took {escape:?}");
        }

        // The root is not the explorer's to rename or delete, and an empty id is
        // exactly what an unnamed row would send.
        assert!(existing(&root, "").is_err());
        assert!(existing(&root, "   ").is_err());
        assert!(creatable(&root, "").is_err());

        assert!(existing(&root, "sub/gone.txt").is_err(), "nothing to act on");
        assert!(creatable(&root, "sub/ok.txt").is_err(), "would clobber");
        assert!(creatable(&root, "sub/new.txt").is_ok());

        // A directory of two entries counts two, and a file has nothing under it.
        let mut total = 0;
        count_under(&root, &mut total);
        assert_eq!(total, 2, "sub, and the file in it");

        #[cfg(windows)]
        assert!(existing(&root, r"C:\Windows\System32\drivers\etc\hosts").is_err());

        let _ = fs::remove_dir_all(&dir);
        let _ = fs::remove_file(dir.join("../ade-fileops-outside.txt"));
    }
}
