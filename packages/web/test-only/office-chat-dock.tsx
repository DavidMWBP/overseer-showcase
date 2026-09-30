import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { ChatRow, MergeMode, OfficeSession, WsMessage } from '@overseer/shared';
import { Chat } from '../src/views/Chat';
import { BatchPane } from '../src/views/BatchPane';
import { BOARD_COLUMNS } from '../src/views/Board';
import { Office } from '../src/office/Office';
import { NeedsStrip } from '../src/office/NeedsStrip';
import type { NeedsYouItem } from '../src/lib/needsYou';
import type { PendingAttachment } from '../src/components/AttachmentPicker';
import { batchDetail, board, chat, repo, reviewDetail } from '../src/test/fixtures';
import '../src/styles.css';

const params = new URLSearchParams(location.search);
const longest = params.get('longest') === '1';
const itemCount = Number(params.get('items') ?? '0');
const largeCounts = params.get('large') === '1';
const propCount = largeCounts ? 618 : itemCount;
/** The whiteboard draws one note per task id, so each column holds `propCount` ids. */
const roomColumns = BOARD_COLUMNS.map((column) => ({ ...column, ids: Array.from({ length: propCount }, (_, k) => `${column.key}-${k}`) }));
/** The meeting table draws one folder per batch key in review. */
const reviewKeys = Array.from({ length: propCount }, (_, k) => `r1/r1-b${k}`);
const mergeMode: MergeMode = params.get('mergeMode') === 'gitlab-mr' ? 'gitlab-mr' : 'local-merge';
const paneRepo = { ...repo, merge_mode: mergeMode };
const repos = params.get('repos') === '2' ? [paneRepo, { ...repo, id: 'r2', path: 'E:/Projects/second-demo' }] : [paneRepo];
const longNeedsTitle = 'Lessons from overseer overseer-b33-e4d5: a fallback that degrades the user\'s stated flow is a decision for the user, not a review finding to implement';
const paneBatch = { ...board.repos[0]!.batches[0]!, id: 'r1-b33', title: longNeedsTitle, status: 'review' as const, note: 'Summary for the responsive Needs drawer.', history: 'Earlier review round.', mr_url: mergeMode === 'gitlab-mr' ? 'https://gitlab.example/r1/merge_requests/33' : null };
const paneBoard = { ...board, repos: [{ ...board.repos[0]!, repo: paneRepo, batches: [paneBatch] }] };
const paneDetail = { ...batchDetail, batch: { ...batchDetail.batch, ...paneBatch }, repo: paneRepo, diff: mergeMode === 'gitlab-mr' ? null : batchDetail.diff };
const needsItems: NeedsYouItem[] = itemCount === 5 ? [
  { kind: 'question', id: String(chat[2]!.id), repoId: null, label: chat[2]!.text, detail: 'chat' },
  // The long batch title stays inside the phone cap of 3 rows, so its clipping is measured at every width.
  { kind: 'batch', id: 'r1-b33', repoId: 'r1', label: longNeedsTitle, detail: 'in review' },
  { kind: 'decision', id: 'ov-14', repoId: 'r1', label: 'Add greeting', detail: 'ov-14 awaiting your decision' },
  { kind: 'repo', id: 'r1', repoId: 'r1', label: 'Verify command fails on main', detail: 'pnpm test' },
  { kind: 'failed', id: 'ov-6', repoId: 'r1', label: 'Failed task', detail: 'ov-6 verification failed' },
] : [];
const longText = Array.from({ length: 8 }, (_, i) => `Longest composer line ${i + 1}: ${'The dock keeps the full Chat composer within its measured column. '.repeat(5)}`).join('\n');
const rows: ChatRow[] = longest
  ? [...chat, { ...chat[0]!, id: Math.max(...chat.map((row) => row.id)) + 1, role: 'user', kind: 'message', ts: '2026-09-24T10:00:00.000Z', text: 'Longest thread message: ' + 'A long message wraps inside the thread and stays in its scroll region. '.repeat(90) }]
  : chat;
const onePixelPng = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/nSgAAAAASUVORK5CYII=';
const initialAttachments: PendingAttachment[] = params.get('attachments') === '4'
  ? Array.from({ length: 4 }, (_, index) => ({ file: new File(['fixture'], `attachment-${index + 1}.png`, { type: 'image/png' }), url: onePixelPng }))
  : [];
const session: OfficeSession = {
  session_id: 'office-chat-dock-fixture', role: 'worker', harness: 'claude', model: 'sonnet', resolved_model: null, account_label: null,
  bead_id: 'ov-3', bead_title: 'Running task', batch_id: null, repo_id: 'r1', state: 'working', stalled_since: null,
};
type OfficeMilestone = Extract<WsMessage, { type: 'office_milestone' }>;
// orch=idle seats the orchestrator without the typing pose (the feed's `walking_in`, as between turns).
const orchestrator: OfficeSession = { ...session, session_id: 'office-chat-dock-orchestrator', role: 'orchestrator', bead_id: null, bead_title: null, state: params.get('orch') === 'idle' ? 'walking_in' : 'working' };
/** workers=N (0 to 12, default 1): the first is `session`, the rest fill the next pod desks. */
const workerCount = Number(params.get('workers') ?? '1');
const workers = Array.from({ length: workerCount }, (_, k) => k === 0 ? session : { ...session, session_id: `office-chat-dock-worker-${k + 1}`, bead_id: `ov-${k + 3}` });
/** critic=1 adds a review session, which takes the first meeting-table seat. */
const critics = params.get('critic') === '1' ? [{ ...session, session_id: 'office-chat-dock-critic', role: 'critic' as const, bead_id: 'ov-2' }] : [];
const officeSessions = params.get('single') === '1' ? [session] : [...workers, ...critics, orchestrator];
const taskDetail = { ...reviewDetail, bead: { ...reviewDetail.bead, id: 'ov-3', title: 'Running task' } };
const fixturePosts: unknown[] = [];
(window as Window & { __officeChatDockPosts?: unknown[] }).__officeChatDockPosts = fixturePosts;
/** Each room object opened, in order, so a browser check can tell a click and a key press reached it. */
const roomOpened: string[] = [];
(window as Window & { __officeRoomOpened?: string[] }).__officeRoomOpened = roomOpened;

// Static files (the character atlas Pixi's `Assets.load` fetches) go to the real server; only `/api` is faked.
const serverFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = new URL(String(input), location.href);
  if (!url.pathname.startsWith('/api/')) return serverFetch(input, init);
  const method = init?.method ?? 'GET';
  if (url.pathname === '/api/chat' && method === 'GET') {
    return new Response(JSON.stringify({ rows, has_more: false, oldest_id: rows[0]?.id ?? null }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  if (url.pathname === '/api/chat' && method === 'POST') {
    fixturePosts.push(JSON.parse(String(init?.body ?? '{}')));
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  }
  if (url.pathname === '/api/tasks/ov-3') {
    return new Response(JSON.stringify(taskDetail), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  if (url.pathname === '/api/batches/r1-b33') {
    return new Response(JSON.stringify(paneDetail), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  return new Response(JSON.stringify({ error: `Unexpected fixture request ${method} ${url.pathname}` }), { status: 404, headers: { 'content-type': 'application/json' } });
};

function Fixture() {
  const [view, setView] = useState<'office' | 'chat'>('office');
  const [batchPanel, setBatchPanel] = useState<string | null>(null);
  const [batchFailed, setBatchFailed] = useState(false);
  const [milestone, setMilestone] = useState<OfficeMilestone | null>(null);
  const [hour, setHour] = useState(12);
  const [questionRequest, setQuestionRequest] = useState<{ id: number; sequence: number } | null>(null);
  const [chatDocked, setChatDocked] = useState(false);
  const questionRequestSequence = React.useRef(0);
  const [target, setTarget] = useState('r1');
  const [text, setText] = useState(longest ? longText : '');
  const [attachments, setAttachments] = useState<PendingAttachment[]>(initialAttachments);
  const [hint, setHint] = useState<string | null>(null);
  (window as Window & { __officeChatDockSetHour?: (hour: number) => void }).__officeChatDockSetHour = setHour;
  const consumeMilestone = React.useCallback((message: OfficeMilestone) => { setMilestone((current) => current === message ? null : current); }, []);
  (window as Window & { __officeChatDockTriggerMilestone?: (kind: OfficeMilestone['kind']) => void }).__officeChatDockTriggerMilestone = (kind) => {
    setMilestone({ type: 'office_milestone', kind, repo_id: 'r1', batch_id: 'r1-b1', bead_id: 'ov-3', at: new Date().toISOString() });
  };
  const readThrough = React.useRef<number | null>(null);
  const chatView = <Chat version={0} repos={repos} reposLoaded repo={target} onRepo={setTarget} board={board} readThrough={readThrough} questionRequest={questionRequest} onQuestionRequestHandled={(sequence) => setQuestionRequest((current) => current?.sequence === sequence ? null : current)} text={text} draftRev={0} onText={setText} onClearText={() => setText('')} attachments={{ attachments, setAttachments, hint, setHint }} />;
  const chatDock = params.get('dock') === '0' || view !== 'office' ? undefined : chatView;
  const openNeeded = (item: NeedsYouItem) => {
    if (item.kind === 'batch') setBatchPanel(item.id);
    if (item.kind === 'question') {
      setQuestionRequest({ id: Number(item.id), sequence: ++questionRequestSequence.current });
      if (!chatDocked) setView('chat');
    }
  };
  return <div className="app">
    <aside className="rail">
      <h1>Overseer</h1>
      <nav className="rail-views" aria-label="Views">
        <button data-view="office" className={view === 'office' ? 'active' : ''} onClick={() => setView('office')}>Office</button>
        <button data-view="chat" className={view === 'chat' ? 'active' : ''} onClick={() => setView('chat')}>Chat</button>
      </nav>
      <div className="rail-context"><div className="rail-status">Mocked layout fixture</div></div>
    </aside>
    <main>
      <div className="office-hold" hidden={view !== 'office'}>
        <div className="office-home">
          <NeedsStrip items={needsItems} draftPlans={2} onOpen={openNeeded} onOpenPlans={() => {}} />
          <Office sessions={officeSessions} openQuestionCount={propCount} milestone={milestone} onMilestoneConsumed={consumeMilestone} board={paneBoard} sceneClock={() => new Date(2026, 8, 25, hour)} active={view === 'office'} hostPanelOpen={batchPanel !== null} onSelectTask={() => setBatchPanel(null)} onOpenChat={() => setView('chat')} onChatDockChange={setChatDocked} chatDock={chatDock} roomProps={{ questions: propCount, reviewBatches: reviewKeys, columns: roomColumns, onOpenChat: () => { roomOpened.push('chat'); setView('chat'); }, onOpenReview: () => roomOpened.push('review'), onOpenBoard: () => roomOpened.push('board') }} />
        </div>
      </div>
      {view === 'office' && batchPanel && <BatchPane key={batchPanel} id={batchPanel} board={paneBoard} version={0} offline={false} loading={!batchFailed} onFetchState={(_path, failed) => setBatchFailed(failed)} onClose={() => setBatchPanel(null)} onSelect={() => {}} onOpenReview={() => {}} />}
      {view === 'chat' && chatView}
    </main>
  </div>;
}

createRoot(document.getElementById('root')!).render(<Fixture />);
