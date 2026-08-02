// SPIKE — delete with `rm -r src/spike`.
//
// A real pi harness behind the existing `AgentProvider` seam, so the whole
// chat UI drives it unchanged. What this is trying to prove is listed in
// docs/wayfinder/pi-harness/tickets/12-walking-skeleton.md.
//
// The credential path is ticket 06's design: Rust makes the HTTPS call and the
// API key never enters JavaScript. An earlier run used a Vite proxy instead, to
// prove the agent loop without the credential as a second variable; that served
// its purpose and is gone.
//
// Local models were meant to be the keyless first run. They could not do it —
// every one on this machine emits tool calls as prose rather than structured
// calls, so the loop never started. See the ticket.

import {
	AgentHarness,
	InMemorySessionStorage,
	Session,
	createReadTool,
	type AgentHarnessEvent,
	type ExecutionEnv,
} from '@earendil-works/pi-agent-core';
import { createModels, createProvider, type Model, type ProviderStreams } from '@earendil-works/pi-ai';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import { rustFetch } from './rustFetch';
import type { AgentEvent, AgentProvider } from '../agent';
import { createSpikeEnv } from './env';
import { mapEvent, type PiEvent } from './events';
import type { WorkspaceProvider } from '../workspace';

export interface SpikeConfig {
	/**
	 * The provider's real base URL — `https://api.deepseek.com`. Requests go out
	 * from Rust, so there is no proxy in the path and no browser origin on the
	 * request. Must still be absolute: pi streams through the official `openai`
	 * SDK, which will not accept a relative `baseURL`.
	 */
	readonly baseUrl: string;
	readonly modelId: string;
}

/*
 * The provider id is "deepseek" on purpose. `detectCompat` in pi-ai keys off
 * `provider === "deepseek"` before it looks at the URL, so naming it correctly
 * applies DeepSeek's compatibility quirks. Calling it "spike" would silently
 * select generic OpenAI behaviour.
 */
const PROVIDER_ID = 'deepseek';

/**
 * pi's `StreamOptions` accepts a custom `fetch`, but `AgentHarnessStreamOptions`
 * does not forward one — so the harness cannot inject it and this is the layer
 * that can. Wrapping `ProviderStreams` is the whole integration: pi is
 * unmodified, and every request the provider makes goes through Rust.
 */
function throughRust(inner: ProviderStreams): ProviderStreams {
	return {
		stream: (model, context, options) =>
			inner.stream(model, context, { ...options, fetch: rustFetch }),
		streamSimple: (model, context, options) =>
			inner.streamSimple(model, context, { ...options, fetch: rustFetch }),
	};
}

/**
 * Is the spike configured? Absent config is the normal case — the scripted
 * provider stays the default, so a checkout with no local model still runs.
 */
export function readSpikeConfig(): SpikeConfig | undefined {
	const baseUrl = import.meta.env.VITE_SPIKE_BASE_URL;
	const modelId = import.meta.env.VITE_SPIKE_MODEL;
	return baseUrl && modelId ? { baseUrl, modelId } : undefined;
}

function createSpikeModel(config: SpikeConfig): Model<'openai-completions'> {
	return {
		id: config.modelId,
		name: config.modelId,
		api: 'openai-completions',
		provider: PROVIDER_ID,
		baseUrl: config.baseUrl,
		reasoning: false,
		input: ['text'],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 32_000,
		maxTokens: 4_096,
	};
}

function createSpikeModels(config: SpikeConfig) {
	const models = createModels();
	models.setProvider(
		createProvider({
			id: PROVIDER_ID,
			name: 'DeepSeek (key held in Rust)',
			baseUrl: config.baseUrl,
			// The renderer holds no key. But `auth` is required, and `resolve()`
			// returning undefined means "unconfigured", which makes every model
			// unavailable — so it has to resolve to something.
			auth: {
				apiKey: {
					name: 'DeepSeek (key held in Rust)',
					// The placeholder is load-bearing, not laziness:
					// `getClientApiKey` throws outright unless it sees a key or
					// an authorization header. This value never leaves the
					// renderer — `provider_stream` discards any Authorization
					// header it is handed and attaches the real key itself.
					resolve: async () => ({
						auth: { apiKey: 'held-in-rust' },
						source: 'Rust proxy',
					}),
				},
			},
			models: [createSpikeModel(config)],
			api: throughRust(openAICompletionsApi()),
		})
	);
	return models;
}

/**
 * Adapt the eleven-kind contract down to the five kinds the shipped chat UI
 * understands.
 *
 * This exists so the spike stays deletable in one command: the alternative is
 * editing `agent.ts` and `transcript.ts` for code that is meant to be thrown
 * away. The loss is real and worth naming — `thinking` renders as ordinary
 * prose, and `usage` and `compacted` are dropped — but the contract itself is
 * still exercised in full, because `mapEvent` runs before this does.
 */
/** The text pi put in a tool result, which is what the model was told. */
function describeResult(result: unknown): string {
	const content = (result as { content?: { type: string; text?: string }[] })?.content;
	const text = content
		?.filter((part) => part.type === 'text')
		.map((part) => part.text)
		.join('\n')
		.trim();
	return text || JSON.stringify(result);
}

function toChatEvents(event: PiEvent): AgentEvent[] {
	switch (event.kind) {
		case 'text':
		case 'thinking':
			return [{ kind: 'text', text: event.text }];
		case 'tool_start':
			return [{ kind: 'activity', label: event.name, detail: JSON.stringify(event.input) }];
		case 'tool_end':
			// `result` is an AgentToolResult, so `String(...)` yields
			// "[object Object]" and throws the diagnostic away — which is
			// exactly what happened the first time a tool failed here.
			return event.isError
				? [{ kind: 'activity', label: 'Tool failed', detail: describeResult(event.result) }]
				: [];
		case 'error':
			return [{ kind: 'text', text: `\n\n[error] ${event.message}\n` }];
		case 'complete':
			return [{ kind: 'complete' }];
		case 'cancelled':
			return [{ kind: 'cancelled' }];
		default:
			return [];
	}
}

export function createPiAgentProvider(
	workspace: WorkspaceProvider,
	config: SpikeConfig
): AgentProvider {
	const env: ExecutionEnv = createSpikeEnv(workspace);

	return {
		start(prompt, onEvent) {
			const harness = new AgentHarness<{ env: ExecutionEnv }>({
				session: new Session(new InMemorySessionStorage()),
				models: createSpikeModels(config),
				model: createSpikeModel(config),
				tools: [createReadTool()],
				toolContext: { env },
				systemPrompt:
					'You are a coding assistant inside an editor. Use the `read` tool to look at ' +
					'files before answering questions about them. Paths are relative to the ' +
					'workspace root.',
			});

			harness.subscribe((event: AgentHarnessEvent) => {
				for (const mapped of mapEvent(event)) {
					for (const chatEvent of toChatEvents(mapped)) {
						onEvent(chatEvent);
					}
				}
			});

			// `prompt()` rejects on harness failures that never reach the event
			// stream — auth, for one, which is precisely what run two is
			// testing. Swallowing it would make a failed run look like an empty
			// one.
			harness.prompt(prompt).catch((cause: unknown) => {
				onEvent({
					kind: 'text',
					text: `\n\n[error] ${cause instanceof Error ? cause.message : String(cause)}\n`,
				});
				onEvent({ kind: 'complete' });
			});

			return {
				cancel: () => void harness.abort(),
				// The spike registers no permission gate, so no approval is
				// ever asked and this is unreachable. Left as a no-op rather
				// than a throw: the UI may still call it on a stale click.
				resolveApproval: () => {},
			};
		},
	};
}
