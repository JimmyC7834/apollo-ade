# 46 — Rust gives each session its own root

**Blocked by:** none — can start immediately.
**Status:** ready-for-agent

The second prefactor, and the one that **reopens
[ADR 0001](../../../adr/0001-multi-root-confinement.md)**. Writing the replacement ADR is
part of this ticket, not a follow-up: the decision is what is being built.

## What to build

Nothing changes on screen. Underneath, confinement stops being ambient.

Today `WorkspaceState` holds one path and every command resolves against it, so "which root
am I confined to" is a property of *when* a command runs. A background session running in
another folder makes that untenable — two roots have to resolve at the same instant.

So Rust keeps a **session table**: creating a session registers a root and returns an
**opaque id**, and the agent's own commands carry that id and resolve against that
session's root. The id is minted by Rust and means nothing to the renderer, which keeps the
existing property that no renderer-supplied path can name a root. A root can only enter the
table the two ways it can today: an OS folder dialog, or an index into the recents list.

**This is stricter than what it replaces, and that is the argument for it.** A session's
root is fixed at birth. Today a workspace switch mutates the one root underneath whatever
is in flight — which is exactly how the session corruption fixed on 2026-08-15 happened.

**The workbench keeps a current root** and it means "the focused session's root". The
explorer, search, LSP and terminal go on using it untouched; only agent commands take an
id. Making every command in `workspace.rs` session-keyed is a far larger diff for nothing
the workbench can spend.

The read-only recents-index parameter added by session switching stays as it is. It answers
a different question — *list* another root without entering it — and it is not a session.

## Acceptance criteria

- [ ] A replacement ADR supersedes 0001, recording that the boundary is now one root **per
      session** and why the id is opaque.
- [ ] Rust mints a session id against a root; agent filesystem and exec commands take it and
      confine to that session's root.
- [ ] An unknown or stale id is refused, never resolved against the current root.
- [ ] Two sessions registered against different roots both resolve correctly with no
      ordering between them.
- [ ] The single session the app has today registers at start-up and behaves identically.
- [ ] Rust tests cover the refusal and the two-roots-at-once case.
- [ ] `npm run check` and `npx tsc --noEmit` clean.
