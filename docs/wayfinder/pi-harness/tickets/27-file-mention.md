# 27 — `@` a file into the prompt

**Blocked by:** none — can start immediately.
**Status:** ready-for-agent.

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

## What to build

Typing `@` in the prompt box opens file completion over the workspace, filtered as you
type, and accepting an entry inserts a reference the agent resolves.

## Acceptance criteria

- [ ] `@` opens completion; it filters through the same `fuzzy.ts` the palette uses rather
      than a second matcher.
- [ ] Escape dismisses without inserting; the prompt box keeps working normally when the
      completion is closed.
- [ ] The chosen expansion is documented in this ticket with its reason, and if contents
      are inlined the transcript says so and the size is capped.
- [ ] A reference to a path that no longer exists fails as a normal tool error the model
      can correct, not as a thrown turn — [ticket 18](18-tool-reaches-the-gate.md)'s rule.
- [ ] Browser mode works against the fixture workspace.
- [ ] `completion.check.ts` covers the new source.
