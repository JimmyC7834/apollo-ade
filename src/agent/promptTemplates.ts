// Commands the user writes: a `.md` file whose body becomes the prompt.
//
// The last unbuilt half of the map's *"a command system for the agent chat"*,
// which [ticket 15](../../docs/wayfinder/pi-harness/tickets/15-core-already-does-this.md)
// deleted from the queue as "one `promptFromTemplate` call". This is that call,
// plus the two things pi leaves to the application — **where to look**, and
// **what happens when a template and a built-in share a name**.
//
// Everything else is pi's: `loadPromptTemplates` reads the directory over our
// own `ExecutionEnv` and reports its failures as diagnostics,
// `formatPromptTemplateInvocation` builds the turn, and `substituteArgs` fills
// `$1`, `$@`, `$ARGUMENTS` and `${@:N:L}` from the words the user typed.
//
// **A template is not gated by the profile, and skills are.** That is not an
// oversight: a skill is listed to the *model*, which is why naming it in a
// profile is the trust act (ticket 13). A template is prose that goes in front
// of the model only when the user types its name — the typing is the trust act,
// and a profile field would be a second one for the same decision. What does
// protect it is the write side: `.agents/commands` is refused to the agent in
// `workspace.rs`, on the argument that already covers `.agents/skills`.

import {
	loadPromptTemplates,
	type ExecutionEnv,
	type PromptTemplate,
} from '@earendil-works/pi-agent-core';

import { SLASH_COMMANDS, type SlashCommand } from './commands.ts';

/**
 * The project commands directory.
 *
 * `.agents/commands` for the reason `.agents/skills` is that rather than
 * `.ade/`: it is meant to be committed and read, and `.ade` is gitignored by
 * `*` and skipped by `list_tree`.
 *
 * **Project only, deliberately.** A global directory would need a second Rust
 * mount — `.skills` is one mount, not a general mechanism — and nothing has
 * asked for one. A command written here is shared with whoever clones the
 * project, which is the case that makes templates worth having at all.
 */
export const PROJECT_TEMPLATES = '/.agents/commands';

let source: ExecutionEnv | undefined;
let set: {
	templates: readonly PromptTemplate[];
	warnings: readonly string[];
	/**
	 * The same templates as composer commands, built once per load.
	 *
	 * Built here rather than on demand because the composer reads it through
	 * `useSyncExternalStore`, which requires the same array back until something
	 * actually changes — a fresh array every render is an infinite render.
	 */
	commands: readonly SlashCommand[];
} = {
	templates: [],
	warnings: [],
	commands: [],
};
const listeners = new Set<() => void>();

/** Tell the store which filesystem to read. The provider owns the env. */
export function useTemplateSource(env: ExecutionEnv): void {
	source = env;
}

export function allTemplates(): readonly PromptTemplate[] {
	return set.templates;
}

/** What was ignored, and why. Reported by `/reload`, which is what read them. */
export function templateWarnings(): readonly string[] {
	return set.warnings;
}

export function onTemplatesChange(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

/**
 * A built-in wins a name clash, and the loser is said out loud.
 *
 * Refusing the whole load over one name would punish a file that is otherwise
 * fine, and silently shadowing it would leave a user typing `/compact` into a
 * command they wrote and getting compaction. The built-ins are matched first by
 * `parseCommand`, so this only has to report what that already does.
 */
export function withoutShadowed(templates: readonly PromptTemplate[]): {
	templates: PromptTemplate[];
	warnings: string[];
} {
	const builtin = new Set(SLASH_COMMANDS.map((command) => command.name));
	const warnings: string[] = [];
	const kept: PromptTemplate[] = [];
	for (const template of templates) {
		if (builtin.has(`/${template.name}`)) {
			warnings.push(`/${template.name} is a built-in command, so that template is ignored`);
			continue;
		}
		kept.push(template);
	}
	return { templates: kept, warnings };
}

/**
 * Read the directory and install what it holds.
 *
 * Always resolves. A missing directory is the normal state and is skipped
 * silently; every read or parse failure comes back as a diagnostic.
 */
export async function reloadTemplates(): Promise<void> {
	if (!source) {
		return;
	}
	const loaded = await loadPromptTemplates(source, PROJECT_TEMPLATES);
	const usable = withoutShadowed(loaded.promptTemplates);
	set = {
		templates: usable.templates,
		warnings: [
			...usable.warnings,
			...loaded.diagnostics.map((problem) => `${problem.path}: ${problem.message}`),
		],
		commands: asCommands(usable.templates),
	};
	for (const listener of listeners) {
		listener();
	}
}

/**
 * The templates as composer commands, for the same list the built-ins are in.
 *
 * `argument: 'text'` on every one: the words after the name are what
 * `substituteArgs` fills the placeholders with, and no list can complete them.
 * A template with no `description` still gets a summary, because the completion
 * menu shows one and an empty column reads as a broken entry.
 */
function asCommands(templates: readonly PromptTemplate[]): SlashCommand[] {
	return templates.map((template) => ({
		name: `/${template.name}`,
		summary: template.description ?? 'Your command.',
		argument: 'text',
	}));
}

/** The installed set as commands. The same array until the next load. */
export function templateCommands(): readonly SlashCommand[] {
	return set.commands;
}
