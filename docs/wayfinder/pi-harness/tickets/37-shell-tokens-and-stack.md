# 37 — The palette and the stack the shell is written in

**Blocked by:** none — can start immediately.
**Status:** **landed.** `Overlay.tsx` was kept, with the reason written into the file:
`<dialog showModal()>` is the platform giving focus containment, the top layer and the
backdrop away, and this app can assume it where a library cannot. `ContextMenu.tsx` moved
onto Radix and kept its props. `App.css` was **not** rewritten into utilities — see the
dev log. **No part of this was looked at**; the light theme has never been rendered.

## Why this one is first, and not negotiable

Slices 38–44 each rewrite a screen. If the token names and the component vocabulary change
after any of them lands, that screen gets written twice. This is the cheapest ticket in the
sequence to do first and the most expensive to do second.

## What changes, and it is a lot

The [Shell Guide](../../UIUX-UPDATE.md) names a stack this repo does not have: **Tailwind
CSS v4**, **shadcn-style local components**, **Radix UI primitives**, and
**`react-markdown`** (the last belongs to [slice 41](41-transcript-markdown.md), but it is
installed here so the dependency step happens once). `package.json` today carries React,
Monaco, xterm, codicons, pi and typebox — and nothing else.

The dev's decision was **adopt the stack and refactor onto it**, not reimplement its
behaviour on the existing hand-rolled primitives. That is a deviation from `context.md`'s
*"prefer an existing dependency to a new one"* and it is taken deliberately: the Shell
Guide is a design that was drawn in that vocabulary, and reproducing it in another one is
how a design arrives 80% right in a way nobody can point at.

## Two token systems, and only one may survive

`tokens.css` opens with *"The palette was VS Code's dark theme, value for value. It is now
a tuned…"*. The Shell Guide names a different set — `--background`, `--foreground`,
`--card`, `--popover`, `--primary`, `--secondary`, `--muted`, `--accent`, `--destructive`,
`--border`, `--input`, `--ring`, `--sidebar`, `--status-done`, `--status-waiting` — which
is shadcn's convention doing the same job under different names.

**Both may not coexist past this ticket.** A repo with `--ide-*` and `--background` both
live is a repo where the next person picks whichever they saw last. The rename is
mechanical and wide, so it is expand–contract inside this one ticket: add the new names,
move every consumer, delete the old ones, and land it green.

## Two themes, where there is one

The Shell Guide requires a **neutral warm light** theme and a **neutral charcoal dark**
theme, plus a theme control that is permanently visible in the titlebar
([slice 38](38-app-chrome.md) draws it; this ticket defines what it switches). Today there
is no light theme and no `prefers-color-scheme` anywhere in `src/`.

Also binding, and worth reading as constraints rather than taste: no gold branding, no
gradients, no atmospheric backgrounds, no glass, minimal shadows, small radii, borders only
where they clarify structure.

**Monaco and xterm both need theme definitions per theme.** They do not read CSS variables;
they take colour objects. Deriving those objects from the tokens in one place is part of
this ticket — the Shell Guide's rule is *"Monaco, terminal, diffs, statuses, menus, and
overlays must derive colors from those tokens."*

## The restyle that was reverted

The dev's uncommitted restyle of `App.css` and `tokens.css` was **stashed** at the start of
this sequence rather than discarded (`git stash list`, message `restyle-before-revert`).
This ticket starts from the committed palette. If the light/dark pair ends up wanting
something from it, it is still there.

## What to build

Tailwind v4 configured against the Shell Guide's token names; Radix installed; the shadcn
component shapes this repo will actually use, added locally as they are needed rather than
wholesale. `src/ui`'s existing primitives refactored onto them or deleted where a Radix
primitive replaces them outright — `Overlay.tsx` and `ContextMenu.tsx` are the two that
most obviously go, since focus-trapping and menu keyboard behaviour are what Radix is for
and what `context.md` names as never-trimmed.

`ActionBar`, `Badge`, `Icon`, `IconButton`, `Pane`, `Tabs`, `WorkbenchTree` and
`ResizableSeparator` are the rest. Some are thin enough to keep as-is over Tailwind
classes; `WorkbenchTree` has a check and real keyboard behaviour and should be left alone
beyond styling.

## Acceptance criteria

- [ ] Tailwind v4, Radix and `react-markdown` are dependencies; the build and
      `npx tsc --noEmit` are clean.
- [ ] The Shell Guide's token names are the only token names. No `--ide-*` remains.
- [ ] Light and dark both exist and are complete. Switching between them leaves no
      unreadable region — checked against every surface that exists today, including
      Monaco, the terminal, and the diff editor.
- [ ] Monaco and xterm derive their colours from the tokens in one place each, not from
      literals scattered at their call sites.
- [ ] No colour literal outside the theme definitions.
- [ ] `Overlay.tsx` and `ContextMenu.tsx` are either replaced by Radix or a note here says
      why they were kept.
- [ ] Every existing surface still works and still looks deliberate. This slice changes how
      the app is styled, not what it does.
- [ ] `npm run check` clean — including `WorkbenchTree.check.ts`, which is the one piece of
      UI here with a real test.
