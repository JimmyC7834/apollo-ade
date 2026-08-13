//! Where the rtk binary comes from.
//!
//! Settled by docs/wayfinder/pi-harness/tickets/11-rtk-in-profile.md, amendment
//! 6 — **route D: fetch the pinned release on first need.** rtk is not bundled
//! and not installed; it is downloaded once, verified against a digest recorded
//! in *this file*, and cached beside the app's own data.
//!
//! Three facts the design rests on, none of them obvious:
//!
//!   - **The digest is ours, not upstream's.** Every release publishes a
//!     `checksums.txt`, and it is deliberately never fetched: same origin, same
//!     connection, same account as the asset, so anything able to substitute the
//!     binary can substitute the digest beside it. It detects the corruption
//!     HTTPS already detects and nothing else. Upstream signs nothing — no GPG,
//!     no minisign, no cosign — so a hash somebody looked at when they chose the
//!     version is the only trust anchor there is, and it has to travel by a
//!     different road than the bytes it describes.
//!   - **The archive is verified before it is opened**, never the binary
//!     afterwards. An attacker-controlled archive is a zip-slip the moment it is
//!     unpacked, so unpacking must not be the step that happens first. It is
//!     also why the entry's *own path is never used*: we match on the file name
//!     and write to a path we chose.
//!   - **PATH wins, and is confirmed by `rtk gain`.** A dev tool that ignores
//!     the dev's own toolchain is the wrong instinct — but `which rtk` is not
//!     enough, because crates.io publishes an unrelated `rtk` (Rust Type Kit)
//!     and finding it would be indistinguishable from finding this one.
//!
//! What this module does not do is decide *whether* rtk runs. That is the
//! profile's `rtk` flag, read in `src/agent/rtk.ts`, which also owns the
//! rewrite. Rust owns the process; JavaScript owns the policy.

use std::io::Read;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::Manager;

use crate::reaper::Reaper;

/// The pinned release, and the reason it is pinned.
///
/// Upstream cut 47 stable releases in six months, so this is permanently a
/// little behind — that is the price of being able to say what the app will
/// execute. Resolving `latest` at fetch time would make a pinned digest
/// impossible by construction: you cannot hash an artifact that does not exist
/// yet. Bumping it is three edits: this line, the digests in `ASSETS`, and
/// `RTK_VERSION` in `src/agent/rtk.ts`, which mirrors it so the profile modal
/// can name the pin before anything has been resolved.
pub const VERSION: &str = "v0.45.0";

/// Bytes we will not exceed for one download.
///
/// The assets are ~4 MB. This is not a security control — the digest is — it is
/// what stops a redirect to something enormous from eating the machine's memory
/// before the digest gets a chance to reject it.
const MAX_DOWNLOAD: usize = 32 * 1024 * 1024;

/// How long the whole acquisition may take before the caller gives up on it.
const FETCH_TIMEOUT: u64 = 120;

struct Asset {
    os: &'static str,
    arch: &'static str,
    name: &'static str,
    /// SHA-256 of the *archive*, recorded when the version above was chosen.
    sha256: &'static str,
}

/// Every target upstream builds, as a table rather than a `match`.
///
/// A table because the digests are the one thing here nothing else can check:
/// the tests below iterate **all five**, where a `match` on the running
/// platform would leave four of them unexamined until somebody else's machine
/// failed to download.
///
/// **There is no ARM Windows entry**, and that is upstream's shape rather than
/// an omission — that platform takes the unavailable path permanently, which is
/// visible degradation working as designed though it will be reported as a bug.
const ASSETS: &[Asset] = &[
    Asset {
        os: "windows",
        arch: "x86_64",
        name: "rtk-x86_64-pc-windows-msvc.zip",
        sha256: "34cea9009a8099acdaf85147b971d95f65efabfa63fb3aea7d3e2b73e6f517c3",
    },
    Asset {
        os: "macos",
        arch: "x86_64",
        name: "rtk-x86_64-apple-darwin.tar.gz",
        sha256: "9ea02f889d5a2779e4fb700df4587824303c5a57cda22e903e30058079fca0ef",
    },
    Asset {
        os: "macos",
        arch: "aarch64",
        name: "rtk-aarch64-apple-darwin.tar.gz",
        sha256: "064151cfc2d50b24d810b06a0af2e41b9c945e83534e4c438c3d3eae607fc3f4",
    },
    Asset {
        os: "linux",
        arch: "x86_64",
        name: "rtk-x86_64-unknown-linux-musl.tar.gz",
        sha256: "c4c036fbf181fc55ef329786c8c17e0d427972b053b825944d968a6aafef1ba4",
    },
    Asset {
        os: "linux",
        arch: "aarch64",
        name: "rtk-aarch64-unknown-linux-gnu.tar.gz",
        sha256: "80a746dd305ef944ff50ef011ae4ce3878dd5ba88dfe35d859d05498191637c3",
    },
];

/// The asset for this machine, if upstream builds one.
fn asset() -> Option<&'static Asset> {
    ASSETS
        .iter()
        .find(|entry| entry.os == std::env::consts::OS && entry.arch == std::env::consts::ARCH)
}

/// What the archive is called inside itself.
fn binary_name() -> &'static str {
    if cfg!(windows) {
        "rtk.exe"
    } else {
        "rtk"
    }
}

/// Where a fetched rtk lives. Versioned, so a bump does not overwrite a binary
/// a running turn may still be executing.
fn cached_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("no app data directory: {e}"))?;
    Ok(base.join("rtk").join(VERSION).join(binary_name()))
}

/// How rtk was obtained, or why it was not.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RtkStatus {
    /// `path` | `cached` | `unavailable`.
    source: &'static str,
    /// What to put in front of a command. Absent when unavailable.
    path: Option<String>,
    /// As rtk reports it — the version that answered, not the version we asked
    /// for, so a bug report names the binary rather than the pin.
    version: Option<String>,
    /// Why it is unavailable, in the words the user will see.
    message: Option<String>,
}

fn unavailable(message: impl Into<String>) -> RtkStatus {
    RtkStatus {
        source: "unavailable",
        path: None,
        version: None,
        message: Some(message.into()),
    }
}

/// How long one probe may take before we conclude it is not answering.
///
/// It exists because acquisition **blocks the tool call that triggered it**. A
/// binary that hangs — the crates.io impostor of the same name, something
/// waiting on a console it will never get — would otherwise block that call
/// forever, which is worse than any answer this function could return.
const PROBE_TIMEOUT: Duration = Duration::from_secs(10);

/// Run one probe command, held to the same rules as every other child this app
/// starts: credentials stripped, adopted into a `Reaper`, and killed if it
/// outstays the deadline.
fn ask(program: &str, argument: &str, capture: bool) -> Option<String> {
    let mut command = Command::new(program);
    command.arg(argument);
    command.stdin(Stdio::null());
    // `gain` is asked only for its exit status, so its output goes nowhere.
    // That is not tidiness: an un-drained pipe fills at 64 KB and the child
    // blocks on the write, and `rtk gain` on a busy machine prints a table.
    // `--version` is one line and safe to hold in the pipe until it exits.
    command.stdout(if capture { Stdio::piped() } else { Stdio::null() });
    command.stderr(Stdio::null());
    // The same strip `agent_exec` does, for the same reason: this is a binary
    // we did not write, and an inherited environment hands it the API key.
    for name in crate::provider::CREDENTIAL_VARS {
        command.env_remove(name);
    }
    #[cfg(not(windows))]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }

    let mut child = command.spawn().ok()?;
    #[allow(unused_mut)]
    let mut reaper = Reaper::new()?;
    reaper.adopt(child.id());

    let deadline = Instant::now() + PROBE_TIMEOUT;
    loop {
        match child.try_wait() {
            Ok(Some(status)) if status.success() => break,
            Ok(Some(_)) | Err(_) => return None,
            Ok(None) => {}
        }
        if Instant::now() > deadline {
            reaper.kill();
            let _ = child.wait();
            return None;
        }
        std::thread::sleep(Duration::from_millis(25));
    }

    if !capture {
        return Some(String::new());
    }
    let mut text = String::new();
    child.stdout.take()?.read_to_string(&mut text).ok()?;
    Some(text.trim().to_string())
}

/// Ask a candidate binary whether it is *this* rtk, and which version.
///
/// `gain` is the discriminator rather than `--version`: the unrelated crates.io
/// `rtk` answers `--version` perfectly happily. A binary that cannot report its
/// own savings is not the tool this feature is about.
///
/// Blocking, so every caller goes through `probe` below rather than this.
fn probe_blocking(program: &str) -> Option<String> {
    ask(program, "gain", false)?;
    ask(program, "--version", true)
}

/// The same, off the async runtime's threads.
async fn probe(program: &str) -> Option<String> {
    let program = program.to_string();
    tauri::async_runtime::spawn_blocking(move || probe_blocking(&program))
        .await
        .ok()
        .flatten()
}

fn digest(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}

/// Pull the binary out of the archive, using our own destination path.
///
/// The entry is found by **file name**, and the name it carries is used for
/// nothing else. That is what makes this zip-slip-proof without a traversal
/// check: there is no path from the archive anywhere in the write.
#[cfg(windows)]
fn extract(archive: &[u8], into: &std::path::Path) -> Result<(), String> {
    let mut zip = zip::ZipArchive::new(std::io::Cursor::new(archive))
        .map_err(|e| format!("the archive could not be opened: {e}"))?;
    for index in 0..zip.len() {
        let mut entry = zip.by_index(index).map_err(|e| e.to_string())?;
        let name = entry
            .enclosed_name()
            .and_then(|path| path.file_name().map(|n| n.to_string_lossy().to_string()));
        if name.as_deref() != Some(binary_name()) {
            continue;
        }
        let mut bytes = Vec::new();
        entry
            .read_to_end(&mut bytes)
            .map_err(|e| format!("the archive could not be read: {e}"))?;
        return write_binary(&bytes, into);
    }
    Err(format!("the archive contains no {}", binary_name()))
}

#[cfg(not(windows))]
fn extract(archive: &[u8], into: &std::path::Path) -> Result<(), String> {
    let mut tar = tar::Archive::new(flate2::read::GzDecoder::new(archive));
    for entry in tar
        .entries()
        .map_err(|e| format!("the archive could not be opened: {e}"))?
    {
        let mut entry = entry.map_err(|e| e.to_string())?;
        let name = entry
            .path()
            .ok()
            .and_then(|path| path.file_name().map(|n| n.to_string_lossy().to_string()));
        if name.as_deref() != Some(binary_name()) {
            continue;
        }
        let mut bytes = Vec::new();
        entry
            .read_to_end(&mut bytes)
            .map_err(|e| format!("the archive could not be read: {e}"))?;
        return write_binary(&bytes, into);
    }
    Err(format!("the archive contains no {}", binary_name()))
}

/// Write the extracted bytes where we said, executable, without ever leaving a
/// half-written file at the path a later run will trust.
fn write_binary(bytes: &[u8], into: &std::path::Path) -> Result<(), String> {
    let parent = into
        .parent()
        .ok_or_else(|| "the cache path has no parent".to_string())?;
    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let staged = into.with_extension("partial");
    std::fs::write(&staged, bytes).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&staged, std::fs::Permissions::from_mode(0o755))
            .map_err(|e| e.to_string())?;
    }
    std::fs::rename(&staged, into).map_err(|e| e.to_string())
}

/// Find rtk, fetching it if that is what finding it takes.
///
/// Never fails: an unavailable rtk is an answer the caller acts on, not an
/// error. The command that wanted it runs unfiltered and says so — silence here
/// would mean the token savings stop with nobody noticing, which is the one
/// failure mode this feature cannot detect from its own output.
#[tauri::command]
pub async fn rtk_resolve(app: tauri::AppHandle) -> RtkStatus {
    // The dev's own install, first. `rtk` bare rather than an absolute path:
    // this is the one case where PATH resolution is the point.
    if let Some(version) = probe("rtk").await {
        return RtkStatus {
            source: "path",
            path: Some("rtk".to_string()),
            version: Some(version),
            message: None,
        };
    }

    let cached = match cached_path(&app) {
        Ok(path) => path,
        Err(message) => return unavailable(message),
    };
    if cached.is_file() {
        let program = cached.to_string_lossy().to_string();
        if let Some(version) = probe(&program).await {
            return RtkStatus {
                source: "cached",
                path: Some(program),
                version: Some(version),
                message: None,
            };
        }
        // Present but not answering — a truncated write from an older build, or
        // a binary this OS refuses to run. Removed so the fetch below replaces
        // it rather than this branch failing the same way every session.
        let _ = std::fs::remove_file(&cached);
    }

    let Some(asset) = asset() else {
        return unavailable(format!(
            "rtk publishes no build for {} {}",
            std::env::consts::OS,
            std::env::consts::ARCH
        ));
    };

    let url = format!(
        "https://github.com/rtk-ai/rtk/releases/download/{VERSION}/{}",
        asset.name
    );
    let response = match reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(FETCH_TIMEOUT))
        .build()
        .map_err(|e| e.to_string())
    {
        Ok(client) => client.get(&url).send().await,
        Err(message) => return unavailable(format!("rtk could not be downloaded: {message}")),
    };
    let response = match response {
        Ok(response) if response.status().is_success() => response,
        Ok(response) => {
            return unavailable(format!(
                "rtk {VERSION} could not be downloaded: HTTP {}",
                response.status()
            ))
        }
        Err(cause) => return unavailable(format!("rtk could not be downloaded: {cause}")),
    };
    if response.content_length().is_some_and(|n| n as usize > MAX_DOWNLOAD) {
        return unavailable("the rtk download is implausibly large and was refused");
    }
    let archive = match response.bytes().await {
        Ok(bytes) if bytes.len() <= MAX_DOWNLOAD => bytes,
        Ok(_) => return unavailable("the rtk download is implausibly large and was refused"),
        Err(cause) => return unavailable(format!("rtk could not be downloaded: {cause}")),
    };

    // Before anything opens it. A mismatch is a refusal rather than a
    // degradation: bytes that do not match the pin never execute.
    let found = digest(&archive);
    if found != asset.sha256 {
        return unavailable(format!(
            "the rtk download did not match its recorded digest ({found}) and was discarded"
        ));
    }

    if let Err(message) = extract(&archive, &cached) {
        return unavailable(format!("rtk could not be unpacked: {message}"));
    }

    let program = cached.to_string_lossy().to_string();
    match probe(&program).await {
        Some(version) => RtkStatus {
            source: "cached",
            path: Some(program),
            version: Some(version),
            message: None,
        },
        None => unavailable("the downloaded rtk would not run on this machine"),
    }
}

#[cfg(test)]
mod tests {
    use super::{binary_name, digest, ASSETS, VERSION};

    #[test]
    fn every_digest_is_a_sha256() {
        // Not a check that the digests are *right* — nothing offline can be —
        // but a typo that shortens one would otherwise only surface as a failed
        // download on somebody else's platform, which is why this walks the
        // whole table rather than the running target's row.
        for asset in ASSETS {
            assert_eq!(asset.sha256.len(), 64, "{}", asset.name);
            assert!(
                asset.sha256.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()),
                "{} is not lowercase hex",
                asset.name
            );
            assert!(asset.name.starts_with("rtk-"));
        }
    }

    #[test]
    fn no_two_targets_share_an_asset() {
        // A copy-paste that left two rows with the same digest would hand one
        // platform another's binary, and the digest check would happily agree.
        for (index, asset) in ASSETS.iter().enumerate() {
            for other in &ASSETS[index + 1..] {
                assert_ne!((asset.os, asset.arch), (other.os, other.arch));
                assert_ne!(asset.sha256, other.sha256, "{} and {}", asset.name, other.name);
            }
        }
    }

    #[test]
    fn the_pin_is_a_version_not_a_tag() {
        // `latest` would make a pinned digest impossible by construction.
        assert!(VERSION.starts_with('v'));
        assert!(VERSION[1..].split('.').all(|part| part.parse::<u32>().is_ok()));
    }

    #[test]
    fn the_digest_is_lowercase_hex() {
        assert_eq!(
            digest(b""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
    }

    /// The download, the digest and the extractor, against the real release.
    ///
    /// **`#[ignore]` because it reaches the network**, which no ordinary test
    /// run should. It exists because this machine has rtk on `PATH`, so
    /// `rtk_resolve` never reaches its own fetch — and a path that only runs on
    /// a stranger's machine is a path nobody has run. Invoke it deliberately:
    ///
    /// ```text
    /// cargo test --lib -- --ignored --nocapture fetches_and_unpacks
    /// ```
    #[test]
    #[ignore = "reaches the network"]
    fn fetches_and_unpacks_the_pinned_asset() {
        let asset = super::asset().expect("this platform has an asset");
        let url = format!(
            "https://github.com/rtk-ai/rtk/releases/download/{VERSION}/{}",
            asset.name
        );
        let archive = tauri::async_runtime::block_on(async {
            reqwest::get(&url).await.unwrap().bytes().await.unwrap()
        });
        assert_eq!(digest(&archive), asset.sha256, "the recorded digest is stale or wrong");

        let into = std::env::temp_dir()
            .join("rtk-extract-check")
            .join(binary_name());
        let _ = std::fs::remove_file(&into);
        super::extract(&archive, &into).expect("the archive yields a binary");
        let unpacked = std::fs::metadata(&into).expect("and it is on disk");
        assert!(unpacked.len() > 1_000_000, "an rtk binary is megabytes, not bytes");

        // The one claim the extractor makes that a byte count cannot: what came
        // out is a working rtk, by the same test the resolver uses.
        let version = super::probe_blocking(&into.to_string_lossy()).expect("it answers `gain`");
        assert!(version.contains(VERSION.trim_start_matches('v')), "{version}");
        let _ = std::fs::remove_file(&into);
    }

    #[test]
    fn the_windows_binary_carries_its_extension() {
        assert_eq!(binary_name(), if cfg!(windows) { "rtk.exe" } else { "rtk" });
    }
}
