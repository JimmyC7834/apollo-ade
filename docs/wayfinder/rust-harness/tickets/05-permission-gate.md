---
label: wayfinder:grilling
title: What stops a tool call?
parent: ../map.md
blocked-by: []
assignee:
status: open
---

# What stops a tool call?

## Question

The sharpest divergence between the two references, and this repo has already taken a
position that neither of them takes.

- **pi ships no gate.** No permission prompts, no allowlists, no sandbox. A
  `beforeToolCall` seam exists with nothing plugged into it. `pi/docs/security.md:35`
  argues a partial in-process sandbox *"would be easy to misunderstand as a security
  boundary"* and pushes containment entirely to Docker/micro-VM.
- **Claude Code makes it first-class**: allow/ask/deny rules with deny→ask→allow
  precedence, six modes, enforced by the harness rather than the model, plus an OS
  sandbox layer, plus checkpoints, plus a managed tier a developer cannot override. The
  docs concede the limits honestly — Read/Edit deny rules do not stop a Python script
  from opening a file.
- **This repo** already says Rust is the only filesystem/process authority and stays
  **root-confined**. That is a real boundary neither reference assumes, and it is
  enforced by the existing `src-tauri/workspace.rs`.

Settle:

- **Does v1 have a gate at all, or only the seam?** pi's answer — ship the seam, ship no
  policy — is defensible and cheap, and the existing approval event in `src/agent.ts`
  suggests a gate was always intended. Say which.
- **Is the gate profile-scoped?** A profile that bundles tools but not permissions is
  half a profile. Cross-check [What is a profile, concretely?](01-profile-data-model.md).
- **What does root-confinement already cover, and what does it not?** `bash` is the hole:
  a root-confined `read`/`write` means nothing if `bash` can `cd ..`. Decide what `bash`
  is allowed to be before it is written.
- **Approval UX ownership** — the harness raises it, but who renders and remembers it,
  and does an approval persist across a session or a turn?
