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

export interface CannedAgent {
	readonly models: MutableModels;
	readonly model: Model<Api>;
	/**
	 * Reload the script. `fauxProvider` hands its responses out in order and
	 * then runs dry, so without this the second prompt of a session would get
	 * no answer at all — a browser mode that works once is worse than one that
	 * obviously loops.
	 */
	rearm(): void;
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

	const models = createModels();
	models.setProvider(faux.provider);

	return {
		models,
		model: faux.getModel(),
		rearm: () => faux.setResponses(script()),
	};
}
