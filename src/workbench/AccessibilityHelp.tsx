import { Overlay } from '../ui';

export interface AccessibilityHelpProps {
	readonly open: boolean;
	readonly onClose: () => void;
}

export function AccessibilityHelp({ open, onClose }: AccessibilityHelpProps) {
	return (
		<Overlay open={open} title="Keyboard help" onClose={onClose}>
			<dl className="ide-help-list">
				<dt>Ctrl+Shift+P</dt>
				<dd>Open the command center. Delete the leading &gt; to search files.</dd>
				<dt>Enter in the prompt</dt>
				<dd>Send the prompt to the agent. Shift+Enter adds a newline instead.</dd>
				<dt>Stop</dt>
				<dd>Cancel the running agent. Focus returns to the prompt when a run ends.</dd>
				<dt>Continue / Skip</dt>
				<dd>Answer an approval request. The agent waits and does nothing until you do.</dd>
				<dt>Plain text transcript</dt>
				<dd>Open the whole conversation as plain text, including tool activity.</dd>
				<dt>Who said what</dt>
				<dd>
					Turns carry a spoken speaker label. Nothing is shown on screen — the card and the
					alignment do that job for a sighted reader, and neither is announced.
				</dd>
				<dt>Enter or Space on an event chip</dt>
				<dd>
					Expand a tool call or a state change in place, beneath the chip. Its details may
					include command output and a link to the artifact it produced.
				</dd>
				<dt>Ctrl+S</dt>
				<dd>Save the active editor. Unsaved tabs show a dot instead of a close button.</dd>
				<dt>Tab / Shift+Tab</dt>
				<dd>Move between the titlebar, the session navigator, chat, and the artifact dock.</dd>
				<dt>Tab into the session navigator</dt>
				<dd>
					Expands it, so session names are readable without a pointer. Leaving it collapses
					it again. Rows marked “fixture” are prototype content with no agent behind them.
				</dd>
				<dt>Arrow keys on the dock edge</dt>
				<dd>
					Resize the artifact dock in 2% steps. The edge has no visible handle but is
					focusable.
				</dd>
				<dt>Arrow keys in the file tree</dt>
				<dd>Move between files; left and right collapse and expand folders.</dd>
				<dt>Shift+Tab in the terminal</dt>
				<dd>Leave the terminal. Tab itself is sent to the shell.</dd>
				<dt>Escape</dt>
				<dd>
					Close this dialog. In the editor it dismisses the editor; open tabs, splits and
					unsaved edits are kept.
				</dd>
			</dl>
			<p className="ide-help-note">
				Collapsing the artifact dock while the keyboard focus is inside it moves focus back
				to chat.
			</p>
			<button type="button" className="ide-button" onClick={onClose}>
				Close
			</button>
		</Overlay>
	);
}
