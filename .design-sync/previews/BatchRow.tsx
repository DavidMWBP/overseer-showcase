import { BatchRow } from '@overseer/web';

const base = {
  repo_id: 'overseer', base_branch: 'main', note: null, history: null, mr_url: null, conflict_files: null,
  created_at: '2026-09-24T08:10:00Z', updated_at: '2026-09-24T09:40:00Z', merged_at: null, merged_commit: null, setup_at: '2026-09-24T08:11:00Z',
  waiting_on: null, overlap_files: null, linked_chat_ids: [412], beads_closed: 0, cost_unknown: 0, pending_action: null,
} as const;
const noop = () => {};
const list = (children: React.ReactNode) => <div className="batches">{children}</div>;

export const InProgress = () => list(
  <BatchRow onClick={noop} batch={{ ...base, id: 'b-7k2m', title: 'Chat outcome chips open a batch panel in place', branch: 'overseer/batch-pills-open-a-side-panel-in-place', status: 'open', beads_total: 4, beads_done: 2, cost: 1.87 }} />,
);

export const InReview = () => list(
  <BatchRow onClick={noop} batch={{ ...base, id: 'b-q4sd', title: 'Usage view: cost per day by model', branch: 'overseer/usage-view', status: 'review', beads_total: 3, beads_done: 3, cost: 2.64, cost_unknown: 1, note: 'All three beads landed and verified.' }} />,
);

export const WaitingOnOverlap = () => list(
  <BatchRow onClick={noop} batch={{ ...base, id: 'b-m2ve', title: 'Toast stack for background action results', branch: 'overseer/toasts', status: 'review', beads_total: 2, beads_done: 1, beads_closed: 1, cost: 0.93, waiting_on: 'b-q4sd', overlap_files: ['packages/web/src/styles.css'] }} />,
);

export const Merging = () => list(
  <BatchRow onClick={noop} batch={{ ...base, id: 'b-z8nn', title: 'Daemon restart keeps adopted workers', branch: 'overseer/restart-adopt', status: 'review', beads_total: 5, beads_done: 5, cost: 6.12, pending_action: { job_id: 'j-2', action: 'merge', started_at: new Date().toISOString() } }} />,
);

export const Merged = () => list(
  <BatchRow onClick={noop} batch={{ ...base, id: 'b-a1ke', title: 'Preflight the verify command on the base branch', branch: 'overseer/preflight', status: 'merged', beads_total: 3, beads_done: 3, cost: 3.05, merged_at: '2026-09-16T14:02:00Z', merged_commit: '8ef9395' }} />,
);
