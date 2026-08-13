// Whether a command goes through rtk, and what it becomes if it does.
//
// Settled by docs/wayfinder/pi-harness/tickets/11-rtk-in-profile.md, amendment
// 6. Rust owns getting the binary (`src-tauri/src/rtk.rs`); this owns the
// policy, and the policy is one line:
//
//     resolve → rtk rewrites → deny list → gate → run → stripControl
//
// **The ordering is the decision.** rtk replaces the command it is given for 27
// of the tools it knows — `git status` really runs as `git status --porcelain
// -b` inside it — so gating on what the model asked for would leave the
// approval card describing something other than what runs, and would put the
// rewrite *after* the deny list that screens resolved argv. Rewriting first
// means there is exactly one command in the system and everything downstream
// reasons about the same bytes.
//
// Scope: **every command the agent runs**, `bash` and user-authored tools
// alike. **Never the integrated terminal** — a human reads that, a human can
// alias it, and the saving this exists for is tokens.

// `.ts` explicitly, because `rtk.check.ts` runs this file under bare node and
// node does not guess extensions. The rest of `src/` omits it; this module is
// one of the few with a static import that has to survive outside vite.
import { isTauri } from '../native.ts';

/** The pin, mirrored from `rtk.rs` so the UI can say which version it means. */
export const RTK_VERSION = 'v0.45.0';

/** What Rust found, as it found it. */
export interface RtkStatus {
	/** `path` — the machine's own install. `cached` — ours, fetched and verified. */
	readonly source: 'path' | 'cached' | 'unavailable';
	/** What to put in front of a command. Absent when unavailable. */
	readonly path?: string | null;
	/** The version that answered, which is not necessarily the version pinned. */
	readonly version?: string | null;
	readonly message?: string | null;
}

const BROWSER: RtkStatus = {
	source: 'unavailable',
	message: 'rtk needs the native shell, and browser mode has none',
};

/**
 * One attempt per app run, success or failure.
 *
 * Memoising the *promise* is what makes the eager prefetch and a bash call
 * racing it share one download rather than two. Failures are memoised too, on
 * purpose: a machine that is offline now is offline in ten seconds, and
 * retrying the fetch on every profile switch would turn one visible failure
 * into a stutter nobody can read. Restarting the app is the retry.
 */
let attempt: Promise<RtkStatus> | undefined;

export function resolveRtk(): Promise<RtkStatus> {
	attempt ??= (async () => {
		if (!isTauri()) {
			return BROWSER;
		}
		try {
			const { invoke } = await import('@tauri-apps/api/core');
			return await invoke<RtkStatus>('rtk_resolve');
		} catch (cause) {
			// `rtk_resolve` answers rather than throwing, so reaching here means
			// the IPC itself failed. Still not fatal: the command runs unfiltered.
			return {
				source: 'unavailable',
				message: cause instanceof Error ? cause.message : String(cause),
			};
		}
	})();
	return attempt;
}

/**
 * Shell syntax rtk must not be put in front of.
 *
 * `rtk cd src && npm run build` runs `cd src` under rtk and then `npm run
 * build` bare, which is not what anybody asked for — and for a redirection or a
 * pipeline it is worse than useless. A model writes compound lines constantly,
 * so this is the common case rather than the exotic one, and the honest answer
 * for all of them is to leave the line alone.
 *
 * Two omissions worth knowing: a leading `VAR=value` assignment is caught
 * separately below, and quoting is not parsed at all — an `&&` inside a quoted
 * string costs the line its rewrite and nothing else. Both errors fall the safe
 * way, which is towards running what the model wrote.
 */
const COMPOUND = /[|&;<>`\n]|\$\(/;

/**
 * The command, through rtk — or `undefined` when it must be left alone.
 *
 * Pure, and the reason this file is checkable without a shell.
 */
export function rtkCommand(command: string, program: string): string | undefined {
	const trimmed = command.trim();
	if (trimmed === '' || COMPOUND.test(trimmed)) {
		return undefined;
	}
	// `FOO=bar cmd` is a shell feature, not a program, and rtk would try to run
	// it as one.
	const first = trimmed.split(/\s+/)[0] ?? '';
	if (first.includes('=')) {
		return undefined;
	}
	// Already wrapped — by a hook that ran twice, or by a model that has seen
	// rtk in its own transcript and copied the shape. Unquoted first, because
	// the form *this function* produces is a quoted absolute path, so the
	// double-wrap it most needs to catch is its own.
	if (isRtk(first.replace(/^'|'$/g, ''))) {
		return undefined;
	}
	const quoted = quoteProgram(program);
	return quoted === undefined ? undefined : `${quoted} ${trimmed}`;
}

/** Is this word rtk already — bare, or as either platform's path? */
function isRtk(word: string): boolean {
	return /(^|[/\\])rtk(\.exe)?$/i.test(word);
}

/**
 * The binary's path as a shell word.
 *
 * The cached path is a Windows one — `C:\Users\…\AppData\…\rtk.exe` — and the
 * shell is Git Bash, where every backslash is an escape. Forward slashes are
 * accepted by Windows itself, so converting and single-quoting is the whole
 * job. A path containing a single quote is refused rather than escaped: it
 * cannot happen under an app data directory, and a wrong guess about quoting is
 * how a path turns into an argument.
 */
function quoteProgram(program: string): string | undefined {
	if (program === 'rtk') {
		return program;
	}
	if (program.includes("'")) {
		return undefined;
	}
	return `'${program.replace(/\\/g, '/')}'`;
}

/**
 * A user tool's argv, through rtk — or unchanged.
 *
 * The counterpart of `rewriteToolCall` for the other half of scope: a user tool
 * is the agent spending tokens on command output exactly as `bash` is. It
 * resolves rather than taking a path, so `RtkStatus.path` stays inside this
 * module and the two call sites cannot drift on what "available" means.
 *
 * Returns the argv it was given when rtk is unavailable, so the caller has
 * nothing to branch on beyond the profile flag — and *that* branch belongs to
 * the caller, because awaiting this at all defers the approval question by a
 * microtask, which a profile with rtk off should not pay.
 */
export async function rtkArgvFor(argv: readonly string[]): Promise<readonly string[]> {
	const status = await resolveRtk();
	return (status.path && rtkArgv(argv, status.path)) || argv;
}

/**
 * The pure half of the above, and the checkable one.
 *
 * Nothing to parse and nothing to quote — Rust spawns the array directly — so
 * the only judgement is whether it is already wrapped.
 */
export function rtkArgv(argv: readonly string[], program: string): readonly string[] | undefined {
	const first = argv[0];
	if (first === undefined) {
		return undefined;
	}
	if (isRtk(first)) {
		return undefined;
	}
	return [program, ...argv];
}

/**
 * Said once, and then not again.
 *
 * rtk being unavailable matters more than most degradations and is harder to
 * notice than any of them: its whole job is to make output shorter, so "rtk
 * silently did nothing" and "rtk worked" look identical to a reader and differ
 * only in the bill. Once per app run, because the alternative is the same
 * sentence on every command for the rest of the session.
 */
let announced = false;

export function rtkNotice(status: RtkStatus): string | undefined {
	if (status.source !== 'unavailable' || announced) {
		return undefined;
	}
	announced = true;
	return `rtk is on for this profile but unavailable — ${status.message ?? 'no reason given'}. Commands run unfiltered.`;
}

/**
 * Rewrite a bash call in place, before anything downstream reads it.
 *
 * **Mutating `event.input` is the mechanism, not a shortcut.** pi validates the
 * arguments once and passes *that object* to the `tool_call` hook and then to
 * the tool's `execute` (`agent-loop.js:405-435`), so a hook registered ahead of
 * the gate's is the one place where a rewrite lands on the same bytes the deny
 * list screens, the approval card shows, and the shell runs.
 *
 * **Always resolves to `undefined`**, and the type says so rather than `void`:
 * pi keeps the last non-undefined hook result, so anything returned from here
 * would displace the gate's decision on the very call it was screening.
 *
 * `warn` is optional, and a subagent passes nothing — the notice is once per
 * app run, and a child consuming it would spend the only user-visible warning
 * on a transcript the user is not reading.
 */
export async function rewriteToolCall(
	event: { readonly toolName: string; readonly input: Record<string, unknown> },
	enabled: boolean,
	warn?: (message: string) => void
): Promise<undefined> {
	if (!enabled || event.toolName !== 'bash' || typeof event.input.command !== 'string') {
		return;
	}
	const status = await resolveRtk();
	if (status.source === 'unavailable' || !status.path) {
		const notice = warn && rtkNotice(status);
		if (notice) {
			warn(notice);
		}
		return;
	}
	const rewritten = rtkCommand(event.input.command, status.path);
	if (rewritten !== undefined) {
		event.input.command = rewritten;
	}
}
