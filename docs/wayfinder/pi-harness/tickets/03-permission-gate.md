---
label: wayfinder:grilling
title: What stops a tool call
parent: ../map.md
blocked-by: [01-execution-env-surface.md, 02-exec-not-terminal.md]
assignee: jc4649
status: closed
---

# What stops a tool call

## Question

Carried over from the paused map and re-cut, because the answer changed shape: the gate
is no longer something we design from scratch against our own harness, it is something
we insert into *someone else's* loop.

Where the three references stand:

- **pi's core ships no gate.** No prompts, no allowlists, no sandbox.
  `pi/docs/security.md:35` argues a partial in-process sandbox *"would be easy to
  misunderstand as a security boundary"* and pushes containment to Docker/micro-VM.
  What pi *does* ship is `permission-gate.ts` — 30 lines, `pi.on("tool_call")`
  returning `{ block: true, reason }` — and it lives in the extension layer we
  [cannot import](../map.md).
- **Claude Code** makes it first-class: allow/ask/deny with deny→ask→allow precedence,
  six modes, enforced by the harness rather than the model, plus an OS sandbox layer.
- **This repo** already holds a position neither takes: Rust is the sole
  filesystem/process authority and stays root-confined, enforced in
  `src-tauri/workspace.rs`.

Settle:

- **Which layer enforces.** There is a TypeScript answer (intercept in the adapter,
  before `invoke`) and a Rust answer (refuse in the command). They are not equivalent:
  the TS gate is the only one that can *ask the user*, but it is also the one running in
  the WebView, which is the less trusted side. The likely answer is both — TS asks,
  Rust enforces — and if so, say plainly what each is responsible for, because a gate
  that looks like two layers but only really has one is worse than an honest single
  layer.
- **What hook pi's core actually offers.** The paused map recorded that pi has a
  `beforeToolCall` seam with nothing plugged into it. Confirm whether that seam exists
  in `pi-agent-core`'s browser-safe export, or whether interception has to happen in
  the `ExecutionEnv` methods themselves — which would mean the gate sees *filesystem
  operations*, not *tool calls*, and cannot distinguish "the agent chose to write this"
  from "a tool it called happened to write this."
- **What the user sees.** `src/agent.ts` already has
  `{ kind: 'approval', label, detail }` and `resolveApproval(approved)`, and the loop
  genuinely stops — the existing comment notes a run that keeps ticking behind a
  pending approval can act before the answer. Decide whether that contract is enough or
  needs to carry structured tool arguments. Overlaps
  [the event contract](05-event-contract.md).
- **Defaults.** Which operations are gated out of the box. `exec` is the obvious one
  (see [How `exec` runs a command](02-exec-not-terminal.md)); writes inside the root
  are arguably not, since the root is already the boundary.
- **Whether the gate is per-profile.** Profiles carry a tool subset already; a
  permission *policy* on the profile is the natural next field, and Claude Code's modes
  are exactly that. Do not settle this before
  [the profile data model](04-profile-data-model.md) — note it and move.

---

## Resolution

**Auto by default, with a floor auto cannot cross. TypeScript asks; Rust enforces.**

### What pi gives us, verified in the published 0.83.0 tarball

The map's earlier claim that pi's gate was unavailable was wrong, and the correction is
load-bearing:

- **`harness.on("tool_call", handler)` is in the browser-safe core.** The handler
  signature is `(event) => Promise<ToolCallResult|undefined> | ToolCallResult|undefined`
  — **async and awaited**, so the gate can block on a real user answer. `ToolCallResult`
  is `{ block?: boolean; reason?: string }`, byte-for-byte what the TUI layer's
  `permission-gate.ts` returns. What is Node-bound is only the *host* that loads user
  scripts off disk.
- **Blocking is graceful.** `agent-loop.js:419-422` turns `{block:true}` into
  `createErrorToolResult(reason || "Tool execution was blocked")` — an ordinary error
  `tool_result` the model sees and can adapt to. The turn continues.
- **Throwing is not.** A handler that throws is wrapped by `normalizeHookError` into an
  `AgentHarnessError` with code `"hook"` and **aborts the turn**. So a declined approval
  must `return { block: true }`. This is the single easiest way to get this wrong.
- **Multiple handlers: last non-undefined result wins** (`emitHook`, `lastResult`).
  There is **no deny-precedence** — unlike Claude Code's deny→ask→allow. Any precedence
  we want is ours to build, and it becomes sharp once
  [user-authored tools](13-user-authored-tools.md) can register hooks.

### Decisions

1. **Two layers, with distinct jobs, and neither is decorative.**
   - **TypeScript (the `tool_call` hook) asks.** It is the only layer that can reach the
     user, and it produces the graceful `{block, reason}` the model can recover from.
   - **Rust enforces.** Path containment and workspace-root checks are refused in Rust
     regardless of what the hook decided.

   This is not belt-and-braces for its own sake. It is **forced** by
   [user-authored tools](13-user-authored-tools.md): once code we did not write shares
   the renderer, a gate that lives only in the renderer is a gate that user code can
   reach around. Rust is the floor that policy cannot lower.

2. **Auto is the default policy.** No prompts. The handler returns `undefined` and the
   call proceeds. The mechanism is unchanged from the asking case — **auto mode is the
   policy dial set to permissive, not the absence of a gate** — which is why supporting
   it costs nothing structural.

3. **A floor auto cannot cross**, enforced even in auto mode:
   - Writes outside the workspace root — refused in Rust, unconditionally. This one *is*
     a real boundary.
   - A short deny list of the irreversible and off-workspace: `rm -rf /`-shaped
     commands, force pushes, `curl … | sh`. **This is a foot-gun guard, not a security
     boundary**, and must be documented as such — a shell can evade it trivially, and
     ticket 02 already conceded that commands are not confined. Claiming more for it
     than that would be exactly the mistake pi's `docs/security.md:35` warns about.
4. **A git checkpoint before each turn is the actual safety net.** For a coding agent,
   undo beats prevention: a prompt the user has been trained to dismiss protects nothing,
   whereas a checkpoint makes an unwanted change recoverable. pi's
   `git-checkpoint.ts` example is the prior art. **Its limits must be stated**: it does
   not recover `rm -rf` outside the repo, a force push, or anything already sent over the
   network — which is precisely why the deny list in (3) exists alongside it.
5. **The ask path ships in v1 anyway.** The default profile never triggers it, but it
   gets wired and exercised, because (a) `AgentEvent.approval` and `resolveApproval`
   already exist in `src/agent.ts` and would otherwise rot into dead code — a risk
   [browser mode](10-browser-mode-env.md) already flags — and (b)
   [user-authored tools](13-user-authored-tools.md) need something to be gated by when
   they land, and retrofitting a gate after untrusted code exists is the wrong order.
6. **Policy is a per-profile field.** Confirms what the map anticipated: an `auto` default
   profile and a `careful` profile differ only in what the handler returns. The field's
   shape belongs to [the profile data model](04-profile-data-model.md), which should now
   treat gate policy as a known member rather than a possibility.

### Not settled here

- **Approval payload shape.** The hook receives structured `{ toolCallId, toolName, input }`,
  while `AgentEvent.approval` currently carries two strings. Belongs to
  [the event contract](05-event-contract.md).
- **Approval memory** (allow-once vs allow-for-session) is moot while auto is the
  default, and becomes live when the `careful` profile is specified. Deferred rather
  than decided; noted so it is not mistaken for an oversight.

### Amendment — the gate sits below the tool layer

[How a user adds their own tool](13-user-authored-tools.md) narrowed where this gate
applies, and the narrowing is an improvement rather than a concession.

**Tool invocation is not itself a gated event.** For built-ins we wrote and for user
tools the user added to a profile, the trust decision has already been made — by us at
build time, or by the user at profile-authoring time. Prompting at invocation asks the
same question twice.

**What the gate examines is what a tool does**: the command being executed, and
destructive filesystem actions. This is why decision 3's floor was always expressed over
*commands* and *writes outside the root* rather than over tool names — that framing turns
out to be the right one, and this amendment makes it explicit rather than incidental.

Two consequences:

- **Declarative user tools must execute through the same `exec` path as the built-in bash
  tool.** That is precisely what lets them go ungated safely: containment, the deny list
  and the auto-mode floor apply to the resolved command with no special handling.
- **Profile membership does not lift the floor.** A trusted tool whose command hits the
  deny list is still stopped. Trust decides whether a tool may be *called*; it does not
  decide what a command may *do*. **Superseded — see the second amendment: the floor now
  *asks* rather than stopping.**

The mechanism is unchanged — `on("tool_call")` remains where a prompt can be raised,
since it is the point that can await a user, and it still sees the resolved command for
bash-shaped calls. What changed is the **policy** it applies.

### Second amendment — the floor asks; it does not refuse

Decision 3 and the amendment above both describe the deny list as something that
*stops* a command. That is not what shipped, and the difference is the whole
argument of [How a tool asks a question](18-tool-reaches-the-gate.md).

**A deny-listed command raises the approval card, in auto mode too.** `gate.ts`'s
`onToolCall` computes a `reason` from `destructive(command)` before it consults the
policy, and a reason forces the question whatever the policy says. `gate.confirm` is
the same door for a user tool whose resolved argv trips the list — same event, same
card, same yes/no.

**Why refusing was the worse end of the trade.** Refusing never stopped anyone deleting
the directory. It made them write `["python3", "cleanup.py"]`, where the deny list
cannot read the command and never asks at all. Strictness bought indirection and cost
the one case a foot-gun guard is any use for: the destruction written plainly enough to
show you. This does not weaken decision 3's honesty clause — a shell still evades the
list trivially, and it is still **not a security boundary**. It changes what the guard
does when it does fire.

The real boundary is unchanged and is still the only thing called one: **writes outside
the workspace root, refused in Rust, unconditionally.**

### What shipped, so the ticket can be read without the code

All six decisions are built, and two of the three "not settled" items are answered:

- The hook is `harness.on('tool_call', …)` in `provider.ts`, handled by `createGate()`.
- **Auto is the default** and the `careful` profile is the asking one; `gatePolicy` is
  the profile field decision 6 promised.
- The **git checkpoint** of decision 4 is `git_checkpoint` in `src-tauri/src/git.rs`,
  called per turn from `provider.ts` — and deliberately non-fatal, because a checkpoint
  is a safety net rather than a precondition.
- **Approval payload shape**: settled by [the event contract](05-event-contract.md) and
  widened by ticket 18 — `{ kind: 'approval', id, name, input, reason }`, where `input`
  is structured and, for a user tool, the argv **array** rather than a joined string.
  `["echo", "a b"]` and `["echo", "a", "b"]` read identically once joined, which is the
  whole reason the array exists.
- **Approval memory** stays deferred, and ticket 18 added a second caller waiting on it.
- Two failure modes the resolution warned about are now asserted in `gate.check.ts`: a
  declined approval returns `{ block: true }` rather than throwing, and a second question
  while one is outstanding is refused rather than left to strand the first promise.
