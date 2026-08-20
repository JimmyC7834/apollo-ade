import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import './App.css';
// Must run before any editor is created.
import './editor/monacoEnvironment';
import { pluginHost } from './plugins/host';
import { WorkbenchController } from './workbench/WorkbenchController';

/*
 * **Plugins load before React mounts**, which is the whole point of ticket 72's
 * injection: a plugin that claims a command has to have claimed it by the time
 * the command centre first renders, or the palette would be built once without
 * it and once with it. A directory read costs a frame at start-up and buys that.
 *
 * Global plugins only — a local one lives under a root and there is no root yet.
 * `WorkbenchController` calls `load` again once one has been opened.
 *
 * `then`, not top-level `await`: the build target has no TLA, and the ordering
 * is what matters rather than the syntax.
 *
 * **`finally`, so the ADE starts whatever happens.** `load` already turns every
 * per-plugin failure into a line in Problems; this is the one failure it cannot
 * catch — itself — and a workbench that will not open because somebody's plugin
 * folder is malformed is the worst outcome available here.
 */
function mount(): void {
	createRoot(document.querySelector('#root')!).render(
		<StrictMode>
			<WorkbenchController />
		</StrictMode>
	);
}

void pluginHost
	.load()
	.catch((cause: unknown) => console.error('plugins failed to load', cause))
	.finally(mount);
