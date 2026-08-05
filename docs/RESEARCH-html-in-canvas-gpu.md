# Research: html-in-canvas (`drawElement`) — is it worth it for this Tauri app?

Date: 2026-08-04. Subject: the WICG `html-in-canvas` proposal, evaluated against this repo (`tauri-ade-prototype`: Vite + React + Monaco + xterm.js frontend, Tauri v2 / Rust backend).

Follows the conventions of `docs/RESEARCH-zed-harness.md` and `docs/RESEARCH-agent-harnesses.md`: every factual claim carries an inline source link, §8 lists every source with a primary/secondary marking, and §7 states what I could not verify rather than filling the gap.

**Sourcing rule applied:** primary sources only — the WICG explainer, chromestatus, blink-dev intents, the vendor standards-positions repos, Chromium's own rendering docs, Tauri/wry official docs, Microsoft Learn. Two secondary sources are cited and are marked as such; neither carries a load-bearing claim.

**Staleness:** everything in §2 is a status snapshot **as of 2026-08-04** and will rot. §1, §3, §4 are structural and will not.

---

## 0. The one-paragraph answer

`html-in-canvas` does not do what the premise assumes. It is not a "render my app with the GPU" switch — your app is *already* GPU-composited on every platform Tauri targets ([RenderingNG](https://developer.chrome.com/docs/chromium/renderingng), [Tauri Linux graphics docs](https://v2.tauri.app/develop/debug/linux-graphics/)). It is a way to **composite live DOM subtrees into a 2D/WebGL/WebGPU scene** so that canvas-drawn UIs can reuse the browser's text layout and accessibility. It is unshipped, Chromium-only, behind a flag or an origin trial ([chromestatus 5172548013916160](https://chromestatus.com/feature/5172548013916160)), and both Mozilla and WebKit are at "no signal". Since Tauri uses WebKit on macOS and Linux ([Tauri webview versions](https://v2.tauri.app/reference/webview-versions/)), adopting it would be a Windows-only, flag-gated dependency on an experiment. **Recommendation: no.** §5 lists the things that would actually help, starting with a one-line change this repo is missing.

---

## 1. What html-in-canvas actually is

### 1.1 The proposal

The primary source is the WICG explainer at <https://github.com/WICG/html-in-canvas>. It is an incubation, not a standard: it is being developed through the WHATWG stages process, tracked at [whatwg/html#10650](https://github.com/whatwg/html/issues/10650).

The stated goal is to let "canvas surfaces benefit from features of browsers (text layout, interactivity, accessibility, etc)" ([WebKit/standards-positions#630](https://github.com/WebKit/standards-positions/issues/630) quoting the proposal). The accessibility motivation is explicit in the explainer: "There is currently no guarantee that the canvas fallback content used for `<canvas>` accessibility always matches the rendered content" ([explainer](https://github.com/WICG/html-in-canvas)). That is the real problem it solves — canvas-drawn UIs are accessibility black holes, and this makes the drawn pixels and the a11y tree the same object.

Note the lineage: this is the *second* attempt. The earlier retained-mode "Canvas place element" proposal ([WICG/canvas-place-element](https://github.com/WICG/canvas-place-element)) was **withdrawn** after WebKit flagged it as "needlessly complex" with an "error-prone, poorly named, or inconsistent" API ([WebKit/standards-positions#403](https://github.com/WebKit/standards-positions/issues/403)). html-in-canvas is the immediate-mode redesign that replaced it ([WebKit/standards-positions#630](https://github.com/WebKit/standards-positions/issues/630)).

### 1.2 API surface

Three primitives ([explainer](https://github.com/WICG/html-in-canvas)):

| Primitive | Form |
|---|---|
| Opt-in attribute | `<canvas layoutsubtree>` — opts canvas descendants into layout and hit testing |
| Draw methods | 2D: `ctx.drawElementImage(element, dx, dy[, w, h])` · WebGL: `WebGLRenderingContext.texElementImage2D()` · WebGPU: `GPUQueue.copyElementImageToTexture()` |
| Update signal | a `paint` event carrying "a list of the canvas children which have changed"; `canvas.requestPaint()` forces one |

Supporting API: `captureElementImage(element)` (transferable snapshot, usable from workers) and `getElementTransform(element, drawTransform)` (returns the CSS transform to apply so the real DOM element's hit region lines up with where you drew it in a 3D scene) ([explainer](https://github.com/WICG/html-in-canvas)).

Note the naming: the method as currently specified is **`drawElementImage()`**, not `drawElement()`. The `drawElement` name is what the original blink-dev "Ready for Developer Testing" thread used ([blink-dev](https://groups.google.com/a/chromium.org/g/blink-dev/c/LYJyOdLbOfY)); it was renamed during incubation. Anything you read that says `drawElement()` is describing an older revision.

### 1.3 Restrictions the explainer imposes on itself

These are from the explainer, not from critics ([explainer](https://github.com/WICG/html-in-canvas)):

- `layoutsubtree` must have been present on the canvas **in the most recent rendering update** — you cannot set it and draw in the same tick.
- The element **must be a direct child of the `<canvas>`**, as of the most recent rendering update. You cannot draw arbitrary DOM from elsewhere in the page.
- The element must have generated boxes — `display: none` subtrees cannot be drawn.
- **CSS transforms on the source element are ignored for drawing** (they still affect hit testing). This is exactly the asymmetry `getElementTransform()` exists to paper over.
- Overflowing content is clipped to the element's border box.
- The `paint` event runs **once per frame**, and DOM changes made during it only appear in the *next* frame — i.e. there is a built-in one-frame latency for reactive updates.

### 1.4 Tainting / security model

The explainer specifies "read-back-allowed rendering": the drawn output deliberately omits anything that would leak state to the page, so the canvas is **not** tainted and `getImageData()` still works. Excluded from the render ([explainer](https://github.com/WICG/html-in-canvas)):

- cross-origin embedded content and cross-origin URL references
- `:visited` link styling
- spelling/grammar markers
- pending form autofill values
- system colors, themes, and user preferences
- IME popups
- subpixel text anti-aliasing (so drawn text is measurably lower fidelity than the same text rendered normally)

Explicitly *not* treated as sensitive: find-in-page and text-fragment markers, and scrollbar/form-control appearance ([explainer](https://github.com/WICG/html-in-canvas)).

Two consequences that matter for an IDE: **cross-origin iframes render as nothing**, and **text drawn this way loses subpixel AA**. For a text-dense editor UI, the second is a visible regression, not a rounding error.

---

## 2. Status and availability — as of 2026-08-04

**All of §2 is a dated snapshot. Re-check before acting on it.**

| Fact | Value | Source |
|---|---|---|
| Chrome Platform Status ID | `5172548013916160` | [chromestatus](https://chromestatus.com/feature/5172548013916160) |
| Chrome status | **In development** — not shipped, no shipped milestone | [chromestatus](https://chromestatus.com/feature/5172548013916160) |
| Spec maturity | "Specification currently under development in a Working Group" (working draft) | [chromestatus](https://chromestatus.com/feature/5172548013916160) |
| Flag | `chrome://flags/#canvas-draw-element` | [explainer](https://github.com/WICG/html-in-canvas) |
| Origin trial | desktop/Android/WebView M148–M150, **extended through M154** | [Intent to Extend Experiment, blink-dev](http://www.mail-archive.com/blink-dev@chromium.org/msg16735.html) |
| W3C TAG review | [design-reviews#1204](https://github.com/w3ctag/design-reviews/issues/1204) — pending | [Intent to Extend](http://www.mail-archive.com/blink-dev@chromium.org/msg16735.html) |
| Mozilla position | **No formal position recorded.** Issue is open, labelled "needs proposed position", assigned to the Graphics team | [mozilla/standards-positions#1076](https://github.com/mozilla/standards-positions/issues/1076) |
| WebKit position | **No position label recorded** on the html-in-canvas issue | [WebKit/standards-positions#630](https://github.com/WebKit/standards-positions/issues/630) |

Chrome stable is around 151–152 in August 2026 (Chrome 151 released 2026-07-28, 152 expected 2026-08-25 — *secondary*, [releases.sh](https://releases.sh/google/chrome)), so the extended origin trial window (through M154) is **currently open**, and the feature is **still not on by default anywhere**.

The Chromium team's own stated risk is interop: "This API exposes a small amount of new information which carries an interop risk, such as the pixels of gradients and form controls" ([Intent to Extend](http://www.mail-archive.com/blink-dev@chromium.org/msg16735.html)). Mozilla raised fingerprinting and compatibility concerns which the proposal is still working through ([Intent to Extend](http://www.mail-archive.com/blink-dev@chromium.org/msg16735.html), [mozilla/standards-positions#1076](https://github.com/mozilla/standards-positions/issues/1076)). There is also open accessibility feedback at [w3c/aria#2758](https://github.com/w3c/aria/issues/2758).

Read the maturity signal plainly: **the extension of the origin trial was granted because the API changed substantially during the trial** — the WebGL/WebGPU surface and the privacy protections were reworked mid-flight ([Intent to Extend](http://www.mail-archive.com/blink-dev@chromium.org/msg16735.html)). This API is still moving. Its predecessor was withdrawn outright. A one-implementation, zero-signal, actively-mutating API is not a foundation.

---

## 3. Does it even apply to Tauri? Mostly no.

Tauri does not bundle Chromium. Per Tauri's own reference docs ([v2.tauri.app/reference/webview-versions](https://v2.tauri.app/reference/webview-versions/)):

- **Windows** — "Tauri uses WebView2 which is based on Microsoft Edge and therefore Chromium."
- **macOS** — "Tauri uses WebKit on macOS (through WKWebView)", preinstalled since 10.10.
- **Linux** — "Tauri uses WebKit on ... Linux (through `webkit2gtk`)."

wry's README agrees: "WebKitGTK is used to provide webviews on Linux", "WebKit is native on macOS", "WebView2 provided by Microsoft Edge Chromium is used" on Windows ([tauri-apps/wry](https://github.com/tauri-apps/wry)).

So the ceiling for a Chromium-only API in Tauri is **Windows only**. On macOS and Linux `ctx.drawElementImage` would be `undefined`, forever, unless and until WebKit implements it — and WebKit has recorded no position and previously rejected the predecessor design ([WebKit/standards-positions#403](https://github.com/WebKit/standards-positions/issues/403), [#630](https://github.com/WebKit/standards-positions/issues/630)).

### 3.1 And on Windows it is still not usable

Two gates, both from Microsoft's own docs:

1. **Command-line switches.** WebView2 does accept Chromium switches via `CoreWebView2EnvironmentOptions.AdditionalBrowserArguments`, and the docs specifically describe merging of `--enable-features` / `--disable-features` ([Microsoft Learn](https://learn.microsoft.com/en-us/microsoft-edge/webview2/reference/winrt/microsoft_web_webview2_core/corewebview2environmentoptions)). But the same doc warns: "If you specify a switch that is important to WebView functionality, it is ignored... **Specific features are disabled internally and blocked from being enabled.**" There is no published guarantee that `CanvasDrawElement` is enable-able in WebView2, and Microsoft reserves the right to block it.
2. **Origin trials.** Edge runs its *own* origin trial program with its own registry; tokens go in a `<meta>` tag or `Origin-Trial` header and "expire in 6 weeks, by default" ([Microsoft Learn — origin trials](https://learn.microsoft.com/en-us/microsoft-edge/origin-trials/)). Chrome origin trial tokens are not Edge origin trial tokens. And a desktop app loading from `tauri://localhost` / a custom scheme is a poor fit for an origin-scoped token in the first place.
3. **Experimental APIs need a preview runtime.** "The Evergreen WebView2 Runtime doesn't include experimental WebView2 APIs; instead ... your app should use the version of WebView2 that is in a Microsoft Edge preview channel (Edge Beta, Edge Dev, or Edge Canary)" ([Microsoft Learn](https://learn.microsoft.com/en-us/microsoft-edge/webview2/how-to/set-preview-channel)). You cannot ask users to install Edge Canary.

Also worth noting: the origin trial's "WebView" platform on chromestatus means **Android System WebView**, not WebView2. I found no Microsoft statement either way about html-in-canvas in WebView2 — see §7.

Net: on Windows it would require shipping a non-default browser flag to end users and hoping Microsoft has not blocklisted it; on macOS and Linux it does not exist. That is the definition of a feature you branch around rather than build on.

---

## 4. The premise: "so my app can be rendered with GPU"

This is the part worth correcting, because it is the actual decision driver and it is false in both directions.

### 4.1 Your app is already GPU-rendered

Chromium's rendering architecture (RenderingNG) states its property as **"GPU raster and draw everywhere. This uses the GPU on all platforms, and all devices, to hyper-accelerate the rendering and animating of web content"** ([developer.chrome.com/docs/chromium/renderingng](https://developer.chrome.com/docs/chromium/renderingng)). The older design doc describes the compositor as a library in `cc/` that manages layer trees and "can use the GPU to perform its drawing step" via the GPU process ([chromium.org — GPU accelerated compositing in Chrome](https://www.chromium.org/developers/design-documents/gpu-accelerated-compositing-in-chrome/)). That is the Windows/WebView2 path.

On Linux, Tauri's own docs describe WebKitGTK's default as the *accelerated* path, with the escape hatches framed as regressions: `WEBKIT_DISABLE_DMABUF_RENDERER=1` fixes DMABUF/`Error 71` crashes "**at the cost of the faster rendering path**", and `WEBKIT_DISABLE_COMPOSITING_MODE=1` is a "last resort" that "**disables accelerated compositing entirely**" — with the warning "Only ship an unconditional override like this if you have verified your app is affected. It disables a faster path for everyone" ([Tauri — Linux Graphics Issues](https://v2.tauri.app/develop/debug/linux-graphics/)).

Read that carefully, because it inverts the premise. On Linux the realistic risk is not "my app isn't GPU rendered so let me add a GPU API" — it is "**something in my dependency chain silently turned GPU compositing off**". The failure mode is well documented across the ecosystem: WebKitGTK's DMABUF renderer failing to initialize on NVIDIA proprietary drivers and some Wayland compositors, producing a blank window ([tauri-apps/tauri#9394](https://github.com/tauri-apps/tauri/issues/9394), [tauri-apps/tauri#12951](https://github.com/tauri-apps/tauri/issues/12951)). If this app feels slow on Linux, **check whether one of these env vars is set** before reaching for a new API.

One honest caveat on §4.1: the older Chromium design doc also says "accelerated compositing ... kicks in only if certain types of content appear on the page" ([chromium.org](https://www.chromium.org/developers/design-documents/gpu-accelerated-compositing-in-chrome/)) — i.e. layer *promotion* is still conditional. But that document predates RenderingNG; the modern statement of intent is "GPU raster and draw everywhere" ([renderingng](https://developer.chrome.com/docs/chromium/renderingng)). Both are Chromium primary sources and they describe different eras; I am treating RenderingNG as current.

### 4.2 What html-in-canvas is actually for

It goes the *other* direction. It does not put your DOM on the GPU — the DOM is already there. It gives you a way to take a DOM subtree that the browser has already laid out and **inject it as a texture into a canvas/WebGL/WebGPU scene you are drawing yourself** ([explainer](https://github.com/WICG/html-in-canvas)). The use cases are 3D UIs, WebGL scenes needing real text layout, and canvas apps that want a real accessibility tree.

If you drew your IDE chrome through it, you would be *adding* a step: DOM layout → paint to texture → your canvas draw → composite. Plus a one-frame update latency, no subpixel AA, ignored CSS transforms, and hand-rolled hit testing (§1.3, §1.4). It is not a speedup for a DOM app. It is a bridge for a canvas app.

---

## 5. If the goal is a faster IDE UI, do these instead

Proportionate list, primary sources only.

**(a) The one-line fix this repo is missing.** `package.json` depends on `@xterm/xterm` and `@xterm/addon-fit` — but **not `@xterm/addon-webgl`**. That addon "enables a WebGL2-based renderer" for xterm.js ([xtermjs/xterm.js addon-webgl](https://github.com/xtermjs/xterm.js/tree/master/addons/addon-webgl)). Terminal scroll/redraw is the single most render-bound surface in an IDE, and this is the sanctioned, shipping, cross-browser way to GPU-accelerate it. It works in WKWebView and WebKitGTK, unlike anything in §1. If any part of this app "should be rendered with GPU", it is the terminal, and the mechanism already exists.

**(b) Let the compositor do its job; use `will-change` surgically.** MDN is blunt that this is not a general accelerant: "**`will-change` is intended to be used as a last resort to try to deal with existing performance problems.** It should not be used to anticipate performance problems," and "Overusing the property can cause the page to slow down instead of improving its performance" ([MDN — will-change](https://developer.mozilla.org/en-US/docs/Web/CSS/will-change)). MDN's recommended pattern is toggling it from script immediately before and after the change, not declaring it in a stylesheet. Applied to a whole IDE layout it will make things worse, not better.

**(c) Canvas-rendered UI, as an architecture, not as a flag.** This is the real version of what html-in-canvas gestures at, and it does not need an experimental API — it needs you to write a renderer. VS Code's terminal took this route via the xterm.js WebGL addon (a). Note that VS Code's *editor* did not: Monaco, which this repo depends on, is DOM-based. If Monaco's rendering is the bottleneck you are feeling, the answer is virtualization and fewer layout-invalidating updates, not a new canvas API.

**(d) Native GPU rendering outside the webview.** Tauri/wry exposes the raw window handle, and wry ships an official [`examples/wgpu.rs`](https://github.com/tauri-apps/wry/blob/dev/examples/wgpu.rs) demonstrating wgpu rendering into a Tauri-managed window; the overlay approach is discussed in [tauri-apps discussion #11944](https://github.com/orgs/tauri-apps/discussions/11944). This is real GPU rendering with no webview involvement and no experimental flags — but it is a separate surface, and you get no DOM, no CSS, no Monaco, and no accessibility inside it. Reasonable for a viewport, absurd for an IDE shell.

**(e) The full-commitment version: leave the webview.** Zed's [gpui](https://github.com/zed-industries/zed/tree/main/crates/gpui) is "a hybrid immediate and retained mode, GPU accelerated, UI framework for Rust" — views build an element tree, style it with a Tailwind-like API, and "give them to GPUI to turn into pixels". That is what a genuinely GPU-drawn IDE looks like. It is also a decision to not have a webview, which is a different project than this one. (See `docs/RESEARCH-zed-harness.md` for prior work on Zed in this repo.)

---

## 6. Bottom line

**Do not adopt html-in-canvas.** Four independent reasons, any one of which is sufficient:

1. **It does not do what you want.** It composites DOM *into* canvas scenes. Your app is a DOM app and is already GPU-composited ([renderingng](https://developer.chrome.com/docs/chromium/renderingng), [Tauri Linux graphics](https://v2.tauri.app/develop/debug/linux-graphics/)). Routing your UI through it adds a frame of latency and loses subpixel AA (§1.3–1.4, §4.2).
2. **Cross-platform breakage is total, not partial.** Tauri is WebKit on macOS and Linux ([Tauri docs](https://v2.tauri.app/reference/webview-versions/), [wry](https://github.com/tauri-apps/wry)). Two of three platforms get nothing, and WebKit has recorded no position after rejecting the predecessor design ([#403](https://github.com/WebKit/standards-positions/issues/403), [#630](https://github.com/WebKit/standards-positions/issues/630)). You would maintain two renderers to gain nothing on either.
3. **Even Windows does not work.** Requires a non-default Chromium flag pushed through `AdditionalBrowserArguments` — which Microsoft explicitly may block ([Microsoft Learn](https://learn.microsoft.com/en-us/microsoft-edge/webview2/reference/winrt/microsoft_web_webview2_core/corewebview2environmentoptions)) — or an Edge origin trial token with a 6-week default lifetime that does not fit a custom-scheme desktop app ([Microsoft Learn](https://learn.microsoft.com/en-us/microsoft-edge/origin-trials/)).
4. **Maturity risk is high and currently realized.** Not shipped, TAG review pending, both other vendors silent, and the origin trial was *extended specifically because the API changed substantially mid-trial* ([chromestatus](https://chromestatus.com/feature/5172548013916160), [Intent to Extend](http://www.mail-archive.com/blink-dev@chromium.org/msg16735.html)). The v1 of this idea was withdrawn. Even the method name changed (`drawElement` → `drawElementImage`).

**Do this instead, in order:**

1. **Measure before optimizing.** There is no evidence in this repo that rendering is the bottleneck. An agent IDE's felt latency is usually the model round-trip, not the compositor.
2. **On Linux, verify you have not disabled GPU compositing.** Check for `WEBKIT_DISABLE_DMABUF_RENDERER` / `WEBKIT_DISABLE_COMPOSITING_MODE` in the environment or in `src-tauri` startup code ([Tauri docs](https://v2.tauri.app/develop/debug/linux-graphics/)). This is the one plausible way this app is *not* GPU rendered today.
3. **Add `@xterm/addon-webgl`.** It is the only item on this page that is shipping, cross-platform, and targets a surface that is genuinely render-bound ([xterm.js](https://github.com/xtermjs/xterm.js/tree/master/addons/addon-webgl)).

This also reads straight off the repo's stated philosophy (`memory/less-is-more-philosophy.md`): a flag-gated, single-vendor, actively-mutating API that breaks two of three platforms is the maximal-weight option for a benefit that has not been shown to exist.

---

## 7. What I could not verify

Stated plainly rather than guessed:

- **`chromestatus.com/feature/5172548013916160` HTML page did not render for me** — the human-facing page returned an empty shell (it is a JS SPA). All chromestatus facts in §2 come from the JSON API endpoint `https://chromestatus.com/api/v0/features/5172548013916160`, which did return data. Same underlying record, different surface.
- **No Microsoft statement found, either way, on html-in-canvas / `CanvasDrawElement` in WebView2.** The chromestatus origin trial platform list says "WebView", which in Chromium's vocabulary means Android System WebView, not WebView2. My §3.1 conclusion is *inference* from the general WebView2 flag and origin-trial docs, not a direct Microsoft statement about this feature. If you want certainty, test it: set `AdditionalBrowserArguments` to `--enable-features=CanvasDrawElement` in `src-tauri` and check whether `CanvasRenderingContext2D.prototype.drawElementImage` exists. That is a 15-minute experiment and it settles the question definitively for your target WebView2 version.
- **I did not read the full WICG explainer text verbatim.** I fetched it twice (repo landing page and `raw.githubusercontent.com/WICG/html-in-canvas/main/README.md`) and both returned consistent structured summaries; §1.3 and §1.4 are faithful to those but the bullet lists may not be exhaustive. If you need the complete restriction set, read the README directly.
- **Mozilla's position is genuinely ambiguous in secondary reporting.** Some write-ups describe it as "negative", others as "no signal". The chromestatus record says **"No signal"** and the Mozilla issue itself is labelled **"needs proposed position"** and unassigned to a stance ([#1076](https://github.com/mozilla/standards-positions/issues/1076)). I am reporting "no formal position" because that is what the two primary sources say. Either way it is not support.
- **Exact current Chrome stable milestone.** I used a secondary source (releases.sh) for the 151/152 dates. It affects only whether the M154 origin trial window is open, not any conclusion.
- **I did not benchmark anything.** No claim here about this app's actual frame times. §6 step 1 exists for that reason.

---

## 8. Sources

### Primary — the proposal
- <https://github.com/WICG/html-in-canvas> — the explainer. Establishes the API surface (`layoutsubtree`, `drawElementImage`, `texElementImage2D`, `copyElementImageToTexture`, `paint`), the drawing restrictions, and the read-back-allowed tainting model.
- <https://github.com/WICG/canvas-place-element> — the withdrawn predecessor proposal.
- <https://github.com/whatwg/html/issues/10650> — the WHATWG tracking issue; establishes standards venue and stage.

### Primary — status and vendor positions
- <https://chromestatus.com/feature/5172548013916160> (data via `/api/v0/features/5172548013916160`) — establishes: category Graphics, status "In development", not shipped, OT M148–150, Firefox and Safari both "No signal".
- <http://www.mail-archive.com/blink-dev@chromium.org/msg16735.html> — Intent to Extend Experiment. Establishes the extension through M154, the TAG review link, the stated interop risk, and that the API changed substantially mid-trial.
- <https://groups.google.com/a/chromium.org/g/blink-dev/c/LYJyOdLbOfY> — original "Ready for Developer Testing" intent; establishes the earlier `drawElement` naming.
- <https://github.com/w3ctag/design-reviews/issues/1204> — TAG design review, pending.
- <https://github.com/mozilla/standards-positions/issues/1076> — establishes Mozilla has **not** recorded a formal position ("needs proposed position", Graphics team).
- <https://github.com/WebKit/standards-positions/issues/630> — html-in-canvas; no position label recorded.
- <https://github.com/WebKit/standards-positions/issues/403> — the predecessor; establishes WebKit's "needlessly complex" / "error-prone... API" concerns and the withdrawn status.
- <https://github.com/w3c/aria/issues/2758> — open accessibility feedback on the proposal.

### Primary — Tauri / webview engines
- <https://v2.tauri.app/reference/webview-versions/> — establishes Windows = WebView2/Chromium, macOS = WKWebView, Linux = webkit2gtk.
- <https://github.com/tauri-apps/wry> — wry README; independently confirms the same per-platform engine mapping.
- <https://v2.tauri.app/develop/debug/linux-graphics/> — establishes that WebKitGTK's DMABUF path is the *fast* path and that the workaround env vars disable acceleration.
- <https://github.com/tauri-apps/tauri/issues/9394>, <https://github.com/tauri-apps/tauri/issues/12951> — real reports of WebKitGTK GPU/NVIDIA rendering failures in Tauri.
- <https://github.com/tauri-apps/wry/blob/dev/examples/wgpu.rs> — official wry wgpu example (native GPU rendering into a Tauri window).
- <https://github.com/orgs/tauri-apps/discussions/11944> — Tauri org discussion on wgpu-as-webview-overlay.

### Primary — Microsoft / WebView2
- <https://learn.microsoft.com/en-us/microsoft-edge/webview2/reference/winrt/microsoft_web_webview2_core/corewebview2environmentoptions> — `AdditionalBrowserArguments`; establishes that Chromium switches are accepted, `--enable-features` is merged, and that some features are "disabled internally and blocked from being enabled".
- <https://learn.microsoft.com/en-us/microsoft-edge/origin-trials/> — establishes Edge runs its own origin trial registry with ~6-week default token lifetime.
- <https://learn.microsoft.com/en-us/microsoft-edge/webview2/how-to/set-preview-channel> — establishes the Evergreen WebView2 Runtime excludes experimental APIs.

### Primary — GPU rendering baseline
- <https://developer.chrome.com/docs/chromium/renderingng> — establishes "GPU raster and draw everywhere" as the modern Chromium property. The core rebuttal to the premise.
- <https://www.chromium.org/developers/design-documents/gpu-accelerated-compositing-in-chrome/> — older design doc; the layer-tree/compositor model and the conditional-promotion caveat noted in §4.1.

### Primary — alternatives
- <https://github.com/xtermjs/xterm.js/tree/master/addons/addon-webgl> — `@xterm/addon-webgl`, "enables a WebGL2-based renderer". The concrete recommendation.
- <https://developer.mozilla.org/en-US/docs/Web/CSS/will-change> — MDN (spec-adjacent); establishes `will-change` is a last resort and that overuse degrades performance.
- <https://github.com/zed-industries/zed/tree/main/crates/gpui> — gpui README; "hybrid immediate and retained mode, GPU accelerated, UI framework for Rust".

### Secondary (marked — no load-bearing claim rests on these)
- <https://releases.sh/google/chrome> — *secondary.* Used only for the Chrome 151/152 August 2026 release dates, to judge whether the M154 OT window is open.
- <https://html-in-canvas.dev/docs/browser-support/> — *secondary.* Community site; surfaced during search as a pointer to the flag name and Chromium 147+ availability. Every claim it makes that appears above is independently sourced to the explainer or chromestatus.
