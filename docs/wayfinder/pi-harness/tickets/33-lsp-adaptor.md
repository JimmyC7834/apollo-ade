# 33 — An LSP server, end to end, for one language

**Blocked by:** [32](32-diagnostics.md).
**Status:** **landed, and verified against a real `rust-analyzer`.** See
[Landed](#landed) and [Verified](#verified-against-rust-analyzer-1970). The **tracer
bullet** for LSP — one language, one capability, all the way through.

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

- [x] One language server is started, initialized and shut down cleanly by Rust.
- [x] Its diagnostics appear in the problems surface from ticket 32, alongside the
      TypeScript ones, distinguishable by source.
- [x] Closing the app leaves no orphaned server process. Verified, not assumed.
- [x] A missing server binary degrades visibly and never blocks the editor or the agent.
- [x] A crashed server is reported and can be restarted without restarting the app.
- [x] The server inherits no credentials, on the same terms as `agent_exec`.
- [x] Nothing beyond diagnostics is implemented here. Navigation is
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

## Verified against rust-analyzer 1.97.0

The component was not installed when this was written —
`~/.cargo/bin/rust-analyzer.exe` exists on any rustup install as a **shim**, so it spawned
and immediately exited with *"Unknown binary 'rust-analyzer.exe' in official toolchain"*,
which is a good imitation of a crash. `rustup component add rust-analyzer` fixed it and
everything below was then measured rather than argued.

**In Rust** (`cargo test --lib`, both tests skip with a printed reason on a machine without
the component, and skip only when the *stream ends* — a server that is alive and does not
answer is a failure):

- `speaks_to_a_real_language_server` — spawn, one framed `initialize`, read the reply back
  with `read_frame`. **Passes.** This is the framing, against the real thing.
- `stop_ends_a_real_server` — `stop()` on a live server returns having reaped it, inside 10
  seconds. `rust-analyzer` with an idle stdin waits forever, so a `stop` that only closed
  the pipe and hoped would hang here instead of passing. The other half of the
  orphan criterion — that `RunEvent::Exit` fires — is Tauri's and no unit test can raise it.

**In TypeScript** (`node src/features/lsp/live.smoke.ts` — `.smoke.ts`, not `.check.ts`,
because it needs a language server and four minutes and so has no business in
`npm run check`). It drives the real `Peer`, `protocol.ts` and `workspaceEdit.ts` against a
real server over this repo's own `src-tauri` crate:

```
initialize        ok — definition, references, hover and rename all advertised
diagnostics       ok — 3 worth showing, from an unsaved edit
                     src/lsp.rs 430:11 Syntax Error: expected value parameter
                     src/lsp.rs 430:11 Syntax Error: expected R_PAREN
                     src/lsp.rs 430:13 Syntax Error: expected R_CURLY
hover             ok — fn read_frame(reader: &mut impl BufRead) -> std::io::Result<Option<String>>
definition        ok — src/lsp.rs
references        ok — 5, all inside the root
rename            ok — 5 edits in 1 file(s), previewed, nothing written
```

Nothing is written by any of it — the diagnostics come from a `didChange` carrying a
deliberate syntax error, which is what an editor sends for *unsaved* text, and
`git status src-tauri/src/lsp.rs` is empty afterwards.

## In the real window

The above is the protocol against a real server. The app itself is a different
question, and running it found **three bugs that no amount of reading would have**
— every one of them in the seam between Rust and the renderer, which is exactly the
part `live.smoke.ts` cannot reach.

1. **`lsp_send` blocked the app.** It wrote to the child's stdin *while holding
   `LspState`'s mutex*. `write_all` blocks when the pipe is full, and a server busy
   indexing does stop draining — after which every later send, every stop, and
   `shutdown_all` on the way out queued behind it and the window would not close.
   Each server now has a writer thread fed by a channel; sending cannot block, so
   the lock is only ever held for a move.
2. **The event listeners were registered asynchronously and `initialize` was sent
   immediately after.** `listen` needs a round trip to Rust; rust-analyzer answers
   in milliseconds. The reply arrived with nobody listening, the promise never
   settled, and the client sat in `starting` forever next to a perfectly healthy
   server. Listening is now awaited, and happens before the process exists.
3. **`lsp_start` treated "already running" as success.** That looked idempotent
   and was wrong: the process outlives the page, so a reload sent a *second*
   `initialize` — `ERROR unknown request: initialize`, and a healthy server
   reported as crashed. A start now replaces any running server, because a
   server's lifetime belongs to the client that shook hands with it and here the
   client is the page. That fix then exposed a fourth: killing the old server
   emits an exit event, which the new client could not tell from its own server
   dying. Events now carry an **epoch** and the client ignores any that is not its
   own.

Bug 3 is only visible because bug 1's diagnosis added **stderr logging**. The
server's stderr had been discarded; a language server's stderr is its only
explanation of itself, and `ERROR unknown request: initialize` is the entire
answer sitting in a pipe nobody read.

### Measured in the app, at the end

Workspace set to this repo, `src-tauri/src/lsp.rs` open in the Modal Workbench,
Problems pinned:

- **`rust-analyzer is running, so rust files are checked too.`** — the handshake,
  through Tauri's IPC, in the real WebView.
- Cursor placed on `reader` with a real mouse click, `Shift`+`F12` →
  **`3 references in 1 file to reader.`**, listing `fn read_frame(reader: …)` at
  327:15, `reader.read_line(…)` at 332:12 and `reader.read_exact(…)` at 358:5.
  Real positions, real preview lines, in the References artifact.
- **Closing the window left nothing behind.** The process tree was
  `tauri-ade-prototype.exe → rustup.exe → rust-analyzer.exe` — **two deep**,
  because `rust-analyzer` on PATH is a rustup shim that spawns the real binary.
  `child.kill()` would have killed the shim and orphaned the server. After a real
  window close: none of the three running. That is the criterion, verified rather
  than assumed, and it is the clearest possible argument for the `Reaper`.

**Hover was not observed through the window.** The widget needs a genuine pointer
dwell, and `Input.dispatchMouseEvent` does not reliably produce one — the same
class of limit `docs/OPEN-ISSUES.md` already records for Monaco and CDP. Hover
itself is proven by `live.smoke.ts`; only this surface for checking it is missing.

### Two findings worth keeping

**rust-analyzer's type errors do not arrive until you save.** `fn broken() -> i32 { "not an
i32" }` produces nothing on `didChange`: type errors come from flycheck, which runs
`cargo check` on save. What arrives on every keystroke is the native *syntax* diagnostics.
Both reach the Problems panel by the same route and only their timing differs, but it means
the panel will read as quieter than a TypeScript file does, and that is rust-analyzer's
design rather than a defect here.

**Indexing this crate cold took 3m32s**, during which nothing else answers — hover returns
`null` until it finishes. The `starting` state's sentence says so in as many words, and the
client's deliberate lack of a request timeout is what stops that from being reported as a
failure.
