---
label: wayfinder:grilling
title: What the Tauri ExecutionEnv actually implements
parent: ../map.md
blocked-by: []
assignee: jc4649
status: closed
---

# What the Tauri ExecutionEnv actually implements

## Question

> **⚠ Read before starting.** Two findings from
> [How this repo depends on pi](07-pi-dependency.md) change what this ticket is looking
> at. (1) pi **0.82.0** replaced `AgentHarness`'s `ExecutionEnv` dependency with
> application-defined `toolContext` values and context-aware `AgentHarnessTool`
> definitions — so `ExecutionEnv` may not be the seam in the 0.83.0 we are pinning.
> (2) The `pi/` clone (`aa0ec808b`) is **ahead of published 0.83.0**, so every line
> number cited below may point at unreleased API. Verify against the pinned tarball
> first. The *shape* of the work is unchanged: Rust holds the authority, TypeScript
> adapts to whatever the current seam is.

The single adapter this whole destination rests on. `ExecutionEnv = FileSystem & Shell`
(`pi/packages/agent/src/harness/types.ts:373`); this ticket settles the `FileSystem`
half — 16 methods plus `cwd` and `cleanup`. `exec` is
[its own ticket](02-exec-not-terminal.md).

Two mismatches with what `src-tauri` exposes today, neither cosmetic:

- **Ours is id-addressed; pi's is path-addressed.** `read_file(id)` / `write_file(id)`
  take an opaque id, and that indirection *is* the mechanism enforcing root
  confinement. pi passes paths, absolute or relative to `cwd`. Going path-based means
  re-establishing containment on every path crossing into Rust.
- **Coverage.** Rust has `list_tree` (whole-tree walk), `read_file`, `write_file`,
  `search_workspace`. pi wants `listDir` (direct children only), plus `absolutePath`,
  `joinPath`, `readTextLines`, `readBinaryFile`, `appendFile`, `fileInfo`,
  `canonicalPath`, `exists`, `createDir`, `remove`, `createTempDir`, `createTempFile`.

Settle:

- **First, establish what the seam actually is.** Everything below is written against
  `ExecutionEnv` because that is what the `pi/` clone shows. Confirm against the pinned
  0.83.0 tarball whether the harness still takes an `ExecutionEnv`, or whether tools now
  receive an application-defined `toolContext`. If it is the latter, this ticket's
  method-by-method table is still the deliverable — the methods just hang off a
  different noun, and the containment, symlink, temp-file and never-throw questions are
  all unchanged.
- **Wrap it either way.** The dependency ticket's resolution says do not implement pi's
  interfaces directly: define our own domain interface and adapt. `context.md` already
  requires exactly that. It is also what makes an upstream rename survivable, which at
  ~one release every 2.1 days is not hypothetical.

- **Where containment is enforced.** Rust is the authority, so the check belongs there
  — but decide whether every command re-validates independently, or one guarded
  path-resolution helper is the single gate. The second is fewer places to forget; the
  first fails safe if someone adds a command later.
- **What `canonicalPath` and symlinks mean under root confinement.** pi's contract says
  symlinks are *not* followed except by `canonicalPath`. A symlink pointing out of the
  workspace root is the obvious escape; decide whether it resolves, errors, or is
  refused before resolution.
- **Temp files.** `createTempDir` / `createTempFile` are in the contract, and the
  natural implementation puts them in the OS temp dir — outside the root. Decide
  whether they live inside the workspace, in a confined scratch area, or whether these
  two methods return an error and we find out what breaks.
- **The never-throw invariant.** `types.ts:288` — *"Operation methods must never throw
  or reject. All filesystem failures ... must be encoded in the returned `Result`."*
  Tauri's `invoke` **rejects** on `Err`. Decide the mapping once, in one place, because
  it is 17 opportunities to leak an exception into pi's loop.
- **How much is v1.** Stubbing the rarely-called methods with a `FileError` and
  learning from real runs is a legitimate answer, and cheaper than guessing which of
  the 16 matter.

Out of this should come a written method-by-method table: pi method → Rust command →
error mapping, with anything deliberately unimplemented marked as such.

---

## Resolution

**Take pi's built-in tools. Implement a ~9-method `ExecutionEnv` subset over Rust,
behind our own domain interface.**

All findings below are from the **published 0.83.0 tarball** (`npm pack`), not the `pi/`
clone — the clone is ahead of the release and could not be trusted for this.

### The seam, established

The map's warning was half right. `AgentHarness` genuinely no longer depends on
`ExecutionEnv`: it takes `tools?: TTool[]` plus
`toolContext: TContext | (() => TContext | Promise<TContext>)`, an **arbitrary
application-defined object** resolved per turn and handed to each tool's `execute()`.
The harness itself has no filesystem opinion at all.

`ExecutionEnv` survives unchanged (`extends FileSystem, Shell`), but its role moved: it
is now the *built-in tools'* context, via
`ExecutionToolContext = { env: ExecutionEnv }`. pi ships `createReadTool`,
`createWriteTool`, `createEditTool` and `createBashTool`, each generic over
`TContext extends ExecutionToolContext`.

So implementing `ExecutionEnv` is **opt-in**, and what it buys is pi's tools.

### Decisions

1. **Use pi's built-in tools** (decided with the dev). The deciding factor is
   `edit-diff` — 16.6 KB of fuzzy-match, whitespace and uniqueness logic, which is where
   agent edit tools usually fail. Also inherited: a file-mutation queue, output
   truncation, and image handling. The accepted cost is that pi owns those tools'
   semantics on a surface that churns at ~one release every 2.1 days.
2. **Implement 9 methods, not 16.** What the shipped code actually calls:

   | Consumer | Methods |
   |---|---|
   | The 4 built-in tools | `readTextFile`, `readBinaryFile`, `writeFile`, `absolutePath`, `canonicalPath`, `fileInfo`, `exists`, `cwd`, `exec` |
   | `loadSkills` / `loadPromptTemplates` | `fileInfo`, `readTextFile`, `listDir`, `canonicalPath` |

   `joinPath`, `readTextLines`, `appendFile`, `createDir`, `remove`, `createTempDir`
   and `createTempFile` are called by nothing we use. **Stub them returning a
   `FileError`** and let real runs prove otherwise. This retires the ticket's temp-file
   question outright — nothing we use calls those two — and defers `createDir`/`remove`.
3. **Containment is enforced in Rust, through one guarded path-resolution helper**, not
   re-validated per command. Follows from `context.md`: Rust is the sole authority. A
   single resolver is one place to audit; the risk it carries — a future command that
   forgets to call it — is the thing code review must watch for, and is cheaper to watch
   than N independent checks staying correct.
4. **Symlinks: `canonicalPath` refuses to resolve outside the root.** It is called by
   both the tools and the skill loader, and a symlink out of the workspace is the
   obvious escape from root confinement. Refusing is consistent with the boundary the
   repo already enforces; following would silently void it.
5. **The never-throw invariant gets exactly one implementation.** Tauri's `invoke`
   *rejects* on `Err`; pi requires a `Result`. One wrapper converts, and no adapter
   method calls `invoke` directly. This is also the cheapest way to keep the invariant
   true as methods are added.
6. **Wrap, do not implement directly.** Per
   [How this repo depends on pi](07-pi-dependency.md), define our own domain interface
   and adapt pi's shape onto it — which `context.md` requires anyway, and which bounds
   the blast radius of an upstream rename.

### Findings that belong to other tickets

- **`createBashTool` ships `commandPrefix?: string` and
  `prepare?: (execution, context, signal) => void`**, where
  `BashExecution = { command, cwd, env, inheritEnv }` is **mutable before the command
  runs**. That is an rtk seam and a command-rewrite seam, upstream and free —
  [`exec`](02-exec-not-terminal.md) and [rtk](11-rtk-in-profile.md) should both start
  from it rather than from adapter surgery.
- **The harness has a hook system with results, in the browser-safe core.** 22 event
  types, eight of which return values that change behaviour — including
  `tool_call -> ToolCallResult { block?, reason? }`, which is byte-for-byte what pi's
  TUI-layer `permission-gate.ts` returns. **The map's Notes were wrong**: what is stuck
  in the Node/TUI layer is the extension *host* that loads user scripts off disk, not
  the hook substrate. This makes [What stops a tool call](03-permission-gate.md)
  substantially smaller than written.
- **The tool set is mutable at runtime** — `ToolsUpdateEvent`, `ResourcesUpdateEvent`,
  `activeToolNames`, and a documented `setResources()`. Mid-session profile switching is
  supported by construction, which answers the load-bearing unknown flagged in
  [What is a profile, concretely?](04-profile-data-model.md).

### Correction — the method survey was incomplete

The table above was built by grepping `harness/tools/`. That missed
`harness/utils/shell-output.js`, which implements bash's output-overflow path. Surveyed
across the **whole** published package, the real list is **11 filesystem methods plus
`exec`**, not 9:

`fileInfo`, `readTextFile`, `canonicalPath`, `writeFile`, `listDir`, `appendFile`,
`absolutePath`, `readBinaryFile`, `exists`, `cwd`, `createTempFile`, `exec`

Only five are genuinely unused: `joinPath`, `readTextLines`, `createDir`, `remove`,
`createTempDir`. Those five keep the stub-with-`FileError` treatment.

**The consequence matters more than the count.** `createTempFile` and `appendFile` are
used by `shell-output.js`: when a command's output exceeds the line or byte cap, pi
streams the full output into a temp file and tells the model the path. So the ticket's
temp-file question is **not retired** — it is live, it belongs to
[`exec`](02-exec-not-terminal.md), and it has a new wrinkle: the model is handed that
path and may well try to `read` it, so wherever the file lives has to be readable by the
`read` tool under the same containment rules.

### Correction 2 — `readTextLines` is required after all

[Where sessions are stored](09-session-store.md) found that `JsonlSessionStorage` takes
`Pick<FileSystem, "readTextFile" | "readTextLines" | "writeFile" | "appendFile">`. So
persisting sessions requires **`readTextLines`**, which both surveys above listed as
unused and stubbed.

Revised: **12 filesystem methods plus `exec`** are live. Only four remain genuinely
unused — `joinPath`, `createDir`, `remove`, `createTempDir` — and they keep the
stub-with-`FileError` treatment.

The lesson worth keeping: both earlier surveys were grep-based over *some* of the
package, and both were wrong in the same direction. The method list should be settled by
type-checking a real implementation against the interface, not by searching for call
sites.

### Correction 3 — `cleanup()`, and the lesson applied

Type-checking a real implementation, which is what
[the spike](12-walking-skeleton.md) finally did, turned up **`cleanup(): Promise<void>`**
— declared on `FileSystem` *and* on `Shell`, and missed by all three surveys above.
One implementation satisfies both. Like every other method it must not throw.

So the surface is **12 filesystem methods, `exec`, and `cleanup`**. Three surveys, three
undercounts, all in the same direction — the correction the last one prescribed is the
one that found this, which is the argument for doing it that way first next time.

One finding that changes how the invariant should be read: **pi's own tools convert
`Result` back into exceptions.** `harness/tools/path-utils.js` wraps `absolutePath` and
`exists` in `getOrThrow`, and the tool executor catches. The never-throw contract
therefore binds *our adapter*, not pi's internals — we still may not throw, but we do not
get to assume a `Result` travels all the way up.
