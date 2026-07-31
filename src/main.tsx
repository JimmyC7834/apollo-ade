import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import './App.css';
// Must run before any editor is created.
import './editor/monacoEnvironment';
import { WorkbenchShell } from './workbench/WorkbenchShell';

createRoot(document.querySelector('#root')!).render(
	<StrictMode>
		<WorkbenchShell />
	</StrictMode>
);
