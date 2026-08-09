// The agent under `npm run dev`: a real harness, a real read tool, a fake model.
//
// pi ships `fauxProvider` for exactly this, so there is no hand-rolled
// `ProviderStreams` here. It streams token by token at a configurable rate, so
// the browser exercises the same incremental-render path the native window does.
//
// The script is two steps because that is the shape of the thing being
// demonstrated: the model asks for a file, the harness runs the tool, and the
// model answers from the result. A one-step script would render prose and prove
// nothing about the loop.

import {
	contentText,
	createModels,
	fauxAssistantMessage,
	fauxProvider,
	fauxText,
	fauxToolCall,
	type Api,
	type Context,
	type FauxResponseStep,
	type Model,
	type MutableModels,
} from '@earendil-works/pi-ai';
import { FIXTURE } from '../workspace';

export { FIXTURE as FIXTURE_FILES };

/** Which fixture file the prompt is asking about, if any. */
function requestedPath(prompt: string): string {
	const lower = prompt.toLowerCase();
	return Object.keys(FIXTURE).find((path) => lower.includes(path.toLowerCase())) ?? 'README.md';
}

function lastUserText(context: Context): string {
	for (let index = context.messages.length - 1; index >= 0; index -= 1) {
		const message = context.messages[index];
		if (message.role === 'user') {
			return contentText(message.content);
		}
	}
	return '';
}

/** The text of the most recent tool result, which is what the model "read". */
function lastToolText(context: Context): string | undefined {
	for (let index = context.messages.length - 1; index >= 0; index -= 1) {
		const message = context.messages[index];
		if (message.role === 'toolResult') {
			return contentText(message.content);
		}
	}
	return undefined;
}

/**
 * The profile the delegating script delegates to.
 *
 * Installed through `installProfiles` like any other definition rather than
 * pushed into the list — same reason browser mode uses the real harness and the
 * real read tool. A fixture that skipped the installer would not prove the
 * installer works, and `delegable()` refusing a description-less profile is
 * exactly the behaviour worth exercising.
 *
 * It exists because **no built-in is delegable and none should be** (see
 * `builtinProfiles`), so without it browser mode would report "no profiles are
 * currently delegable" and the tool could never fire.
 */
export const FIXTURE_PROFILES: readonly unknown[] = [
	{
		name: 'researcher',
		description: 'Reads files and reports what is in them, without changing anything.',
		subagent: true,
		tools: { write: false, edit: false, bash: false },
		instructions: 'Answer from what you read. Do not modify anything.',
	},
];

/** Whether this prompt is asking for the delegation demo rather than the read one. */
function asksToDelegate(prompt: string): boolean {
	return /\b(subagent|delegate|delegation|task tool)\b/i.test(prompt);
}

export interface CannedAgent {
	readonly models: MutableModels;
	readonly model: Model<Api>;
	/**
	 * Reload the script. `fauxProvider` hands its responses out in order and
	 * then runs dry, so without this the second prompt of a session would get
	 * no answer at all — a browser mode that works once is worse than one that
	 * obviously loops.
	 *
	 * Takes the prompt because there are two scripts now and the prompt is what
	 * chooses between them. The steps themselves still read the *context* rather
	 * than this string — the prompt picks the script, the context fills it in.
	 */
	rearm(prompt: string): void;
}

export function cannedProvider(): CannedAgent {
	const faux = fauxProvider({
		provider: 'browser',
		models: [{ id: 'browser-fixture', name: 'Browser fixture' }],
		// Slow enough to look like a stream rather than a paste, fast enough
		// that nobody waits for it.
		tokensPerSecond: 90,
	});

	const script = (): FauxResponseStep[] => [
		(context) =>
			fauxAssistantMessage([
				fauxText('Let me read that file.\n\n'),
				fauxToolCall('read', { path: requestedPath(lastUserText(context)) }),
			]),
		(context) => {
			const read = lastToolText(context);
			return fauxAssistantMessage(
				read
					? `Here is what that file contains:\n\n${read}\n\nThis is browser mode, so the ` +
							'file came from an in-memory fixture rather than disk. Run ' +
							'`npm run tauri dev` with a model configured to talk to a real one.'
					: 'I could not read that file. Browser mode only has the fixture workspace — ' +
							`try one of: ${Object.keys(FIXTURE).join(', ')}.`
			);
		},
	];

	/**
	 * The delegation script: four steps across **two** agents.
	 *
	 * `fauxProvider` hands its responses out in one ordered queue, and the parent
	 * and the child both draw from it. That works — and only works — because a
	 * delegation is strictly sequential: `task.execute` awaits `host.run`, so the
	 * child cannot be asked anything until the parent's call is out, and the
	 * parent cannot continue until the child is done. The order below is that
	 * sequence written down:
	 *
	 *   1. parent calls `task`
	 *   2. child reads a file
	 *   3. child answers from what it read
	 *   4. parent answers from the child's report
	 *
	 * A script that delegated twice, or a model that ran two children in
	 * parallel, would interleave and this would fall apart. That is a real limit
	 * of the fixture rather than of `MAX_CONCURRENT`, and it is why the
	 * concurrency behaviour is checked against a fake host in `subagent.check.ts`
	 * instead of here.
	 */
	const delegation = (): FauxResponseStep[] => [
		(context) =>
			fauxAssistantMessage([
				fauxText('That is self-contained, so I will hand it to a subagent.\n\n'),
				fauxToolCall('task', {
					profile: 'researcher',
					label: 'read the fixture file',
					prompt: `Read ${requestedPath(lastUserText(context))} and say what is in it.`,
				}),
			]),
		(context) =>
			fauxAssistantMessage([
				fauxText('Reading it now.\n\n'),
				fauxToolCall('read', { path: requestedPath(lastUserText(context)) }),
			]),
		(context) => {
			const read = lastToolText(context);
			return fauxAssistantMessage(
				read
					? `The file contains:\n\n${read}`
					: 'I could not read that file — browser mode only has the fixture workspace.'
			);
		},
		(context) =>
			fauxAssistantMessage(
				`The subagent reported back:\n\n${lastToolText(context) ?? '(nothing)'}\n\n` +
					'Its own steps stayed in its own transcript — only the one progress line and ' +
					'this report crossed back. That is the whole point of delegating.'
			),
	];

	const models = createModels();
	models.setProvider(faux.provider);

	return {
		models,
		model: faux.getModel(),
		rearm: (prompt) => faux.setResponses(asksToDelegate(prompt) ? delegation() : script()),
	};
}
