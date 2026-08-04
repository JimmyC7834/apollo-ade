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
	JsonlSessionRepo,
	Session,
	createBashTool,
	createEditTool,
	createReadTool,
	createWriteTool,
	type AgentHarnessEvent,
	type ExecutionEnv,
} from '@earendil-works/pi-agent-core';
import { createModels, createProvider, type Api, type Model } from '@earendil-works/pi-ai';
import { anthropicMessagesApi } from '@earendil-works/pi-ai/api/anthropic-messages.lazy';
import { googleGenerativeAIApi } from '@earendil-works/pi-ai/api/google-generative-ai.lazy';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import type { AgentEvent, AgentProvider } from './index';
import {
	compactionMessage,
	FALLBACK_CONTEXT_WINDOW,
	needsCompaction,
	readAutoCompact,
	readContextWindow,
} from './compaction';
import { createMemoryEnv, createTauriEnv } from './env';
import { mapEvent } from './events';
import { installRustFetch } from './rustFetch';
import { cannedProvider, FIXTURE_FILES } from './canned';
import { createGate, readGatePolicy, type GatePolicy } from './gate';

/**
 * The system prompt, once the shell is known.
 *
 * Which shell the `bash` tool got **varies by machine** — Git Bash where it is
 * installed, PowerShell where it is not — so a model told nothing writes POSIX
 * at a PowerShell and finds out one failed command at a time. Ticket 02 called
 * this out as a consequence of detecting rather than mandating a shell, and
 * saying it costs a sentence.
 */
function systemPrompt(shell: string | undefined): string {
	const base =
		'You are a coding assistant inside an editor. Use the `read` tool to look at files ' +
		'before answering questions about them, and `write` or `edit` to change them. Paths ' +
		'are relative to the workspace root. If a file is missing, say so rather than ' +
		'guessing at its contents. Never guess at what a file contains before editing it — ' +
		'read it first.';
	if (!shell) {
		return `${base} There is no shell available, so the \`bash\` tool will always fail.`;
	}
	return shell === 'bash'
		? `${base} The \`bash\` tool runs commands in bash, from the workspace root.`
		: `${base} The \`bash\` tool runs commands in **PowerShell**, not bash, from the ` +
				'workspace root. Write PowerShell syntax: no `&&`, no `|| true`, no `$(...)`, ' +
				'and use `Get-ChildItem` rather than `ls -la`.';
}

/** Which shell Rust resolved, or undefined outside the native shell. */
async function resolveShell(): Promise<string | undefined> {
	try {
		const { invoke } = await import('@tauri-apps/api/core');
		return (await invoke<string | null>('agent_shell')) ?? undefined;
	} catch {
		return undefined;
	}
}

/**
 * Snapshot the working tree before the turn.
 *
 * Best-effort by design: no repository, no commits, or a clean tree all mean
 * there is nothing to save, and none of them is a reason to refuse to run. The
 * checkpoint is a safety net, not a precondition — failing the turn because the
 * net could not be hung would be worse than running without it.
 */
async function checkpoint(prompt: string): Promise<void> {
	try {
		const { invoke } = await import('@tauri-apps/api/core');
		await invoke('git_checkpoint', { label: `agent: ${prompt.slice(0, 60)}` });
	} catch {
		// Not a git repository, or git is not installed.
	}
}

/**
 * Where the transcript lives.
 *
 * Inside the workspace, as [ticket 09](docs/wayfinder/pi-harness/tickets/09-session-store.md)
 * settled — which means no containment exemption is needed, because the agent's
 * own root already covers it.
 */
const SESSIONS_ROOT = '/.ade/sessions';

let sessionOnce: Promise<Session> | undefined;

/**
 * One session per window, however many times the provider is built.
 *
 * React's StrictMode double-invokes `useMemo` in development, so
 * `createAgentProvider` runs twice — and both runs found no stored session and
 * both created one, leaving an empty orphan on disk at every start. Caching the
 * *promise* rather than the session is what makes the second caller wait for
 * the first rather than race it.
 *
 * This does not make concurrent writers safe in general: two windows on the
 * same workspace are two module instances, and both would open the newest
 * session and append to the same file. Nothing here prevents that, and nothing
 * needs to until sessions are something the user can pick.
 */
function sharedSession(env: ExecutionEnv): Promise<Session> {
	return (sessionOnce ??= openSession(env));
}

/**
 * The session to continue, or a new one.
 *
 * "Most recent for this workspace" is the whole selection policy, and it is a
 * placeholder for a session picker rather than a design: `repo.list()` sorts
 * newest first and `fork()` is right there, so the UI is what is missing, not
 * the capability.
 *
 * Failing to open a stored session must not cost you the agent. A corrupt or
 * half-written JSONL file falls back to a fresh session — losing history is
 * bad, but refusing to run at all is worse, and the broken file is left on disk
 * rather than deleted.
 */
async function openSession(env: ExecutionEnv): Promise<Session> {
	const repo = new JsonlSessionRepo({ fs: env, sessionsRoot: SESSIONS_ROOT });

	/*
	 * A self-ignoring directory, so the transcript never reaches the user's
	 * commits and their `.gitignore` is never edited by us. `git` reads a
	 * `.gitignore` at any level, and `*` there covers everything beneath it.
	 */
	await env.createDir('/.ade');
	await env.writeFile('/.ade/.gitignore', '*\n');

	try {
		const existing = await repo.list({ cwd: '/' });
		if (existing[0]) {
			return await repo.open(existing[0]);
		}
	} catch {
		// Fall through to a new session.
	}
	return repo.create({ cwd: '/' });
}

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
		/*
		 * A heuristic on the model id, and knowingly a poor one — it happens to
		 * be right for `deepseek-reasoner` and will be wrong for the next
		 * reasoning model that is not named after one.
		 *
		 * The honest answer is a model catalog, and pi ships one; the map
		 * recorded that pi's is already stale enough for a new key to be unable
		 * to call what it advertises, so adopting it is its own piece of work.
		 * Until then this is wrong in a visible way rather than absent: the
		 * adapter reads `reasoning_content` off the stream regardless, so a
		 * mislabelled model still *shows* its reasoning — what this flag
		 * controls is whether that reasoning is echoed back on later turns.
		 */
		reasoning: /reason|think/i.test(choice.modelId),
		input: ['text'],
		// Zeroed rather than guessed. A wrong cost table produces confident
		// wrong numbers in the UI, which is worse than none — and the real
		// figures belong with the catalog work, not here.
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		// pi needs a number here — it clamps `maxTokens` against it — so the
		// guess survives where the type demands one. Nothing that decides *when
		// to compact* reads this field; that reads `readContextWindow()`, which
		// is allowed to answer "unknown". See ticket 16.
		contextWindow: readContextWindow() ?? FALLBACK_CONTEXT_WINDOW,
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

/**
 * One harness for the whole conversation.
 *
 * It used to be one harness *per turn*, which meant a new `Session` per turn and
 * therefore no memory of the last one: a follow-up like "now do the same to the
 * other file" had nothing to refer to. It also made `compacted` unreachable
 * rather than merely untested — there was never any history to compact.
 *
 * What is per-turn is the *subscription*, because each turn has its own
 * `onEvent` to deliver into. Both registrations are disposed when the turn
 * settles; leaking one would deliver a later turn's events into a dead
 * transcript.
 */
function createRunner(
	env: ExecutionEnv,
	session: Promise<Session>,
	models: ReturnType<typeof createModels>,
	model: Model<Api>,
	policy: GatePolicy
) {
	/*
	 * Opening the session is I/O, so the harness cannot exist until it lands.
	 * Built once and awaited by every turn rather than per turn — `start` stays
	 * synchronous for the UI's sake, and the first prompt absorbs whatever the
	 * open costs.
	 */
	const ready = Promise.all([session, resolveShell()]).then(
		([opened, shell]) =>
			new AgentHarness<{ env: ExecutionEnv }>({
				session: opened,
				models,
				model,
				/*
				 * `model.reasoning: true` is not enough to get reasoning out of a
				 * model, and the failure is silent. pi's harness defaults
				 * `thinkingLevel` to "off", and for DeepSeek that makes its adapter
				 * send `thinking: { type: "disabled" }` — the API then returns no
				 * `reasoning_content` at all, so no `thinking_delta` is ever emitted
				 * and the transcript looks exactly like a non-reasoning model.
				 *
				 * The level is not exposed yet; it belongs to profiles alongside the
				 * model. "medium" until then, and only for a model that can use it —
				 * asking a non-reasoning model to think is a request some providers
				 * reject outright.
				 */
				thinkingLevel: model.reasoning ? 'medium' : 'off',
				// `createBashTool` is pi's, not ours: it owns capture, truncation,
				// throttled progress and overflow on top of `env.exec`, so Rust only
				// has to run a command and stream chunks.
				tools: [createReadTool(), createWriteTool(), createEditTool(), createBashTool()],
				toolContext: { env },
				/*
				 * A callback, never a string — the decision
				 * [ticket 04](docs/wayfinder/pi-harness/tickets/04-profile-data-model.md)
				 * reached and the walking skeleton, which predates it, did not
				 * honour. There is no `setSystemPrompt`; `createTurnState()` awaits
				 * this once per turn, so a callback reading live state is the *only*
				 * way a profile's `instructions` can ever reach the model.
				 *
				 * It composes nothing yet and returns the same text every turn. That
				 * is the point: what it composes, and in what order, is
				 * [ticket 17](docs/wayfinder/pi-harness/tickets/17-system-prompt-assembly.md),
				 * deferred. Passing a string would have decided it by foreclosure.
				 */
				systemPrompt: () => systemPrompt(shell),
			})
	);

	const contextWindow = readContextWindow();
	const autoCompact = readAutoCompact();

	/*
	 * One harness, one thing at a time.
	 *
	 * `prompt()` and `compact()` both throw `AgentHarnessError("busy")` unless
	 * the harness is idle, and there are now two ways for the user to reach it
	 * — sending, and `/compact`. Serialising here is four lines and removes the
	 * whole class: the alternative is a `busy` error surfacing as a failed turn
	 * whenever someone types while a compaction is running, which they cannot
	 * see and cannot stop.
	 */
	let queue: Promise<unknown> = Promise.resolve();
	function enqueue<T>(work: () => Promise<T>): Promise<T> {
		const next = queue.then(work, work);
		queue = next.catch(() => undefined);
		return next;
	}

	/**
	 * Compact, reporting failure as an event rather than throwing.
	 *
	 * `AgentHarness.compact()` throws for three different reasons — a busy
	 * harness, nothing to compact, and a failed summary — and only the last is
	 * unexpected. A caller that let any of them escape would turn "your
	 * conversation is short" into an unhandled rejection.
	 *
	 * The `compacted` event is not emitted here. It arrives through whichever
	 * subscription is live, mapped from pi's `session_compact`, which is what
	 * keeps the marker landing in the right turn.
	 */
	async function compactWith(
		harness: AgentHarness<{ env: ExecutionEnv }>,
		onEvent: (event: AgentEvent) => void
	) {
		try {
			await harness.compact();
		} catch (cause: unknown) {
			onEvent({ kind: 'error', message: compactionMessage(cause) });
		}
	}

	function start(prompt: string, onEvent: (event: AgentEvent) => void) {
		const gate = createGate(policy, onEvent);

		let released = false;
		let stopped = false;
		let running: AgentHarness<{ env: ExecutionEnv }> | undefined;
		let dispose: (() => void) | undefined;

		// The turn's latest context reading, and whether its `complete` is being
		// withheld while an automatic compaction finishes. Withholding is what
		// keeps the composer disabled across the compaction: releasing the turn
		// first would let the user send a prompt into a harness that is about to
		// throw `busy`, and would deliver the `compacted` marker into a turn the
		// UI had already finished with.
		let contextTokens = 0;
		let heldComplete = false;

		function release() {
			if (released) {
				return;
			}
			released = true;
			dispose?.();
		}

		function attach(harness: AgentHarness<{ env: ExecutionEnv }>) {
			const offHook = harness.on('tool_call', (event) => gate.onToolCall(event));
			const offEvents = harness.subscribe((event: AgentHarnessEvent) => {
				for (const mapped of mapEvent(event, contextWindow)) {
					if (mapped.kind === 'usage') {
						contextTokens = mapped.contextTokens;
					}
					/*
					 * The one moment compaction can run: the turn is over, so the
					 * harness is idle, and the usage just reported is real rather
					 * than estimated. `complete` is held back until it is done —
					 * see `heldComplete` above.
					 */
					if (
						mapped.kind === 'complete' &&
						autoCompact &&
						needsCompaction(contextTokens, contextWindow)
					) {
						heldComplete = true;
						continue;
					}
					onEvent(mapped);
					if (mapped.kind === 'complete' || mapped.kind === 'cancelled') {
						// Deferred: disposing a listener from inside the dispatch pi is
						// currently walking is the kind of thing that works until it
						// does not.
						queueMicrotask(release);
					}
				}
			});
			dispose = () => {
				offHook();
				offEvents();
			};
		}

		// `prompt()` rejects on failures that never reach the event stream — auth is
		// the common one, and opening the session is now another. Swallowing either
		// would make a failed run look like an empty one, which is indistinguishable
		// from the model having nothing to say.
		void ready
			.then((harness) =>
				enqueue(async () => {
					// Stopped while the session was still opening, or while an
					// earlier operation held the queue. Attaching now would
					// register listeners nothing will ever release.
					if (stopped) {
						return;
					}
					running = harness;
					attach(harness);
					await checkpoint(prompt);
					await harness.prompt(prompt);
					// Deliberately after `prompt()` resolves rather than inside the
					// event handler: `compact()` refuses a harness that is not idle,
					// and `message_end` fires while the agent loop is still running.
					//
					// Re-checking `stopped` matters: Stop cannot interrupt a
					// compaction, but it can arrive during one, and a turn that
					// reported `cancelled` must not then report `complete`.
					if (heldComplete) {
						await compactWith(harness, onEvent);
						if (!stopped) {
							onEvent({ kind: 'complete' });
						}
					}
				})
			)
			.catch((cause: unknown) => {
				onEvent({
					kind: 'error',
					message: cause instanceof Error ? cause.message : String(cause),
				});
				onEvent({ kind: 'complete' });
			})
			// Belt and braces: `release` normally runs off the terminal event, but a
			// turn that settles without emitting one would otherwise leak both
			// registrations into the next turn.
			.finally(release);

		return {
			/**
			 * Stop now, rather than when the network agrees.
			 *
			 * `cancelled` is synthesised here instead of waiting for pi's `abort`
			 * event, for two reasons found by testing rather than by reading.
			 *
			 * **Order.** `AgentHarness.abort()` emits `abort` *after* awaiting
			 * `waitForIdle()`, so the unwinding run's `agent_end` — mapped to
			 * `complete` — arrives first and the turn is already released by the
			 * time `abort` lands. Releasing on `abort` instead would invert the
			 * problem for every normal turn.
			 *
			 * **Content.** That unwinding also emits a `message_end` whose usage is
			 * all zeros, so waiting for pi renders a stopped turn as prose cut
			 * mid-word followed by "0 in · 0 out · 0 context" and no
			 * acknowledgement that anything was stopped.
			 */
			cancel: () => {
				if (released) {
					return;
				}
				stopped = true;
				// Abandon first. Aborting while the gate still holds a promise would
				// leave the hook awaiting an answer that can no longer arrive, and
				// the turn would never settle.
				gate.abandon();
				onEvent({ kind: 'cancelled' });
				release();
				void running?.abort();
			},
			resolveApproval: (approved: boolean) => gate.resolve(approved),
		};
	}

	/**
	 * `/compact`, typed by the user.
	 *
	 * Its own subscription, because there is no turn running to borrow one from
	 * — and its own `complete`, because the UI ends a run on that event and
	 * nothing else will send one.
	 */
	function compact(onEvent: (event: AgentEvent) => void) {
		void ready
			.then((harness) =>
				enqueue(async () => {
					const off = harness.subscribe((event: AgentHarnessEvent) => {
						for (const mapped of mapEvent(event, contextWindow)) {
							onEvent(mapped);
						}
					});
					try {
						await compactWith(harness, onEvent);
					} finally {
						off();
					}
				})
			)
			.catch((cause: unknown) => {
				onEvent({ kind: 'error', message: compactionMessage(cause) });
			})
			.finally(() => onEvent({ kind: 'complete' }));
	}

	return { start, compact };
}

export function createAgentProvider(): AgentProvider {
	const native = '__TAURI_INTERNALS__' in globalThis;
	const choice = native ? readModelChoice() : undefined;

	if (choice) {
		// Diverts provider hosts to Rust for every adapter, including the Google
		// ones that refuse an injected `fetch`.
		installRustFetch();
		const env = createTauriEnv();
		return createRunner(
			env,
			sharedSession(env),
			modelsFor(choice),
			modelFor(choice),
			readGatePolicy()
		);
	}

	// No model configured, or no native shell: the canned provider. It is the
	// same harness and the same tool, so a bug in the mapping shows up here too.
	// The session stays in memory here — browser mode has no disk to persist to,
	// and inventing one would be the parallel fiction ticket 10 ruled out.
	const canned = cannedProvider();
	const runner = createRunner(
		createMemoryEnv(FIXTURE_FILES),
		Promise.resolve(new Session(new InMemorySessionStorage())),
		canned.models,
		canned.model,
		readGatePolicy()
	);
	return {
		start: (prompt, onEvent) => {
			canned.rearm();
			return runner.start(prompt, onEvent);
		},
		// Not rearmed: compaction asks the model for a summary, and the canned
		// script has no answer for that. It reports "not enough conversation"
		// or the script's own failure, which is the honest browser-mode answer
		// rather than a fake summary the real path would never produce.
		compact: runner.compact,
	};
}
