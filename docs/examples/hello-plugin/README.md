# The hello plugin

The smallest plugin that uses everything tickets
[72](../wayfinder/pi-harness/tickets/72-a-plugin-loads-and-adds-a-command.md) and
[73](../wayfinder/pi-harness/tickets/73-a-plugin-acts-and-listens.md) built: a claimed
command, `invoke`, and a `tool_call` handler.

Installing one is copying a folder, and **where you copy it is the trust decision**:

- **Global** — into the `plugins` folder the Plugins artifact names at the top. It loads at
  start-up. Putting it there *is* the decision.
- **Local** — into `.ade/plugins/` under a project root. It is listed and **inert** until you
  enable it for that root, because cloning a repository must never be the same act as running
  its author's code.

Open the command centre and run **Hello: Say Which Branch**; it logs the branch to the
console. Every tool call the model makes is logged too. It changes nothing and calls only
`git_branch`, which reads.

`docs/adr/0005-a-plugin-is-injected-and-the-api-is-a-promise.md` is why it works this way.
