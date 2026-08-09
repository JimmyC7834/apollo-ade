// Run with `npm run check`.
//
// The delegation tool without a model, a session or a harness — the whole point
// of `SubagentHost` being a seam. What is asserted here is the set of decisions
// from docs/wayfinder/pi-harness/tickets/24-subagents.md that a type cannot
// carry: which profiles are offered, which failures the model can correct,
// depth, the concurrency cap, and what the one progress line says.

import assert from 'node:assert/strict';
import {
	MAX_CONCURRENT,
	MAX_DEPTH,
	createActivity,
	createTaskTool,
	delegable,
	progressLine,
	type Delegation,
	type DelegationRequest,
	type SubagentHost,
} from './subagent.ts';
import type { Profile } from './profile.ts';
import type { AgentEvent } from './index.ts';

const BASE: Profile = {
	name: 'base',
	model: { provider: 'deepseek', id: 'deepseek-chat' },
	thinkingLevel: 'medium',
	tools: {},
	skills: [],
	rtk: false,
	gatePolicy: 'auto',
	subagent: false,
};

const profile = (over: Partial<Profile>): Profile => ({ ...BASE, ...over });

// --- Which profiles a parent may spawn -------------------------------------

// A flag alone is not enough. The parent model *chooses* the child, so it has to
// be told what each profile is for — and `instructions` is what the child is
// told, which is a different string for a different reader.
{
	const problems: string[] = [];
	const offered = delegable(
		[
			profile({ name: 'auto' }),
			profile({ name: 'researcher', subagent: true, description: '  reads and reports  ' }),
			profile({ name: 'nameless', subagent: true }),
			profile({ name: 'blank', subagent: true, description: '   ' }),
			// A description without the flag is not an offer. Saying what a profile
			// is for must not be the thing that arms it.
			profile({ name: 'described', description: 'not delegable' }),
		],
		problems
	);

	assert.deepEqual(offered, [{ name: 'researcher', description: 'reads and reports' }]);
	assert.equal(problems.length, 2, `named every drop: ${problems.join(' | ')}`);
	assert.ok(problems.every((problem) => /description/.test(problem)));
	assert.ok(problems.some((problem) => problem.includes('"nameless"')));
	assert.ok(problems.some((problem) => problem.includes('"blank"')));
}

// --- The one line a delegation shows ---------------------------------------

{
	assert.equal(
		progressLine('researcher', 'research rtk and report back', 'read src/main.ts'),
		'researcher - research rtk and report back - [read src/main.ts]'
	);

	// Long fields are clipped rather than wrapped: this is one line inside a tool
	// call, not a paragraph.
	const long = progressLine(
		'researcher',
		'work out whether the filter engine can be vendored at all',
		'bash cargo test --manifest-path src-tauri/Cargo.toml'
	);
	assert.ok(long.length < 100, long);
	assert.ok(long.includes('...'));

	// Newlines in a child's prose must not break the line into two.
	assert.ok(!progressLine('p', 'l', 'first\nsecond').includes('\n'));

	// Nothing has happened yet, so there is no bracket rather than an empty one.
	assert.equal(progressLine('researcher', 'research rtk', ''), 'researcher - research rtk');
}

// --- What counts as activity ------------------------------------------------

// Tool calls and prose produce a line; nothing else does. Thinking is excluded
// on purpose: a child that reasons for a minute would otherwise scroll its
// reasoning through the parent's transcript, and this line is a status.
{
	const activity = createActivity();
	assert.equal(activity({ kind: 'thinking', text: 'hmm' }), undefined);
	assert.equal(activity({ kind: 'usage', inputTokens: 9, outputTokens: 9, contextTokens: 9 }), undefined);
	assert.equal(activity({ kind: 'queued', steer: ['x'], followUp: [] }), undefined);

	// Prose accumulates rather than replacing: `text` arrives in chunks, and a
	// line rebuilt from the newest chunk shows single words.
	assert.equal(activity({ kind: 'text', text: 'Reading ' }), 'Reading');
	assert.equal(activity({ kind: 'text', text: 'the manifest' }), 'Reading the manifest');

	// A tool call resets it, so the line follows what the child is doing now
	// rather than growing all turn.
	assert.equal(
		activity({ kind: 'tool_start', id: 't1', name: 'read', input: { path: 'Cargo.toml' } }),
		'read Cargo.toml'
	);
	assert.equal(activity({ kind: 'tool_end', id: 't1', result: 'ok', isError: false }), undefined);
	assert.equal(activity({ kind: 'text', text: 'Done' }), 'Done');

	// A tool with nothing string-shaped to name still says what ran.
	assert.equal(activity({ kind: 'tool_start', id: 't2', name: 'ls', input: {} }), 'ls');
}

// --- The tool ---------------------------------------------------------------

const RESEARCHER = profile({
	name: 'researcher',
	subagent: true,
	description: 'reads the repository and reports back',
});

/** A host that records what it was asked for and answers without a harness. */
function fakeHost(
	profiles: readonly Profile[],
	run: (request: DelegationRequest) => Promise<Delegation> = async () => ({
		answer: 'done',
		inputTokens: 10,
		outputTokens: 3,
	})
): SubagentHost & { seen: DelegationRequest[] } {
	const seen: DelegationRequest[] = [];
	return {
		seen,
		delegable: () => delegable(profiles),
		profile: (name) => profiles.find((candidate) => candidate.name === name),
		run: (request) => {
			seen.push(request);
			return run(request);
		},
	};
}

const call = (
	tool: ReturnType<typeof createTaskTool>,
	params: { profile: string; label: string; prompt: string },
	depth = 1,
	signal?: AbortSignal
) => tool.execute('c1', params, signal, undefined, { depth });

// The description is where the parent model learns what it may delegate to, and
// it is a getter because `/reload` changes that set under a tool built once.
{
	const profiles = [profile({ name: 'auto' })];
	const host: SubagentHost = {
		delegable: () => delegable(profiles),
		profile: (name) => profiles.find((candidate) => candidate.name === name),
		run: async () => ({ answer: '', inputTokens: 0, outputTokens: 0 }),
	};
	const tool = createTaskTool(host);
	assert.match(tool.description, /No profiles are currently delegable/);

	profiles.push(RESEARCHER);
	assert.match(tool.description, /researcher: reads the repository/, 'the same tool, reloaded');
}

// Everything the model can correct is a *thrown* error, which pi turns into an
// ordinary error tool result inside the same turn. Ticket 18's pattern: a
// rejection that escaped would end the turn instead.
{
	const tool = createTaskTool(fakeHost([profile({ name: 'auto' }), RESEARCHER]));

	await assert.rejects(
		() => call(tool, { profile: 'nonesuch', label: 'x', prompt: 'y' }),
		// It names what is available, so the correction is possible without a
		// second round trip.
		/No delegable profile named "nonesuch"\. Available: researcher\./
	);

	// A real profile that is not delegable fails the same way rather than running.
	// A profile the user never marked is not a subagent by accident.
	await assert.rejects(
		() => call(tool, { profile: 'auto', label: 'x', prompt: 'y' }),
		/No delegable profile named "auto"/
	);
}

// Depth counts the main agent, so a child may delegate and its child may not.
{
	const host = fakeHost([RESEARCHER]);
	const tool = createTaskTool(host);
	const params = { profile: 'researcher', label: 'dig', prompt: 'find it' };

	const child = await call(tool, params, 1);
	assert.equal(host.seen[0].depth, 2, 'the main agent is depth 1');
	assert.deepEqual(child.content, [{ type: 'text', text: 'done' }]);

	await call(tool, params, MAX_DEPTH - 1);
	assert.equal(host.seen[1].depth, MAX_DEPTH);

	await assert.rejects(
		() => call(tool, params, MAX_DEPTH),
		new RegExp(`may nest ${MAX_DEPTH} deep`)
	);
	assert.equal(host.seen.length, 2, 'and nothing was started');
}

// The child's tokens travel back on the result rather than into the parent's
// meter. Adding them there would corrupt the number auto-compaction divides by.
{
	const tool = createTaskTool(fakeHost([RESEARCHER]));
	const result = await call(tool, { profile: 'researcher', label: 'dig', prompt: 'find it' });
	assert.deepEqual(result.details, {
		profile: 'researcher',
		label: 'dig',
		depth: 2,
		timedOut: false,
		inputTokens: 10,
		outputTokens: 3,
	});
	// No `cost` key at all, because this child's model had no known rates. A
	// `cost: 0` here would tell a reader the delegation was free — ticket 26's
	// distinction, carried through to the one place a child's spend is reported.
	assert.ok(!('cost' in (result.details as object)));
}

// And a priced child carries its spend back on the same terms as its tokens:
// on the result, never into the parent's meter.
{
	const tool = createTaskTool(
		fakeHost([RESEARCHER], async () => ({
			answer: 'done',
			inputTokens: 10,
			outputTokens: 3,
			cost: 0.0042,
		}))
	);
	const result = await call(tool, { profile: 'researcher', label: 'dig', prompt: 'find it' });
	assert.equal((result.details as { cost?: number }).cost, 0.0042);
}

// A child that says nothing is reported as such rather than as an empty tool
// result the model has to guess about.
{
	const tool = createTaskTool(
		fakeHost([RESEARCHER], async () => ({ answer: '   ', inputTokens: 0, outputTokens: 0 }))
	);
	const result = await call(tool, { profile: 'researcher', label: 'dig', prompt: 'find it' });
	assert.match((result.content[0] as { text: string }).text, /without saying anything/);
}

// The progress line is pushed as partial output, which is how a delegation
// renders with no new event kind: `tool_update` already carries it.
{
	const tool = createTaskTool(
		fakeHost([RESEARCHER], async (request) => {
			request.onLine('read Cargo.toml');
			return { answer: 'done', inputTokens: 0, outputTokens: 0 };
		})
	);
	const lines: string[] = [];
	await tool.execute(
		'c1',
		{ profile: 'researcher', label: 'dig into rtk', prompt: 'find it' },
		undefined,
		(update) => lines.push((update.content[0] as { text: string }).text),
		{ depth: 1 }
	);
	assert.deepEqual(lines, [
		// One before anything has happened, so the delegation is visible from the
		// moment it starts rather than from its first tool call.
		'researcher - dig into rtk',
		'researcher - dig into rtk - [read Cargo.toml]',
	]);
}

// Four at once. Without a cap one model call can start twelve agents against one
// API key and one working tree.
{
	let running = 0;
	let peak = 0;
	const release: (() => void)[] = [];
	const tool = createTaskTool(
		fakeHost([RESEARCHER], async () => {
			running += 1;
			peak = Math.max(peak, running);
			await new Promise<void>((resolve) => release.push(resolve));
			running -= 1;
			return { answer: 'done', inputTokens: 0, outputTokens: 0 };
		})
	);

	const all = Array.from({ length: MAX_CONCURRENT + 2 }, (_, index) =>
		call(tool, { profile: 'researcher', label: `job ${index}`, prompt: 'go' })
	);
	// Let every call reach the limiter before counting.
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.equal(peak, MAX_CONCURRENT, `started ${peak} at once`);

	// The rest queue rather than being refused: a refusal loses a delegation the
	// model meant, and arrives as a failure it then has to reason about.
	while (release.length > 0) {
		release.shift()?.();
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
	const results = await Promise.all(all);
	assert.equal(results.length, MAX_CONCURRENT + 2, 'every delegation ran');
	assert.equal(peak, MAX_CONCURRENT, 'and never more than the cap at a time');
}

// Cancelling the parent turn aborts the child. pi aborts the running tool call,
// and that is the whole mechanism — no separate registry of children.
{
	const parent = new AbortController();
	const tool = createTaskTool(
		fakeHost([RESEARCHER], async (request) => {
			await new Promise<void>((resolve) =>
				request.signal.addEventListener('abort', () => resolve(), { once: true })
			);
			return { answer: 'partial', inputTokens: 0, outputTokens: 0 };
		})
	);

	const running = call(tool, { profile: 'researcher', label: 'dig', prompt: 'go' }, 1, parent.signal);
	parent.abort();
	const result = await running;
	// Reported as what it reached, not as a timeout: the parent's cancellation is
	// not a task failure, and the turn that would read it is going away anyway.
	assert.deepEqual(result.content, [{ type: 'text', text: 'partial' }]);
	assert.equal((result.details as { timedOut: boolean }).timedOut, false);
}

console.log('agent/subagent.check.ts: ok');
