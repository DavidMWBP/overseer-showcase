import { Card } from '@overseer/web';

const base = {
  repo_id: 'overseer', batch_id: 'b-7k2m', branch: 'overseer/b-7k2m', cost: 0.42, elapsed_ms: 312_000,
  session_status: 'running', session_id: 's-19', verify_failure: null, verify_block: 'none', tier: 'standard',
  model: 'gpt-5.6-terra', account_name: null, account_label: null, findings: null, accepted_note: null, pending_action: null,
} as const;
const bead = (id: string, title: string, labels: string[] = []) => ({
  id, title, description: '', status: 'in_progress' as const, priority: 2, labels, notes: '', assignee: null, closed_at: null, dependency_count: 0,
});
const noop = () => {};
const col = (children: React.ReactNode) => <div className="column" style={{ width: 240 }}>{children}</div>;

export const Running = () => col(
  <Card selected={false} onClick={noop} card={{ ...base, bead: bead('overseer-4fq', 'Add day separators to the chat thread'), column: 'running', state: 'running', harness: 'codex' }} />,
);

export const Selected = () => col(
  <Card selected onClick={noop} card={{ ...base, bead: bead('overseer-9ht', 'Show the batch pill as a side panel in place'), column: 'verifying', state: 'verifying', harness: 'claude', model: 'sonnet', elapsed_ms: 48_000 }} />,
);

export const VerifyFailed = () => col(
  <Card selected={false} onClick={noop} card={{ ...base, bead: bead('overseer-2xp', 'Cap vitest workers at four forks'), column: 'ready', state: 'idle', harness: 'codex', session_status: 'ended', verify_failure: 'FAIL src/vitest-config.test.ts > every test file is reached once', verify_block: 'output', elapsed_ms: 540_000 }} />,
);

export const NeedsDecision = () => col(
  <Card selected={false} onClick={noop} card={{ ...base, bead: bead('overseer-7cw', 'Refresh the OAuth token before a session starts'), column: 'review', state: 'awaiting_decision', harness: 'claude', model: 'fable', session_status: 'ended', findings: [{ file: 'src/accounts.ts', summary: 'Expiry check ignores the two-hour window', severity: 'must' }] }} />,
);

export const ReRunning = () => col(
  <Card selected={false} onClick={noop} card={{ ...base, bead: bead('overseer-3mz', 'Keep the reading position across a view change'), column: 'ready', state: 'idle', harness: 'opencode', model: 'deepseek-v4-pro', session_status: 'ended', elapsed_ms: 95_000, pending_action: { job_id: 'j-8', action: 'redispatch', started_at: new Date().toISOString() } }} />,
);

export const Done = () => col(
  <Card selected={false} onClick={noop} card={{ ...base, bead: { ...bead('overseer-1bd', 'Record the stall mark on the session row'), status: 'closed' }, column: 'done', state: 'done', harness: null, model: null, session_status: 'ended', elapsed_ms: null }} />,
);
