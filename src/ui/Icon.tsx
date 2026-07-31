import '@vscode/codicons/dist/codicon.css';

export interface IconProps {
	/** Codicon name without the `codicon-` prefix, e.g. "files", "search". */
	readonly name: string;
	/** Icons are decorative by default; the labelled control around them carries the meaning. */
	readonly label?: string;
}

export function Icon({ name, label }: IconProps) {
	return (
		<span
			className={`codicon codicon-${name}`}
			role={label ? 'img' : undefined}
			aria-label={label}
			aria-hidden={label ? undefined : true}
		/>
	);
}
