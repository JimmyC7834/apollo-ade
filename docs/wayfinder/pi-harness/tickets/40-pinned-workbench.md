# 40 — The Pinned Workbench, and what an artifact is

**Blocked by:** [37](37-shell-tokens-and-stack.md).
**Status:** **landed, unseen.** All four features were re-homed: terminal, Changes,
Replace and the Explorer tree are artifacts, and `replace.ts`, `replace.check.ts` and
`applyReplacements` are untouched. Persistence went to version 2 and drops version-1
records rather than guessing a dock out of a panel height. The dock's geometry, the
collapsed strip and `resize: both` are all written-not-seen.

## Most of the Modal Workbench already exists

`src/editor/EditorDialog.tsx` opens with *"The editor as a transient, dismissible surface
over the workbench, so Agent Chat stays the primary experience underneath"* and dismisses
*"leaving every tab and every unsaved edit intact."* That is the
[Shell Guide](../../UIUX-UPDATE.md)'s Modal Workbench, already built, already correct on
the property that is easiest to get wrong.

Two things it lacks: **two-pane splitting**, horizontal and vertical, and native
`resize: both` with a corner indicator and min/max bounds.

## What is new: the dock

A persistent artifact dock. Landscape: right of chat. Portrait or under 760px: below chat.
Resizable from an **invisible 8px** pointer target — the left edge in landscape, the top
edge in portrait — constrained between 24% and 65%. Collapsed it becomes a 32px icon strip
on the right or a 32px tab bar at the bottom; clicking a collapsed tab or empty bar space
expands it. The collapse control anchors to the **bottom** of the right strip and the
**right** of the bottom bar, and **content-sized tabs must never push it away**.

Pinning moves a tab out of the Modal Workbench and into the dock. That is the only way in.

## The reason this slice matters more than it looks

The Shell Guide deletes the regions that four working features live in. `WorkbenchLayout`
has `primarySidebar`, `secondarySidebar` and `panel`; the Shell Guide has none of them.
Today those hold **Explorer**, **Search + replace-across-files**, **Changes**, and the
**terminal**. The Guide re-homes none of them explicitly, and a slice that deletes the
regions without building the dock deletes four features.

So the dock is the answer to *"where did my panels go"*, and this ticket owns the artifact
model that makes it possible:

- **Terminal** → artifact. Already has a specialised renderer; keep it.
- **Changes** (git) → artifact, keeping its diff behaviour.
- **Replace-across-files** → a **Replace Artifact**. [Ticket 30](30-replace-across-files.md)
  landed a plan list, per-file counts, per-file Diff buttons and an apply, and none of that
  fits a command-palette result row. `replace.ts`, `replace.check.ts` and the controller's
  `applyReplacements` survive untouched; only `SearchView.tsx` is rehoused.
  [Slice 44](44-palette-and-notifications.md) owns find; this owns replace.
- **Explorer tree** → replaced by the Context Explorer in
  [slice 42](42-composer-and-context-explorer.md), which is a different thing wearing a
  similar name. Do not delete the tree until 42 lands.
- **Diagnostics** → an artifact, per the Guide. [Ticket 32](32-diagnostics.md) still owns
  what is in it.

**File artifacts render with Monaco in both workbenches**, following the current theme,
minimap off, 12px font on 20px line height, laying out automatically when panes or the
dock resize.

## Tabs, which have a rule that keeps being repeated

32px tall. Content-sized, 80px minimum and 180px maximum. Close buttons appear only on
hover or focus, **absolutely overlaid on the label**, and showing one must not resize the
tab; labels truncate beneath the overlay. This is the same non-shifting rule as slice 38's
breadcrumb and slice 43's profile edit icon, for the third time.

## Persistence

The dock persists: size, collapsed state, and which artifacts are pinned. `persistence.ts`
already stores layout geometry and open editors, so this is a shape change rather than a
new mechanism. A dock you rebuild every launch is a dock you stop using.

## Acceptance criteria

- [ ] The dock docks right in landscape and below in portrait, resizes from an invisible
      8px target, and is constrained to 24–65%.
- [ ] Collapsed it is a 32px strip or bar; the collapse control stays anchored and cannot
      be pushed away by tabs.
- [ ] Pinning moves a tab from the Modal Workbench into the dock.
- [ ] The Modal Workbench splits two ways and resizes with `resize: both` inside sane
      bounds; dismissing it still preserves tabs, splits and unsaved edits.
- [ ] Terminal, Changes and Replace all work as artifacts, with no loss of behaviour from
      their panel versions. Replace still previews before it writes and still refuses a
      dirty file by name.
- [ ] Monaco artifacts re-layout on dock and pane resize.
- [ ] Dock size, collapsed state and pinned artifacts survive a restart.
- [ ] Tab close buttons do not resize tabs.
- [ ] `npm run check` clean — `replace.check.ts` in particular must still pass untouched.
