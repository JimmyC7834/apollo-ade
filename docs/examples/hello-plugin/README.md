# The hello plugin

The smallest plugin that uses **all six messages** — everything tickets
[72](../wayfinder/pi-harness/tickets/72-a-plugin-loads-and-adds-a-command.md) through
[76](../wayfinder/pi-harness/tickets/76-a-plugin-changes-the-chrome.md) built:

| Message | What it does here |
| --- | --- |
| `claim('command')` | **Hello: Say Which Branch** in the command centre. |
| `invoke` | `git_branch`, which reads and changes nothing. |
| `on` | logs every tool call the model makes, and blocks none of them. |
| `claim('tool')` | `which_branch`, **off** until a profile names it. |
| `panel` + `relay` | its own page in a dock tab, asking the plugin for the branch. |
| `theme` | one token value, put back when the plugin is disabled. |
| `claim('layout')` | renames Terminal to Shell and pulls it to the front. |

Installing one is copying a folder, and **where you copy it is the trust decision**:

- **Global** — into the `plugins` folder the Plugins artifact names at the top. It loads at
  start-up. Putting it there *is* the decision.
- **Local** — into `.ade/plugins/` under a project root. It is listed and **inert** until you
  enable it for that root, because cloning a repository must never be the same act as running
  its author's code.

Open the command centre and run **Hello: Say Which Branch**; it logs the branch to the
console. It changes nothing and calls only `git_branch`, which reads.

Two things are deliberately **not** automatic:

- The tool `which_branch` appears in the profile editor marked *from Hello* and switched
  **off**. Enabling the plugin says "run this code"; a profile naming the tool is the
  separate act that says "let the model call this".
- Nothing this plugin claims can hide the Plugins artifact or the command that opens it.
  That is the route back — a plugin that could hide it would be a plugin you could not
  turn off.

The panel is served over `plugin://`, which reaches that plugin's folder and nothing
outside it. It links `plugin://ade/tokens.css` to get the ADE's palette: a plugin cannot
import our components, and it does not have to invent a look either.

`docs/adr/0005-a-plugin-is-injected-and-the-api-is-a-promise.md` is why it works this way.
