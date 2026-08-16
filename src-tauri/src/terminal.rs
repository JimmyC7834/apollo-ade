//! Native PTY sessions.
//!
//! Rust owns every process handle: the frontend holds only an opaque session
//! id, and can write, resize, and kill through it. Output and exit travel back
//! as events rather than as command results, because a shell produces bytes
//! whenever it likes, not when it is asked.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};

use portable_pty::{Child, CommandBuilder, MasterPty, NativePtySystem, PtySize, PtySystem};
use serde::Serialize;
use tauri::{AppHandle, Emitter};

pub const OUTPUT_EVENT: &str = "terminal://output";
pub const EXIT_EVENT: &str = "terminal://exit";

/// The shell is hardcoded. Cross-platform discovery is not implemented; this
/// prototype targets Windows, and `-NoProfile` keeps startup deterministic.
#[cfg(windows)]
const SHELL: [&str; 3] = ["powershell.exe", "-NoLogo", "-NoProfile"];
#[cfg(not(windows))]
const SHELL: [&str; 1] = ["/bin/sh"];

/// Take the app's API keys out of a child's environment.
///
/// **The rule is about children, not about which child.** `exec.rs`, `lsp.rs`
/// and `rtk.rs` each say so and each do it; this was the one that did not, and
/// the omission was never a decision — it was simply missed, which is why the
/// review found it as an inconsistency rather than as a policy.
///
/// The case for leaving it alone was real and was considered: the keys are set
/// with `setx`, so the user's own shell has them regardless, and this terminal is
/// the *user's* rather than the agent's. What settles it the other way is that
/// this shell prints into the renderer. `exec.rs`'s comment records that `echo
/// $DEEPSEEK_API_KEY` putting the key straight into the transcript is what
/// motivated the strip in the first place, and a PTY pane is the same surface
/// with a different frame around it. A user who wants their key in a shell has
/// every other shell on the machine.
///
/// Targeted, not `env_clear`: the shell still inherits `PATH`, `HOME` and
/// everything else, because a terminal that starts without the user's
/// environment is a terminal nobody can use.
fn strip_credentials(command: &mut CommandBuilder) {
    for name in crate::provider::CREDENTIAL_VARS {
        command.env_remove(name);
    }
}

/// The shell this app starts, minus the app's credentials.
///
/// Everything but the working directory, which `terminal_create` adds because it
/// is the only caller that has a workspace to add. Split out so the test below
/// can spawn **the same command the app spawns** — a strip asserted only against
/// a builder the app does not use would be asserting a copy of the code.
fn shell_command() -> CommandBuilder {
    let mut command = CommandBuilder::new(SHELL[0]);
    for arg in &SHELL[1..] {
        command.arg(arg);
    }
    strip_credentials(&mut command);
    command
}

struct Session {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send + Sync>,
}

#[derive(Default)]
pub struct TerminalState(Mutex<HashMap<String, Session>>);

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Output {
    id: String,
    /// Raw shell bytes, lossily decoded. xterm.js re-parses the escape codes.
    data: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Exit {
    id: String,
    code: Option<u32>,
}

#[tauri::command]
pub fn terminal_create(
    id: String,
    cols: u16,
    rows: u16,
    app: AppHandle,
    state: tauri::State<'_, TerminalState>,
    workspace: tauri::State<'_, crate::workspace::WorkspaceState>,
) -> Result<(), String> {
    let size = PtySize {
        rows: rows.max(1),
        cols: cols.max(1),
        pixel_width: 0,
        pixel_height: 0,
    };
    let pair = NativePtySystem::default()
        .openpty(size)
        .map_err(|e| e.to_string())?;

    let mut command = shell_command();
    // The shell starts in the workspace root, which Rust reads from its own
    // state rather than taking from the renderer. A directory named by page
    // script is a directory the untrusted side chose to run a shell in, and
    // that is the same hole `choose_workspace` closes for the file surface.
    // With no workspace selected the shell inherits the app's directory.
    if let Ok(root) = crate::workspace::root_of(&workspace) {
        command.cwd(root);
    }
    let child = pair.slave.spawn_command(command).map_err(|e| e.to_string())?;
    // The slave is dropped here on purpose: while this process still holds it
    // open, the reader below would never see EOF when the shell exits.
    drop(pair.slave);

    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;

    // One blocking reader thread per session. `read` is the only way to learn
    // that the shell produced output, and it cannot be polled from async.
    let pump = Arc::new(app);
    let pump_id = id.clone();
    std::thread::spawn(move || {
        let mut buffer = [0u8; 8192];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let data = String::from_utf8_lossy(&buffer[..n]).into_owned();
                    if pump
                        .emit(
                            OUTPUT_EVENT,
                            Output {
                                id: pump_id.clone(),
                                data,
                            },
                        )
                        .is_err()
                    {
                        break; // The window is gone; nothing left to feed.
                    }
                }
            }
        }
        let _ = pump.emit(
            EXIT_EVENT,
            Exit {
                id: pump_id,
                code: None,
            },
        );
    });

    state.0.lock().unwrap().insert(
        id,
        Session {
            master: pair.master,
            writer,
            child,
        },
    );
    Ok(())
}

#[tauri::command]
pub fn terminal_write(
    id: String,
    data: String,
    state: tauri::State<'_, TerminalState>,
) -> Result<(), String> {
    let mut sessions = state.0.lock().unwrap();
    let session = sessions.get_mut(&id).ok_or("no such terminal")?;
    session
        .writer
        .write_all(data.as_bytes())
        .map_err(|e| e.to_string())?;
    session.writer.flush().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn terminal_resize(
    id: String,
    cols: u16,
    rows: u16,
    state: tauri::State<'_, TerminalState>,
) -> Result<(), String> {
    let sessions = state.0.lock().unwrap();
    let session = sessions.get(&id).ok_or("no such terminal")?;
    session
        .master
        .resize(PtySize {
            rows: rows.max(1),
            cols: cols.max(1),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())
}

/// Kill the shell and forget the session. The reader thread ends on its own
/// once the PTY closes, and emits the exit event as it goes.
///
/// **Closing the pty is done off this thread, and that is the whole fix.** This
/// command used to hang — reliably, on the first call — and because a
/// synchronous command holds Tauri's dispatcher, every later `invoke` from the
/// page hung behind it. The window went unresponsive and looked exactly like a
/// stalled debugger connection, which is what it was blamed on three times.
///
/// The kill is not the slow part: `WinChild::kill` is `TerminateProcess` and no
/// wait. The slow part is the **drop**. `Session` owns the master, a
/// `ConPtyMasterPty` is an `Arc<Mutex<Inner>>` holding a `PsuedoCon`, and
/// `PsuedoCon::drop` calls `ClosePseudoConsole` — which waits for the pty's
/// output to be drained. The only thing draining it is our reader thread, and
/// that thread spends its time in `app.emit(…)`, which needs the main thread —
/// the thread now sitting inside this command. Each waits for the other.
///
/// So the teardown is handed to a blocking task and this returns. It is the
/// sibling of the lesson `exec.rs` already wrote down about killing a shell and
/// then waiting on its pipes: *waiting for EOF is waiting for the wrong event.*
/// Here the wrong event is the close, and the fix is the same shape — stop
/// waiting on the dispatcher for something the dispatcher has to service.
///
/// The kill itself stays here, so the caller still gets a real answer about the
/// thing it asked for. Nothing is lost by detaching the rest: the session is
/// already out of the map, so it is unreachable, and the reader emits the exit
/// event as it winds down.
#[tauri::command]
pub fn terminal_kill(id: String, state: tauri::State<'_, TerminalState>) -> Result<(), String> {
    // Scoped so the map's lock is released before anything else happens — a
    // teardown holding it would block `terminal_create` for a new pane.
    let session = state.0.lock().unwrap().remove(&id);
    let Some(mut session) = session else {
        return Ok(()); // Already gone; killing twice is not an error.
    };
    let killed = session.child.kill().map_err(|e| e.to_string());
    tauri::async_runtime::spawn_blocking(move || drop(session));
    killed
}

#[cfg(test)]
mod tests {
    use super::{shell_command, strip_credentials, CommandBuilder};
    use crate::provider::CREDENTIAL_VARS;
    use std::ffi::OsStr;

    /// Every credential goes, and nothing else does.
    ///
    /// **The control variable is the half that makes this a test.** Asserting
    /// only that the keys are absent passes on any machine where they were never
    /// set — and passes just as well against `env_clear`, which would leave the
    /// shell with no `PATH`. Proving that a neighbouring variable survives is
    /// what distinguishes "removed these" from "removed everything" and from
    /// "there was nothing there".
    ///
    /// Built on a `CommandBuilder` with known values rather than by setting real
    /// process variables: `CommandBuilder::new` snapshots the environment, so a
    /// test that mutated it would be mutating shared state under whichever other
    /// test happens to be spawning a child at the time.
    #[test]
    fn the_credentials_are_removed_from_the_builder() {
        let mut command = CommandBuilder::new("shell");
        command.env("ADE_CONTROL", "survives");
        for name in CREDENTIAL_VARS {
            command.env(name, "sentinel-must-not-reach-the-shell");
        }

        strip_credentials(&mut command);

        assert_eq!(
            command.get_env("ADE_CONTROL"),
            Some(OsStr::new("survives")),
            "the shell must still inherit the user's environment, or this proves nothing"
        );
        for name in CREDENTIAL_VARS {
            assert!(command.get_env(name).is_none(), "{name} reached the shell");
        }
    }

    /// And the command the app *actually spawns* is the stripped one.
    ///
    /// The test above proves `strip_credentials` works on a builder that
    /// certainly had the keys; this proves `terminal_create`'s own builder is
    /// one that went through it, so neither is asserting a copy of the other's
    /// code. Together they cover the two ways this could be wrong: the strip not
    /// working, and the strip not being called.
    ///
    /// `PATH` is the control. Without it this passes just as happily against an
    /// `env_clear`, which would hand the user a shell with no tools on it.
    #[test]
    fn the_shell_this_app_starts_carries_no_credentials() {
        let command = shell_command();

        assert!(
            command.get_env("PATH").is_some() || command.get_env("Path").is_some(),
            "the shell lost PATH — that is env_clear, not a targeted strip"
        );

        // Whether this process even has a key to lose. It normally does — they
        // are set with `setx`, so a `cargo test` inherits them — but saying so
        // out loud is what stops a green run on a bare machine being read as
        // evidence it did.
        let mut had_one = false;
        for name in CREDENTIAL_VARS {
            if std::env::var(name).is_ok_and(|value| !value.trim().is_empty()) {
                had_one = true;
            }
            assert!(command.get_env(name).is_none(), "{name} reached the shell");
        }
        if !had_one {
            eprintln!(
                "NOTE: no credential is set in this process, so the assertions above are \
                 vacuous here. `the_credentials_are_removed_from_the_builder` is not."
            );
        }
    }

    /// Killing a real shell and closing its pty finishes, and does not take long.
    ///
    /// **This covers half of the deadlock and the comment on `terminal_kill`
    /// says which half.** The bug needs Tauri's main thread to be inside the
    /// command while the reader thread waits on it to emit, and there is no
    /// event loop in a unit test — so the cycle cannot form here. What this does
    /// hold is the other end: with something draining the pty, kill-then-drop
    /// completes promptly. If `ClosePseudoConsole` ever became slow on its own,
    /// rather than slow because of who was waiting, this is what would say so.
    ///
    /// Modelled on `lsp::tests::stop_ends_a_real_server`, for the same reason: a
    /// teardown that only *eventually* completes is the failure worth catching,
    /// so returning at all is the assertion and the bound catches the rest.
    #[test]
    fn killing_a_shell_and_closing_its_pty_completes() {
        use portable_pty::{NativePtySystem, PtySize, PtySystem};
        use std::io::Read;
        use std::time::Instant;

        let pair = NativePtySystem::default()
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .expect("a pty");

        let mut child = pair
            .slave
            .spawn_command(shell_command())
            .expect("a shell — this test needs one on PATH");
        drop(pair.slave);

        // The drain, which is the condition the close needs. Without a reader
        // this test would be asserting something else entirely.
        let mut reader = pair.master.try_clone_reader().expect("a reader");
        let pump = std::thread::spawn(move || {
            let mut buffer = [0u8; 8192];
            while let Ok(n) = reader.read(&mut buffer) {
                if n == 0 {
                    break;
                }
            }
        });

        let started = Instant::now();
        child.kill().expect("kill");
        drop(pair.master);
        let elapsed = started.elapsed();

        assert!(
            elapsed.as_secs() < 10,
            "kill and close should not block: took {elapsed:?}"
        );
        let _ = child.wait();
        let _ = pump.join();
    }
}
