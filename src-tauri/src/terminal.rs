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
    cwd: Option<String>,
    app: AppHandle,
    state: tauri::State<'_, TerminalState>,
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

    let mut command = CommandBuilder::new(SHELL[0]);
    for arg in &SHELL[1..] {
        command.arg(arg);
    }
    if let Some(cwd) = cwd {
        command.cwd(cwd);
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
#[tauri::command]
pub fn terminal_kill(id: String, state: tauri::State<'_, TerminalState>) -> Result<(), String> {
    let Some(mut session) = state.0.lock().unwrap().remove(&id) else {
        return Ok(()); // Already gone; killing twice is not an error.
    };
    session.child.kill().map_err(|e| e.to_string())
}
