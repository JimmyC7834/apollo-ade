import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import './App.css';
// Must run before any editor is created.
import './editor/monacoEnvironment';
import { WorkbenchController } from './workbench/WorkbenchController';

createRoot(document.querySelector('#root')!).render(
	<StrictMode>
		<WorkbenchController />
	</StrictMode>
);
