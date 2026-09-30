import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';

const root = createRoot(document.getElementById('root')!);

if (import.meta.env.DEV && location.hash === '#mascot') {
  void import('./views/MascotSheet').then(({ MascotSheet }) => root.render(<React.StrictMode><MascotSheet /></React.StrictMode>));
} else {
  root.render(<React.StrictMode><App /></React.StrictMode>);
}
