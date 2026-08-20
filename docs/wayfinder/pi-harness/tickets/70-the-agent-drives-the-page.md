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

Driven end to end against **`gemini-3.6-flash`**, in the native window, on a purpose-built
`file:` page with a heading, a button, a field and a `console.error`.

- [x] `browser` appears in `capabilities.tools` and can be switched off in a profile. The
      profile editor showed "Tools 7 of 7".
- [x] The agent opened the page and read it, and reported something only obtainable from
      the live DOM: asked for the `h1`, it called
      `{"action":"read","selector":"h1","tab":"browser:1"}` and answered
      **"Nothing has happened yet"** — the heading's text.
- [x] The agent clicked `#go` and typed into `#name`, and the page responded: the heading
      became **"The button was pressed"** and the echo line became **"echo: Ada"**. The echo
      only updates from the page's own `input` listener, so the synthetic events reached
      the framework rather than only the DOM.
- [x] The agent read the console error the page logged —
      **"error: probe page: a deliberate console error, code 4711"**.
- [x] An agent-opened tab is hidden and has **no slot in the dock strip**: after two turns
      and seven tool calls the strip still held only Problems, References and Terminal, and
      the transcript held two chips.
- [x] The chip's button opens the tab into the strip. Clicked: the strip gained a `file`
      tab with the page's URL on its address row. It is a `<p class="ide-chip">` with a
      `<button class="ide-chip-action">`, not a `<details>`, and carries no chevron.
- [x] Page text in the transcript is marked as untrusted data — the transcript shows the
      wrapper around the heading, verbatim.
- [ ] Esc returning focus. The page-side half was driven: the navigation to `ade-ipc:esc`
      is cancelled by `on_navigation`. Nobody watched the caret come back. **This is the
      one criterion still open.**
- [x] A non-allowed host is refused, at open and at navigate and on a link the page
      follows. Tool errors reach the model and it recovers from them: it sent
      `action: "text"`, was told `text is not an action; use open, read, click, type or
      console`, and corrected itself.
- [x] `RESERVED` contains `browser`, and `userTools.ts`'s comment records the widening.
- [x] `npm run check` and `cargo test` pass.
- [x] **Driven in the native window against a real model.**

**Found by that run and fixed:** `action` was a free string, so the model reached for
`"text"` — the name of the parameter beside it. It is now a union of the five literals, so
the choice is constrained rather than hoped for.
