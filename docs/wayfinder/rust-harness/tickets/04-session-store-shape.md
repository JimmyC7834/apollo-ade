---
label: wayfinder:grilling
title: Session log — tree or line?
parent: ../map.md
blocked-by: []
assignee:
status: open
---

# Session log — tree or line?

## Question

Both references persist append-only JSONL, but they are not the same data structure, and
the difference is roughly 1,300 lines of pi.

- **pi**: an append-only **tree** — `parentId` on every entry, format v3, stored under
  `~/.pi/agent/sessions/<encoded-cwd>/`, with *branch summarization* when you navigate
  the tree (`session-manager.ts:46-51`, `:474-480`).
- **Claude Code**: a **linear** JSONL per session under `~/.claude/projects/`, resume by
  the same id, `--fork-session` copies the file under a new one. Subagent transcripts are
  separate sidechain files. Reads capped at 50MB.

Claude Code gets forking by *copying a line*; pi pays for a tree and gets in-place
branch navigation. Decide which this harness is, and be explicit that the tree is the
expensive half — the fork feature it enables may or may not be wanted at all
(see **Not yet specified** on the map).

Settle:

- Tree or line, and if line, whether the format leaves room to become a tree later.
- **Where sessions live on disk**, given the root-confinement rule — per-workspace inside
  the project, or a global store keyed by workspace path as both references do.
- **What one entry contains.** Enough to reconstruct the exact request that was sent, or
  only enough to redraw the UI? These diverge fast, and compaction depends on the answer.
- **Resume and replay.** What is rebuilt on resume beyond the message list — file
  history, usage counters, pending approvals.
