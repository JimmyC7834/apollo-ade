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

use crate::reaper::Reaper;

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
    /// The shell's whole process tree.
    ///
    /// **This was the last spawn point in the app without one**, and `reaper.rs`
    /// named it in its own documentation as the example of the thing it exists
    /// to stop: *"`child.kill()` — what `terminal.rs` does — kills only the
    /// direct child and leaves every descendant running."* Observed exactly that
    /// way while chasing something else: killing the process that owned a PTY
    /// left its `powershell.exe` alive and reparented.
    ///
    /// A user's shell is lower stakes than the build `exec.rs` was protecting
    /// against — nobody's `npm run build` is left running by closing a terminal
    /// pane — but the shape is identical, and a shell is the *easiest* place to
    /// start something long-lived on purpose.
    ///
    /// It also earns something the other consumers get for free: `Reaper` sets
    /// `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, so dropping a `Session` takes the
    /// tree with it whether or not anyone called `terminal_kill`. Closing the
    /// window drops `TerminalState`, which now cleans up after itself.
    reaper: Reaper,
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

    // Adopted immediately after spawn, on the same terms as `exec.rs`: anything
    // the shell starts in the gap is still caught, because job membership is
    // inherited, but the gap is kept as small as the API allows.
    let mut reaper = Reaper::new().ok_or_else(|| "could not create a process job".to_string())?;
    if let Some(pid) = child.process_id() {
        reaper.adopt(pid);
    }

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
            reaper,
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
    // The job first, then the child — the order `lsp::stop` uses, and for the
    // same reason: the reaper is the guarantee rather than the mechanism, it
    // takes the tree whether or not the shell cooperates, and running it first
    // means a wedged direct child cannot delay it. `TerminateJobObject` does not
    // block, so this stays on the command thread.
    session.reaper.kill();
    let killed = session.child.kill().map_err(|e| e.to_string());
    tauri::async_runtime::spawn_blocking(move || drop(session));
    killed
}

#[cfg(test)]
mod tests {
    use super::{shell_command, strip_credentials, CommandBuilder, Mutex, Reaper};
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

    /// Killing the shell takes what the shell started, not just the shell.
    ///
    /// The property `Reaper` exists for, asserted on a *terminal* for the first
    /// time — `reaper.rs` used to name this file as the example of getting it
    /// wrong. A shell is the easiest place in the app to start something
    /// long-lived on purpose, so "closing the pane left it running" is not
    /// hypothetical here.
    ///
    /// **This test is only possible because of the ConPTY handshake.** A pty
    /// will not run anything until something answers its opening `ESC[6n`
    /// cursor-position request — xterm.js does it in the app, and this has to do
    /// it by hand. Without that the shell never reads the command and the test
    /// silently proves nothing, which is exactly how a whole day went.
    ///
    /// Skipped rather than failed when the shell will not cooperate, following
    /// `lsp::tests`: a machine where PowerShell behaves differently is not a
    /// broken build. The grandchild cannot leak even then — `Reaper` sets
    /// `KILL_ON_JOB_CLOSE`, so dropping it on any exit path takes the tree.
    #[test]
    #[cfg(windows)]
    fn killing_the_shell_takes_its_children() {
        use portable_pty::{NativePtySystem, PtySize, PtySystem};
        use std::io::{Read, Write};
        use std::sync::Arc;
        use std::time::{Duration, Instant};

        /// Is this pid still on the machine? `tasklist` rather than `OpenProcess`
        /// so the test stays free of `unsafe`.
        fn alive(pid: u32) -> bool {
            std::process::Command::new("tasklist")
                .args(["/FI", &format!("PID eq {pid}"), "/NH"])
                .output()
                .map(|out| String::from_utf8_lossy(&out.stdout).contains(&pid.to_string()))
                .unwrap_or(false)
        }

        let pair = NativePtySystem::default()
            .openpty(PtySize { rows: 30, cols: 120, pixel_width: 0, pixel_height: 0 })
            .expect("a pty");
        let child = pair.slave.spawn_command(shell_command()).expect("a shell");
        let mut reaper = Reaper::new().expect("a job object");
        if let Some(pid) = child.process_id() {
            reaper.adopt(pid);
        }
        drop(pair.slave);

        let seen = Arc::new(Mutex::new(String::new()));
        let sink = seen.clone();
        let mut reader = pair.master.try_clone_reader().expect("a reader");
        std::thread::spawn(move || {
            let mut buffer = [0u8; 8192];
            while let Ok(n) = reader.read(&mut buffer) {
                if n == 0 {
                    break;
                }
                sink.lock().unwrap().push_str(&String::from_utf8_lossy(&buffer[..n]));
            }
        });

        let mut writer = pair.master.take_writer().expect("a writer");
        std::thread::sleep(Duration::from_millis(2000));
        // "the cursor is at row 1, column 1" — the answer that starts the shell.
        writer.write_all(&[0x1b, b'[', b'1', b';', b'1', b'R']).expect("dsr");
        writer.flush().expect("flush");
        std::thread::sleep(Duration::from_millis(2000));

        writer
            .write_all(
                b"$p = Start-Process powershell -ArgumentList '-NoProfile','-Command',\
                  'Start-Sleep -Seconds 300' -PassThru -WindowStyle Hidden; \
                  Write-Output \"GRANDCHILD=$($p.Id)\"\r",
            )
            .expect("command");
        writer.flush().expect("flush");

        // The pid is printed twice — the echo of what was typed, then the
        // output — so the *last* match is the one that is a number.
        let deadline = Instant::now() + Duration::from_secs(20);
        let mut grandchild = None;
        while Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(500));
            let text = seen.lock().unwrap().clone();
            if let Some(pid) = text
                .rsplit("GRANDCHILD=")
                .filter_map(|rest| {
                    let digits: String = rest.chars().take_while(char::is_ascii_digit).collect();
                    digits.parse::<u32>().ok()
                })
                .next()
            {
                grandchild = Some(pid);
                break;
            }
        }

        let Some(grandchild) = grandchild else {
            reaper.kill();
            eprintln!("SKIPPED: the shell never reported a grandchild pid");
            return;
        };
        assert!(alive(grandchild), "the grandchild {grandchild} should be running");

        reaper.kill();

        // Termination is not instantaneous; the assertion is that it happens.
        let deadline = Instant::now() + Duration::from_secs(10);
        while alive(grandchild) && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(200));
        }
        assert!(
            !alive(grandchild),
            "the grandchild {grandchild} outlived the shell — the job did not take the tree"
        );
    }

    /// Closing a pty that is **mid-stream** returns, and does not take long.
    ///
    /// This replaces a version that was weak in two ways, and the second was
    /// the serious one.
    ///
    /// It killed the shell immediately after spawning it, so the shell had not
    /// finished starting and the pty had nothing buffered — it closed an idle
    /// pty and called that the teardown path. The real `terminal_kill` deadlock
    /// came from a *busy* one, so it exercised the wrong case. This one answers
    /// the `ESC[6n` cursor request the pty opens with (see the probing notes in
    /// OPEN-ISSUES — nothing runs until something answers it), waits for a real
    /// prompt, and only then floods the pty and closes it under load.
    ///
    /// **And it could not fail on the thing it claimed to test.** The shape was
    /// `drop(master); let elapsed = started.elapsed(); assert!(elapsed < 10s)` —
    /// so a close that blocked forever never reached the assertion at all. It
    /// could only catch slow-but-finite, which is the one failure that was never
    /// going to happen. The close now runs on its own thread and the main thread
    /// waits on a channel with a deadline, so a hang fails loudly instead of
    /// hanging the suite.
    ///
    /// What it still cannot reach is the deadlock's own cycle, which needs
    /// Tauri's main thread inside the command while the reader waits on it to
    /// emit; there is no event loop in a unit test. `terminal_kill`'s comment
    /// carries that half.
    #[test]
    fn closing_a_busy_pty_returns() {
        use portable_pty::{NativePtySystem, PtySize, PtySystem};
        use std::io::{Read, Write};
        use std::sync::mpsc;
        use std::sync::Arc;
        use std::time::{Duration, Instant};

        let pair = NativePtySystem::default()
            .openpty(PtySize { rows: 24, cols: 100, pixel_width: 0, pixel_height: 0 })
            .expect("a pty");

        let mut child = pair
            .slave
            .spawn_command(shell_command())
            .expect("a shell — this test needs one on PATH");
        // Adopted so a flooding shell cannot outlive a failed run.
        let mut reaper = Reaper::new().expect("a job object");
        if let Some(pid) = child.process_id() {
            reaper.adopt(pid);
        }
        drop(pair.slave);

        // The drain. Counting bytes as well as consuming them, because "the pty
        // was busy" has to be something the test can assert rather than assume.
        let seen = Arc::new(Mutex::new(String::new()));
        let bytes = Arc::new(Mutex::new(0usize));
        let (text_sink, count_sink) = (seen.clone(), bytes.clone());
        let mut reader = pair.master.try_clone_reader().expect("a reader");
        let pump = std::thread::spawn(move || {
            let mut buffer = [0u8; 8192];
            while let Ok(n) = reader.read(&mut buffer) {
                if n == 0 {
                    break;
                }
                *count_sink.lock().unwrap() += n;
                let mut text = text_sink.lock().unwrap();
                // Only the head is kept; the flood below is megabytes and none
                // of it is interesting after the prompt.
                if text.len() < 4096 {
                    text.push_str(&String::from_utf8_lossy(&buffer[..n]));
                }
            }
        });

        let mut writer = pair.master.take_writer().expect("a writer");
        std::thread::sleep(Duration::from_millis(1500));
        writer.write_all(&[0x1b, b'[', b'1', b';', b'1', b'R']).expect("dsr");
        writer.flush().expect("flush");

        // A prompt is the proof the shell is up. Without it the flood below goes
        // nowhere and the test would close an idle pty again, quietly.
        let deadline = Instant::now() + Duration::from_secs(15);
        while Instant::now() < deadline && !seen.lock().unwrap().contains("PS ") {
            std::thread::sleep(Duration::from_millis(200));
        }
        if !seen.lock().unwrap().contains("PS ") {
            reaper.kill();
            let _ = child.wait();
            eprintln!("SKIPPED: the shell never produced a prompt");
            return;
        }

        // Now make it busy.
        writer
            .write_all(b"1..2000000 | ForEach-Object { \"line $_\" }\r")
            .expect("flood");
        writer.flush().expect("flush");

        /*
         * **Wait for the load, rather than racing a clock against it.**
         *
         * Two earlier shapes of this were wrong, and both were caught by trying
         * to make the test fail on purpose.
         *
         * A byte count after a fixed sleep is a race dressed as a threshold: a
         * warm run moved megabytes and a cold one moved 72 KB, so it failed once
         * and passed once. Flaky is worse than weak.
         *
         * Sampling "did anything move in the last 250ms" is not a race, and it is
         * also not the property — it passes on the *echo of the command that was
         * just typed*. Proved by falsification: replacing the flood with a silent
         * 40-second sleep still passed, because the shell had echoed the line
         * back. It asserted the pty was not stone dead, which was never in doubt.
         *
         * Waiting for a real volume with a generous deadline is neither. It is
         * deterministic — a slow machine takes longer and still arrives — and it
         * is false exactly when nothing is flooding, which is the case this test
         * exists to rule out. The prompt and the echo together are a few hundred
         * bytes, so the bar sits far above them.
         */
        const BUSY_BYTES: usize = 100_000;
        let deadline = Instant::now() + Duration::from_secs(25);
        while *bytes.lock().unwrap() < BUSY_BYTES && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(100));
        }
        let streamed = *bytes.lock().unwrap();
        assert!(
            streamed >= BUSY_BYTES,
            "the pty should be under load before the close; only {streamed} bytes \
             streamed in 25s, so this would have closed an idle pty"
        );

        // The close, on its own thread, so a hang is a failure rather than a
        // hung suite. This is the part the old test got wrong.
        let (done, finished) = mpsc::channel();
        let master = pair.master;
        child.kill().expect("kill");
        std::thread::spawn(move || {
            let started = Instant::now();
            drop(master);
            let _ = done.send(started.elapsed());
        });

        match finished.recv_timeout(Duration::from_secs(15)) {
            Ok(elapsed) => assert!(
                elapsed.as_secs() < 10,
                "closing a busy pty took {elapsed:?}"
            ),
            Err(_) => panic!(
                "closing a busy pty never returned — {streamed} bytes had streamed. \
                 This is the shape of the `terminal_kill` deadlock."
            ),
        }

        reaper.kill();
        let _ = child.wait();
        let _ = pump.join();
    }
}
