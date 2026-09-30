import React from 'react';
import { createRoot } from 'react-dom/client';
import '../src/styles.css';
import { Toasts } from '../src/components/Toasts';
import { pushToast, resetToasts } from '../src/lib/toasts';

createRoot(document.getElementById('root')!).render(<Toasts />);
(window as typeof window & { showToast: (text: string, kind: 'success' | 'failure') => void }).showToast = (text, kind) => {
  resetToasts();
  pushToast(kind, text);
};
