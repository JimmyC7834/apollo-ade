// Which agent the workbench gets, and how it is assembled.
//
// One harness, two environments. Natively it reads real files through Rust and
// streams from a real model; under `npm run dev` it runs the *same* harness and
// the *same* read tool against an in-memory disk and a canned provider. That is
// `context.md`'s browser-mode rule satisfied by exercising the real mapping
// code rather than by writing a second, drifting fiction.

import {
	AgentHarness,
	Session,
	createBashTool,
	createEditTool,
	createReadTool,
	createWriteTool,
	type AgentHarnessEvent,
	type AgentHarnessTool,
	type ExecutionEnv,
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
import type { AgentEvent, AgentProvider, SessionRoot } from './index';
import { replayEntries, type HistoryTurn } from './history';
import { compactionMessage, needsCompaction, readAutoCompact } from './compaction';
import {
	contextWindowFor,
	costFor,
	FALLBACK_CONTEXT_WINDOW,
	reasoningFor,
	thinkingLevelMapFor,
} from './models';
import { createMemoryEnv, createTauriEnv, type NotingEnv } from './env';
import {
	diskSessions,
	memorySessions,
	type SessionStore,
	type SessionWant,
} from './sessionStore';
import { mapEvent } from './events';
import { installRustFetch } from './rustFetch';
import { cannedProvider, FIXTURE_FILES } from './canned';
import { createGate } from './gate';
import { resolveRtk, rewriteToolCall } from './rtk';
import { undoNote, type UndoOutcome } from './undo';
import { loadedRoot } from './profileFiles';
import { isTauri } from '../native';
import { allTemplates, onTemplatesChange, useTemplateSource } from './promptTemplates';
import { createAskTool, createAsker } from './ask';
import { createBrowserTool } from './browserTool';
import { applyContributors, composeSystemPrompt } from './systemPrompt';
import {
	activeProfile,
	activeToolNames,
	createSelection,
	listProfiles,
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
async function checkpoint(prompt: string, session: string | undefined): Promise<string | undefined> {
	try {
		const { invoke } = await import('@tauri-apps/api/core');
		return (
			(await invoke<string | null>('git_checkpoint', {
				label: `agent: ${prompt.slice(0, 60)}`,
				// The session's own repository. Without it a background turn would
				// snapshot whichever folder the window happened to be showing — the
				// same ambient-root bug ADR 0002 removed from the file commands.
				session: session ?? null,
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
async function restore(
	session: Session,
	sha: string,
	agentSession: string | undefined
): Promise<UndoOutcome> {
	const { invoke } = await import('@tauri-apps/api/core');
	const restored = await invoke<Omit<UndoOutcome, 'told'>>('git_restore_checkpoint', {
		sha,
		session: agentSession ?? null,
	});
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

/**
 * The same environment, when it is the one that collects Rust's write notes.
 *
 * A shape test rather than a flag: browser mode's memory environment has no
 * notes to give and no Rust to give them, and neither branch should have to
 * carry a capability field to say so.
 */
function noting(env: ExecutionEnv): NotingEnv | undefined {
	return 'takeNotes' in env ? (env as NotingEnv) : undefined;
}

/**
 * The same tool, plus whatever Rust wanted said about the writes it made.
 *
 * **Wrapped here rather than hooked**, because pi's harness has no after-tool
 * hook — `afterToolCall` belongs to the `Agent` underneath it, which the harness
 * does not expose. A wrapper is also the more accurate place: it takes the notes
 * from *this* call's own context, so a subagent's writes are noted in the
 * subagent's transcript rather than surfacing in its parent's.
 *
 * It never fails the tool and never changes what the tool did. The write has
 * already happened by the time this runs — that is ticket 51's decision, not an
 * accident of ordering.
 */
function withWriteNotes<T extends AgentHarnessTool<ToolContext>>(tool: T): T {
	return {
		...tool,
		async execute(toolCallId, params, signal, onUpdate, context) {
			const result = await tool.execute(toolCallId, params, signal, onUpdate, context);
			const notes = noting(context.env)?.takeNotes() ?? [];
			return notes.length === 0
				? result
				: { ...result, content: [...result.content, ...notes.map(text)] };
		},
	};
}

const text = (value: string) => ({ type: 'text' as const, text: value });

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
	modelFollowsProfile = false,
	/**
	 * Rust's id for this session, where there is one.
	 *
	 * Only the git commands need it here — everything else already carries it,
	 * inside `env`. Undefined in browser mode, where there is no repository.
	 */
	agentSession?: string,
	/** The folder this session is confined to, for the test `mine` makes. */
	agentRoot?: string
) {
	/**
	 * This session's profile — ticket 50.
	 *
	 * **Per runner, not per window.** Everything below reads `profile.current()`
	 * where it used to read the module's `profile.current()`, which is the whole of
	 * the change: a switch made in one conversation retunes that conversation's
	 * harness and no other. A background session mid-turn is unaffected by
	 * anything the user does elsewhere.
	 */
	/**
	 * Whether a change to the window's project-scoped stores belongs to *this*
	 * session — ticket 49's other half, and a hole review found.
	 *
	 * Profiles, user tools, skills and prompt templates are all read from a root,
	 * and a window now holds sessions in several. Focusing a conversation in one
	 * folder re-reads that folder's files, and without this test every runner
	 * rebuilt its tool set from them — handing a folder's own `argv` manifests to
	 * a session confined somewhere else. A reload used to make that impossible by
	 * throwing the whole window away.
	 */
	const mine = () => {
		const from = loadedRoot();
		return from === undefined || from === agentRoot;
	};
	const profile = createSelection(mine);

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
		// The two that write. `bash` writes too, but through a shell Rust does not
		// track, and the read tool is deliberately silent: two agents reading one
		// file is normal and a note on it would be constant noise.
		withWriteNotes(createWriteTool()),
		withWriteNotes(createEditTool()),
		createBashTool(),
		createAskTool(asker),
		/*
		 * The page the agent can look at — ticket 70. Listed among the built-ins
		 * because a profile decides about it the way it decides about `bash`:
		 * `"tools": { "browser": false }` is how a profile that must not open one
		 * says so. It reads its workbench from `setBrowserHost` rather than being
		 * built with one, because a tool is built once and the workbench is not
		 * mounted yet when the runner is created.
		 */
		createBrowserTool(),
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
	let tools = [...builtins, ...userToolDefinitions(gate, () => profile.current().rtk)];
	const declare = () =>
		setCapabilities({
			tools: tools.map((tool) => tool.name),
			skills: allSkills().map((skill) => skill.name),
			optIn: userTools().map((tool) => tool.name),
		});
	declare();

	// At app open too, not only on a switch: the profile that is already active
	// is the one whose first command would otherwise pay for the download.
	if (profile.current().rtk) {
		void resolveRtk();
	}

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
				thinkingLevel: thinkingFor(profile.current().thinkingLevel),
				tools,
				activeToolNames: activeToolNames(profile.current()),
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
						canRead: activeToolNames(profile.current()).includes('read'),
						instructions: profile.current().instructions,
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
		// Ahead of the gate, for the reason `attach` records — and on the child's
		// own `rtk` flag, since a profile decides this the way it decides its
		// policy. No `warn`: the notice belongs to the parent's transcript.
		const offRtk = harness.on('tool_call', (event) => rewriteToolCall(event, profile.rtk));
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
			offRtk();
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
	profile.subscribe(() => {
		const chosen = profile.current();
		/*
		 * The selection already ignores another root's catalogue (`createSelection`
		 * takes `mine`), so by here this is always this session's own profile —
		 * either because it chose it, or because its own root's file redefined it.
		 */
		/*
		 * Fetch rtk before anything wants it.
		 *
		 * The hook above *blocks* the tool call that triggers acquisition, which
		 * is the right correctness answer and a poor experience the one time it
		 * fires. Doing it here and at construction means it has almost always
		 * already happened — and `resolveRtk` memoises, so a switch after the
		 * first is free rather than another download.
		 */
		if (chosen.rtk) {
			void resolveRtk();
		}
		void ready.then((harness) =>
			enqueue(async () => {
				if (modelFollowsProfile && chosen.model.id && chosen.model.id !== current.id) {
					current = modelFor(chosen.model);
					await harness.setModel(current);
				}
				await harness.setActiveTools(activeToolNames(chosen));
				await harness.setThinkingLevel(thinkingFor(chosen.thinkingLevel));
				// Which skills the *next* turn may use, and which the system prompt
				// lists. A third field the switch has to apply, for the same reason
				// the tool set is one: the profile names them and they are off by
				// default, so a switch that left them alone would leave the model
				// holding the previous profile's skills.
				await harness.setResources(resourcesFor(chosen));
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
		// Another folder's skills are not this session's — see `mine`.
		if (!mine()) {
			return;
		}
		declare();
		void ready.then((harness) =>
			enqueue(() => harness.setResources(resourcesFor(profile.current())))
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
		if (!mine()) {
			return;
		}
		void ready.then((harness) =>
			enqueue(() => harness.setResources(resourcesFor(profile.current())))
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
		/*
		 * **The one with teeth.** A user tool is an argv array a folder's
		 * `ade.profiles.json` declares, run through the gate — so installing another
		 * root's tools into this harness would let a folder the user merely glanced
		 * at execute commands in the folder they are working in.
		 */
		if (!mine()) {
			return;
		}
		tools = [...builtins, ...userToolDefinitions(gate, () => profile.current().rtk)];
		declare();
		void ready.then((harness) =>
			enqueue(() => harness.setTools(tools, activeToolNames(profile.current())))
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
		/*
		 * No model, no turn.
		 *
		 * Checked here rather than at construction, because at construction there
		 * is nothing to check: `createAgentProvider` runs during render and the
		 * profile naming the model is read on the effect path afterwards. By the
		 * time anybody presses Enter it has long since arrived, so this only fires
		 * when a model really is configured nowhere — no profile file, no global
		 * one, no `VITE_AGENT_MODEL`.
		 *
		 * It says what to do instead of failing at the network. `modelFor` builds
		 * a `Model` out of whatever it is handed, so an empty id reaches the
		 * provider host as an empty model name and comes back as somebody's 404.
		 *
		 * **`modelFollowsProfile` gates it, and leaving that off was a regression
		 * caught by running browser mode.** There the model is the canned script's
		 * own and the profile names none, so an ungated check refused every turn
		 * in the browser — replacing a working fixture with a message telling the
		 * user to configure something the fixture does not use. The flag already
		 * means exactly "the profile is where the model comes from", which is the
		 * only condition under which the profile lacking one is a problem.
		 */
		if (modelFollowsProfile && !profile.current().model.id) {
			onEvent({
				kind: 'error',
				message:
					'No model is configured. Name one in a profile — the profile button ' +
					'below the composer — or start the app with VITE_AGENT_MODEL set.',
				code: 'no_model',
			});
			onEvent({ kind: 'complete' });
			return {
				cancel: () => undefined,
				steer: () => undefined,
				follow: () => undefined,
				resolveApproval: () => undefined,
				answerQuestion: () => undefined,
			};
		}

		// Read at turn start, not at construction: switching to `ask` has to
		// apply to the next turn rather than to the next window.
		gate.begin(profile.current().gatePolicy, onEvent);
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
			/*
			 * **Registered before the gate, and that is the whole design.**
			 * `emitHook` walks handlers in registration order and keeps the last
			 * non-undefined result, so this one rewrites `event.input.command` —
			 * the same object pi hands to `execute` — and then the gate's deny
			 * list reads what will actually run. Ticket 11, amendment 6:
			 * `resolve → rtk rewrites → deny list → gate → run → stripControl`.
			 */
			// `Promise<undefined>`, not `void`, for the reason `rewriteToolCall`
			// carries the same annotation: pi keeps the last non-undefined hook
			// result, so anything returned here displaces the gate's decision.
			const offRtk = harness.on('tool_call', async (event): Promise<undefined> => {
				const before = event.input.command;
				await rewriteToolCall(event, profile.current().rtk, (message) =>
					onEvent({ kind: 'error', message, code: 'rtk_unavailable' })
				);
				/*
				 * The transcript row is already out and says what the *model* wrote:
				 * pi emits `tool_execution_start` with `toolCall.arguments` before it
				 * validates them or runs this hook, and it validates into a fresh
				 * object, so the mutation above can never be seen from there. Under
				 * `ask` the approval card is built later still and shows the truth,
				 * which is why this only ever looked wrong under `auto` — the policy
				 * the user actually runs.
				 */
				if (event.input.command !== before) {
					onEvent({ kind: 'tool_input', id: event.toolCallId, input: { ...event.input } });
				}
			});
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
				offRtk();
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
					const sha = await checkpoint(label, agentSession);
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
		return await enqueue(async () => restore(await sessions.own, sha, agentSession));
	}

	/**
	 * The open session, as turns.
	 *
	 * `getBranch` rather than `getEntries`: the branch is the path the harness
	 * itself is on, so a compacted or forked session reads back as the
	 * conversation the model actually has rather than every entry the file holds.
	 */
	async function history(): Promise<readonly HistoryTurn[]> {
		try {
			return replayEntries(await (await sessions.own).getBranch());
		} catch {
			return [];
		}
	}

	/**
	 * Whose work an undo of this checkpoint would also revert — ticket 52.
	 *
	 * Rust's answer, because Rust is the only side that saw every session's
	 * writes. Never rejects: an empty list is both "nobody else was here" and
	 * "there is no Rust to ask", and both mean the ordinary undo.
	 */
	async function contention(sha: string): Promise<readonly string[]> {
		try {
			const { invoke } = await import('@tauri-apps/api/core');
			return await invoke<string[]>('checkpoint_contention', {
				sha,
				session: agentSession ?? null,
			});
		} catch {
			return [];
		}
	}

	/**
	 * Put something into this session's context that nobody said.
	 *
	 * The same mechanism `restore` uses for its own note, exposed because ticket
	 * 52 needs it pointed at a *different* session: the conversation whose edits
	 * somebody else's undo reverted has to be told, or it goes on believing they
	 * are there. Through the queue, like every other session write.
	 */
	async function record(note: string): Promise<void> {
		try {
			await enqueue(async () =>
				(await sessions.own).appendCustomMessageEntry('undo', note, false, {})
			);
		} catch {
			// The transcript still shows it. A context that could not be written
			// is the same end state `told: false` already describes.
		}
	}

	return {
		start,
		skill,
		template,
		compact,
		undo,
		contention,
		record,
		profile,
		listSessions: () => sessions.list(),
		history,
		path: () => sessions.path,
		/*
		 * Overridden on the native path, where there is a Rust session id to
		 * release as well. What is here is what every runner owes: the profile
		 * store holds a listener per selection, and a closed session that kept one
		 * would go on retuning a harness nobody can reach on every `/reload`.
		 */
		dispose: () => profile.stop(),
	};
}

/**
 * Which agent this window gets.
 *
 * **The branch is `isTauri()` and nothing else, and that is the fix for a real
 * bug.** It used to be `native && profile.current().model.id`, on the premise —
 * stated in the comment that was here — that a model could only come from an env
 * var, which is available synchronously. That premise expired when profiles
 * became files: `ade.profiles.json` names a model, `loadProfileFiles()` reads it
 * on the *effect* path, and this function runs during `WorkbenchController`'s
 * **render**. A project profile was therefore always too late, so a native
 * window with a perfectly good profile ran the canned fixture — answering
 * "Browser mode. Run `npm run tauri dev`" inside a real Tauri window — while the
 * composer bar, which subscribes to the store, displayed the model it was not
 * using. `VITE_AGENT_MODEL` masked it completely, which is why every native
 * verification in this repo had passed.
 *
 * Deferring construction until profiles load was the obvious repair and is the
 * wrong one: `createRunner` calls `setCapabilities`, and `profile.ts` notes that
 * until it does, a profile naming a tool refuses to activate. That window is
 * unobservable *only* because the runner is built first. So the runner stays
 * eager and the **model** becomes the late-bound part — which needs no new
 * machinery, because `onProfileChange` already calls `harness.setModel` and has
 * since profiles could name a second model.
 *
 * A native window with no model configured anywhere no longer falls back to the
 * fixture. It gets the real environment and refuses turns until a model is
 * named — see the guard in `begin`. The fixture is browser mode's, and it says
 * so in every one of its replies.
 */
/**
 * @param at Which recent root this session belongs to, by index into Rust's
 * recents list. Undefined is the root the window is in — the only case there was
 * before ticket 49.
 */
export async function createAgentProvider(
	want: SessionWant = {},
	at?: number
): Promise<AgentProvider> {
	if (isTauri()) {
		// Diverts provider hosts to Rust for every adapter, including the Google
		// ones that refuse an injected `fetch`. Idempotent, so a window with six
		// sessions in it still patches `fetch` once.
		installRustFetch();
		/*
		 * **The root is claimed before anything can touch it.** Rust registers the
		 * folder and hands back an id; every path this environment names resolves
		 * against *that* root for as long as the session lives, whatever the window
		 * is showing. Ticket 46, and `docs/adr/0002-a-root-per-session.md`.
		 */
		const { invoke } = await import('@tauri-apps/api/core');
		/*
		 * `workspace` is null for "the root this window is in" and an index into
		 * the recents list for a session in another folder — ticket 49. It is an
		 * index rather than a path for `switch_workspace`'s reason, unchanged.
		 */
		const created = await invoke<{ id: string; root: SessionRoot }>('create_agent_session', {
			workspace: at ?? null,
		});
		const session = created.id;
		const env = createTauriEnv({ session });
		/*
		 * `activeProfile().model` may still be the empty built-in here, and that
		 * is expected rather than tolerated: `modelFollowsProfile` is `true`, so
		 * the moment `loadProfileFiles` installs the real one the harness is told.
		 */
		const runner = createRunner(
			env,
			diskSessions(env, want),
			allModels(),
			modelFor(activeProfile().model),
			true,
			session,
			created.root.path
		);
		return {
			...runner,
			/*
			 * Handing the root back is what makes "closed" true on the Rust side as
			 * well as in the window: every command carrying this id starts being
			 * refused, so a straggling write from a run that was stopped cannot land
			 * in a folder nobody is looking at.
			 */
			dispose: () => {
				runner.dispose();
				void invoke('close_agent_session', { session }).catch(() => {});
			},
			root: created.root,
			enter: () => invoke<SessionRoot>('focus_agent_session', { session }),
			// Never rejects: a session that could not be named still runs, it is
			// simply called "another session" in somebody else's warning.
			label: (name) => void invoke('label_agent_session', { session, label: name }).catch(() => {}),
		};
	}

	// Browser mode: the canned provider. It is the same harness and the same
	// tool, so a bug in the mapping shows up here too. The session stays in
	// memory — there is no disk to persist to, and inventing one would be the
	// parallel fiction ticket 10 ruled out.
	const canned = cannedProvider();
	/*
	 * `FIXTURE_PROFILES` — browser mode's one addition to the built-ins — is
	 * installed by `loadProfileFiles`, not here. This function runs during
	 * `WorkbenchController`'s render, and installing profiles notifies a store
	 * `ComposerBar` subscribes to; the reasoning is at the browser branch of
	 * `loadProfileFiles`, which is on the effect path where it belongs.
	 */
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
		// Nothing to be contended with: browser mode has one session and no
		// repository, so no checkpoint and nobody to share a folder with.
		contention: runner.contention,
		record: runner.record,
		// The canned runner has one of these like any other, and it is per session
		// there too — browser mode simply only ever has one session.
		profile: runner.profile,
		// Empty here, for the reason `memorySessions` gives.
		listSessions: runner.listSessions,
		// Empty for the same reason, and by the same code path: a session in
		// memory has entries, it simply starts with none.
		history: runner.history,
		// Undefined here — there is no file — which is what the navigator reads
		// as "not one of the stored rows".
		path: runner.path,
		dispose: runner.dispose,
		// One fixture, no folders to tell apart, and nothing to switch the
		// workbench to. `root` undefined is what the navigator reads as "wherever
		// this window already is".
		enter: async () => undefined,
		// Nothing to name it to: browser mode has one session and no Rust.
		label: () => {},
	};
}




