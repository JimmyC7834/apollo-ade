// What the composer offers while a slash command is being typed — ticket 21.
//
// Separate from `commands.ts` because that file is the list and this is a rule
// about it, and separate from the component because a rule inside a `.tsx`
// cannot be checked. `AgentChat` renders whatever comes back and knows none of
// the reasoning below.
//
// The palette's scorer is reused rather than reimplemented: `/prof` finding
// `/profile` is the same question `tog` finding `Toggle Panel` is, and the
// tie-breaks are already tuned there. Ticket 27's `@` join is the same reuse
// carried one step further — a file mention is that question again over the
// workspace tree, which is the list the palette was already scoring.

import { fuzzyFilter } from '../commands/fuzzy.ts';
import { SLASH_COMMANDS, type ArgumentSource, type SlashCommand } from './commands.ts';

export interface Completion {
	/** The whole composer text this entry leaves behind when accepted. */
	readonly value: string;
	/** The right-hand column: what the command does, or where a name came from. */
	readonly summary: string;
}

/**
 * The lists the argument sources name, plus the workspace's files.
 *
 * `text` is absent on purpose — free text is what nothing completes, and making
 * that a missing key rather than an empty array means a fourth source cannot be
 * added without this type asking for it.
 *
 * `file` is not an `ArgumentSource` and is deliberately outside that record: no
 * command takes a file, and `@` is not a command. Adding `'file'` to
 * `ArgumentSource` would have offered it as an argument to `/skill`.
 */
export type CompletionSources = Readonly<
	Record<Exclude<ArgumentSource, 'text'>, readonly string[]>
> & {
	/** Every file in the workspace, root-relative, for `@`. */
	readonly file: readonly string[];
};

/**
 * The `@`-token the caret is sitting at the end of, or nothing.
 *
 * Anchored to the end of the text because that is where the caret is — the
 * composer does not track a caret position, and the slash menu has always made
 * the same assumption. Editing in the middle of a line will not open the menu,
 * which is a limitation and not a bug: a menu that opened on a `@` three words
 * back would insert its answer in the wrong place.
 *
 * `(^|\s)` is the whole rule about email addresses and decorators: `@` must
 * start a word, so `write to me@example.com` completes nothing.
 */
const MENTION = /(?:^|\s)@(\S*)$/;

/**
 * How many files the menu will offer at once.
 *
 * A bare `@` fuzzy-matches every file in the workspace, and a real repository
 * has thousands. The cap is the same admission `search`'s `MAX_RESULTS` makes:
 * a list longer than this is not being read, it is being scrolled past.
 */
const MAX_FILES = 20;

/**
 * The entries to offer for the text now in the composer.
 *
 * Two positions, and the space between them decides which: the first word is a
 * command name, and the second is its argument. Nothing else completes —
 * everything after the argument is free text bound for the model.
 *
 * `running` filters to the commands that mean anything now, which is the same
 * list `send` refuses by. Offering `/compact` mid-turn and then refusing it is
 * a menu that lies, and the flag is already on every entry.
 */
export function complete(
	text: string,
	sources: CompletionSources,
	running = false,
	// The user's prompt templates arrive here, appended to the built-ins by the
	// composer. Same defaulting as `parseCommand`, and for the same reason: a
	// command from disk cannot be in a list compiled into the app.
	commands: readonly SlashCommand[] = SLASH_COMMANDS
): Completion[] {
	/*
	 * An entry that would change nothing is not an entry.
	 *
	 * It reads like tidiness and it is not: the menu owns Enter while it is open,
	 * so a fully typed `/compact` offering `/compact` costs a second Enter to send
	 * something that was already correct. Dropping the identical entry closes the
	 * menu at exactly the point the user has finished typing.
	 */
	const useful = (entries: Completion[]) => entries.filter((entry) => entry.value !== text);

	/*
	 * `@` — ticket 27, and the one menu that opens mid-sentence.
	 *
	 * **The reference stays a path.** `@src/agent/env.ts` reaches the model as
	 * those characters and nothing more, so the model still spends a `read` call
	 * — but a targeted one, against a path a person chose rather than a path it
	 * guessed. Inlining the contents was the alternative and it was rejected for
	 * now: a 40 KB file would become 40 KB of context nobody visibly asked for,
	 * and this repo already has `strip.ts` devoted to not spending bytes
	 * invisibly. Inlining would need the same treatment — a cap, an announcement
	 * in the transcript, and a number measured on this repo.
	 *
	 * It is also the reversible answer. The completion UI is identical either
	 * way, and a path that no longer exists fails as a normal `read` error the
	 * model can correct — which is ticket 18's rule, and it costs nothing here
	 * because nothing here resolves the path at all.
	 *
	 * Checked before the slash branch, and it has to be: `/steer look at @src/`
	 * is a sentence with a mention in it, and the slash branch would answer `[]`
	 * for it.
	 */
	const mention = MENTION.exec(text);
	if (mention) {
		const typed = mention[1] ?? '';
		const before = text.slice(0, text.length - typed.length);
		return useful(
			fuzzyFilter(typed, sources.file, (path) => path)
				.slice(0, MAX_FILES)
				.map(({ item }) => ({ value: `${before}${item}`, summary: 'file' }))
		);
	}

	// Only a leading slash opens the command menu, and it must be the first
	// character: completing mid-sentence would put a popup over prose that
	// happens to mention one.
	if (!text.startsWith('/')) {
		return [];
	}

	const space = text.indexOf(' ');
	if (space === -1) {
		return useful(
			fuzzyFilter(
				text,
				commands.filter((command) => Boolean(command.whileRunning) === running),
				(command) => command.name
			).map(({ item }) => ({
				// A command that takes an argument leaves the caret past a space, so
				// accepting it opens the second menu rather than ending the interaction.
				value: item.argument ? `${item.name} ` : item.name,
				summary: item.summary,
			}))
		);
	}

	const command = commands.find((entry) => entry.name === text.slice(0, space));
	// `text` arguments included: `/steer` takes a sentence, and no list holds one.
	if (!command?.argument || command.argument === 'text') {
		return [];
	}
	// The same filter as the first word, and it is not redundant: nothing stops a
	// user typing `/skill ` in full while a turn runs, and completing its argument
	// would finish a line `send` then refuses.
	if (Boolean(command.whileRunning) !== running) {
		return [];
	}

	const typed = text.slice(space + 1);
	// Past the argument. `/skill grilling this plan` is a skill and then free
	// text for the model, and the free half is not a name to be completed.
	if (typed.includes(' ')) {
		return [];
	}

	return useful(
		fuzzyFilter(typed, sources[command.argument], (name) => name).map(({ item }) => ({
			value: `${command.name} ${item}`,
			summary: command.argument as string,
		}))
	);
}
