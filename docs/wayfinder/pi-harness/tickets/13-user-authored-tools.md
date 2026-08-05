---
label: wayfinder:grilling
title: How a user adds their own tool
parent: ../map.md
blocked-by: [03-permission-gate.md, 06-credentials-and-http.md]
assignee: jc4649
status: closed
---

# How a user adds their own tool

## Question

Graduated from the map's fog when the dev named it as a requirement: users should be
able to add their own tools, *"like the native pi agent"*. It is the hardest thing on
this map, and the paused map independently called the same problem its largest unknown.

**What pi does, and why we cannot copy it.** pi's extension host loads TypeScript files
off disk — `jiti` plus `node:module` — and runs them in-process with full Node
authority. `pi.on("tool_call", ...)`, `ctx.ui.select(...)`, the lot. Two of those three
ingredients are unavailable in a WebView, and the third is the one we would not want
even if we could have it.

**What we do have**, established by
[What the Tauri ExecutionEnv actually implements](01-execution-env-surface.md): the
substrate is all there in the browser-safe core.

- `tools?: TTool[]` is a plain array, and `ToolsUpdateEvent` / `activeToolNames` /
  `setResources()` make it mutable at runtime, so tools can be added and removed while a
  session is live.
- `AgentHarnessTool<TContext, TParameters, TDetails>` is a public type: a TypeBox schema
  plus an `execute()`. Nothing about it requires the definition to be written by us.
- The 22-event hook system, with `tool_call -> { block?, reason? }`, is the enforcement
  point.

So the missing piece is not the harness. It is: **where does a user's code run, and with
what authority?**

Settle:

- **What a user-authored tool actually is.** The options are genuinely different
  products, and this is the question the rest depend on:
  - **Declarative** — a manifest (JSON/YAML) naming a schema and a shell command to run.
    No user code executes in our process at all; it goes through `exec` and the existing
    permission gate. Covers a surprising share of real tools, and is the only option
    with no new trust boundary. Claude Code's hooks are close to this shape.
  - **Sandboxed script** — user JS in a Worker or an iframe with no ambient authority,
    talking to the host over `postMessage`, with every capability explicitly granted.
    Real extensibility; a real amount of work.
  - **Unsandboxed script in the renderer** — `import()` from a blob, or `new Function`.
    Closest to pi, and the trap: user code would share the renderer with the API key
    (see [Who holds the API key](06-credentials-and-http.md)), the workspace adapter,
    and the permission gate it is supposed to be subject to. A gate that user code can
    reach around is not a gate.
  - **Out-of-process** — the tool is a subprocess speaking a small protocol. Strongest
    isolation, and the shape of every plugin system that survived. Costs a protocol and
    a process lifecycle.
- **Where the trust boundary is, and whether the gate stays meaningful.** This is why
  the ticket blocks on [What stops a tool call](03-permission-gate.md): whatever is
  decided there has to survive the introduction of code we did not write. If the answer
  to the gate is "TypeScript asks, Rust enforces", user tools are fine; if any of the
  enforcement lives in the renderer, they are not.
- **Discovery and installation.** Where tool definitions live, whether they are
  per-project or global (pi's presets use both, project winning), and what happens on a
  malformed one.
- **Whether a user tool can be profile-scoped.** Profiles already carry a tool subset,
  so this may be free — but a profile referencing a tool that failed to load is the same
  dangling-reference problem [the profile data model](04-profile-data-model.md) has to
  answer for built-ins.
- **What v1 is.** The declarative option is a genuinely useful product on its own and
  costs almost nothing beyond `exec` and the gate. Deciding it is v1 does not foreclose
  scripts later, and it is the only option that can ship before the sandboxing question
  is answered.

Out of scope for this ticket: UI extensions, custom renderers, and anything touching the
ADE's own chrome. This is about **tools** — things the model can call. pi's extension API
does far more, and that breadth is what makes it a Node-and-TUI artifact.

---

## Resolution

**A declarative manifest for v1. Tools are not gated — profile membership is the trust
act — and the gate moves below the tool layer, onto commands and destructive actions.**

### Why renderer scripts are out, on evidence

`src-tauri/capabilities/default.json` scopes permissions to `"windows": ["main"]` —
**per-window, not per-script**. Anything executing in the main renderer can call every
Tauri command: `write_file`, `exec`, and the provider command holding the key. So user
code in the renderer would not need to *steal* the credential
[ticket 06](06-credentials-and-http.md) moved into Rust; it would use it by proxy. The
option is disqualified by how Tauri's capability model works, not by preference.

A **Web Worker has no `window`**, so no Tauri IPC exists inside it. That is real
capability isolation obtained for free rather than enforced — and it is why the Worker
route remains the credible path for scripts later.

### Decisions

1. **v1 is a declarative manifest**: a schema plus an **argv array** — see the amendment
   below, which corrects "shell command template" to argv. No user code
   runs in our process. It ships now, introduces no new trust boundary, and covers a
   large share of what people actually want — linters, formatters, project scripts, HTTP
   calls. **It is honestly less than pi offers**: no logic, no conditionals, no state.
   That gap is accepted for v1, not argued away.
2. **The manifest is versioned with a `runtime` discriminator from day one**, so a
   `runtime: "worker"` variant slots in without a format migration. This is the cheap
   half of "manifest now, Worker next", and it is worth doing even if the Worker never
   arrives.
3. **User tools are not gated.** Adding a tool to a profile **is** the trust decision;
   asking again at invocation would be asking the same question twice, and training the
   user to dismiss prompts. This supersedes the framing in
   [What stops a tool call](03-permission-gate.md), which is amended accordingly.
4. **The gate operates below the tool layer**, on the command being run and on
   destructive filesystem actions — not on tool identity. This is the load-bearing
   consequence, and it is what makes (3) safe: **a declarative tool executes through the
   same `exec` path as the built-in bash tool**, so Rust containment, the deny list, and
   the auto-mode floor from ticket 03 all apply to it automatically, without the tool
   being "gated" as a tool.

   Concretely: a user tool whose template resolves to `rm -rf /` is stopped — not because
   it is a user tool, but because the *command* hits the floor. **Trust granted by
   profile membership does not lift the floor.** A tool cannot be used to launder a
   command past the deny list.
5. **Discovery follows the profile convention**: a global file and a project file,
   project winning — matching [the profile data model](04-profile-data-model.md) so there
   is one rule for configuration rather than two. A malformed manifest fails loudly and
   is reported; a profile referencing a tool that failed to load **refuses to activate**,
   which is the same dangling-reference rule ticket 04 already set for built-ins.

### Amendment — argv, not a command string

Decision 1 originally said "a schema plus a shell command template". **That is an
injection hole and is corrected here.**

If parameters are substituted into a command *string* which is then handed to a shell, a
user tool declared as `grep {pattern} .` executes arbitrary code the moment the model
supplies `pattern = "; rm -rf ~"`. The user authored a grep tool; the model got a shell.
The gate does not save this — the composed command is what reaches `exec`, and by then
the injected fragment *is* the command.

**The manifest declares argv as an array**, and parameters substitute as whole argv
elements:

```json
{ "runtime": "exec", "argv": ["grep", "{pattern}", "."] }
```

- A parameter fills exactly one argv slot. It is never re-parsed, never word-split, never
  glob-expanded.
- Rust spawns with that argv directly, not through a shell, so quoting and escaping do not
  arise as problems to get right.
- A parameter appearing as a *fragment* of an element (`"--name={name}"`) is fine; what is
  forbidden is a parameter expanding into more than one element.

Cheap side effect: the "which shell" question from
[How `exec` runs a command](02-exec-not-terminal.md) does not apply to user tools at all.
That decision governs the `bash` tool, where a shell is the point. User tools never need
one.

This is worth deciding now rather than later: shipping string templates and migrating to
argv afterwards breaks every manifest already written.

### Rejected — rewriting pi's built-in tools into the manifest format

Considered and declined: expressing pi's four built-ins (`bash`, `read`, `write`, `edit`)
as argv manifests so one engine runs everything.

It reads as unification but is a downgrade. `read`, `write` and `edit` are **not shell
commands** — they call `env.readBinaryFile` / `writeFile` directly, with no process
involved. Re-expressing `read` as `["cat", "{path}"]` would lose image detection and
base64 attachment, `offset`/`limit`, line-and-byte truncation with the continuation hint,
and the temp-file overflow path — all of which pi already ships and tests. It replaces
working code with more code that does less, and adds a process spawn per file read.

**The real form of the instinct is correct, but it is one layer down.** What should be
shared is not the tool *format* but the **floor**: containment, the deny list, and
auto-mode live in Rust and apply to whatever reaches them. Built-ins reach it through the
filesystem commands; `bash` and user tools reach it through `exec`. That is already the
design from decision 4 — one enforcement point, several execution paths — and it is what
makes the built-ins' distinct implementations harmless.

So the shape is: **pi's four built-ins are a bounded exception, and every tool added after
them goes through the common argv engine.** The exception does not grow — it is four
tools, already written, and nothing new joins them.

One caveat on "any custom tool is a script you could call from a shell": true for
`runtime: "exec"`, and it is why v1 costs almost nothing. It is *not* true of what
decision 2's discriminator exists for. A `runtime: "worker"` tool holds state across
calls, makes decisions between steps, and returns structured `details` — none of which
survives being flattened into an argv line. The exception list stays at four; the
**runtime** list is what grows.

### Shipped

All five decisions are built. Three things the ticket did not say, and one it
got wrong:

- **The manifests live in the profile files**, not beside them. Decision 5 asked
  for "a global file and a project file, project winning"; the *same* two files
  satisfy that more literally than a parallel pair, and it is what makes the
  opt-in rule below liveable — a tool and the profile that has to name it are
  authored side by side. It also inherits the write floor for free, which
  matters more here than it did for profiles: `ade.profiles.json` now decides
  what argv the agent can spawn.
- **`agent_exec` grew an `argv` field** rather than a second command. Set, Rust
  spawns it directly with no shell; unset, the existing shell path is unchanged.
  Everything else — cwd confinement, the job object, the timeout, streaming — is
  shared, which is the point: a user tool is not a second execution path.
- **A malformed manifest is rejected whole**, where a malformed profile drops
  the bad field and keeps going. The two policies differ deliberately: a profile
  is a bag of settings and seven good fields should survive one typo, where
  there is no such thing as half a tool. Half a manifest runs something other
  than what its author wrote.

**The correction: `tools` defaults on, and this ticket needs it off.** Ticket
04's map rule is that an unmentioned tool is *enabled*, so that a tool pi adds
upstream does not vanish from profiles written before it existed. Applied to a
user tool that makes decision 3 false — dropping a manifest on disk would arm it
in every profile, and the trust act that justifies not gating it would never
happen. **User tools are opt-in; built-ins keep default-on.** The rule follows
the argument rather than the mechanism: default-on for tools nobody chose to
have, opt-in for tools someone wrote. Decided with the dev.

Two smaller consequences, both from the same floor argument:

- **The deny list is checked against the resolved argv**, so a user tool cannot
  launder `rm -rf` past it. It **refuses** rather than asking, unlike `bash`: a
  turn owns the gate and can ask, a tool cannot. That makes user tools strictly
  stricter than the shell, which is the safe direction — `bash` is still there
  for someone who means it.
- **A manifest may not shadow `read`, `write`, `edit` or `bash`.** pi throws on
  duplicate tool names, so this would otherwise take the harness down at
  `setTools` rather than at parse. Hard-coded, because the ticket's own rule is
  that the built-in exception does not grow.

**Verified live, not only in the checks.** The model was shown a manifest tool,
called it with the right parameter, and got its output back. The argv property
was tested by passing `; echo pwned`, `$(whoami)`, `` `whoami` `` and `*` as
parameter values: every one came back printed verbatim, so nothing downstream
word-splits, substitutes or glob-expands. Under a profile that did not name the
tool, the model listed only `read, write, edit, bash`.

**Parameters, widened.** `"pattern": "what to find"` still means a required
string and is still what almost every tool writes. The long form —
`{ description, type, required, choices }` — adds numbers, booleans, optional
slots and a closed set of values. Two things it forced:

- **An omitted optional takes its whole argv element with it.** One rule,
  right in both shapes it has to be right in: `["rg", "{pattern}", "{path}"]`
  without a path runs `rg pattern` rather than `rg pattern ""`, and
  `"--project={dir}"` without a dir disappears rather than becoming a bare
  `--project=`. Substituting the empty string would have been the smaller change
  and would pass an empty argument to a program that asked for a path.
- **`choices` emits `enum`, not a union of literals.** TypeBox's `Type.Union`
  produces `anyOf: [{const}, …]`, which is correct JSON Schema and the thing
  Google's function-declaration subset handles worst; `enum` is what every
  provider reads. TypeBox validates the keyword either way, so the portable
  form costs nothing.

Verified with real turns: the model picked a value from `choices`, supplied the
optional number when the prompt implied it, and omitted it when it did not.

### The credential the ticket did not think about

Ticket 06 put the key in Rust so it never enters JavaScript, and that is still
true — but it lives in **this process's environment**, and an inherited
environment hands it to every child. A manifest of `["node", "-e",
"console.log(process.env.DEEPSEEK_API_KEY)"]` printed it into the transcript.

`agent_exec` now strips `ANTHROPIC_API_KEY`, `GEMINI_API_KEY` and
`DEEPSEEK_API_KEY` from every child, on the **shell path as much as the argv
one** — `bash` was the older hole and user tools only made it sharper by being
ungated on the argument that profile membership is the trust act. The list lives
in `provider.rs` beside the arms it mirrors, so a provider added without being
added there fails in the direction that leaks nothing new. A tool that genuinely
needs a key gets one through the manifest's `env`, written by the person who
wrote the tool.

`PATH` and everything else still travel; the strip is three names, not
`env_clear`.

### Three more manifest fields, and a parse bug they found

`timeout` (seconds, default 120), `cwd` (root-relative, confined by Rust like
every other path) and `env`. Output now **streams** through pi's `onUpdate`,
throttled to four times a second — Rust sends a message per line, and
forwarding each one would re-render the transcript once per line of a build log.

Writing the manifest that tested them found a real defect. The placeholder
pattern was `\{([^{}]*)\}`, which reads **any** braces as a parameter — so an
ordinary `node -e` script was rejected for "using `{clearInterval(t);}` without
declaring it", and `awk '{print $1}'`, `find . -exec rm {} \;` and `jq '{a: .b}'`
would all have been unusable. A placeholder is now braces around an
*identifier*, which leaves real shell and script braces alone while keeping the
error that matters: `{pattenr}` is still an identifier, so a mistyped parameter
is still reported rather than silently becoming a literal.

Two smaller things from the same session: a failed run reported `[object
Object]` because Rust rejects with `{ code, message }` rather than an `Error`,
and it now carries the partial output with the failure — a tool killed at its
timeout printed something first, and that is usually the whole diagnosis.

### `/reload`

Files were read once, at workspace restore, so editing a manifest meant
restarting the app. For a feature whose entire interface is hand-authoring a
file, that is the cost of not building an editor, and it is not worth paying for
four lines. `/reload` re-reads both files; the install paths already handled
being run twice, so nothing here is a first-load special case. `/profile` says
so, since nobody would guess.

**What is still honestly missing.** The destructive refusal cannot be
overridden: a tool that legitimately clears a build directory is permanently
unusable, because refusing is all a tool can do without a way to reach the
gate's approval path. Routing it through is real plumbing rather than a tweak.

### Not settled here

- **Worker-hosted scripts** — the capability protocol, worker lifecycle, and handling of
  hangs, timeouts and errors in code we did not write. This is the largest single piece
  of work the map has deferred, and it should be its own effort when it comes, not a
  ticket bolted onto this one.
- **UI extensions, custom renderers, ADE chrome** — out of scope as originally charted,
  and still fog on the map.
