# 33 — An LSP server, end to end, for one language

**Blocked by:** [32](32-diagnostics.md).
**Status:** **built. Not proven end-to-end on this machine** — see [Landed](#landed) for
exactly which line the verification stops at. The **tracer bullet** for LSP — one language,
one capability, all the way through.

## What this buys that ticket 32 cannot

Ticket 32 gets diagnostics for TypeScript out of a worker that is already bundled. It gets
nothing for Rust, Python, or anything else, and nothing beyond markers. This ticket is the
transport that fixes both — and it is deliberately scoped to prove the transport rather
than to deliver the feature set.

This map previously argued against LSP as *"a subsystem, not a feature."* That was an
argument about cost and not about value, and the dev has weighed it. It stands. What the
argument still earns is the shape below: **one language, one capability, then stop.**

## What to build

A language server process, managed by Rust, whose diagnostics for its language appear in
the same problems surface ticket 32 built.

Pick **one** server to start, and pick it by what this repo is written in that
`ts.worker` does not cover: `rust-analyzer`. It also happens to be the hardest — slow to
start, enormous initial indexing — which is the right thing to find out first rather than
last.

## Where the hard parts are, and they are not the protocol

- **Rust owns the process, not JavaScript.** This is the whole architecture of this app:
  Rust is the only process authority. An LSP server is a long-lived child with a duplex
  pipe, which `exec.rs` does not do — it spawns, captures and exits. This is closer to
  `terminal.rs`, and it is genuinely new machinery.
- **Lifecycle is the risk.** Start, initialize handshake, shutdown, crash, restart, and
  the workspace switch in [ticket 31](31-workspace-switching.md), which changes the root
  the server was initialized against. A leaked `rust-analyzer` is a gigabyte of RAM.
- **Discovery.** A server that is not installed must degrade to "no LSP for this
  language", visibly, and never block the editor. Do not bundle one.
- **Credentials.** `agent_exec` strips `CREDENTIAL_VARS` from every child it starts. A
  language server is a child this app starts, and it must be held to the same rule.

## Acceptance criteria

- [ ] One language server is started, initialized and shut down cleanly by Rust.
- [ ] Its diagnostics appear in the problems surface from ticket 32, alongside the
      TypeScript ones, distinguishable by source.
- [ ] Closing the app leaves no orphaned server process. Verified, not assumed.
- [ ] A missing server binary degrades visibly and never blocks the editor or the agent.
- [ ] A crashed server is reported and can be restarted without restarting the app.
- [ ] The server inherits no credentials, on the same terms as `agent_exec`.
- [ ] Nothing beyond diagnostics is implemented here. Navigation is
      [ticket 34](34-lsp-navigation.md) and it is blocked on this landing.

## Landed

**The split, which is the one decision worth arguing with:** *Rust owns the process,
JavaScript owns the protocol.* `src-tauri/src/lsp.rs` spawns the child, holds its stdin and
stdout open in both directions, reads `Content-Length` frames off stdout, and hands each
body up as an opaque string. It never parses one. The handshake, capability negotiation,
request correlation and position arithmetic are in `src/features/lsp/`, because all of them
have to reach Monaco anyway and putting them in Rust would mean a second serialisation of
every message plus a Rust-side model of the editor's state.

`terminal.rs` was the template and `exec.rs` was not, as the ticket predicted — output that
arrives whenever it likes travels as events, not as command results.

**Where the hard parts turned out to be, against the ticket's four:**

- **Process ownership.** `exec.rs` already had the answer and it was not being shared: the
  `Reaper` — a Windows job object, a process group elsewhere — moved to `src-tauri/src/reaper.rs`
  unchanged and now has two consumers. It matters more here than there: `rust-analyzer`
  runs `cargo` and `rustc` while it indexes, so `child.kill()` would leave a build running.
- **Lifecycle.** Start is idempotent, stop is idempotent, and a crash is a *state* rather
  than an exception — `off`, `starting`, `ready`, `missing`, `crashed`, `unavailable`. A
  crash never auto-restarts, because a server that dies on startup would otherwise restart
  forever and every attempt would look like the first. The workspace root is a dependency of
  the start effect, so ticket 31's switch is a restart and not a notification.
- **Discovery.** A `NotFound` spawn error becomes `missing` and reads *"…is not installed,
  so rust files are not checked. Install it and restart."* — a sentence in the Problems
  panel, next to a Restart button. The button is there precisely because installing a server
  happens outside this window: it is how the user picks it up without restarting the app.
  Nothing is bundled.
- **Credentials.** `command.env_remove` over `provider::CREDENTIAL_VARS`, the same loop
  `agent_exec` runs. Held to the rule because it is a child, not because it plausibly wants
  a key.

**Diagnostics needed no change to ticket 32 at all.** They are written with
`monaco.editor.setModelMarkers(model, 'rust-analyzer', …)`, and `ProblemsView` already reads
every marker and re-groups on `onDidChangeMarkers` — so they appear beside the TypeScript
ones, distinguishable by `source`, and `problems.ts`'s prediction that "nothing here would
have to change for it" held exactly.

**Checked:** `read_frame` against byte-vs-character counting (a non-ASCII identifier
desynchronises every message after it if this is wrong), unknown headers, and an empty
stream. `jsonrpc.check.ts` covers out-of-order replies, a server-to-client request being
mistaken for a reply, a reply delivered twice, and the crash case where every outstanding
request must be failed rather than left hanging. `protocol.check.ts` covers the position
arithmetic and the URI round trip.

### What is not proven, stated plainly

**No language server has been started by this code on this machine.**
`~/.cargo/bin/rust-analyzer.exe` exists here, which is misleading: it is a rustup *shim* for
a component that is not installed, so it spawns successfully and immediately exits with
*"Unknown binary 'rust-analyzer.exe' in official toolchain"*. `rustup component add
rust-analyzer` is the one command that makes the rest of this ticket verifiable.

`lsp::tests::speaks_to_a_real_language_server` is written and currently **skips**, printing
that line. It is conditioned on the *stream ending*, not on the spawn failing, so it will
start really running the moment the component is installed — and a server that is alive and
does not answer is a failure, not a skip.

So of the acceptance criteria above: the code for every one of them exists and is reviewed,
**none of the six that need a live server has been observed**. The boxes are left unticked
on purpose. What *was* observed is the whole path that does not need Rust: the client's
states render in the Problems panel (`rust-analyzer needs the desktop app; the browser has
no process to start it in`), and ticket 34's machinery works against Monaco's TypeScript
worker — measured in the browser, below.
