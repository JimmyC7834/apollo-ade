---
label: wayfinder:grilling
title: What the system prompt is made of
parent: ../map.md
blocked-by: []
assignee: jc4649
status: closed
---

# What the system prompt is made of

**Was deferred, now closed.** The one part of this that was not a decision —
passing a callback instead of a string — shipped first as its own slice, because
it foreclosed everything else here and cost a line. The questions below were then
grilled against pi's own source; see Fact 5, which reframed the headline question
before it was answered.

## Question

The last unsettled dependency before [profiles](04-profile-data-model.md) can be built.
Four of the map's fog entries are blocked behind profiles; profiles carry an
`instructions` field; and nobody has said what that field *does* to the prompt that
already exists.

## Fact 1 — we are already on the wrong side of this

[Ticket 04](04-profile-data-model.md) resolved, in bold:

> **Pass a callback, never a string** — a string forecloses `instructions` switching
> permanently.

`src/agent/provider.ts:309` passes a string. `systemPrompt(shell)` is evaluated once when
the harness is constructed, so a profile's `instructions` have no way to reach the model
however the questions below are answered.

This is the same class of mistake [ticket 15](15-core-already-does-this.md) was written
about — building against an assumption that a closed ticket had already corrected —
except here the ticket being contradicted is our own rather than pi's. The walking
skeleton predates ticket 04's resolution, which explains it and does not fix it.

## Fact 2 — the callback runs once per turn, and that is the whole mechanism

There is no `setSystemPrompt`. `systemPrompt` accepts
`string | ((context) => string | Promise<string>)`, and `createTurnState()` awaits the
callback **once per turn** (`agent-harness.js:291`). A callback reading current profile
state therefore gives a per-turn system prompt with no setter and no new session.

`before_agent_start` can override it as a second lever, and whether that is used at all
is one of the questions.

## Settle

- **Does `instructions` append to the base prompt, or replace it?** pi's `preset.ts`
  chose one; we have not. Replacing lets a profile build a genuinely different agent and
  lets a user delete the shell guidance that keeps the model from writing POSIX at a
  PowerShell. Appending keeps the floor and makes profiles weaker than they look.

- **What composes in, and in what order.** Base guidance, detected shell, skills via
  `formatSkillsForSystemPrompt`, workspace facts, profile instructions. Order is not
  cosmetic — later text is generally weighted more heavily by models, and a floor placed
  first is a floor a profile can talk over.

- **What happens when it changes mid-conversation.** [Ticket 14](14-switch-aftermath.md)
  decided a profile switch renders as a visible transcript divider, on the reasoning that
  the agent's instructions changing underneath a continuous-looking conversation is a UX
  problem rather than a data one. A per-turn callback makes that real: the prompt can now
  differ between two adjacent turns with nothing in the transcript saying so.

- **Whether `before_agent_start` is used at all**, or left unwired like
  `session_before_compact` was in [ticket 16](16-compaction.md). Adopting a hook to use
  none of its capabilities is surface area for nothing.

- **Whether the assembly is pure enough to check.** Everything above is string
  composition over a small record, which is the shape that takes a `.check.ts` well —
  and `context.md` requires one for branch logic. Worth deciding before writing it, not
  after.

## Out of scope

- The profile data model itself. [Ticket 04](04-profile-data-model.md) settled eight
  fields and is closed; this ticket is about one of them.
- Skills *loading*, which [ticket 15](15-core-already-does-this.md) deferred until
  profiles exist. Their composition into the prompt is in scope here; where they come
  from is not.

---

## Fact 5 — pi answered this, three times, at three layers

Grilled against pi's own source rather than recall. The answer is not
append-or-replace; it is *which actor gets which lever*.

**Layer 1 — the builder.** `packages/coding-agent/src/core/system-prompt.ts`
exposes a pure `buildSystemPrompt(options)`. `customPrompt` **replaces** the base
guidance; `appendSystemPrompt` and `promptGuidelines` **add** to it. Then, in both
the replace and the default path alike, it appends project context, then skills,
then `Current working directory:` **last**. Replacement replaces the prose the app
*authored*; it never removes the facts the app *computed*. Rebuilt whenever its
inputs change (`agent-session.ts:939`, `:2275`).

**Layer 2 — the hook chain.** `core/extensions/runner.ts:1080` walks every
extension's `before_agent_start` handler, passing each the *running*
`currentSystemPrompt` and letting it return a new one; `ctx.getSystemPrompt()`
reads it back. This lands after everything, cwd included. **pi's core does not do
this** — `AgentHarness.emitHook` (`agent-harness.js:181`) hands every handler the
same string and keeps only the last non-undefined result. The chaining is
coding-agent's own code, written at the application layer, which is our layer.

**Layer 3 — lifetime.** The hook's string becomes `_systemPromptOverride`, used as
`override ?? base` and then cleared (`agent-session.ts:1069`, `:1251`). Per-turn,
discarded after. Core matches: `createContext(turnState, beforeResult?.systemPrompt)`
leaves `turnState.systemPrompt` at its pre-hook value.

So `preset.ts` — the closest analogue to our profiles — appends *after the facts*
only because an extension cannot reach layer 1. Its field is documented
"Instructions to append to system prompt" and implemented as exactly that. A
profile of ours is layer 1, not layer 2, and `appendSystemPrompt` is the slot it
belongs in: inside the builder, **before** skills and cwd.

## Fact 6 — three things this cannot break, verified

- **The summariser never sees it.** `compaction.js:418` and `:571` pass a fixed
  `SUMMARIZATION_SYSTEM_PROMPT`. A profile's instructions cannot change how
  history is summarised.
- **The prompt is persisted nowhere.** `AgentState.systemPrompt` is live state,
  `AgentContext.systemPrompt` is per-request, and no session entry carries it.
- **The callback can see the tools.** Its context is
  `{ session, model, thinkingLevel, activeTools, resources }` — no `toolContext`,
  but `activeTools` is there, so a prompt can describe the tools a profile
  actually left active, which is what pi's own builder does with `selectedTools`.

---

## Resolution

**1. `instructions` appends. Only appends.** No `customPrompt` equivalent, so no
profile can delete the PowerShell warning or the read-before-edit rule. This
follows `preset.ts`, the direct analogue, over the CLI's `--system-prompt`, which
is an operator lever rather than a profile field. [Ticket 04](04-profile-data-model.md)
stays at eight fields.

**2. The order is base guidance → instructions → skills → shell and workspace
facts, facts last.** This inverts the worry the ticket was written with. "A floor
placed first is a floor a profile can talk over" assumed protection comes from
going first; pi protects the floor by putting it **last**, where models weight
most. The shell sentence is split out of today's welded base string to get there.

**3. `before_agent_start` is wired — as the extension point, not as the profile's
route in.** The profile composes through layer 1. The hook carries our own
chaining runner, mirroring `runner.ts`, because core's `emitHook` does not chain:
a second handler returning a `systemPrompt` would silently discard the first.
One registered handler, an ordered list of contributors behind it, each seeing
the running string.

This was settled against the recommendation to leave it unwired. The reason it is
right anyway: the profile field and the extension surface are different features,
and the callback alone serves only the first.

**4. Nothing beyond [ticket 14](14-switch-aftermath.md)'s divider.** A switch is
visible; there is no profile editor in v1, so there is no other way for the prompt
to change mid-conversation. Recording a prompt hash per turn is machinery for an
event that cannot yet happen.

**5. A per-profile *prompt-change mode* — append vs replace as a setting rather
than a constant — is deferred to the map as fog.** Decision 1 is the default, not
a ceiling. Noted so that choosing append now does not read later as never having
considered replace.

**6. Skills get their slot and position now**, between instructions and the facts,
via pi's `formatSkillsForSystemPrompt` — exported by the core and called by
neither pi package, the same shape as `shouldCompact` and `isContextOverflow`.
`resources.skills` stays empty until [ticket 15](15-core-already-does-this.md)'s
deferred loading lands. Settling the position now is the point: an order with a
hole in it is the situation this ticket was written about.

**7. `VITE_AGENT_INSTRUCTIONS` supplies it until profiles exist**, joining
`VITE_AGENT_PROVIDER`, `_MODEL`, `_GATE` and `_AUTOCOMPACT`. It makes the path
testable live rather than only in a check, and collapses into the profile field
with the others.

### Consequences, not choices

- The composer is pure string work over a small record, so it takes a
  `.check.ts` — `context.md` requires one where there is branch logic, and
  segment omission is branch logic.
- The hook's result is per-turn; `turnState.systemPrompt` keeps the pre-hook
  value. Nothing else reads it, so the divergence is harmless.
- A throw inside a hook aborts the turn (`normalizeHookError`). One handler, no
  throwing.

### What this slice does *not* protect

- **A profile cannot remove the floor.** That is decision 1 working as intended,
  and it means a profile is genuinely weaker than pi's `customPrompt`.
- **No transcript can say what a turn was told.** Accepted in decision 4, and it
  becomes real the moment the prompt can differ between adjacent turns.
