//! Finding plugins on disk — ticket 72.
//!
//! **Rust discovers and reads; the renderer decides.** This file walks two
//! folders, reads each `plugin.json` and, where the manifest names one, the
//! script beside it. It does not validate the manifest, does not check the `api`
//! integer and does not know what a claim is: every one of those produces a
//! *message a user reads*, and messages belong next to the code that composes
//! the rest of them. What comes back here is text and a reason it is missing.
//!
//! ## Two folders, and no third
//!
//! - **Global** — `<app data>/plugins`. Putting a folder there is the trust
//!   decision, in the same spirit as `profiles.rs`: one fixed location, no
//!   argument, so the renderer cannot turn this into a second filesystem.
//! - **Local** — `<root>/.ade/plugins`, where the root is the one
//!   `WorkspaceState` already holds. **The renderer does not name it.** A root
//!   named by the renderer is the hole `choose_workspace` exists to close, and
//!   `set_workspace` is debug-only for exactly that reason — so a local plugin
//!   is only discoverable once a root has been adopted through one of the two
//!   real doors.
//!
//! Local plugins are *read* here and are not run: enablement is the renderer's,
//! remembered per root, and nothing in this file knows about it. Reading a file
//! is not executing it, and listing what is there is the whole point — a plugin
//! nobody can see is a plugin nobody can enable.
//!
//! ## Confinement
//!
//! Each plugin folder is its own root, and every file under it is fetched
//! through `workspace::resolve`, which is the same function the project's own
//! reads go through: no `..`, no absolute paths, no symlinks, canonicalised and
//! checked with `starts_with`. So a manifest saying `"script": "../../id_rsa"`
//! is refused by the rule that already existed rather than by a new one.

use std::fs;
use std::path::{Path, PathBuf};

use tauri::Manager;

use crate::workspace::{self, WorkspaceState};

/// What discovery found, and where the global folder is.
///
/// The path travels with the list because a feature whose folder is at an
/// unnamed location is a feature nobody finds — `global_profiles_path` learned
/// this first. Here it is a field rather than a second command: the plugin list
/// wants both in one breath.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Discovery {
    /// Display path of `<app data>/plugins`, whether or not it exists yet.
    global_dir: String,
    /// Display path of `<root>/.ade/plugins`, or `None` with no root adopted.
    local_dir: Option<String>,
    plugins: Vec<DiscoveredPlugin>,
}

/// One folder that might be a plugin.
///
/// Every field is optional except identity, because *a broken plugin still has
/// to be listed*. A folder that cannot be parsed disappearing from the list is
/// indistinguishable from never having been copied in, and the user's next move
/// is to look at the list.
#[derive(serde::Serialize)]
pub struct DiscoveredPlugin {
    /// `global:<folder>` or `local:<folder>` — stable across runs, because the
    /// folder name is what the user typed when they copied it in.
    id: String,
    scope: &'static str,
    /// The folder's own name, which is what the manifest is named against.
    folder: String,
    /// Display path of the plugin folder, for a Problems line to point at.
    dir: String,
    /// Raw `plugin.json`. Parsed by the renderer, not here.
    manifest: Option<String>,
    /// Raw text of the file `manifest.script` names, when it names one.
    script: Option<String>,
    /// Why a field above is absent. Present means the plugin cannot run.
    error: Option<String>,
}

/// Where the global folder lives. Created lazily by the user, not by us: an
/// empty folder appearing in app data is noise until someone wants one.
fn global_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|dir| dir.join("plugins"))
        .map_err(|e| e.to_string())
}

/// Read one file beneath a plugin folder, as text.
///
/// The two failure modes are told apart on purpose: a manifest that is *absent*
/// means "this folder is not a plugin", and one that is present but unreadable
/// means "this plugin is broken". They read differently in Problems and they
/// should.
fn read_within(dir: &Path, relative: &str) -> Result<String, String> {
    let path = workspace::resolve(dir, relative)?;
    fs::read_to_string(path).map_err(|e| e.to_string())
}

/// The entry point a manifest names, without validating the manifest.
///
/// Deliberately permissive: anything other than a string here is `None`, and the
/// renderer's parser is what says why. Two parsers producing two different
/// verdicts about one file is the failure this shape avoids — this one only ever
/// answers "which file do I also read".
fn script_entry(manifest: &str) -> Option<String> {
    serde_json::from_str::<serde_json::Value>(manifest)
        .ok()?
        .get("script")?
        .as_str()
        .map(str::to_owned)
}

fn discover_folder(dir: &Path, scope: &'static str, out: &mut Vec<DiscoveredPlugin>) {
    // An absent plugins folder is the normal state, not a failure: nobody has
    // copied anything in yet.
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    let mut folders: Vec<PathBuf> = entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.is_dir())
        .collect();
    // Sorted, so the order a plugin loads in is the order its folder sorts in
    // rather than whatever the filesystem happened to hand back. Load order is
    // observable — two plugins claiming one command id resolve by it.
    folders.sort();

    for folder in folders {
        let name = folder
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        if name.is_empty() {
            continue;
        }
        // Canonical, because `resolve` confines by `starts_with` and mixing a
        // canonical child with a non-canonical root makes every file look like
        // an escape.
        let Ok(root) = workspace::canonical(&folder) else {
            continue;
        };
        let dir_display = root.display().to_string();
        let mut plugin = DiscoveredPlugin {
            id: format!("{scope}:{name}"),
            scope,
            folder: name,
            dir: dir_display,
            manifest: None,
            script: None,
            error: None,
        };
        match read_within(&root, "plugin.json") {
            Ok(text) => {
                if let Some(entry) = script_entry(&text) {
                    match read_within(&root, &entry) {
                        Ok(source) => plugin.script = Some(source),
                        Err(reason) => plugin.error = Some(format!("cannot read {entry}: {reason}")),
                    }
                }
                plugin.manifest = Some(text);
            }
            Err(reason) => plugin.error = Some(format!("cannot read plugin.json: {reason}")),
        }
        out.push(plugin);
    }
}

/// Everything on disk that might be a plugin.
///
/// Takes no argument, and that is the security property rather than an economy:
/// both folders are derived from state this process already holds.
#[tauri::command]
pub fn list_plugins(
    app: tauri::AppHandle,
    state: tauri::State<'_, WorkspaceState>,
) -> Result<Discovery, String> {
    let global = global_dir(&app)?;
    let mut plugins = Vec::new();
    discover_folder(&global, "global", &mut plugins);

    // No root adopted yet is not an error. At boot there is no workspace, and
    // the renderer asks again once one has been opened.
    let local = workspace::root_of(&state)
        .ok()
        .map(|root| root.join(".ade").join("plugins"));
    if let Some(dir) = &local {
        discover_folder(dir, "local", &mut plugins);
    }

    Ok(Discovery {
        global_dir: global.display().to_string(),
        local_dir: local.map(|dir| dir.display().to_string()),
        plugins,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn script_entry_reads_only_a_string() {
        assert_eq!(script_entry(r#"{"script":"index.js"}"#), Some("index.js".into()));
        assert_eq!(script_entry(r#"{"script":42}"#), None);
        assert_eq!(script_entry(r#"{"panel":"p.html"}"#), None);
        // A manifest the renderer will reject still must not make discovery fail.
        assert_eq!(script_entry("not json at all"), None);
    }

    #[test]
    fn a_manifest_cannot_name_a_file_outside_its_folder() {
        let temp = std::env::temp_dir().join("ade-plugin-confinement");
        let plugin = temp.join("evil");
        fs::create_dir_all(&plugin).unwrap();
        fs::write(temp.join("secret.txt"), "sh").unwrap();
        let root = workspace::canonical(&plugin).unwrap();
        assert!(read_within(&root, "../secret.txt").is_err());
        assert!(read_within(&root, "secret.txt").is_err());
        fs::remove_dir_all(&temp).ok();
    }

    #[test]
    fn a_folder_with_no_manifest_is_listed_with_its_reason() {
        let temp = std::env::temp_dir().join("ade-plugin-empty");
        fs::create_dir_all(temp.join("nothing")).unwrap();
        let mut out = Vec::new();
        discover_folder(&temp, "global", &mut out);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].id, "global:nothing");
        assert!(out[0].manifest.is_none());
        // Listed, not silently dropped: the user's next move is to read this.
        assert!(out[0].error.as_deref().unwrap().contains("plugin.json"));
        fs::remove_dir_all(&temp).ok();
    }

    #[test]
    fn a_missing_plugins_folder_is_not_an_error() {
        let mut out = Vec::new();
        discover_folder(
            &std::env::temp_dir().join("ade-plugins-that-do-not-exist"),
            "global",
            &mut out,
        );
        assert!(out.is_empty());
    }
}
