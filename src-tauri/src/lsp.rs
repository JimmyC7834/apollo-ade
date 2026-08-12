//! Language servers — ticket 33.
//!
//! **Rust owns the process; JavaScript owns the protocol.** That split is the
//! one design decision in this file and it is worth stating, because "Rust owns
//! the process authority" could be read as "Rust speaks LSP".
//!
//! What has to be here is what only Rust can do: spawn a long-lived child, hold
//! its stdin and stdout open in both directions for the life of the window,
//! strip credentials from its environment, confine its working directory to the
//! workspace root, and kill the whole tree when the window goes. What does
//! *not* have to be here is JSON-RPC correlation, the `initialize` handshake,
//! capability negotiation, or position arithmetic — all of which are pure
//! logic that has to reach Monaco anyway, and all of which are cheaper to write
//! and to check in TypeScript. Putting them here would mean a second
//! serialisation of every message and a Rust-side model of the editor's state.
//!
//! So this module carries **framing and nothing above it**. It reads
//! `Content-Length` headers off stdout, hands the JSON body up as an opaque
//! string, and writes framed bodies back down. It never parses one.
//!
//! `terminal.rs` is the nearest relative — a long-lived child whose output
//! arrives whenever it likes and therefore travels as events rather than as
//! command results. `exec.rs` is not: it spawns, captures and exits.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::reaper::Reaper;

pub const MESSAGE_EVENT: &str = "lsp://message";
pub const EXIT_EVENT: &str = "lsp://exit";

/// Which binary serves which language, and the argv it is started with.
///
/// **Hardcoded, for the same reason `terminal.rs` hardcodes the shell.** The
/// renderer names a *language*, never a command line: a start call that carried
/// an argv would be page script choosing a program for this app to run, which
/// is exactly the hole `choose_workspace` closes for the file surface. Adding a
/// server is a change here, deliberately.
///
/// One entry, on purpose. Ticket 33 is a tracer bullet: `rust-analyzer` because
/// it is what this repo is written in that Monaco's TypeScript worker does not
/// cover, and because it is the hardest — slow to start and enormous to index,
/// which is the right thing to find out first rather than last.
const SERVERS: [(&str, &[&str]); 1] = [("rust", &["rust-analyzer"])];

fn argv_for(language: &str) -> Option<&'static [&'static str]> {
    SERVERS
        .iter()
        .find(|(name, _)| *name == language)
        .map(|(_, argv)| *argv)
}

struct Server {
    stdin: ChildStdin,
    child: Child,
    /// The server's whole process tree. `rust-analyzer` runs `cargo` and
    /// `rustc` while it indexes, so killing only the direct child leaves a
    /// build running — the failure `exec.rs` already found once.
    reaper: Reaper,
}

#[derive(Default)]
pub struct LspState(Mutex<HashMap<String, Server>>);

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Message {
    language: String,
    /// One JSON-RPC message, still as text. Rust does not parse it.
    body: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Exit {
    language: String,
    /// Absent when the server was stopped on purpose, or when the exit status
    /// could not be read. The frontend distinguishes the two by whether it
    /// asked.
    code: Option<i32>,
}

/// Start a language server for `language`, or say why not.
///
/// Starting one that is already running is not an error and does not restart
/// it; the frontend restarts by stopping first, which keeps "is it up" a
/// question with one answer.
#[tauri::command]
pub fn lsp_start(
    language: String,
    app: AppHandle,
    state: tauri::State<'_, LspState>,
    workspace: tauri::State<'_, crate::workspace::WorkspaceState>,
) -> Result<(), String> {
    let argv = argv_for(&language).ok_or_else(|| format!("no language server for {language}"))?;
    if state.0.lock().unwrap().contains_key(&language) {
        return Ok(());
    }

    // The root comes from Rust's own state, never from the renderer — same rule
    // as the terminal's cwd. A server initialised against a directory page
    // script named is a server indexing wherever page script pointed it.
    let root = crate::workspace::root_of(&workspace)?;

    let mut command = Command::new(argv[0]);
    command.args(&argv[1..]);
    command.current_dir(root);
    // A language server is a child this app starts, so it is held to the same
    // rule as `agent_exec`: no credential reaches it. rust-analyzer has no use
    // for an API key, and that is not the point — the point is that the rule is
    // about children, not about which child.
    for name in crate::provider::CREDENTIAL_VARS {
        command.env_remove(name);
    }
    command.stdin(Stdio::piped());
    command.stdout(Stdio::piped());
    command.stderr(Stdio::piped());
    #[cfg(not(windows))]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }

    let mut child = command.spawn().map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            // The one error the frontend renders specially, so "you have not
            // installed it" does not read as "it crashed".
            format!("{} is not installed, or not on PATH", argv[0])
        } else {
            e.to_string()
        }
    })?;

    let mut reaper = Reaper::new().ok_or_else(|| {
        let _ = child.kill();
        "could not create a process job".to_string()
    })?;
    reaper.adopt(child.id());

    let stdin = child.stdin.take().ok_or("no stdin")?;
    let stdout = child.stdout.take().ok_or("no stdout")?;
    let stderr = child.stderr.take().ok_or("no stderr")?;

    // Two blocking reader threads, because both pipes have to be drained.
    // Nothing reads the server's log, but a full stderr pipe blocks the server
    // itself — rust-analyzer is chatty enough to fill one during indexing.
    std::thread::spawn(move || {
        let mut sink = [0u8; 4096];
        let mut stderr = stderr;
        while matches!(stderr.read(&mut sink), Ok(n) if n > 0) {}
    });

    let pump = Arc::new(app);
    let pump_language = language.clone();
    std::thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        loop {
            match read_frame(&mut reader) {
                Ok(Some(body)) => {
                    if pump
                        .emit(
                            MESSAGE_EVENT,
                            Message {
                                language: pump_language.clone(),
                                body,
                            },
                        )
                        .is_err()
                    {
                        break; // The window is gone.
                    }
                }
                // EOF, or a frame this loop cannot resynchronise from. Either
                // way the conversation is over; the exit below reports it.
                Ok(None) | Err(_) => break,
            }
        }
        let _ = pump.emit(
            EXIT_EVENT,
            Exit {
                language: pump_language,
                code: None,
            },
        );
    });

    state.0.lock().unwrap().insert(
        language,
        Server {
            stdin,
            child,
            reaper,
        },
    );
    Ok(())
}

/// Send one JSON-RPC message, framed. `body` is written verbatim.
#[tauri::command]
pub fn lsp_send(
    language: String,
    body: String,
    state: tauri::State<'_, LspState>,
) -> Result<(), String> {
    let mut servers = state.0.lock().unwrap();
    let server = servers
        .get_mut(&language)
        .ok_or("no language server running")?;
    // Content-Length counts bytes, not characters. `body.len()` is the byte
    // length of a Rust string, which is what the header wants — a `chars()`
    // count would truncate every message containing a non-ASCII identifier.
    write!(server.stdin, "Content-Length: {}\r\n\r\n", body.len()).map_err(|e| e.to_string())?;
    server
        .stdin
        .write_all(body.as_bytes())
        .map_err(|e| e.to_string())?;
    server.stdin.flush().map_err(|e| e.to_string())
}

/// Stop a server and forget it. Stopping one that is not running is not an
/// error, so a restart never has to check first.
#[tauri::command]
pub fn lsp_stop(language: String, state: tauri::State<'_, LspState>) -> Result<(), String> {
    if let Some(server) = state.0.lock().unwrap().remove(&language) {
        stop(server);
    }
    Ok(())
}

fn stop(mut server: Server) {
    // Closing stdin first is what a well-behaved client does after `exit`: the
    // server sees EOF and leaves on its own. The reaper is the guarantee, not
    // the mechanism — it takes the tree whether or not the server cooperates.
    drop(server.stdin);
    server.reaper.kill();
    let _ = server.child.kill();
    let _ = server.child.wait();
}

/// Kill every server. Called as the app exits, which is the only reliable
/// moment: a `rust-analyzer` that outlives its window is a gigabyte of resident
/// memory with nothing left to talk to.
pub fn shutdown_all(app: &AppHandle) {
    let state = app.state::<LspState>();
    let servers = std::mem::take(&mut *state.0.lock().unwrap());
    for (_, server) in servers {
        stop(server);
    }
}

/// One `Content-Length`-framed message, or `None` at end of stream.
///
/// Headers are ASCII and terminated by a blank line; the body that follows is
/// exactly as many bytes as the header said. Anything other than
/// `Content-Length` — `Content-Type` is the only one servers send — is read and
/// dropped, because a header this client does not understand is not a reason to
/// desynchronise the stream.
fn read_frame(reader: &mut impl BufRead) -> std::io::Result<Option<String>> {
    let mut length: Option<usize> = None;
    let mut line = String::new();
    loop {
        line.clear();
        if reader.read_line(&mut line)? == 0 {
            return Ok(None); // EOF between messages: a clean end.
        }
        let trimmed = line.trim_end_matches(['\r', '\n']);
        if trimmed.is_empty() {
            break; // Blank line: headers are over.
        }
        if let Some(value) = trimmed
            .strip_prefix("Content-Length:")
            .or_else(|| trimmed.strip_prefix("content-length:"))
        {
            length = value.trim().parse().ok();
        }
    }

    let Some(length) = length else {
        // Headers with no length: there is no way to know where the body ends,
        // so there is no way to find the next message either. Give up rather
        // than guess, and let the caller report the server as gone.
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "message without Content-Length",
        ));
    };

    let mut body = vec![0u8; length];
    reader.read_exact(&mut body)?;
    String::from_utf8(body)
        .map(Some)
        .map_err(|_| std::io::Error::new(std::io::ErrorKind::InvalidData, "message is not UTF-8"))
}

#[cfg(test)]
mod tests {
    use super::{read_frame, stop, Reaper, Server};
    use std::io::BufReader;

    fn frames(input: &str) -> Vec<String> {
        let mut reader = BufReader::new(input.as_bytes());
        let mut out = Vec::new();
        while let Ok(Some(body)) = read_frame(&mut reader) {
            out.push(body);
        }
        out
    }

    #[test]
    fn reads_consecutive_messages() {
        assert_eq!(
            frames("Content-Length: 2\r\n\r\n{}Content-Length: 5\r\n\r\n[1,2]"),
            vec!["{}".to_string(), "[1,2]".to_string()]
        );
    }

    #[test]
    fn ignores_other_headers() {
        assert_eq!(
            frames("Content-Type: application/vscode-jsonrpc\r\nContent-Length: 2\r\n\r\n{}"),
            vec!["{}".to_string()]
        );
    }

    #[test]
    fn counts_bytes_not_characters() {
        // "é" is two bytes and one character. A char-counting reader would stop
        // one byte short here and desynchronise every message after it.
        let body = "\"é\"";
        let input = format!("Content-Length: {}\r\n\r\n{body}", body.len());
        assert_eq!(frames(&input), vec![body.to_string()]);
    }

    #[test]
    fn empty_stream_is_a_clean_end() {
        assert!(frames("").is_empty());
    }

    /// The framing, against the real thing.
    ///
    /// The tests above are the arithmetic; this is the only one that proves a
    /// language server can actually be spoken to — spawn `rust-analyzer`, write
    /// one `initialize` frame the way `lsp_send` does, and read its reply back
    /// with `read_frame`. It does not use the handshake, which lives in
    /// TypeScript; it uses the one message needed to make the server answer.
    ///
    /// **Skipped rather than failed when the server is not usable here.** A
    /// machine without `rust-analyzer` is the ticket's `missing` state, not a
    /// broken build, and a test that failed there would be testing the
    /// developer's toolchain. Two shapes of unusable have to be told apart, and
    /// the second is the one that cost an afternoon: `~/.cargo/bin/
    /// rust-analyzer.exe` exists on any rustup install as a **shim**, so the
    /// spawn succeeds and the process then exits with *"Unknown binary
    /// 'rust-analyzer.exe' in official toolchain"* unless
    /// `rustup component add rust-analyzer` has been run. The skip is therefore
    /// conditioned on the child having *died*, not on the spawn having failed —
    /// a server that is alive and did not answer is a real failure and is
    /// reported as one.
    #[test]
    fn speaks_to_a_real_language_server() {
        use std::io::Write;
        use std::process::{Command, Stdio};

        let Ok(mut child) = Command::new("rust-analyzer")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
        else {
            eprintln!("SKIPPED: rust-analyzer is not on PATH");
            return;
        };

        let body = r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"processId":null,"rootUri":null,"capabilities":{}}}"#;
        {
            let stdin = child.stdin.as_mut().expect("stdin");
            write!(stdin, "Content-Length: {}\r\n\r\n", body.len()).expect("header");
            stdin.write_all(body.as_bytes()).expect("body");
            stdin.flush().expect("flush");
        }

        let mut reader = BufReader::new(child.stdout.take().expect("stdout"));
        let mut reply = None;
        let mut ended = false;
        // The server may send progress notifications before the reply, so read
        // until the correlated one arrives rather than assuming it is first.
        for _ in 0..20 {
            match read_frame(&mut reader) {
                Ok(Some(frame)) if frame.contains("\"id\":1") => {
                    reply = Some(frame);
                    break;
                }
                Ok(Some(_)) => continue,
                Ok(None) | Err(_) => {
                    ended = true;
                    break;
                }
            }
        }

        // Whether the stream ended is what tells a missing component apart from
        // a framing bug — and it is the stream, not `try_wait`, that has to be
        // asked: stdout reaches EOF a moment before the process is reaped, so a
        // status check here races and reports the server as still alive.
        let _ = child.kill();
        let _ = child.wait();

        if reply.is_none() && ended {
            eprintln!(
                "SKIPPED: rust-analyzer exited without answering. \
                 Run `rustup component add rust-analyzer` to make this test real."
            );
            return;
        }

        let reply = reply.expect("rust-analyzer is running but did not answer initialize");
        assert!(
            reply.contains("capabilities"),
            "the reply should advertise capabilities: {reply}"
        );
    }

    /// `stop` ends a real server, and does not hang doing it.
    ///
    /// The criterion this stands in for is *"closing the app leaves no orphaned
    /// server process"*. What it proves is the half that is this module's:
    /// `shutdown_all` calls `stop`, and `stop` returns having reaped the child.
    /// The other half — that `RunEvent::Exit` fires — is Tauri's, and a unit
    /// test cannot raise it.
    ///
    /// A language server is exactly the right subject: `rust-analyzer` with an
    /// idle stdin waits forever, so a `stop` that only closed the pipe and
    /// hoped would hang here rather than pass.
    #[test]
    fn stop_ends_a_real_server() {
        use std::process::{Command, Stdio};
        use std::time::Instant;

        let Ok(mut child) = Command::new("rust-analyzer")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
        else {
            eprintln!("SKIPPED: rust-analyzer is not on PATH");
            return;
        };

        let Some(mut reaper) = Reaper::new() else {
            panic!("could not create a process job");
        };
        reaper.adopt(child.id());
        let stdin = child.stdin.take().expect("stdin");

        let started = Instant::now();
        stop(Server {
            stdin,
            child,
            reaper,
        });
        // `stop` waits on the child, so returning at all is the assertion. The
        // bound catches a wait that only *eventually* completes.
        assert!(
            started.elapsed().as_secs() < 10,
            "stop should not block: took {:?}",
            started.elapsed()
        );
    }
}
