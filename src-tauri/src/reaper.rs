//! Everything one spawned process started, killable as a unit.
//!
//! Lifted out of `exec.rs` by ticket 33, unchanged. A language server is the
//! second consumer: `rust-analyzer` shells out to `cargo` and `rustc` while it
//! indexes, so `child.kill()` on the server leaves a build running and a
//! gigabyte of RAM behind — the same failure this already solved once.

#[cfg(not(windows))]
use std::process::Command;

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
pub(crate) struct Reaper(windows_sys::Win32::Foundation::HANDLE);

#[cfg(windows)]
// The handle is owned by this struct and only ever used through it. Tauri moves
// it between threads with the rest of the run state.
unsafe impl Send for Reaper {}

#[cfg(windows)]
impl Reaper {
    pub(crate) fn new() -> Option<Self> {
        use std::mem::{size_of, zeroed};
        use windows_sys::Win32::System::JobObjects::{
            CreateJobObjectW, JobObjectExtendedLimitInformation, SetInformationJobObject,
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

    // `&mut self` is not needed here — a job handle is adopted into, not
    // mutated — but the process-group version below genuinely does mutate, and
    // matching the two signatures is what keeps `let mut reaper` at every call
    // site from being a warning on exactly one platform.
    pub(crate) fn adopt(&mut self, pid: u32) {
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

    pub(crate) fn kill(&self) {
        unsafe { windows_sys::Win32::System::JobObjects::TerminateJobObject(self.0, 1) };
    }
}

#[cfg(windows)]
impl Drop for Reaper {
    fn drop(&mut self) {
        unsafe { windows_sys::Win32::Foundation::CloseHandle(self.0) };
    }
}

/// Elsewhere the process group does the same job, and `process_group(0)` at the
/// spawn site makes the child its leader.
#[cfg(not(windows))]
pub(crate) struct Reaper(u32);

#[cfg(not(windows))]
impl Reaper {
    pub(crate) fn new() -> Option<Self> {
        Some(Self(0))
    }
    pub(crate) fn adopt(&mut self, pid: u32) {
        self.0 = pid;
    }
    pub(crate) fn kill(&self) {
        // Shelling out to `kill` rather than taking a `libc` dependency for one
        // call. The negative pid targets the group.
        let _ = Command::new("kill")
            .args(["-KILL", &format!("-{}", self.0)])
            .status();
    }
}
