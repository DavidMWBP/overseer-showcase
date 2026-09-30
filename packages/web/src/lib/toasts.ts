/**
 * The action-result toasts, held outside React so any view can raise one: a failure is pushed by the view whose request
 * the daemon refused, and every outcome is pushed by the app shell from the `action_result` socket message. The one
 * `<Toasts>` host subscribes and draws them.
 */
export interface Toast { id: number; kind: 'success' | 'failure'; text: string }

let toasts: Toast[] = [];
const listeners = new Set<() => void>();
let seq = 0;

function emit(): void { for (const listener of listeners) listener(); }

/** Raise a toast and return its id, so a caller could dismiss it early. */
export function pushToast(kind: Toast['kind'], text: string): number {
  const id = ++seq;
  toasts = [...toasts, { id, kind, text }];
  emit();
  return id;
}

/** Dismiss one toast, whether its own timer fired or the user pressed its dismiss control. */
export function dismissToast(id: number): void {
  toasts = toasts.filter((t) => t.id !== id);
  emit();
}

/** Tests: toasts a test raised must not outlive it (the store is module-level). */
export function resetToasts(): void { toasts = []; seq = 0; emit(); }

export function subscribeToasts(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function currentToasts(): Toast[] { return toasts; }
