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
	type JsonlSessionMetadata,
	type ThinkingLevel,
} from '@earendil-works/pi-agent-core';
import {
	clampThinkingLevel,
	createModels,
	createProvider,
	contentText,
	type Api,
	type Model,
} from '@earendil-works/pi-ai';
import { anthropicMessagesApi } from '@earendil-works/pi-ai/api/anthropic-messages.lazy';
import { googleGenerativeAIApi } from '@earendil-works/pi-ai/api/google-generative-ai.lazy';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import type { AgentEvent, AgentProvider } from './index';
import { compactionMessage, needsCompaction, readAutoCompact } from './compaction';
import {
	contextWindowFor,
	costFor,
	FALLBACK_CONTEXT_WINDOW,
	reasoningFor,
	thinkingLevelMapFor,
} from './models';
import { createMemoryEnv, createTauriEnv } from './env';
import { mapEvent } from './events';
import { installRustFetch } from './rustFetch';
import { cannedProvider, FIXTURE_FILES, FIXTURE_PROFILES } from './canned';
import { createGate } from './gate';
import { undoNote, type UndoOutcome } from './undo';
import { isTauri } from '../native';
import { allTemplates, onTemplatesChange, useTemplateSource } from './promptTemplates';
import { createAskTool, createAsker } from './ask';
import { applyContributors, composeSystemPrompt } from './systemPrompt';
import {
	activeProfile,
	activeToolNames,
	installProfiles,
	listProfiles,
	onProfileChange,
	PROVIDER_IDS,
	setCapabilities,
	type ProfileModel,
	type Profile,
	type ProviderId,
} from './profile';
import {
	createActivity,
	createTaskTool,
	delegable,
	type Delegation,
	type DelegationRequest,
} from './subagent';
import {
	allSkills,
	onSkillsChange,
	permittedSkills,
	useSkillSource,
} from './skills';
import { onUserToolsChange, userToolDefinitions, userTools } from './userTools';

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
async function checkpoint(prompt: string): Promise<string | undefined> {
	try {
		const { invoke } = await import('@tauri-apps/api/core');
		return (
			(await invoke<string | null>('git_checkpoint', {
				label: `agent: ${prompt.slice(0, 60)}`,
			})) ?? undefined
		);
	} catch {
		// Not a git repository, or git is not installed.
		return undefined;
	}
}

/**
 * Put the tree back, and record the reversal where the model will read it.
 *
 * **Order matters and is not symmetrical.** The restore goes first, because a
 * note about a rewind that never ran is worse than no note. It therefore rejects
 * on its own failure, and nothing has happened — the caller reports it and the
 * turn stays undoable, which is correct.
 *
 * The note comes second and **cannot be allowed to reject**. By the time it
 * runs the tree is already back, so throwing here would leave the files gone,
 * the model's context untouched, and the transcript recording neither — the
 * exact state ticket 28 says must not be reachable. Instead the failure is
 * carried out in `told`, so the transcript always records the undo and says
 * plainly that the model was not informed.
 */
async function restore(session: Session, sha: string): Promise<UndoOutcome> {
	const { invoke } = await import('@tauri-apps/api/core');
	const restored = await invoke<Omit<UndoOutcome, 'told'>>('git_restore_checkpoint', { sha });
	const outcome = { ...restored, told: true };
	/*
	 * pi's own way of putting something into the context that nobody said.
	 *
	 * **Verified in `dist`, not assumed** — the thing ticket 15 is entirely about.
	 * `convertToLlm` maps a `custom_message` to a `role: "user"` message, so this
	 * really does reach the model on the next turn. `display` is a hint to pi's
	 * own renderer and does not gate that; it is `false` because the transcript
	 * this app shows renders its own note on the undone turn.
	 */
	try {
		await session.appendCustomMessageEntry('undo', undoNote(outcome), false, outcome);
		return outcome;
	} catch {
		return { ...outcome, told: false };
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

/**
 * The window's own conversation, and somewhere to put a subagent's.
 *
 * Both come from one place because they share a directory: ticket 24 chose one
 * `/.ade/sessions` over a second root once pi's own parentage fields were found,
 * and that only works if whatever opens the window's session is also what knows
 * which files are children.
 */
interface SessionStore {
	readonly own: Promise<Session>;
	/** A session of a subagent's own, recorded as belonging to `own`. */
	child(): Promise<Session>;
}

let sessionOnce: Promise<Session<JsonlSessionMetadata>> | undefined;

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
function diskSessions(env: ExecutionEnv): SessionStore {
	const repo = new JsonlSessionRepo({ fs: env, sessionsRoot: SESSIONS_ROOT });
	const own = (sessionOnce ??= openSession(env, repo));
	return {
		own,
		/*
		 * **Both fields, and they are not the same claim.** `parentSessionPath`
		 * because it is true and because the deferred child chat view needs the
		 * link. `metadata.delegatedFrom` because that is what start-up filters on
		 * — filtering on `parentSessionPath` alone would also hide a *forked*
		 * session, and a fork is a session the user should still see on the day
		 * forking gets a UI.
		 */
		child: async () => {
			const parent = await (await own).getMetadata();
			return repo.create({
				cwd: '/',
				parentSessionPath: parent.path,
				metadata: { delegatedFrom: parent.path },
			});
		},
	};
}

/**
 * The session to continue, or a new one.
 *
 * "Most recent for this workspace" is the whole selection policy, and it is a
 * placeholder for a session picker rather than a design: `repo.list()` sorts
 * newest first and `fork()` is right there, so the UI is what is missing, not
 * the capability.
 *
 * **Newest that is not a subagent's.** A child's file is written after its
 * parent's by definition, so once delegation exists "the newest file" is usually
 * a child — and the next launch would resume somebody's sub-task instead of the
 * conversation the user was having.
 *
 * Failing to open a stored session must not cost you the agent. A corrupt or
 * half-written JSONL file falls back to a fresh session — losing history is
 * bad, but refusing to run at all is worse, and the broken file is left on disk
 * rather than deleted.
 */
async function openSession(
	env: ExecutionEnv,
	repo: JsonlSessionRepo
): Promise<Session<JsonlSessionMetadata>> {
	/*
	 * A self-ignoring directory, so the transcript never reaches the user's
	 * commits and their `.gitignore` is never edited by us. `git` reads a
	 * `.gitignore` at any level, and `*` there covers everything beneath it.
	 */
	await env.createDir('/.ade');
	await env.writeFile('/.ade/.gitignore', '*\n');

	try {
		const existing = await repo.list({ cwd: '/' });
		const mine = existing.find((entry) => !entry.metadata?.delegatedFrom);
		if (mine) {
			return await repo.open(mine);
		}
	} catch {
		// Fall through to a new session.
	}
	return repo.create({ cwd: '/' });
}

/** Browser mode's, where there is no disk and a child is simply another one. */
function memorySessions(): SessionStore {
	return {
		own: Promise.resolve(new Session(new InMemorySessionStorage())),
		child: async () => new Session(new InMemorySessionStorage()),
	};
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
		 * Was `/reason|think/i.test(choice.id)` — a guess on the *name*, right
		 * for `deepseek-reasoner` by accident and wrong for the next reasoning
		 * model not named after one. Ticket 19 replaced it with a table.
		 *
		 * **Unknown becomes `false`, and that is the safe direction rather than
		 * the tidy one.** Every thinking branch in pi's adapters is gated on this
		 * flag, so `false` sends no thinking parameters at all and the provider's
		 * own default applies. `true` on a model that does not reason sends
		 * `thinking: { type: "disabled" }` — or a `reasoning_effort` string — to
		 * an API that may reject it outright. Guessing low fails quietly;
		 * guessing high can fail hard.
		 *
		 * What is no longer silent is *that it was a default*: `reasoningFor`
		 * answers `undefined` for an unlisted model, `/profile` says so, and
		 * `VITE_AGENT_REASONING=on` is the escape hatch.
		 */
		reasoning: reasoningFor(choice.id) ?? false,
		// Only where pi publishes one. `getSupportedThinkingLevels` reads it to
		// drop levels a model does not take — `gemini-3-pro-preview` has no `off`
		// and no `medium` — and absent means "allow off through high", which is
		// what we were doing for every model before.
		thinkingLevelMap: thinkingLevelMapFor(choice.id),
		input: ['text'],
		/*
		 * Real rates where `models.ts` has them, zeroes where it does not — and
		 * the zeroes are never shown. pi's `calculateCost` multiplies whatever
		 * it is handed and `Model.cost` has nowhere to put "unknown", so the
		 * zeroed table stays for the type's sake and `costFor` answering
		 * `undefined` is what actually decides whether a cost reaches the UI.
		 * The same arrangement `contextWindow` below is under, for the same
		 * reason: a confident wrong number is worse than none.
		 */
		cost: costFor(choice.id) ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		// pi needs a number here — it clamps `maxTokens` against it — so the
		// fallback survives where the type demands one, but it is now the last
		// resort rather than the only answer. Nothing that decides *when to
		// compact* reads this field; that reads `contextWindowFor`, which is
		// allowed to answer "unknown". See ticket 16.
		contextWindow: contextWindowFor(choice.id) ?? FALLBACK_CONTEXT_WINDOW,
		maxTokens: 8_192,
	};
}

/**
 * Every provider, not only the one the window opened on.
 *
 * `models.streamSimple` resolves the provider by `model.provider` at request
 * time (`pi-ai/dist/models.js:275` → `requireProvider`), and an unregistered id
 * throws `ModelsError("provider")`. Registering only the active one was fine
 * while the model came from an env var and could not change; a profile file can
 * now name a model on another provider, and `setModel` would have failed on the
 * first turn after the switch rather than at the switch.
 *
 * `requireProvider` does not check that the model is *listed* — the list is for
 * enumeration — so each provider is registered with an empty one and the model
 * travels with the request. All three cost nothing to register: they are
 * already bundled (decision 3), and the api factories are lazy subpath imports.
 */
function allModels() {
	const models = createModels();
	for (const provider of PROVIDER_IDS) {
		models.setProvider(
			createProvider({
				id: provider,
				name: provider,
				baseUrl: SHAPES[provider].baseUrl,
				auth: {
					apiKey: {
						name: `${provider} (key held in Rust)`,
						// The placeholder is load-bearing. pi's OpenAI adapter throws
						// outright unless it sees a key or an authorization header,
						// and Google's requires one too. The value never travels:
						// `provider_stream` discards whatever auth header it is
						// handed and attaches the real key itself.
						resolve: async () => ({ auth: { apiKey: 'held-in-rust' }, source: 'Rust' }),
					},
				},
				models: [],
				api: apiFor(provider),
			})
		);
	}
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
/**
 * What a tool is handed at call time.
 *
 * `depth` is here rather than baked into the delegation tool because pi resolves
 * the context **per turn snapshot**, so one tool instance can serve the main
 * agent and every subagent below it. Building a tool set per level would be the
 * same tools four times over. See `subagent.ts`.
 */
type ToolContext = { env: ExecutionEnv; depth: number };

function createRunner(
	env: ExecutionEnv,
	sessions: SessionStore,
	models: ReturnType<typeof createModels>,
	model: Model<Api>,
	/**
	 * Whether a profile switch may change the model.
	 *
	 * False on the canned path, where the model is the script's own and swapping
	 * it out would leave the fixture answering as something it is not.
	 */
	modelFollowsProfile = false
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
	/*
	 * One asker for the runner, pointed at each turn's sink as it opens — the
	 * mechanism ticket 18 settled on, and the reason the tool below can be built
	 * once. The gate is per turn because it is cheap; a *tool* is not, because
	 * rebuilding one means `setTools` inside a run.
	 */
	const asker = createAsker();

	/*
	 * And the gate, on the same terms. It was built per turn while the
	 * `tool_call` hook was its only caller; a user tool's `execute` is the second
	 * one, and tools are built once. `begin` in `start()` is what still makes the
	 * policy a per-turn reading.
	 */
	const gate = createGate();

	/*
	 * Delegation, which is a tool and nothing more
	 * ([ticket 24](docs/wayfinder/pi-harness/tickets/24-subagents.md)). It is
	 * listed among the built-ins because a profile decides about it the way it
	 * decides about `bash`: `"tools": { "task": false }` is how a profile that
	 * must not delegate says so, and no second mechanism is needed.
	 *
	 * The store is read on every call rather than captured, so `/reload` changes
	 * which profiles are delegable without rebuilding the tool.
	 */
	const task = createTaskTool({
		delegable: () => delegable(listProfiles()),
		profile: (name) => listProfiles().find((candidate) => candidate.name === name),
		run: (request) => runSubagent(request),
	});

	const builtins = [
		createReadTool(),
		createWriteTool(),
		createEditTool(),
		createBashTool(),
		createAskTool(asker),
		task,
	];

	/*
	 * The user's own tools sit beside them, and the two sets are told apart
	 * because they follow opposite defaults: an unmentioned built-in is on, an
	 * unmentioned user tool is off. See `Capabilities.optIn`.
	 *
	 * Declared here rather than in `userTools.ts` because this is the only place
	 * that knows both halves — pi's built-ins are constructed here, and the
	 * store is what refuses a profile naming something outside the union.
	 */
	let tools = [...builtins, ...userToolDefinitions(gate)];
	const declare = () =>
		setCapabilities({
			tools: tools.map((tool) => tool.name),
			skills: allSkills().map((skill) => skill.name),
			optIn: userTools().map((tool) => tool.name),
		});
	declare();

	// The stores read through this environment, so they have to be told which one.
	useSkillSource(env);
	useTemplateSource(env);

	/**
	 * Everything `setResources` holds, always both halves.
	 *
	 * `setResources` **replaces** — it rebuilds `resources` from the object it is
	 * given, so a call passing only `skills` silently empties the templates. Every
	 * caller goes through this, which is the only thing keeping the three setters
	 * below from deleting each other's half.
	 */
	const resourcesFor = (profile: Profile) => ({
		skills: [...permittedSkills(allSkills(), profile)],
		promptTemplates: [...allTemplates()],
	});

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
	/*
	 * The model in force. A `let`, because a profile switch can now change it —
	 * and everything that reads a property of the model (the clamp, the context
	 * window behind the meter and auto-compaction) has to read the current one
	 * rather than the one the window opened on.
	 */
	let current = model;

	const thinkingFor = (level: ThinkingLevel): ThinkingLevel => clampThinkingLevel(current, level);

	/*
	 * Opening the session is I/O, so the harness cannot exist until it lands.
	 * Built once and awaited by every turn rather than per turn — `start` stays
	 * synchronous for the UI's sake, and the first prompt absorbs whatever the
	 * open costs.
	 */
	// Resolved once and shared with every subagent, which needs the same shell
	// facts in its system prompt and must not each pay a native round trip.
	const shellReady = resolveShell();

	const ready = Promise.all([sessions.own, shellReady]).then(
		([opened, shell]) =>
			new AgentHarness<ToolContext>({
				session: opened,
				models,
				model,
				// The profile the window opens on. Every later switch arrives
				// through `onProfileChange` below.
				thinkingLevel: thinkingFor(activeProfile().thinkingLevel),
				tools,
				activeToolNames: activeToolNames(activeProfile()),
				// Depth 1: the main agent counts toward the nesting limit, so a
				// child is 2 and its child is 3 and that one may not delegate.
				toolContext: { env, depth: 1 },
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
						canRead: activeToolNames(activeProfile()).includes('read'),
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
	const contextWindow = () => contextWindowFor(current.id);
	// Read per call, not per session: `/profile` can switch to a model whose
	// rates we do not have, and a flag captured at construction would keep
	// reporting the old model's prices against the new model's tokens.
	const priced = () => costFor(current.id) !== undefined;
	const autoCompact = readAutoCompact();

	/**
	 * One subagent, start to finish.
	 *
	 * A second `AgentHarness` and nothing more — which is the whole finding behind
	 * ticket 24. pi keeps no registry and no global agent state, so this is a
	 * `new` beside the one above, sharing the environment, the providers and the
	 * tool set and differing in the four things a profile decides.
	 *
	 * **It does not go through `enqueue`.** That serialiser exists to keep two
	 * turns off *one* harness; this is a different harness, and routing it through
	 * would hold every delegation until the turn that asked for it had ended.
	 *
	 * **The child starts from the prompt and nothing else.** No parent history is
	 * copied: doing so would pay the context cost the delegation exists to avoid,
	 * twice, and it is what makes the prompt the whole contract and therefore
	 * makes a bad delegation debuggable.
	 *
	 * Auto-compaction is deliberately absent rather than forgotten. A child runs
	 * exactly one turn, and pi will only compact an idle harness — so the rule
	 * "compaction per child, on the same terms" has nothing to fire on until a
	 * child can be talked to again, which is the deferred chat view.
	 */
	async function runSubagent(request: DelegationRequest): Promise<Delegation> {
		const { profile, prompt, depth, signal, onLine } = request;
		// The canned path keeps the script's own model for the same reason a
		// profile switch does not change it there: the fixture answers as itself.
		const childModel = modelFollowsProfile && profile.model.id ? modelFor(profile.model) : current;
		const [session, shell] = await Promise.all([sessions.child(), shellReady]);

		const harness = new AgentHarness<ToolContext>({
			session,
			models,
			model: childModel,
			thinkingLevel: clampThinkingLevel(childModel, profile.thinkingLevel),
			tools,
			activeToolNames: activeToolNames(profile),
			toolContext: { env, depth },
			resources: resourcesFor(profile),
			systemPrompt: (context) =>
				composeSystemPrompt({
					shell,
					skills: context.resources.skills,
					canRead: activeToolNames(profile).includes('read'),
					instructions: profile.instructions,
				}),
		});

		/*
		 * **The child's own profile decides how much it asks**, and the question
		 * still reaches the user. This is the case that tests the premise: a
		 * read-only `research` child can sit on `auto` while an `editor` child runs
		 * `ask`, because the profile author decided that. Taking the parent's
		 * policy instead would leave `gatePolicy` silently meaningless for
		 * subagents.
		 *
		 * The gate is the runner's, not one of its own: `resolveApproval` on the
		 * run reaches exactly one gate, so a child with its own could ask a
		 * question nothing could ever answer. Four children asking at once is what
		 * made the gate queue.
		 */
		const offGate = harness.on('tool_call', (event) => gate.onToolCall(event, profile.gatePolicy));

		/*
		 * The child's events stay inside the child. Only one line of them escapes,
		 * and **`usage` never does**: adding a child's tokens to the parent's meter
		 * would corrupt the number auto-compaction divides by — the parent's window
		 * is not fuller because a child read a file. Both counts are kept and the
		 * delegation carries the child's back separately.
		 */
		const activity = createActivity();
		let inputTokens = 0;
		let outputTokens = 0;
		// Undefined until a priced `usage` arrives, and it stays undefined for a
		// child on an unpriced model — the same distinction between "nothing" and
		// "nothing known" the parent's footer makes. A child whose model differs
		// from the parent's is exactly why this is accumulated here rather than
		// derived from the parent's rates later.
		let cost: number | undefined;
		let said = '';
		const off = harness.subscribe((event: AgentHarnessEvent) => {
			for (const mapped of mapEvent(event, contextWindowFor(childModel.id), costFor(childModel.id) !== undefined)) {
				if (mapped.kind === 'usage') {
					inputTokens += mapped.inputTokens;
					outputTokens += mapped.outputTokens;
					if (mapped.cost) {
						const { input, output, cacheRead, cacheWrite } = mapped.cost;
						cost = (cost ?? 0) + input + output + cacheRead + cacheWrite;
					}
					continue;
				}
				if (mapped.kind === 'text') {
					said += mapped.text;
				}
				const line = activity(mapped);
				if (line !== undefined) {
					onLine(line);
				}
			}
		});

		// Both the parent's cancellation and the child's own budget arrive here.
		// The half-written session file is left on disk rather than deleted: a
		// partial record beats no record when you are asking why it failed.
		const stop = () => void harness.abort();
		signal.addEventListener('abort', stop, { once: true });

		try {
			const answer = await harness.prompt(prompt);
			return { answer: contentText(answer.content), inputTokens, outputTokens, cost };
		} catch (cause: unknown) {
			// An aborted run unwinds through a rejection, and what it had reached is
			// still worth reporting — a subagent stopped at fifteen minutes usually
			// found most of the answer. Any other failure is a *harness* failure and
			// travels on as one, which the tool turns into an error `tool_result`.
			if (signal.aborted) {
				return { answer: said, inputTokens, outputTokens, cost };
			}
			throw cause;
		} finally {
			signal.removeEventListener('abort', stop);
			offGate();
			off();
		}
	}

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
	/** Turns in flight. Only `undo` reads it, and only to refuse. */
	let live = 0;

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
	 * **`model` is applied last, and only where it means anything.** It was left
	 * unwired while every built-in named the same model; a profile file can now
	 * name a second one, which is what makes the branch real. Order matters
	 * inside the switch: `setModel` first, so the clamp that follows asks the
	 * model being switched *to* what it supports rather than the one being left.
	 */
	onProfileChange((profile) => {
		void ready.then((harness) =>
			enqueue(async () => {
				if (modelFollowsProfile && profile.model.id && profile.model.id !== current.id) {
					current = modelFor(profile.model);
					await harness.setModel(current);
				}
				await harness.setActiveTools(activeToolNames(profile));
				await harness.setThinkingLevel(thinkingFor(profile.thinkingLevel));
				// Which skills the *next* turn may use, and which the system prompt
				// lists. A third field the switch has to apply, for the same reason
				// the tool set is one: the profile names them and they are off by
				// default, so a switch that left them alone would leave the model
				// holding the previous profile's skills.
				await harness.setResources(resourcesFor(profile));
			})
		);
	});

	/**
	 * The skills on disk, which land whenever `/reload` or the first root
	 * selection reads them.
	 *
	 * `setResources` is pi's own setter and it emits `resources_update`, so the
	 * harness treats a mid-session change as a real event rather than as
	 * something we patched in behind it. Through the queue like every other
	 * setter, so the skill list never changes under a run in flight.
	 *
	 * `declare()` first and synchronously: `installProfiles` validates skill
	 * names against `setCapabilities` immediately after the load, where the
	 * harness only needs to know by the next turn.
	 */
	onSkillsChange(() => {
		declare();
		void ready.then((harness) =>
			enqueue(() => harness.setResources(resourcesFor(activeProfile())))
		);
	});

	/*
	 * The user's commands, which land on the same `/reload` the skills do.
	 *
	 * No `declare()` beside it, unlike skills: a template is not a capability a
	 * profile names, so nothing validates against it. See `promptTemplates.ts`
	 * for why the profile does not gate them.
	 */
	onTemplatesChange(() => {
		void ready.then((harness) =>
			enqueue(() => harness.setResources(resourcesFor(activeProfile())))
		);
	});

	/*
	 * The user's tool files, which land long after this — they are read once the
	 * workspace root is known, and the harness is built before that.
	 *
	 * `setTools` takes the active list too, so the harness never sees a moment
	 * where a newly declared tool exists but no profile has decided about it.
	 * The `declare()` is synchronous and the harness call is not, deliberately:
	 * `installProfiles` runs immediately after `installUserTools` and validates
	 * against `setCapabilities`, where the harness only needs to know by the
	 * next turn — and going through the queue is what keeps the tool set from
	 * changing under a run in flight.
	 */
	onUserToolsChange(() => {
		tools = [...builtins, ...userToolDefinitions(gate)];
		declare();
		void ready.then((harness) =>
			enqueue(() => harness.setTools(tools, activeToolNames(activeProfile())))
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
		harness: AgentHarness<ToolContext>,
		onEvent: (event: AgentEvent) => void
	) {
		try {
			await harness.compact();
		} catch (cause: unknown) {
			onEvent({ kind: 'error', message: compactionMessage(cause) });
		}
	}

	/**
	 * One turn, however it was started.
	 *
	 * `prompt()` and `skill()` are the same turn with a different first message —
	 * pi's `skill()` looks the name up in `resources`, formats the body with
	 * `formatSkillInvocation`, and hands it to the very same `executeTurn`. So
	 * everything a turn owns (the gate, the asker, the hooks, held compaction,
	 * cancellation) is shared, and only the call differs. `label` is what the
	 * transcript shows as the prompt; for a skill that is the command the user
	 * typed rather than the body, which would be a wall of instructions nobody
	 * wrote.
	 */
	function begin(
		label: string,
		run: (harness: AgentHarness<ToolContext>) => Promise<unknown>,
		onEvent: (event: AgentEvent) => void
	) {
		// Read at turn start, not at construction: switching to `ask` has to
		// apply to the next turn rather than to the next window.
		gate.begin(activeProfile().gatePolicy, onEvent);
		// Point both at this turn. Anything left outstanding by a previous turn is
		// abandoned here rather than answered by this turn's user.
		asker.begin(onEvent);

		// One more turn in flight. `release` is idempotent — see `released` — so
		// this is incremented once and decremented once per turn.
		live += 1;

		let released = false;
		let stopped = false;
		let running: AgentHarness<ToolContext> | undefined;
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
			live -= 1;
			dispose?.();
		}

		function attach(harness: AgentHarness<ToolContext>) {
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
				for (const mapped of mapEvent(event, contextWindow(), priced())) {
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
						needsCompaction(contextTokens, contextWindow())
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
					const sha = await checkpoint(label);
					if (sha) {
						// Before the turn's own output, because that is when it was
						// taken — and because a turn that fails still has one.
						onEvent({ kind: 'checkpoint', sha });
					}
					await run(harness);
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

		/** Report a queueing failure into the transcript instead of losing it. */
		async function queued(call: Promise<void> | undefined) {
			try {
				if (!call) {
					throw new Error('The turn is no longer running.');
				}
				await call;
			} catch (cause: unknown) {
				onEvent({
					kind: 'error',
					message: `That was not queued: ${cause instanceof Error ? cause.message : String(cause)}`,
				});
			}
		}

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
				// Same reason as the gate: a tool awaiting an answer that can no
				// longer arrive is a turn that never settles.
				asker.abandon();
				onEvent({ kind: 'cancelled' });
				release();
				void running?.abort();
			},
			/*
			 * The two queues, straight through to pi.
			 *
			 * Not through `enqueue`: that serialiser exists to keep two *turns* off
			 * one harness, and these are calls made while a turn is running — going
			 * through it would hold every steer until the turn it was meant for had
			 * ended. Queueing is what pi does with them.
			 *
			 * Both throw `invalid_state` on an idle harness, and the window between
			 * a turn settling and the UI hearing `complete` is real, so the throw is
			 * reported rather than swallowed. `running` being undefined is the same
			 * case one moment earlier: the session has not opened yet.
			 *
			 * The queue itself is not echoed here. pi emits `queue_update` from
			 * inside both calls, and that is what reaches the transcript — so what
			 * the UI shows is pi's queue rather than our record of what we sent.
			 */
			steer: (text: string) => void queued(running?.steer(text)),
			follow: (text: string) => void queued(running?.followUp(text)),
			resolveApproval: (approved: boolean) => gate.resolve(approved),
			answerQuestion: (chosen: readonly string[]) => asker.answer(chosen),
		};
	}

	const start = (prompt: string, onEvent: (event: AgentEvent) => void) =>
		begin(prompt, (harness) => harness.prompt(prompt), onEvent);

	/**
	 * `/skill <name>`, typed by the user.
	 *
	 * The user half of skills, and pi's own — `AgentHarness.skill()` finds the
	 * skill in `resources`, wraps the body with `formatSkillInvocation` and runs
	 * it as the turn's first message. `extra` is pi's `additionalInstructions`,
	 * appended after the skill block.
	 *
	 * This is the *only* way the user reaches a skill and the only way the model
	 * cannot: `skill()` throws `busy` unless the harness is idle, so it can never
	 * be called from inside a turn and can never be a tool. The model's half is
	 * the `<available_skills>` listing plus an ordinary `read`, which is why the
	 * global directory had to become readable at all.
	 */
	const skill = (name: string, extra: string | undefined, onEvent: (event: AgentEvent) => void) =>
		begin(`/skill ${name}`, (harness) => harness.skill(name, extra), onEvent);

	/**
	 * `/<command>`, typed by the user — one of their own prompt templates.
	 *
	 * The same one-line shape `skill` has, because underneath it is the same
	 * thing: `promptFromTemplate` looks the name up in `resources`, fills the
	 * placeholders with `substituteArgs`, and hands the result to the very same
	 * `executeTurn`. So the gate, the asker, the hooks and cancellation are all
	 * shared, and an unknown name fails as pi's `invalid_argument` rather than
	 * as a prompt that says "/deploy".
	 *
	 * The label is what the user typed, for the reason `/skill`'s is: the body is
	 * a file they wrote and the transcript should show the command, not the file.
	 */
	const template = (
		name: string,
		args: readonly string[],
		onEvent: (event: AgentEvent) => void
	) =>
		begin(
			[`/${name}`, ...args].join(' '),
			(harness) => harness.promptFromTemplate(name, [...args]),
			onEvent
		);

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
						for (const mapped of mapEvent(event, contextWindow(), priced())) {
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

	/**
	 * Undo, **through the same queue every other harness operation goes through.**
	 *
	 * That is what implements "refused while a turn is running" — not a flag the
	 * UI could forget to check. A running turn holds the queue, so an undo that
	 * arrived mid-turn would land after it and rewind a turn the user is watching
	 * finish. The queue makes ordering safe; the explicit refusal below makes it
	 * *visible*, which is what the ticket asked for.
	 */
	async function undo(sha: string): Promise<UndoOutcome> {
		if (live > 0) {
			throw new Error('The agent is still running. Stop it first.');
		}
		return await enqueue(async () => restore(await sessions.own, sha));
	}

	return { start, skill, template, compact, undo };
}

export function createAgentProvider(): AgentProvider {
	const native = isTauri();
	// The active profile names the model. An empty id means nobody has named one
	// — there is still no picker and no profile file, so it comes from an env var
	// — and that falls to the canned provider exactly as a missing env var did.
	const choice = native && activeProfile().model.id ? activeProfile().model : undefined;

	if (choice) {
		// Diverts provider hosts to Rust for every adapter, including the Google
		// ones that refuse an injected `fetch`.
		installRustFetch();
		const env = createTauriEnv();
		return createRunner(env, diskSessions(env), allModels(), modelFor(choice), true);
	}

	// No model configured, or no native shell: the canned provider. It is the
	// same harness and the same tool, so a bug in the mapping shows up here too.
	// The session stays in memory here — browser mode has no disk to persist to,
	// and inventing one would be the parallel fiction ticket 10 ruled out.
	const canned = cannedProvider();
	/*
	 * The one profile browser mode adds to the built-ins. Natively these come
	 * from `profiles.json` through Rust; there is no disk here, and without a
	 * delegable profile the `task` tool can only ever answer that it has nobody
	 * to delegate to — which would leave the whole feature unreachable in the
	 * only mode that runs without an API key.
	 */
	installProfiles(FIXTURE_PROFILES);
	const runner = createRunner(
		createMemoryEnv(FIXTURE_FILES),
		memorySessions(),
		canned.models,
		canned.model
	);
	return {
		start: (prompt, onEvent) => {
			canned.rearm(prompt);
			return runner.start(prompt, onEvent);
		},
		// Not rearmed either, and it will not find a skill: the memory environment
		// has no skill directories, so `/skill` in browser mode says the name is
		// unknown. That is the honest answer rather than a fixture skill the
		// native path would never load.
		skill: runner.skill,
		// Nor rearmed, and it will find no template either: the memory environment
		// has no `.agents/commands`, so a command from disk cannot exist in browser
		// mode. Same honest answer as `/skill` gives there.
		template: runner.template,
		// Not rearmed: compaction asks the model for a summary, and the canned
		// script has no answer for that. It reports "not enough conversation"
		// or the script's own failure, which is the honest browser-mode answer
		// rather than a fake summary the real path would never produce.
		compact: runner.compact,
		// Reachable only through a checkpoint sha, and browser mode never emits
		// one — there is no repository and `git_checkpoint` is a Rust command. So
		// this is dead by construction rather than by a flag, and `runner.undo`
		// would fail on the missing `invoke` anyway. Passed through so the two
		// providers stay the same shape.
		undo: runner.undo,
	};
}
