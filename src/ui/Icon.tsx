/*
 * The icon component. The glyphs themselves, and the rule that chose them, are
 * in `glyphs.ts` — a plain module, because `publicNames.ts` promises these names
 * to plugins and its check runs under bare `node`, which cannot parse JSX.
 */
import { glyph, type IconName } from './glyphs.ts';

export type { IconName };

export interface IconProps {
	readonly name: IconName;
}

/**
 * Decorative by definition: the labelled control around an icon carries the
 * meaning, so every icon is hidden from assistive technology. The optional
 * `label` that used to make one an `img` had no caller in two years of slices
 * — an icon that needs a name means the control around it is missing one.
 */
export function Icon({ name }: IconProps) {
	return (
		<span className={`ide-icon ide-icon-${name}`} aria-hidden={true}>
			{glyph(name)}
		</span>
	);
}
