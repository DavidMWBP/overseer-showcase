import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Chat } from '../src/views/Chat';
import { BatchPane } from '../src/views/BatchPane';
import { board, chat, repo } from '../src/test/fixtures';
import type { PendingAttachment } from '../src/components/AttachmentPicker';
import '../src/styles.css';

const params = new URLSearchParams(location.search);
const banner = params.get('banner');
const repos = params.get('repos') === '2' ? [repo, { ...repo, id: 'r2' }] : [repo];
const rows = Array.from({ length: Number(params.get('rows') ?? 60) }, (_, i) => ({ ...chat[0]!, id: i + 1, text: `Message ${i + 1}: ${'A long conversation needs its own scroll area. '.repeat(3)}`, seen_at: i === 0 || i === 58 ? chat[0]!.ts : null, replied_at: i === 0 ? chat[0]!.ts : null }));
// untracked=1 leaves every row without a status, so the one status=… sets is the only stamp; text=long|short sets the last two rows' text.
if (params.get('untracked') === '1') rows.forEach((r, i) => { rows[i] = { ...r, seen_at: null, replied_at: null }; });
const lastText = params.get('text') === 'long' ? `Long: ${'ab '.repeat(160)}` : params.get('text') === 'short' ? 'Short' : null;
if (lastText !== null) for (const i of [58, 59]) rows[i] = { ...rows[i]!, text: lastText };
if (params.get('status') === 'Seen') rows[59] = { ...rows[59]!, seen_at: chat[0]!.ts };
if (params.get('status') === 'Answered') rows[59] = { ...rows[59]!, seen_at: chat[0]!.ts, replied_at: chat[0]!.ts };
const outcomeBoard = { ...board, repos: [{ ...board.repos[0]!, batches: params.get('outcomes') === '0' ? [] : Array.from({ length: 3 }, (_, i) => ({ ...board.repos[0]!.batches[0]!, id: `r1-b${i + 1}`, origin_chat_id: 60, linked_chat_ids: [60], title: `A long request title for the outcome chip number ${i + 1}` })) }] };
const panelBoard = { ...board, repos: [{ ...board.repos[0]!, batches: [{ ...board.repos[0]!.batches[0]!, title: "Lessons from overseer overseer-b33-e4d5: a fallback that degrades the user's stated flow is a decision for the user, not a review finding to implement", origin_chat_id: 60, linked_chat_ids: [60], status: 'open' as const, beads_total: 2, beads_done: 0, beads_closed: 0 }], cards: board.repos[0]!.cards.map((card) => card.bead.id === 'ov-3' ? { ...card, bead: { ...card.bead, title: 'X'.repeat(60) } } : card) }] };
const displayBoard = params.get('panel') === '1' ? panelBoard : outcomeBoard;
const commandSuggestions = Array.from({ length: 12 }, (_, i) => ({
  name: `command-${String(i + 1).padStart(2, '0')}`,
  description: i === 0
    ? 'The longest command description explains how this workflow checks repository conventions, traces the changed behavior, and reports the evidence reviewers need. It names the tradeoffs and edge cases so the command can be chosen without opening its full instructions. The result stays inside two lines at every width and ends with an ellipsis when more text remains.'
    : `Run command ${i + 1} for this repository.`,
  kind: 'command' as const,
  source: i === 11 ? 'global' as const : 'repo' as const,
}));
if (params.get('jump') === '1') rows.push({ ...chat[1]!, id: 61, text: 'New message while away' });
if (params.get('questions') === '3') rows.push(...Array.from({ length: 3 }, (_, i) => ({ ...chat[2]!, id: 101 + i, text: `Open question ${i + 1}?` })));
// question=long is a question the size of the one that filled an iPhone screen (about 1,600 characters with "- " lines);
// question=short is one line. questions=N with either adds N - 1 more of the same kind, numbered, so the pager shows.
const LONG_QUESTION = [
  'Before I split this up I need your call on how the question card should behave on phones, because two of the options change what the orchestrator sends and one only changes the layout:',
  '- Option A: always split multi-part questions into separate ask_user calls, so each card holds one decision and the pager walks through them one at a time, oldest first.',
  '- Option B: keep one question per decision but cap the pinned card at a share of the visible height, and let the question text scroll inside it while the answer box and buttons stay put.',
  '- Option C: do both, which means the prompt changes and the layout change land in the same batch and have to be verified together on the phone with the keyboard open.',
  '- Option D: collapse the question text to its first two lines behind a Show more control, which keeps the card small but hides the part of the question that usually carries the choice.',
  '- Option E: move open questions out of Chat into their own sheet that opens from the Needs strip, which frees the composer but adds a second place to look and a second way to answer the same question.',
  '- Option F: leave the card as it is and only keep the line breaks, which fixes the run-together list but still lets a long question cover the answer box.',
  'I lean towards C, since splitting alone still leaves one long decision able to cover the screen, and the cap alone still lets several decisions run together into one card. If you pick B or C I will also keep the line breaks, so the options above render on their own lines instead of one paragraph.',
  'Which should I do, and should the cap be 40% of the visible height or something else?',
].join('\n');
const question = params.get('question');
if (question) rows.push({ ...chat[2]!, id: 201, text: question === 'long' ? LONG_QUESTION : 'Short question?' });
for (let n = 2; question && n <= Number(params.get('questions') ?? 1); n++) rows.push({ ...chat[2]!, id: 200 + n, text: question === 'long' ? `Question ${n}: ${LONG_QUESTION}` : `Question ${n}?` });
// The fetch answers from the live array, so rows pushed by __arrive reach the next load or refresh.
globalThis.fetch = async (input) => new Response(JSON.stringify(String(input).endsWith('/commands') ? commandSuggestions : { rows, has_more: false, oldest_id: 1 }), { status: 200, headers: { 'Content-Type': 'application/json' } });

function Fixture() {
  const readThrough = React.useRef<number | null>(null);
  const [target, setTarget] = useState('r1');
  const [text, setText] = useState('');
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [hint, setHint] = useState<string | null>(null);
  const [panelBatch, setPanelBatch] = useState<string | null>(null);
  // Round-trip probes: Board unmounts Chat as the shell does, and __arrive appends assistant rows and bumps the chat version.
  const [view, setView] = useState<'chat' | 'board'>('chat');
  const [version, setVersion] = useState(0);
  Object.assign(window, { __readThrough: readThrough, __arrive: (n: number) => {
    const first = rows.at(-1)!.id + 1;
    rows.push(...Array.from({ length: n }, (_, i) => ({ ...chat[1]!, id: first + i, text: `Arrival ${first + i}` })));
    setVersion((v) => v + 1);
  } });
  return <div className="app"><aside className="rail"><div className="rail-context"><div className="rail-status">Chat</div></div><div className="rail-views"><button className={view === 'chat' ? 'active' : ''} onClick={() => setView('chat')}>Chat</button><button className={view === 'board' ? 'active' : ''} onClick={() => setView('board')}>Board</button></div></aside>
    <main>
      {banner && <div className="banner-warn" role="alert">{banner === 'offline' ? 'Daemon unreachable, retrying… What you see is the last known state; it refreshes when the daemon is back.' : 'Could not load /api/repos: request failed'}</div>}
      {view === 'chat' && <Chat version={version} repos={repos} repo={target} onRepo={setTarget} board={displayBoard} onOpenBatch={(batch) => setPanelBatch(batch.id)} readThrough={readThrough} text={text} draftRev={0} onText={setText} onClearText={() => setText('')}
        attachments={{ attachments, setAttachments, hint, setHint }} />}
      {panelBatch && view === 'chat' && <BatchPane id={panelBatch} board={displayBoard} onClose={() => setPanelBatch(null)} onSelect={() => {}} onOpenReview={() => {}} />}
    </main>
  </div>;
}

createRoot(document.getElementById('root')!).render(<Fixture />);
