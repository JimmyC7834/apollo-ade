// Tools the user wrote, declared rather than programmed.
//
// docs/wayfinder/pi-harness/tickets/13-user-authored-tools.md settled the shape:
// **a declarative manifest for v1** — a schema plus an argv array — so no code
// we did not write ever runs in our process. It is honestly less than pi offers
// (no logic, no conditionals, no state); `runtime` is the discriminator that
// lets a `"worker"` variant arrive later without a format migration.
//
// Two rules from that ticket do the load-bearing work here:
//
// **argv, never a command string.** A parameter fills exactly one argv element
// and is never re-parsed, word-split or glob-expanded. `grep {pattern} .` as a
// *string* handed to a shell is arbitrary code execution the moment the model
// supplies `pattern = "; rm -rf ~"` — the user authored a grep tool and the
// model got a shell. Rust spawns the argv directly, so quoting never arises.
//
// **Trust granted by profile membership does not lift the floor.** A tool
// cannot launder a command past the deny list, so the resolved argv is checked
// against it here.

import { Type, type TSchema } from 'typebox';
import {
	formatSize,
	sanitizeBinaryOutput,
	truncateTail,
	type AgentHarnessTool,
} from '@earendil-works/pi-agent-core';
// Explicit extension, like `events.ts` — this module is reachable from a check
// script, which node resolves without Vite's help.
import { destructive, type Gate } from './gate.ts';
import { ASK_TOOL } from './ask.ts';
import { BROWSER_TOOL } from './browserTool.ts';
import { isTauri } from '../native.ts';
import { rtkArgvFor } from './rtk.ts';

/** Model-visible tool names travel in the request; keep them boring. */
const NAME = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;

/**
 * A placeholder is braces around an **identifier**, and nothing else is one.
 *
 * The obvious `\{([^{}]*)\}` was wrong in a way only a real manifest found:
 * argv routinely contains braces that are not placeholders. `awk '{print $1}'`,
 * `find . -exec rm {} \;`, `jq '{a: .b}'`, and any `node -e` script with a block
 * in it — the test manifest that caught this was rejected for "using
 * `{clearInterval(t);}` without declaring it".
 *
 * Requiring an identifier leaves all of those alone, because real braces in
 * shell and script syntax almost always hold a space, a symbol, or nothing.
 * What it keeps is the error that matters: `{pattenr}` is still an identifier,
 * so a mistyped parameter is still reported rather than silently becoming a
 * literal. The residue is `awk '{x}'` — a lone identifier in braces — which is
 * rare and fails loudly rather than quietly.
 */
const PLACEHOLDER = /\{([a-zA-Z][a-zA-Z0-9_-]{0,63})\}/g;

/**
 * The built-ins, which a manifest may not shadow.
 *
 * `AgentHarness` throws on duplicate tool names, and a manifest that redefined
 * `bash` would take the harness down at `setTools` rather than at parse.
 *
 * Ticket 13's rule was that the built-in exception **does not grow** — meaning
 * no new *executing* tool joins pi's four. `ask_user` was let past it because it
 * is the opposite kind of thing: it runs nothing, it asks the user something.
 *
 * **`browser` widens that rule, and this is the record of it.** It executes: it
 * opens a page and clicks in it. Ticket 70 and
 * [ADR 0004](../../docs/adr/0004-a-browser-tab-is-a-child-webview.md) are where
 * the decision was made, on the grounds that a page is a surface the workbench
 * owns rather than a program the model chose — the same reason `bash` is gated
 * and this is not. The rule is now "the built-ins are the six below", and the
 * next addition needs its own argument rather than this one.
 *
 * Imported rather than re-typed so the names cannot drift.
 */
const RESERVED = new Set(['read', 'write', 'edit', 'bash', ASK_TOOL, BROWSER_TOOL]);

/**
 * One parameter, in the manifest's long form.
 *
 * `"pattern": "what to find"` is the short form and means exactly
 * `{ description: "what to find", type: "string", required: true }` — which is
 * what almost every tool wants, so it stays the thing you write by default. The
 * long form exists for the three cases the short one cannot say.
 */
export interface UserToolParameter {
	readonly description: string;
	readonly type: 'string' | 'number' | 'boolean';
	readonly required: boolean;
	/** A closed set of allowed values. Strings only. */
	readonly choices?: readonly string[];
}

export interface UserTool {
	readonly name: string;
	readonly description: string;
	readonly parameters: Readonly<Record<string, UserToolParameter>>;
	readonly argv: readonly string[];
	/** Seconds before Rust kills it. */
	readonly timeout: number;
	/** Root-relative, and confined by Rust like every other path. */
	readonly cwd?: string;
	/**
	 * Variables added to the child's environment.
	 *
	 * The escape hatch for the credential stripping in `agent_exec`: a tool that
	 * genuinely needs a key is given one by the person who wrote the manifest,
	 * rather than every child inheriting every secret the app holds.
	 */
	readonly env?: Readonly<Record<string, string>>;
}

/** Two minutes, matching nothing in particular — long enough for a linter. */
const DEFAULT_TIMEOUT = 120;

const TYPES = ['string', 'number', 'boolean'] as const;

/**
 * Read one parameter, short form or long.
 *
 * Returns the reason it is wrong rather than throwing, because the caller turns
 * that into the manifest's single rejection message — a parameter is not
 * separately salvageable from the tool it belongs to.
 */
function parseParameter(raw: unknown): UserToolParameter | string {
	if (typeof raw === 'string') {
		return raw.trim()
			? { description: raw, type: 'string', required: true }
			: 'needs a description';
	}
	if (!isRecord(raw)) {
		return `must be a description or an object, saw ${JSON.stringify(raw)}`;
	}
	if (typeof raw.description !== 'string' || !raw.description.trim()) {
		return 'needs a description';
	}

	const type = raw.type ?? 'string';
	if (!TYPES.includes(type as (typeof TYPES)[number])) {
		return `has type ${JSON.stringify(raw.type)}; expected one of ${TYPES.join(', ')}`;
	}

	const required = raw.required ?? true;
	if (typeof required !== 'boolean') {
		return `has required ${JSON.stringify(raw.required)}; expected true or false`;
	}

	let choices: string[] | undefined;
	if (raw.choices !== undefined) {
		if (
			!Array.isArray(raw.choices) ||
			raw.choices.length === 0 ||
			!raw.choices.every((choice) => typeof choice === 'string')
		) {
			return 'needs "choices" as a non-empty array of strings';
		}
		if (type !== 'string') {
			// Allowing it would mean a schema whose declared type and enumerated
			// values disagree, which providers handle inconsistently.
			return '"choices" only applies to a string';
		}
		choices = raw.choices as string[];
	}

	return {
		description: raw.description,
		type: type as UserToolParameter['type'],
		required,
		...(choices ? { choices } : {}),
	};
}

/*
 * Parsing. Same policy as the profile files, for the same reason: a manifest is
 * hand-written JSON, so every field is `unknown` until proven otherwise.
 *
 * The difference is what a bad field costs. A profile drops the field and keeps
 * going, because seven good fields should survive one typo. A *tool* is
 * rejected whole — there is no partial tool. Half a manifest is a tool that
 * runs something other than what its author wrote, and the ticket's own rule is
 * that a malformed manifest fails loudly.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseTool(raw: unknown, problems: string[]): UserTool | undefined {
	const reject = (why: string) => {
		problems.push(`ignoring a tool: ${why}`);
		return undefined;
	};

	if (!isRecord(raw)) {
		return reject(`not an object (${JSON.stringify(raw)})`);
	}
	const { name } = raw;
	if (typeof name !== 'string' || !NAME.test(name)) {
		return reject(`"name" must be a short identifier, saw ${JSON.stringify(name)}`);
	}
	const said = (why: string) => reject(`"${name}" ${why}`);

	// Defaulted rather than required, because `"exec"` is the only value that
	// exists — but named in the error, so the first `"worker"` manifest gets a
	// message about the runtime and not about a field it did not get to.
	const runtime = raw.runtime ?? 'exec';
	if (runtime !== 'exec') {
		return said(`declares runtime ${JSON.stringify(runtime)}; only "exec" is supported`);
	}

	// The model chooses tools by their descriptions. An undescribed tool is one
	// the model will either never call or call for the wrong reason.
	if (typeof raw.description !== 'string' || !raw.description.trim()) {
		return said('needs a "description" — it is what the model chooses it by');
	}

	if (
		!Array.isArray(raw.argv) ||
		raw.argv.length === 0 ||
		!raw.argv.every((part) => typeof part === 'string')
	) {
		return said(`needs "argv" as a non-empty array of strings, saw ${JSON.stringify(raw.argv)}`);
	}
	const argv = raw.argv as string[];

	const parameters: Record<string, UserToolParameter> = {};
	if (raw.parameters !== undefined) {
		if (!isRecord(raw.parameters)) {
			return said('needs "parameters" as { name: "description" }');
		}
		for (const [key, value] of Object.entries(raw.parameters)) {
			if (!NAME.test(key)) {
				return said(`has a parameter named ${JSON.stringify(key)}; use a short identifier`);
			}
			const parameter = parseParameter(value);
			if (typeof parameter === 'string') {
				return said(`parameter "${key}" ${parameter}`);
			}
			parameters[key] = parameter;
		}
	}

	if (RESERVED.has(name)) {
		return said('is the name of a built-in tool');
	}

	// The program is fixed by the manifest and can never be chosen by the model.
	// That is what bounds a user tool to the one thing its author named. Any
	// brace at all, rather than only a placeholder: a program name has no honest
	// reason to contain one, so the stricter rule costs nothing and catches a
	// malformed placeholder here instead of at spawn.
	if (argv[0].includes('{')) {
		return said('cannot take a parameter as its program name');
	}

	const used = new Set<string>();
	for (const element of argv) {
		for (const [, key] of element.matchAll(PLACEHOLDER)) {
			// `hasOwn`, not `in`: the manifest is `JSON.parse` output, so `in`
			// would accept `{toString}` off the prototype and hand the model a
			// parameter nobody declared.
			if (!Object.hasOwn(parameters, key)) {
				return said(`uses {${key}} in argv but does not declare it in "parameters"`);
			}
			used.add(key);
		}
	}
	// A declared parameter nothing substitutes is a silent no-op: the model
	// fills it in, and the command runs as if it had not.
	const unused = Object.keys(parameters).filter((key) => !used.has(key));
	if (unused.length > 0) {
		return said(`declares ${unused.join(', ')} but never uses them in argv`);
	}

	const timeout = raw.timeout ?? DEFAULT_TIMEOUT;
	if (typeof timeout !== 'number' || !Number.isFinite(timeout) || timeout <= 0) {
		return said(`has timeout ${JSON.stringify(raw.timeout)}; expected seconds above zero`);
	}

	let cwd: string | undefined;
	if (raw.cwd !== undefined) {
		if (typeof raw.cwd !== 'string' || !raw.cwd.trim()) {
			return said(`has cwd ${JSON.stringify(raw.cwd)}; expected a path inside the workspace`);
		}
		// Not validated further here. Rust's resolver refuses anything above the
		// root, and duplicating that rule in the renderer would create a second
		// answer to the same question — the one that is always the wrong one.
		cwd = raw.cwd;
	}

	let env: Record<string, string> | undefined;
	if (raw.env !== undefined) {
		if (
			!isRecord(raw.env) ||
			!Object.values(raw.env).every((value) => typeof value === 'string')
		) {
			return said('needs "env" as { NAME: "value" }, with string values');
		}
		env = raw.env as Record<string, string>;
	}

	return { name, description: raw.description, parameters, argv, timeout, cwd, env };
}

/**
 * Fill the placeholders, one whole element at a time.
 *
 * The substitution is deliberately dumb — a string replace inside one array
 * element — and that is the security property. A value containing spaces,
 * quotes, semicolons or globs stays one argument, because nothing downstream
 * ever parses it again.
 *
 * **An element mentioning an omitted optional parameter is dropped whole.** One
 * rule, and it is right in both shapes it has to be right in: `["rg",
 * "{pattern}", "{path}"]` without a path runs `rg pattern` rather than `rg
 * pattern ""`, and `"--project={dir}"` without a dir disappears rather than
 * becoming a bare `--project=`. Substituting the empty string would have been
 * the smaller change and would pass an empty argument to a program that asked
 * for a path.
 */
export function resolveArgv(tool: UserTool, params: Record<string, unknown>): string[] {
	const given = (key: string) => Object.hasOwn(params, key) && params[key] !== undefined;

	return tool.argv.flatMap((element) => {
		const mentioned = [...element.matchAll(PLACEHOLDER)].map(([, key]) => key);
		if (mentioned.some((key) => !given(key))) {
			return [];
		}
		return [element.replace(PLACEHOLDER, (_, key: string) => String(params[key]))];
	});
}

/**
 * One parameter as the model will see it.
 *
 * `Type.Optional` rather than leaving it out of `required`, because that is
 * what TypeBox emits a correct `required` array from — and the array is the
 * only thing a provider reads to decide whether it may omit an argument.
 */
function schemaFor(spec: UserToolParameter): TSchema {
	const options = { description: spec.description };
	const base = spec.choices
		? // `enum` on a string rather than a union of literals. TypeBox emits the
			// union as `anyOf: [{const}, ...]`, which is correct JSON Schema and
			// the thing Google's function-declaration subset is worst at; `enum`
			// is what every provider reads. Checked against TypeBox: it validates
			// the keyword, so portability costs nothing here.
			Type.String({ ...options, enum: [...spec.choices] })
		: spec.type === 'number'
			? Type.Number(options)
			: spec.type === 'boolean'
				? Type.Boolean(options)
				: Type.String(options);
	return spec.required ? base : Type.Optional(base);
}

type ExecOutcome = { stdout: string; stderr: string; exitCode: number };

/**
 * What the model gets back: whatever the command printed, and how it ended.
 *
 * **Truncated by pi's own limits**, not by ours. A user tool calls `agent_exec`
 * directly rather than through `env.exec`, so pi's bash tool — which caps what
 * the model sees at 2000 lines or 50 KB — is not in the path, and the only cap
 * left was Rust's 8 MiB transport guard. A tool that runs a build printed the
 * whole log into the context window. `truncateTail` keeps the *end*, which is
 * where a failing command says why, and it is the same rule and the same numbers
 * `bash` already answers with.
 *
 * `sanitizeBinaryOutput` for the same reason: a tool may be pointed at anything,
 * and pi strips control bytes before a model ever sees them.
 */
export function report(argv: readonly string[], outcome: ExecOutcome): string {
	const printed = [outcome.stdout.trim(), outcome.stderr.trim()].filter(Boolean).join('\n');
	const cut = truncateTail(sanitizeBinaryOutput(printed));
	const body = cut.truncated
		? `${cut.content}\n\n[showing the last ${cut.outputLines} of ${cut.totalLines} lines, ` +
			`${formatSize(cut.outputBytes)} of ${formatSize(cut.totalBytes)}]`
		: cut.content;
	if (outcome.exitCode === 0) {
		return body || '(no output)';
	}
	return `${body}\n\n${argv[0]} exited with code ${outcome.exitCode}`.trim();
}

/**
 * One manifest, as a tool pi can run.
 *
 * `execute` throws on failure rather than encoding an error in `content` — that
 * is pi's contract for `AgentTool`, and the harness turns the throw into a
 * `tool_result` the model sees and can adapt to.
 */
function createUserTool(
	tool: UserTool,
	gate: Gate,
	// The *session's* profile, since ticket 50 — a window no longer has one.
	rtkOn: () => boolean
): AgentHarnessTool<{ env: unknown }> {
	const parameters = Type.Object(
		Object.fromEntries(Object.entries(tool.parameters).map(([key, spec]) => [key, schemaFor(spec)]))
	) as TSchema;

	return {
		name: tool.name,
		label: tool.name,
		description: tool.description,
		parameters,
		// `callId` rather than `id`: the exec below has an `id` of its own, and it
		// is a different identifier — pi's tool call versus Rust's process handle.
		async execute(callId, params, signal, onUpdate) {
			let argv = resolveArgv(tool, params as Record<string, unknown>);

			/*
			 * rtk first, for the same reason it goes first for `bash`: the deny
			 * list below screens *resolved* argv, and what it screens has to be
			 * what runs. Ticket 11's amendment 6 puts every command the agent
			 * runs through rtk, tools included — a user tool is the agent
			 * spending tokens on output exactly like a shell command is.
			 *
			 * Nothing is quoted or joined, so unlike the `bash` path there is no
			 * shell syntax that could make this the wrong thing to do.
			 */
			// The guard is not an optimisation. Awaiting at all pushes the
			// approval question below into a later microtask, and a profile with
			// rtk off should not have its gate timing changed by a feature it
			// does not use.
			if (rtkOn()) {
				argv = [...(await rtkArgvFor(argv))];
			}

			/*
			 * The floor, reached through a different door. Ticket 13's decision 4
			 * is that the gate operates on the *command*, not on tool identity, so
			 * a user tool resolving to `rm -rf /` is stopped for the same reason
			 * `bash` would be — and being trusted enough to be in a profile does
			 * not lift it.
			 *
			 * **Asked about, not refused** — the same question `bash` gets, on the
			 * same event and the same card, now that `gate.confirm` exists
			 * (ticket 18). It used to throw, because a tool had no way to ask.
			 *
			 * Refusing was never the safer end of the trade, which is what settled
			 * it. It did not stop anyone deleting the directory; it made them move
			 * the deletion into `["python3", "cleanup.py"]`, where the deny list
			 * cannot read it and never asks at all. Strictness here bought
			 * indirection and cost the one case a foot-gun guard is any use for:
			 * the destruction written plainly enough to show you.
			 *
			 * A decline still throws, so the model's recovery path is unchanged.
			 * The approval carries the argv as the array it is, rather than joined
			 * — `["echo", "a b"]` and `["echo", "a", "b"]` read identically once
			 * joined, and that is the whole reason the array exists.
			 */
			const why = destructive(argv.join(' '));
			if (why && !(await gate.confirm(callId, tool.name, argv, why))) {
				throw new Error(`refused: this ${why}, and you declined it.`);
			}

			if (!isTauri()) {
				throw new Error('user tools need the native shell');
			}
			const { Channel, invoke } = await import('@tauri-apps/api/core');
			const id = crypto.randomUUID();
			const stop = () => void invoke('agent_exec_cancel', { id }).catch(() => {});
			signal?.addEventListener('abort', stop, { once: true });

			/*
			 * Live output, throttled.
			 *
			 * Rust sends a message per line and pi's own bash tool throttles on
			 * top of `env.exec` for exactly that reason. Forwarding every line
			 * straight to `onUpdate` would re-render the transcript once per line
			 * of a build log. A quarter second is slow enough to be cheap and
			 * fast enough to read as live.
			 */
			let live = '';
			let flushed = 0;
			const flush = () => {
				flushed = Date.now();
				onUpdate?.({ content: [{ type: 'text', text: live }], details: undefined });
			};

			const channel = new Channel<{ chunk?: string }>();
			channel.onmessage = (event) => {
				live += event.chunk ?? '';
				if (Date.now() - flushed > 250) {
					flush();
				}
			};

			try {
				const outcome = await invoke<ExecOutcome>('agent_exec', {
					id,
					// `argv` is what makes Rust spawn directly; `command` is unread.
					request: {
						command: '',
						argv,
						cwd: tool.cwd ?? null,
						env: tool.env ?? {},
						inheritEnv: true,
						timeout: tool.timeout,
					},
					onEvent: channel,
				});
				return {
					content: [{ type: 'text', text: report(argv, outcome) }],
					details: outcome,
				};
			} catch (cause) {
				/*
				 * Rust rejects with `{ code, message }`, not an `Error`, so letting
				 * it propagate raw put the string "[object Object]" in front of the
				 * model where "the command exceeded its timeout" belonged. Found by
				 * running a tool into its own timeout rather than by reading.
				 *
				 * The partial output goes with it: a tool killed at 120 seconds
				 * printed something before it died, and that is usually the whole
				 * diagnosis.
				 */
				const failure = cause as { code?: string; message?: string };
				const why = failure?.message ?? String(cause);
				throw new Error(live.trim() ? `${why}\n\n${live.trim()}` : why);
			} finally {
				signal?.removeEventListener('abort', stop);
			}
		},
	};
}

/*
 * The store. Small and mutable, like `profile.ts`'s, and for the same reason:
 * the files are read after the workspace root is known, which is long after the
 * provider was built.
 */

let tools: UserTool[] = [];
const listeners = new Set<(tools: readonly UserTool[]) => void>();

export function userTools(): readonly UserTool[] {
	return tools;
}

/** Watch for a reload. Returns its disposer, following `harness.on`. */
export function onUserToolsChange(listener: (tools: readonly UserTool[]) => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

/**
 * The pi tools for whatever is currently installed.
 *
 * The gate is passed in rather than imported: it is the *runner's* gate, and a
 * module-level one would be a second gate answering to nothing.
 */
export function userToolDefinitions(
	gate: Gate,
	rtkOn: () => boolean
): AgentHarnessTool<{ env: unknown }>[] {
	return tools.map((tool) => createUserTool(tool, gate, rtkOn));
}

/**
 * Replace the user tool set from what the files declared.
 *
 * `definitions` arrives global-first, so a project tool of the same name
 * replaces the global one — the same precedence the profiles use, and the same
 * one rule for configuration the ticket asked for. Replacement is *whole* here
 * rather than field-by-field: a profile merges because it is a bag of settings,
 * where a tool is one thing and half of two manifests is neither.
 *
 * Called before `installProfiles`, because a profile naming a tool that has not
 * been declared yet refuses to activate.
 */
export function installUserTools(
	definitions: readonly unknown[],
	problems: string[] = []
): string[] {
	const merged = new Map<string, UserTool>();
	for (const definition of definitions) {
		const tool = parseTool(definition, problems);
		if (tool) {
			merged.set(tool.name, tool);
		}
	}
	tools = [...merged.values()];
	for (const listener of listeners) {
		listener(tools);
	}
	return problems;
}
