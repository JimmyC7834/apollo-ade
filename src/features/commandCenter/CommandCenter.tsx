import { useEffect, useMemo, useRef, useState } from 'react';

import { commandLabel, type Command } from '../../commands/commandRegistry';
import { fuzzyFilter } from '../../commands/fuzzy';
import { Icon, Overlay } from '../../ui';
import type { WorkspaceEntry } from '../../workspace';

export interface CommandCenterProps {
	readonly open: boolean;
	readonly commands: readonly Command[];
	readonly files: readonly WorkspaceEntry[];
	readonly onOpenFile: (entry: WorkspaceEntry) => void;
	readonly onClose: () => void;
}

const COMMAND_PREFIX = '>';
const MAX_RESULTS = 50;

type Result =
	| { readonly kind: 'command'; readonly id: string; readonly label: string }
	| { readonly kind: 'file'; readonly id: string; readonly label: string; readonly detail: string };

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
	onOpenFile,
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
				.map(({ item }) => ({ kind: 'command', id: item.id, label: commandLabel(item) }));
		}
		const onlyFiles = files.filter((entry) => entry.kind === 'file');
		return fuzzyFilter(query.trim(), onlyFiles, (entry) => entry.name)
			.slice(0, MAX_RESULTS)
			.map(({ item }) => ({
				kind: 'file',
				id: item.id,
				label: item.name,
				detail: item.id,
			}));
	}, [query, commands, files]);

	// The query changing invalidates the previous selection.
	useEffect(() => {
		setActiveIndex(0);
	}, [query]);

	function accept(result: Result | undefined): void {
		if (!result) {
			return;
		}
		// Close first, so focus restoration happens before the command runs and
		// a command that moves focus itself is not immediately overridden.
		onClose();
		if (result.kind === 'command') {
			commands.find((command) => command.id === result.id)?.run();
		} else {
			const entry = files.find((file) => file.id === result.id);
			if (entry) {
				onOpenFile(entry);
			}
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
				aria-label="Type a command, or a filename without the leading angle bracket"
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
						className={`ide-quickpick-row${index === activeIndex ? ' ide-quickpick-row-active' : ''}`}
						// Mouse down would steal focus from the input before the click lands.
						onMouseDown={(event) => event.preventDefault()}
						onClick={() => accept(result)}
					>
						<Icon name={result.kind === 'command' ? 'gear' : 'file'} />
						<span className="ide-quickpick-label">{result.label}</span>
						{result.kind === 'file' ? (
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
