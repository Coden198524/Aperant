// Initialize browser mock before anything else (no-op in Electron)
import './lib/browser-mock';

// Initialize i18n before React
import '../shared/i18n';

import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import './styles/globals.css';

if (window.DEBUG) {
  console.log('[Renderer] Starting renderer process...');
  console.log('[Renderer] window.electronAPI:', window.electronAPI);
  console.log('[Renderer] window.electronAPI.onTaskTokenUsage:', window.electronAPI?.onTaskTokenUsage);
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

if (window.DEBUG) {
  console.log('[Renderer] App component rendered');
}
