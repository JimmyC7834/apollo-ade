# 33 — An LSP server, end to end, for one language

**Blocked by:** [32](32-diagnostics.md).
**Status:** ready-for-agent. The **tracer bullet** for LSP — one language, one capability,
all the way through.

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
