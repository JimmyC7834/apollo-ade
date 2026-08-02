// SPIKE — delete with `rm -r src/spike`.
//
// A real pi harness behind the existing `AgentProvider` seam, so the whole
// chat UI drives it unchanged. What this is trying to prove is listed in
// docs/wayfinder/pi-harness/tickets/12-walking-skeleton.md.
//
// The plan was local-then-DeepSeek so the key would be the only variable that
// changed. That fell through: every local model on this machine emits tool
// calls as prose rather than structured calls, so the loop could not be
// exercised at all. DeepSeek is now the only run, and the credential is held
// out of the picture a different way — a dev-server proxy attaches it in Node.
// Ticket 06's real question, streamed bytes crossing the Tauri IPC, is
// therefore still unanswered and is its own next piece of work.

import {
	AgentHarness,
	InMemorySessionStorage,
	Session,
	createReadTool,
	type AgentHarnessEvent,
	type ExecutionEnv,
} from '@earendil-works/pi-agent-core';
import { createModels, createProvider, type Model } from '@earendil-works/pi-ai';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import type { AgentEvent, AgentProvider } from '../agent';
import { createSpikeEnv } from './env';
import { mapEvent, type PiEvent } from './events';
import type { WorkspaceProvider } from '../workspace';

export interface SpikeConfig {
	/**
	 * Must be absolute: pi streams through the official `openai` SDK, which
	 * will not accept a relative `baseURL`. For DeepSeek this points at the
	 * dev-server proxy (`http://localhost:5190/spike-deepseek`), which attaches
	 * the key in Node — see the `proxy` block in `vite.config.ts`.
	 */
	readonly baseUrl: string;
	readonly modelId: string;
}

/*
 * The provider id is "deepseek" on purpose, even though requests go to
 * localhost. `detectCompat` in pi-ai keys off `provider === "deepseek"` before
 * it looks at the URL, so naming it correctly gets DeepSeek's compatibility
 * quirks applied while the traffic still goes through the proxy. Calling it
 * "spike" would silently select generic OpenAI behaviour.
 */
const PROVIDER_ID = 'deepseek';

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
			name: 'DeepSeek (through the dev-server proxy)',
			baseUrl: config.baseUrl,
			// The browser holds no key — the proxy attaches it. But `auth` is
			// required, and `resolve()` returning undefined means
			// "unconfigured", which makes every model unavailable. So it
			// resolves to empty auth. When the credential moves into Rust this
			// is the one function that changes.
			auth: {
				apiKey: {
					name: 'Spike (key attached by the dev-server proxy)',
					// The placeholder is load-bearing, not laziness:
					// `getClientApiKey` throws outright unless it sees a key or
					// an authorization header. The value never travels — the
					// proxy overwrites the Authorization header with the real
					// key before the request leaves Node.
					resolve: async () => ({
						auth: { apiKey: 'attached-by-proxy' },
						source: 'dev-server proxy',
					}),
				},
			},
			models: [createSpikeModel(config)],
			api: openAICompletionsApi(),
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
function toChatEvents(event: PiEvent): AgentEvent[] {
	switch (event.kind) {
		case 'text':
		case 'thinking':
			return [{ kind: 'text', text: event.text }];
		case 'tool_start':
			return [{ kind: 'activity', label: event.name, detail: JSON.stringify(event.input) }];
		case 'tool_end':
			return event.isError
				? [{ kind: 'activity', label: 'Tool failed', detail: String(event.result) }]
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
