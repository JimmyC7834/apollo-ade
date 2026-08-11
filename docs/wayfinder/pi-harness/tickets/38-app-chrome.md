# 38 — Titlebar, ADE menu, breadcrumb

**Blocked by:** [37](37-shell-tokens-and-stack.md).
**Status:** **landed, unseen.** `branch` came from a new `git_branch` command and a
`getBranch` on the changes seam; `session` is named by the live session's first prompt.
Every measurement here is written-not-seen — see `docs/OPEN-ISSUES.md`.

## What exists

`src/workbench/Titlebar.tsx` and `useWindowControls.ts` already draw a custom titlebar and
already drive minimise / maximise / close through Tauri. This slice reshapes it rather than
inventing it.

## What to build

A 42px titlebar with three fixed regions, per the [Shell Guide](../../UIUX-UPDATE.md):

```text
[ADE menu]   [workspace/branch / session]   [theme][minimize][maximize][close]
```

**The ADE menu is the only application menu.** New session, Command palette, Settings,
About ADE, Quit. Nothing else opens it.

**The breadcrumb truncates; it never pushes.** `workspace/branch / session` occupies the
draggable region, and the window controls do not move when it grows. This is Shell Guide
principle 6 — *"Controls should not shift nearby content when hovered, expanded, or
closed"* — and it recurs in three later slices, so getting the technique right here is
worth more than the breadcrumb is.

**Every control is 42px wide and always visible.** Close uses the destructive token on
hover.

## The parts that need a real answer

- **`branch` has to come from somewhere.** `changes.ts` and the Rust `git2` layer know the
  branch; nothing currently surfaces it to the titlebar. Small, but it is a new read.
- **`session` implies a session has a name.** Nothing names sessions today.
  [Slice 39](39-session-navigator.md) owns the session model; this slice renders whatever
  it exposes and shows the workspace and branch alone until it exists. Do not invent a
  second naming scheme here.
- **The theme control is a toggle, not a menu.** 37 defines the two themes; this draws the
  switch and persists the choice through `persistence.ts`.

## Acceptance criteria

- [ ] The titlebar is 42px, three regions, and the window controls never move.
- [ ] The ADE menu is the only application menu and carries the five items. Settings and
      About may be stubs that say so; New session, Command palette and Quit work.
- [ ] The breadcrumb shows workspace and branch, truncating rather than pushing, and shows
      the session once 39 gives it one.
- [ ] The theme toggle switches light/dark and the choice survives a restart.
- [ ] Dragging the titlebar still moves the window; the controls are not draggable.
- [ ] Menu keyboard behaviour comes from Radix, not from hand-rolled key handling; Escape
      closes and focus returns to the ADE button.
- [ ] `npm run check` and `npx tsc --noEmit` clean.
