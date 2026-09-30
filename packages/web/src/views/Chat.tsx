import { Fragment, type KeyboardEvent, type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { BatchSummary, BoardResponse, ChatPage, ChatRow, ChatSendRequest, Repo, RepoCommand } from '@overseer/shared';
import { api, getChatPage, isUnreachable } from '../api';
import { PlainText } from '../components/PlainText';
import { AttachmentButton, AttachmentPreviews, attachmentOps, type AttachmentHost } from '../components/AttachmentPicker';
import { Loading } from '../components/Loading';
import { batchStatusLabel } from '../components/BatchRow';

function Question(p: { q: ChatRow; onAnswered: () => void; answerRef: (element: HTMLTextAreaElement | null) => void }) {
  const [text, setText] = useState('');
  const submit = async () => {
    if (!text.trim()) return;
    await api.post('/chat/answer', { question_id: p.q.id, text: text.trim() });
    setText('');
    p.onAnswered();
  };
  // Dismiss closes the question and tells the orchestrator so (a paid turn when a session is live); a superseded question needs no Dismiss.
  // A failed dismiss (a stale id after a refresh) must not be an unhandled rejection that leaves the card up: the refetch shows what is true.
  const dismiss = async () => { try { await api.post('/chat/dismiss', { question_id: p.q.id }); } catch { /* the thread refetch below shows the current state */ } p.onAnswered(); };
  return (
    <div className="question">
      {/* Focusable with a name so a long question can be scrolled from the keyboard; Safari does not make a scroller a tab stop itself. */}
      <div className="question-text" role="region" aria-label="Question text" tabIndex={0}><PlainText text={p.q.text} /></div>
      <textarea ref={p.answerRef} value={text} onChange={(e) => setText(e.target.value)} placeholder="Your answer" aria-label="Your answer" rows={2}
        onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void submit(); } }} />
      <div className="question-actions">
        <button onClick={() => void submit()}>Answer</button>
        <button className="link" onClick={() => void dismiss()} title="Close the question without answering; the orchestrator is told not to wait for an answer.">Dismiss</button>
      </div>
    </div>
  );
}

const isPending = (r: ChatRow) => r.kind === 'question' && r.answered_at === null && r.superseded_at === null;
// A thread a few pixels short of its end is at the bottom: an iPhone's touch scroll stops 2-3 px short, and a stricter test lost
// every row read on the way down. 24 px stays under one row, so a thread scrolled up by a row is not read through.
export const AT_BOTTOM_TOLERANCE = 24;
export const atBottom = (el: HTMLElement) => el.scrollHeight - el.clientHeight - el.scrollTop <= AT_BOTTOM_TOLERANCE;

/**
 * The shape of an arrived thread, shimmered while the first page is in flight (the thread used to be an empty scroller: the
 * empty-state line is gated on a loaded page, so a slow fetch showed nothing at all). Three messages — a request, the
 * orchestrator's reply and a notice — is the shape of a short exchange and measures the same 167 px as the loaded fixture
 * thread's messages, so the swap moves the content by nothing rather than by the height of the scroller.
 */
function ThreadPlaceholder() {
  const rows: { role: string; label: string; text: string }[] = [
    { role: 'user', label: 'You', text: 'Add a greeting endpoint to the api package.' },
    { role: 'assistant', label: 'Orchestrator', text: 'Created a batch with one task and dispatched a worker to it.' },
    { role: 'system', label: 'Overseer', text: 'Verification passed and the branch landed.' },
  ];
  // aria-hidden: the thread is a live region, and aria-busy does not take a subtree out of the accessibility tree, so without it a
  // screen reader would read three messages that were never sent. Loading's own role="status" carries the loading state.
  return (
    <div className="thread-placeholder" aria-hidden="true">
      {rows.map((r, i) => (
        <div key={i} className={`msg msg-${r.role}`}>
          <div className="msg-role">{r.label}</div>
          <div className="pre">{r.text}</div>
        </div>
      ))}
    </div>
  );
}

/** The daemon stores a repo-scoped message as `[repo: <id>] text`; show the scope as a tag instead of the raw prefix. */
export function splitRepoTag(text: string): { repo: string | null; text: string } {
  const m = /^\[repo: ([^\]]+)\] ([\s\S]*)$/.exec(text);
  return m ? { repo: m[1]!, text: m[2]! } : { repo: null, text };
}

/**
 * Chronological order, where a question counts from the moment it was resolved: the answer is the user's move, so the question
 * lands after the turn that asked it ("Waiting on your answer…" is stored after the question row) and before the reply
 * to the answer. A superseded question follows the same rule, since sorting one kind of resolved question by its answer and
 * the other by when it was asked put two questions of one turn on opposite sides of the line that closed the turn, and the
 * thread read as an answer to a question that had not been asked yet (round 20 R20-3). Ties keep id order.
 */
export function orderThread(rows: ChatRow[]): ChatRow[] {
  const at = (r: ChatRow) => (r.kind === 'question' && (r.answered_at ?? r.superseded_at)) || r.ts;
  return [...rows].sort((a, b) => at(a).localeCompare(at(b)) || a.id - b.id);
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const sameLocalDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

/**
 * The day separator's text: Today, Yesterday, else a fixed "Mon 21 Sep". Built from the local calendar parts rather than
 * `toLocaleDateString`, so the same conversation reads the same in every locale.
 */
export function dayLabel(ts: string, now: Date = new Date()): string {
  const d = new Date(ts);
  if (sameLocalDay(d, now)) return 'Today';
  if (sameLocalDay(d, new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1))) return 'Yesterday';
  return `${WEEKDAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

/** The local wall-clock HH:MM of a stored UTC timestamp (the daemon writes UTC; the dashboard shows local time). */
export function formatTime(ts: string): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** Rows of one role within this gap form a group; a longer gap splits it. */
const GROUP_GAP_MS = 5 * 60 * 1000;

export interface ChatItem {
  row: ChatRow;
  /** The day separator to print above this row, or null when it shares the previous row's local day. */
  day: string | null;
  /** True when this row begins a group: only it carries the role label and time. */
  groupStart: boolean;
}

/**
 * Annotate an already-ordered thread for display. The first row of each local day opens a day separator. Consecutive rows
 * of the same role within five minutes form one group (tighter spacing, one role label); a question, a system notice, a day
 * boundary or a role change always starts a new group.
 */
export function groupThread(thread: ChatRow[], now: Date = new Date()): ChatItem[] {
  let prev: ChatRow | null = null;
  let prevDate: Date | null = null;
  return thread.map((row) => {
    const date = new Date(row.ts);
    const dayBoundary = prevDate === null || !sameLocalDay(prevDate, date);
    const gap = prevDate === null ? Infinity : date.getTime() - prevDate.getTime();
    const groupStart = prev === null
      || dayBoundary
      || prev.role !== row.role
      || row.kind === 'question' || prev.kind === 'question'
      || row.role === 'system'
      || gap < 0 || gap > GROUP_GAP_MS;
    const item: ChatItem = { row, day: dayBoundary ? dayLabel(row.ts, now) : null, groupStart };
    prev = row;
    prevDate = date;
    return item;
  });
}

const QUOTE_MAX = 80;
/**
 * The first line of the user message an orchestrator row answers, when a newer user message sits between them: a reply that
 * lands after the user's next message otherwise reads as the answer to it (round 16). Null when the row answers the message
 * right above it, or has no known origin (a turn started by a notice or an answer).
 */
export function repliesTo(thread: ChatRow[]): Map<number, string> {
  const byId = new Map(thread.map((x) => [x.id, x]));
  const out = new Map<number, string>();
  let lastUser: ChatRow | undefined;
  for (const r of thread) {
    if (r.role === 'user') { lastUser = r; continue; }
    if (r.role !== 'assistant' || r.reply_to === null || r.reply_to === undefined || !lastUser || lastUser.id === r.reply_to) continue;
    const target = byId.get(r.reply_to);
    if (!target) continue;
    const line = splitRepoTag(target.text).text.split('\n')[0]!.trim();
    out.set(r.id, line.length > QUOTE_MAX ? `${line.slice(0, QUOTE_MAX)}…` : line);
  }
  return out;
}

/** `stamp` is a continuation row's time and status, floated right ahead of the text so only the first line flows around it. */
function UserText(p: { text: string; stamp?: ReactNode }) {
  const { repo, text } = splitRepoTag(p.text);
  return <div className="pre">{p.stamp}{repo && <span className="chip repo-tag">{repo}</span>}{text}</div>;
}

/** What the composer says instead of the proxy's status code while the daemon is down (round 11: "POST /chat failed with 500" under a banner that said unreachable). */
export const OUTAGE_SEND = 'Daemon unreachable, retrying… The message was not sent; it stays here until the daemon is back.';
export const OUTAGE_LOAD = 'Daemon unreachable, retrying… The thread is the last one loaded.';
/** Chat opened during the outage: there is no last thread to show, and the line must not claim one (round 15). */
export const OUTAGE_LOAD_NONE = 'Daemon unreachable, retrying… The thread cannot be loaded until the daemon is back.';
/** With more than one repo registered, the stored default is not used until the user has picked a target in this browser session (round 12: a message went out under the last-used repo). */
export const PICK_REPO = 'Pick the repository this message is for; it was not sent.';
const CHOSEN_KEY = 'overseer.chatRepoChosen';
const readChosen = (): boolean => { try { return sessionStorage.getItem(CHOSEN_KEY) === '1'; } catch { return false; } };

interface SlashToken { start: number; end: number; query: string }

function slashTokenAt(text: string, caret: number): SlashToken | null {
  const match = /(^|\s)\/([\p{L}\p{N}_:.-]*)$/u.exec(text.slice(0, caret));
  return match ? { start: match.index + match[1]!.length, end: caret, query: match[2]! } : null;
}

function commandsMatching(commands: RepoCommand[], query: string): RepoCommand[] {
  const search = query.toLowerCase();
  return commands
    .filter((command) => command.name.toLowerCase().includes(search) || command.description.toLowerCase().includes(search))
    .sort((a, b) => {
      const aRank = a.name.toLowerCase().includes(search) ? 0 : 1;
      const bRank = b.name.toLowerCase().includes(search) ? 0 : 1;
      return aRank - bRank || a.name.localeCompare(b.name);
    });
}

function highlightMatch(text: string, query: string): ReactNode {
  const index = query ? text.toLowerCase().indexOf(query.toLowerCase()) : -1;
  return index < 0 ? text : <>{text.slice(0, index)}<mark>{text.slice(index, index + query.length)}</mark>{text.slice(index + query.length)}</>;
}

export function Chat(p: { version: number; repos: Repo[] | null; repo: string; onRepo: (id: string) => void; board?: BoardResponse | null; onOpenBatch?: (batch: BatchSummary) => void; /** The daemon is unreachable (the shell knows): a send is refused with the outage, not attempted and reported as an HTTP code. */ offline?: boolean; /** Opens Setup: with no repository registered the composer sends the user there instead of spending an orchestrator turn (round 14). */ onSetup?: () => void; /** False while the repo list has not loaded yet: an unknown list is not an empty one (fix round 14 review). */ reposLoaded?: boolean; /** Highest row read when Chat was last left or sent; owned by the shell across view changes. */ readThrough?: { current: number | null }; /** A one-shot shell request to select and focus an open question. */ questionRequest?: { id: number; sequence: number } | null; onQuestionRequestHandled?: (sequence: number) => void; /** The composer's draft and pending attachments, owned by the shell so leaving the view does not lose them. */ text: string; /** The draft's revision, bumped by the shell on every edit; a send captures it so its completion clears only an untouched draft. */ draftRev: number; draftQuestionIds?: number[] | null; onDraftQuestionIds?: (ids: number[] | null) => void; attachmentQuestionIds?: number[] | null; onAttachmentQuestionIds?: (ids: number[] | null) => void; onText: (text: string) => void; onClearText: (repo: string, rev: number) => void; attachments: AttachmentHost }) {
  const [rows, setRows] = useState<ChatRow[] | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [oldestId, setOldestId] = useState<number | null>(null);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const text = p.text;
  const setText = p.onText;
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const repo = p.repo;
  const repos = p.repos ?? [];
  const [chosen, setChosen] = useState(readChosen);
  // The select is a default that outlives the session; a second repo makes a silent default a wrong-repo risk, so a first send asks for the choice.
  const needsChoice = repos.length > 1 && !chosen;
  const noRepos = repos.length === 0 && (p.reposLoaded ?? true);
  const choose = (id: string) => { setChosen(true); try { sessionStorage.setItem(CHOSEN_KEY, '1'); } catch { /* storage unavailable */ } setError((e) => (e === PICK_REPO ? null : e)); p.onRepo(id); };
  const chatRef = useRef<HTMLDivElement>(null);
  const threadRef = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const sendingRef = useRef(false);
  const select = useRef<HTMLSelectElement>(null);
  const refocus = useRef(false);
  const suggestionList = useRef<HTMLDivElement>(null);
  const requestedCommands = useRef(new Set<string>());
  const [commandsByRepo, setCommandsByRepo] = useState<Map<string, RepoCommand[] | null>>(() => new Map());
  const [slashToken, setSlashToken] = useState<SlashToken | null>(null);
  const [dismissedSuggestion, setDismissedSuggestion] = useState<string | null>(null);
  const [activeSuggestion, setActiveSuggestion] = useState(0);
  const [pendingCaret, setPendingCaret] = useState<number | null>(null);
  const commandRepo = repo && !needsChoice ? repo : '';
  const slashKey = slashToken ? `${commandRepo}:${slashToken.start}:${slashToken.query}` : '';
  const commandMatches = slashToken && commandRepo
    ? commandsMatching(commandsByRepo.get(commandRepo) ?? [], slashToken.query)
    : [];
  const suggestionsOpen = !sending && commandMatches.length > 0 && slashKey !== dismissedSuggestion;
  const selectedSuggestion = commandMatches[activeSuggestion] ?? commandMatches[0];
  const readSlashToken = (element: HTMLTextAreaElement) => {
    setSlashToken(slashTokenAt(element.value, element.selectionStart ?? element.value.length));
  };
  useEffect(() => {
    if (!slashToken || !commandRepo || requestedCommands.current.has(commandRepo)) return;
    requestedCommands.current.add(commandRepo);
    void api.get<RepoCommand[]>(`/repos/${encodeURIComponent(commandRepo)}/commands`)
      .then((commands) => setCommandsByRepo((current) => new Map(current).set(commandRepo, commands)))
      .catch(() => setCommandsByRepo((current) => new Map(current).set(commandRepo, null)));
  }, [commandRepo, slashToken]);
  useEffect(() => {
    if (!suggestionsOpen) return;
    const list = suggestionList.current;
    const option = list?.querySelector<HTMLElement>(`[data-suggestion-index="${activeSuggestion}"]`);
    if (!list || !option) return;
    const listTop = list.getBoundingClientRect().top + list.clientTop;
    const optionTop = option.getBoundingClientRect().top - listTop + list.scrollTop;
    const optionBottom = optionTop + option.getBoundingClientRect().height;
    if (optionTop < list.scrollTop) list.scrollTop = optionTop;
    else if (optionBottom > list.scrollTop + list.clientHeight) list.scrollTop = optionBottom - list.clientHeight;
  }, [activeSuggestion, suggestionsOpen]);
  useEffect(() => { setActiveSuggestion(0); }, [slashToken?.start, slashToken?.query]);
  useLayoutEffect(() => {
    const element = input.current;
    if (element && document.activeElement === element) setSlashToken(slashTokenAt(text, element.selectionStart ?? text.length));
  }, [text]);
  useLayoutEffect(() => {
    if (pendingCaret === null) return;
    input.current?.focus();
    input.current?.setSelectionRange(pendingCaret, pendingCaret);
    setPendingCaret(null);
  }, [pendingCaret, text]);
  const insertCommand = (command: RepoCommand) => {
    if (!slashToken) return;
    const insertion = `/${command.name} `;
    const next = `${text.slice(0, slashToken.start)}${insertion}${text.slice(slashToken.end)}`;
    setPendingCaret(slashToken.start + insertion.length);
    setSlashToken(null);
    setDismissedSuggestion(slashKey);
    setText(next);
  };
  const composerKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (suggestionsOpen && event.key === 'ArrowDown') {
      event.preventDefault();
      setActiveSuggestion((current) => (current + 1) % commandMatches.length);
      return;
    }
    if (suggestionsOpen && event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveSuggestion((current) => (current + commandMatches.length - 1) % commandMatches.length);
      return;
    }
    if (suggestionsOpen && event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      setDismissedSuggestion(slashKey);
      return;
    }
    if (suggestionsOpen && (event.key === 'Tab' || (event.key === 'Enter' && !event.shiftKey))) {
      event.preventDefault();
      if (selectedSuggestion) insertCommand(selectedSuggestion);
      return;
    }
    if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void send(); }
  };

  // A failed load keeps whatever thread is shown and says so in the composer's error line; the empty-thread hint needs a real answer.
  const loadedOnce = useRef(false);
  const scrollToBottom = useRef(true);
  const [pinned, setPinned] = useState(true);
  // Keep the divider until send or reload; the button counts only arrivals since the latest bottom read.
  const [unreadIds, setUnreadIds] = useState<number[]>([]);
  const [jumpUnreadIds, setJumpUnreadIds] = useState<number[]>([]);
  const [selectedQuestion, setSelectedQuestion] = useState<{ id: number; index: number } | null>(null);
  const questionAnswers = useRef(new Map<number, HTMLTextAreaElement>());
  const handledQuestionRequest = useRef<number | null>(null);
  const focusedQuestionRequest = useRef<number | null>(null);
  const [focusQuestionRequest, setFocusQuestionRequest] = useState<number | null>(null);
  const highestId = () => Math.max(0, ...rowsRef.current.map((row) => row.id));
  // Reading is recorded while the thread is at the bottom, not only when Chat is left; the unmount check is a second chance.
  const markRead = () => {
    const thread = threadRef.current;
    if (thread && atBottom(thread) && p.readThrough && rowsRef.current.length) p.readThrough.current = Math.max(p.readThrough.current ?? 0, highestId());
  };
  // The thread's own position, not scrollIntoView, which can move the page or the visual viewport on iOS. Repeated on the next
  // frame so late layout (images, the question card, the chips) leaves no gap.
  const toBottom = () => {
    const thread = threadRef.current;
    if (!thread) return;
    thread.scrollTop = thread.scrollHeight;
    setJumpUnreadIds([]);
    markRead();
    requestAnimationFrame(() => {
      const current = threadRef.current;
      if (!current || !scrollToBottom.current) return;
      current.scrollTop = current.scrollHeight;
      markRead();
    });
  };
  useLayoutEffect(() => () => markRead(), []);
  useEffect(() => {
    const viewport = window.visualViewport;
    const chat = chatRef.current;
    if (!viewport || !chat) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      const thread = threadRef.current;
      const pinned = thread && atBottom(thread);
      // iOS leaves the layout viewport tall when the keyboard reduces only the visual viewport.
      if (viewport.scale === 1 && viewport.height < window.innerHeight - 1) {
        chat.style.setProperty('--chat-viewport-height', `${Math.max(0, viewport.offsetTop + viewport.height - chat.getBoundingClientRect().top)}px`);
        // The pinned question card's cap is a share of what is visible, not of the layout viewport the keyboard covers.
        chat.style.setProperty('--visual-viewport-height', `${viewport.height}px`);
        chat.classList.add('chat-visual-viewport');
      } else {
        chat.classList.remove('chat-visual-viewport');
        chat.style.removeProperty('--chat-viewport-height');
        chat.style.removeProperty('--visual-viewport-height');
      }
      if (pinned && thread) thread.scrollTop = thread.scrollHeight - thread.clientHeight;
    };
    const schedule = () => { if (!document.hidden && !frame) frame = requestAnimationFrame(update); };
    const refresh = () => {
      // A frame queued before backgrounding may never run on iOS.
      cancelAnimationFrame(frame);
      frame = 0;
      if (!document.hidden) update();
    };
    const composerBlur = (event: FocusEvent) => {
      if (event.target instanceof Element && event.target.closest('.composer')) refresh();
    };
    viewport.addEventListener('resize', schedule);
    viewport.addEventListener('scroll', schedule);
    document.addEventListener('visibilitychange', refresh);
    window.addEventListener('pageshow', refresh);
    window.addEventListener('resize', refresh);
    chat.addEventListener('focusout', composerBlur);
    schedule();
    return () => {
      viewport.removeEventListener('resize', schedule);
      viewport.removeEventListener('scroll', schedule);
      document.removeEventListener('visibilitychange', refresh);
      window.removeEventListener('pageshow', refresh);
      window.removeEventListener('resize', refresh);
      chat.removeEventListener('focusout', composerBlur);
      cancelAnimationFrame(frame);
    };
  }, []);
  // A preceding page changes height after React commits it. Keep the old height until the layout effect so the visible row stays put.
  const earlierScrollHeight = useRef<number | null>(null);
  const rowsRef = useRef<ChatRow[]>([]);
  // Older test fixtures predate ChatPage. The live API always sends a page; accepting a row array keeps those fixtures focused on their behaviour.
  const page = (value: ChatPage | ChatRow[]): ChatPage => Array.isArray(value) ? { rows: value, has_more: false, oldest_id: value[0]?.id ?? null } : value;
  const replaceRows = (next: ChatRow[]) => { rowsRef.current = next; setRows(next); };
  const currentOpenQuestionIds = () => rowsRef.current.filter(isPending).map((question) => question.id);
  const recordDraftQuestionIds = () => p.onDraftQuestionIds?.([...(p.attachmentQuestionIds ?? currentOpenQuestionIds())]);
  const mergeRows = (incoming: ChatRow[], dropCarriedBefore?: number | null) => {
    const incomingIds = new Set(incoming.map((row) => row.id));
    // Open questions and queued rows are carried outside the cursor window. If one is absent from a newer latest page,
    // the daemon has resolved it or flushed it, so retaining its old flags would keep stale UI pinned indefinitely.
    const current = dropCarriedBefore === undefined || dropCarriedBefore === null ? rowsRef.current : rowsRef.current.filter((row) =>
      !(row.id < dropCarriedBefore && !incomingIds.has(row.id) && (isPending(row) || row.queued_at !== null)),
    );
    const byId = new Map(current.map((row) => [row.id, row]));
    for (const row of incoming) byId.set(row.id, row);
    replaceRows([...byId.values()].sort((a, b) => a.id - b.id));
  };
  const applyLatest = (value: ChatPage | ChatRow[]) => {
    const next = page(value);
    const unseen = p.readThrough?.current === null || p.readThrough === undefined ? [] : next.rows.filter((row) => row.id > p.readThrough!.current! && row.role !== 'user' && !isPending(row)).map((row) => row.id);
    if (p.readThrough?.current === null) p.readThrough.current = Math.max(0, ...next.rows.map((row) => row.id));
    loadedOnce.current = true;
    scrollToBottom.current = true;
    setUnreadIds(unseen);
    setJumpUnreadIds([]);
    setPinned(true);
    replaceRows(next.rows); setHasMore(next.has_more); setOldestId(next.oldest_id); setError(null);
  };
  const load = () => getChatPage()
    .then((value) => { applyLatest(value); return true; })
    .catch((e: Error) => {
      setError(isUnreachable(e) ? (loadedOnce.current ? OUTAGE_LOAD : OUTAGE_LOAD_NONE) : `Could not load the thread: ${e.message}`);
      return false;
    });
  useEffect(() => { if (p.version === 0) void load(); }, [p.version]);
  useLayoutEffect(() => {
    const height = earlierScrollHeight.current;
    if (height === null) return;
    earlierScrollHeight.current = null;
    const thread = threadRef.current;
    if (thread) thread.scrollTop += thread.scrollHeight - height;
  }, [rows]);
  useEffect(() => { if (scrollToBottom.current && rows?.length) toBottom(); }, [rows]);
  const loadEarlier = async () => {
    if (oldestId === null || loadingEarlier) return;
    setLoadingEarlier(true);
    try {
      const next = page(await getChatPage({ before: oldestId }));
      scrollToBottom.current = false;
      // Measured only once the page is here, right before it is merged: a failed load or a socket append must not shift scrollTop.
      earlierScrollHeight.current = threadRef.current?.scrollHeight ?? 0;
      mergeRows(next.rows); // by id: the latest page may already carry an older reply_to row this page repeats
      setHasMore(next.has_more);
      setOldestId(next.oldest_id);
      setError(null);
    } catch (e) { earlierScrollHeight.current = null; setError(`Could not load the thread: ${(e as Error).message}`); } finally { setLoadingEarlier(false); }
  };
  // Every update fetches the latest page and merges it by id: pending and queued rows live there, so their answered_at,
  // superseded_at and queued_at changes are picked up. A carried row that is now absent is dropped; otherwise it would
  // retain stale pending or queued state below the cursor. Earlier ordinary rows stay (has_more and oldest_id only change
  // when Show earlier messages loads a page).
  const refresh = () => getChatPage()
    .then((response) => {
      const next = page(response);
      const lastId = highestId();
      const arrived = !scrollToBottom.current ? next.rows.filter((row) => row.id > lastId && row.role !== 'user' && !isPending(row)).map((row) => row.id) : [];
      mergeRows(next.rows, next.oldest_id); setError(null);
      setUnreadIds((ids) => [...new Set([...ids, ...arrived])].filter((id) => rowsRef.current.some((row) => row.id === id)));
      setJumpUnreadIds((ids) => [...new Set([...ids, ...arrived])].filter((id) => rowsRef.current.some((row) => row.id === id)));
      return true;
    })
    .catch((e: Error) => {
      setError(isUnreachable(e) ? OUTAGE_LOAD : `Could not load the thread: ${e.message}`);
      return false;
    });
  useEffect(() => {
    if (p.version === 0) return;
    if (!rowsRef.current.length) { void load(); return; }
    const thread = threadRef.current;
    scrollToBottom.current = !thread || atBottom(thread);
    setPinned(scrollToBottom.current);
    void refresh();
    // WebSocket versions are monotonic. The initial render is deliberately a latest-page load above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.version]);
  // The textarea is disabled while a message is in flight; focus goes back to it once it is enabled again, not to <body>,
  // unless the user has moved on to another control meanwhile.
  useEffect(() => {
    if (!sending && refocus.current) {
      refocus.current = false;
      if (document.activeElement === document.body || document.activeElement === input.current) input.current?.focus();
    }
  }, [sending]);
  const attachmentState = attachmentOps(p.attachments, sending, () => {
    const ids = p.draftQuestionIds ?? p.attachmentQuestionIds ?? currentOpenQuestionIds();
    p.onDraftQuestionIds?.([...ids]);
    p.onAttachmentQuestionIds?.([...ids]);
  });
  const { attachments, clear: clearAttachments, setHint: setAttachHint, dropProps, pasteProps, toBody } = attachmentState;

  const send = async () => {
    const t = text.trim();
    if ((!t && !attachments.length) || sendingRef.current) return;
    if (p.offline) { setError(OUTAGE_SEND); return; }
    if (noRepos) return; // Send is disabled and the composer says why; Enter must not slip past it
    if (needsChoice) { setError(PICK_REPO); select.current?.focus(); return; }
    sendingRef.current = true; setError(null); setAttachHint(null); setSending(true); refocus.current = true;
    // The revision the draft had when the send started: if anything was typed before the POST resolves, even back to the same
    // text, the revision has moved on and the completion leaves the new draft alone.
    const sentRev = p.draftRev;
    try {
      const outgoing = await toBody();
      const body: ChatSendRequest = { text: t, ...(repo ? { repo } : {}), ...(outgoing.length ? { attachments: outgoing } : {}), open_question_ids: p.draftQuestionIds ?? p.attachmentQuestionIds ?? [] };
      await api.post('/chat', body);
      setUnreadIds([]);
      setJumpUnreadIds([]);
      p.onClearText(repo, sentRev);
      clearAttachments(attachments);
      p.onAttachmentQuestionIds?.(null);
      const loaded = rowsRef.current.length ? refresh() : load();
      void loaded.then((succeeded) => {
        if (succeeded && p.readThrough) p.readThrough.current = highestId();
      });
    } catch (e) { setError(isUnreachable(e) ? OUTAGE_SEND : (e as Error).message); } finally { sendingRef.current = false; setSending(false); }
  };
  // Retry on a row reporting an undelivered message: the ref turns a double click into one request, the button is disabled
  // while it is in flight, and an accepted retry hides it until the refetched row carries `retried_at`.
  const retryingRef = useRef(new Set<number>());
  const [retrying, setRetrying] = useState<ReadonlySet<number>>(() => new Set());
  const [retried, setRetried] = useState<ReadonlySet<number>>(() => new Set());
  const retry = async (id: number) => {
    if (retryingRef.current.has(id)) return;
    retryingRef.current.add(id); setRetrying(new Set(retryingRef.current));
    try {
      await api.post(`/chat/${id}/retry`);
      setRetried((ids) => new Set(ids).add(id));
      void refresh();
    } catch (e) { setError(`Could not retry: ${(e as Error).message}`); } finally {
      retryingRef.current.delete(id); setRetrying(new Set(retryingRef.current));
    }
  };
  // The answered question unmounts with its textarea; the composer is where the conversation continues.
  const answered = () => {
    if (rowsRef.current.length) void refresh(); else void load();
    input.current?.focus();
  };

  const all = rows ?? [];
  const firstSeenUserId = all.find((row) => row.role === 'user' && row.seen_at !== null)?.id;
  const pending = all.filter(isPending);
  useEffect(() => {
    const hasDraft = text.length > 0 || p.attachments.attachments.length > 0;
    if (p.attachments.attachments.length === 0 && p.attachmentQuestionIds != null) p.onAttachmentQuestionIds?.(null);
    if (!hasDraft) {
      if (p.draftQuestionIds != null) p.onDraftQuestionIds?.(null);
    } else if (p.draftQuestionIds == null && rows !== null) p.onDraftQuestionIds?.([...(p.attachmentQuestionIds ?? rowsRef.current.filter(isPending).map((question) => question.id))]);
  }, [text, p.attachments.attachments.length, p.draftQuestionIds, p.onDraftQuestionIds, p.attachmentQuestionIds, p.onAttachmentQuestionIds, rows]);
  useEffect(() => {
    const request = p.questionRequest;
    if (!request || handledQuestionRequest.current === request.sequence || (rows === null && error === null)) return;
    handledQuestionRequest.current = request.sequence;
    const index = pending.findIndex((question) => question.id === request.id);
    if (index >= 0) {
      setSelectedQuestion({ id: request.id, index });
      setFocusQuestionRequest(request.sequence);
    }
    p.onQuestionRequestHandled?.(request.sequence);
  }, [p.questionRequest, p.onQuestionRequestHandled, rows, error]);
  useLayoutEffect(() => {
    if (focusQuestionRequest === null || focusQuestionRequest === focusedQuestionRequest.current || selectedQuestion === null) return;
    focusedQuestionRequest.current = focusQuestionRequest;
    questionAnswers.current.get(selectedQuestion.id)?.focus();
  }, [focusQuestionRequest, selectedQuestion?.id]);
  // A selection is only meaningful while its question is open. Once the list empties, a stale {id, index} would reopen the
  // pager on that old position when the next questions arrive (3 of 3, all answered, three new → 3 of 3 again instead of 1 of 3).
  useEffect(() => {
    if (pending.length === 0) setSelectedQuestion(null);
  }, [pending.length]);
  const selectedIndex = selectedQuestion === null ? -1 : pending.findIndex((q) => q.id === selectedQuestion.id);
  const activeIndex = selectedIndex >= 0 ? selectedIndex : Math.min(selectedQuestion?.index ?? 0, pending.length - 1);
  const thread = orderThread(all.filter((r) => !isPending(r)));
  const items = groupThread(thread);
  const quotes = repliesTo(thread); // once per render, not once per row (fix round 16 review)
  const batchesByMessage = new Map<number, BatchSummary[]>();
  for (const batch of p.board?.repos.flatMap((r) => r.batches) ?? []) {
    for (const id of new Set(batch.linked_chat_ids ?? (batch.origin_chat_id == null ? [] : [batch.origin_chat_id]))) {
      const list = batchesByMessage.get(id) ?? [];
      list.push(batch);
      batchesByMessage.set(id, list);
    }
  }
  // Whether a question is still wanted is the daemon's to say, not the thread's to guess: a pinned question is one the daemon has
  // neither answered nor superseded, and it carries no caveat. Round 18 marked a question older than the newest orchestrator
  // message; the orchestrator writes "waiting on your answer" right after asking and wakes on every landed bead, so the mark
  // landed on live questions and told the user to dismiss what the orchestrator was blocked on (round 19).
  return (
    <div className="chat" ref={chatRef}>
      {/* The scroll container is a Tab stop in Chrome; named, so it does not read as an anonymous group between the rail and the composer. */}
      <div className="thread" ref={threadRef} role="log" aria-label="Conversation" onScroll={(event) => {
        const bottomNow = atBottom(event.currentTarget);
        scrollToBottom.current = bottomNow;
        setPinned(bottomNow);
        if (bottomNow) setJumpUnreadIds([]);
        markRead();
      }}>
        {hasMore && <button className="link" onClick={() => void loadEarlier()} disabled={loadingEarlier}>{loadingEarlier ? 'Loading earlier messages…' : 'Show earlier messages'}</button>}
        {/* A first load that failed is not still loading: it has an error line to show, and shimmering a fabricated thread for the
            whole outage would be worse than the blank this replaced. */}
        <Loading loading={rows === null && error === null} label="Loading the conversation…" placeholder={<ThreadPlaceholder />}>
        {rows !== null && rows.length === 0 && !noRepos && (p.reposLoaded ?? true) && <p className="muted">Pick a repository and describe what you want done. Each request becomes a batch with its own branch.</p>}
        {items.map(({ row: r, day, groupStart }) => {
          const quote = quotes.get(r.id) ?? null;
          const status = r.role !== 'user' ? null : r.replied_at ? 'Answered' : r.seen_at ? 'Seen' : r.queued_at || (firstSeenUserId !== undefined && r.id > firstSeenUserId) ? 'Waiting' : null;
          // The time is shown on the first row of a group, or on hover/focus (desktop only) for the rows a group continues.
          const time = <time className={`msg-time${groupStart ? '' : ' msg-time-hover'}`} dateTime={r.ts}>{formatTime(r.ts)}</time>;
          const stamp = status ? <span className="msg-stamp">{time}<span className="msg-status">{status}</span></span> : time;
          return (
          <Fragment key={r.id}>
          {day !== null && <div className="chat-day">{day}</div>}
          {r.id === unreadIds[0] && <div className="chat-unread-divider">Unread</div>}
          <div className={`msg msg-${r.role}${groupStart ? ' msg-group-start' : ''}`}>
            {/* A notice written while no orchestrator session was live waits for the next turn; the label says so rather than implying it was delivered.
                Only the first row of a group carries the role label, so a burst of replies reads as one turn rather than a wall of headers. */}
            {groupStart
              ? <div className="msg-role">{r.role === 'system' ? 'Overseer' : r.role === 'user' ? 'You' : 'Orchestrator'}{r.queued_at && <span className="muted"> · queued for the orchestrator's next turn</span>}{stamp}</div>
              : status ? null : time}
            {quote !== null && <div className="muted">{`↳ to your earlier message “${quote}”`}</div>}
            {/* Orchestrator replies and notices are markdown-ish; shown as plain text, markers stripped, like History on the Board. */}
            {r.role === 'user' ? <UserText text={r.text} stamp={!groupStart && status ? <span className="msg-continuation-stamp">{stamp}</span> : undefined} /> : <div className="pre"><PlainText text={r.text} /></div>}
            {r.role === 'user' && batchesByMessage.has(r.id) && <div className="chat-outcomes">{batchesByMessage.get(r.id)!.map((batch) => <button key={batch.id} type="button" className={`chip chat-outcome ${batch.status}`} onClick={() => p.onOpenBatch?.(batch)} title={batch.title} aria-label={`${batch.title}: ${batchStatusLabel(batch.status, batch.waiting_on)}`}><span className="chat-outcome-title">{batch.title}</span><span>{batchStatusLabel(batch.status, batch.waiting_on)}</span></button>)}</div>}
            {/* Any row can carry images: user messages and the rejection notices Overseer writes with role 'system'. */}
            {r.attachments?.length ? <div className="msg-attachments">{r.attachments.map((a, i) => {
              const src = `/api/chat/${r.id}/attachments/${i}`;
              return <a key={`${a.name}-${i}`} href={src} target="_blank" rel="noopener"><img src={src} alt={a.name} loading="lazy" /></a>;
            })}</div> : null}
            {r.role === 'system' && typeof r.failed_for === 'number' && !r.retried_at && !retried.has(r.id) && <div className="chat-retry"><button type="button" onClick={() => void retry(r.id)} disabled={retrying.has(r.id)}>{retrying.has(r.id) ? 'Retrying…' : 'Retry'}</button></div>}
            {r.kind === 'question' && r.answer && <div className="msg-answer">↳ {r.answer}</div>}
            {r.kind === 'question' && r.superseded_at && <div className="muted">No longer waiting for an answer. Reply in the composer if it still matters.</div>}
          </div>
          </Fragment>
          );
        })}
        </Loading>
      </div>
      {pending.length > 0 && <div className="pinned">
        {pending.length > 1 && <div className="question-pager" aria-label="Open questions">
          <button className="link" disabled={activeIndex === 0} onClick={() => setSelectedQuestion({ id: pending[activeIndex - 1]!.id, index: activeIndex - 1 })}>Previous</button>
          <span>Question {activeIndex + 1} of {pending.length}</span>
          <button className="link" disabled={activeIndex === pending.length - 1} onClick={() => setSelectedQuestion({ id: pending[activeIndex + 1]!.id, index: activeIndex + 1 })}>Next</button>
        </div>}
        {pending.map((q, index) => <div key={q.id} className={index === activeIndex ? 'question-page-active' : 'question-page-inactive'}><Question q={q} onAnswered={answered} answerRef={(element) => {
          if (element) questionAnswers.current.set(q.id, element);
          else questionAnswers.current.delete(q.id);
        }} /></div>)}
      </div>}
      {!pinned && jumpUnreadIds.length > 0 && <button className="chat-jump" onClick={() => { scrollToBottom.current = true; setPinned(true); toBottom(); }}>Jump to latest · {jumpUnreadIds.length > 99 ? '99+' : jumpUnreadIds.length} new</button>}
      {suggestionsOpen && <div ref={suggestionList} id="chat-command-list" className="chat-command-list" role="listbox" aria-label="Chat command suggestions">
        {commandMatches.map((command, index) => (
          <button key={`${command.source}:${command.name}`} id={`chat-command-option-${index}`} type="button" role="option" aria-selected={index === activeSuggestion}
            aria-label={`/${command.name}, ${command.description}, ${command.source}`} tabIndex={-1} data-suggestion-index={index}
            className="chat-command-option" onMouseDown={(event) => event.preventDefault()} onMouseEnter={() => setActiveSuggestion(index)}
            onClick={() => insertCommand(command)}>
            <span className="chat-command-name">/{highlightMatch(command.name, slashToken?.query ?? '')}</span>
            <span className="chat-command-description">{highlightMatch(command.description, slashToken?.query ?? '')}</span>
            <span className="chat-command-source">{command.source}</span>
          </button>
        ))}
      </div>}
      <div className="composer" {...dropProps}>
        {/* One card: the text on top, the target and Send in a toolbar row underneath. The hint line only appears when it carries an
            instruction; otherwise the labelled select is the cue for where the message goes (round 12 wanted words, not a bare select). */}
        {(noRepos || needsChoice) && <div className="composer-target muted">
          {noRepos ? <>Register a repository in Setup first; the orchestrator has nothing to work on yet. {p.onSetup && <button className="link" onClick={p.onSetup}>Open Setup</button>}</>
            : <>Pick the repository this message is for{repo && <> (last used: <span className="chip repo-tag">{repo}</span>)</>}.</>}
        </div>}
        <AttachmentPreviews state={attachmentState} disabled={sending} />
        <textarea ref={input} value={text} placeholder="Message the orchestrator" aria-label="Message the orchestrator" disabled={sending} rows={Math.min(8, Math.max(2, text.split('\n').length))}
          aria-expanded={suggestionsOpen} aria-controls={suggestionsOpen ? 'chat-command-list' : undefined}
          aria-activedescendant={suggestionsOpen && selectedSuggestion ? `chat-command-option-${activeSuggestion}` : undefined}
          onChange={(event) => {
            const next = event.target.value;
            if (!text && next && p.draftQuestionIds == null) recordDraftQuestionIds();
            else if (text && !next && attachments.length === 0) p.onDraftQuestionIds?.(null);
            setText(next); setDismissedSuggestion(null); readSlashToken(event.currentTarget);
          }} onClick={(event) => readSlashToken(event.currentTarget)}
          onKeyUp={(event) => readSlashToken(event.currentTarget)} onSelect={(event) => readSlashToken(event.currentTarget)}
          onFocus={(event) => readSlashToken(event.currentTarget)} onBlur={() => setSlashToken(null)} {...pasteProps}
          onKeyDown={composerKeyDown} />
        <div className="composer-bar">
          {attachmentState.hint ? <span className="muted composer-hint composer-hint-error" role="alert">{attachmentState.hint}</span> : <span className="muted composer-hint composer-key-hint">Enter to send · Shift+Enter for a new line</span>}
          <AttachmentButton state={attachmentState} disabled={sending} />
          {!noRepos && <label className="composer-to muted">To
            <select ref={select} aria-label="Repo" value={needsChoice ? '?' : repo} onChange={(e) => choose(e.target.value)}>
              {needsChoice && <option value="?" disabled>Pick a repository…</option>}
              <option value="">all repos</option>
              {repos.map((r) => <option key={r.id} value={r.id}>{r.id}</option>)}
            </select>
          </label>}
          {/* A blank (or whitespace-only) message sends nothing, so Send says so by being disabled instead of looking broken when it is pressed (round 18). */}
          <button className="primary" disabled={sending || !!p.offline || noRepos || (!text.trim() && attachments.length === 0)} onClick={() => void send()}>{sending ? 'Sending…' : 'Send'}</button>
        </div>
        {error && <div className="badge-warn" role="alert">{error}</div>}
      </div>
    </div>
  );
}
