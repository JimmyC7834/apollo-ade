import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import './App.css';
import { WorkbenchShell } from './workbench/WorkbenchShell';

createRoot(document.querySelector('#root')!).render(
	<StrictMode>
		<WorkbenchShell />
	</StrictMode>
);
