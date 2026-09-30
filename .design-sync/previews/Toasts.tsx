import { useEffect } from 'react';
import { Toasts, pushToast, dismissToast } from '@overseer/web';

// The store is module-level: seed it once per mount and clear what this story pushed on unmount.
export const ActionResults = () => {
  useEffect(() => {
    const ids = [
      pushToast('failure', 'Merge refused for b-m2ve: it waits on b-q4sd, which changes packages/web/src/styles.css too.'),
      pushToast('failure', 'Re-dispatch failed for overseer-2xp: no usable account in the standard tier.'),
      pushToast('success', 'Batch b-a1ke merged.'),
    ];
    return () => ids.forEach(dismissToast);
  }, []);
  return <div style={{ height: 240, background: 'var(--bg)' }}><Toasts /></div>;
};
