import React from 'react';
import { createRoot } from 'react-dom/client';
import type { Program, ProgramBatchSummary, ProgramDetail } from '@overseer/shared';
import '../src/styles.css';
import { Programs } from '../src/views/Programs';

// Worst case for width: unbroken tokens in the program title, a batch title, a lane name, a prerequisite badge and a decision.
const long = 'Rename-the-account-settings-endpoint-and-keep-the-old-one-answering-until-every-client-has-moved';
const batch = (id: string, lane: string, position: number, over: Partial<ProgramBatchSummary> = {}): ProgramBatchSummary => ({ program_id: 'pg1', batch_id: id, lane, position, title: `${id} ${long}`, status: 'open', beads_total: 12, beads_done: 3, beads_closed: 1, ...over });
const program: Program = { id: 'pg1', repo_id: 'overseer', title: `Accounts ${long}`, status: 'open', created_at: '2026-09-28T08:00:00.000Z', origin_chat_id: null };
const detail: ProgramDetail = {
  ...program,
  batches: [batch('b1', 'api', 0, { status: 'merged' }), batch('b2', 'api', 1, { status: 'review' }), batch('b3', `web-${long}`, 0), batch('b4', 'docs', 0)],
  waits: [{ batch_id: 'b3', prerequisite_batch_id: 'b2', released: false }, { batch_id: 'b4', prerequisite_batch_id: 'b1', released: true }],
  entries: [
    { program_id: 'pg1', kind: 'decision', text: `Keep it: ${long.repeat(4)}\nand a second line`, created_at: '2026-09-28T08:00:00.000Z', source_chat_id: 1 },
    { program_id: 'pg1', kind: 'ownership', text: 'web lane owns packages/web/src/views', created_at: '2026-09-28T09:00:00.000Z', source_chat_id: null },
  ],
  merge_order: ['b1', 'b2', 'b3', 'b4'],
};
window.fetch = async (input) => new Response(JSON.stringify(String(input).endsWith('/api/programs') ? [program] : detail), { status: 200 });

createRoot(document.getElementById('root')!).render(<Programs version={0} onOpenBatch={() => {}} />);
