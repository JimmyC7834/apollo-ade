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
import type { AgentHarnessTool } from '@earendil-works/pi-agent-core';
// Explicit extension, like `events.ts` — this module is reachable from a check
// script, which node resolves without Vite's help.
import { destructive } from './gate.ts';

/** How long a user tool may run before Rust kills it. Seconds. */
const TIMEOUT = 120;

/** Model-visible tool names travel in the request; keep them boring. */
const NAME = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;

const PLACEHOLDER = /\{([^{}]*)\}/g;

/**
 * pi's four built-ins, which a manifest may not shadow.
 *
 * `AgentHarness` throws on duplicate tool names, and a manifest that redefined
 * `bash` would take the harness down at `setTools` rather than at parse. Hard-
 * coded because the ticket's own rule is that the built-in exception **does not
 * grow**: it is four tools, already written, and nothing new joins them.
 */
const RESERVED = new Set(['read', 'write', 'edit', 'bash']);

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
}

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
	// brace at all, so a malformed placeholder is caught here rather than
	// spawning a program with a literal `{` in its name.
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

	return { name, description: raw.description, parameters, argv };
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

/** What the model gets back: whatever the command printed, and how it ended. */
function report(argv: readonly string[], outcome: ExecOutcome): string {
	const body = [outcome.stdout.trim(), outcome.stderr.trim()].filter(Boolean).join('\n');
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
function createUserTool(tool: UserTool): AgentHarnessTool<{ env: unknown }> {
	const parameters = Type.Object(
		Object.fromEntries(Object.entries(tool.parameters).map(([key, spec]) => [key, schemaFor(spec)]))
	) as TSchema;

	return {
		name: tool.name,
		label: tool.name,
		description: tool.description,
		parameters,
		async execute(_id, params, signal) {
			const argv = resolveArgv(tool, params as Record<string, unknown>);

			/*
			 * The floor, reached through a different door. Ticket 13's decision 4
			 * is that the gate operates on the *command*, not on tool identity, so
			 * a user tool resolving to `rm -rf /` is stopped for the same reason
			 * `bash` would be — and being trusted enough to be in a profile does
			 * not lift it.
			 *
			 * Refused rather than asked about, unlike the bash path. The gate can
			 * ask because a turn owns it; a tool has no way to. That makes user
			 * tools strictly stricter than bash here, which is the safe direction:
			 * `bash` is still there for someone who means it.
			 *
			 * ponytail: refuse-only. Route it through the gate's approval if a
			 * real destructive user tool ever turns out to be wanted.
			 */
			const why = destructive(argv.join(' '));
			if (why) {
				throw new Error(`refused: this ${why}. Run it through the bash tool if you mean it.`);
			}

			if (!('__TAURI_INTERNALS__' in globalThis)) {
				throw new Error('user tools need the native shell');
			}
			const { Channel, invoke } = await import('@tauri-apps/api/core');
			const id = crypto.randomUUID();
			const stop = () => void invoke('agent_exec_cancel', { id }).catch(() => {});
			signal?.addEventListener('abort', stop, { once: true });

			try {
				const outcome = await invoke<ExecOutcome>('agent_exec', {
					id,
					// `argv` is what makes Rust spawn directly; `command` is unread.
					request: { command: '', argv, cwd: null, env: {}, inheritEnv: true, timeout: TIMEOUT },
					// Required by the command, and deliberately ignored: a user tool
					// returns its output at the end rather than streaming it. Live
					// output is `bash`'s job, where a long-running command is the
					// point; a linter that prints nothing until it finishes has
					// nothing to show.
					onEvent: new Channel<unknown>(),
				});
				return {
					content: [{ type: 'text', text: report(argv, outcome) }],
					details: outcome,
				};
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

/** The pi tools for whatever is currently installed. */
export function userToolDefinitions(): AgentHarnessTool<{ env: unknown }>[] {
	return tools.map(createUserTool);
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
