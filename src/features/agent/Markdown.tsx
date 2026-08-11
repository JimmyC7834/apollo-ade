// Transcript Markdown, and the one thing that makes it more than a renderer:
// the `artifact:` protocol survives.
//
// `react-markdown` runs every URL through `defaultUrlTransform`, which drops any
// protocol it does not recognise — so without the transform below every artifact
// reference silently becomes a link with no `href`, and the rule is enforced by a
// library that has never heard of this app.

import { memo } from 'react';
import ReactMarkdown, { defaultUrlTransform, type Components } from 'react-markdown';

import { Icon } from '../../ui';
import { ARTIFACT_SCHEME, resolveArtifact } from './references';

export interface MarkdownProps {
	readonly children: string;
	/** The files that exist, so a reference to one that does not can say so. */
	readonly files: readonly string[];
	readonly onOpenArtifact?: (id: string) => void;
}

/** Let ours through; hand every other URL to the library's own rule. */
function urlTransform(url: string): string | null {
	return url.startsWith(ARTIFACT_SCHEME) ? url : defaultUrlTransform(url);
}

/**
 * Markdown with artifact links, unboxed.
 *
 * Memoised on its text: a streaming turn re-renders the whole transcript on
 * every chunk, and re-parsing every completed turn's Markdown each time is the
 * one place this gets expensive rather than merely wasteful.
 */
export const Markdown = memo(function Markdown({ children, files, onOpenArtifact }: MarkdownProps) {
	const components: Components = {
		a({ href, children: label }) {
			if (!href?.startsWith(ARTIFACT_SCHEME)) {
				// An ordinary link. `target="_blank"` with `rel` because this is a
				// desktop app: a navigation in the workbench frame replaces the app.
				return (
					<a href={href} target="_blank" rel="noreferrer noopener">
						{label}
					</a>
				);
			}
			const id = resolveArtifact(href, files);
			if (!id) {
				/*
				 * A reference to an artifact that does not exist. Rendered as a
				 * failure rather than as a link that opens nothing: a dead click with
				 * no error surface is precisely the thing the harness-emits rule was
				 * decided to avoid, and it can still happen — a file referenced by a
				 * completed turn can be deleted afterwards.
				 */
				return (
					<span className="ide-md-artifact-broken" title={`${href} — no such artifact`}>
						<Icon name="warning" />
						{label}
					</span>
				);
			}
			return (
				<button
					type="button"
					className="ide-md-artifact"
					onClick={() => onOpenArtifact?.(id)}
				>
					{label}
				</button>
			);
		},
	};

	return (
		<div className="ide-md">
			<ReactMarkdown urlTransform={urlTransform} components={components}>
				{children}
			</ReactMarkdown>
		</div>
	);
});
