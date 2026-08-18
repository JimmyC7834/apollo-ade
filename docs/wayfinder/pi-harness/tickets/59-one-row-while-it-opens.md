# 59 — One row while it opens

**Blocked by:** [58](58-abandoned-is-not-a-conversation.md).
**Status:** **landed**

## What to build

Clicking a conversation opens it as one row, keeping its own name, with nothing appearing
beside it.

## What was happening

Two defects with one shape: **a session was published before the facts the navigator draws
it from had arrived.**

`build` in `sessionSet.ts` added the session to the collection and focused it — both of
which publish — and only then awaited `provider.path()`. So for the length of one file read
the window held a session with no path. The navigator tells an open conversation from a
stored row *by that path*, so it could not match them and drew both: the row you clicked,
and a second one under it.

That second row had no name either, because a session has no name until its history has
replayed, which is another file read. With nothing to show it fell back to `New session` —
the label for a conversation nobody has said anything in. So clicking a conversation made a
`New session` appear, and made the thing you clicked look like it had been duplicated.

The comment above the await already said the path was *"awaited, not left to land later"*,
and gave the right reason: the navigator's match and `bootstrap`'s refusal are decisions,
and a decision cannot be made against a field that has not arrived. Awaiting it after
publishing bought none of what the intent was for.

## The two fixes

**The path is resolved before the session joins the collection.** Nothing can observe a
session without its file.

**A live row with no name of its own borrows the name of the stored row it hides.** History
is deliberately *not* awaited — holding a clicked conversation off screen for a file read
would trade a flicker for a stall — so the gap is filled from the row it was opened from
instead. `New session` survives for the case it was written for: a conversation that is
genuinely new has no stored row to borrow from.

## Acceptance criteria

- [x] Clicking a stored conversation never shows two rows for it, at any point.
- [x] The row keeps its own name throughout; it does not become `New session` and back.
- [x] A genuinely new session is still called `New session`.
- [x] Driven in the **native** window.

## Verified

A `MutationObserver` over the navigator recorded every DOM change through a click on a
stored conversation in `workspace-b`, for six seconds. Across all of them there was exactly
**one distinct row list** — the same eleven rows before, during and after — so no row was
ever added and no name ever changed. Afterwards the clicked row was live (`aria-current`,
no archive or delete), still named `Read ONLY-IN-B.md …`, with its transcript replayed.

The two rows that do read `New session` are live sessions with nothing said in them, which
is what that label is for.
