import { Icon, type IconName } from './Icon';

export interface IconButtonProps {
	readonly icon: IconName;
	/** Required: an icon-only control is unusable without an accessible name. */
	readonly label: string;
	readonly onClick: () => void;
	readonly pressed?: boolean;
	readonly danger?: boolean;
	readonly disabled?: boolean;
}

export function IconButton({
	icon,
	label,
	onClick,
	pressed,
	danger,
	disabled,
}: IconButtonProps) {
	return (
		<button
			type="button"
			className={`ide-icon-button${danger ? ' ide-icon-button-danger' : ''}`}
			title={label}
			aria-label={label}
			aria-pressed={pressed}
			disabled={disabled}
			onClick={onClick}
		>
			<Icon name={icon} />
		</button>
	);
}
