# 51 — Rust tells an agent that another session wrote this file

**Blocked by:** [46](46-a-root-per-session.md), [48](48-sessions-run-in-the-background.md).
**Status:** landed

One half of what makes concurrent turns in one folder honest. The other half is
[ticket 52](52-undo-under-contention.md).

## What to build

When two live sessions share a root, the second one to write a file is told that another
agent is working on it, and decides what to do about that itself.

**Rust is the only place this can live.** It is the one side that sees every session's
writes; a renderer-side registry would only know about the sessions that particular window
built, and the write path is the boundary that has to hold anyway.

Three decisions, taken in the open:

- **Writes only, not reads.** Two agents reading the same file is normal and harmless, and
  a warning on it would be constant noise.
- **Written *this turn*, by another live session.** The question is "is someone else
  working on this right now", not "has anyone ever touched it".
- **Once per file per session.** A note on every write becomes a thing the model learns to
  skip past, and then the one that mattered is skipped too.

The note is appended to the tool result, which is the same channel `stripControl`'s
truncation note already uses. It names the other session so the agent can say something
useful about it. It does **not** block the write — the decision belongs to the agent, and
above it to the person reading the transcript.

## Acceptance criteria

- [x] Two sessions in one root: the second to write a file this turn gets a note naming the
      other session.
- [x] The same session writing the same file again gets no further note.
- [x] Writing a file nobody else has touched produces no note.
- [x] Reads produce no note.
- [x] Sessions in different roots never warn about each other.
- [x] The write itself is never refused because of this.
- [x] Rust tests cover first-write, repeat-write and different-root.
