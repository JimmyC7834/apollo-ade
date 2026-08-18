// A tool call or a state change, as one compact pill between Markdown
// paragraphs.
//
// A `<details>` rather than a button and a conditional block, because that is
// exactly what this is — a disclosure whose expansion belongs *beneath the chip*
// and nowhere else. The Guide is explicit that expanding must not open another
// surface, and `<details>` cannot: it has no other surface to open. It also
// carries the expanded state to a screen reader without a single aria attribute.

import type { ReactNode } from 'react';

import { Icon, type IconName } from '../../ui';

export interface EventChipProps {
	/** The glyph in front of the label — see `Icon`. */
	readonly icon: IconName;
	readonly label: string;
	/** The outcome at chip width — see `compactResult`. */
	readonly result?: string;
	/** Drives the marker colour, via `--status-*`. */
	readonly state?: 'running' | 'done' | 'failed';
	/** Read instead of the visible text, when the visible text is not enough. */
	readonly ariaLabel?: string;
	readonly children?: ReactNode;
}

export function EventChip({ icon, label, result, state, ariaLabel, children }: EventChipProps) {
	const head = (
		<>
			<Icon name={icon} />
			<span className="ide-chip-label">{label}</span>
			{result ? <span className="ide-chip-result">{result}</span> : null}
		</>
	);

	// A chevron that expands nothing is a lie, so a chip with no details is not
	// a disclosure at all.
	if (!children) {
		return (
			<p className="ide-chip" data-state={state} aria-label={ariaLabel}>
				{head}
			</p>
		);
	}

	return (
		<details className="ide-chip ide-chip-open" data-state={state}>
			<summary aria-label={ariaLabel}>
				{head}
				<Icon name="chevron-right" />
			</summary>
			<div className="ide-chip-body">{children}</div>
		</details>
	);
}
