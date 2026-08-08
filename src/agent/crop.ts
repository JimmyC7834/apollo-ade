// What the model sees of a command's output, minus the noise.
//
// Settled by docs/wayfinder/pi-harness/RESEARCH-rtk-crop-logic.md, which read
// rtk v0.44.2 and found the load-bearing distinction: rtk's savings come from
// two mechanisms, and only one of them can live here.
//
//   - Commands where rtk **runs the user's exact argv** and drops lines from
//     what came back. That is this file, and it is cheap.
//   - Commands where rtk **runs a different command** — `git status` becomes
//     `git status --porcelain -b` — and renders the result. That is a parser
//     per tool, and it would mean the user approves one command while another
//     runs. Deliberately not here. See ticket 11.
//
// So this is a *post-filter*, structurally. Nothing below can add an argument,
// change a command, or reach the process. It takes a string and returns a
// shorter one.
//
// Three rules keep it from doing invisible damage, and all three are load
// bearing rather than decoration:
//
//   1. **A command with no rule is untouched.** Matching is opt-in. `cat`,
//      `git diff` and everything unrecognised pass through byte for byte.
//   2. **Never worse.** If cropping made the text longer — an `on_empty`
//      standing in for output that was already shorter — the original is
//      returned. Lifted from rtk's own `core/guard.rs:6-12`, which exists for
//      the same reason.
//   3. **It says what it dropped.** The caller appends a note, the same way
//      `env.ts` already says `[output truncated at 8 MiB]`. A model reasoning
//      from a silently shortened log is the failure this whole idea risks, and
//      it looks exactly like the model being stupid.

/** One command's noise, as patterns to drop. */
export interface CropRule {
	/** Which commands this applies to, tested against the whole command line. */
	readonly match: RegExp;
	/** A line matching any of these is dropped. */
	readonly drop: readonly RegExp[];
	/** What to say when every line was dropped. Without it, empty stays empty. */
	readonly onEmpty?: string;
}

export interface Cropped {
	readonly text: string;
	/** Lines removed. Zero means the text is untouched. */
	readonly dropped: number;
	/** Lines the command printed, before cropping. */
	readonly total: number;
}

/**
 * The rules, one command each.
 *
 * **`npm` is transcribed from rtk rather than invented.** `src/cmds/js/npm_cmd.rs:136-168`
 * at v0.44.2 is four `continue`s and an empty-check over the tool's own output,
 * with `"ok"` when nothing survives — the whole filter, and it is class (a) in
 * the research note: same argv, drop lines only. It is here because it is proven
 * and free, not because npm is the biggest spender.
 *
 * **`cargo` and `tsc` are absent on purpose.** Both are class (a′) — rtk keeps
 * the user's argv for them too, so their noise *is* extractable, but the share
 * of their output that is noise has never been measured on this repo. Adding a
 * skip-list on a guess is how a crop starts eating the errors it was supposed to
 * surface. The seam exists now; the numbers decide the next entry.
 *
 * ponytail: a flat array scanned per command. A map keyed on argv[0] matters at
 * a few hundred rules, not at one.
 */
export const RULES: readonly CropRule[] = [
	{
		// rtk's own rewrite rule, `src/discover/rules.rs:90`. The subcommand is
		// always present by the time this sees it, so the bare `npm` that lists
		// scripts is not matched and not cropped.
		match: /^\s*npm\s+(exec|run|run-script|rum|urn|x)(\s|$)/,
		drop: [
			// The `> package@1.0.0 build` banner npm prints before a script, and
			// the command line it echoes under it.
			/^>.*@/,
			/^\s*npm WARN/,
			/^\s*npm notice/,
			// Progress-bar remnants. The two braces are npm's own spinner glyphs;
			// the length bound is what stops `...` inside real prose from going.
			/[⸨⸩]/,
			/^(?=.{0,9}$).*\.\.\./,
			/^\s*$/,
		],
		onEmpty: 'ok',
	},
];

/** The rule for this command, if any. */
export function ruleFor(command: string): CropRule | undefined {
	return RULES.find((rule) => rule.match.test(command));
}

/**
 * Crop one command's output.
 *
 * Pure, and deliberately so — the caller does the logging and the note, which
 * keeps this runnable under `node` in `crop.check.ts` with no environment.
 */
export function crop(command: string, text: string): Cropped {
	const rule = ruleFor(command);
	const lines = text.split('\n');
	const untouched = { text, dropped: 0, total: lines.length };
	if (!rule || text === '') {
		return untouched;
	}

	const kept = lines.filter((line) => !rule.drop.some((pattern) => pattern.test(line)));
	const result = kept.length === 0 && rule.onEmpty !== undefined ? rule.onEmpty : kept.join('\n');

	// Never worse — rtk's `guard.rs:6-12`. An `on_empty` string can be longer
	// than the whitespace it replaced, and a rule that grows its input is a bug
	// the model should never have to see.
	if (result.length >= text.length) {
		return untouched;
	}

	return { text: result, dropped: lines.length - kept.length, total: lines.length };
}

/**
 * What to tell the model, appended to stderr by the caller.
 *
 * Bytes as well as lines because bytes are the thing being spent, and because
 * this is the measurement: every crop that happens leaves a number in the
 * transcript, so what the next rule should be stops being a guess.
 */
export function cropNote(before: string, after: Cropped): string | undefined {
	if (after.dropped === 0) {
		return undefined;
	}
	return (
		`[cropped ${after.dropped} of ${after.total} lines, ` +
		`${before.length} to ${after.text.length} bytes]`
	);
}
