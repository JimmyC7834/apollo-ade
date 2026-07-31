export type BadgeTone = 'neutral' | 'added' | 'modified' | 'deleted';

export interface BadgeProps {
	/** Short marker, e.g. "M" or a count. */
	readonly label: string;
	/**
	 * Longer text for assistive technology. Required when `label` is an
	 * abbreviation: "M" is meaningless read aloud.
	 */
	readonly title?: string;
	readonly tone?: BadgeTone;
}

/** Small semantic status or count marker. */
export function Badge({ label, title, tone = 'neutral' }: BadgeProps) {
	return (
		<span className={`ide-badge ide-badge-${tone}`} title={title} aria-label={title}>
			{label}
		</span>
	);
}
