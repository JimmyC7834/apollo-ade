# 45 — A session is an object the window holds

**Blocked by:** none — can start immediately.
**Status:** ready-for-agent

A prefactor, and it is deliberately not a tracer bullet: nothing changes on screen. It
exists because every slice after it is impossible while a session is module-level state.

## What to build

The app runs exactly as it does today, but as a **collection of one session** rather than
as one session. A session becomes an object that owns its harness, its provider, its store
and its transcript, and the window owns a collection of them plus which one is focused.

Three things stand in the way, and they are the whole ticket:

- **`sessionOnce`** caches one session promise per module. It exists because StrictMode
  double-invokes render and both runs created a session; the replacement has to solve that
  same problem per *instance* rather than per module, and the double-mount is real — see
  the entry doubling noted in `docs/OPEN-ISSUES.md`.
- **The provider is built during render.** `createAgentProvider` runs in
  `WorkbenchController`'s render and installs the Rust fetch shim as a side effect. Building
  N of those on a render path is not viable; creation becomes an action.
- **The transcript lives in `AgentChat`'s state.** A session nobody is looking at has to
  keep accumulating turns, so `turns` moves onto the instance and the component renders the
  focused one. This is also what makes the restored-history path and the live path the same
  path.

**Switching stays a reload for now.** Replacing it is ticket 47's job; doing both here
makes one commit that cannot be verified in halves.

## Acceptance criteria

- [ ] A session instance can be created, and creating two does not disturb the first.
- [ ] No module-level session state remains; the Rust fetch shim is installed once per
      window regardless of how many sessions exist.
- [ ] The transcript belongs to the instance. `AgentChat` renders the focused session's
      turns and holds none of its own.
- [ ] StrictMode's double render still produces one session and one file on disk.
- [ ] Everything that worked before works: a turn, `/compact`, undo, restored history,
      session switching by reload, browser mode's canned provider.
- [ ] `npm run check` and `npx tsc --noEmit` clean.
