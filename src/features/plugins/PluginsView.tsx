// The plugin list — ticket 72.
//
// Every folder discovery found, loadable or not, running or not. A broken plugin
// is listed with its reason rather than dropped, for the reason `plugins.rs`
// gives: a folder that vanishes from the list is indistinguishable from one that
// was never copied in, and the list is where the user looks next.
//
// **The two states have to be obvious**, which is what most of this file is
// about. A global plugin is running because putting the folder there was the
// decision. A local plugin arrived with somebody's repository and is *listed and
// inert* until it is enabled for this root — cloning is not the same act as
// running the author's code, and a list that showed both the same way would make
// it one.

import { Badge, type BadgeTone } from '../../ui';
import type { ListedPlugin } from '../../plugins/host';

export interface PluginsViewProps {
	readonly plugins: readonly ListedPlugin[];
	readonly globalDir: string | undefined;
	readonly localDir: string | undefined;
	readonly onSetEnabled: (id: string, enabled: boolean) => void;
}

function status(plugin: ListedPlugin): { readonly label: string; readonly tone: BadgeTone } {
	if (plugin.reason) {
		return { label: 'Failed', tone: 'deleted' };
	}
	if (plugin.loaded) {
		return { label: 'Running', tone: 'added' };
	}
	return { label: 'Not enabled', tone: 'neutral' };
}

export function PluginsView({ plugins, globalDir, localDir, onSetEnabled }: PluginsViewProps) {
	return (
		<div className="ide-problems">
			<p className="ide-problems-scope">
				{globalDir === undefined ? (
					'Plugins are a native feature; there are no folders to read here.'
				) : (
					<>
						Copy a folder into <code>{globalDir}</code> to add a plugin.
						{localDir ? (
							<>
								{' '}
								Plugins in <code>{localDir}</code> came with this project and do not run until
								you enable them.
							</>
						) : null}
					</>
				)}
			</p>
			{plugins.length === 0 ? (
				<p className="ide-problems-scope">No plugins found.</p>
			) : (
				<ul className="ide-plugins">
					{plugins.map((plugin) => {
						const state = status(plugin);
						return (
							<li key={plugin.id} className="ide-plugins-row">
								<div className="ide-plugins-head">
									<span className="ide-plugins-name">{plugin.name}</span>
									<Badge
										label={plugin.scope}
										title={
											plugin.scope === 'local'
												? 'Came with this project'
												: 'Installed for every project'
										}
										tone={plugin.scope === 'local' ? 'modified' : 'neutral'}
									/>
									<Badge label={state.label} tone={state.tone} />
									{/*
									 * Only a local plugin has a switch. A global one is
									 * enabled by being where it is, and a second way to
									 * say that would be a second thing to disagree.
									 */}
									{plugin.scope === 'local' ? (
										<button
											type="button"
											className="ide-plugins-toggle"
											onClick={() => onSetEnabled(plugin.id, !plugin.enabled)}
										>
											{plugin.enabled ? 'Disable' : `Enable ${plugin.name}`}
										</button>
									) : null}
								</div>
								{plugin.description ? (
									<p className="ide-plugins-description">{plugin.description}</p>
								) : null}
								<p className="ide-plugins-dir">{plugin.dir}</p>
								{plugin.reason ? <p className="ide-plugins-reason">{plugin.reason}</p> : null}
							</li>
						);
					})}
				</ul>
			)}
		</div>
	);
}
