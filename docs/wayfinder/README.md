# Wayfinder maps

No issue tracker is configured for this repo, so wayfinder maps live here as markdown.

One directory per effort: `map.md` plus `tickets/NN-slug.md`. Frontmatter carries what a
tracker would: `label` (`wayfinder:map`, or the ticket type — `research`, `prototype`,
`grilling`, `task`), `blocked-by` (list of sibling filenames), `assignee`, `status`.

**Frontier** = open tickets with `assignee:` empty whose every `blocked-by` entry is
`status: closed`. There is no query engine; read the frontmatter.

**Claiming**: set `assignee` *before* doing any work, so a concurrent session skips it.

**Assets**: research output, measurements, and prototypes live in `<effort>/assets/`
and are linked from the ticket that produced them — never pasted into the ticket body.
A research ticket is not resolved until its asset exists.

**Resolving**: append a `## Resolution` section to the ticket, set `status: closed`, then
add one line to the map's *Decisions so far*. Never restate the decision on the map — the
map indexes, the ticket holds.

Refer to maps and tickets by their **title**, never by number.

A map may carry `status: paused` in its frontmatter — kept for the record, not being
worked. Its tickets are off every frontier regardless of their own status.

| Effort | Map | Status |
|---|---|---|
| pi as the ADE's built-in agent | [map.md](pi-harness/map.md) | active |
| Rust agent harness for the ADE | [map.md](rust-harness/map.md) | paused — pi became a dependency, not a reference |
