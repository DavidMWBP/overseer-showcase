import { useEffect, useState } from 'react';
import type { DiscussionDetail, DiscussionRow, DiscussionSummary, DiscussionTurnRow, HarnessName, Repo } from '@overseer/shared';
import { api, fmtCost } from '../api';
import { AttachmentPicker, useAttachments } from '../components/AttachmentPicker';
import { pushToast } from '../lib/toasts';

/** The participants a request that names none gets, in the order the form lists them (the daemon's own default). */
export const HARNESSES: HarnessName[] = ['claude', 'codex', 'opencode'];
/** How much of an answer is shown before it collapses: a discussion answer can run for pages. */
export const TURN_COLLAPSE_CHARS = 600;
export const DEFAULT_CAP = '5.00';
export const DISCUSSIONS_EMPTY = 'No discussions yet. Ask a question above to start one.';

/** One line for a discussion's lifecycle: `running`/`done`, or the stop the daemon recorded. */
export function statusLabel(d: Pick<DiscussionRow, 'status' | 'stop_reason'>): string {
  if (d.status === 'running' || d.status === 'done') return d.status;
  return d.stop_reason ? `${d.status}: ${d.stop_reason}` : d.status;
}

/** A whole answer, collapsed behind a Show more control once it is long enough to push the rest of the thread off screen. */
function TurnText({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  const long = text.length > TURN_COLLAPSE_CHARS;
  return (
    <>
      <p className="discussion-turn-text">{long && !expanded ? `${text.slice(0, TURN_COLLAPSE_CHARS)}…` : text}</p>
      {long && <button type="button" className="link" onClick={() => setExpanded((e) => !e)}>{expanded ? 'Show less' : 'Show more'}</button>}
    </>
  );
}

/** The question, its rules and Start; the list of discussions sits underneath. */
export function DiscussionList(p: { repos: Repo[] | null; version?: number; offline?: boolean; onOpen: (id: string) => void }) {
  const [question, setQuestion] = useState('');
  const [repoId, setRepoId] = useState('');
  const [participants, setParticipants] = useState<Record<HarnessName, boolean>>({ claude: true, codex: true, opencode: true });
  const [cap, setCap] = useState(DEFAULT_CAP);
  const [starting, setStarting] = useState(false);
  const attachmentState = useAttachments(starting);
  const [list, setList] = useState<DiscussionSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const chosen = HARNESSES.filter((h) => participants[h]);
  const capValue = Number(cap);
  const reason = !question.trim() ? 'Enter a question.'
    : chosen.length === 0 ? 'Choose at least one participant.'
      : !Number.isFinite(capValue) || capValue <= 0 ? 'The cost cap must be greater than 0.'
        : null;

  useEffect(() => {
    let live = true;
    setError(null);
    api.get<DiscussionSummary[]>('/discussions')
      .then((rows) => { if (live) setList([...rows].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))); })
      .catch((e: Error) => { if (live) setError(e.message); });
    return () => { live = false; };
  }, [p.version, p.offline]);

  const start = async () => {
    if (reason || starting) return;
    setStarting(true);
    try {
      const outgoing = await attachmentState.toBody();
      const created = await api.post<DiscussionDetail>('/discussions', {
        question: question.trim(), repo_id: repoId || null, participants: chosen, cost_cap: capValue,
        ...(outgoing.length ? { attachments: outgoing } : {}),
      });
      setQuestion('');
      attachmentState.clear();
      p.onOpen(created.id);
    } catch (e) {
      pushToast('failure', `Could not start the discussion: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setStarting(false);
    }
  };

  return (
    <div className="discussions-view">
      <h2>Discussions <span className="experimental-tag">Experimental</span></h2>
      <p className="experimental-note">Experimental: best for a wide list of ideas; for a single decision, one model plus a critic did as well for less.</p>
      <p className="muted">Put one question to several agent CLIs at once; each answers on its own, then reads the others.</p>
      <form className="discussion-form" onSubmit={(e) => { e.preventDefault(); void start(); }}>
        <label htmlFor="discussion-question">Question</label>
        <textarea id="discussion-question" value={question} onChange={(e) => setQuestion(e.target.value)} rows={3} placeholder="What should we decide?" {...attachmentState.dropProps} {...attachmentState.pasteProps} />
        <AttachmentPicker state={attachmentState} disabled={starting} showHint />
        <label htmlFor="discussion-repo">Repository</label>
        <select id="discussion-repo" value={repoId} onChange={(e) => setRepoId(e.target.value)}>
          <option value="">none</option>
          {(p.repos ?? []).map((r) => <option key={r.id} value={r.id}>{r.id}</option>)}
        </select>
        <fieldset className="discussion-participants">
          <legend>Participants</legend>
          {HARNESSES.map((h) => (
            <label key={h} className="checkbox">
              <input type="checkbox" checked={participants[h]} onChange={(e) => setParticipants((prev) => ({ ...prev, [h]: e.target.checked }))} />
              {h}
            </label>
          ))}
        </fieldset>
        <label htmlFor="discussion-cap">Cost cap ($)</label>
        <input id="discussion-cap" type="number" min="0" step="0.01" value={cap} onChange={(e) => setCap(e.target.value)} />
        <div className="discussion-actions">
          <button type="submit" disabled={reason !== null || starting}>{starting ? 'Starting…' : 'Start'}</button>
          {reason && <span className="muted" role="status">{reason}</span>}
        </div>
      </form>

      <h3>Your discussions</h3>
      {error && <p className="badge-warn" role={list === null ? 'alert' : 'status'}>{list === null ? `Could not load discussions: ${error}` : `Showing the last known discussions; they could not be refreshed (${error}).`}</p>}
      {list === null && !error && <p className="muted">loading…</p>}
      {list !== null && list.length === 0 && <p className="muted">{DISCUSSIONS_EMPTY}</p>}
      <ul className="discussion-list">
        {(list ?? []).map((d) => (
          <li key={d.id}>
            <button type="button" className="discussion-row" onClick={() => p.onOpen(d.id)}>
              <span className="discussion-row-question">{d.question}</span>
              <span className={`discussion-status discussion-status-${d.status}`}>{statusLabel(d)}</span>
              <span className="muted">{roundsLabel(d)}</span>
              <span className="mono">{fmtCost(d.cost)}</span>
              <span className="muted">{new Date(d.created_at).toLocaleString()}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The daemon's `MAX_ROUNDS`: a discussion runs three rounds at most. */
const MAX_ROUNDS = 3;

/** Rounds so far on a list row: the highest round with a turn, marked while that round still waits on a participant. */
export function roundsLabel(d: DiscussionSummary): string {
  if (d.rounds === 0) return 'no answers yet';
  return `round ${d.rounds} of ${MAX_ROUNDS}${d.round_in_progress ? ' (in progress)' : ''}`;
}

/** One round's turns, in the order the daemon recorded them. */
function Round({ round, turns }: { round: number; turns: DiscussionTurnRow[] }) {
  return (
    <section className="discussion-round">
      <h4>Round {round}</h4>
      {turns.map((t) => (
        <article key={t.id} className="discussion-turn">
          <header>
            <span className={`discussion-harness harness-${t.harness}`}>{t.harness}</span>
            <span className="mono discussion-turn-cost">{fmtCost(t.cost)}</span>
          </header>
          <TurnText text={t.text} />
        </article>
      ))}
    </section>
  );
}

/** One discussion: its question, status, cost against the cap, the thread by round, Stop while it runs and the synthesis. */
export function DiscussionThread(p: { id: string; version?: number; offline?: boolean; onBack: () => void }) {
  const [loaded, setLoaded] = useState<{ id: string; detail: DiscussionDetail } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stopping, setStopping] = useState(false);
  const [sending, setSending] = useState(false);

  useEffect(() => {
    let live = true;
    setError(null);
    api.get<DiscussionDetail>(`/discussions/${p.id}`)
      .then((d) => { if (live) setLoaded({ id: p.id, detail: d }); })
      .catch((e: Error) => { if (live) setError(e.message); });
    return () => { live = false; };
  }, [p.id, p.version, p.offline]);

  const stop = async () => {
    if (stopping) return;
    setStopping(true);
    try {
      setLoaded({ id: p.id, detail: await api.post<DiscussionDetail>(`/discussions/${p.id}/stop`) });
    } catch (e) {
      pushToast('failure', `Could not stop the discussion: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setStopping(false);
    }
  };

  const sendToChat = async () => {
    if (!detail?.synthesis || sending) return;
    setSending(true);
    try {
      await api.post('/chat', { text: `${detail.question}\n\n${detail.synthesis}` });
      pushToast('success', 'Discussion sent to chat.');
    } catch (e) {
      pushToast('failure', `Could not send the discussion to chat: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSending(false);
    }
  };

  const detail = loaded?.id === p.id ? loaded.detail : null;
  if (error && !detail) return (
    <div className="discussions-view">
      <button type="button" className="link" onClick={p.onBack}>Back</button>
      <p className="badge-warn" role="alert">Could not load the discussion: {error}</p>
    </div>
  );
  if (!detail) return <div className="discussions-view"><p className="muted">loading…</p></div>;

  const rounds = [...new Set(detail.turns.map((t) => t.round))].sort((a, b) => a - b);
  return (
    <div className="discussions-view">
      <button type="button" className="link" onClick={p.onBack}>Back</button>
      {error && <p className="badge-warn" role="status">Showing the last known discussion; it could not be refreshed ({error}).</p>}
      <h2>{detail.question}</h2>
      {detail.attachments?.length ? <div className="msg-attachments discussion-question-attachments">{detail.attachments.map((a, i) => {
        const src = `/api/discussions/${detail.id}/attachments/${i}`;
        return <a key={`${a.name}-${i}`} href={src} target="_blank" rel="noopener"><img src={src} alt={a.name} loading="lazy" /></a>;
      })}</div> : null}
      <p className="discussion-status" role="status">{statusLabel(detail)}</p>
      <div className="discussion-cost">
        <p>Total <span className="mono">{fmtCost(detail.cost)}</span> of <span className="mono">{fmtCost(detail.cost_cap)}</span> cap</p>
        <ul>
          {detail.participants.map((par) => (
            <li key={par.harness}>
              <span className={`discussion-harness harness-${par.harness}`}>{par.harness}</span>
              <span className="mono">{fmtCost(par.cost)}</span>
              {par.status === 'failed' && <span className="discussion-failed"> failed</span>}
            </li>
          ))}
        </ul>
      </div>
      {(detail.status === 'running' || stopping) && <button type="button" onClick={() => void stop()} disabled={stopping}>{stopping ? 'Stopping…' : 'Stop'}</button>}

      {rounds.map((round) => <Round key={round} round={round} turns={detail.turns.filter((t) => t.round === round)} />)}

      {detail.status === 'done' && (
        <section className="discussion-synthesis">
          <h3>Synthesis</h3>
          {detail.synthesis ? <p className="discussion-turn-text">{detail.synthesis}</p> : <p className="muted">No synthesis was written.</p>}
          <button type="button" onClick={() => void sendToChat()} disabled={!detail.synthesis || sending}>{sending ? 'Sending…' : 'Send to chat'}</button>
        </section>
      )}
    </div>
  );
}

/** The Discussions view: the list, or one thread when the hash names one (`#discussions/<id>`). */
export function Discussions(p: { id: string | null; repos: Repo[] | null; version?: number; offline?: boolean; onOpen: (id: string) => void; onBack: () => void }) {
  return p.id
    ? <DiscussionThread id={p.id} version={p.version} offline={p.offline} onBack={p.onBack} />
    : <DiscussionList repos={p.repos} version={p.version} offline={p.offline} onOpen={p.onOpen} />;
}
