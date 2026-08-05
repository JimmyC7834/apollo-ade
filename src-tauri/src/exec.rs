//! One-shot command execution for the agent.
//!
//! Not a terminal. `terminal.rs` owns the PTY the *user* types into and keeps
//! its job; this runs a single command, streams what it prints, and returns
//! when it exits. The two share nothing on purpose — a PTY is interactive and
//! long-lived, this is neither.
//!
//! **Policy, stated plainly: the working directory is confined, the command is
//! not.** Rust refuses a `cwd` outside the workspace and starts the child
//! inside it, then does not police what the command does next — `cd /` works,
//! absolute paths work. This is the deviation from `context.md`'s "Rust is the
//! only filesystem/process authority; it stays root-confined" that
//! docs/wayfinder/pi-harness/tickets/02-exec-not-terminal.md records and
//! accepts: a shell can always reach the filesystem, and a partial sandbox that
//! reads as absolute is worse than an honest boundary. Containment for what a
//! command *does* belongs to the permission gate.

use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tauri::Manager;

use crate::workspace::{root_of, WorkspaceState};

/// Ceiling on what crosses the IPC, per stream.
///
/// pi truncates what the *model* sees, but the raw bytes reach the renderer
/// first. A command that prints hundreds of megabytes is cut off here, and the
/// cut is reported rather than swallowed.
const MAX_CAPTURE_BYTES: usize = 8 * 1024 * 1024;

#[derive(Default)]
pub struct ExecState(Mutex<HashMap<String, Running>>);

struct Running {
    reaper: Reaper,
    cancelled: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecRequest {
    #[serde(default)]
    command: String,
    /// Spawn this argv **directly, with no shell**, ignoring `command`.
    ///
    /// The user-tool path
    /// (docs/wayfinder/pi-harness/tickets/13-user-authored-tools.md). A manifest
    /// declares argv as an array and parameters fill whole elements, so nothing
    /// is ever re-parsed, word-split or glob-expanded — which is the whole
    /// reason the amendment on that ticket replaced command strings. Handing
    /// the same argv to a shell as a joined string would put the injection hole
    /// straight back.
    ///
    /// Everything else below is shared: the same cwd confinement, the same job
    /// object, the same timeout and the same streaming.
    argv: Option<Vec<String>>,
    /// Root-relative, like every other path the renderer sends.
    cwd: Option<String>,
    #[serde(default)]
    env: HashMap<String, String>,
    #[serde(default = "yes")]
    inherit_env: bool,
    /// Seconds. pi's contract: no default.
    timeout: Option<u64>,
}

fn yes() -> bool {
    true
}

#[derive(Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ExecEvent {
    Stdout { chunk: String },
    Stderr { chunk: String },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecOutcome {
    stdout: String,
    stderr: String,
    exit_code: i32,
    /// True when either stream hit `MAX_CAPTURE_BYTES`.
    truncated: bool,
}

/// Carries pi's error code, which is a fixed vocabulary rather than free text:
/// `aborted | timeout | shell_unavailable | spawn_error | callback_error | unknown`.
#[derive(Serialize)]
pub struct ExecFailure {
    code: &'static str,
    message: String,
}

fn fail(code: &'static str, message: impl Into<String>) -> ExecFailure {
    ExecFailure {
        code,
        message: message.into(),
    }
}

/// The shell to run commands with, resolved once.
///
/// pi names the tool `bash` and describes it as "Execute a bash command", so
/// models emit POSIX syntax at it. Git Bash is the only Windows option that
/// does not fight that; PowerShell is a fallback that will mis-handle a good
/// fraction of what a model writes, which is why the resolved shell is stated
/// in the system prompt rather than assumed.
fn shell() -> Option<&'static (PathBuf, &'static str)> {
    static SHELL: OnceLock<Option<(PathBuf, &'static str)>> = OnceLock::new();
    SHELL
        .get_or_init(|| {
            #[cfg(windows)]
            {
                let candidates = [
                    r"C:\Program Files\Git\bin\bash.exe",
                    r"C:\Program Files (x86)\Git\bin\bash.exe",
                ];
                for path in candidates {
                    let path = PathBuf::from(path);
                    if path.is_file() {
                        return Some((path, "bash"));
                    }
                }
                // Anything on PATH — a scoop/winget Git, or WSL's bash.
                if let Ok(output) = Command::new("where").arg("bash.exe").output() {
                    if let Some(first) = String::from_utf8_lossy(&output.stdout).lines().next() {
                        let path = PathBuf::from(first.trim());
                        if path.is_file() {
                            return Some((path, "bash"));
                        }
                    }
                }
                let powershell = PathBuf::from("powershell.exe");
                return Some((powershell, "powershell"));
            }
            #[cfg(not(windows))]
            {
                Some((PathBuf::from("/bin/bash"), "bash"))
            }
        })
        .as_ref()
}

/// Which shell the agent got, for the system prompt.
///
/// Behaviour varies by machine — a box without Git Bash runs PowerShell and
/// POSIX one-liners fail there. Telling the model which it has is cheaper than
/// letting it find out one failed command at a time.
#[tauri::command]
pub fn agent_shell() -> Option<&'static str> {
    shell().map(|(_, name)| *name)
}

/// Everything one command started, killable as a unit.
///
/// **Three mechanisms were tried before this one, and the first two look like
/// they work.**
///
/// `child.kill()` — what `terminal.rs` does — kills only the direct child and
/// leaves every descendant running.
///
/// `taskkill /F /T` prints SUCCESS for each process it kills and still leaves
/// grandchildren behind, because it kills a process before enumerating that
/// process's children.
///
/// Enumerating the tree first and killing leaves-first *also* fails here, and
/// this is the finding that settles it: Git Bash's fork emulation spawns
/// intermediate processes that exit immediately, so a `sleep` under
/// `bash -lc` ends up with a **parent id that no longer resolves to any
/// process**. Measured directly — `ppid=9568, parentName=<GONE>` while the
/// sleep was still running. No walk from our root pid can reach it, because the
/// chain is already broken.
///
/// A job object does not care about parentage: every process created inside it
/// belongs to it, orphaned or not, and `TerminateJobObject` takes the lot.
#[cfg(windows)]
struct Reaper(windows_sys::Win32::Foundation::HANDLE);

#[cfg(windows)]
// The handle is owned by this struct and only ever used through it. Tauri moves
// it between threads with the rest of the run state.
unsafe impl Send for Reaper {}

#[cfg(windows)]
impl Reaper {
    fn new() -> Option<Self> {
        use std::mem::{size_of, zeroed};
        use windows_sys::Win32::System::JobObjects::{
            JobObjectExtendedLimitInformation, SetInformationJobObject, CreateJobObjectW,
            JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        };

        unsafe {
            let handle = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if handle.is_null() {
                return None;
            }
            // Kill on close as well as on demand, so a panic or an early return
            // cannot leak the tree either.
            let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = zeroed();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            SetInformationJobObject(
                handle,
                JobObjectExtendedLimitInformation,
                &limits as *const _ as *const std::ffi::c_void,
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            );
            Some(Self(handle))
        }
    }

    fn adopt(&self, pid: u32) {
        use windows_sys::Win32::Foundation::CloseHandle;
        use windows_sys::Win32::System::JobObjects::AssignProcessToJobObject;
        use windows_sys::Win32::System::Threading::{
            OpenProcess, PROCESS_SET_QUOTA, PROCESS_TERMINATE,
        };

        unsafe {
            let process = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid);
            if process.is_null() {
                return;
            }
            AssignProcessToJobObject(self.0, process);
            CloseHandle(process);
        }
    }

    fn kill(&self) {
        unsafe { windows_sys::Win32::System::JobObjects::TerminateJobObject(self.0, 1) };
    }
}

#[cfg(windows)]
impl Drop for Reaper {
    fn drop(&mut self) {
        unsafe { windows_sys::Win32::Foundation::CloseHandle(self.0) };
    }
}

/// Elsewhere the process group does the same job, and `process_group(0)` below
/// makes the child its leader.
#[cfg(not(windows))]
struct Reaper(u32);

#[cfg(not(windows))]
impl Reaper {
    fn new() -> Option<Self> {
        Some(Self(0))
    }
    fn adopt(&mut self, pid: u32) {
        self.0 = pid;
    }
    fn kill(&self) {
        // Shelling out to `kill` rather than taking a `libc` dependency for one
        // call. The negative pid targets the group.
        let _ = Command::new("kill")
            .args(["-KILL", &format!("-{}", self.0)])
            .status();
    }
}

/// Has this run been cancelled? Read on every loop turn rather than waited on,
/// because the thing we would otherwise wait for is the pipe, and the pipe
/// outlives the process.
fn stopped(registry: &tauri::State<'_, ExecState>, id: &str) -> bool {
    registry
        .0
        .lock()
        .unwrap()
        .get(id)
        .map(|entry| entry.cancelled)
        .unwrap_or(false)
}

/// Stop a running command. Safe to call for an id that has already finished.
#[tauri::command]
pub fn agent_exec_cancel(id: String, state: tauri::State<'_, ExecState>) {
    let mut running = state.0.lock().unwrap();
    if let Some(entry) = running.get_mut(&id) {
        entry.cancelled = true;
        entry.reaper.kill();
    }
}

/// Run one command, streaming its output, and return when it exits.
#[tauri::command]
pub async fn agent_exec(
    id: String,
    request: ExecRequest,
    on_event: Channel<ExecEvent>,
    app: tauri::AppHandle,
    workspace: tauri::State<'_, WorkspaceState>,
) -> Result<ExecOutcome, ExecFailure> {
    let root = root_of(&workspace).map_err(|e| fail("spawn_error", e))?;

    // Confine the cwd, and only the cwd.
    let cwd = match &request.cwd {
        Some(relative) => {
            let path = crate::workspace::contained(&root, relative.trim_start_matches('/'))
                .map_err(|e| fail("spawn_error", e))?;
            if !path.is_dir() {
                return Err(fail("spawn_error", format!("not a directory: {relative}")));
            }
            path
        }
        None => root.clone(),
    };

    let mut command = match &request.argv {
        Some(argv) => {
            let (program, rest) = argv
                .split_first()
                .ok_or_else(|| fail("spawn_error", "argv is empty"))?;
            let mut direct = Command::new(program);
            direct.args(rest);
            direct
        }
        None => {
            let (shell_path, shell_name) = shell()
                .ok_or_else(|| fail("shell_unavailable", "no shell was found on this machine"))?;
            let mut shelled = Command::new(shell_path);
            if *shell_name == "bash" {
                shelled.arg("-lc").arg(&request.command);
            } else {
                shelled
                    .args(["-NoLogo", "-NoProfile", "-Command"])
                    .arg(&request.command);
            }
            shelled
        }
    };
    command.current_dir(&cwd);
    if !request.inherit_env {
        command.env_clear();
    }

    /*
     * The API keys do not travel to the child.
     *
     * Ticket 06 put the credential in Rust so it never enters JavaScript, and
     * that is still true — but it lives in *this process's environment*, and an
     * inherited environment hands it to everything we start. `echo
     * $DEEPSEEK_API_KEY` printed it straight into the transcript.
     *
     * Stripped for the shell path as much as for user tools: `bash` was the
     * older hole, and user tools only made it sharper by being ungated on the
     * argument that profile membership is the trust act. A command that
     * genuinely needs a key can still be given one through `env` below, which
     * is applied after — explicitly, by the person who wrote the manifest,
     * rather than by everything inheriting everything.
     */
    for name in crate::provider::CREDENTIAL_VARS {
        command.env_remove(name);
    }

    command.envs(&request.env);
    command.stdin(Stdio::null());
    command.stdout(Stdio::piped());
    command.stderr(Stdio::piped());
    #[cfg(not(windows))]
    {
        use std::os::unix::process::CommandExt;
        // Its own process group, so `kill_tree` can take the whole thing.
        command.process_group(0);
    }


    let timeout = request.timeout.map(Duration::from_secs);
    let exec_id = id.clone();

    // Blocking from here: reading two pipes and waiting on a child is not
    // async work, and pretending otherwise would only add a runtime.
    let result = tauri::async_runtime::spawn_blocking(move || {
        let mut child = command.map_err_spawn()?;

        // Adopted immediately after spawn. A process started by the child in the
        // gap would still be caught — job membership is inherited — but the gap
        // is kept as small as the API allows.
        #[allow(unused_mut)]
        let mut reaper =
            Reaper::new().ok_or_else(|| fail("spawn_error", "could not create a process job"))?;
        reaper.adopt(child.id());

        let registry = app.state::<ExecState>();
        registry.0.lock().unwrap().insert(
            exec_id.clone(),
            Running {
                reaper,
                cancelled: false,
            },
        );

        let (tx, rx) = mpsc::channel::<(bool, String)>();
        let mut readers = Vec::new();
        for (is_err, pipe) in [
            (false, child.stdout.take().map(|p| Box::new(p) as Box<dyn std::io::Read + Send>)),
            (true, child.stderr.take().map(|p| Box::new(p) as Box<dyn std::io::Read + Send>)),
        ] {
            let Some(pipe) = pipe else { continue };
            let tx = tx.clone();
            readers.push(std::thread::spawn(move || {
                let mut reader = BufReader::new(pipe);
                let mut line = String::new();
                loop {
                    line.clear();
                    // Lossy by necessity: a command may print bytes that are
                    // not UTF-8, and losing the run over one of them would be
                    // worse than a replacement character.
                    let mut raw = Vec::new();
                    match reader.read_until(b'\n', &mut raw) {
                        Ok(0) | Err(_) => break,
                        Ok(_) => {}
                    }
                    line.push_str(&String::from_utf8_lossy(&raw));
                    if tx.send((is_err, line.clone())).is_err() {
                        break;
                    }
                }
            }));
        }
        drop(tx);

        let mut stdout = String::new();
        let mut stderr = String::new();
        let mut truncated = false;
        let started = Instant::now();
        let mut timed_out = false;

        loop {
            match rx.recv_timeout(Duration::from_millis(100)) {
                Ok((is_err, chunk)) => {
                    let sink = if is_err { &mut stderr } else { &mut stdout };
                    if sink.len() + chunk.len() > MAX_CAPTURE_BYTES {
                        truncated = true;
                    } else {
                        sink.push_str(&chunk);
                        let event = if is_err {
                            ExecEvent::Stderr { chunk }
                        } else {
                            ExecEvent::Stdout { chunk }
                        };
                        // pi throttles the UI side already; Rust must not
                        // throttle again or live output goes choppy.
                        let _ = on_event.send(event);
                    }
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
                Err(mpsc::RecvTimeoutError::Timeout) => {}
            }

            /*
             * Stop waiting on the pipes once the child has been killed.
             *
             * Killing the shell does **not** close its stdout: a grandchild
             * inherited the write handle, so `read_until` blocks until *that*
             * process exits. `sleep 25`, killed after two seconds, still made
             * `exec` take 25.4 seconds to return — with `taskkill` reporting
             * success the whole time. Waiting for EOF is waiting for the wrong
             * event.
             */
            if stopped(&registry, &exec_id) {
                break;
            }
            if let Some(limit) = timeout {
                if started.elapsed() > limit && !timed_out {
                    timed_out = true;
                    if let Some(entry) = registry.0.lock().unwrap().get(&exec_id) {
                        entry.reaper.kill();
                    }
                    break;
                }
            }
        }

        let cancelled = stopped(&registry, &exec_id);

        if cancelled || timed_out {
            // Deliberately not joined. A reader thread can outlive this call by
            // exactly as long as whatever still holds the pipe, and blocking on
            // it here is the bug above. They exit on their own; the channel
            // receiver is dropped, so their sends fail and the loop ends.
            drop(readers);
            let _ = child.kill();
            registry.0.lock().unwrap().remove(&exec_id);
            return Err(if cancelled {
                fail("aborted", "the command was stopped")
            } else {
                fail("timeout", "the command exceeded its timeout")
            });
        }

        for reader in readers {
            let _ = reader.join();
        }
        let status = child.wait();
        registry.0.lock().unwrap().remove(&exec_id);

        Ok(ExecOutcome {
            stdout,
            stderr,
            // A signalled child has no code; -1 is not a real exit status and
            // is reported as such rather than as success.
            exit_code: status.map(|s| s.code().unwrap_or(-1)).unwrap_or(-1),
            truncated,
        })
    })
    .await;

    match result {
        Ok(outcome) => outcome,
        Err(cause) => Err(fail("unknown", cause.to_string())),
    }
}

/// `Command::spawn` with pi's error code attached.
trait SpawnWithCode {
    fn map_err_spawn(&mut self) -> Result<std::process::Child, ExecFailure>;
}

impl SpawnWithCode for Command {
    fn map_err_spawn(&mut self) -> Result<std::process::Child, ExecFailure> {
        self.spawn().map_err(|e| fail("spawn_error", e.to_string()))
    }
}
