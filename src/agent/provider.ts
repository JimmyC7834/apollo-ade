// Which agent the workbench gets, and how it is assembled.
//
// One harness, two environments. Natively it reads real files through Rust and
// streams from a real model; under `npm run dev` it runs the *same* harness and
// the *same* read tool against an in-memory disk and a canned provider. That is
// `context.md`'s browser-mode rule satisfied by exercising the real mapping
// code rather than by writing a second, drifting fiction.

import {
	AgentHarness,
	InMemorySessionStorage,
	Session,
	createReadTool,
	type AgentHarnessEvent,
	type ExecutionEnv,
} from '@earendil-works/pi-agent-core';
import { createModels, createProvider, type Api, type Model } from '@earendil-works/pi-ai';
import { anthropicMessagesApi } from '@earendil-works/pi-ai/api/anthropic-messages.lazy';
import { googleGenerativeAIApi } from '@earendil-works/pi-ai/api/google-generative-ai.lazy';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import type { AgentEvent, AgentProvider } from './index';
import { createMemoryEnv, createTauriEnv } from './env';
import { mapEvent } from './events';
import { installRustFetch } from './rustFetch';
import { cannedProvider, FIXTURE_FILES } from './canned';

const SYSTEM_PROMPT =
	'You are a coding assistant inside an editor. Use the `read` tool to look at files ' +
	'before answering questions about them. Paths are relative to the workspace root. ' +
	'If a file is missing, say so rather than guessing at its contents.';

/*
 * The three API shapes pi bundles. Keyed by pi's real provider id, not a label
 * of ours: `detectCompat` in pi-ai keys off `provider === "deepseek"` before it
 * looks at the URL, and Rust reads the same id to choose which credential to
 * attach. An invented id would silently select generic OpenAI behaviour.
 */
const SHAPES = {
	deepseek: { api: 'openai-completions', baseUrl: 'https://api.deepseek.com' },
	anthropic: { api: 'anthropic-messages', baseUrl: 'https://api.anthropic.com/v1' },
	google: {
		api: 'google-generative-ai',
		baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
	},
} as const;

type ProviderId = keyof typeof SHAPES;

interface ModelChoice {
	readonly provider: ProviderId;
	readonly modelId: string;
}

/**
 * Which model to run.
 *
 * Configuration, not a profile — [the profile data model](docs/wayfinder/pi-harness/tickets/04-profile-data-model.md)
 * owns that and is a later slice. This is the smallest thing that lets the app
 * talk to a model at all, and it is deliberately not built out: two env vars,
 * no UI, no persistence.
 */
function readModelChoice(): ModelChoice | undefined {
	const provider = (import.meta.env.VITE_AGENT_PROVIDER ?? 'deepseek') as ProviderId;
	const modelId = import.meta.env.VITE_AGENT_MODEL;
	return modelId && provider in SHAPES ? { provider, modelId } : undefined;
}

function apiFor(provider: ProviderId) {
	if (provider === 'anthropic') return anthropicMessagesApi();
	if (provider === 'google') return googleGenerativeAIApi();
	return openAICompletionsApi();
}

function modelFor(choice: ModelChoice): Model<Api> {
	return {
		id: choice.modelId,
		name: choice.modelId,
		api: SHAPES[choice.provider].api,
		provider: choice.provider,
		baseUrl: SHAPES[choice.provider].baseUrl,
		reasoning: false,
		input: ['text'],
		// Zeroed rather than guessed. A wrong cost table produces confident
		// wrong numbers in the UI, which is worse than none — and the real
		// figures belong with the catalog work, not here.
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 8_192,
	};
}

function modelsFor(choice: ModelChoice) {
	const models = createModels();
	models.setProvider(
		createProvider({
			id: choice.provider,
			name: choice.provider,
			baseUrl: SHAPES[choice.provider].baseUrl,
			auth: {
				apiKey: {
					name: `${choice.provider} (key held in Rust)`,
					// The placeholder is load-bearing. pi's OpenAI adapter throws
					// outright unless it sees a key or an authorization header,
					// and Google's requires one too. The value never travels:
					// `provider_stream` discards whatever auth header it is
					// handed and attaches the real key itself.
					resolve: async () => ({ auth: { apiKey: 'held-in-rust' }, source: 'Rust' }),
				},
			},
			models: [modelFor(choice)],
			api: apiFor(choice.provider),
		})
	);
	return models;
}

/** One harness, one turn. Everything above this is which pieces it is given. */
function runHarness(
	env: ExecutionEnv,
	models: ReturnType<typeof createModels>,
	model: Model<Api>,
	prompt: string,
	onEvent: (event: AgentEvent) => void
) {
	const harness = new AgentHarness<{ env: ExecutionEnv }>({
		session: new Session(new InMemorySessionStorage()),
		models,
		model,
		tools: [createReadTool()],
		toolContext: { env },
		systemPrompt: SYSTEM_PROMPT,
	});

	harness.subscribe((event: AgentHarnessEvent) => {
		for (const mapped of mapEvent(event)) {
			onEvent(mapped);
		}
	});

	// `prompt()` rejects on failures that never reach the event stream — auth is
	// the common one. Swallowing it would make a failed run look like an empty
	// one, which is indistinguishable from the model having nothing to say.
	harness.prompt(prompt).catch((cause: unknown) => {
		onEvent({
			kind: 'error',
			message: cause instanceof Error ? cause.message : String(cause),
		});
		onEvent({ kind: 'complete' });
	});

	return {
		cancel: () => void harness.abort(),
		// No permission gate is registered yet, so no approval is ever asked.
		// A no-op rather than a throw: the UI may still call this on a stale
		// click. It becomes real in the gate slice.
		resolveApproval: () => {},
	};
}

export function createAgentProvider(): AgentProvider {
	const native = '__TAURI_INTERNALS__' in globalThis;
	const choice = native ? readModelChoice() : undefined;

	if (choice) {
		// Diverts provider hosts to Rust for every adapter, including the Google
		// ones that refuse an injected `fetch`.
		installRustFetch();
		const env = createTauriEnv();
		const models = modelsFor(choice);
		const model = modelFor(choice);
		return { start: (prompt, onEvent) => runHarness(env, models, model, prompt, onEvent) };
	}

	// No model configured, or no native shell: the canned provider. It is the
	// same harness and the same tool, so a bug in the mapping shows up here too.
	const env = createMemoryEnv(FIXTURE_FILES);
	const canned = cannedProvider();
	return {
		start: (prompt, onEvent) => {
			canned.rearm();
			return runHarness(env, canned.models, canned.model, prompt, onEvent);
		},
	};
}
