// Which skills exist, and which of them this profile permits.
//
// docs/wayfinder/pi-harness/tickets/20-skills.md. A skill is a directory with a
// `SKILL.md` in it, holding instructions for one task — the
// [Agent Skills standard](https://agentskills.io/specification), which pi
// implements and Claude Code and Codex also write.
//
// **Almost nothing here is ours.** pi's `loadSkills` walks the directories over
// our own `ExecutionEnv`, parses the front matter, honours ignore files and
// reports its own diagnostics; `formatSkillsForSystemPrompt` writes the listing;
// `formatSkillInvocation` builds the turn. What this file adds is the two things
// pi's core deliberately leaves to the application: **where to look**, and
// **which skill wins when two share a name**. `loadSourcedSkills` exists for
// exactly this and says so — "the agent package does not interpret source
// values; applications define their own provenance shape."
//
// The store shape follows `profile.ts` and `userTools.ts`: one module-level set,
// installed by a loader, with a change callback the provider subscribes to.
// Loading is I/O and cannot happen before the workspace root is chosen, so it is
// driven from `profileFiles.ts` — one call reads every hand-authored thing, and
// `/reload` gets skills for free.

import { loadSkills as loadSkillsFrom, type ExecutionEnv, type Skill } from '@earendil-works/pi-agent-core';

import type { Profile } from './profile';

/**
 * The global skills directory, seen through the mount.
 *
 * Not an OS path: `workspace.rs` maps ids under `.skills` to the folder beside
 * the global profiles file, so this is the same root-relative namespace every
 * other file uses and the renderer still never learns a real path. The mount is
 * why the *model* can read a global skill — it reads `/.skills/x/SKILL.md`
 * through the ordinary `read` tool, and so do a skill's own relative references.
 */
export const GLOBAL_SKILLS = '/.skills';

/**
 * The project skills directory.
 *
 * `.agents/skills` rather than `.ade/skills`, for the reason `profileFiles.ts`
 * gives about the project profiles file: `.ade` is gitignored by `*` and skipped
 * by `list_tree`, so a skill meant to be committed and read would be neither.
 * `.agents/skills` is also the standard's project location and one of the four
 * pi itself reads, so a project shared with another harness needs no second copy.
 */
export const PROJECT_SKILLS = '/.agents/skills';

export interface SkillSet {
	readonly skills: readonly Skill[];
	/** Everything ignored or overridden, and why. Empty is the normal case. */
	readonly warnings: readonly string[];
}

/**
 * Merge the two directories, project winning.
 *
 * **pi merges the other way** — its client takes the user directory first and
 * reports the project one as a collision. Its reason is trust: pi does not
 * trust a project until you approve it. That reason does not carry here, because
 * a skill does nothing until a profile names it, so trust is already settled
 * before a name is looked up. What is left is specificity, and the project is
 * more specific — which is also the rule the two profiles files already follow.
 * One merge rule for both is worth more than agreeing with upstream.
 *
 * A collision **warns and continues**. Both files exist and one of them works;
 * refusing the profile over it would be punishing a name clash. But the loser is
 * now dead code on someone's disk, so it is said out loud rather than dropped.
 */
export function mergeSkills(global: readonly Skill[], project: readonly Skill[]): SkillSet {
	const byName = new Map<string, Skill>();
	const warnings: string[] = [];
	for (const skill of global) {
		byName.set(skill.name, skill);
	}
	for (const skill of project) {
		const beaten = byName.get(skill.name);
		if (beaten) {
			warnings.push(
				`two skills are named "${skill.name}": using ${skill.filePath}, ignoring ${beaten.filePath}`
			);
		}
		byName.set(skill.name, skill);
	}
	return { skills: [...byName.values()], warnings };
}

/**
 * The skills this profile permits, in the order they were loaded.
 *
 * Default **off**, which is user tools' rule rather than the `tools` map's.
 * Ticket 04 made an unmentioned tool *on* so that a tool pi adds upstream does
 * not vanish from a profile written before it existed — the author never had the
 * chance to mention it. That argument is about tools arriving from a dependency.
 * A skill arrives because someone put a directory on this machine, and ticket
 * 13's rule covers that case: naming it in a profile **is** the trust decision,
 * so a skill dropped on disk arms nothing.
 */
export function permittedSkills(all: readonly Skill[], profile: Profile): readonly Skill[] {
	const wanted = new Set(profile.skills);
	return all.filter((skill) => wanted.has(skill.name));
}

/**
 * What `/skills` says.
 *
 * Here rather than in the JSX that renders it, for the reason `transcript.ts`
 * and `thinkingUnavailable` are: a rule inside a `.tsx` cannot be checked, and
 * three of the four states below are ones nothing else in the app reports.
 *
 * A skill can be **on disk and unpermitted** (the default, and the one a user
 * will hit first), **permitted**, or **shadowed** by a name clash. A fourth,
 * having no `description`, is invisible even here: pi drops those without a
 * diagnostic, so the only symptom is a skill that never appears. The list says
 * where the directories are for exactly that case.
 */
export function describeSkills(
	all: readonly Skill[],
	profile: Profile,
	warnings: readonly string[],
	globalPath?: string
): string {
	const permitted = new Set(permittedSkills(all, profile).map((skill) => skill.name));
	const lines =
		all.length > 0
			? all.map(
					(skill) =>
						`${permitted.has(skill.name) ? '●' : '○'} ${skill.name} — ${skill.description}`
				)
			: ['No skills found.'];
	return [
		...lines,
		// The half a user who wrote a skill and saw nothing happen is missing.
		// Same sentence shape as `/profile` uses for user tools, and the same
		// reason: being on disk is not being enabled.
		`\nA profile must name a skill in "skills" to enable it; "${profile.name}" names ` +
			`${profile.skills.length > 0 ? profile.skills.join(', ') : 'none'}.`,
		...(warnings.length > 0 ? ['', ...warnings] : []),
		`\nRead from ${PROJECT_SKILLS.slice(1)} (this project)` +
			`${globalPath ? ` and ${globalPath} (global)` : ''}.` +
			` A skill is a directory holding a SKILL.md with a name and a description.` +
			` Edit either and run /reload.`,
	].join('\n');
}

let source: ExecutionEnv | undefined;
let globalPath: string | undefined;
let set: SkillSet = { skills: [], warnings: [] };
const listeners = new Set<() => void>();

/**
 * Tell the store which filesystem to read.
 *
 * Called by the provider, which owns the `ExecutionEnv` — the same reason it is
 * the only caller of `setCapabilities`. Until it is called, `reloadSkills` finds
 * nothing, which is the right answer in browser mode: the memory environment has
 * no skill directories and inventing some would be the parallel fiction ticket
 * 10 ruled out.
 */
export function useSkillSource(env: ExecutionEnv): void {
	source = env;
}

/** Every skill on disk, whether or not the active profile permits it. */
export function allSkills(): readonly Skill[] {
	return set.skills;
}

/** What went wrong last load. Shown by `/skills`, not at startup. */
export function skillWarnings(): readonly string[] {
	return set.warnings;
}

export function onSkillsChange(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

/**
 * Read both directories and install what they hold.
 *
 * Always resolves. `loadSkills` reports every failure as a diagnostic rather
 * than throwing, and a missing directory is not even that — it is the normal
 * state and is skipped silently.
 *
 * The diagnostics are kept but not raised. A skill with no `description` is
 * dropped by pi without a diagnostic at all, and a name that does not match its
 * directory is only a warning. The case that matters is already covered
 * elsewhere: a profile naming a skill that did not load fails
 * `danglingReferences` and refuses to activate, which names it.
 */
export async function reloadSkills(where?: string): Promise<void> {
	globalPath = where ?? globalPath;
	if (!source) {
		return;
	}
	// Two calls rather than one with both directories, because pi's flat result
	// carries no provenance and the merge rule needs to know which is which.
	const global = await loadSkillsFrom(source, GLOBAL_SKILLS);
	const project = await loadSkillsFrom(source, PROJECT_SKILLS);
	const merged = mergeSkills(global.skills, project.skills);
	set = {
		skills: merged.skills,
		warnings: [
			...merged.warnings,
			...[...global.diagnostics, ...project.diagnostics].map(
				(problem) => `${problem.path}: ${problem.message}`
			),
		],
	};
	for (const listener of listeners) {
		listener();
	}
}

/** `describeSkills` over the installed set, for the one caller that renders it. */
export function skillList(profile: Profile): string {
	return describeSkills(set.skills, profile, set.warnings, globalPath);
}
