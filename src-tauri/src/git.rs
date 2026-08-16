//! Git source control, always scoped to the selected workspace root.
//!
//! Every invocation goes through `git -C <root>` with a validated relative
//! path after a `--` separator, so an id from the frontend can neither become
//! a git option nor name a file outside the workspace.

use std::path::{Component, Path};
use std::process::Command;

use serde::Serialize;

use crate::workspace::{
    agent_root, checkpoint_taken, resolve, root_of, turn_begins, write_mark, SessionRoots,
    WorkspaceState, Writers,
};

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Change {
    /// Workspace-relative path — the same id space the Explorer uses.
    id: String,
    name: String,
    /// "added", "modified" or "deleted".
    status: &'static str,
    staged: bool,
    /// False where there is nothing to restore *from*: an untracked or newly
    /// added file has no HEAD version, so reverting it would mean deleting it,
    /// which this app does not do.
    revertable: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangeDiff {
    id: String,
    name: String,
    original: String,
    modified: String,
}

/// A git object id and nothing else.
///
/// The same trust boundary `relative` is, for the other kind of argument the
/// frontend supplies. A sha reaches git in a position where `--upload-pack=…`
/// or `-c` would be read as an option, and a ref name would let the frontend
/// choose a tree this app never took a checkpoint of.
fn object_id(sha: &str) -> Result<&str, String> {
    if sha.len() >= 7 && sha.len() <= 64 && sha.chars().all(|c| c.is_ascii_hexdigit()) {
        Ok(sha)
    } else {
        Err("invalid checkpoint".into())
    }
}

/// Ids arrive from the frontend, so this is a trust boundary: only plain
/// relative paths are ever handed to git.
fn relative(id: &str) -> Result<&str, String> {
    if Path::new(id)
        .components()
        .any(|c| !matches!(c, Component::Normal(_)))
    {
        return Err("invalid path".into());
    }
    Ok(id)
}

fn git(root: &Path, args: &[&str]) -> Result<String, String> {
    let mut command = Command::new("git");
    command.arg("-C").arg(root).args(args);
    #[cfg(windows)]
    {
        // Without this every git call flashes a console window over the app.
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let out = command
        .output()
        .map_err(|e| format!("git is not available: {e}"))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    String::from_utf8(out.stdout).map_err(|_| "git returned non-UTF-8 output".to_string())
}

fn basename(path: &str) -> String {
    path.rsplit('/').next().unwrap_or(path).to_string()
}

fn status_of(code: char) -> &'static str {
    match code {
        'A' | '?' => "added",
        'D' => "deleted",
        _ => "modified",
    }
}

/// Parse `git status --porcelain=v1 -z`.
///
/// Intentionally minimal, one row per path: a file that is staged *and* edited
/// again shows only its staged half, because the UI models a change as either
/// staged or not. `-z` is used so paths are never quoted or escaped and always
/// use forward slashes, matching the workspace id space exactly.
fn parse_status(raw: &str) -> Vec<Change> {
    let mut out = Vec::new();
    // `-z` terminates every field with NUL, leaving one trailing empty field.
    let mut fields = raw.split('\0').filter(|field| !field.is_empty());

    while let Some(entry) = fields.next() {
        let mut codes = entry.chars();
        let (Some(index), Some(worktree)) = (codes.next(), codes.next()) else {
            continue;
        };
        if index == 'R' || index == 'C' {
            // Renames and copies emit a second field with the original path,
            // which this model does not track. Consume it so it is not read as
            // the next entry.
            fields.next();
        }
        // The first three bytes are ASCII status codes and a space.
        let path = entry.get(3..).unwrap_or("");
        if path.is_empty() {
            continue;
        }
        let staged = index != ' ' && index != '?';
        out.push(Change {
            id: path.to_string(),
            name: basename(path),
            status: status_of(if staged { index } else { worktree }),
            staged,
            revertable: index != '?' && index != 'A',
        });
    }
    out
}

#[tauri::command]
pub fn git_changes(state: tauri::State<'_, WorkspaceState>) -> Result<Vec<Change>, String> {
    let root = root_of(&state)?;
    match git(
        &root,
        &["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    ) {
        Ok(raw) => Ok(parse_status(&raw)),
        // A workspace that is not a repository simply has no changes. Every
        // other failure — git missing, repository corrupt — is still reported.
        Err(e) if e.contains("not a git repository") => Ok(Vec::new()),
        Err(e) => Err(e),
    }
}

/// The current branch name, for the titlebar breadcrumb.
///
/// `None` rather than an error in the two cases that are not failures: the
/// workspace is not a repository, or HEAD is detached and there is no branch to
/// name. The breadcrumb shows the workspace alone in both, which is honest —
/// inventing "main" or "HEAD" would not be.
#[tauri::command]
pub fn git_branch(state: tauri::State<'_, WorkspaceState>) -> Result<Option<String>, String> {
    let root = root_of(&state)?;
    match git(&root, &["symbolic-ref", "--short", "HEAD"]) {
        Ok(raw) => {
            let name = raw.trim();
            Ok((!name.is_empty()).then(|| name.to_string()))
        }
        // Not a repository, or a detached HEAD, which `symbolic-ref` refuses.
        Err(_) => Ok(None),
    }
}

/// The working-tree side of a diff.
///
/// Only one failure is allowed to read as an empty file: the file is not there,
/// which is what a deleted file looks like and is the right answer. Every other
/// refusal `resolve` can give — outside the workspace, a symlink, over the size
/// cap — and every read failure is an error. Collapsing those into an empty
/// string renders a confinement refusal as a diff that deletes the whole file:
/// a plausible-looking answer to a question that was denied.
fn working_tree_side(root: &Path, path: &str) -> Result<String, String> {
    match resolve(root, path) {
        // Reported as-is: a read failure here is a permission problem or a
        // file that is not UTF-8, and neither is "the file is empty".
        Ok(file) => std::fs::read_to_string(file).map_err(|e| e.to_string()),
        Err(e) if e == "not found" => Ok(String::new()),
        Err(e) => Err(e),
    }
}

/// HEAD content against working-tree content.
///
/// An added file has no HEAD blob, so that side stays optional. The working
/// tree is read through `resolve`, which brings the workspace's symlink, size
/// and confinement rules with it.
///
/// ponytail: HEAD-vs-worktree only. A staged-then-re-edited file is shown
/// against HEAD, not against its index version; add a third side when partial
/// staging is modelled.
#[tauri::command]
pub fn git_diff(id: String, state: tauri::State<'_, WorkspaceState>) -> Result<ChangeDiff, String> {
    let root = root_of(&state)?;
    let path = relative(&id)?;
    Ok(ChangeDiff {
        id: id.clone(),
        name: basename(path),
        original: git(&root, &["show", &format!("HEAD:{path}")]).unwrap_or_default(),
        modified: working_tree_side(&root, path)?,
    })
}

#[tauri::command]
pub fn git_stage(id: String, state: tauri::State<'_, WorkspaceState>) -> Result<(), String> {
    let root = root_of(&state)?;
    git(&root, &["add", "--", relative(&id)?]).map(|_| ())
}

#[tauri::command]
pub fn git_unstage(id: String, state: tauri::State<'_, WorkspaceState>) -> Result<(), String> {
    let root = root_of(&state)?;
    git(&root, &["restore", "--staged", "--", relative(&id)?]).map(|_| ())
}

/// Destructive: puts the file back to its HEAD content and unstages it, which
/// is what "this file no longer appears in the change list" means. The caller
/// confirms first, and `revertable` keeps it away from files with no HEAD
/// version to restore from.
#[tauri::command]
pub fn git_revert(id: String, state: tauri::State<'_, WorkspaceState>) -> Result<(), String> {
    let root = root_of(&state)?;
    git(
        &root,
        &[
            "restore",
            "--source=HEAD",
            "--staged",
            "--worktree",
            "--",
            relative(&id)?,
        ],
    )
    .map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_status_covers_the_shapes_the_ui_shows() {
        // Staged modify, unstaged modify, untracked, staged delete, staged add,
        // a rename (whose original path must not be read as another entry), and
        // a path with a space.
        let raw = "M  src/a.ts\0 M src/b.ts\0?? src/c.ts\0D  src/d.ts\0A  src/e.ts\0\
                   R  src/new.ts\0src/old.ts\0 M src/two words.ts\0";
        let changes = parse_status(raw);

        let ids: Vec<&str> = changes.iter().map(|c| c.id.as_str()).collect();
        assert_eq!(
            ids,
            [
                "src/a.ts",
                "src/b.ts",
                "src/c.ts",
                "src/d.ts",
                "src/e.ts",
                "src/new.ts",
                "src/two words.ts",
            ]
        );

        assert_eq!((changes[0].status, changes[0].staged), ("modified", true));
        assert_eq!((changes[1].status, changes[1].staged), ("modified", false));
        // Untracked reads as an unstaged addition, and cannot be reverted.
        assert_eq!((changes[2].status, changes[2].staged), ("added", false));
        assert!(!changes[2].revertable);
        assert_eq!((changes[3].status, changes[3].staged), ("deleted", true));
        // A staged addition has no HEAD version to restore from.
        assert_eq!((changes[4].status, changes[4].staged), ("added", true));
        assert!(!changes[4].revertable);
        assert_eq!((changes[5].status, changes[5].staged), ("modified", true));
        assert_eq!(changes[5].name, "new.ts");
        assert!(changes[0].revertable);

        assert!(parse_status("").is_empty());
    }

    #[test]
    fn working_tree_side_reports_refusals_instead_of_emptiness() {
        let dir = std::env::temp_dir().join("ade-diff-test");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("sub")).unwrap();
        std::fs::write(dir.join("kept.txt"), "hi").unwrap();
        std::fs::write(dir.join("../ade-diff-outside.txt"), "nope").unwrap();
        let root = crate::workspace::canonical(&dir).unwrap();

        assert_eq!(working_tree_side(&root, "kept.txt").unwrap(), "hi");
        // Deleted: the one absence that legitimately reads as an empty side.
        assert_eq!(working_tree_side(&root, "gone.txt").unwrap(), "");
        // Everything else must surface, or the UI shows a whole-file deletion
        // where the answer was actually "no".
        assert!(working_tree_side(&root, "../ade-diff-outside.txt").is_err());
        assert!(working_tree_side(&root, "/etc/passwd").is_err());
        // Present but not a regular file: an absence-shaped answer would be a
        // lie, and `resolve` must not report it with the not-found message.
        assert!(working_tree_side(&root, "sub").is_err());

        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_file(dir.join("../ade-diff-outside.txt"));
    }

    #[test]
    fn relative_rejects_escapes() {
        assert!(relative("src/a.ts").is_ok());
        assert!(relative("../outside.ts").is_err());
        assert!(relative("/etc/passwd").is_err());
        assert!(relative("src/../../outside.ts").is_err());
    }
}

/// Snapshot the working tree before a turn, so an unwanted change is
/// recoverable.
///
/// For a coding agent, undo beats prevention: a prompt the user has been
/// trained to dismiss protects nothing, whereas a checkpoint makes the change
/// reversible. This is decision 4 of the permission-gate ticket.
///
/// `stash create` builds a commit object without touching the working tree, the
/// index, or the branch — the agent's turn proceeds exactly as if this had not
/// run. `stash store` then names it so it appears in `git stash list` and is
/// not garbage-collected.
///
/// **Its limits are the reason the rest of the floor exists.** It captures
/// modifications to *tracked* files only: it does not recover an untracked file
/// the agent overwrote, anything deleted outside the repository, a force push,
/// or anything already sent over the network. `Ok(None)` means there was
/// nothing to save, which is the normal case for a clean tree.
#[tauri::command]
pub fn git_checkpoint(
    label: String,
    session: Option<String>,
    state: tauri::State<'_, WorkspaceState>,
    roots: tauri::State<'_, SessionRoots>,
    writers: tauri::State<'_, Writers>,
) -> Result<Option<String>, String> {
    /*
     * **Where a turn begins, which is the only reason this is told about it.**
     * Ticket 51's note fires while another session's turn is still the one it
     * wrote in, and this command is called once at the start of every turn — so
     * it is the boundary rather than a second mechanism invented to be one.
     * Recorded before the git work, because a folder that is not a repository
     * still has turns.
     */
    turn_begins(&writers, session.as_deref());
    // Where in the order of writes this snapshot sits, read *before* the snapshot
    // is taken — `write_mark` says why.
    let at = write_mark(&writers);
    // The *session's* repository, not the focused one. A turn running in the
    // background must snapshot the tree it is editing even while the window is
    // showing another folder — ticket 49, and the hole review found in 45–48.
    let root = agent_root(&state, &roots, session.as_deref())?;
    let created = git(&root, &["stash", "create"])?;
    let sha = created.trim();
    if sha.is_empty() {
        return Ok(None);
    }
    git(&root, &["stash", "store", "-m", &label, sha])?;
    // Where this checkpoint sits in the order of writes to this folder, so undo
    // can say whose work it would also revert — ticket 52.
    checkpoint_taken(&writers, &root, sha, session.as_deref(), at);
    Ok(Some(sha.to_string()))
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Restored {
    /// The tree as it was *immediately before* the undo, stashed. `None` means
    /// there was nothing to save. This is what makes the undo itself undoable.
    backup: Option<String>,
    /// Workspace-relative paths that were put back.
    restored: Vec<String>,
    /// Paths git tracked that the checkpoint did not have, and that were
    /// therefore removed. They are in `backup`.
    removed: Vec<String>,
}

/// Put the working tree back to a checkpoint taken by `git_checkpoint`.
///
/// The other half of the safety net, and the reason the net was worth hanging:
/// see [ticket 28](docs/wayfinder/pi-harness/tickets/28-session-undo.md).
///
/// **A checkpoint of the current tree is taken first, always.** Everything this
/// then overwrites — including work the user did by hand after the turn began —
/// is recoverable from `backup` by the same mechanism, which is what makes an
/// operation that destroys uncommitted changes an acceptable thing to offer at
/// all. The UI confirms before calling this; that confirmation is the gate, and
/// this is the floor beneath it.
///
/// `restore --worktree` rather than `checkout <sha> -- .`, so the index is left
/// exactly as it was: an undo that silently staged everything it touched would
/// change what the user's next commit contains.
///
/// **Untracked files are never touched.** `git stash create` does not capture
/// them, so deleting one here would be the single unrecoverable thing this
/// command could do — and it is precisely the case a checkpoint cannot cover.
/// A file the agent created and left untracked survives the undo, and the
/// caller says so.
#[tauri::command]
pub fn git_restore_checkpoint(
    sha: String,
    session: Option<String>,
    state: tauri::State<'_, WorkspaceState>,
    roots: tauri::State<'_, SessionRoots>,
) -> Result<Restored, String> {
    // Undo puts back the tree the turn was taken in. Resolving against the
    // focused root would let an undo in one conversation reset another folder.
    let root = agent_root(&state, &roots, session.as_deref())?;
    let sha = object_id(&sha)?;
    // Refuse an id that is not a commit we could have made, before anything moves.
    git(&root, &["cat-file", "-e", &format!("{sha}^{{commit}}")])
        .map_err(|_| "that checkpoint is no longer in this repository".to_string())?;

    // Read what will change *before* changing it — afterwards the answer is empty.
    let changes = git(&root, &["diff", "--name-status", sha])?;
    let mut restored = Vec::new();
    let mut removed = Vec::new();
    for line in changes.lines() {
        let Some((status, path)) = line.split_once('\t') else {
            continue;
        };
        // "A" is added *in the working tree* relative to the checkpoint, so
        // restoring the checkpoint removes it. Everything else is put back.
        if status.starts_with('A') {
            removed.push(path.to_string());
        } else {
            restored.push(path.to_string());
        }
    }

    let created = git(&root, &["stash", "create"])?;
    let backup = created.trim();
    let backup = if backup.is_empty() {
        None
    } else {
        git(&root, &["stash", "store", "-m", "before undo", backup])?;
        Some(backup.to_string())
    };

    git(&root, &["restore", "--source", sha, "--worktree", "--", "."])?;
    Ok(Restored {
        backup,
        restored,
        removed,
    })
}

#[cfg(test)]
mod restore_tests {
    use super::object_id;

    #[test]
    fn object_id_rejects_anything_that_is_not_a_sha() {
        assert!(object_id("1b5d27b48a3bc5dfa5ee11231ef4b51af39c0c82").is_ok());
        assert!(object_id("1b5d27b").is_ok());
        // The three shapes that would make this an injection rather than a lookup.
        assert!(object_id("--upload-pack=touch owned").is_err());
        assert!(object_id("HEAD").is_err());
        assert!(object_id("refs/heads/master").is_err());
        // Too short to be an abbreviation git would accept, and empty.
        assert!(object_id("1b5d2").is_err());
        assert!(object_id("").is_err());
    }
}
