# 70 — The agent drives the page

**Blocked by:** [69](69-a-page-you-can-look-at.md).
**Status:** ready-for-agent

## What to build

The agent can open a page, read it, click in it, type into it and read its console — so it
can check its own web work instead of asking you to look. You ask it to open the dev
server and tell you what the title bar says, and it does.

## Why

This is the reason the feature was asked for. 69 is a window; this is the loop closing.

## What is there now

- `eval_with_callback` from [68](68-a-child-webview-proven.md) — the whole drive channel.
- `EventChip` already renders every tool call as a compact pill in the transcript, so the
  chip that announces a hidden tab is mostly built.
- `RESERVED` in `userTools.ts` is `read, write, edit, bash, ask_user`.

## The shape of it

**One tool named `browser`, with actions** — open, read, click, type, console. Not a family
of narrower tools: `profile.tools` is a boolean per name, so several names would buy finer
trust granularity, and that granularity is worth nothing to a dev who grants tools by
profile membership and runs the gate on `auto`. It is **GET-shaped**: the model supplies a
URL and never a request body or headers.

**It is ungated**, like every other tool in a profile. Membership is the trust decision.

**Page text is untrusted data and the transcript says so.** A page can contain text
addressed to the model. What comes back from `read` is marked as data, not presented as
instruction.

**Agent-opened tabs are hidden**, positioned outside the client rect per 68's answer. A
hidden tab takes **no slot in the dock strip** — otherwise one long turn floods the dock
with pages you never asked to see. It exists as a chip in the transcript, and opening it
from the chip is what puts it in the strip.

**The chip is a TUI chip button, not a `<details>`.** `EventChip`'s comment records the
Guide's rule that expanding must not open another surface — and opening a tab is exactly
that. So the chip carries one button labelled with the host, and no chevron: a control that
opens a surface is not a disclosure, and should not dress as one. It is styled like every
other control in the restyle — no fill at rest, invert on the cursor.

**An `initialization_script` on every tab** catches Esc and returns focus to the ADE,
because the page is a separate HWND and while your cursor is in it the command centre
shortcut and the composer keybindings do not fire. The same script captures the console,
which is why it has to exist regardless.

**`RESERVED` grows to six, and that widens a written rule.** `userTools.ts` records ticket
13's rule that the built-in exception does not grow — no new *executing* tool joins pi's
four — and that `ask_user` was let past because it "runs nothing". `browser` executes. The
comment in `userTools.ts` is amended to say so rather than left contradicting the code.

## Not in scope

No screenshots: the agent acts on text, and you are looking at the page already. No request
bodies or model-supplied headers. No arbitrary hosts. No network-request listing — the
console is what this ticket captures.

## Acceptance criteria

- [x] `browser` appears in `capabilities.tools` and can be switched off in a profile.
- [x] Reading the live DOM works: `document.body.getBoundingClientRect`, `document.title`
      and a node count all came back from a hidden page in the native window. **The model
      has not been the one to ask** — see the last line.
- [ ] The agent clicks a button and types into a field. The scripts are covered against a
      fake host; no model has run them.
- [x] The console the page logged is readable — `window.__adeConsole` came back holding
      Vite's and React's lines and a probe `console.error`.
- [ ] An agent-opened tab is hidden with no slot in the strip and appears as a chip. Built;
      not observed, because no model has opened one.
- [x] The chip is a button, not a `<details>`, and shows no chevron — `EventChip`'s
      `action`.
- [x] Page text in the transcript is marked as untrusted data, and the check asserts it.
- [ ] Esc returning focus. The page-side half was driven: the navigation to `ade-ipc:esc`
      is cancelled by `on_navigation`. Nobody watched the caret come back.
- [x] A non-allowed host is refused, at open and at navigate and on a link the page
      follows, and the refusal reaches the caller.
- [x] `RESERVED` contains `browser`, and `userTools.ts`'s comment records the widening.
- [x] `npm run check` and `cargo test` pass.
- [ ] **Not driven against a real model.** Recorded in `docs/OPEN-ISSUES.md` rather than
      claimed. This is the one criterion the slice does not meet.
