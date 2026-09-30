import { Diff } from '@overseer/web';

// The card page is white; Overseer is dark-only, so every story sits on the app background.
const dark = (children: React.ReactNode) => <div style={{ background: "var(--bg)", color: "var(--text)", padding: 16, borderRadius: 6 }}>{children}</div>;

const diff = `diff --git a/packages/web/src/components/Toasts.tsx b/packages/web/src/components/Toasts.tsx
index 3b1c2e0..9a4f7d1 100644
--- a/packages/web/src/components/Toasts.tsx
+++ b/packages/web/src/components/Toasts.tsx
@@ -4,7 +4,7 @@ import { currentToasts, dismissToast, subscribeToasts, type Toast } from '../lib/toasts';
 /** How long a success toast stays before it dismisses itself; a failure waits for the user. */
-export const TOAST_MS = 4000;
+export const TOAST_MS = 5000;

 function ToastItem({ toast }: { toast: Toast }) {
diff --git a/packages/web/src/styles.css b/packages/web/src/styles.css
index 71e0a52..c28d9b4 100644
--- a/packages/web/src/styles.css
+++ b/packages/web/src/styles.css
@@ -742,3 +742,5 @@
 .toast-text { overflow-wrap: anywhere; }
+.toast-dismiss { min-width: 44px; min-height: 44px; }
+.toast-failure { border-color: var(--warn); }
`;

export const TwoFiles = () => dark(<Diff diff={diff} />);

export const NoChanges = () => dark(<Diff diff={null} />);
