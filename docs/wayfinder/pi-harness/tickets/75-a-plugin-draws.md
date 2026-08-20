# 75 — A plugin draws

**Blocked by:** [72](72-a-plugin-loads-and-adds-a-command.md),
[73](73-a-plugin-acts-and-listens.md).
**Status:** ready-for-agent

## What to build

`panel(url)` and `relay(payload)`. A plugin opens its **own page** in a dock slot, draws
whatever it likes in it, and its two halves — the injected script and the page — talk to
each other through the ADE.

## Why

This is the answer to "as diverse as possible" for pixels. Claims cover the chrome a plugin
wants to *add* to what we draw; a plugin panel covers everything else, with no widget
vocabulary for us to design and maintain forever.

It is also the cheapest of the visual options, because
[slice 43](69-a-page-you-can-look-at.md) already built it.

## What is there now

Almost all of it, pointed somewhere else:

- `src-tauri/src/browser.rs` creates, places, navigates, evaluates in and closes a child
  webview, all `async` because a synchronous command deadlocks the main thread.
- `src/features/browser/BrowserTab.tsx` measures an empty box and keeps the webview over
  it, through a `ResizeObserver` plus window listeners; `hiddenRect` moves a page below the
  window rather than hiding it, because a never-shown webview may not lay out.
- `src/ui/occlusion.ts` — any overlay that opens hides the page, because a child HWND is
  always on top and we cannot draw over it.
- The `ade-ipc:` scheme, cancelled by `on_navigation`, is the page's channel back to Rust.
- [ADR 0004](../../../adr/0004-a-browser-tab-is-a-child-webview.md) records why all of this
  is a child webview and not an iframe.

What does not exist is a way to serve a plugin's own files to a webview.

## The shape of it

**A `plugin://` protocol, registered in Rust**, serving files out of one plugin's folder
and nothing outside it — the same root-confinement the filesystem adapter already follows.
`plugin://<name>/panel.html` is what the webview loads. A plugin panel is therefore its own
origin: it cannot reach our DOM, and it is not granted our Tauri capabilities.

**`tokens.css` is served over the same protocol**, so a panel that links it gets our
palette, spacing, type and row height, and follows the theme. This is the honest answer to
"can a plugin use your components" — it cannot import them, and it does not have to invent
a look.

**`relay(payload)` is opaque.** The plugin's script and its panel have no direct channel;
every byte already passes through us. So we carry an arbitrary JSON payload between them
and never parse it. The plugin defines whatever protocol it wants inside. This is what
stops our six messages growing for reasons that are not about us.

**The transport is uneven and the adapter hides it.** `ade-ipc:` carries a URL, so a large
relay payload out of a panel is split by our adapter and rejoined before the other side
sees it. The plugin author never learns this happened.

**A panel is a dock tab like any other.** Reuse the existing tab machinery rather than
inventing a second one, the way a browser tab did.

## Not in scope

Themes and layout — [76](76-a-plugin-changes-the-chrome.md). No sandboxing of the injected
script: the plugin still has the ADE's full authority, and the panel's separate origin is a
property of webviews, not a security claim about the plugin as a whole.

## Acceptance criteria

- [ ] A plugin calls `panel` and its own page appears as a dock tab, drawing its own markup.
- [ ] `plugin://` serves only that plugin's folder — a path escaping it is refused, tested
      in Rust.
- [ ] A panel that links `tokens.css` matches the ADE's palette and spacing, and follows a
      theme change.
- [ ] The panel tracks the dock, hides behind overlays, and is destroyed when its tab
      closes — the same behaviour a browser tab already has.
- [ ] `relay` carries a payload both ways between the script and the panel, unparsed, and a
      payload large enough to exceed a URL survives the trip intact.
- [ ] `npm run check` and `cargo test` pass.
- [ ] Driven in the **native** window.
