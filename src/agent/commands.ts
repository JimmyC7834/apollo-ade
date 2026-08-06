// The slash commands the composer knows, as data.
//
// They used to be a chain of `startsWith` inside `AgentChat.send`, which worked
// while `send` was the only thing that needed to know them. Three consumers now
// want the list: `send` itself, `/steer` (ticket 22), and completion (ticket 21,
// deferred). A fourth is coming from disk — pi's prompt templates are commands
// the *user* writes — which is why the list is a value that can be extended
// rather than a chain that has to be edited.
//
// It is not in `src/commands/commandRegistry.ts`. That registry is the
// workbench palette: entries there have a `run`, appear in a fuzzy-searched
// list, and belong to the window. These are typed where the prompt is, take
// arguments, and mean nothing outside the agent — a shared registry would have
// to grow a "which surface" field on every entry to keep them apart.
//
// What is deliberately *not* here is what each command does. The bodies stay in
// `send`, because each one closes over the provider, the transcript sink and the
// announcer, and moving them here would drag the whole component's state across
// the seam to save a switch.

/** Where a command's argument is completed from. Read by ticket 21; the list
 * carries it now so the table is not rebuilt when completion lands. */
export type ArgumentSource = 'skill' | 'profile' | 'text';

export interface SlashCommand {
	/** Including the slash, because that is how it is typed and matched. */
	readonly name: string;
	readonly summary: string;
	/** Absent when the command takes no argument. */
	readonly argument?: ArgumentSource;
	/**
	 * Whether the command means anything while a turn is running.
	 *
	 * Read in both directions, and it is the composer's only rule about when a
	 * command is allowed: `false` is refused mid-turn rather than queued as prose,
	 * and `true` is refused while idle rather than sent to the model as a prompt.
	 */
	readonly whileRunning?: boolean;
}

export const SLASH_COMMANDS: readonly SlashCommand[] = [
	{ name: '/compact', summary: 'Summarise the conversation now.' },
	{ name: '/reload', summary: 'Re-read profiles, tools and skills from disk.' },
	{ name: '/skills', summary: 'List every skill, and say why one is missing.' },
	{ name: '/skill', summary: 'Run a skill.', argument: 'skill' },
	{ name: '/profile', summary: 'Switch profile, or list them.', argument: 'profile' },
	{
		name: '/steer',
		summary: 'Change what the running turn is doing.',
		argument: 'text',
		whileRunning: true,
	},
];

/**
 * The command the text names, and whatever follows it.
 *
 * `commands` defaults to the built-ins and is passed in whole by the composer,
 * which appends the user's own prompt templates — commands that come from disk
 * and cannot be in a list compiled into the app. Built-ins come first in that
 * array, which is the whole of the name-clash rule: the first match wins.
 *
 * Exact name or name-plus-space, which is what keeps `/skills` from being read
 * as `/skill` with the argument `s` — the space is required, so no name can
 * shadow a longer one and the list needs no ordering rule.
 *
 * `args` is the raw remainder, not a word list. Splitting is the caller's, and
 * it differs: `/skill` takes a name and then free text, where a prompt template
 * will want pi's `parseCommandArgs` for shell quoting.
 */
export function parseCommand(
	text: string,
	commands: readonly SlashCommand[] = SLASH_COMMANDS
): { command: SlashCommand; args: string } | undefined {
	const trimmed = text.trim();
	for (const command of commands) {
		if (trimmed === command.name) {
			return { command, args: '' };
		}
		if (trimmed.startsWith(`${command.name} `)) {
			return { command, args: trimmed.slice(command.name.length).trim() };
		}
	}
	return undefined;
}
