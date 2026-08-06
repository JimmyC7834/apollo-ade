import '@vscode/codicons/dist/codicon.css';

export interface IconProps {
	/** Codicon name without the `codicon-` prefix, e.g. "files", "search". */
	readonly name: string;
}

/**
 * Decorative by definition: the labelled control around an icon carries the
 * meaning, so every icon is hidden from assistive technology. The optional
 * `label` that used to make one an `img` had no caller in two years of slices
 * — an icon that needs a name means the control around it is missing one.
 */
export function Icon({ name }: IconProps) {
	return <span className={`codicon codicon-${name}`} aria-hidden={true} />;
}
