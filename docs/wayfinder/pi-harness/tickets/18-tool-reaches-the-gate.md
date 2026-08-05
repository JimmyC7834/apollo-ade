---
label: wayfinder:grilling
title: How a tool asks a question
parent: ../map.md
blocked-by: []
assignee: jc4649
status: open
---

# How a tool asks a question

## Question

Fell out of building [How a user adds their own tool](13-user-authored-tools.md)
rather than out of the map. It is the only thing that ticket left unbuilt, and
it is a decision rather than an omission.

**The state today.** The deny list from
[What stops a tool call](03-permission-gate.md) is checked against a user tool's
resolved argv, because decision 4 of ticket 13 says the gate operates on the
command and trust granted by profile membership does not lift the floor. When it
matches, the tool **refuses** — it throws, and the model gets an error saying to
use `bash` if it means it.

`bash` in the same situation **asks**. The difference is not a policy choice; it
is a structural one. `createGate` is built per turn in `provider.ts` and reaches
the model through the `tool_call` hook, which owns a promise it can leave
pending until the user answers. A tool's `execute()` has no handle on any of
that: it receives `(toolCallId, params, signal, onUpdate, context)` and no way
to emit an `approval` event or await an answer.

**What is actually wrong with it.** A user tool that legitimately clears a build
directory — `["rm", "-rf", "{dir}"]`, which is a completely ordinary thing to
want — can never run. Not "runs after a prompt": never. The user wrote the
manifest, put the tool in a profile, and the tool is still permanently dead. The
workaround is to write it as a `bash` invocation instead, which is worse in
every way the argv decision was made to avoid.

So the refusal is safe and honest, and it is also the one place where being
strict produces a feature that does not work.

Settle:

- **Whether a tool should be able to ask at all**, or whether the answer is that
  the deny list is the wrong check for a tool. A third position exists and
  should be argued rather than assumed away: the manifest was hand-authored and
  its argv[0] is fixed, so a user tool is arguably *already* a considered
  decision in a way an ad-hoc `bash` command is not — which would make the deny
  list's job here checking the *parameters*, not the whole command. Note that
  this is the argument decision 3 already made once for tool identity, and
  extending it to the command is exactly what "trust does not lift the floor"
  refused. Reopening it needs a reason, not a preference.
- **How a tool reaches the gate, if it should.** The mechanisms differ in what
  they cost:
  - **Through `toolContext`** — `AgentHarnessTool` already receives a context
    object, and `provider.ts` already builds `{ env }`. Adding the live gate to
    it is small, and it is the only option that needs nothing from pi. The
    question is what the context holds between turns, since the gate is
    per-turn and the context is resolved per turn snapshot
    (`resolveToolContext`) — which may make this free or may make it subtle.
  - **A second `tool_call` hook** that inspects the *resolved* argv rather than
    the raw params. This keeps the asking in one place, which is the property
    ticket 03 cared about. It needs the resolution to happen before the hook
    sees it, or the hook to be able to resolve it itself — the tool currently
    resolves inside `execute`.
  - **Rust asks.** The floor already lives there and it is the only side that
    cannot be reached around. It is also the largest change and puts UI in the
    place with no UI.
- **What the approval says.** A `bash` prompt shows a command string. An argv
  array is not one, and joining it for display re-introduces the ambiguity the
  array exists to remove — `["echo", "a b"]` and `["echo", "a", "b"]` render
  identically. Decide what the user is shown, given that what they are agreeing
  to is the array.
- **Whether this is per-tool or per-call.** A manifest could carry
  `"confirm": true` and opt into asking for everything it does, which is a
  different feature from the deny list firing. If both exist, say which wins.
- **What happens under `auto`.** The deny list already fires in auto mode for
  `bash`, deliberately — auto is the permissive end of a dial, not the absence
  of one. Whatever is decided here has to hold in both policies or explain why
  not.

Out of scope: changing what is *on* the deny list. That list is short on
purpose, every entry is irreversible, and
[What stops a tool call](03-permission-gate.md) already argued that a list long
enough to fire often is a list people click through. This ticket is about what
happens when it fires, not about when.

Related: [Approval memory](03-permission-gate.md) — allow-once versus
for-session versus persistent — is still deferred there, and a tool that can ask
is a second caller for whatever that becomes. Worth settling the two together if
they land in the same slice.
