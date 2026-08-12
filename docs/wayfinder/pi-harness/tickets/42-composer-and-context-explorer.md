# 42 — The composer, and the Context Explorer

**Blocked by:** [37](37-shell-tokens-and-stack.md), [40](40-pinned-workbench.md).
**Status:** **landed in `336c307`, record not yet written.** The criteria below are
untouched because nobody has checked them against the code — they say nothing about
whether the work is done. Do not read an unticked box here as work remaining. The
deferred location-rail decision is still deferred.

## The composer

Centred, capped at 760px. First row: `[prompt input][send]`. Send is disabled when the
prompt is empty. Draft attachments appear as removable chips above the input. Dragging a
file or folder over the composer highlights its border and surface.

**No microphone.** The [Shell Guide](../../UIUX-UPDATE.md) specifies one that *"simulates
recording, then inserts mock transcription"* — a placeholder in the prototype, and a button
that lies in the shipping composer. There is no speech-to-text in this repo, and adding one
means either a cloud API — with the credential handling the Rust HTTPS path exists to keep
out of JavaScript — or a local model. Dictation is its own ticket with its own credential
decision. **This is a deliberate deviation from the Shell Guide, recorded here.**

### The bottom bar

Separate from the input surface, exactly 32px:

```text
[attach][profile summary][context ring]                              [profile]
```

The three left controls are independent transparent buttons — **not** a segmented
container, no default border or background, each highlighting on hover alone. Profile
summary is read-only: `model · effort · maximum context`. Context usage is an unlabelled
circular ring; clicking it opens a usage popover. The profile selector has no leading icon.

The ring and the popover replace the meter that renders beside the token counts today,
including the session cost line [ticket 26](26-cost.md) landed. Do not lose it in the move.

**One control the Guide does not name sits on the right, beside the profile selector:**
the plain-text transcript. It is the documented way out for anyone who cannot read a
transcript of nested disclosures — it is in the keyboard help by name — so deleting it to
match a mock's silence would remove an accessibility affordance to gain a pixel. The
Guide constrains the *left* group to three; the right is the profile selector and this.

## The Context Explorer

Attach opens a **modeless** file explorer in the empty chat area directly above the
composer: same width, 8px gap, capped at 280px or 36vh, never covering the input or
toolbar, with the Session Navigator above it in z-order. No title header, no footer.

```text
[previous][current path][close]
[location rail][flat directory contents]
```

Flat listing, immediate children only. Clicking a folder drills in; Previous walks back
through history. Clicking a file opens it as a Monaco tab in the Modal Workbench. Previous,
path and Close share one compact 28px bar.

**Dragging into the composer is the Guide's only stated way to attach.** It is not this
app's only way: [ticket 27](27-file-mention.md) landed `@` file mention in Slice 39, and
`@src/agent/env.ts` reaches the model as a path. Both stay. The Guide's sentence describes
a prototype with no completion menu, and deleting a landed feature to match a mock's
omission is not what "follow the Shell Guide" meant.

### The location rail — deferred, and it is the security boundary

The Guide's rail lists **Recent, Downloads, Documents, Desktop, Pinned, C:, D:**.
`src-tauri/src/workspace.rs` opens with *"Root-confined workspace access… one canonical
root, no escaping it"* and *"the UI never sees or sends absolute paths except when choosing
the root."* Rust will refuse every one of those, and that refusal is the boundary, not a
foot-gun guard.

**The dev deferred this.** So: **ship the explorer confined to the workspace root, with the
rail unbuilt.** Do not quietly implement a root-only rail wearing OS labels — that is a
decision, and it is not this ticket's to take.

When it comes back, the option to look at first is a **second confined mount**.
`workspace.rs:120` already calls the global skills directory *"the second thing this app
reads from outside the workspace root"*, resolved through a mount prefix so the UI still
never learns an OS path. Documents and Downloads could be third and fourth on identical
terms. Drive letters could not.

## Acceptance criteria

- [ ] Composer centred at 760px, send disabled when empty, attachment chips removable, drag
      highlight on the border and surface.
- [ ] No microphone button exists.
- [ ] Bottom bar is exactly 32px, three independent transparent left controls, profile
      summary read-only in `model · effort · maximum context` form.
- [ ] The context ring shows usage and its popover carries what the current meter carries,
      including session cost.
- [ ] The Context Explorer is modeless, sits above the composer without covering it,
      respects the height cap, and stays below the Session Navigator in z-order.
- [ ] Flat listing, drill-in, Previous history, file opens as a Modal tab.
- [ ] Drag-to-attach works, and `@` mention still works.
- [ ] The location rail is absent, and this ticket says why.
- [ ] `npm run check` and `npx tsc --noEmit` clean.
