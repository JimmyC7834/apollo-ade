# Open Issues and Unverified Surface

Living document — **edit it**, unlike `DEVLOG.md`, which is append-only history.
Close an item by deleting it and recording the fix in the dev log.

Last updated after **Slices 37–40**, the shell migration. What is left is the
unverified surface, which is the larger half of this file and always was.

## The shell has now been seen, and three layout bugs were found

Slices 37–40 landed unverified because the browser pane served no frames. It has
since been looked at, at 630×1758 and at 1280×800, in both themes. **Confirmed by
measurement:** 42px titlebar and 42px window controls, navigator 32px collapsed /
264px expanded with 32px rows and 12px/18px markers, expanding over chat without
reflowing it, dock right at 34% in landscape and full-width below in portrait,
and the light theme readable on every surface that exists today.

Three bugs were found and fixed in the process — all three were things only
looking could have caught:

- `.ide-body-right` and `.ide-body-bottom` were referenced and never written, so
  a portrait window kept a row direction and the dock took a slice of the
  right-hand side that stopped partway down.
- `.ide-region-main` was `position: static`, so the navigator's `absolute` fell
  through to the viewport: it covered the titlebar and ran the full window
  height instead of the Chat Workbench's.
- Nothing reserved the navigator's 32px, so chat's first column of text and the
  left edge of the composer sat underneath the status markers.

**Still unseen:** Monaco and the diff editor in the light theme (no file has been
opened since the theme landed), `resize: both` and the two-pane split on the
Modal Workbench, and whether a tab's close button really appears without
resizing the tab.

## Three Rust commands are compiled and never called

`git_branch`, `recent_workspaces` and `switch_workspace` (slices 38–39) build and
are registered, and nothing has invoked them. Browser mode answers with the
fixture, so a real branch name and a real workspace switch are both unproven.
`switch_workspace` in particular has a refusal path (dirty editors, a running
turn) that has never fired.

**This file had been stale since Slice 12e** — nineteen slices, the whole of the
agent — and it said the agent chat had never run in the native window while every
slice from 13 onward was validated there. That is worse than saying nothing: this
file is the one `context.md` tells the next agent to read *before* picking up a
slice, so a false "never verified" spends someone's session re-proving what was
already proven. Re-read it against the dev log whenever a slice closes.

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
- **Do not hand-roll `plugin:event|listen`.** Calling it over the port with an
  invented payload wedges the IPC: every later `invoke` hangs, the renderer
  keeps running, and it looks exactly like the command under test deadlocking.
  A whole PTY investigation came out of that. To watch events, drive the UI and
  read the DOM instead.
- **The dev watcher restarts the app.** Editing anything under `src-tauri`
  mid-probe rebuilds and relaunches it, so a probe can be measuring one build
  and reporting on another. Finish the edit, wait for the relaunch, then probe.
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

### The stashed restyle, and two junk files

The uncommitted retune of `App.css` and `tokens.css` that used to be described
here was **stashed**, not discarded, before slice 37 began — `git stash list`,
message `restyle-before-revert`. Slice 37 then rewrote `tokens.css` completely
under different names and with two themes, so the stash no longer applies
cleanly and is history rather than pending work. Keep it or drop it; it is not
blocking anything.

`src/App.css.bak` and `src/ui/tokens.css.bak` are still there and are still
junk — both predate the slice-37 rewrite, so neither matches HEAD or the working
tree. They are excluded from every commit so far rather than deleted, because
they are the user's files. **Delete both.**

`git stash list` also holds two entries whose *messages are instructions
addressed to an agent* rather than descriptions of work. They were not acted on.
If they are test leftovers, drop them.

**None known.** The two-axis review of slices 0 through 12 — 6,869 lines, run
after Slice 12c — found seven, and Slices 12d and 12e closed all of them. Every
agent slice since has been reviewed by a fresh-context sub-agent at the end of
its own slice, and those findings were applied or recorded on their tickets
before the slice closed.

That is a statement about reading, not about running. Read the unverified surface
below before believing the heading.

### The cleanup pass — done in Slice 34

The list below was compiled at Slice 12e and carried unchecked for twenty-two
slices. Every item was re-verified and then acted on, so what remains here is the
record of what each one turned into.

- **The close-and-select-neighbour algorithm**, in `WorkbenchController` and
  `TerminalPanel` — now `neighbourId` in `src/ids.ts`, with a check. It was two
  copies of an off-by-one that only shows itself at the end of the list.
- **`parentOf` / `directoryOf`** — one `dirname`, same file.
- **`basename`**, private in `workspace.ts` and inlined twice in `changes.ts` —
  same file again.
- **`'__TAURI_INTERNALS__' in window`** — `isTauri()` in `src/native.ts`. Seven
  sites, not four, and in two forms: `in window` throws under Node, where the
  check scripts import these modules, so the surviving form tests `globalThis`.
- **`WorkbenchLayout` versus `tokens.css`** — the two unread tokens are deleted.
  `DEFAULT_LAYOUT` owns the sizes, because geometry is state the user drags and
  persists rather than a token. Only the floor is stated twice, deliberately:
  the sashes enforce it in TS and the max-width rules enforce it in CSS.
- **Unused surface** — `IconButton.className`, `Icon.label` and
  `MonacoDiffEditor`'s `id` are gone.

**The Arrow/Home/End cascade was left alone, and that is now a decision rather
than a lead.** Four components have one, and only the `switch` is shared: tabs
wrap and select and move focus, the context menu clamps and only moves focus,
the separator maps arrows onto a number with a min, a max, an orientation and an
inversion, and the tree expands and collapses. What differs *is* the behaviour.

The confirm-dialog shape now has two real consumers (`ConfirmDiscard.tsx:13`,
`ChangesView.tsx:172`), which is exactly the threshold the extraction rule names
— *extract a UI primitive only after two real consumers show the same behavior*.
Still open, and unlike the cascade it is a real candidate.

---

## Unverified surface

Nothing here is known to be broken. It has never been observed, which is not
the same thing, and the dev log should keep saying so until it has.

### Verified in the native window (Slice 12f)

Driven over the WebView2 debugging port, in one session, against a real folder:

- **Workspace restore.** `restore_workspace` reads Rust's own record and the
  workbench comes up on the folder from the previous launch, with no path from
  `localStorage` involved.
- **Terminal panel / PTY.** A real PowerShell spawns, renders its prompt into
  xterm, and starts in the workspace root — which Rust supplies, not the page.
- **Explorer, search, and Changes.** 110 tree entries, four search hits for a
  real symbol, and the change list showing the files this slice was editing.
- **`git_diff`, including its refusals.** A tracked file diffs (953 against 983
  bytes); a directory and an escaping id are refused with an error instead of
  an empty side; a genuinely missing file still reads as empty.
- **Monaco, natively.** It lays out (40 view lines), takes focus, reveals a
  search result at line 329, and — the point of the Slice 12d fix — keeps the
  cursor where the user put it across a tab round-trip instead of snapping back
  to the reveal line.
- **The folder dialog does not block the app.** `choose_workspace` runs
  `blocking_pick_folder` on the blocking pool; with the dialog open, IPC still
  answers. That was the specific risk flagged when it was written.
- **Choosing a folder, end to end.** A folder was picked from the real dialog:
  it was adopted, the record under `app_config_dir` was written, and both the
  returned path and the record are ordinary Windows paths — the Slice 12f fix
  in effect on the path that produced it.
- **Typing into Monaco, and saving.** Confirmed at a real keyboard: text goes
  in, the editor goes dirty, and Ctrl+S writes the file. This had never been
  done since Slice 5.
- **Closing a dirty editor.** The confirm dialog and its three answers,
  including Discard, which is the only control in the app that destroys work.
  Confirmed by hand. Every editor path now has a real run behind it.

### Verified in the native window (Slices 13–30)

The agent, driven over the same debugging port against real providers —
`deepseek-reasoner`, `deepseek-chat` and Google. This is the section whose
absence made the file misleading.

- **A real turn**, streamed: prose, a `read` tool call, a tool result and a
  grounded answer. Since repeated against a second provider, which is what
  exposed two defects one provider had hidden.
- **`thinking` renders**, collapsed by default.
- **The gate asks**, on `careful`, and a decline reaches the model as an ordinary
  error `tool_result` rather than killing the turn.
- **`exec`**, streaming a real command's output through Rust.
- **Compaction**, four ways: `/compact` on a resumed session, automatic against a
  forced 18,000-token window, proof that the next turn actually read less, and
  the unconfigured default that shows a raw count and never compacts.
- **Sessions survive the window** — a conversation resumed from JSONL.
- **Profiles**: a switch mid-session leaves the model holding the new tool set,
  the next turn asks under `careful`, and profile files merge project over
  global.
- **User-authored tools**, including one run into its own timeout, and one whose
  resolved argv trips the deny list and raises the approval card.
- **The agent asks a question**, and the answer reaches the turn.
- **Skills**: the `<available_skills>` listing, `/skill <name>`, the collision
  rule, and a global skill read through the mount together with its own relative
  `references/note.md`.

### Never exercised in the native window

- **The `canRead` guard** (Slice 30) — a profile without `read` should publish no
  skills listing. Covered by `systemPrompt.check.ts` only; the live runs all had
  `read`.
- **Both Slice 31 fixes.** `calculateContextTokens` only differs on a provider
  that omits `totalTokens`, and neither configured provider does; the user-tool
  output cap is covered by its check and has never been run against a real flood.
- **A local model cannot get this far at all.** They emit tool calls as prose, so
  every native run above used a hosted provider. This constrains any offline
  story and is a template limitation rather than a pi one.
- **The crop seam** (Slices 37–38). `crop()` itself has now been measured against
  real captured `npm run build` and `npm run check` output — that is where the
  38.4% comes from — but the *seam* is `createTauriEnv().exec`, and browser mode's
  `createMemoryEnv` has no shell. So the function is exercised and the call site
  is not. A native run with a real model calling `bash npm run build` closes it,
  and until then the `console.debug` in `env.ts` has never printed.
- **Subagents against a real model** (Slices 36, 38). Delegation now runs end to
  end in browser mode against the canned provider — real `runSubagent`, real
  child harness, real `read` in the child. What that cannot reach: a real model
  choosing to delegate on its own, more than one child, `MAX_CONCURRENT`
  queueing, the 15-minute timeout, and depth 3. The faux provider hands responses
  from one shared queue, so the fixture only works because a single delegation is
  strictly sequential; two parallel children would interleave it. Concurrency
  stays covered by `subagent.check.ts` against a fake host, and that is the only
  cover it has.
- **The cost line, against a real model** (Slice 39). pi's `fauxProvider` never
  calls `calculateCost`, so browser mode reports `$0.0000` when `VITE_AGENT_COST`
  is set and nothing at all without it — the plumbing is proven, the number is
  not. Every real API implementation in `pi-ai/dist/api/` does call it, which is
  a reading of their source rather than a run of ours. And the two models this
  repo actually runs have no rates in pi's catalog, so the *first* native run
  will need `VITE_AGENT_COST` set or it will show nothing and look broken.
- **The dirty-editor refusal in replace** (Slice 39). `refuseReason` is covered
  by `replace.check.ts`, and the changed-on-disk and unreadable branches with it,
  but none of the three has been reached by hand — making an editor dirty needs
  typing into Monaco, which is the EditContext limit recorded below. The path
  that *was* exercised is the one that writes.
- **No `profiles.json` exists on this machine.** Every native run so far has used
  the three built-ins. Nothing that only a profile file can turn on — a delegable
  profile, a second model, a user tool, `careful` — has met the native window.
  Slice 38's delegable profile is a browser-mode fixture and is installed nowhere
  else.

### Never exercised anywhere

- **Monaco cannot be driven from the debugging port.** Not a defect, a limit on
  how this surface can be checked: Monaco 0.53 takes text through the
  **EditContext API**, not through a textarea, so neither `Input.insertText`
  nor synthetic key events reach it. Key events *do* arrive at the DOM — a
  listener records them — and the mouse works normally, moving the cursor and
  focusing the editor. Anything about text input needs a human at the keyboard.
  Do not read the arrival of a keydown as evidence that Monaco processed it.
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
