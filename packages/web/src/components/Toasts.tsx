import { useEffect, useSyncExternalStore } from 'react';
import { currentToasts, dismissToast, subscribeToasts, type Toast } from '../lib/toasts';

/** How long a success toast stays before it dismisses itself; a failure waits for the user. */
export const TOAST_MS = 5000;

function ToastItem({ toast }: { toast: Toast }) {
  useEffect(() => {
    if (toast.kind !== 'success') return;
    const t = setTimeout(() => dismissToast(toast.id), TOAST_MS);
    return () => clearTimeout(t);
  }, [toast.id, toast.kind]);
  return (
    <div className={`toast toast-${toast.kind}`} role={toast.kind === 'success' ? 'status' : 'alert'}>
      <span className="toast-text">{toast.text}</span>
      <button className="link toast-dismiss" onClick={() => dismissToast(toast.id)} aria-label="Dismiss">×</button>
    </div>
  );
}

/**
 * The action results, stacked in a corner: a success dismisses itself, a failure stays until dismissed and shows the
 * daemon's message. Every toast is reachable by keyboard through its dismiss control.
 */
export function Toasts() {
  const toasts = useSyncExternalStore(subscribeToasts, currentToasts);
  return <div className="toasts" data-testid="toasts">{toasts.map((t) => <ToastItem key={t.id} toast={t} />)}</div>;
}
