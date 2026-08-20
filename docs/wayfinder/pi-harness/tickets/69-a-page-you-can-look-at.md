# 69 — A page you can look at

**Blocked by:** [68](68-a-child-webview-proven.md).
**Status:** ready-for-agent

## What to build

A **browser tab**: you open one from the command centre, type a URL on its one-line
address row, and the page appears in the dock. It is a dock tab like any other — you can
pin several, switch between them, and close them.

## Why

This is the half you asked for first, and it is useful on its own: the app under
development, open beside the code, without leaving the ADE. It is also the surface
[70](70-the-agent-drives-the-page.md) drives, so it comes first.

## What is there now

- `pinned` in `WorkbenchController.tsx` is already `readonly string[]` of artifact ids in
  tab order, and files already sit in it as many-of-a-kind beside the six singletons. A
  browser tab is `browser:<n>` in that same list — no new tab machinery.
- `ToolArtifactKind`, `TOOL_ARTIFACTS` and `ArtifactView`'s `if` chain are all closed and
  singleton-shaped. This is the first artifact kind that is *not* a singleton.
- `IconName` is `keyof typeof GLYPHS`, so the glyph is a type-level addition.

## The shape of it

**The webview is not in the React tree, and everything hard about this ticket follows from
that.** `ArtifactView`'s branch for a browser tab renders the address row and an empty box
that reserves the space; Rust paints the page over that box.

- **Position sync.** The box's rect is measured and pushed to Rust on mount, on dock
  resize, on window resize and on portrait/landscape flip.
- **The occlusion rule, from [ADR 0004](../../../adr/0004-a-browser-tab-is-a-child-webview.md):
  any overlay that opens hides the tab.** The command centre, the profile modal, the
  context popover and toasts each have one mount point, so this is one `hide()`/`show()`
  pair and not a concern spread through the UI. A tab that is not the active dock tab is
  hidden by the same call.
- **The address row is one `--row-height` line**, in the same face as everything else: the
  URL, and reload. No back, no forward — history is a state machine that localhost
  browsing does not use.
- **Per session.** A tab belongs to the session that opened it, following `pinned`.
- **The host allow-list lives in Rust** (68) and the UI only reports what it refused. A
  URL outside it is offered to the OS browser instead — that is the one thing an
  out-of-scope host can usefully do.

## Not in scope

No agent involvement at all — no tool, no chip, no hidden tabs. Nothing in this ticket
reads the page's DOM. Arbitrary hosts stay out; the allow-list is localhost and `file:`,
and widening it is future work recorded in the map.

## Acceptance criteria

- [x] A browser tab opens from the command centre and appears in the dock's tab strip.
- [x] Typing a URL on the address row navigates it; reload reloads it.
- [x] Several tabs can be open at once and switching between them shows the right page and
      hides the others — the tab not in front is placed below the window.
- [x] Closing a tab destroys its webview — no orphaned window sitting over the app.
- [x] The page tracks the dock. Driven for the dock rectangle and the hide/show move; the
      portrait flip rides the same `ResizeObserver` and was not separately driven.
- [x] Opening the command centre hides the page and dismissing it brings the page back:
      `y = 66` → `y = 794` → `y = 66`. Every overlay declares itself through the one
      mechanism in `occlusion.ts`, so the profile editor and toasts follow.
- [x] A non-allowed host is refused with a message that names the host, and offers the OS
      browser.
- [ ] **Deviation.** Tabs belong to the *window*, not to the session. `pinned` is window
      state and every other artifact behaves that way, so a per-session browser tab would be
      a second mechanism for what the dock already does. Recorded in the dev log.
- [x] `npm run check` and `cargo test` pass.
- [x] Driven in the **native** window, over the WebView2 debugging port.
