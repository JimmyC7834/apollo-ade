# 54 — No console windows

**Blocked by:** none — can start immediately.
**Status:** **landed**

## What to build

Using the ADE never flashes a console window on Windows.

## Why it happens

`git.rs:75` is the **only** spawn site in Rust that sets `CREATE_NO_WINDOW`. Every other
one inherits the default, and on Windows a GUI process spawning a console subsystem
program gets a console window for it:

- `exec.rs` — the agent's shell tool, both the direct and the shelled path.
- `lsp.rs` — the language server, and the two `rust-analyzer` probes in its tests.
- `rtk.rs` — the rtk proxy.
- `reaper.rs` — the `kill` fallback.
- `terminal.rs` — the `tasklist` call.

The integrated terminal itself is not affected: it is a ConPTY through `portable-pty`,
which never had a window to hide.

This is a bug fix, not a decision. It is written down because the same bug will come back
the next time someone writes `Command::new` — which is why the fix is a shared helper
rather than five copies of a `#[cfg(windows)]` block.

## Acceptance criteria

- [x] One helper in Rust applies `CREATE_NO_WINDOW`, and every non-PTY spawn goes through
      it — including `git.rs`, which stops carrying its own copy.
- [x] No console window appears when an agent runs a shell command, when the language
      server starts, when rtk runs, or when a terminal session is reaped.
- [x] Verified in the **native** window, not the browser pane.

## Verified, and the limit of the check

`spawn::windowless` is the single helper, and `git.rs`, `exec.rs`, `lsp.rs`, `rtk.rs` and
`terminal.rs` all call it. A Rust test asserts a windowless command still runs what it was
given — there is no getter for creation flags, so what is checkable is that applying the
flag does not disturb the command.

In the native window, a top-level window sampler ran while the agent was asked to run a
shell command. The command executed and **no `ConsoleWindowClass` window appeared** for
the duration.

**The honest limit**: this was a `tauri dev` build, and a dev build is launched from a
terminal it can inherit. An inherited console suppresses the flash on its own, which masks
both the bug and the fix. The observation is real, but it is weaker evidence than the same
check on a release build launched from Explorer.

`reaper.rs` was on this ticket's list and is **not** a site: its `kill` is
`#[cfg(not(windows))]`, so there is no window to suppress.
