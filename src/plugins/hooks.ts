// What a plugin is told, and what it is allowed to decide — ticket 73.
//
// ## The paragraph that matters
//
// **A plugin may add a block and may never lift one.**
//
// pi's `AgentHarness.emitHook` hands every handler the same event and keeps only
// the **last non-undefined result**. So a plugin that installs a `tool_call`
// handler and returns an object — any object, including `{}` — silently replaces
// the gate's `{ block: true }`. Nothing fails. No test goes red. The permission
// gate is simply gone.
//
// Everything below exists to make that impossible:
//
// - Plugin handlers are **never registered on the harness**. `provider.ts` calls
//   `runToolCall` once, with one handler, and this module runs the chain inside
//   it. The registry deliberately has no accessor that hands its handlers out —
//   there is nothing to pass to `harness.on` even by accident.
// - Only `block === true` survives. A handler returning `{ block: false }`,
//   `{}`, `undefined` or a string produces **no decision at all**, so an allow
//   can never displace a deny.
// - `hooks.check.ts` fails if `provider.ts` ever imports more from this file
//   than the two entry points.
//
// ## Ours-shaped, not pi's
//
// The payloads below are our own types. `api` covers our surface and not pi's,
// and pi's event shapes change in minor releases every couple of days — a raw
// pass-through would make every one of those a plugin author's problem instead
// of ours. `provider.ts` maps into these shapes at the registration site.
//
// **The list is short on purpose.** ADR 0005 replaced the "name three plugins
// you actually want" gate with a different one: the surface grows one event at a
// time, and only when something real needs the next. Publishing all
// twenty-two of pi's events would have meant publishing twenty-two payloads we
// had not designed, which is the pass-through this section rules out.

/** Our name for each event a plugin can hear, and nothing more. */
export const PLUGIN_EVENTS = [
	'turn_start',
	'turn_end',
	'tool_call',
	'tool_result',
	'model_update',
	'tools_update',
	'compacted',
	'abort',
	/*
	 * Not a harness event at all — ticket 75. It is the plugin's own panel
	 * talking back to the plugin's own script, and it is in this list because
	 * `on` is the one way a plugin registers for anything and a second
	 * registration mechanism for one event would be a second mechanism.
	 *
	 * The payload is whatever the panel sent. We never parse it.
	 */
	'relay',
] as const;

export type PluginEventName = (typeof PLUGIN_EVENTS)[number];

export function isPluginEvent(name: string): name is PluginEventName {
	return (PLUGIN_EVENTS as readonly string[]).includes(name);
}

/** A tool the model is about to run. The only event whose result is honoured. */
export interface ToolCallPayload {
	readonly callId: string;
	readonly tool: string;
	readonly input: Record<string, unknown>;
}

/** A turn beginning, and what the model was told. */
export interface TurnStartPayload {
	readonly prompt: string;
	readonly systemPrompt: string;
}

/** A turn that has settled, and how many prompts are still queued behind it. */
export interface TurnEndPayload {
	readonly queued: number;
}

/** What a tool answered. Text only — an image is not a shape we promise yet. */
export interface ToolResultPayload {
	readonly callId: string;
	readonly tool: string;
	readonly isError: boolean;
	readonly text: string;
}

/** The model changed. Its id, not pi's `Model`, which is a live object. */
export interface ModelPayload {
	readonly model: string;
}

/** The tool set changed — every tool that exists, and the subset in play. */
export interface ToolsPayload {
	readonly tools: readonly string[];
	readonly active: readonly string[];
}

/** History was summarised. */
export interface CompactedPayload {
	readonly tokensBefore: number;
	readonly summary: string;
}

/** The run was stopped, and what was thrown away with it. */
export interface AbortPayload {
	readonly clearedSteer: number;
	readonly clearedFollowUp: number;
}

/** What a plugin may say about one. Anything else it returns is discarded. */
export interface ToolCallDecision {
	readonly block?: boolean;
	readonly reason?: string;
}

export type PluginHandler = (payload: unknown) => unknown;

/**
 * How long a plugin gets, per call.
 *
 * The same 15 seconds `browser_eval` already uses, for the same reason it gives:
 * a caller inside a model's turn cannot wait forever. It is a *deadline* and not
 * a delay — a handler that answers in a millisecond costs a millisecond.
 *
 * **It is best effort and the ADR says so.** A handler that awaits something
 * slow is caught here. A handler that spins in a synchronous loop is not, and no
 * timer can interrupt it: it runs on our main thread and freezes the window.
 * That is the trigger for moving plugins into a sandbox, recorded rather than
 * quietly worked around.
 */
export const DEADLINE_MS = 15_000;

/**
 * Race `work` against the clock.
 *
 * The loser keeps running — a promise cannot be cancelled — so this bounds how
 * long we *wait*, not how long the plugin *takes*. That is the honest limit of
 * doing this in-process, and it is why breaching disables the plugin for the
 * session rather than just failing the one call.
 */
export function withDeadline<T>(work: Promise<T>, what: string, ms = DEADLINE_MS): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`${what} took longer than ${ms}ms`)), ms);
		work.then(resolve, reject).finally(() => clearTimeout(timer));
	});
}

/**
 * The one thing a plugin's `tool_call` result may contain.
 *
 * Written as a filter rather than a cast: a plugin can return anything at all,
 * and every shape other than an explicit block reads as "no opinion". This is
 * the whole of "may add a block, may never lift one".
 */
export function asBlock(result: unknown): ToolCallDecision | undefined {
	if (typeof result !== 'object' || result === null) {
		return undefined;
	}
	const decision = result as ToolCallDecision;
	if (decision.block !== true) {
		return undefined;
	}
	return typeof decision.reason === 'string'
		? { block: true, reason: decision.reason }
		: { block: true };
}

/**
 * Deny precedence over a whole chain.
 *
 * The **first** block wins rather than the last, so the reason a user reads is
 * the reason of the plugin that objected first — and so that adding a second
 * plugin cannot change the message the first one produces.
 */
export function firstBlock(results: readonly unknown[]): ToolCallDecision | undefined {
	for (const result of results) {
		const decision = asBlock(result);
		if (decision) {
			return decision;
		}
	}
	return undefined;
}

interface Registration {
	readonly pluginId: string;
	readonly event: PluginEventName;
	readonly handler: PluginHandler;
}

/*
 * Deliberately module-private, and deliberately without a getter. The failure
 * this file exists to prevent needs a list of handlers to pass to `harness.on`;
 * there is no way to obtain one.
 */
const registrations: Registration[] = [];

/** Told when a plugin breaches its deadline or throws, so it can be disabled. */
let onBreach: (pluginId: string, reason: string) => void = () => {};

export function setOnBreach(report: (pluginId: string, reason: string) => void): void {
	onBreach = report;
}

export function registerHandler(
	pluginId: string,
	event: PluginEventName,
	handler: PluginHandler
): void {
	registrations.push({ pluginId, event, handler });
}

/** Every handler a plugin installed, gone at once. Disabling is all-or-nothing. */
export function dropPlugin(pluginId: string): void {
	for (let at = registrations.length - 1; at >= 0; at -= 1) {
		if (registrations[at].pluginId === pluginId) {
			registrations.splice(at, 1);
		}
	}
}

/** For the check, and for the plugin list. Counts, never handlers. */
export function handlerCount(event?: PluginEventName): number {
	return event === undefined
		? registrations.length
		: registrations.filter((entry) => entry.event === event).length;
}

/**
 * Run one plugin handler under its deadline, converting every failure into
 * "this plugin is finished" rather than into a failed turn.
 *
 * Never rethrows. A plugin is not allowed to break the agent it is decorating —
 * the run continues, the plugin does not.
 */
async function runOne(entry: Registration, payload: unknown, ms: number): Promise<unknown> {
	try {
		return await withDeadline(
			Promise.resolve(entry.handler(payload)),
			`${entry.pluginId} handling ${entry.event}`,
			ms
		);
	} catch (cause) {
		const reason = cause instanceof Error ? cause.message : String(cause);
		dropPlugin(entry.pluginId);
		onBreach(entry.pluginId, reason);
		return undefined;
	}
}

/**
 * Every plugin hears it; nothing it says is honoured.
 *
 * Returns `undefined` always, and the call site must return that to the harness.
 * Returning anything else from a notification handler would displace whichever
 * of our own handlers ran before it — the same `emitHook` trap, from the other
 * direction.
 */
export async function notifyPlugins(
	event: PluginEventName,
	payload: unknown,
	// Only the check passes this. A deadline the caller picks would be a knob
	// nobody turns, and a 15-second check is a check people start skipping.
	ms = DEADLINE_MS
): Promise<undefined> {
	// A copy, because a handler that fails is dropped from `registrations` while
	// this loop is walking it.
	for (const entry of registrations.filter((candidate) => candidate.event === event)) {
		await runOne(entry, payload, ms);
	}
	return undefined;
}

/**
 * One plugin hears it, and nothing it says is honoured.
 *
 * `relay` is the reason this exists: a panel belongs to one plugin, and
 * broadcasting its payload would hand one plugin's private protocol to every
 * other plugin in the window.
 */
export async function notifyPlugin(
	pluginId: string,
	event: PluginEventName,
	payload: unknown,
	ms = DEADLINE_MS
): Promise<undefined> {
	for (const entry of registrations.filter(
		(candidate) => candidate.event === event && candidate.pluginId === pluginId
	)) {
		await runOne(entry, payload, ms);
	}
	return undefined;
}

/**
 * The chain for a tool call: every plugin, then the gate.
 *
 * **The gate is never overridden, and is not asked when the answer is already
 * no.** The ticket's wording is "the gate runs last and unconditionally", which
 * is about a plugin never being able to turn a block into an allow — that
 * property holds here absolutely. What is skipped is only the *question*: under
 * `ask`, running the gate after a plugin has already denied the call would put a
 * card in front of the user whose answer could not change anything. Approving a
 * call that stays blocked is worse than not being asked.
 */
export async function runToolCall(
	payload: ToolCallPayload,
	gate: () => Promise<ToolCallDecision | undefined>,
	/** See `notifyPlugins`. */
	ms = DEADLINE_MS
): Promise<ToolCallDecision | undefined> {
	const results: unknown[] = [];
	for (const entry of registrations.filter((candidate) => candidate.event === 'tool_call')) {
		results.push(await runOne(entry, payload, ms));
	}
	return firstBlock(results) ?? (await gate());
}
