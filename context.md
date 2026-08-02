# Context

Working rules for this repo. Read before starting work.

## Less is more

The governing philosophy, and it outranks the guide when the two pull apart.
**Every wanted and needed feature ships — and nothing else does.** This is not a
licence to cut scope: a missing feature the user asked for is a failure, not a
simplification.

What it rules out is everything around the feature. No abstraction with one
implementation. No configuration for a constant. No scaffolding built for a
future that has not arrived. No second way to do something that already works.
When two designs deliver the same behaviour, the smaller one is correct — and
"smaller" means fewer moving parts and fewer concepts to hold, not terser code.

Prefer deleting to adding. Prefer an existing dependency to a new one, a
platform feature to a dependency, and nothing at all to any of them. When a
shortcut is taken deliberately, mark it and name what would justify replacing
it, so the next reader knows it was a decision rather than an oversight.

The exceptions are fixed and small: input validation at trust boundaries, error
handling that prevents data loss, the security boundary, and accessibility. These
are never the thing that gets trimmed.

## The guide is the spec

`docs/# Building a VS Code-Like Agent IDE with Vertical Slices.md` is the
authoritative architecture record and roadmap. Follow it — slice order, adapter
seams, security policy, accessibility contracts, UI-extraction rules. If you
deviate, say so explicitly and record it in the dev log rather than quietly
diverging.

## Dev log rule

**Every completed slice gets a summary appended to `docs/DEVLOG.md`.** Append
only — never rewrite or reorder existing entries. One entry per slice, added
when the slice is finished, using the template already in that file:

- User outcome (one sentence, not a file list)
- Added
- UI extracted / reused
- Adapters and dependencies
- Security boundary
- Accessibility behavior
- Validation performed (and what was *not* validated)
- Caveats and deviations from the guide

The log is how the next agent learns what actually happened, including what
was skipped. Record honest gaps — an unrun test is a caveat, not an omission.

## Open issues

`docs/OPEN-ISSUES.md` is the living counterpart to the dev log: current open
defects, what has never been verified, and how to inspect the **native** window
over the WebView2 debugging port. **Read it before picking up a slice**, and
edit it — close items by deleting them and recording the fix in the dev log.

It exists because the dev log is append-only, so by the time it is long enough
to be useful it is too long to answer "what is broken right now?".

## Working rules

- Feature code consumes domain interfaces; it never calls Tauri directly.
- Every native capability gets a deterministic browser implementation so the
  UI runs under `npm run dev` with no native process.
- Extract a UI primitive only after two real consumers show the same behavior.
- Accessibility is part of the slice, not follow-up work.
- Rust is the only filesystem/process authority; it stays root-confined.

## Validation

```bash
npm run build
npm run check
cargo test --manifest-path src-tauri/Cargo.toml
```

Dev server runs on port 5190 (5180 belongs to the sibling `agent-window-tauri`).

The browser pane is **not** equivalent to the native window — it serves no
animation frames, so Monaco never lays out and timing behaves differently.
Anything about focus, layout inside Monaco, or animation has to be checked
natively; `docs/OPEN-ISSUES.md` explains how.
