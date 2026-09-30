import { useEffect, useState } from 'react';
import type { Program, ProgramBatchSummary, ProgramDetail } from '@overseer/shared';
import { api } from '../api';
import { Loading } from '../components/Loading';

const beadsText = (b: ProgramBatchSummary) => (b.beads_closed ? `${b.beads_done} landed, ${b.beads_closed} closed of ${b.beads_total} beads` : `${b.beads_done}/${b.beads_total} beads done`);

/** Every batch merged reads as done even before the program row itself is marked done. */
export const programDone = (p: ProgramDetail) => p.status === 'done' || (p.batches.length > 0 && p.batches.every((b) => b.status === 'merged'));

function ProgramView({ program, onOpenBatch }: { program: ProgramDetail; onOpenBatch: (batchId: string) => void }) {
  const titleOf = (id: string) => program.batches.find((b) => b.batch_id === id)?.title ?? id;
  const lanes = new Map<string, ProgramBatchSummary[]>();
  for (const b of program.batches) lanes.set(b.lane, [...(lanes.get(b.lane) ?? []), b]);
  const done = programDone(program);
  const entries = [...program.entries].reverse();
  return (
    <section className="program" aria-label={program.title}>
      <h3 className="program-title">{program.title} {done ? <span className="chip merged">done</span> : <span className="chip open">open</span>}</h3>
      <div className="program-lanes">
        {[...lanes].map(([lane, batches]) => (
          <section key={lane} className="program-lane" aria-label={`Lane ${lane}`}>
            <h4>{lane}</h4>
            {batches.map((b) => {
              const waits = program.waits.filter((w) => w.batch_id === b.batch_id && !w.released);
              return (
                <button key={b.batch_id} type="button" className="program-batch" onClick={() => onOpenBatch(b.batch_id)}>
                  <span className="program-batch-title">{b.title ?? b.batch_id}</span>
                  <span className="program-batch-meta">
                    <span className={`chip ${b.status ?? ''}`}>{b.status ?? 'unknown'}</span>
                    <span className="muted">{beadsText(b)}</span>
                    {waits.map((w) => <span key={w.prerequisite_batch_id} className="chip awaiting">waits for {titleOf(w.prerequisite_batch_id)}</span>)}
                  </span>
                </button>
              );
            })}
          </section>
        ))}
      </div>
      <h4>Merge order</h4>
      {program.merge_order.length === 0
        ? <p className="muted">No merge order yet.</p>
        : (
          <ol className="program-merge-order">
            {program.merge_order.map((id) => {
              const merged = program.batches.find((b) => b.batch_id === id)?.status === 'merged';
              return <li key={id}>{merged ? <s>{titleOf(id)}</s> : titleOf(id)}</li>;
            })}
          </ol>
        )}
      <h4>Log</h4>
      {entries.length === 0
        ? <p className="muted">No entries yet.</p>
        : (
          <ul className="program-entries">
            {entries.map((e, i) => (
              <li key={`${e.created_at}-${i}`}>
                <span className="muted"><time dateTime={e.created_at}>{new Date(e.created_at).toLocaleString()}</time> · {e.kind}</span>
                <p className="program-entry-text">{e.text}</p>
              </li>
            ))}
          </ul>
        )}
    </section>
  );
}

/**
 * The open programs, each with its lanes, merge order and log. Refetched when `version` moves (App bumps it on the `board` and
 * `chat` socket messages), never on a timer.
 */
export function Programs({ version, onOpenBatch }: { version: number; onOpenBatch: (batchId: string) => void }) {
  const [programs, setPrograms] = useState<ProgramDetail[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    const fresh = version > 0;
    api.get<Program[]>('/programs', { fresh })
      .then((all) => Promise.all(all.filter((p) => p.status === 'open').map((p) => api.get<ProgramDetail>(`/programs/${encodeURIComponent(p.id)}`, { fresh }))))
      .then((details) => { if (live) { setPrograms(details); setError(null); } })
      .catch((e: unknown) => { if (live) setError(e instanceof Error ? e.message : String(e)); });
    return () => { live = false; };
  }, [version]);
  return (
    <div className="programs">
      <h2>Programs</h2>
      {error && <p className="badge-warn" role="alert">Could not load the programs: {error}</p>}
      <Loading loading={programs === null && !error} label="Loading the programs…" placeholder={<p className="muted">No open programs. A request with several stories starts one.</p>}>
        {programs !== null && (programs.length === 0
          ? <p className="muted">No open programs. A request with several stories starts one.</p>
          : programs.map((p) => <ProgramView key={p.id} program={p} onOpenBatch={onOpenBatch} />))}
      </Loading>
    </div>
  );
}
