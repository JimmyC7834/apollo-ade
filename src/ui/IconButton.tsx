import { Icon } from './Icon';

export interface IconButtonProps {
	readonly icon: string;
	/** Required: an icon-only control is unusable without an accessible name. */
	readonly label: string;
	readonly onClick: () => void;
	readonly pressed?: boolean;
	readonly danger?: boolean;
	readonly className?: string;
}

export function IconButton({ icon, label, onClick, pressed, danger, className }: IconButtonProps) {
	return (
		<button
			type="button"
			className={`ide-icon-button${danger ? ' ide-icon-button-danger' : ''}${className ? ` ${className}` : ''}`}
			title={label}
			aria-label={label}
			aria-pressed={pressed}
			onClick={onClick}
		>
			<Icon name={icon} />
		</button>
	);
}
