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
	type ThinkingLevel,
} from '@earendil-works/pi-agent-core';
import {
	clampThinkingLevel,
	createModels,
	createProvider,
	type Api,
	type Model,
} from '@earendil-works/pi-ai';
import { anthropicMessagesApi } from '@earendil-works/pi-ai/api/anthropic-messages.lazy';
import { googleGenerativeAIApi } from '@earendil-works/pi-ai/api/google-generative-ai.lazy';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import type { AgentEvent, AgentProvider } from './index';
import {
	compactionMessage,
	contextWindowFor,
	FALLBACK_CONTEXT_WINDOW,
	needsCompaction,
	readAutoCompact,
} from './compaction';
import { createMemoryEnv, createTauriEnv } from './env';
import { mapEvent } from './events';
import { installRustFetch } from './rustFetch';
import { cannedProvider, FIXTURE_FILES } from './canned';
import { createGate } from './gate';
import { applyContributors, composeSystemPrompt } from './systemPrompt';
import {
	activeProfile,
	activeToolNames,
	onProfileChange,
	setCapabilities,
	type ProfileModel,
	type ProviderId,
} from './profile';

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
} as const satisfies Record<ProviderId, { api: Api; baseUrl: string }>;

function apiFor(provider: ProviderId) {
	if (provider === 'anthropic') return anthropicMessagesApi();
	if (provider === 'google') return googleGenerativeAIApi();
	return openAICompletionsApi();
}

function modelFor(choice: ProfileModel): Model<Api> {
	return {
		id: choice.id,
		name: choice.id,
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
		reasoning: /reason|think/i.test(choice.id),
		input: ['text'],
		// Zeroed rather than guessed. A wrong cost table produces confident
		// wrong numbers in the UI, which is worse than none — and the real
		// figures belong with the catalog work, not here.
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		// pi needs a number here — it clamps `maxTokens` against it — so the
		// fallback survives where the type demands one, but it is now the last
		// resort rather than the only answer. Nothing that decides *when to
		// compact* reads this field; that reads `contextWindowFor`, which is
		// allowed to answer "unknown". See ticket 16.
		contextWindow: contextWindowFor(choice.id) ?? FALLBACK_CONTEXT_WINDOW,
		maxTokens: 8_192,
	};
}

function modelsFor(choice: ProfileModel) {
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
	model: Model<Api>
) {
	/*
	 * The tool set the harness is given, which is not the tool set that runs: a
	 * profile's `tools` map picks the active subset out of it. Built once and
	 * declared to the profile store, because the store is what refuses a profile
	 * naming a tool that is not in here.
	 *
	 * `createBashTool` is pi's, not ours: it owns capture, truncation, throttled
	 * progress and overflow on top of `env.exec`, so Rust only has to run a
	 * command and stream chunks.
	 */
	const tools = [createReadTool(), createWriteTool(), createEditTool(), createBashTool()];
	setCapabilities({ tools: tools.map((tool) => tool.name), skills: [] });

	/**
	 * The level this model will tolerate.
	 *
	 * `model.reasoning: true` is not enough to get reasoning out of a model, and
	 * the failure is silent: pi's harness defaults `thinkingLevel` to "off", and
	 * for DeepSeek that makes its adapter send `thinking: { type: "disabled" }` —
	 * the API then returns no `reasoning_content`, so no `thinking_delta` is ever
	 * emitted and the transcript looks like a non-reasoning model.
	 *
	 * The profile names the level and the model has the last word, which is
	 * **pi's `clampThinkingLevel`** rather than a rule of ours — the adopt list
	 * from [ticket 15](docs/wayfinder/pi-harness/tickets/15-core-already-does-this.md).
	 * It reads `thinkingLevelMap` and walks to the nearest supported level, where
	 * the obvious hand-rolled version (`reasoning ? level : "off"`) is only its
	 * first line. pi's own adapters clamp again at request time; what this fixes
	 * is `getThinkingLevel()` reporting a level the model will never honour.
	 */
	const thinkingFor = (level: ThinkingLevel): ThinkingLevel => clampThinkingLevel(model, level);

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
				// The profile the window opens on. Every later switch arrives
				// through `onProfileChange` below.
				thinkingLevel: thinkingFor(activeProfile().thinkingLevel),
				tools,
				activeToolNames: activeToolNames(activeProfile()),
				toolContext: { env },
				/*
				 * A callback, never a string — the decision
				 * [ticket 04](docs/wayfinder/pi-harness/tickets/04-profile-data-model.md)
				 * reached and the walking skeleton, which predates it, did not
				 * honour. There is no `setSystemPrompt`; `createTurnState()` awaits
				 * this once per turn, so a callback reading live state is the *only*
				 * way a profile's `instructions` can reach the model.
				 *
				 * `resources.skills` is the harness's own, so the prompt describes
				 * the skills actually loaded rather than a list we kept in parallel.
				 * It is empty until ticket 15's deferred loading lands.
				 */
				systemPrompt: (context) =>
					composeSystemPrompt({
						shell,
						skills: context.resources.skills,
						instructions: activeProfile().instructions,
					}),
			})
	);

	/*
	 * Read off the model rather than the environment, so the compaction
	 * threshold and the meter are measured against the window the model
	 * actually has. `model.contextWindow` is deliberately not used: it has the
	 * fallback baked in and can no longer say "unknown", which is the one answer
	 * that keeps auto-compaction from firing against a fabricated denominator.
	 */
	const contextWindow = contextWindowFor(model.id);
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

	/*
	 * A switch reaches the running harness — **through the queue**, so it lands
	 * between turns rather than inside one. Narrowing the tool set halfway
	 * through a turn would be retroactive in the one way ticket 14 forbids: the
	 * model would have been offered a tool it is then denied, mid-run.
	 *
	 * pi rewards the queue a second time. Both setters branch on
	 * `phase === "idle"`: idle, they append a real session entry
	 * (`appendActiveToolsChange`, `appendThinkingLevelChange`); mid-run they go
	 * to `pendingSessionWrites` to be flushed later. Waiting for idle is what
	 * puts the change in the session tree where it happened — which is the
	 * substrate ticket 14 wants for deriving the active profile from entries.
	 *
	 * Only the two fields a built-in profile can differ in need applying.
	 * `instructions` needs nothing, because the system prompt is a callback the
	 * harness awaits once per turn; `gatePolicy` is read when a turn opens its
	 * gate.
	 *
	 * **`model` is deliberately not applied.** `setModel()` exists and would be
	 * one line, but every built-in names the same model — the id still comes from
	 * an env var — so wiring it now would ship an untested branch, and on the
	 * canned path it would swap the scripted model out from under its own script.
	 * It lands when a profile file can name a second model.
	 */
	onProfileChange((profile) => {
		void ready.then((harness) =>
			enqueue(async () => {
				await harness.setActiveTools(activeToolNames(profile));
				await harness.setThinkingLevel(thinkingFor(profile.thinkingLevel));
			})
		);
	});

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
		// Read at turn start, not at construction: switching to `careful` has to
		// apply to the next turn rather than to the next window.
		const gate = createGate(activeProfile().gatePolicy, onEvent);

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
			/*
			 * The extension point for the system prompt
			 * ([ticket 17](docs/wayfinder/pi-harness/tickets/17-system-prompt-assembly.md)).
			 * The profile's own `instructions` do not come through here — they
			 * compose inside `composeSystemPrompt`, before the shell facts. This is
			 * for everything after that, and it is a *rewrite* rather than an
			 * append, following pi's extension contract.
			 *
			 * One handler, because `emitHook` keeps only the last non-undefined
			 * result; the chaining lives in `applyContributors`.
			 */
			const offPrompt = harness.on('before_agent_start', async (event) => {
				const composed = await applyContributors(event.systemPrompt);
				return composed === event.systemPrompt ? undefined : { systemPrompt: composed };
			});
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
				offPrompt();
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
	// The active profile names the model. An empty id means nobody has named one
	// — there is still no picker and no profile file, so it comes from an env var
	// — and that falls to the canned provider exactly as a missing env var did.
	const choice = native && activeProfile().model.id ? activeProfile().model : undefined;

	if (choice) {
		// Diverts provider hosts to Rust for every adapter, including the Google
		// ones that refuse an injected `fetch`.
		installRustFetch();
		const env = createTauriEnv();
		return createRunner(env, sharedSession(env), modelsFor(choice), modelFor(choice));
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
		canned.model
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
