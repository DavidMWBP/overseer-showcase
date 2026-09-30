import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { BoardColumn, BoardResponse, ChatPage, ChatRow, CostsResponse, DaemonStatus, DoctorResponse, OfficeSession, OrchestratorActivity, Plan as PlanT, Repo, StatusResponse, WsMessage } from '@overseer/shared';
import { api, isUnreachable, useWs } from './api';
import type { AttachmentHost, PendingAttachment } from './components/AttachmentPicker';
import { Toasts } from './components/Toasts';
import { actionToast } from './lib/actions';
import { boardLoaded, boardRequested, jobEnded } from './lib/jobs';
import { createBoardResponseGate } from './lib/boardResponse';
import { pushToast } from './lib/toasts';
import { Rail, type View } from './components/Rail';
import { needsYouItems, type NeedsYouItem } from './lib/needsYou';
import { useFaviconBadge } from './lib/useFaviconBadge';
import { Board, BOARD_COLUMNS } from './views/Board';
import { Office } from './office/Office';
import { NeedsStrip, rememberStripRows } from './office/NeedsStrip';
import { Chat } from './views/Chat';
import { Review } from './views/Review';
import { Usage } from './views/Usage';
import { Setup, doctorAlert, type SetupSection } from './views/Setup';
import { Plan } from './views/Plan';
import { PlanList } from './views/PlanList';
import { Programs } from './views/Programs';
import { Discussions } from './views/Discussions';
import { Evidence } from './views/Evidence';
import { BatchPane } from './views/BatchPane';
import { TaskPane } from './views/TaskPane';
import { evidenceFolderFromHash } from './lib/evidence';

const VIEWS: View[] = ['office', 'board', 'chat', 'review', 'setup', 'plan', 'usage', 'discussions', 'evidence'];
type SidePanel = { kind: 'batch'; batchId: string } | { kind: 'task'; beadId: string; fromBatch?: string };
// `#<view>` or, on the Board, `#board/<bead id>` for the card whose pane is open (round 16: a reload closed the pane).
const viewFromHash = (): View | null => { const h = location.hash.slice(1).split('/')[0]; if (h === 'needs') return 'office'; return VIEWS.includes(h as View) ? h as View : null; };
const taskFromHash = (): string | null => { const [v, id] = location.hash.slice(1).split('/'); return v === 'board' && id ? decodeURIComponent(id) : null; };
const planFromHash = (): string | null => { const [v, id] = location.hash.slice(1).split('/'); return v === 'plan' && id ? decodeURIComponent(id) : null; };
const discussionFromHash = (): string | null => { const [v, id] = location.hash.slice(1).split('/'); return v === 'discussions' && id ? decodeURIComponent(id) : null; };
const hashFor = (view: View, boardTask: string | null, planId: string | null, discussionId: string | null, evidenceFolder: string | null = null): string =>
  `#${view}${view === 'board' && boardTask ? `/${encodeURIComponent(boardTask)}` : ''}${view === 'plan' && planId ? `/${encodeURIComponent(planId)}` : ''}${view === 'discussions' && discussionId ? `/${encodeURIComponent(discussionId)}` : ''}${view === 'evidence' && evidenceFolder ? `/${encodeURIComponent(evidenceFolder)}` : ''}`;
const REPO_KEY = 'overseer.chatRepo';
/** The Chat composer's text survives a reload; the key is per repository, since the composer belongs to one. */
const DRAFT_KEY = 'overseer.chatDraft';
const draftKey = (repo: string) => `${DRAFT_KEY}.${repo}`;
/** IDs open when that per-repo draft began, so a saved draft keeps its original question snapshot. */
const DRAFT_QUESTIONS_KEY = 'overseer.chatDraftOpenQuestions';
const draftQuestionsKey = (repo: string) => `${DRAFT_QUESTIONS_KEY}.${repo}`;
/** How long a board fetch may run before the Board says it is refreshing: a fast refresh must not flash the note (fix round 20 review R20-2). */
export const REFRESH_NOTE_MS = 400;
/** How often at most an open Trace is refetched for a session that keeps recording events (a worker writes several a second). */
export const EVENT_REFRESH_MS = 1000;
/** Sessions the web remembers as ended while it waits for a board that confirms it; orchestrator sessions never get confirmed by a card, so the set is capped. */
const ENDED_MAX = 50;
/** Sessions whose event ticks are kept; older ones are dropped, so a long-lived tab does not grow a key per session (fix round 13 review). */
const TICKS_MAX = 50;
const storedRepo = (): string => { try { return localStorage.getItem(REPO_KEY) ?? ''; } catch { return ''; } };
const storedDraft = (repo: string): string => { try { return localStorage.getItem(draftKey(repo)) ?? ''; } catch { return ''; } };
const storedDraftQuestionIds = (repo: string): number[] | null => {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(draftQuestionsKey(repo)) ?? 'null');
    return Array.isArray(value) && value.every((id) => Number.isSafeInteger(id) && id > 0) ? value : null;
  } catch { return null; }
};

function GoneTaskPane({ beadId, onClose }: { beadId: string; onClose: () => void }) {
  const pane = useRef<HTMLElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => { pane.current?.focus({ preventScroll: true }); }, [beadId]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closeRef.current(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);
  return (
    <aside className="detail" ref={pane} tabIndex={-1} aria-label={`Details of ${beadId}`}>
      <div className="detail-head">
        <button className="link detail-back" onClick={onClose} aria-label="Back">‹ Back</button>
        <span className="mono muted">{beadId}</span>
        <button className="link detail-close" onClick={onClose} aria-label="Close details" title="Close details">×</button>
      </div>
      <p className="muted">Task {beadId} is no longer on the board.</p>
    </aside>
  );
}

export function App() {
  // The view lives in the URL hash and the Chat repo choice in localStorage, so a reload lands where the user was.
  const [view, setView] = useState<View>(() => viewFromHash() ?? 'office');
  const [officeDayStart, setOfficeDayStart] = useState(() => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return today.getTime();
  });
  const [boardTask, setBoardTask] = useState<string | null>(taskFromHash);
  const [planId, setPlanId] = useState<string | null>(planFromHash);
  const [discussionId, setDiscussionId] = useState<string | null>(discussionFromHash);
  const [evidenceFolder, setEvidenceFolder] = useState<string | null>(() => evidenceFolderFromHash(location.hash));
  const [discussionVersion, setDiscussionVersion] = useState(0);
  const [plans, setPlans] = useState<PlanT[] | null>(null);
  // Every plan of every status, for the Plans entry on Office: a draft, approved or discarded plan is all reachable there, unlike
  // `plans` above (drafts only), which still feeds the Needs strip on Office and the Rail badge.
  const [allPlans, setAllPlans] = useState<PlanT[] | null>(null);
  const [plansVersion, setPlansVersion] = useState(0);
  const [repos, setRepos] = useState<Repo[] | null>(null);
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [daemon, setDaemon] = useState<DaemonStatus | null>(null);
  const [daemonRefreshKey, setDaemonRefreshKey] = useState(0);
  const [setupTarget, setSetupTarget] = useState<SetupSection | 'daemon' | null>(null);
  const [doctor, setDoctor] = useState<DoctorResponse | null>(null);
  const [costs, setCosts] = useState<CostsResponse | null>(null);
  // The board is fetched once here and refreshed on socket events; Board and Review render it straight away instead of refetching on every visit.
  const [board, setBoard] = useState<BoardResponse | null>(null);
  useEffect(() => {
    let timer: number;
    const scheduleMidnight = () => {
      const now = new Date();
      const today = new Date(now);
      today.setHours(0, 0, 0, 0);
      setOfficeDayStart(today.getTime());
      const nextMidnight = new Date(now);
      nextMidnight.setHours(24, 0, 0, 0);
      timer = window.setTimeout(scheduleMidnight, nextMidnight.getTime() - now.getTime());
    };
    const onVisibilityChange = () => {
      if (document.visibilityState !== 'visible') return;
      window.clearTimeout(timer);
      scheduleMidnight();
    };
    scheduleMidnight();
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.clearTimeout(timer);
    };
  }, []);
  const [chatRows, setChatRows] = useState<ChatRow[] | null>(null);
  const [questionRequest, setQuestionRequest] = useState<{ id: number; sequence: number } | null>(null);
  const questionRequestSequence = useRef(0);
  const [chatDocked, setChatDocked] = useState(false);
  // One entry per session the daemon's office feed is showing, or null until the first snapshot has arrived: an unloaded office is
  // not an empty one. A `leaving` session is dropped here and the Office view walks its character out.
  const [officeSessions, setOfficeSessions] = useState<OfficeSession[] | null>(null);
  // A milestone is transient: only the active Office view receives it, and Office clears it as soon as its effect starts.
  const [officeMilestone, setOfficeMilestone] = useState<Extract<WsMessage, { type: 'office_milestone' }> | null>(null);
  const acknowledgeOfficeMilestone = useCallback((milestone: Extract<WsMessage, { type: 'office_milestone' }>) => {
    setOfficeMilestone((current) => current === milestone ? null : current);
  }, []);
  useEffect(() => { if (view !== 'office') setOfficeMilestone(null); }, [view]);
  // Set when the socket drops and cleared by the snapshot the daemon sends on the next connect, so the shell does not briefly read
  // the last-known set (an empty one included) as the current one between the reconnect and that snapshot.
  const [officeStale, setOfficeStale] = useState(false);
  // The orchestrator's live activity; the daemon resends the current one on every (re)connect, so a refresh mid-turn is right.
  const [activity, setActivity] = useState<OrchestratorActivity | null>(null);
  const [boardVersion, setBoardVersion] = useState(0);
  const [chatVersion, setChatVersion] = useState(0);
  const chatReadThrough = useRef<number | null>(null);
  const [reviewTask, setReviewTask] = useState<string | null>(null);
  const [reviewBatch, setReviewBatch] = useState<string | null>(null);
  const [sidePanel, setSidePanel] = useState<SidePanel | null>(null);
  const [boardAt, setBoardAt] = useState(0); // when `board` was fetched; elapsed times tick from here, so a Board remount cannot reset them
  const [jumpTo, setJumpTo] = useState<string | null>(null);
  const [chatRepo, setChatRepoState] = useState(storedRepo);
  // The composer's draft and pending attachments live here, above the view switch: leaving Chat unmounts the composer, and
  // `File` objects cannot be written to storage, so the state has to outlive it. A draft is kept per repository, in memory and
  // in localStorage, so a send that lands after the user switched repositories clears only the repository it was sent to. Each
  // per-repository draft carries a revision, bumped on every edit: a send captures it and clears only if nothing was typed
  // since, so a draft re-entered to the same text is not erased by the earlier send. The attachment list is kept as it is
  // across a repo switch: a preview URL is revoked when its attachment is removed or sent.
  const [chatDrafts, setChatDrafts] = useState<Record<string, { text: string; rev: number; questionIds: number[] | null }>>(() => {
    const initialRepo = storedRepo();
    const text = storedDraft(initialRepo);
    return { [initialRepo]: { text, rev: 0, questionIds: text ? storedDraftQuestionIds(initialRepo) : null } };
  });
  const [chatAttachments, setChatAttachments] = useState<PendingAttachment[]>([]);
  const [chatAttachmentQuestionIds, setChatAttachmentQuestionIds] = useState<number[] | null>(null);
  const [chatAttachHint, setChatAttachHint] = useState<string | null>(null);
  const chatDraftEntry = chatDrafts[chatRepo] ?? { text: '', rev: 0, questionIds: null };
  const chatDraft = chatDraftEntry.text;
  const chatDraftRev = chatDraftEntry.rev;
  const setChatDraft = (text: string) => {
    setChatDrafts((drafts) => {
      const current = drafts[chatRepo] ?? { text: '', rev: 0, questionIds: null };
      return { ...drafts, [chatRepo]: { ...current, text, rev: current.rev + 1 } };
    });
    try { localStorage.setItem(draftKey(chatRepo), text); } catch { /* storage unavailable */ }
  };
  const setChatDraftQuestionIds = (ids: number[] | null) => {
    setChatDrafts((drafts) => {
      const current = drafts[chatRepo] ?? { text: '', rev: 0, questionIds: null };
      if (current.questionIds === ids || (ids !== null && current.questionIds !== null)) return drafts;
      return { ...drafts, [chatRepo]: { ...current, questionIds: ids } };
    });
    try {
      if (ids === null) localStorage.removeItem(draftQuestionsKey(chatRepo));
      else localStorage.setItem(draftQuestionsKey(chatRepo), JSON.stringify(ids));
    } catch { /* storage unavailable */ }
  };
  const clearChatDraft = (repo: string, rev: number) => {
    setChatDrafts((drafts) => {
      if (drafts[repo]?.rev !== rev) return drafts;
      try { localStorage.setItem(draftKey(repo), ''); } catch { /* storage unavailable */ }
      try { localStorage.removeItem(draftQuestionsKey(repo)); } catch { /* storage unavailable */ }
      return { ...drafts, [repo]: { ...drafts[repo]!, text: '', rev: rev + 1, questionIds: null } };
    });
  };
  const setChatRepo = (id: string) => {
    setChatRepoState(id);
    try { localStorage.setItem(REPO_KEY, id); } catch { /* storage unavailable */ }
    setChatDrafts((drafts) => {
      if (id in drafts) return drafts;
      const text = storedDraft(id);
      return { ...drafts, [id]: { text, rev: 0, questionIds: text ? storedDraftQuestionIds(id) : null } };
    });
  };
  const chatAttachmentHost: AttachmentHost = { attachments: chatAttachments, setAttachments: setChatAttachments, hint: chatAttachHint, setHint: setChatAttachHint };
  const decided = useRef(viewFromHash() !== null);
  // The view the URL asked for, when an install with no repositories cannot show it: Setup opens instead and says so, rather than
  // rewriting the hash in silence (round 21 nit). A view the user picks themselves is not a redirect, so it clears this.
  const [askedFor, setAskedFor] = useState<View | null>(() => { const v = viewFromHash(); return v && v !== 'setup' ? v : null; });
  const manual = useRef(false); // the user picked a view in this session; nothing overrides that
  const landedRepoless = useRef(false); // the repo-less redirect selected Repositories once; it must not re-select on every refetch
  const hashRef = useRef(hashFor(view, boardTask, planId, discussionId, evidenceFolder));
  hashRef.current = hashFor(view, boardTask, planId, discussionId, evidenceFolder);
  const viewRef = useRef(view);
  viewRef.current = view;
  // Keep the marker on a detail entry until its Back button consumes that entry. The marker rides along with the entry.
  useEffect(() => { history.replaceState(history.state, '', hashRef.current); }, [view, boardTask, planId, discussionId, evidenceFolder]);
  useEffect(() => {
    // A hash typed into the address bar switches the view; an unknown one is put back to the current view. The old Needs hash is replaced in place by Office.
    const onHash = () => {
      if (location.hash === hashRef.current) return;
      if (location.hash.slice(1).split('/')[0] === 'needs') history.replaceState(null, '', '#office');
      const v = viewFromHash();
      if (v) {
        if (v !== viewRef.current) setSidePanel(null);
        decided.current = true;
        setAskedFor(v === 'setup' ? null : v);
        setView(v);
        if (v === 'board') setBoardTask(taskFromHash());
        if (v === 'plan') setPlanId(planFromHash());
        if (v === 'discussions') setDiscussionId(discussionFromHash());
        if (v === 'evidence') setEvidenceFolder(evidenceFolderFromHash(location.hash));
      } else history.replaceState(null, '', hashRef.current);
    };
    addEventListener('hashchange', onHash);
    return () => removeEventListener('hashchange', onHash);
  }, []);

  // The daemon is unreachable: the event socket closed or a fetch could not reach it. The page says so, stops ticking, and
  // polls /health with backoff until it answers; then everything is refetched, so a daemon restart needs no reload. An
  // error the daemon itself answered (a 400, a 500 from one endpoint) is not an outage: it is shown for that endpoint.
  const [offline, setOffline] = useState(false);
  const [loadError, setLoadError] = useState<{ path: string; message: string } | null>(null);
  // Every endpoint whose last load failed, not just the newest: a view's shimmer gate asks about its own paths, and one slot
  // would forget an earlier failure as soon as another endpoint failed after it.
  const [failedPaths, setFailedPaths] = useState<string[]>([]);
  const attempt = useRef(0); // health-poll backoff step; reset by a successful load, not by every offline flip
  const load = useCallback(<T,>(path: string, set: (v: T) => void, fresh = false) => api.get<T>(path, { fresh })
    .then((v) => { set(v); attempt.current = 0; setLoadError((e) => (e?.path === path ? null : e)); setFailedPaths((p) => (p.includes(path) ? p.filter((x) => x !== path) : p)); })
    .catch((e: unknown) => { if (isUnreachable(e)) setOffline(true); else { setLoadError({ path, message: e instanceof Error ? e.message : String(e) }); setFailedPaths((p) => (p.includes(path) ? p : [...p, path])); } }), []);
  const loadRepos = useCallback(() => load<Repo[]>('/repos', setRepos), [load]);
  const loadStatus = useCallback(() => { void load<StatusResponse>('/status', setStatus); }, [load]);
  // Daemon metadata is advisory: a failure must not replace the shell's own endpoint error with a header-only concern.
  const loadDaemon = useCallback(() => { void api.get<DaemonStatus>('/daemon', { fresh: true }).then(setDaemon).catch(() => {}); }, []);
  const loadDoctor = useCallback(() => { void load<DoctorResponse>('/doctor', setDoctor); }, [load]);
  const loadCosts = useCallback(() => { void load<CostsResponse>('/costs', setCosts); }, [load]);
  // A slow board build has one request in flight. Socket changes queue one trailing reload and retain its fresh flag.
  const [boardPending, setBoardPending] = useState(0);
  const boardRequestActive = useRef(false);
  const boardReloadQueued = useRef(false);
  const boardReloadFresh = useRef(false);
  const boardSeq = useRef(0);
  const boardResponseGate = useRef(createBoardResponseGate()).current;
  // Sessions the daemon has reported ended whose cards the board still shows as running: the `session_ended` notice arrives
  // seconds before the rebuilt board (a build waits behind bd), and a board requested before the exit can land after it. Until a
  // board confirms the end, such a card is shown settling, so Stop is not offered to a worker that has exited (round 12).
  const endedSessions = useRef(new Set<string>());
  const settle = useCallback((b: BoardResponse): BoardResponse => {
    const ended = endedSessions.current;
    while (ended.size > ENDED_MAX) ended.delete(ended.values().next().value!);
    if (ended.size === 0) return b;
    for (const c of b.repos.flatMap((r) => r.cards)) if (c.session_id && ended.has(c.session_id) && c.session_status !== 'running') ended.delete(c.session_id);
    if (ended.size === 0) return b;
    return { ...b, repos: b.repos.map((r) => ({ ...r, cards: r.cards.map((c) => (c.session_id && ended.has(c.session_id) && c.session_status === 'running' ? { ...c, session_status: 'ended', state: c.state === 'running' ? 'settling' : c.state } : c)) })) };
  }, []);
  const loadBoard = useCallback((fresh = false) => {
    if (boardRequestActive.current) {
      boardReloadQueued.current = true;
      boardReloadFresh.current ||= fresh;
      return;
    }
    const seq = ++boardSeq.current;
    const mark = boardRequested(); // a job accepted before this request is settled by its answer
    boardRequestActive.current = true;
    setBoardPending(1);
    void load<BoardResponse>('/board', (b) => {
      boardResponseGate(seq, () => { boardLoaded(b, mark); setBoard(settle(b)); setBoardAt(Date.now()); });
    }, fresh).finally(() => {
      boardRequestActive.current = false;
      if (boardReloadQueued.current) {
        const nextFresh = boardReloadFresh.current;
        boardReloadQueued.current = false;
        boardReloadFresh.current = false;
        loadBoard(nextFresh);
      } else setBoardPending(0);
    });
  }, [load, settle, boardResponseGate]);
  // "refreshing…" only once a fetch has been in flight this long: a board that answers quickly flashed the note on every socket event (fix round 20 review R20-2).
  const [refreshSlow, setRefreshSlow] = useState(false);
  const boardBusy = boardPending > 0;
  useEffect(() => {
    if (!boardBusy) { setRefreshSlow(false); return; }
    const t = setTimeout(() => setRefreshSlow(true), REFRESH_NOTE_MS);
    return () => clearTimeout(t);
  }, [boardBusy]);
  // The Needs strip on Office needs question rows even while Chat is not mounted. The latest page always carries every open question, however old.
  const loadChatRows = useCallback(() => { void load<ChatPage>('/chat?limit=100', (page) => setChatRows(page.rows)); }, [load]);
  const loadPlans = useCallback(() => { void load<PlanT[]>('/plans', setPlans); }, [load]);
  const loadAllPlans = useCallback(() => { void load<PlanT[]>('/plans/all', setAllPlans); }, [load]);
  const loadAll = useCallback(() => { void loadRepos(); loadStatus(); loadDaemon(); loadDoctor(); loadCosts(); loadBoard(); loadChatRows(); loadPlans(); loadAllPlans(); }, [loadRepos, loadStatus, loadDaemon, loadDoctor, loadCosts, loadBoard, loadChatRows, loadPlans, loadAllPlans]);
  useEffect(() => { loadAll(); }, [loadAll]);
  useEffect(() => {
    const timer = setInterval(loadDaemon, 60_000);
    return () => clearInterval(timer);
  }, [loadDaemon]);
  useEffect(() => {
    if (!offline) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const probe = () => {
      // The Chat view reloads on chatVersion; a recovery without a socket drop would otherwise leave its "could not load" line.
      api.get('/health').then(() => { if (!stopped) { setOffline(false); loadAll(); setChatVersion((v) => v + 1); } }).catch(() => { if (!stopped) timer = setTimeout(probe, Math.min(5000, 1000 * 2 ** ++attempt.current)); });
    };
    timer = setTimeout(probe, Math.min(5000, 1000 * 2 ** attempt.current));
    return () => { stopped = true; clearTimeout(timer); };
  }, [offline, loadAll]);
  useEffect(() => {
    if (repos === null || doctor === null) return;
    // Board, Chat and Review have nothing to show without a repo; Discussions and Evidence do, so their hashes stay.
    if (repos.length === 0 && !manual.current && !['discussions', 'evidence'].includes(viewFromHash() ?? '')) {
      setSidePanel(null);
      setView('setup');
      // A fresh install needs the Add repository form, unless a prerequisite needs attention: choose once per repo-less arrival so the
      // user can move to another section without being pulled back by the next refetch.
      if (!landedRepoless.current) { landedRepoless.current = true; setSetupTarget(doctorAlert(doctor) ? 'general' : 'repositories'); }
    }
    // A repository exists, so the redirect the hash caused is over: removing the last one later is the user's own doing and must
    // not re-announce it (fix round 21 review NB-1: Setup said "Board needs a repository, so Setup opened instead" after a Remove).
    if (repos.length > 0) { setAskedFor(null); landedRepoless.current = false; }
    if (decided.current) return;
    decided.current = true;
    if (doctorAlert(doctor)) { setSidePanel(null); setSetupTarget('general'); setView('setup'); }
  }, [repos, doctor]);
  useEffect(() => {
    if (boardVersion === 0) return;
    // Fresh: a change notice must not be answered by a /board request that was already in flight when the change happened.
    const t = setTimeout(() => { loadBoard(true); loadCosts(); loadStatus(); }, 300); // a tool-only orchestrator turn moves "last active" without a chat row
    return () => clearTimeout(t);
  }, [boardVersion, loadBoard, loadCosts, loadStatus]);
  useEffect(() => { if (chatVersion > 0) loadChatRows(); }, [chatVersion, loadChatRows]);
  // Per session, how many times its events have changed, bumped at most once a second: an open Trace of that session refetches on it
  // (fix round 12 review: the daemon emits `board` only at lifecycle boundaries, so a live trace never refreshed during a run).
  const [eventTicks, setEventTicks] = useState<Record<string, number>>({});
  const eventTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  useEffect(() => () => { for (const t of eventTimers.current.values()) clearTimeout(t); }, []);
  useWs((m: WsMessage) => {
    if (m.type === 'board') setBoardVersion((v) => v + 1);
    // A background action ended: the views holding its target let go of it, the board's own refresh follows, and the
    // outcome shows as a toast either way.
    if (m.type === 'action_result') { jobEnded(m); const t = actionToast(m); pushToast(t.kind, t.text); }
    // The set is updated outside the state updater (an updater runs twice under StrictMode and must not have effects).
    if (m.type === 'session_ended') { endedSessions.current.add(m.session_id); if (board) setBoard(settle(board)); }
    if (m.type === 'event' && !eventTimers.current.has(m.session_id)) {
      eventTimers.current.set(m.session_id, setTimeout(() => { eventTimers.current.delete(m.session_id); setEventTicks((t) => { const { [m.session_id]: n = 0, ...rest } = t; const next = { ...rest, [m.session_id]: n + 1 }; /* re-inserted last, so the cap evicts the least recently bumped session, not the first seen (fix round 14 review) */ for (const k of Object.keys(next).slice(0, Math.max(0, Object.keys(next).length - TICKS_MAX))) delete next[k]; return next; }); }, EVENT_REFRESH_MS));
    }
    if (m.type === 'chat') { setChatVersion((v) => v + 1); loadStatus(); } // every chat row moves the orchestrator's "last active"
    if (m.type === 'status') loadStatus();
    if (m.type === 'repos') void loadRepos();
    if (m.type === 'orchestrator_activity') setActivity(m.activity);
    // The office feed sends one message per session state change. A `leaving` session is dropped: the Office view reads the
    // disappearance as the walk-out, and a session that returns (a verification) is added again.
    if (m.type === 'office') setOfficeSessions((prev) => {
      const without = (prev ?? []).filter((s) => s.session_id !== m.session.session_id);
      return m.session.state === 'leaving' ? without : [...without, m.session];
    });
    // Milestones are one-shot. Ignore them outside the visible Office view; they are never added to the reconnectable session set.
    if (m.type === 'office_milestone' && view === 'office') setOfficeMilestone(m);
    // The snapshot is the whole set the daemon is showing, sent once on every connect (empty included): it replaces the set, so
    // a session that ended while the socket was down is missing from it and walks out on the reconnect instead of lingering as a ghost.
    if (m.type === 'office_snapshot') { setOfficeStale(false); setOfficeSessions(m.sessions); }
    if (m.type === 'plans') { setPlansVersion((v) => v + 1); loadPlans(); loadAllPlans(); }
    // A discussion recorded a turn, ended, or changed status: the list and any open thread refetch.
    if (m.type === 'discussion') setDiscussionVersion((v) => v + 1);
    // A lost socket keeps the last office set: the room stays drawn, dimmed and frozen (Office.tsx), until the snapshot the daemon
    // sends on reconnect replaces the whole set, so a session that ended while the socket was down walks out then, not now. `officeStale`
    // keeps that dimmed presentation through the gap between the reconnect and the snapshot, so the held set is never read as current.
  }, (c) => { setOffline(c === 'lost'); if (c === 'lost') { setActivity(null); setOfficeStale(true); } else { loadDaemon(); setDaemonRefreshKey((v) => v + 1); } }); // a reconnect already refetches through the messages above; the daemon resends the activity

  const mainRef = useRef<HTMLElement>(null);
  // main is the scroll container; a view switched from the tab bar at the bottom of a long page otherwise opened scrolled down.
  const onView = (v: View, target?: { section: SetupSection | 'daemon' }) => { if (v !== view) setSidePanel(null); decided.current = true; manual.current = true; setAskedFor(null); setSetupTarget(target?.section ?? null); if (v === 'discussions') setDiscussionId(null); if (v === 'evidence') setEvidenceFolder(null); setView(v); mainRef.current?.scrollTo?.(0, 0); };
  // A detail opened from the list or the Office strip pushes its own entry; Back consumes it and restores that preceding hash.
  const openPlan = (id: string) => {
    history.pushState({ overseerPlanDetail: true }, '', hashFor('plan', null, id, null));
    setPlanId(id);
    onView('plan');
  };
  const openPlanList = () => { setPlanId(null); onView('plan'); };
  // A discussion opened from the list (Start, or a row) pushes its own entry, so Back returns to the list.
  const openDiscussion = (id: string) => {
    history.pushState({ overseerDiscussionDetail: true }, '', `#discussions/${encodeURIComponent(id)}`);
    setDiscussionId(id);
  };
  const closeDiscussion = () => { if (history.state?.overseerDiscussionDetail) history.back(); else setDiscussionId(null); };
  const onRepo = (id: string) => { onView('board'); setJumpTo(id); };
  const onSetupTargeted = useCallback(() => setSetupTarget(null), []);
  // The thread's context is what goes; it asks like every other irreversible action (round 10: one click lost it, the tooltip only helps if hovered first).
  const newSession = () => {
    if (!confirm("Start a new orchestrator session? The orchestrator's memory of this conversation is lost; the next message starts fresh. Batches and tasks are unaffected.")) return;
    void api.post('/orchestrator/reset').then(loadStatus);
  };
  // Batch ids carry the repo id as their prefix (bead ids need not: Review deselects a bead the board no longer lists); a Review selection under a removed repo would 404 on the next board refresh.
  const onRepoRemoved = (id: string) => { const under = (x: string | null) => (x !== null && x.startsWith(`${id}-`) ? null : x); setReviewBatch(under); setReviewTask(under); };

  // A fetch a view waits on has failed: that view then shows its own line, not a shimmer of content that never arrived (the
  // loading contract's rule, the same gate Chat, Trace and the board pane apply to their own fetches). The signal is scoped to
  // the paths the view actually waits on, so an unrelated endpoint's error (/status, /doctor, /costs, the other view's plans
  // fetch) cannot end a shimmer while the data it stands in for is still in flight.
  const fetchFailed = (paths: string[]) => offline || paths.some((p) => failedPaths.includes(p));
  const needsFailed = fetchFailed(['/board', '/chat?limit=100', '/plans', '/repos']);
  const planListFailed = fetchFailed(['/plans/all']);
  // Everything blocked on the user, from the board, the latest chat page, the draft plans and the repos already in hand.
  const needed = needsYouItems(board, chatRows, plans, repos);
  useFaviconBadge(needed.length);
  const openNeeded = (i: NeedsYouItem) => {
    if (i.kind === 'plan') return openPlan(i.id);
    if (i.kind === 'repo') return onView('setup', { section: 'repositories' });
    if (i.kind === 'question') {
      setQuestionRequest({ id: Number(i.id), sequence: ++questionRequestSequence.current });
      if (!chatDocked) onView('chat');
      return;
    }
    if (i.kind === 'batch') { setSidePanel({ kind: 'batch', batchId: i.id }); return; }
    setSidePanel({ kind: 'task', beadId: i.id });
  };

  const counts = {
    running: board?.repos.flatMap((r) => r.cards).filter((c) => c.column === 'running').length ?? 0,
    questions: chatRows?.filter((c) => c.kind === 'question' && c.answered_at === null && c.superseded_at === null).length ?? 0,
    failed: board?.repos.flatMap((r) => r.cards).filter((c) => c.verify_failure !== null && c.column !== 'done').length ?? 0,
    plans: plans?.filter((p) => p.status === 'draft').length ?? 0,
    // The Review badge keeps the user-actionable count and names held batches separately in its tooltip and accessible name.
    review: needed.filter((i) => i.kind === 'batch').length,
    reviewWaiting: board?.repos.flatMap((r) => r.batches).filter((b) => b.status === 'review' && !!b.waiting_on).length ?? 0,
  };
  // While the Office shows, a prop whose data is still in flight shows a shimmer instead of a false 0 (null), as the strip does;
  // once its fetch has failed it falls back to 0. In review and the whiteboard's columns count board rows only, so they wait on /board alone.
  const boardUnloaded = view === 'office' && board === null && !fetchFailed(['/board']);
  const needsPending = view === 'office' && (board === null || chatRows === null || plans === null || repos === null) && !needsFailed;
  const questionsUnloaded = view === 'office' && chatRows === null && !fetchFailed(['/chat?limit=100']);
  // The whiteboard draws one note per task, so each column carries a key per task; a moved key travels between columns.
  // Two repositories can hold the same bead id, so the key is the repository id and the bead id.
  // Done shows only tasks closed since the browser's local midnight; the Board keeps its full Done column.
  const officeColumns = useMemo((): { key: BoardColumn; label: string; ids: string[] | null }[] => BOARD_COLUMNS.map(({ key, label }) => ({
    key,
    label: key === 'done' ? 'Done today' : label,
    ids: boardUnloaded ? null : board?.repos.flatMap((r) => r.cards.filter((c) => c.column === key && (key !== 'done' || (c.bead.closed_at !== null && Date.parse(c.bead.closed_at) >= officeDayStart))).map((c) => `${r.repo.id}/${c.bead.id}`)) ?? [],
  })), [board, boardUnloaded, officeDayStart]);
  // The meeting table holds one folder per Board batch in review, in every repository, keyed by repository and batch id;
  // unlike the Review badge it counts batches that wait on something and batches in a repository whose orchestrator merges
  // without asking.
  const reviewFolders = useMemo(() => (boardUnloaded ? null
    : board?.repos.flatMap((r) => r.batches.filter((b) => b.status === 'review').map((b) => `${r.repo.id}/${b.id}`)) ?? []), [board, boardUnloaded]);
  const needsLoaded = board !== null && chatRows !== null && plans !== null && repos !== null;
  // The strip placeholder reserves as many item rows as the strip showed the last time it loaded in this browser.
  useEffect(() => { if (needsLoaded) rememberStripRows(needed.length); }, [needsLoaded, needed.length]);

  // Setup says which view sent the user here, but only while that is still true: with a repository, or after the user picked a view, nothing is said.
  const sentFrom = repos?.length === 0 && askedFor ? askedFor.replace(/^./, (c) => c.toUpperCase()) : null;
  const unfinishedBatches = Object.fromEntries(board?.repos.map((r) => [r.repo.id, { open: r.batches.filter((b) => b.status === 'open').length, review: r.batches.filter((b) => b.status === 'review').length }]) ?? []);
  const chatView = <Chat version={chatVersion} repos={repos} reposLoaded={repos !== null} repo={repos?.some((r) => r.id === chatRepo) ? chatRepo : ''} onRepo={setChatRepo} board={board} onOpenBatch={(batch) => setSidePanel({ kind: 'batch', batchId: batch.id })} offline={offline} onSetup={() => onView('setup', { section: 'repositories' })} readThrough={chatReadThrough} questionRequest={questionRequest} onQuestionRequestHandled={(sequence) => setQuestionRequest((current) => current?.sequence === sequence ? null : current)} text={chatDraft} draftRev={chatDraftRev} draftQuestionIds={chatDraftEntry.questionIds} onDraftQuestionIds={setChatDraftQuestionIds} attachmentQuestionIds={chatAttachmentQuestionIds} onAttachmentQuestionIds={setChatAttachmentQuestionIds} onText={setChatDraft} onClearText={clearChatDraft} attachments={chatAttachmentHost} />;
  return (
    <div className="app">
      <Rail repos={repos} status={status} daemon={daemon} costs={costs} counts={counts} view={view} onView={onView} onRepo={onRepo} setupAlert={doctorAlert(doctor)} onNewSession={newSession} activity={activity} pendingQuestion={counts.questions > 0} offline={offline} loadFailed={fetchFailed} />
      <main ref={mainRef}>
        {/* Before anything loaded there is no last known state to speak of (fix round 15 review: the banner contradicted Chat's own line). */}
        {offline && <div className="banner-warn" role="alert">Daemon unreachable, retrying… {board === null && repos === null ? 'Nothing has been loaded yet.' : 'What you see is the last known state; it refreshes when the daemon is back.'}</div>}
        {loadError && !offline && <div className="banner-warn" role="alert">Could not load /api{loadError.path}: {loadError.message}</div>}
        {view === 'plan' && (planId
          ? <Plan id={planId} version={plansVersion} offline={offline} onBack={() => (history.state?.overseerPlanDetail ? history.back() : onView('office'))} onOpenBoard={(repoId) => { history.pushState(null, '', hashFor('board', null, null, null)); setJumpTo(repoId); onView('board'); }} />
          : <><PlanList plans={allPlans} loading={allPlans === null && !planListFailed} onOpen={openPlan} /><Programs version={boardVersion + chatVersion} onOpenBatch={(batchId) => setSidePanel({ kind: 'batch', batchId })} /></>)}
        {view === 'board' && <Board board={board} boardAt={boardAt} version={boardVersion} eventTicks={eventTicks} offline={offline} refreshing={refreshSlow && !offline} jumpTo={jumpTo} onJumped={() => setJumpTo(null)} onOpenReview={(id) => { setReviewTask(id); setReviewBatch(null); onView('review'); }} onOpenBatch={(id) => { setReviewBatch(id); setReviewTask(null); onView('review'); }} initialSelected={boardTask} onSelected={setBoardTask} />}
        {/* Office stays mounted while another view shows, so the desks and characters it keeps in its own state survive the switch; the hidden attribute hides it and drops it from the accessibility tree, and `active` pauses its loop. The held set reads as reconnecting until the snapshot after a reconnect. */}
        <div className="office-hold" hidden={view !== 'office'}>
          <div className="office-home">
            <NeedsStrip items={needed} draftPlans={counts.plans} loading={needsPending} active={view === 'office'} onOpen={openNeeded} onOpenPlans={openPlanList} />
            <Office sessions={officeSessions} openQuestionCount={counts.questions} milestone={view === 'office' ? officeMilestone : null} onMilestoneConsumed={acknowledgeOfficeMilestone} board={board} version={boardVersion} eventTicks={eventTicks} offline={offline} stale={officeStale} active={view === 'office'} hostPanelOpen={sidePanel !== null} onSelectTask={() => setSidePanel(null)} onOpenReview={(id) => { setReviewTask(id); setReviewBatch(null); onView('review'); }} onOpenBatch={(id) => setSidePanel({ kind: 'batch', batchId: id })} onOpenChat={() => onView('chat')} onChatDockChange={setChatDocked} chatDock={view === 'office' ? chatView : undefined} roomProps={{ questions: questionsUnloaded ? null : counts.questions, reviewBatches: reviewFolders, columns: officeColumns, onOpenChat: () => onView('chat'), onOpenReview: () => onView('review'), onOpenBoard: () => onView('board') }} />
          </div>
        </div>
        {view === 'chat' && chatView}
        {view === 'review' && <Review board={board} version={boardVersion} selected={reviewTask} onSelect={setReviewTask} selectedBatch={reviewBatch} onSelectBatch={setReviewBatch} offline={offline} loadFailed={fetchFailed} />}
        {view === 'usage' && <Usage offline={offline} />}
        {view === 'discussions' && <Discussions id={discussionId} repos={repos} version={discussionVersion} offline={offline} onOpen={openDiscussion} onBack={closeDiscussion} />}
        {view === 'evidence' && <Evidence folder={evidenceFolder} offline={offline} />}
        {view === 'setup' && <Setup sentFrom={sentFrom} repos={repos} doctor={doctor} offline={offline} loadFailed={fetchFailed} unfinishedBatches={unfinishedBatches} onOpenUsage={() => onView('usage')} onOpenDiscussions={() => onView('discussions')} onOpenEvidence={() => onView('evidence')} onRefreshDoctor={loadDoctor} onReposChanged={loadRepos} onRemoved={onRepoRemoved} daemonRefreshKey={daemonRefreshKey} target={setupTarget} onTargeted={onSetupTargeted} />}
        {view !== 'board' && board && sidePanel?.kind === 'batch' && <BatchPane key={sidePanel.batchId} id={sidePanel.batchId} board={board} version={boardVersion} offline={offline} loading={!fetchFailed([`/batches/${sidePanel.batchId}`])} onFetchState={(path, failed) => setFailedPaths((paths) => failed ? (paths.includes(path) ? paths : [...paths, path]) : paths.filter((x) => x !== path))} onClose={() => setSidePanel(null)} onSelect={(beadId) => setSidePanel({ kind: 'task', beadId, fromBatch: sidePanel.batchId })} onOpenReview={(id) => { setReviewBatch(id); setReviewTask(null); onView('review'); }} />}
        {view !== 'board' && board && sidePanel?.kind === 'task' && (
          board.repos.some((r) => r.cards.some((card) => card.bead.id === sidePanel.beadId))
            ? <TaskPane beadId={sidePanel.beadId} board={board} version={boardVersion} eventTicks={eventTicks} offline={offline} onSelect={(beadId) => setSidePanel({ ...sidePanel, beadId })} onClose={() => setSidePanel(null)} onBackToBatch={sidePanel.fromBatch ? () => setSidePanel({ kind: 'batch', batchId: sidePanel.fromBatch! }) : undefined} onOpenReview={(id) => { setReviewTask(id); setReviewBatch(null); onView('review'); }} onOpenBatch={(batchId) => setSidePanel({ kind: 'batch', batchId })} />
            : <GoneTaskPane beadId={sidePanel.beadId} onClose={() => setSidePanel(null)} />
        )}
      </main>
      <Toasts />
    </div>
  );
}
