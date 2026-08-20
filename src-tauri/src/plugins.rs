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

/// The scheme a plugin's own page is served over — ticket 75.
pub const PANEL_SCHEME: &str = "plugin";

/// The plugin id the ADE serves its own files under. Not a folder on disk.
const ADE: &str = "ade";

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
fn global_dir<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Result<PathBuf, String> {
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

// ## A plugin's own page — ticket 75
//
// `plugin://<scope>/<folder>/<file>` serves one plugin's folder and nothing
// outside it. The scope and the folder are two path segments rather than the
// `global:hello` id spelled literally, because a colon in a URL path is legal
// and handled differently by every parser that touches it — two segments cannot
// be got wrong.
//
// A panel is therefore **its own origin**: it cannot reach our DOM and it holds
// none of our Tauri capabilities. That is a property of webviews rather than a
// claim about the plugin, whose injected half still runs with our authority.

/// The URL a panel is opened at, in the form this platform actually serves.
///
/// Windows and Android route a custom scheme through `http://<scheme>.localhost`
/// and everything else serves it directly. Built here rather than in the
/// renderer so nothing above this file has to know which platform it is on; the
/// path is the same either way, which is what the handler below parses.
pub fn panel_url(scope: &str, folder: &str, relative: &str) -> String {
    let path = format!("{scope}/{folder}/{}", relative.trim_start_matches('/'));
    if cfg!(any(windows, target_os = "android")) {
        format!("http://{PANEL_SCHEME}.localhost/{path}")
    } else {
        format!("{PANEL_SCHEME}://localhost/{path}")
    }
}

/// Split `/<scope>/<folder>/<rest>` into its three parts.
///
/// Takes the *path* rather than the URL, because the two platform forms differ
/// in everything except the path.
fn panel_parts(path: &str) -> Option<(String, String, String)> {
    let mut segments = path.trim_start_matches('/').splitn(3, '/');
    let scope = segments.next()?.to_owned();
    let folder = segments.next()?.to_owned();
    let rest = segments.next().unwrap_or_default();
    let rest = if rest.is_empty() { "index.html".to_owned() } else { rest.to_owned() };
    if scope.is_empty() || folder.is_empty() {
        return None;
    }
    Some((scope, folder, rest))
}

/// Where a plugin's folder is, from the two names in a panel URL.
///
/// `folder` is checked for being one path component before it is joined, so a
/// URL naming `../..` never reaches the filesystem at all. The file inside it
/// then goes through `workspace::resolve` like everything else here, which is
/// what refuses a symlink pointing out.
fn panel_file<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    state: &WorkspaceState,
    scope: &str,
    folder: &str,
    relative: &str,
) -> Result<PathBuf, String> {
    if Path::new(folder).components().count() != 1 || folder.contains("..") {
        return Err(format!("{folder} is not a plugin folder"));
    }
    let dir = match scope {
        "global" => global_dir(app)?.join(folder),
        "local" => workspace::root_of(state)?
            .join(".ade")
            .join("plugins")
            .join(folder),
        other => return Err(format!("{other} is not a plugin scope")),
    };
    let root = workspace::canonical(&dir).map_err(|e| e.to_string())?;
    workspace::resolve(&root, relative)
}

/// What a browser makes of a file, by its extension. Text needs the charset.
fn content_type(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase()
        .as_str()
    {
        "html" | "htm" => "text/html; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "json" => "application/json; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "woff2" => "font/woff2",
        _ => "application/octet-stream",
    }
}

// **Our palette, over the plugin's own protocol.**
//
// `plugin://ade/tokens.css` is the honest answer to "can a plugin use your
// components": it cannot import them — nothing but data crosses, and a React
// component is not data — and it does not have to invent a look either. A panel
// that links this gets every custom property the workbench has.
//
// Compiled in rather than read off disk. It is the same file Vite compiles into
// the workbench, so there is still exactly one definition; reading it at runtime
// would need it shipped as a bundle resource, which is a second copy that can go
// missing in a release build and never in a dev one.
//
// The theme is a class on `<html>`, so a panel follows the workbench by being
// told which one is on — see `panels.ts`.
const TOKENS_CSS: &str = include_str!("../../src/ui/tokens.css");

fn refuse(reason: String) -> tauri::http::Response<Vec<u8>> {
    tauri::http::Response::builder()
        .status(404)
        .header("Content-Type", "text/plain; charset=utf-8")
        .body(reason.into_bytes())
        .expect("a 404 with a string body is always valid")
}

/// Serve one file out of one plugin's folder.
pub fn serve_panel<R: tauri::Runtime>(
    ctx: tauri::UriSchemeContext<'_, R>,
    request: tauri::http::Request<Vec<u8>>,
) -> tauri::http::Response<Vec<u8>> {
    let Some((scope, folder, relative)) = panel_parts(request.uri().path()) else {
        return refuse(format!("{} names no plugin file", request.uri().path()));
    };
    if scope == ADE && folder == "tokens.css" {
        return tauri::http::Response::builder()
            .header("Content-Type", "text/css; charset=utf-8")
            .body(TOKENS_CSS.as_bytes().to_vec())
            .expect("a css body is always valid");
    }
    let app = ctx.app_handle();
    let state = app.state::<WorkspaceState>();
    match panel_file(app, state.inner(), &scope, &folder, &relative) {
        Err(reason) => refuse(reason),
        Ok(path) => match fs::read(&path) {
            Err(error) => refuse(error.to_string()),
            Ok(bytes) => tauri::http::Response::builder()
                .header("Content-Type", content_type(&path))
                .body(bytes)
                .expect("a file body is always valid"),
        },
    }
}

#[cfg(test)]
mod panel_tests {
    use super::*;

    #[test]
    fn a_panel_url_carries_the_scope_and_the_folder_as_segments() {
        let url = panel_url("local", "hello", "panel.html");
        assert!(url.ends_with("/local/hello/panel.html"), "{url}");
        // Whichever form the platform serves, the path is what the handler reads.
        assert_eq!(
            panel_parts("/local/hello/panel.html"),
            Some(("local".into(), "hello".into(), "panel.html".into()))
        );
        // A bare folder is its index, the way any static server answers.
        assert_eq!(
            panel_parts("/global/hello/"),
            Some(("global".into(), "hello".into(), "index.html".into()))
        );
        assert_eq!(panel_parts("/hello"), None);
    }

    #[test]
    fn a_panel_cannot_escape_its_own_folder() {
        let temp = std::env::temp_dir().join("ade-panel-confinement");
        let plugin = temp.join("evil");
        fs::create_dir_all(&plugin).unwrap();
        fs::write(temp.join("secret.txt"), "sh").unwrap();
        fs::write(plugin.join("panel.html"), "<b>hi</b>").unwrap();
        let root = workspace::canonical(&plugin).unwrap();

        // The file inside is served; everything above it is refused, by the same
        // resolver a project read goes through.
        assert!(workspace::resolve(&root, "panel.html").is_ok());
        assert!(workspace::resolve(&root, "../secret.txt").is_err());
        assert!(workspace::resolve(&root, "..\\secret.txt").is_err());
        assert!(workspace::resolve(&root, "/etc/passwd").is_err());
        fs::remove_dir_all(&temp).ok();
    }

    #[test]
    fn a_folder_segment_is_never_a_path() {
        // Refused before the filesystem is touched, which is why this holds with
        // no app handle to hand.
        for bad in ["..", "a/b", "a\\b", "../.."] {
            assert!(
                Path::new(bad).components().count() != 1 || bad.contains(".."),
                "{bad} must not pass for a folder name"
            );
        }
        assert_eq!(Path::new("hello").components().count(), 1);
    }

    #[test]
    fn tokens_are_served_and_are_the_workbench_ones() {
        // Compiled in, so this is the same text `tokens.css` holds.
        assert!(TOKENS_CSS.contains("--background"));
        assert!(TOKENS_CSS.contains(".dark"));
    }

    #[test]
    fn a_content_type_is_chosen_by_extension() {
        assert_eq!(content_type(Path::new("a/panel.html")), "text/html; charset=utf-8");
        assert_eq!(content_type(Path::new("a/style.css")), "text/css; charset=utf-8");
        assert_eq!(content_type(Path::new("a/logo.png")), "image/png");
        assert_eq!(content_type(Path::new("a/thing.bin")), "application/octet-stream");
    }
}
