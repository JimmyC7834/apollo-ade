// What the model sees of a command's output, minus the bytes no terminal is
// listening for.
//
// **This file used to have rules, and ticket 11 took them away.** It once
// carried one transcribed rtk filter — npm's, worth 0.3% of an `npm run build`
// — as the reachable half of rtk's savings: the class of commands where rtk
// runs the user's exact argv and only drops lines. Amendment 6 settled the
// other half instead, by fetching rtk itself (`src-tauri/src/rtk.rs`), and a
// hand-maintained copy of somebody else's filter table drifting against
// upstream is the cost that was never worth paying once the real one was
// running. `RULES`, `ruleFor`, `CropRule` and rtk's never-worse guard went with
// it.
//
// What is left is the part that was never rtk's, and the part that pays:
// **control codes are stripped from every command's output, always.** It runs
// after rtk rather than instead of it, because rtk cannot do this job — its
// `strip_ansi` lives inside per-command TOML filters, and **zero of the 63 fire
// on `cargo`, `npm`, `tsc`, `git`, `vite`, `rustc`, `clippy` or `node`**. With
// rtk fully enabled and working, `npm run build` still hands the model its
// escape bytes.
//
// The honest case for it is **free, unconditional and occasionally enormous**,
// not a headline rate. Measured on piped stdout, exactly as `exec.rs` captures
// it: `npm run build` is 38.2% escapes and `npx vite build` 38.3%, while `npm
// run check`, `cargo build`, `cargo test`, `npx tsc`, `git status` and `git
// log` are all **zero** — vite colours even when its output is a pipe, and
// everything else detects the non-TTY. So on a project that is all cargo and
// tsc this earns nothing, which is fine for a stage costing one regex. For an
// ADE it is still the right shape of argument, because the tools that
// colour-when-piped are exactly the ones nobody predicted.
//
// Two rules keep it from doing invisible damage:
//
//   1. **No line is ever lost.** It removes no content, only the bytes that
//      were telling a terminal what colour to be, and there is no terminal
//      here.
//   2. **It says what it dropped.** The caller appends a note, the same way
//      `env.ts` already says `[output truncated at 8 MiB]`. A model reasoning
//      from a silently shortened log is the failure this whole idea risks, and
//      it looks exactly like the model being stupid.

/**
 * CSI sequences — the ANSI control-sequence grammar, not just colour.
 *
 * Written as the grammar rather than as `\x1b\[[0-9;]*m` because the same tools
 * that colour also move the cursor: `\x1b[2K` and `\x1b[1A` are how a progress
 * bar rewrites its own line, and piped output keeps every frame of that. Both
 * shapes are pure terminal instruction and neither survives usefully in a
 * transcript.
 *
 * Not stripped: bare `\r`. It is the *other* half of how progress bars
 * overdraw, and dropping it would silently join lines that a terminal would
 * have shown separately. Rejoining those needs a decision about which frame to
 * keep, which is a rule, not a strip. Deferred until something measures it.
 */
const CONTROL = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

/** What a terminal would have rendered, as plain text. */
export function stripControl(text: string): string {
	return text.replace(CONTROL, '');
}

/**
 * What to tell the model, appended to stderr by the caller.
 *
 * Bytes rather than lines, because bytes are the thing being spent and because
 * no line is lost. Every strip that happens leaves its number in the
 * transcript, which is the only measurement of this stage there is.
 */
export function stripNote(before: string, after: string): string | undefined {
	if (after.length === before.length) {
		return undefined;
	}
	return `[stripped terminal control codes, ${before.length} to ${after.length} bytes]`;
}
