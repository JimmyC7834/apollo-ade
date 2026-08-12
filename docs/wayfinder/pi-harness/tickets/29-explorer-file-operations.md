# 29 — Let the human create a file

**Blocked by:** [25](25-confirm-primitive.md).
**Status:** **landed.** See [Landed](#landed).

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

- [x] Create file, create folder, rename and delete, from the explorer context menu.
- [x] Rename and delete are Rust commands and both refuse a path outside the root, with a
      check covering the refusal.
- [x] Delete confirms first and says what it is deleting, including how many entries when
      it is a directory.
- [x] A rename updates any open editor tab for that file; a delete closes it or marks it
      gone rather than leaving a tab that writes to nothing.
- [x] The tree refreshes without a manual reload.
- [x] Browser mode either supports these against the fixture or refuses them honestly —
      not a silent no-op. [Ticket 10](10-browser-mode-env.md)'s rule.

## Landed

**Four Rust commands, plus one that only reads.** `create_file`, `create_folder`,
`rename_entry` and `delete_entry`, and `delete_plan` — which exists so the
confirmation can say how many entries a folder holds *before* anything is
destroyed rather than reporting it afterwards.

All of them reach a path through one of two helpers and nothing else:

- `creatable` — contained, and not already taken.
- `existing` — contained, parent canonicalised and still inside the root, target
  present, and **not a symlink**. Deleting a link and following it differ by an
  entire directory tree, so the rule is stated once for both operations.

The criterion asks for a check on the refusal and it is asserted on those two
helpers rather than on the commands, because a `tauri::command` needs a
`tauri::State` to call and testing through one would be testing Tauri's plumbing
instead of the boundary. `rename_and_delete_cannot_leave_the_root` covers `..`,
absolute ids, backslash spellings, the drive-qualified Windows form, the empty
id (which is the root itself), and the counting walk.

**They use `may_write`, not `agent_may_write`.** That difference is the point of
having two: `ade.profiles.json` and `.agents/skills` are withheld from the
*agent*, because an agent that can rewrite what it is told can grant itself
anything. The human is the one who writes those files. What binds both is
containment, and that is enforced identically.

**Delete goes to the OS trash.** The ticket asked to prefer recoverable over
confirmed and neither Tauri nor its fs plugin offers a trash, so this is one new
dependency — `trash`, seven crates, no `chrono` on Windows. Taken deliberately:
the alternative is `remove_dir_all`, which would make this the only action in the
app with no way back, in a repo whose standing rule is that destructive
operations are gated. A confirmation is only as good as the attention of the
person clicking it.

**Renaming a folder moves the editors under it.** `isUnder` is a function rather
than an inline `startsWith` for one reason: the prefix has to be tested with the
trailing slash, or renaming `src` also drags `src-old/x.ts` along. Source editors
follow the rename and keep their unsaved text; **diff tabs close**, because a
diff is a snapshot against a path git no longer has in the working tree. A delete
closes both, which is the ticket's "no tab writing to nothing".

**The confirmation says what the trash cannot give back.** Unsaved editor buffers
are counted by the workbench — the only side that knows what is open — and named
in the dialog, because the file is recoverable and the buffer is not.

**Browser mode, split rather than blanket.** Against the fixture all four work,
in memory, which is what made every claim above verifiable without a native
window. Against a real browser-picked folder, create works and **rename and
delete are refused out loud**: rename has no portable API, and delete has one and
is refused anyway, because the browser has no trash and implementing it would put
the app's one unrecoverable action behind its least-tested provider. The
provider carries `deletesToTrash`, so the dialog promises a trash only where one
exists.

**Also fixed on the way:** an empty workspace had no rows to right-click, so
ticket 29's whole premise — the human cannot create a file — would still have
held for a new project. The empty state offers New file directly.
