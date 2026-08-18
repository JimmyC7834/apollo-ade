# 64 — Icons are text

**Blocked by:** [63](63-one-grid.md).
**Status:** ready-for-agent

## What to build

Every icon in the app is a character, drawn in the same face and on the same grid as the
label beside it. A picture survives only where a character would be a lie.

## Why it is one file

Every icon in this app already goes through `Icon` or `IconButton` — one component, no
bare `codicon-` class anywhere in the tree. So this is a name-to-glyph map and a deleted
stylesheet import, not a sweep.

**Count the names before writing the map, and count them from three places, not one.**
There are the literal `name=` and `icon=` props, but also the ones chosen at runtime
(`side === 'right' ? 'chevron-left' : 'chevron-up'`, the window controls' maximise/restore
pair) and the ones that live in data rather than JSX — `TOOL_ARTIFACTS` in `artifacts.ts`,
and the row models in the Changes, Search, Problems and References views. Roughly thirty-six
names, and the JSX greps alone find half of them.

That is also why it is worth doing rather than approximating. A codicon is a webfont
rendered at 16px into a 13px line — it never sits on the grid, and beside mono text it is
the one thing that still says "web app".

## The glyphs

ASCII wherever ASCII is obvious, and three Unicode characters where it is not — `✓` for a
check, `⏎` for send, `■` for a filled marker. That line was drawn by looking at the
alternatives: `[x]` for a tick and `->` for send are cryptic in a way `+` and `x` are not.

The map is the contract, so it lives in one place with the component that reads it, and a
name with no entry is a build error rather than a blank space.

## What stays a picture

The context ring in `ComposerBar.tsx`. It is an SVG already, it is a *proportion* rather
than a symbol, and a proportion is the one thing a character cannot say. It shrinks to
13px so it sits on the line, and nothing else about it changes.

## Accessibility does not change

`Icon` is `aria-hidden` today because the control around it carries the name, and that is
still right — a `+` is no more readable to a screen reader than a codicon was. Every
`IconButton` keeps its required `label`. **No control may lose its accessible name to
become a glyph.**

## Not in scope

No icon is added, removed or moved. The `@vscode/codicons` dependency comes out of the
import in `Icon.tsx`; whether it leaves `package.json` depends on Monaco, which ships its
own.

## Acceptance criteria

- [ ] `Icon` renders a character from a single name-to-glyph map; no codicon class is
      emitted anywhere.
- [ ] Every name in use has a glyph — including the runtime-chosen ones and the ones from
      `artifacts.ts` and the view row models — and an unknown name fails loudly rather than
      silently rendering nothing.
- [ ] The codicon stylesheet is no longer imported by the app.
- [ ] The context ring still draws, at 13px, on the baseline.
- [ ] Every icon-only control still has its accessible name.
- [ ] `npm run check` passes.
- [ ] Driven in the **native** window: the navigator's markers, the composer bar, the dock
      tabs, the command centre and the profile editor all read.
