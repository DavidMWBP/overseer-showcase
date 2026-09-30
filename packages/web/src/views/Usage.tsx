import { useEffect, useMemo, useState } from 'react';
import type { UsageBreakdownRow, UsageGroup, UsageResponse, UsageTotals } from '@overseer/shared';
import { api } from '../api';
import { UsageChart } from '../components/UsageChart';
import {
  RANGE_DAYS, RESTART_GAP_LIMIT, CODEX_EST_TITLE, estTitle, fmtTokens, rangeFor, sortRows, stackDays, tokenTotal, usageCost,
  type CostBasis, type Measure, type RangeDays, type SortKey,
} from '../lib/usage';

/** The `est.` marker: every estimated figure carries it, and its tooltip says what the estimate is and, on a codex bucket, how it can read low. */
function Est({ totals }: { totals: UsageTotals }) {
  return <abbr className="usage-est" title={estTitle(totals)}>est.</abbr>;
}

function Card({ label, value, title, note }: { label: string; value: string; title?: string; note?: React.ReactNode }) {
  return (
    <div className="usage-card">
      <div className="usage-card-label">{label}{note ? <> {note}</> : null}</div>
      <div className="usage-card-value" title={title}>{value}</div>
    </div>
  );
}

const COLUMNS: { key: SortKey; label: string }[] = [
  { key: 'key', label: 'name' },
  { key: 'reported', label: 'cost' },
  { key: 'estimated', label: 'estimate' },
  { key: 'tokens', label: 'tokens' },
  { key: 'sessions', label: 'sessions' },
];

/** One breakdown. On a phone the stylesheet turns these rows into a list; the cells name themselves through `data-label`. */
function Breakdown({ title, rows, empty }: { title: string; rows: UsageBreakdownRow[]; empty: string }) {
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: 'reported', desc: true });
  const sorted = useMemo(() => sortRows(rows, sort.key, sort.desc), [rows, sort]);
  const pick = (key: SortKey) => setSort((s) => (s.key === key ? { key, desc: !s.desc } : { key, desc: key !== 'key' }));
  return (
    <section className="usage-breakdown">
      <h3>{title}</h3>
      {rows.length === 0 ? <p className="muted">{empty}</p> : (
        <table className="usage-table">
          <thead>
            <tr>
              {COLUMNS.map((c) => (
                <th key={c.key} aria-sort={sort.key === c.key ? (sort.desc ? 'descending' : 'ascending') : 'none'}>
                  <button type="button" className="link" onClick={() => pick(c.key)}>{c.label}{sort.key === c.key ? (sort.desc ? ' ↓' : ' ↑') : ''}</button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sorted.map((r) => {
              const reported = usageCost(r, 'reported');
              const estimated = usageCost(r, 'estimated');
              return (
                <tr key={r.key ?? '—'}>
                  <td className="breakable" data-label="name" title={r.key ?? undefined}>{r.label ?? r.key ?? 'none'}</td>
                  <td className="mono" data-label="cost" title={reported.title}>{reported.text}</td>
                  {/* Never a bare dollar figure: the estimate always travels with its marker, and a codex row's marker carries the base-tier caveat. */}
                  <td className="mono" data-label="estimate" title={estimated.title}>{estimated.text} <Est totals={r} /></td>
                  <td className="mono" data-label="tokens" title={`${tokenTotal(r).toLocaleString()} tokens`}>{fmtTokens(tokenTotal(r))}</td>
                  <td className="mono" data-label="sessions">{r.sessions}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
}

const BREAKDOWNS: { group: UsageGroup; title: string }[] = [
  { group: 'model', title: 'By model' },
  { group: 'account', title: 'By account' },
  { group: 'harness', title: 'By harness' },
  { group: 'repo', title: 'By repository' },
];

/**
 * What the sessions in a range cost and consumed. Reported and estimated dollars are two separate sums here exactly as the daemon
 * keeps them: they are never added together, and a bucket that reported nothing reads "unknown" rather than $0.00.
 */
export function Usage({ offline }: { offline?: boolean }) {
  const [days, setDays] = useState<RangeDays>(30);
  const [basis, setBasis] = useState<CostBasis>('reported');
  const [metric, setMetric] = useState<'cost' | 'tokens'>('cost');
  const [data, setData] = useState<UsageResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    const range = rangeFor(days);
    setError(null);
    api.get<UsageResponse>(`/usage?from=${range.from}&to=${range.to}&group=model,account,harness,repo`)
      .then((r) => { if (live) setData(r); })
      .catch((e: Error) => { if (live) setError(e.message); });
    return () => { live = false; };
  }, [days, offline]);

  const measure: Measure = metric === 'tokens' ? 'tokens' : basis;
  const stacks = useMemo(
    () => (data ? stackDays(data.days_by_model, { from: data.from, to: data.to }, measure) : null),
    [data, measure],
  );
  const totals = data?.totals;

  return (
    <div className="usage-view">
      <h2>Usage</h2>
      <div className="usage-controls" role="group" aria-label="Range">
        {RANGE_DAYS.map((d) => (
          <button key={d} type="button" className={d === days ? 'active' : ''} aria-pressed={d === days} onClick={() => setDays(d)}>{d} days</button>
        ))}
      </div>
      {error && <p className="badge-warn" role="alert">Could not load usage: {error}</p>}
      {!data || !totals || !stacks ? <p className="muted">{error ? '' : 'loading…'}</p> : (
        <>
          <p className="muted usage-range">{data.from} to {data.to}, UTC days.</p>
          <div className="usage-cards">
            <Card label="Reported cost" value={usageCost(totals, 'reported').text} title={usageCost(totals, 'reported').title} />
            <Card label="Estimated cost" note={<Est totals={totals} />} value={usageCost(totals, 'estimated').text} title={usageCost(totals, 'estimated').title} />
            <Card label="Tokens" value={fmtTokens(tokenTotal(totals))} title={`${tokenTotal(totals).toLocaleString()} tokens`} />
            <Card label="Sessions" value={String(totals.sessions)} />
          </div>
          <ul className="usage-limits">
            <li>{RESTART_GAP_LIMIT}</li>
            {totals.codex_sessions > 0 && <li title={CODEX_EST_TITLE}>Codex estimates are priced at the catalog’s base context tier, so a codex session whose requests crossed ~272k tokens is estimated up to 2x low.</li>}
          </ul>
          <section className="usage-chart-card">
            <div className="usage-chart-head">
              <h3>{metric === 'tokens' ? 'Tokens per day' : basis === 'reported' ? 'Reported cost per day' : 'Estimated cost per day'}</h3>
              <div className="usage-controls" role="group" aria-label="Measure">
                <button type="button" className={metric === 'cost' && basis === 'reported' ? 'active' : ''} aria-pressed={metric === 'cost' && basis === 'reported'} onClick={() => { setMetric('cost'); setBasis('reported'); }}>Reported</button>
                <button type="button" className={metric === 'cost' && basis === 'estimated' ? 'active' : ''} aria-pressed={metric === 'cost' && basis === 'estimated'} onClick={() => { setMetric('cost'); setBasis('estimated'); }}>Estimated</button>
                <button type="button" className={metric === 'tokens' ? 'active' : ''} aria-pressed={metric === 'tokens'} onClick={() => setMetric('tokens')}>Tokens</button>
              </div>
            </div>
            {metric === 'cost' && basis === 'estimated' && <p className="muted">Every figure in this chart is an estimate <Est totals={totals} />, not a bill.</p>}
            <UsageChart stacks={stacks} measure={measure} label={`${metric === 'tokens' ? 'Tokens' : basis === 'reported' ? 'Reported cost' : 'Estimated cost'} per day, stacked by model, ${data.from} to ${data.to}`} />
          </section>
          {BREAKDOWNS.map((b) => (
            <Breakdown key={b.group} title={b.title} rows={data.groups[b.group] ?? []} empty="No sessions in this range." />
          ))}
        </>
      )}
    </div>
  );
}
