# 60 — One harness per file

**Blocked by:** [59](59-one-row-while-it-opens.md).
**Status:** **landed**

## What to build

Opening a conversation never puts a second live session on a file that already has one.

## Why the *last* row was the one that did it

`openSession` tries every stored conversation in turn and falls back to another one when the
one asked for cannot be replayed — a JSONL whose parent chain has a hole in it, which this
repo has and which the **oldest** files are the likeliest to be. The last row in a workspace
is the oldest, so it is the reliable way to reach the fallback.

Falling back is right, and it is announced: *"That conversation could not be reopened. Opened
the most recent one instead."* What was wrong is what happened next. The conversation it fell
back to was usually the newest one — which is usually **already open**. So the window ended
up holding two live sessions on one file: two identical rows in the navigator, and two
harnesses appending to the same JSONL. The second half is the one that is not cosmetic.

**`bootstrap` already knew this could happen** and said so, in a comment naming exactly this
case: *"a damaged file whose candidate fallback lands on a conversation an earlier iteration
already opened."* It handled it by opening, noticing, and closing the duplicate a step later
— which left two writers coexisting for the length of a close, and did nothing at all for a
**click**, which is the other way in.

## The fix

`build` refuses before the session joins the collection: if a live session already holds that
file, the new provider is disposed and the existing session is focused instead.

It belongs there because that is the only place that knows both facts at once — which file
this turned out to be, and what is already open. It is only possible at all because
[59](59-one-row-while-it-opens.md) moved the path resolution above the lines that publish.

`bootstrap`'s own after-the-fact cleanup is gone with it; its remaining pre-check is now only
an optimisation that saves opening a provider.

## Acceptance criteria

- [x] Clicking a conversation that cannot be reopened does not add a second row for the one
      it falls back to.
- [x] Two harnesses never append to one JSONL by this route.
- [x] The fallback is still announced rather than silent.
- [x] Reopening at launch still puts back the set that was open.
- [x] Driven in the **native** window.

## Verified

In the native window, clicking the last row of this repo's workspace — its oldest stored
conversation, from 2026-08-05 — announced *"That conversation could not be reopened. Opened
the most recent one instead."*, which is the fallback firing for real rather than a
simulation of it.

The group held four rows before and four after, with exactly one marked current and the
clicked row still listed as stored. Before this, that click added a fifth row: a second live
session on the file the fallback landed on, which was already open.

**Not covered by a check.** The guard lives in `sessionSet`, whose only route in is an async
provider factory that talks to Rust, and there is no seam that would let a check reach it
without inventing one. The pure part of this batch — which row a set of sessions produces —
is checked in `sessions.check.ts`; this is the stateful part, and it was driven instead.
