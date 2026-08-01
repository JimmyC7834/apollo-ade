# Open Issues and Unverified Surface

Living document — **edit it**, unlike `DEVLOG.md`, which is append-only history.
Close an item by deleting it and recording the fix in the dev log.

Last updated after Slice 12e, which closed the last of the review defects. What
is left is the unverified surface, which is the larger half of this file and
always was.

---

## How to inspect the native window

This is the capability everything below depends on, so it comes first. Until
Slice 12b nothing had ever been observed running in the real Tauri window; the
browser pane at `localhost:5190` was the only surface, and it is not equivalent
(see the warning below).

Tauri on Windows uses WebView2, which speaks the Chrome DevTools Protocol. Start
the app with a debugging port:

```bash
WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222 npm run tauri dev
```

Then `http://localhost:9222/json` lists targets, and the page target's
`webSocketDebuggerUrl` accepts `Runtime.evaluate` with `awaitPromise: true`.
Node 22+ has a built-in `WebSocket`, so a ~40 line client is enough — no
dependency needed.

Two things that cost time when this was first set up:

- **Close the socket cleanly.** Calling `process.exit()` straight after
  `ws.close()` leaves WebView2 holding a half-open debugger connection, and it
  can stall its UI thread on one. That looks exactly like the app hanging.
- **Reset state between probes.** A dialog left open from a previous probe makes
  the tree behind it inert, so the next probe's clicks do nothing and the
  results look like failures.
- **Measure a control before theorising.** The editor-focus defect took three
  sessions of reading code and one A/B run: probe, comment out `StrictMode`,
  probe again, restore. Vite reloads on the edit, so a control and an experiment
  are two minutes apart in the same window. Do that before forming a theory
  about anything mount-related — React's development double-mount disposes and
  recreates Monaco, and it looks exactly like a bug in your own code.

Selecting a workspace without driving the OS folder dialog:

```js
await window.__TAURI_INTERNALS__.invoke('set_workspace', {
  path: 'C:/Users/.../tauri-ade-prototype',   // forward slashes
});
```

Use **forward slashes**. Backslashes survive neither shell heredocs nor JS
string escaping reliably, and `set_workspace` rejects a mangled path with
Windows error 123, which reads like an app bug and is not one.

`set_workspace` is a **debug-build affordance only** — it refuses in release,
because a root named by the renderer is the hole `choose_workspace` closes. It
records the root exactly as a real choice does, so a probe survives a reload.

To make the UI reflect it, write `ade.workbench` into `localStorage` with a
`workspace` field and reload — that exercises the real restore path. Only the
*presence* of that field matters now; the `path` in it is decorative, since
`restore_workspace` takes no argument and reads Rust's own record.

### The browser pane is not a substitute

The in-app browser pane never composites. Measured: **0 animation frames in
500ms**, against 32 in the native window. Consequences that produced wrong
conclusions during Slice 12:

- Monaco never lays out, renders no view lines, and accepts no synthetic input.
- `requestAnimationFrame` never fires, and background `setTimeout` is throttled
  to roughly one second, so a 128ms retry sequence stretches to several seconds.

Anything about timing, focus, layout inside Monaco, or animation **must** be
verified in the native window. Semantics-only checks (roles, labels, state) are
still fine there.

---

## Open defects

**None.** The two-axis review of slices 0 through 12 — 6,869 lines, run after
Slice 12c — found seven, and Slices 12d and 12e closed all of them.

That is a statement about reading, not about running. Every one of those seven
was found by reading the source, and every fix was verified the same way; the
unverified surface below has not shrunk, and is now the only thing standing
between this and a working app. Read it before believing the heading.

### Not defects, but worth a cleanup pass

Duplication the review turned up, none of it wrong today:
`forceCloseEditor` (`WorkbenchController.tsx:324`) and `close`
(`TerminalPanel.tsx:33`) are the same close-and-select-neighbour algorithm;
`parentOf` (`ExplorerTree.tsx:19`) and `directoryOf` (`ChangesView.tsx:31`) are
identical bodies under two names; `basename` (`workspace.ts:84`) is re-inlined
twice in `changes.ts`; the `'__TAURI_INTERNALS__' in window` test appears in four
files; the same Arrow/Home/End cascade appears in four components; and
`WorkbenchLayout.tsx:27` hardcodes three sizes that `tokens.css:96` already
defines, two of which are now unused.

Unused surface: `IconButton.className`, `Icon.label`, `MonacoDiffEditor`'s `id`.

The confirm-dialog shape now has two real consumers (`ConfirmDiscard.tsx:13`,
`ChangesView.tsx:172`), which is exactly the threshold the extraction rule names
— *extract a UI primitive only after two real consumers show the same behavior*.

---

## Unverified surface

Nothing here is known to be broken. It has never been observed, which is not
the same thing, and the dev log should keep saying so until it has.

### Never exercised in the native window

- **Terminal panel / PTY.** The whole of Slice 6 natively: spawning PowerShell,
  input and output, resize, multiple terminals, disposal on close. Only the
  browser echo fake has ever run.
- **Agent chat.** Slice 11 natively — streaming with real animation frames,
  approval, cancellation, the live region. Note the deterministic provider paces
  on `requestAnimationFrame` when the document is visible, which has therefore
  never actually been the code path under test.
- **Explorer "Open Folder" empty state** and the native folder dialog, which
  needs a real OS dialog and a user gesture. Slice 12e moved that dialog into
  Rust (`choose_workspace`), so what has never been run is now a
  `blocking_pick_folder` call on the async command runtime — a plausible place
  to deadlock, and the one thing here that would be obvious in ten seconds of
  actually opening a folder.
- **`restore_workspace`**, and the record under `app_config_dir` it reads. The
  path that matters — quit with a folder open, relaunch, get it back — has
  never been walked natively.

### Never exercised anywhere

- **Typing into Monaco**, and therefore dirty state surviving dialog dismissal
  end to end. No file has ever been edited through the UI and saved. This was
  previously written up here as "sound by construction", on the grounds that
  `EditorDialog` holds no content state. That was wrong, and the reveal-on-every-
  keystroke defect closed in Slice 12d is what was hiding behind it. Do not argue
  a surface is safe from its structure while it has never been run. The fix for
  that defect is itself unobserved for the same reason.
- **Screen reader.** Every accessibility claim in the dev log is structural:
  roles, labels, focus order and live-region wiring verified in the DOM. None of
  it has been heard. The `role="log"` transcript streaming word by word is the
  most likely thing to be unpleasant in practice.

### Exercised only past the point of the picker

- **Browser File System Access provider** (`src/workspace.ts`, the Slice 10c
  deviation). The picker needs a user gesture. Everything after it — the
  recursive walk, ignored directories, the depth cap, reading, the fatal-UTF-8
  rejection, saving via `createWritable`, search over real files — is first-run
  code. Its rules are a second implementation of what `workspace.rs` enforces,
  and only review keeps the two copies agreeing.

---

## Testing gap worth closing

Slice 12 shipped a regression that made the workbench unusable — a closed
`<dialog>` holding 760px of the layout — while every check passed. The checks
queried roles, labels, focus and open/closed state, and all of that was correct.
None of them looked at geometry.

`npm run check` covers pure logic only. Before calling a layout or overlay slice
done, assert **sizes and positions** of the regions behind the change, not just
its semantics.
