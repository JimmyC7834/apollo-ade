//! One rule for every child process this app starts: it gets no console window.
//!
//! On Windows a GUI process that spawns a console-subsystem program gets a
//! console window allocated for it, which flashes over the app. `git.rs` carried
//! its own `#[cfg(windows)]` block for this and every other spawn site did not,
//! so the ADE flashed a window whenever an agent ran a command, whenever the
//! language server started, and whenever rtk was probed.
//!
//! It lives here rather than as five copies because the bug is not any one of
//! those sites — it is that `Command::new` is the wrong default, and the next
//! one written would have had it too.
//!
//! Nothing to do off Windows, where a child inherits a terminal or none and no
//! window exists to suppress. The function is still called there so call sites
//! need no `cfg` of their own.

use std::process::Command;

/// Give `command` no console window. Returns it, so it chains onto a builder.
pub fn windowless(command: &mut Command) -> &mut Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        /// `CREATE_NO_WINDOW`, from `winbase.h`. Spelled out rather than taking
        /// a `windows-sys` dependency for one constant.
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The flag must not disturb the command it is applied to — it is added to
    /// the creation flags, not substituted for the program, arguments or cwd.
    /// Cheap to assert and it is the only way this helper could be wrong.
    #[test]
    fn a_windowless_command_still_runs_what_it_was_given() {
        let mut command = Command::new(if cfg!(windows) { "cmd" } else { "sh" });
        command.args(if cfg!(windows) {
            ["/C", "exit 0"]
        } else {
            ["-c", "exit 0"]
        });
        let status = windowless(&mut command).status().expect("it spawns");
        assert!(status.success(), "the command ran and exited cleanly");
    }
}
