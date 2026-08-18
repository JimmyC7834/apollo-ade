import { useEffect, useMemo, useRef, useState } from 'react';

import { TOOL_ARTIFACTS, type ToolArtifactKind } from '../../artifacts';
import { commandLabel, type Command } from '../../commands/commandRegistry';
import { fuzzyFilter } from '../../commands/fuzzy';
import type { TranscriptHit } from '../agent/transcript';
import type { Session, WorkspaceGroup } from '../../sessions';
import { Icon, type IconName, Overlay } from '../../ui';
import type { WorkspaceEntry } from '../../workspace';

export interface CommandCenterProps {
	readonly open: boolean;
	readonly commands: readonly Command[];
	readonly files: readonly WorkspaceEntry[];
	/** Every session the navigator draws, fixtures included and marked. */
	readonly groups: readonly WorkspaceGroup[];
	readonly onOpenFile: (entry: WorkspaceEntry) => void;
	/** Pin or raise an artifact — this is how a result opens the Replace surface. */
	readonly onOpenArtifact: (id: string) => void;
	readonly onSelectSession: (session: Session) => void;
	/** What the live transcript says. A function, so the palette holds no copy. */
	readonly searchTranscript: (term: string) => readonly TranscriptHit[];
	readonly onClose: () => void;
}

const COMMAND_PREFIX = '>';
const MAX_RESULTS = 50;

interface BaseResult {
	readonly id: string;
	readonly label: string;
	/** Muted trailing text: a file's path, or why a command cannot run. */
	readonly detail?: string;
}

/**
 * What a result is, and where activating it goes.
 *
 * Each kind names its own source on the row, because the four are searched
 * together: a row that says only "Replace" is ambiguous between an artifact, a
 * command and a line somebody typed.
 */
type Result =
	| (BaseResult & { readonly kind: 'command'; readonly disabled?: string })
	| (BaseResult & { readonly kind: 'file' })
	| (BaseResult & { readonly kind: 'session'; readonly session: Session })
	| (BaseResult & { readonly kind: 'artifact' })
	| (BaseResult & { readonly kind: 'transcript' });

/** The word on the row that says which of the five this is. */
const SOURCE_LABEL: Record<Result['kind'], string> = {
	command: 'Command',
	file: 'File',
	session: 'Session',
	artifact: 'Artifact',
	transcript: 'Transcript',
};

const SOURCE_ICON: Record<Result['kind'], IconName> = {
	command: 'gear',
	file: 'file',
	session: 'comment-discussion',
	artifact: 'layout',
	transcript: 'quote',
};

const PER_SOURCE = 8;

/**
 * Quick pick over commands and files.
 *
 * Mode is chosen by prefix, as in VS Code: `>` searches commands, bare text
 * searches files. The two lists are scored by the same function but never
 * blended — mixing them is what makes a palette feel unpredictable.
 */
export function CommandCenter({
	open,
	commands,
	files,
	groups,
	onOpenFile,
	onOpenArtifact,
	onSelectSession,
	searchTranscript,
	onClose,
}: CommandCenterProps) {
	const [query, setQuery] = useState(COMMAND_PREFIX);
	const [activeIndex, setActiveIndex] = useState(0);
	const listRef = useRef<HTMLUListElement>(null);

	// Every opening starts from a clean, predictable state.
	useEffect(() => {
		if (open) {
			setQuery(COMMAND_PREFIX);
			setActiveIndex(0);
		}
	}, [open]);

	const results = useMemo<Result[]>(() => {
		if (query.startsWith(COMMAND_PREFIX)) {
			const term = query.slice(COMMAND_PREFIX.length).trim();
			return fuzzyFilter(term, commands, commandLabel)
				.slice(0, MAX_RESULTS)
				.map(({ item }) => ({
					kind: 'command',
					id: item.id,
					label: commandLabel(item),
					disabled: item.disabled,
					detail: item.disabled,
				}));
		}
		/*
		 * Four sources, searched together and **kept in a fixed order** rather than
		 * interleaved by score. The old comment here said the two lists were never
		 * blended because mixing them makes a palette unpredictable; ticket 44 asks
		 * for one search across four things, so the answer is a stable order and a
		 * source label on every row — the same score across different kinds of
		 * thing is not a comparable number.
		 */
		const term = query.trim();
		const results: Result[] = [];

		const onlyFiles = files.filter((entry) => entry.kind === 'file');
		results.push(
			...fuzzyFilter(term, onlyFiles, (entry) => entry.name)
				.slice(0, PER_SOURCE)
				.map(({ item }): Result => ({
					kind: 'file',
					id: item.id,
					label: item.name,
					detail: item.id,
				}))
		);

		const sessions = groups.flatMap((group) =>
			group.sessions.map((session) => ({ session, group }))
		);
		results.push(
			...fuzzyFilter(term, sessions, (entry) => entry.session.name)
				.slice(0, PER_SOURCE)
				.map(({ item }): Result => ({
					kind: 'session',
					id: item.session.id,
					label: item.session.name,
					// The prototype marking from slice 39, carried into the palette:
					// a fixture must not be mistakable for a session with a harness.
					detail: `${item.group.label}${item.session.live ? '' : ' · fixture'}`,
					session: item.session,
				}))
		);

		const artifacts = (Object.keys(TOOL_ARTIFACTS) as ToolArtifactKind[]).map(
			(kind) => TOOL_ARTIFACTS[kind]
		);
		results.push(
			...fuzzyFilter(term, artifacts, (artifact) => artifact.title)
				.slice(0, PER_SOURCE)
				.map(({ item }): Result => ({ kind: 'artifact', id: item.id, label: item.title }))
		);

		results.push(
			...searchTranscript(term)
				.slice(0, PER_SOURCE)
				.map((hit, index): Result => ({
					kind: 'transcript',
					id: `${hit.turnId}:${index}`,
					label: hit.label,
					detail: hit.detail,
				}))
		);

		return results.slice(0, MAX_RESULTS);
	}, [query, commands, files, groups, searchTranscript]);

	// The query changing invalidates the previous selection.
	useEffect(() => {
		setActiveIndex(0);
	}, [query]);

	function accept(result: Result | undefined): void {
		if (!result) {
			return;
		}
		// Blocked commands stay selectable so a screen reader can read the
		// reason, but activating one does nothing and leaves the palette open.
		if (result.kind === 'command' && result.disabled) {
			return;
		}
		// Close first, so focus restoration happens before the command runs and
		// a command that moves focus itself is not immediately overridden.
		onClose();
		if (result.kind === 'command') {
			commands.find((command) => command.id === result.id)?.run();
			return;
		}
		if (result.kind === 'artifact') {
			onOpenArtifact(result.id);
			return;
		}
		if (result.kind === 'session') {
			onSelectSession(result.session);
			return;
		}
		if (result.kind === 'transcript') {
			// Nothing to open: the transcript is already on screen behind this, and
			// there is one of it. Scrolling to the line would be a nice thing to
			// have and is not what a search result promised.
			return;
		}
		const entry = files.find((file) => file.id === result.id);
		if (entry) {
			onOpenFile(entry);
		}
	}

	function onKeyDown(event: React.KeyboardEvent): void {
		if (event.key === 'ArrowDown') {
			event.preventDefault();
			setActiveIndex((index) => (results.length === 0 ? 0 : (index + 1) % results.length));
		} else if (event.key === 'ArrowUp') {
			event.preventDefault();
			setActiveIndex((index) =>
				results.length === 0 ? 0 : (index - 1 + results.length) % results.length
			);
		} else if (event.key === 'Enter') {
			event.preventDefault();
			accept(results[activeIndex]);
		}
	}

	// Keep the active row scrolled into view during keyboard navigation.
	useEffect(() => {
		listRef.current
			?.querySelectorAll('li')
			[activeIndex]?.scrollIntoView({ block: 'nearest' });
	}, [activeIndex]);

	const activeId = results[activeIndex] ? `quickpick-${activeIndex}` : undefined;

	return (
		<Overlay open={open} title="Command center" titleHidden onClose={onClose} className="ide-quickpick">
			<input
				className="ide-quickpick-input"
				value={query}
				onChange={(event) => setQuery(event.target.value)}
				onKeyDown={onKeyDown}
				aria-label="Type a command, or search sessions, files, artifacts and the transcript without the leading angle bracket"
				aria-controls="quickpick-list"
				aria-activedescendant={activeId}
				aria-autocomplete="list"
				role="combobox"
				aria-expanded
				spellCheck={false}
			/>
			<ul className="ide-quickpick-list" id="quickpick-list" role="listbox" ref={listRef}>
				{results.map((result, index) => (
					<li
						key={`${result.kind}:${result.id}`}
						id={`quickpick-${index}`}
						role="option"
						aria-selected={index === activeIndex}
						aria-disabled={result.kind === 'command' && result.disabled ? true : undefined}
						className={
							'ide-quickpick-row' +
							(index === activeIndex ? ' ide-quickpick-row-active' : '') +
							(result.kind === 'command' && result.disabled
								? ' ide-quickpick-row-disabled'
								: '')
						}
						// Mouse down would steal focus from the input before the click lands.
						onMouseDown={(event) => event.preventDefault()}
						onClick={() => accept(result)}
					>
						<Icon name={SOURCE_ICON[result.kind]} />
						<span className="ide-quickpick-label">{result.label}</span>
						{/* Which of the five this is. Spoken as well as shown, because
						    the icon is decorative and the label alone is ambiguous. */}
						<span className="ide-quickpick-source">{SOURCE_LABEL[result.kind]}</span>
						{result.detail ? (
							<span className="ide-quickpick-detail">{result.detail}</span>
						) : null}
					</li>
				))}
			</ul>
			<p className="ide-quickpick-status" role="status">
				{results.length === 0
					? 'No matching results'
					: `${results.length} result${results.length === 1 ? '' : 's'}`}
			</p>
		</Overlay>
	);
}
