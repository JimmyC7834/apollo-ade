// What the model is told, and in what order.
//
// Settled in docs/wayfinder/pi-harness/tickets/17-system-prompt-assembly.md,
// which was grilled against pi's own source. pi answers this at three layers: a
// pure builder (`coding-agent/src/core/system-prompt.ts`), a chaining hook over
// extensions (`core/extensions/runner.ts:1080`), and a per-turn override that is
// cleared afterwards. This file is layers one and two; the harness gives us
// three for free.

import { formatSkillsForSystemPrompt, type Skill } from '@earendil-works/pi-agent-core';

/** Everything the prompt is assembled from. */
export interface PromptParts {
	/** Which shell `bash` got, or undefined when there is none. */
	readonly shell?: string;
	/** Skills the harness has loaded. Empty until ticket 15's loading lands. */
	readonly skills?: readonly Skill[];
	/** The active profile's `instructions`. Appended, never substituted. */
	readonly instructions?: string;
}

const BASE =
	'You are a coding assistant inside an editor. Use the `read` tool to look at files ' +
	'before answering questions about them, and `write` or `edit` to change them. Paths ' +
	'are relative to the workspace root. If a file is missing, say so rather than ' +
	'guessing at its contents. Never guess at what a file contains before editing it — ' +
	'read it first.';

/**
 * The shell sentence, which is the one part of this that is machine-detected.
 *
 * Which shell the `bash` tool got **varies by machine** — Git Bash where it is
 * installed, PowerShell where it is not — so a model told nothing writes POSIX
 * at a PowerShell and finds out one failed command at a time. Ticket 02 called
 * this out as the cost of detecting rather than mandating a shell.
 */
function shellFacts(shell: string | undefined): string {
	if (!shell) {
		return 'There is no shell available, so the `bash` tool will always fail.';
	}
	return shell === 'bash'
		? 'The `bash` tool runs commands in bash, from the workspace root.'
		: 'The `bash` tool runs commands in **PowerShell**, not bash, from the workspace ' +
				'root. Write PowerShell syntax: no `&&`, no `|| true`, no `$(...)`, and use ' +
				'`Get-ChildItem` rather than `ls -la`.';
}

/**
 * Assemble the prompt. Base guidance, then the profile, then skills, then facts.
 *
 * **The facts go last on purpose.** The ticket was written fearing the opposite —
 * that a floor placed first is a floor a profile can talk over — and pi's answer
 * is the inverse: `buildSystemPrompt` appends project context, skills and
 * `Current working directory:` *after* whatever the caller added, because later
 * text is generally weighted more heavily. Putting the shell sentence last is
 * what keeps a profile from contradicting it by accident.
 *
 * `instructions` sits in the slot pi calls `appendSystemPrompt` — inside the
 * builder, before the facts — rather than where `preset.ts` puts it. preset.ts
 * appends after everything only because an extension cannot reach this layer. A
 * profile can.
 *
 * Empty segments are omitted rather than emitted blank, so the prompt does not
 * accumulate blank paragraphs as fields go unset.
 */
export function composeSystemPrompt(parts: PromptParts): string {
	const skills = parts.skills ? formatSkillsForSystemPrompt([...parts.skills]) : '';
	return [BASE, parts.instructions?.trim(), skills, shellFacts(parts.shell)]
		.filter((segment): segment is string => Boolean(segment))
		.join('\n\n');
}

/**
 * The active profile's instructions, until profiles exist.
 *
 * The fifth interim env var, following `VITE_AGENT_PROVIDER`, `_MODEL`, `_GATE`
 * and `_AUTOCOMPACT`, and it collapses into
 * [ticket 04](docs/wayfinder/pi-harness/tickets/04-profile-data-model.md)'s
 * `instructions` field with the rest of them.
 */
export function readInstructions(): string | undefined {
	return import.meta.env.VITE_AGENT_INSTRUCTIONS || undefined;
}

/**
 * Something that may rewrite the assembled prompt before a turn runs.
 *
 * Receives the running string and returns a new one — pi's extension contract,
 * which is a *rewrite* and not an append, so a contributor may reorder or remove
 * as well as add.
 */
export type PromptContributor = (prompt: string) => string | Promise<string>;

const contributors: PromptContributor[] = [];

/** Register a contributor. Returns its disposer, following `harness.on`. */
export function addPromptContributor(contributor: PromptContributor): () => void {
	contributors.push(contributor);
	return () => {
		const at = contributors.indexOf(contributor);
		if (at >= 0) {
			contributors.splice(at, 1);
		}
	};
}

/**
 * Run the chain, each contributor seeing what the last one produced.
 *
 * **This has to be ours.** pi's `AgentHarness.emitHook` (`agent-harness.js:181`)
 * hands every handler the *same* string and keeps only the last non-undefined
 * result, so a second handler would silently discard the first. pi's own
 * coding-agent does not rely on that either — `core/extensions/runner.ts:1080`
 * threads `currentSystemPrompt` through its extensions by hand. This is that,
 * minus the extension loader.
 */
export async function applyContributors(
	prompt: string,
	chain: readonly PromptContributor[] = contributors
): Promise<string> {
	let current = prompt;
	for (const contributor of chain) {
		current = await contributor(current);
	}
	return current;
}
