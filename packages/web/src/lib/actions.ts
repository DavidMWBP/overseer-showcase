import type { ActionResult } from '@overseer/shared';

/** The action's own name, as the task and its button read it. */
const ACTION_NAME: Record<string, string> = {
  merge: 'Merge',
  reject: 'Reject',
  abandon: 'Abandon',
  interrupt: 'Stop worker',
  verify: 'Retry verification',
  close: 'Close bead',
  'close-landed': 'Retry close',
  redispatch: 'Re-dispatch',
  'accept-review': 'Land anyway',
};
export const actionName = (action: string): string => ACTION_NAME[action] ?? action;

/** What a target's action button reads while the daemon runs it. */
const PENDING: Record<string, string> = {
  merge: 'Merging…',
  reject: 'Rejecting…',
  abandon: 'Abandoning…',
  interrupt: 'Stopping…',
  verify: 'Retrying…',
  close: 'Closing…',
  'close-landed': 'Closing…',
  redispatch: 'Re-dispatching…',
  'accept-review': 'Landing…',
};
export const pendingLabel = (action: string): string => PENDING[action] ?? 'Working…';

/** The lower-case verb a refusal reads with: "Could not <verb>: <message>". */
const VERB: Record<string, string> = {
  merge: 'merge',
  reject: 'reject',
  abandon: 'abandon',
  interrupt: 'stop the worker',
  verify: 'retry the verification',
  close: 'close the bead',
  'close-landed': 'close the bead',
  redispatch: 're-dispatch',
  'accept-review': 'land it anyway',
};
export const actionVerb = (action: string): string => VERB[action] ?? `run ${action}`;

/** What a finished action says: the outcome the daemon reported. */
const DONE: Record<string, (target: string) => string> = {
  merge: (t) => `${t} merged.`,
  reject: (t) => `${t} rejected.`,
  abandon: (t) => `${t} abandoned.`,
  interrupt: (t) => `Stop requested for ${t}.`,
  verify: (t) => `Verification of ${t} passed.`,
  close: (t) => `${t} closed.`,
  'close-landed': (t) => `${t} closed.`,
  redispatch: (t) => `${t} re-dispatched.`,
  'accept-review': (t) => `${t} landed with its open findings.`,
};

/** The success or failure text for one `action_result`. */
export function actionToast(r: ActionResult): { kind: 'success' | 'failure'; text: string } {
  if (r.ok) return { kind: 'success', text: (DONE[r.action] ?? ((t: string) => `${t}: ${actionName(r.action)} finished.`))(r.target) };
  return { kind: 'failure', text: `${actionName(r.action)} failed: ${r.message ?? 'the daemon did not say why'}` };
}

/** The text for a refusal the request itself answered, before any job ran. */
export const refusalToast = (action: string, message: string): string => `Could not ${actionVerb(action)}: ${message}`;
