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
