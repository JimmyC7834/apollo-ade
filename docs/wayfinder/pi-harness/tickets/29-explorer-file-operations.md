# 29 — Let the human create a file

**Blocked by:** [25](25-confirm-primitive.md).
**Status:** ready-for-agent.

## The asymmetry this closes

Rust exposes `agent_write_file`, `agent_create_dir` and `agent_append_file`. It exposes
nothing for rename and nothing for delete, and the explorer offers no file operations at
all. **The agent can create files the person sitting in front of the window cannot.**

That is not a security posture, it is an omission — the agent's authority was built first
because the agent needed it first.

## What to build

Create file, create folder, rename and delete, from the explorer's context menu.
`ContextMenu` already exists and is already used.

## What is genuinely new

Rename and delete have **no Rust command**, and both must land under `contained()` like
everything else — the confinement boundary is the one thing in this repo that is a real
security boundary rather than a foot-gun guard, and two new mutating commands are exactly
where it gets tested.

Delete is the one to be careful with. This repo's standing instruction is that destructive
operations are gated, and a delete that takes a directory takes everything under it.

- Confirm before deleting, through [ticket 25](25-confirm-primitive.md)'s primitive.
- Prefer the OS trash to an unlink if Tauri's dialog or fs plugins offer one — recoverable
  beats confirmed.
- An open editor whose file was renamed or deleted must not keep silently writing to a
  path that moved.

## Acceptance criteria

- [ ] Create file, create folder, rename and delete, from the explorer context menu.
- [ ] Rename and delete are Rust commands and both refuse a path outside the root, with a
      check covering the refusal.
- [ ] Delete confirms first and says what it is deleting, including how many entries when
      it is a directory.
- [ ] A rename updates any open editor tab for that file; a delete closes it or marks it
      gone rather than leaving a tab that writes to nothing.
- [ ] The tree refreshes without a manual reload.
- [ ] Browser mode either supports these against the fixture or refuses them honestly —
      not a silent no-op. [Ticket 10](10-browser-mode-env.md)'s rule.
