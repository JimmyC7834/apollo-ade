# 68 — A child webview, proven

**Blocked by:** none — can start immediately.
**Status:** ready-for-agent

## What to build

Rust can open a child webview at a rectangle, point it at a page, evaluate JavaScript in
it and get the answer back — and we know what a webview reports when it has never been
shown.

## Why this is first

[ADR 0004](../../../adr/0004-a-browser-tab-is-a-child-webview.md) rests on one assumption
that nothing in this repo has tested: that a webview positioned outside the parent's
client rect still lays out. Hidden mode depends on it. If it is false, the agent driving a
hidden page reads a DOM with no geometry and reports a working page as broken.

This repo has been bitten by exactly this class of thing before. `CONTEXT.md` records that
the dev browser pane "serves no animation frames, so Monaco never lays out". A webview
nobody is looking at is the same shape of hazard, and finding out after two slices of UI
are built on it is the expensive order.

The ticket is not only a probe. The two commands it lands are the ones 69 and 70 both
call, so nothing here is throwaway.

## What is there now

Nothing. There is no webview code in `src-tauri/src`, and the only mention of a second
webview anywhere is the generated permission schema.

## The shape of it

Two Tauri commands, in a new `src-tauri/src/browser.rs`:

- **open** — `window.add_child(WebviewBuilder::new(label, WebviewUrl::External(url)), pos,
  size)`, with `set_position` / `set_size` for later moves.
- **eval** — `Webview::eval_with_callback`, whose result is a JSON string, returned to the
  caller.

Both are root-agnostic: a webview is not a file, so `workspace.rs`'s confinement does not
apply. What does apply is the **host allow-list** — `localhost`, `127.0.0.1` and `file:`
and nothing else — and it belongs here, in Rust, at the point the URL is used, not in the
UI that supplies it.

**The probe is the acceptance test, not a scratch binary.** A `cargo test` cannot open a
window, so this is checked by driving the native app: open a webview clipped outside the
client rect, navigate it to the dev server, and eval
`JSON.stringify(document.body.getBoundingClientRect())`.

**Answered, 2026-08-19: it lays out.** A child webview opened at
`y = window.innerHeight + 32` — outside the parent's client rect, clipped away by
the OS — and pointed at the dev server reported
`document.body.getBoundingClientRect()` as `1280 x 800`, `window.innerWidth` /
`innerHeight` as `[1280, 800]`, `document.title` as `"ADE"`, and 629 nodes in the
document. So a page nobody is looking at is a page with layout, `eval` reaches it,
and hidden mode needs no fallback. Measured over the WebView2 debugging port
against the native window; see `docs/OPEN-ISSUES.md` for how.

## Not in scope

No UI. No artifact kind, no tab, no glyph, no agent tool. Nothing calls these commands
from React yet except whatever throwaway affordance the check needs.

## Acceptance criteria

- [x] A child webview opens at a given rect and shows a page from the dev server.
- [x] `eval` returns `document.title` to Rust as a string.
- [x] A URL that is not localhost, `127.0.0.1` or `file:` is refused by Rust, and the
      refusal names the host. Both at open and at navigate: `example.com is not a host a
      browser tab may open.`
- [x] **The hidden-mode question is answered in writing** — above, and in the ADR. It
      lays out.
- [x] The fallback is not needed, and is recorded as not needed.
- [x] `npm run check` and `cargo test` pass.
- [x] Driven in the **native** window, over the WebView2 debugging port.
