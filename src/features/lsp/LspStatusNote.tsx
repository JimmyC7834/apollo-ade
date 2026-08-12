// What the language server is doing, in the Problems panel — ticket 33.
//
// It goes here rather than in a status bar or a notification because this is
// where its output goes: a panel that says "No problems" while the only thing
// that could find them was never installed is the same lie ticket 32's scope
// note exists to avoid. One sentence, and a button when there is something to
// press.

import type { LspStatus } from './client';

export interface LspStatusNoteProps {
	readonly status: LspStatus | undefined;
	readonly onRestart: () => void;
}

export function LspStatusNote({ status, onRestart }: LspStatusNoteProps) {
	if (!status || status.state === 'off') {
		return null;
	}

	// `missing` is not a failure of this app and must not read like one, so it
	// gets the plainest sentence of the four. It still gets the button, which
	// looks wrong until you read its sentence: installing the server is
	// something the user does *outside* this window, and the button is how they
	// pick it up without restarting the app.
	const sentence: Record<LspStatus['state'], string> = {
		off: '',
		unavailable: `${status.server} needs the desktop app; the browser has no process to start it in.`,
		starting: `${status.server} is starting. A large project takes a while to index, and nothing is blocked while it does.`,
		ready: `${status.server} is running, so ${status.language} files are checked too.`,
		missing: `${status.server} is not installed, so ${status.language} files are not checked. Install it and restart.`,
		crashed: `${status.server} stopped, so ${status.language} files are no longer checked.`,
	};

	return (
		<p className="ide-problems-scope" role="status">
			{sentence[status.state]}
			{status.state === 'crashed' || status.state === 'missing' ? (
				<>
					{' '}
					<button type="button" className="ide-button" onClick={onRestart}>
						Restart {status.server}
					</button>
				</>
			) : null}
		</p>
	);
}
