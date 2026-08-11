# 39 — The Session Navigator, and one real workspace switch

**Blocked by:** [37](37-shell-tokens-and-stack.md).
**Status:** **landed, unseen.** Switching is real and goes through a Rust-owned recent
list **by index, never by path** — see `docs/adr/0001-multi-root-confinement.md`, which is
written and unimplemented as required. A switch is refused while anything is dirty or a
turn is running. `sessions.check.ts` asserts exactly one session is `live`. The geometry is
written-not-seen.

## The largest thing in the Shell Guide, and the least real

The [Shell Guide](../../UIUX-UPDATE.md) specifies a navigator with per-session status
markers — *Running: flashing. Done: blue. Idle: gray. Waiting for input: yellow* — plus
unread notification state distinct from lifecycle, plus **workspace groups** with
collapsible headers and their own status dots.

Statuses that flash and notifications that accumulate only mean anything if sessions run
**while you are looking at a different one**. This repo has exactly one session, one
harness, one gate, and one confinement root.

## Decided: the UI is real, the concurrency is a fixture

The dev chose to build the mock-up ahead of the functionality, and chose it knowingly. Two
rules make that safe rather than corrosive:

- **The mock lands on `master` behind a visible prototype affordance.** Not on a long-lived
  branch — those diverge from every other ticket and die. Not indistinguishable from real
  either: a navigator showing three sessions when one exists, with nothing on screen
  saying so, is how a fixture gets mistaken for a feature. The Shell Guide's own caveats
  list had to warn about this four separate times, and those warnings do not survive being
  copied into a shell that looks finished.
- **One confinement root stays real.** `src-tauri/src/workspace.rs` holds one canonical
  root and confines by `starts_with`. Rendering N workspace groups from fixtures does not
  touch that. The moment a second group runs a real turn it does, and that is a different
  change with a different risk — see below.

## What is genuinely real in this slice

**Workspace switching**, absorbed from ticket 31. `set_workspace` already exists and
already does the Rust half; one root is still the boundary, it is merely a different root
than it was a minute ago. The navigator needs a recent-workspaces list to group by, so this
is where it lands.

**Session status within one session.** Running vs waiting-for-input vs idle vs done is a
real distinction the running harness already makes — the gate blocks on a prompt, and that
is *waiting for input*. Those four states earn their place even with one session.

## What must not be smuggled in

**Concurrent live sessions.** N harnesses against one git tree makes the per-turn
`git_checkpoint` meaningless — two turns interleaving produce a checkpoint neither one can
be rolled back to. That is its own ticket and its own grilling.

**Multi-root.** Two live workspaces means two confinement roots, and `workspace.rs` holds
one. **Write the ADR before it is needed, not during** — the invariant changes shape, and
that is exactly the kind of decision `context.md` wants recorded rather than discovered.

## The shape, which is exact and fussy

- Collapsed: **32px** wide including a 1px right border, icon column 31px, flush to the
  top, no background, status icons floating over the Chat Workbench.
- Expanded: **264px**, over chat — it does not reflow it — with a solid surface and shadow
  restored for label readability.
- Every header and row is exactly 32px high. No rounding on active or hover highlights, no
  dividers, no group margins.
- Row structure: `[31px centered status icon][label][24px action]`.
- Workspace header is one line: `workspace · branch`.
- The active session does **not** get a row background.
- Markers are rounded squares. 12px default, 18px for the active session.
- Workspace status dots appear **only** when the group is collapsed.

## Acceptance criteria

- [ ] Collapsed and expanded states match the measurements above. Expanding does not reflow
      chat.
- [ ] Switching workspaces works for real, without a restart, and the recent list persists.
- [ ] The four session statuses render, and the live session's status is derived from the
      running harness rather than from a fixture.
- [ ] Additional sessions and additional workspace groups are fixtures, and **the UI says
      so** — visibly, not in a comment.
- [ ] Clicking a session switches the visible transcript. For fixture sessions this shows
      fixture content and does not start a harness.
- [ ] The navigator belongs to the Chat Workbench and spans only its height.
- [ ] Keyboard reachable, rows announced, and recorded as structural in `OPEN-ISSUES.md`
      like every other accessibility claim here.
- [ ] An ADR exists for multi-root confinement, written and unimplemented.
- [ ] `npm run check` and `npx tsc --noEmit` clean.
