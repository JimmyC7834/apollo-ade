# 27 — `@` a file into the prompt

**Blocked by:** none — can start immediately.
**Status:** **landed.** See [Landed](#landed).

## Both halves are built and have never met

`src/commands/fuzzy.ts` is the fuzzy filter the command palette already uses over the
workspace tree. `src/agent/completion.ts` is the inline completion the slash commands
already use in the prompt box. Neither knows the other exists. This ticket is the join.

Today the model discovers files by calling `read` on a guess, which costs a tool call and
a round trip to learn something the person typing already knew.

## The decision this ticket exists to make

**What does `@src/agent/env.ts` become in the message pi actually sends?**

- *A path.* Cheap, honest, and the model still spends a `read` call — but a targeted one.
  The transcript stays small and the model decides whether it needs the contents.
- *The contents, inlined.* No tool call, and the model cannot fail to look. But a 40 KB
  file silently becomes 40 KB of context the person did not visibly ask for, and this repo
  has [a whole seam](11-rtk-in-profile.md) devoted to not spending bytes invisibly.

**Do not split the difference with a size threshold chosen by feel.** If inlining wins,
it needs the same treatment `crop.ts` got: a cap, an announcement in the transcript when
it fires, and a number measured on this repo rather than guessed.

A defensible third answer is *path now, inline later* — it is reversible, and the
completion UI is identical either way.

## Decided: a path

`@src/agent/env.ts` reaches the model as those characters and nothing else.
Nothing resolves it, nothing reads it, and the model still spends a `read` call —
but against a path a person chose rather than one it guessed.

Three reasons, in the order they mattered:

- **It is the reversible one.** The completion UI is identical either way, so
  inlining later costs the expansion and nothing else. Path-first is the
  decision that can be unmade.
- **Inlining is a byte-spending feature and this repo has a rule about those.**
  `crop.ts` exists because bytes that go into the model unannounced are bytes
  nobody can account for afterwards. Inlining without a cap, a transcript note
  and a number measured here would be the same mistake with better manners.
- **A dead path stays a normal tool error.** Ticket 18's rule is free here,
  because nothing in the completion path can fail — the failure happens where
  `read` fails, which is where the model can correct it.

What the mention actually costs, then, is one round trip. That is the price of
the decision, and it is the thing to measure before revisiting it.

## What to build

Typing `@` in the prompt box opens file completion over the workspace, filtered as you
type, and accepting an entry inserts a reference the agent resolves.

## Landed

Twenty lines in `completion.ts` and one new prop. `MENTION` finds the `@`-token
at the end of the composer, `fuzzyFilter` scores the workspace's files against
it, and the entry replaces the token rather than the line — which is what lets
this menu open mid-sentence where the slash menu cannot.

Two limits worth stating rather than discovering:

- **It completes at the end of the text, not at the caret.** The composer tracks
  no caret position and never has; the slash menu has always made the same
  assumption. Editing into the middle of a line will not open the menu.
- **Twenty entries, capped.** A bare `@` matches every file in the workspace, and
  a real repository has thousands. Same admission `search`'s `MAX_RESULTS` makes.

## Acceptance criteria

- [x] `@` opens completion; it filters through the same `fuzzy.ts` the palette
      uses rather than a second matcher.
- [x] Escape dismisses without inserting; the prompt box keeps working normally
      when the completion is closed. Both are the existing menu's behaviour,
      unchanged — this menu is the same menu.
- [x] The chosen expansion is documented above with its reason. Nothing is
      inlined, so nothing is capped and the transcript has nothing to announce.
- [x] A reference to a path that no longer exists fails as a normal tool error —
      free, because nothing here resolves the path at all.
- [x] Browser mode works against the fixture workspace. Verified: `read @ma`
      offered `read @src/main.ts`, and the run read the fixture file.
- [x] `completion.check.ts` covers the new source.
