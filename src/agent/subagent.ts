// Delegation: a profile, run as a second agent, from inside a turn.
//
// Settled in docs/wayfinder/pi-harness/tickets/24-subagents.md. **pi has no
// subagent concept** — `subagent`, `spawnAgent`, `forkSession` and `childAgent`
// return nothing across its whole `dist` — and it does not need one, because
// `AgentHarness` is already the unit of one agent: no registry, no singleton, no
// global state. A second agent is one `new`.
//
// So this file is the *tool*, and nothing else. Building the child harness is
// `provider.ts`, because that is where the environment, the models and the
// session repo are. The seam between them is `SubagentHost`.
//
// Not to be confused with pi's session **branching** (`getBranch`,
// `branch_summary`), which is one conversation splitting in two. A subagent is a
// different agent with a different session, and the two do not share a word.

import { Type } from 'typebox';
// Explicit extension, like `events.ts` — this module is reachable from a check
// script, which node resolves without Vite's help.
import type { Profile } from './profile.ts';
import type { AgentEvent } from './index.ts';
import type { AgentHarnessTool } from '@earendil-works/pi-agent-core';

/** What the model calls. Named for the job, not for the mechanism. */
export const TASK_TOOL = 'task';

/**
 * How many children may run at once, across every depth.
 *
 * A constant, and configuration for it is deferred. No cap at all would let one
 * model call start twelve agents against one API key and one working tree; a
 * per-profile cap would be configuration for a constant.
 */
export const MAX_CONCURRENT = 4;

/** Including the main agent, so a child may delegate once and its child may not. */
export const MAX_DEPTH = 3;

/**
 * Wall clock, not tool calls.
 *
 * A tool-call budget counts actions, so it kills a child reading sixty files
 * correctly and a child stuck in a cheap loop at the same number. Time is the
 * question a person actually asks about a background job. Configurable in
 * settings later; deferred.
 */
export const TIMEOUT_MS = 15 * 60 * 1000;

/** A profile the parent model may pick, and the words it picks by. */
export interface Delegable {
	readonly name: string;
	readonly description: string;
}

export interface DelegationRequest {
	readonly profile: Profile;
	readonly label: string;
	readonly prompt: string;
	/** The child's own depth, already checked against `MAX_DEPTH`. */
	readonly depth: number;
	/** Aborted by the parent turn's cancellation, or by the timeout. */
	readonly signal: AbortSignal;
	/** The child's latest activity, one line, newest wins. */
	readonly onLine: (line: string) => void;
}

export interface Delegation {
	/** What the child answered. Its own report of failure is a normal answer. */
	readonly answer: string;
	/**
	 * The child's usage, kept apart from the parent's.
	 *
	 * Adding it to the parent's meter would corrupt the number auto-compaction
	 * divides by — the parent's window is not fuller because a child read a file.
	 * Showing the two together is a UI decision, deferred; this is the tracking
	 * the decision needs to already exist.
	 */
	readonly inputTokens: number;
	readonly outputTokens: number;
	/**
	 * What the child spent, in dollars, on the same terms as its tokens: its
	 * own, and never added to the parent's.
	 *
	 * Undefined when the child's model has no known rates — which is not the
	 * same as zero, and is a distinction the child can make independently of its
	 * parent because a delegation may well run on a different model.
	 */
	readonly cost?: number;
}

export interface SubagentHost {
	/** Which profiles are delegable right now. Re-read on every call. */
	delegable(): readonly Delegable[];
	/** Resolve a name to the profile to run it under. */
	profile(name: string): Profile | undefined;
	run(request: DelegationRequest): Promise<Delegation>;
}

/**
 * Which profiles a parent model may spawn, and which claim to and cannot.
 *
 * `subagent: true` with no description is **dropped with a warning** rather than
 * offered: the parent model chooses the child, so it has to be told what each
 * profile is for, and `instructions` is what the child is *told* rather than
 * what the parent *reads*. This is Slice 35's shadowed-template rule, and one
 * rule for both beats two. The profile still works for the user; it is only
 * invisible to the parent.
 */
export function delegable(profiles: readonly Profile[], problems: string[] = []): Delegable[] {
	const ready: Delegable[] = [];
	for (const profile of profiles) {
		if (!profile.subagent) {
			continue;
		}
		if (!profile.description?.trim()) {
			problems.push(
				`profile "${profile.name}": subagent is true but there is no "description", ` +
					'so the agent cannot be told what to delegate to it. Not offering it.'
			);
			continue;
		}
		ready.push({ name: profile.name, description: profile.description.trim() });
	}
	return ready;
}

/** One field of the progress line, shortened where it has to be. */
function clip(text: string, max: number): string {
	const flat = text.replace(/\s+/g, ' ').trim();
	return flat.length > max ? `${flat.slice(0, max)}...` : flat;
}

/**
 * The one line a delegation shows in the main chat.
 *
 * `researcher - research rtk and... - [read file r...]` — the profile, the label
 * the model wrote, and the child's latest activity. The label is the model's and
 * not the profile name, because three parallel children of one profile would
 * otherwise read alike; and not the prompt's first line, because that is a
 * sentence.
 *
 * The child chat view is deferred (ticket 24), so this line is the whole of what
 * a delegation looks like until it lands.
 */
export function progressLine(profile: string, label: string, latest: string): string {
	const parts = [clip(profile, 24), clip(label, 32)];
	const activity = clip(latest, 24);
	return activity ? `${parts.join(' - ')} - [${activity}]` : parts.join(' - ');
}

/** The first string a tool was given, which is nearly always the thing it acts on. */
function subject(input: unknown): string {
	if (typeof input !== 'object' || input === null) {
		return '';
	}
	const first = Object.values(input as Record<string, unknown>).find(
		(value) => typeof value === 'string' && value.trim()
	);
	return typeof first === 'string' ? first : '';
}

/**
 * What the child is doing, from its own event stream.
 *
 * **Tool calls and prose produce a line; nothing else does.** `usage` and
 * `queued` are bookkeeping. Thinking is deliberately excluded even though it
 * would make the line livelier: a child that reasons for a minute between tool
 * calls would otherwise scroll its reasoning through the parent's transcript,
 * and the one line is a status, not a second conversation.
 *
 * Prose accumulates rather than replacing, because `text` arrives in chunks and
 * a line rebuilt from the newest chunk shows single words. It resets when a tool
 * call starts, so the line follows the child's current activity rather than
 * growing all turn.
 *
 * Stateful, so one of these belongs to one child.
 */
export function createActivity(): (event: AgentEvent) => string | undefined {
	let prose = '';
	return (event) => {
		if (event.kind === 'tool_start') {
			prose = '';
			const acting = subject(event.input);
			return acting ? `${event.name} ${acting}` : event.name;
		}
		if (event.kind === 'tool_end') {
			prose = '';
			return undefined;
		}
		if (event.kind === 'text') {
			prose += event.text;
			return prose.trim() || undefined;
		}
		if (event.kind === 'error') {
			return event.message;
		}
		return undefined;
	};
}

/**
 * Wait for a slot, run, and hand it on.
 *
 * pi executes a batch of tool calls in parallel unless a tool declares
 * `executionMode: "sequential"` (`agent-loop.js:290`), so a model asking for six
 * children really does start six. They queue rather than being refused: a
 * refusal loses a delegation the model meant, and it would arrive as a failure
 * the model then has to reason about.
 */
function limiter(max: number) {
	let running = 0;
	const waiting: (() => void)[] = [];
	return async function slot<T>(work: () => Promise<T>): Promise<T> {
		if (running >= max) {
			await new Promise<void>((resolve) => waiting.push(resolve));
		}
		running += 1;
		try {
			return await work();
		} finally {
			running -= 1;
			waiting.shift()?.();
		}
	};
}

/** The reason a child stopped early, or nothing when it finished. */
export function timeoutNote(ms: number): string {
	return `The subagent did not finish within ${Math.round(ms / 60_000)} minutes and was stopped. What it had reached is above.`;
}

/**
 * The delegation tool.
 *
 * Built once and shared by every harness in the runner, at every depth: the
 * depth it is running at arrives in the **tool context**, which pi resolves per
 * turn snapshot (`AgentHarnessTool.execute`'s last argument). One instance
 * therefore serves a parent and its children without a tool set per level.
 *
 * `execute` **throws** for everything the model can correct — an unknown
 * profile, a profile that is not delegable, a delegation past the depth limit.
 * pi turns the throw into an ordinary error `tool_result`, so the model fixes it
 * inside the same turn; that is [ticket 18](18-tool-reaches-the-gate.md)'s
 * pattern, and it is why these are not exceptions that end the turn.
 *
 * A child that *ran* and did not achieve the job is the other kind of failure
 * entirely, and it returns normally with the child's own account of it.
 */
export function createTaskTool(host: SubagentHost): AgentHarnessTool<{ depth: number }> {
	const slot = limiter(MAX_CONCURRENT);

	return {
		name: TASK_TOOL,
		label: TASK_TOOL,
		/*
		 * A getter, because the delegable set changes under a built tool: `/reload`
		 * rewrites the profiles and the tool object is built once. pi reads
		 * `description` while building each request, so this is live at no cost —
		 * the alternative was rebuilding the tool set on every profile switch,
		 * which churns `setTools` for a string.
		 */
		get description(): string {
			const offered = host.delegable();
			if (offered.length === 0) {
				return 'Delegate a sub-task to another agent. No profiles are currently delegable, so this tool cannot be used.';
			}
			return [
				'Delegate a sub-task to another agent, which runs on its own and reports back.',
				'Use it when a sub-task would flood this conversation with detail you do not need to keep.',
				'The subagent starts from your prompt and nothing else: it cannot see this conversation, so the prompt is the whole brief.',
				'',
				'Profiles you can delegate to:',
				...offered.map((profile) => `- ${profile.name}: ${profile.description}`),
			].join('\n');
		},
		parameters: Type.Object({
			profile: Type.String({ description: 'Which profile to run the subagent under.' }),
			label: Type.String({
				description:
					'A few words naming this sub-task, shown to the user while it runs. Not the profile name.',
			}),
			prompt: Type.String({
				description:
					'The whole brief for the subagent. It sees nothing of this conversation, so include the context it needs.',
			}),
		}),
		async execute(_callId, params, signal, onUpdate, context) {
			const { profile: name, label, prompt } = params as {
				profile: string;
				label: string;
				prompt: string;
			};

			const offered = host.delegable();
			const chosen = offered.find((candidate) => candidate.name === name);
			if (!chosen) {
				throw new Error(
					offered.length === 0
						? `There are no delegable profiles, so "${name}" cannot be run. A profile needs "subagent": true and a "description".`
						: `No delegable profile named "${name}". Available: ${offered.map((one) => one.name).join(', ')}.`
				);
			}
			const profile = host.profile(name);
			if (!profile) {
				throw new Error(`Profile "${name}" went away before the subagent could start.`);
			}

			const depth = context.depth + 1;
			if (depth > MAX_DEPTH) {
				throw new Error(
					`Subagents may nest ${MAX_DEPTH} deep including you, and this would be ${depth}. Do this part of the work yourself.`
				);
			}

			/*
			 * One controller for both ways a child stops early. The parent's
			 * cancellation arrives on `signal` — pi aborts the running tool call —
			 * and the budget arrives on the timer; the child cannot tell them apart
			 * and does not need to, because only the report differs.
			 */
			const controller = new AbortController();
			let expired = false;
			const timer = setTimeout(() => {
				expired = true;
				controller.abort();
			}, TIMEOUT_MS);
			const stop = () => controller.abort();
			signal?.addEventListener('abort', stop, { once: true });

			let latest = '';
			const show = () =>
				onUpdate?.({
					content: [{ type: 'text', text: progressLine(name, label, latest) }],
					details: undefined,
				});
			show();

			try {
				const done = await slot(() =>
					host.run({
						profile,
						label,
						prompt,
						depth,
						signal: controller.signal,
						onLine: (line) => {
							latest = line;
							show();
						},
					})
				);

				// The parent's cancellation is not a task failure to report back —
				// the turn that would read it is being torn down. Only the budget
				// produces an answer.
				const answer = expired
					? [done.answer.trim(), timeoutNote(TIMEOUT_MS)].filter(Boolean).join('\n\n')
					: done.answer.trim() || '(the subagent finished without saying anything)';

				return {
					content: [{ type: 'text', text: answer }],
					details: {
						profile: name,
						label,
						depth,
						timedOut: expired,
						// Kept, not shown. See `Delegation`.
						inputTokens: done.inputTokens,
						outputTokens: done.outputTokens,
						// Absent rather than zero on an unpriced model, so a reader of
						// these details cannot read "we do not know" as "it was free".
						...(done.cost === undefined ? {} : { cost: done.cost }),
					},
				};
			} finally {
				clearTimeout(timer);
				signal?.removeEventListener('abort', stop);
			}
		},
	};
}
