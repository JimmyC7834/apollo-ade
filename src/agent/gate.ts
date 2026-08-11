// What stops a tool call.
//
// Settled in docs/wayfinder/pi-harness/tickets/03-permission-gate.md: TypeScript
// asks, Rust enforces. This file is only the asking half. The floor — refusing
// writes outside the workspace root — lives in `agent_write_file` and applies
// whatever this decides, because once user-authored tools share the renderer, a
// gate that lives only in the renderer is one that user code can reach around.

import type { AgentEvent } from './index';

/**
 * How much the gate asks. A profile field, read at the start of every turn.
 *
 * Three, because the Shell Guide names three and the dev chose three — ticket
 * 43. Their edges, written down because a third policy is only safe if they are:
 *
 * - **`ask`** — prompts before every mutating tool call. Was `careful`.
 * - **`auto`** — the default, and the one actually used. Never prompts, but
 *   still asks on the deny list below: **auto mode is the policy dial set to
 *   permissive, not the absence of a gate.**
 * - **`bypass`** — skips this file entirely, deny list included.
 *
 * **What `bypass` does not bypass, and cannot:** Rust's root confinement.
 * `agent_write_file` refuses writes outside the canonical root whatever is
 * decided here, and the per-turn `git_checkpoint` is not part of the gate
 * either. So `bypass` removes the deny list — which `context.md` records as a
 * foot-gun guard and explicitly not a security boundary — and nothing else.
 */
export type GatePolicy = 'ask' | 'auto' | 'bypass';

/**
 * Which tools change something.
 *
 * The gate examines what a tool *does*, not what it is called — the amendment
 * on ticket 13. Naming the mutating built-ins is how that is expressed while
 * the built-ins are all there is.
 *
 * **`bash` is here in full**, not only when its command matches the deny list.
 * A shell can always change something, so under `ask` every command is a
 * question; the deny list is the narrower thing that fires even under `auto`.
 * Asking only about pattern matches would make `ask` quietly weaker than its
 * name.
 */
const MUTATING = new Set(['write', 'edit', 'bash']);

/**
 * Commands auto mode will not run without asking.
 *
 * **This is a foot-gun guard and explicitly not a security boundary.** Every
 * pattern here is trivially evaded — a variable, a quote in the wrong place, a
 * `sh -c` wrapper — and pretending otherwise would be worse than not having it,
 * because someone would rely on it. It exists because the default policy is
 * `auto`, and auto mode running `git reset --hard` on a whim is a bad afternoon
 * that a single prompt prevents.
 *
 * The list is short on purpose. Every entry is *irreversible* — it destroys
 * work that no checkpoint restores, either because it rewrites history or
 * because it reaches outside the repository. Things that are merely dangerous
 * do not belong; a list long enough to fire often is a list people click
 * through.
 */
const DESTRUCTIVE: readonly { readonly pattern: RegExp; readonly why: string }[] = [
	{ pattern: /\brm\s+(-[a-z]*[rf][a-z]*\s+)+/i, why: 'deletes files recursively' },
	{ pattern: /\bgit\s+reset\s+--hard\b/i, why: 'discards uncommitted work' },
	{ pattern: /\bgit\s+clean\s+-[a-z]*f/i, why: 'deletes untracked files' },
	{ pattern: /\bgit\s+push\b.*(--force\b|(?<!-)-f\b)/i, why: 'rewrites a remote branch' },
	{ pattern: /\bgit\s+checkout\s+--\s/i, why: 'discards changes to those files' },
	{ pattern: /\b(shutdown|reboot|mkfs\.?\w*|diskpart)\b/i, why: 'affects the machine itself' },
	// `format` needs a drive to be the dangerous one. Bare `\bformat\b` also
	// matched `echo "format the disk"` and would have matched "format the code",
	// which is the kind of noise that trains people to click through.
	{ pattern: /\bformat\s+[a-z]:/i, why: 'formats a drive' },
	{ pattern: /\bdd\s+.*\bof=/i, why: 'writes raw blocks' },
	{ pattern: /\b(rmdir|del)\s+\/s\b/i, why: 'deletes a directory tree' },
	{ pattern: /:\(\)\s*\{.*\}\s*;\s*:/, why: 'is a fork bomb' },
];

/** The reason this command is worth asking about, if any. */
export function destructive(command: string): string | undefined {
	return DESTRUCTIVE.find((rule) => rule.pattern.test(command))?.why;
}

export interface Gate {
	/**
	 * Point the gate at the running turn, with the policy that turn opened on.
	 *
	 * The gate used to be *built* per turn, which was right while the hook was
	 * its only caller. A tool's `execute` is the second caller and tools are
	 * built once — see `ask.ts` for why rebuilding one per turn is not an option
	 * — so the gate now has the asker's lifetime and the same per-turn sink.
	 */
	begin(policy: GatePolicy, emit: (event: AgentEvent) => void): void;
	/**
	 * Ask about something a tool is about to do. `true` means run it.
	 *
	 * The same question, the same event and the same card as the hook's — a
	 * destructive command is a yes/no about an imminent action whoever noticed
	 * it. Deliberately *not* routed through `ask.ts`: that answers a list of
	 * strings, and merging the two would produce a union every caller has to
	 * narrow, which is the reason `answerQuestion` and `resolveApproval` are
	 * separate one layer up.
	 */
	confirm(id: string, name: string, input: unknown, reason: string): Promise<boolean>;
	/**
	 * pi's `tool_call` hook. Returning `undefined` lets the call proceed;
	 * returning `{ block: true }` produces an ordinary error `tool_result` the
	 * model sees and can adapt to.
	 *
	 * **It must never throw.** A handler that throws is wrapped into an
	 * `AgentHarnessError` with code `hook` and *aborts the turn* — so a declined
	 * approval returns `{ block: true }` rather than rejecting. That is the
	 * single easiest way to get this wrong, which is why it is asserted in
	 * `gate.check.ts`.
	 *
	 * `policy` overrides the turn's for one harness. A subagent runs under **its
	 * own profile's** policy (ticket 24), so a read-only `research` child can sit
	 * on `auto` while an `editor` child asks — and the profile field would
	 * otherwise silently do nothing for children. The sink is not overridden with
	 * it: a child's question still has to reach the user.
	 */
	onToolCall(
		event: {
			toolCallId: string;
			toolName: string;
			input: Record<string, unknown>;
		},
		policy?: GatePolicy
	): Promise<{ block?: boolean; reason?: string } | undefined>;
	/** Answer the question at the front of the queue. */
	resolve(approved: boolean): void;
	/** Decline everything outstanding, so a cancelled run does not hang forever. */
	abandon(): void;
}

export function createGate(): Gate {
	let turnPolicy: GatePolicy = 'auto';
	let emit: ((event: AgentEvent) => void) | undefined;

	/**
	 * The questions waiting on the user, oldest first.
	 *
	 * A single slot was right while one turn's tools ran one at a time. Ticket 24
	 * makes up to four subagents run at once against one user, so two tools can
	 * genuinely need an answer at the same moment — and the old code refused the
	 * second, which turns a parallel delegation into a blocked tool call nobody
	 * asked for. **Only the front one is emitted**, so the UI still shows one card
	 * and `resolve` is still unambiguous about which card it answered.
	 */
	const waiting: { readonly event: AgentEvent; readonly resolve: (approved: boolean) => void }[] =
		[];

	const settle = (approved: boolean) => {
		const front = waiting.shift();
		front?.resolve(approved);
		if (waiting[0]) {
			emit?.(waiting[0].event);
		}
	};

	/** Emit the question and hold until it is answered. Both callers' body. */
	async function ask(
		id: string,
		name: string,
		input: unknown,
		reason?: string
	): Promise<boolean> {
		return await new Promise<boolean>((resolve) => {
			waiting.push({ event: { kind: 'approval', id, name, input, reason }, resolve });
			if (waiting.length === 1) {
				emit?.(waiting[0].event);
			}
		});
	}

	return {
		begin(next, sink) {
			// A turn starting while approvals are outstanding can only mean the last
			// turn's were never settled. Declining them here is what stops this
			// turn's user from answering a question they were never shown.
			while (waiting.length > 0) {
				settle(false);
			}
			turnPolicy = next;
			emit = sink;
		},

		async confirm(id, name, input, reason) {
			return await ask(id, name, input, reason);
		},

		async onToolCall(event, policy = turnPolicy) {
			/*
			 * Bypass, first and unconditionally — the deny list included, which is
			 * the only thing it actually removes. Everything that is a boundary
			 * rather than a guard is enforced where this cannot reach it: writes
			 * outside the root in `agent_write_file`, and the per-turn checkpoint
			 * outside the gate altogether.
			 */
			if (policy === 'bypass') {
				return undefined;
			}
			/*
			 * What the tool *does*, not what it is called. `bash` is examined by
			 * its command, which is why the deny list lives here rather than in
			 * the tool's `prepare` hook: this is the one place that can *ask*,
			 * and `prepare` is reserved for rewriting (rtk).
			 *
			 * This fires in auto mode too. Auto is the permissive end of a policy
			 * dial, not the absence of one, and the floor is the part it cannot
			 * cross.
			 */
			const reason =
				event.toolName === 'bash' && typeof event.input.command === 'string'
					? destructive(event.input.command)
					: undefined;

			if (!reason && (policy === 'auto' || !MUTATING.has(event.toolName))) {
				return undefined;
			}

			const approved = await ask(event.toolCallId, event.toolName, event.input, reason);
			return approved ? undefined : { block: true, reason: 'The user declined this change.' };
		},

		resolve: settle,
		// Treated as a decline: the call must not proceed on a run the user
		// stopped. The transcript still records the question as unanswered,
		// because cancelling is not an answer.
		abandon: () => {
			while (waiting.length > 0) {
				settle(false);
			}
		},
	};
}
