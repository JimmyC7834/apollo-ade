// What a session runs under, and what switching one means.
//
// Settled in docs/wayfinder/pi-harness/tickets/04-profile-data-model.md: eight
// fields, a tool *map* rather than a list, and a dangling reference refuses
// activation. This file is the data model and the live store; applying a switch
// to a running harness is `provider.ts`, because that is where the harness is.
//
// It is also where the interim env vars come to die. `VITE_AGENT_PROVIDER`,
// `_MODEL`, `_GATE` and `_INSTRUCTIONS` were each "a profile field once profiles
// exist"; they now seed the built-in profiles and nothing else reads them.

import type { ThinkingLevel } from '@earendil-works/pi-agent-core';
// Explicit extension for the same reason `subagent.ts` has one below: this is a
// *value* import now, and `profile.check.ts` runs this file under plain node.
import { isGatePolicy, type GatePolicy } from './gate.ts';
// Explicit extension: `profile.check.ts` runs this file under plain node. The
// import is one way — `subagent.ts` takes only the *type* of a profile back —
// so declaring the delegable rule beside the tool that uses it costs no cycle.
import { delegable } from './subagent.ts';

/**
 * The providers this app can talk to.
 *
 * pi's real provider ids, not labels of ours — `detectCompat` keys off
 * `provider === "deepseek"` and Rust reads the same id to choose a credential.
 * Declared here rather than in `provider.ts` so a profile can name a provider
 * without the data model depending on the harness.
 */
export type ProviderId = 'deepseek' | 'anthropic' | 'google';

export const PROVIDER_IDS: readonly ProviderId[] = ['deepseek', 'anthropic', 'google'];

export interface ProfileModel {
	readonly provider: ProviderId;
	readonly id: string;
}

/** The eight fields. Five match a shipped implementation; three are ours. */
export interface Profile {
	readonly name: string;
	readonly model: ProfileModel;
	readonly thinkingLevel: ThinkingLevel;
	/**
	 * Tool exposure, as a **map and not a list**, following Zed
	 * (`crates/agent_settings/src/agent_profile.rs:107`). The map distinguishes
	 * *explicitly disabled* from *not mentioned*: pi ships a release roughly
	 * every 2.1 days, and a tool added upstream is absent from a list — and so
	 * silently excluded — where absent from a map it falls through to its
	 * default. An unmentioned tool is on.
	 */
	readonly tools: Readonly<Record<string, boolean>>;
	/** Appended to the system prompt, never substituted for it. Ticket 17. */
	readonly instructions?: string;
	readonly skills: readonly string[];
	/** Route shell commands through rtk. Ticket 11; not yet applied. */
	readonly rtk: boolean;
	readonly gatePolicy: GatePolicy;
	/**
	 * Whether a parent agent may spawn this profile as a subagent.
	 *
	 * The tenth field, and the only one
	 * [ticket 24](docs/wayfinder/pi-harness/tickets/24-subagents.md) added: the
	 * dev's premise was that a profile is already a reasonable subagent
	 * definition, and it survived the grill with one flag and one string.
	 *
	 * Off by default, because a profile the author never thought about as a
	 * subagent is not one — unlike a *tool*, where the default-on rule protects
	 * profiles written before the tool existed.
	 */
	readonly subagent: boolean;
	/**
	 * What this profile is for, in the parent model's words rather than the
	 * child's.
	 *
	 * Required once `subagent` is true, and separate from `instructions` on
	 * purpose: `instructions` is what the child is *told*, and this is what the
	 * parent *reads to choose*. Using one string for both would make every
	 * delegable profile advertise its own system prompt.
	 */
	readonly description?: string;
}

/** What the harness actually has, for references to be checked against. */
export interface Capabilities {
	readonly tools: readonly string[];
	readonly skills: readonly string[];
	/**
	 * Tools that are **off** unless a profile names them, inverting the rule
	 * above for user-authored tools only.
	 *
	 * The two closed tickets contradict each other here and this is where they
	 * are reconciled. Ticket 04's default-on exists so a tool *pi* adds upstream
	 * does not vanish from profiles written before it existed — the profile
	 * author never had the chance to mention it. Ticket 13's "adding a tool to a
	 * profile **is** the trust decision" is what justifies user tools not being
	 * asked about at invocation. Default-on would make that false: dropping a
	 * manifest on disk would arm it everywhere and the trust act would never
	 * happen.
	 *
	 * So the rule follows the argument rather than the mechanism: default-on for
	 * tools nobody chose to have, opt-in for tools someone wrote.
	 */
	readonly optIn?: readonly string[];
}

let capabilities: Capabilities = { tools: [], skills: [] };

/**
 * Tell the store what exists.
 *
 * Called once by the provider, which is the only thing that knows — the tool
 * list is built there and the skills come off the harness's own resources.
 * Until it is called nothing is available, so a profile naming a tool would
 * refuse to activate rather than activate against an empty world; the store is
 * only reachable through the provider, so that window is not observable.
 */
export function setCapabilities(next: Capabilities): void {
	capabilities = next;
}

/**
 * What exists, for a UI that has to list it.
 *
 * The profile modal (ticket 43) shows every tool and every skill with a mark
 * against the enabled ones, and this store is already the answer to "every" —
 * asking the provider a second time would be a second answer that could differ.
 */
export function knownCapabilities(): Capabilities {
	return capabilities;
}

/**
 * Everything this profile names that does not exist.
 *
 * Complementary to pi's own check rather than a duplicate of it:
 * `AgentHarness.validateToolNames` **throws** `AgentHarnessError`
 * ("invalid_argument") for an unknown active tool, which as a switch mechanism
 * means an exception in a UI callback. This runs first and turns the same
 * condition into a refusal that names what is missing.
 *
 * Only tools the profile *enables* are checked. Disabling a tool that is not
 * there is not a dangling reference — it is a profile that survived the tool
 * being removed, which is exactly the degradation the map shape was chosen for.
 */
export function danglingReferences(profile: Profile, have: Capabilities = capabilities): string[] {
	const missing: string[] = [];
	if (!PROVIDER_IDS.includes(profile.model.provider)) {
		missing.push(`provider "${profile.model.provider}"`);
	}
	for (const [name, enabled] of Object.entries(profile.tools)) {
		if (enabled && !have.tools.includes(name)) {
			missing.push(`tool "${name}"`);
		}
	}
	for (const name of profile.skills) {
		if (!have.skills.includes(name)) {
			missing.push(`skill "${name}"`);
		}
	}
	return missing;
}

/** Which tools run under this profile, in the order the harness was given them. */
export function activeToolNames(profile: Profile, have: Capabilities = capabilities): string[] {
	// `?? default` rather than `!== false`, so the map's third state — not
	// mentioned — resolves per tool instead of globally. See `optIn`.
	return have.tools.filter((name) => profile.tools[name] ?? !have.optIn?.includes(name));
}

/*
 * The interim env vars.
 *
 * Read through one binding rather than as four `import.meta.env.VITE_*`
 * expressions, because this module builds its profiles at load and
 * `import.meta.env` does not exist under plain `node` — which is what
 * `profile.check.ts` runs on. Vite substitutes the whole object just as
 * happily as it substitutes a single key.
 */
const ENV: Partial<Record<string, string>> = import.meta.env ?? {};

function envModel(): ProfileModel {
	const provider = (ENV.VITE_AGENT_PROVIDER ?? 'deepseek') as ProviderId;
	return {
		provider: PROVIDER_IDS.includes(provider) ? provider : 'deepseek',
		id: ENV.VITE_AGENT_MODEL ?? '',
	};
}

function envGatePolicy(): GatePolicy {
	// `careful` is still accepted, and means `ask`. It was the name for four
	// slices and it is in people's `.env` files; silently falling back to `auto`
	// would turn a stated preference for being asked into never being asked.
	const raw = ENV.VITE_AGENT_GATE === 'careful' ? 'ask' : ENV.VITE_AGENT_GATE;
	return isGatePolicy(raw) ? raw : 'auto';
}

function envInstructions(): string | undefined {
	return ENV.VITE_AGENT_INSTRUCTIONS || undefined;
}

/**
 * The profiles shipped with the app.
 *
 * Built-ins rather than a blank slate, which is decision 5 and the thing that
 * makes the feature usable on first run — Zed does the same. `auto` is the gate
 * default from ticket 03; `ask` and `plan` are the two switches worth having
 * before there is a profile editor, and `plan` is the one that exercises the
 * tool map rather than merely carrying it.
 *
 * They all name the same model, because the model still comes from an env var
 * and there is no picker. That is the one place the collapse of the env vars is
 * incomplete, and it stays that way until a profile file exists to name a
 * second model in.
 */
export function builtinProfiles(): Profile[] {
	const instructions = envInstructions();
	const base: Profile = {
		name: 'auto',
		model: envModel(),
		thinkingLevel: 'medium',
		tools: {},
		instructions,
		skills: [],
		rtk: false,
		gatePolicy: envGatePolicy(),
		// No built-in is delegable. A subagent runs unattended, so which profiles
		// one may be is the user's decision to write down rather than ours to ship
		// a default for.
		subagent: false,
	};
	return [
		base,
		{ ...base, name: 'ask', gatePolicy: 'ask' },
		{
			...base,
			name: 'plan',
			thinkingLevel: 'high',
			gatePolicy: 'auto',
			// The tools are what makes this a plan mode; the instruction only
			// explains the refusal the model is about to meet. A prompt that asks
			// for read-only behaviour and leaves `write` enabled is a suggestion.
			tools: { write: false, edit: false },
			instructions: [instructions, 'Do not modify anything. Investigate, then propose a plan.']
				.filter(Boolean)
				.join('\n\n'),
		},
	];
}

let profiles = builtinProfiles();
let active: Profile = profiles[0];

const listeners = new Set<(profile: Profile) => void>();

export function listProfiles(): readonly Profile[] {
	return profiles;
}

/*
 * Reading a profile out of a file.
 *
 * The file is hand-written JSON, so every field is `unknown` until proven
 * otherwise. The policy throughout is **a bad field is dropped and reported,
 * never fatal**: one typo in `thinkingLevel` must not cost the user the other
 * seven fields, and a file that fails to load entirely would leave someone
 * staring at built-ins wondering why their profile did nothing. The refusal
 * ticket 04 decided on is about *activation*, not parsing — and it still
 * applies, because a dropped field can leave a profile whose references dangle.
 */

/** pi's own order (`pi-ai/dist/models.js:391`), which is not exported. */
const THINKING_LEVELS: readonly ThinkingLevel[] = [
	'off',
	'minimal',
	'low',
	'medium',
	'high',
	'xhigh',
	'max',
];

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Apply one file entry over a base profile, field by field.
 *
 * Field-level rather than wholesale replacement, which is what makes "users
 * override built-ins" true in the useful sense: `{"name": "plan",
 * "thinkingLevel": "max"}` should retune `plan` and keep its tool map, not
 * replace it with a profile that has none.
 */
function applyDefinition(base: Profile, raw: Record<string, unknown>, problems: string[]): Profile {
	const name = raw.name as string;
	const reject = (field: string, saw: unknown) =>
		problems.push(`profile "${name}": ignoring ${field} (${JSON.stringify(saw) ?? 'undefined'})`);

	const next: {
		-readonly [K in keyof Profile]: Profile[K];
	} = { ...base, name };

	if (raw.model !== undefined) {
		const model = raw.model;
		if (isRecord(model) && typeof model.id === 'string' && typeof model.provider === 'string') {
			// An unknown provider is *kept*, not corrected: `danglingReferences`
			// reports it by name at activation, which is a better error than
			// silently running on a provider the user did not ask for.
			next.model = { provider: model.provider as ProviderId, id: model.id };
		} else {
			reject('model', model);
		}
	}

	if (raw.thinkingLevel !== undefined) {
		if (THINKING_LEVELS.includes(raw.thinkingLevel as ThinkingLevel)) {
			next.thinkingLevel = raw.thinkingLevel as ThinkingLevel;
		} else {
			reject('thinkingLevel', raw.thinkingLevel);
		}
	}

	if (raw.tools !== undefined) {
		if (isRecord(raw.tools) && Object.values(raw.tools).every((on) => typeof on === 'boolean')) {
			// Merged over the base map rather than replacing it, for the same
			// reason the map exists at all: a file that mentions one tool is
			// saying something about that tool and nothing about the rest.
			next.tools = { ...base.tools, ...(raw.tools as Record<string, boolean>) };
		} else {
			reject('tools', raw.tools);
		}
	}

	if (raw.instructions !== undefined) {
		if (typeof raw.instructions === 'string') {
			next.instructions = raw.instructions || undefined;
		} else {
			reject('instructions', raw.instructions);
		}
	}

	if (raw.skills !== undefined) {
		if (Array.isArray(raw.skills) && raw.skills.every((skill) => typeof skill === 'string')) {
			next.skills = raw.skills as string[];
		} else {
			reject('skills', raw.skills);
		}
	}

	if (raw.rtk !== undefined) {
		if (typeof raw.rtk === 'boolean') {
			next.rtk = raw.rtk;
		} else {
			reject('rtk', raw.rtk);
		}
	}

	if (raw.subagent !== undefined) {
		if (typeof raw.subagent === 'boolean') {
			next.subagent = raw.subagent;
		} else {
			reject('subagent', raw.subagent);
		}
	}

	if (raw.description !== undefined) {
		if (typeof raw.description === 'string') {
			next.description = raw.description || undefined;
		} else {
			reject('description', raw.description);
		}
	}

	if (raw.gatePolicy !== undefined) {
		// `careful` is the old name for `ask`, translated rather than rejected —
		// a hand-written profile file predates the rename, and rejecting the field
		// would leave that profile on `auto`, which is the opposite of what it says.
		if (raw.gatePolicy === 'careful') {
			next.gatePolicy = 'ask';
		} else if (isGatePolicy(raw.gatePolicy)) {
			next.gatePolicy = raw.gatePolicy;
		} else {
			reject('gatePolicy', raw.gatePolicy);
		}
	}

	return next;
}

/**
 * Replace the profile set with the built-ins plus whatever the files defined.
 *
 * `definitions` arrives already ordered — global first, then project — and a
 * later entry with the same name merges over an earlier one, which is decision
 * 4's "project wins" without a second merge pass. Built-ins are the base, so a
 * file that names `plan` retunes it and a file that names `cheap` adds it.
 *
 * The active profile is re-resolved **by name** and its listeners fire, so a
 * reloaded definition of the profile you are already on takes effect rather than
 * waiting for a switch. If the file dropped that name, the session falls back to
 * the first profile rather than holding a profile no longer in the list.
 */
export function installProfiles(definitions: readonly unknown[], problems: string[] = []): string[] {
	const merged = new Map(builtinProfiles().map((profile) => [profile.name, profile]));
	const fallback = merged.get('auto') as Profile;

	for (const definition of definitions) {
		if (!isRecord(definition) || typeof definition.name !== 'string' || !definition.name) {
			problems.push(`ignoring a profile with no "name": ${JSON.stringify(definition)}`);
			continue;
		}
		const base = merged.get(definition.name) ?? fallback;
		merged.set(definition.name, applyDefinition(base, definition, problems));
	}

	profiles = [...merged.values()];

	// Reported here rather than where the delegable list is read, because
	// `/reload` is the moment the user can act on it — and reading it happens on
	// every turn, which would repeat the warning forever.
	delegable(profiles, problems);

	/*
	 * Re-resolving the active profile is the one place a switch can happen
	 * without anyone asking for one, so it makes decision 2's argument itself
	 * rather than inheriting it from `activateProfile`: a file that redefines
	 * the profile you are running under must not be able to leave the session on
	 * one whose references dangle. `auto` is the fallback because it is a
	 * built-in and therefore cannot be the thing that broke.
	 */
	const candidate = profiles.find((profile) => profile.name === active.name) ?? profiles[0];
	const missing = danglingReferences(candidate);
	if (missing.length > 0) {
		problems.push(
			`profile "${candidate.name}" names things that do not exist: ${missing.join(', ')}. Falling back to "${profiles[0].name}".`
		);
		active = profiles[0];
	} else {
		active = candidate;
	}

	for (const listener of listeners) {
		listener(active);
	}
	return problems;
}

export function activeProfile(): Profile {
	return active;
}

/** Watch for switches. Returns its disposer, following `harness.on`. */
export function onProfileChange(listener: (profile: Profile) => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

export type Activation =
	| { readonly ok: true; readonly profile: Profile }
	| { readonly ok: false; readonly reason: string };

/**
 * Switch, or refuse and say why.
 *
 * **A dangling reference refuses activation** (decision 2). The session stays on
 * the previous profile. An agent running with quietly-different capabilities
 * than its profile claims is a worse failure than an irritating one, and it is
 * invisible — the user would attribute the degraded behaviour to the model.
 *
 * The switch is non-retroactive by construction: nothing here touches history.
 */
export function activateProfile(name: string): Activation {
	const profile = profiles.find((candidate) => candidate.name === name);
	if (!profile) {
		return { ok: false, reason: `No profile named "${name}".` };
	}
	const missing = danglingReferences(profile);
	if (missing.length > 0) {
		return {
			ok: false,
			reason: `Profile "${name}" names things that do not exist: ${missing.join(', ')}. Staying on "${active.name}".`,
		};
	}
	active = profile;
	for (const listener of listeners) {
		listener(profile);
	}
	return { ok: true, profile };
}
