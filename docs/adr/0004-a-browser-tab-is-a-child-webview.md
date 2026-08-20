# 0004 — A browser tab is a child webview, not an iframe

**Status:** accepted, not yet implemented.
**Date:** 2026-08-19.
**Context:** settled in a grill; slices not yet ticketed.
**Amends:** the built-in tool rule recorded in `src/agent/userTools.ts`.

## Context

The dev asked for a **browser tab**: a page open inside the ADE, so that the app under
development can be looked at without leaving the ADE, and so that the agent can open a
link, read a page, and click in it. The stated purpose is to help development — the agent
verifying its own web work is the case that matters, not general web browsing.

Nothing exists to extend. The app's CSP is `frame-src 'none'`, `capabilities/default.json`
carries only the five window-control permissions, there is no `opener` or `shell`
dependency, and pi ships no web tool of any kind — no `web_fetch`, `web_search` or
`browser` anywhere in `@earendil-works/pi-agent-core`. This is greenfield in both halves.

**One constraint decides the whole design.** The ADE runs on `tauri://localhost`; a dev
server runs on `http://localhost:5173`. Those are different origins, so an `<iframe>`
holding the page would refuse `contentDocument`, and the agent could display a page while
being unable to read a single node in it. There is no workaround that does not require the
page to cooperate, and a foreign page does not cooperate.

Scope, settled in the same grill: **localhost and `file:` URLs only for now**, with
arbitrary hosts recorded as wanted later; one tab per dock tab, **per session**; a URL line
and reload but no history; the agent may open tabs **hidden**, announced as a chip in the
transcript; page text enters the transcript marked as untrusted data; no screenshots.

## Decision

**A browser tab renders in a Tauri child webview, created and driven from Rust.**

`window.add_child` places it; `WebviewUrl::External` points it at the page;
`set_position`, `set_size`, `hide` and `show` keep it aligned with the dock. The agent's
drive channel is **`Webview::eval_with_callback`**
(`~/.cargo/registry/.../tauri-2.11.5/src/webview/mod.rs:1929`), which evaluates JavaScript
on any page and hands the JSON-serialised result back to Rust. That one call is the entire
mechanism for reading the DOM, clicking, typing and capturing the console. It needs no
injected bridge and no cooperation from the page.

**The agent gets one tool, `browser`, with actions** — open, read, click, type, console —
rather than a family of narrower tools. `profile.tools` is a boolean per name, so several
names would buy finer trust granularity; that granularity is worth nothing to a dev who
grants tools by profile membership and runs the gate on `auto`. The tool is not gated:
membership is the trust decision, as it is for every other tool. It is **GET-shaped** —
the model supplies a URL, never a request body or headers — so what leaves the machine is
bounded by the URL itself.

## Consequences

**The tab paints above the entire React tree, and this is accepted.** On Windows a child
webview is a real child HWND: wry creates it with `CreateWindowExW`
(`wry-0.55.1/src/webview2/mod.rs:251`) and places it with `SetWindowPos(..., HWND_TOP, ...)`
(line 268). A child HWND always paints over its parent's content, so no part of the DOM can
draw over the tab. The command centre, the profile modal, dropdowns and toasts would each
be hidden behind it.

**The mitigation is one rule: any overlay that opens hides the tab.** Each of those
surfaces has a single mount point, so this is a `hide()`/`show()` pair and not a concern
scattered through the UI. The rule is also honest about what the tab is — a foreign page
borrowing a rectangle of our window, not a component in our tree.

**The tab must be positioned by hand.** It does not scroll with the dock, does not clip to
rounded corners, and must be re-synced on every layout change and hidden on every tab
switch. This is the recurring maintenance cost of the decision.

**Hidden mode rests on an unverified assumption**, and it is one this repo has been bitten
by before: `CONTEXT.md` records that the dev browser pane "serves no animation frames, so
Monaco never lays out". A webview that is never shown may report zero-size rects, in which
case the agent would drive a page with no layout and report it as broken. The design
therefore hides a tab by **positioning it outside the parent's client rect** — clipped by
the OS, but still sized and still laying out — rather than by calling `hide()`. **The first
slice is a probe that proves this**, before any UI is built. If the rect comes back zero,
hidden mode degrades to "opens minimised" and the agent cannot drive a tab it has not shown.

**Answered, 2026-08-19: it lays out.** A child webview opened at
`y = window.innerHeight + 32` — outside the parent's client rect, clipped away by
the OS — and pointed at the dev server reported
`document.body.getBoundingClientRect()` as `1280 x 800`, `window.innerWidth` /
`innerHeight` as `[1280, 800]`, `document.title` as `"ADE"`, and 629 nodes in the
document. So a page nobody is looking at is a page with layout, `eval` reaches it,
and hidden mode needs no fallback. Measured over the WebView2 debugging port
against the native window; see `docs/OPEN-ISSUES.md` for how.

**Two things the implementation found that this ADR did not predict**, both
recorded in `browser.rs` where they will be read:

- **Multiple webviews in one window are behind tauri's `unstable` feature.**
  `Window::add_child`, `WebviewBuilder` and `Manager::get_webview` are all gated,
  so `Cargo.toml` now carries `features = ["unstable"]`. It is an API-stability
  flag rather than an experiment switch, and `browser.rs` is the only file that
  touches the gated surface.
- **Every command that touches a webview has to be `async`.** Tauri runs a
  synchronous command on the main thread, and `add_child` posts work *to* the
  main thread and blocks waiting for it — so the synchronous version deadlocked
  the whole application on the first call.

**This widens a rule that was written down.** `src/agent/userTools.ts` records ticket 13's
rule that the built-in exception **does not grow** — no new *executing* tool joins pi's
four. `ask_user` was let past it explicitly because it is "the opposite kind of thing: it
runs nothing". `browser` is not the opposite kind; it executes. `RESERVED` grows to six,
and this is the first genuine widening rather than an exception in the shape of the old
one.

**Two things do not change, against first expectations.** The CSP stays `frame-src 'none'`,
because a child webview is a separate webview and not a frame. And
`capabilities/default.json` stays as it is, because capabilities gate the *JavaScript*
Tauri API, while the webview is created in Rust — which is what the working rule "Rust is
the only authority; feature code never calls Tauri directly" requires anyway.

**The dev and the agent share one page.** Both can click and type in it: the dev natively,
the agent through `eval`. So the agent can navigate away from what the dev is reading, or
type into a field the dev is in. This is what "the agent verifies its own work while you
watch" means, and it is recorded here as a decision rather than left as a surprise.

**Focus leaves React whenever the dev clicks the page**, because the tab is a separate
HWND — the command centre shortcut, Esc and the composer keybindings stop firing. An
`initialization_script` on every tab catches Esc and returns focus to the ADE. That script
has to exist for console capture regardless, so it is not extra machinery.

**This is not a plugin, and it cannot be one.** The app's only extension point is the
declarative tool manifest in `userTools.ts`, which runs no foreign code by design. A
browser tab needs a new artifact kind, a renderer and a glyph — all closed unions — and,
decisively, it needs `window.add_child`. Foreign code hosted in a Web Worker has no
`window`, which is the very property that makes that isolation safe. Whether the ADE should
grow a real extension system is a separate question and is being taken up separately.

## Alternatives considered

- **An `<iframe>` in the dock.** Much the cheaper build: it stays in the DOM, clips,
  scrolls, and needs no positioning code or occlusion rule. Rejected because it is
  view-only. Cross-origin blocks the agent from reading the page, which deletes the reason
  the feature was asked for. It also fails on most real sites once the localhost-only
  scope is lifted, since `X-Frame-Options: DENY` and `frame-ancestors` are near-universal.
- **The OS default browser, via an opener plugin.** Trivial to build and genuinely useful
  for a link the dev wants to read. Rejected as the primary mechanism: nothing is visible
  to the ADE, so neither the tab nor the agent exists. Kept as the fallback for a host
  outside the allow-list.
- **A fetch-only tool: Rust `GET` a URL, return text, render nothing.** Nearly free, since
  `rustFetch.ts` and `reqwest` already exist. Rejected as insufficient once "drive" was in
  scope, and then rejected outright as redundant: a tab can return its own text, and two
  ways to get the text of a page is the second-way-to-do-something that *less is more*
  forbids.
- **Driving the page over the WebView2 remote debugging port (CDP)** instead of `eval`.
  Real, and this repo already uses that port to inspect the native window — see
  `docs/OPEN-ISSUES.md`. Rejected because `eval_with_callback` does the same job with no
  port to open, no protocol client to write, and no second channel into the app that is
  reachable from outside it.
- **Screenshots for the agent.** Rejected. The agent acts on text — the DOM, the console,
  the network list — and the dev is already looking at the page. Capturing a foreign HWND
  and then paying for a vision call buys nothing that `eval` does not already return.
