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
import type { GatePolicy } from './gate';

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
}

/** What the harness actually has, for references to be checked against. */
export interface Capabilities {
	readonly tools: readonly string[];
	readonly skills: readonly string[];
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
	return have.tools.filter((name) => profile.tools[name] !== false);
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
	return ENV.VITE_AGENT_GATE === 'careful' ? 'careful' : 'auto';
}

function envInstructions(): string | undefined {
	return ENV.VITE_AGENT_INSTRUCTIONS || undefined;
}

/**
 * The profiles shipped with the app.
 *
 * Built-ins rather than a blank slate, which is decision 5 and the thing that
 * makes the feature usable on first run — Zed does the same. `auto` is the gate
 * default from ticket 03; `careful` and `plan` are the two switches worth having
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
	};
	return [
		base,
		{ ...base, name: 'careful', gatePolicy: 'careful' },
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

const profiles = builtinProfiles();
let active: Profile = profiles[0];

const listeners = new Set<(profile: Profile) => void>();

export function listProfiles(): readonly Profile[] {
	return profiles;
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
