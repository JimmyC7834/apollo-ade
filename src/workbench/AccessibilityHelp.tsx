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
				<dt>Ctrl+S</dt>
				<dd>Save the active editor. Unsaved tabs show a dot instead of a close button.</dd>
				<dt>Tab / Shift+Tab</dt>
				<dd>Move between the titlebar, regions, and separators.</dd>
				<dt>Arrow keys on a separator</dt>
				<dd>Resize the adjacent region in 20px steps.</dd>
				<dt>Home / End on a separator</dt>
				<dd>Resize to the smallest or largest allowed size.</dd>
				<dt>Arrow keys in the file tree</dt>
				<dd>Move between files; left and right collapse and expand folders.</dd>
				<dt>Shift+Tab in the terminal</dt>
				<dd>Leave the terminal. Tab itself is sent to the shell.</dd>
				<dt>Escape</dt>
				<dd>Close this dialog.</dd>
			</dl>
			<p className="ide-help-note">
				Hiding a region that contains the keyboard focus moves focus to the main region.
			</p>
			<button type="button" className="ide-button" onClick={onClose}>
				Close
			</button>
		</Overlay>
	);
}
