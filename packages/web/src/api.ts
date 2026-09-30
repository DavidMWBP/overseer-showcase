import { useEffect, useRef } from 'react';
import type { AccountUsage, CardState, ChatPage, WsMessage } from '@overseer/shared';

export class ApiError extends Error {
  constructor(readonly status: number, message: string, readonly body: unknown) { super(message); }
}

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/**
 * The daemon cannot be reached: the request itself failed (network error, an unparsable proxy page), a gateway answer
 * (502-504), or the dev proxy's bare 500 while the daemon boots. A daemon that answered, even with a 500, carries `{ error }`.
 */
export function isUnreachable(e: unknown): boolean {
  if (!(e instanceof ApiError)) return true;
  return (e.status >= 502 && e.status <= 504) || (e.status === 500 && e.body === null);
}

async function request<T>(method: Method, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, { method, headers: body === undefined ? {} : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new ApiError(res.status, (data as { error?: string } | null)?.error ?? `${method} ${path} failed with ${res.status}`, data);
  return data as T;
}

// Identical GETs in flight at the same time share one request: the dev proxy serialises upstream calls, so a doubled
// /board fetch (StrictMode, a socket burst) would otherwise take twice as long. `fresh` opts out: a fetch that follows a
// change notice must not be served the response of a request that was sent before the change.
const inflightGets = new Map<string, Promise<unknown>>();
function dedupedGet<T>(path: string, fresh = false): Promise<T> {
  const current = inflightGets.get(path);
  if (current && !fresh) return current as Promise<T>;
  const p = request<T>('GET', path).finally(() => { if (inflightGets.get(path) === p) inflightGets.delete(path); });
  inflightGets.set(path, p);
  return p;
}
/** Tests: a GET one test leaves unsettled must not be handed to the next. */
export function resetInflight(): void { inflightGets.clear(); }

export const api = {
  get: <T>(path: string, opts?: { fresh?: boolean }) => dedupedGet<T>(path, opts?.fresh),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body),
  put: <T>(path: string, body: unknown) => request<T>('PUT', path, body),
  patch: <T>(path: string, body: unknown) => request<T>('PATCH', path, body),
  delete: <T>(path: string) => request<T>('DELETE', path),
};

/** Chat pagination keeps its preceding-page cursor in the URL. */
export function getChatPage(query: { before?: number } = {}): Promise<ChatPage> {
  const params = new URLSearchParams({ limit: '100' });
  if (query.before !== undefined) params.set('before', String(query.before));
  return api.get<ChatPage>(`/chat?${params}`);
}

/** The daemon caches the upstream answer for 180 s and dedupes in-flight calls, so a shorter client poll only costs a local request and picks up a refreshed value within about a minute of the cache expiring. */
export const USAGE_POLL_MS = 60_000;
/** `null` for an account the daemon has no usage for (not Claude OAuth). `fresh`: a poll must never be served an older in-flight answer. */
export const fetchAccountUsage = (id: string) => api.get<AccountUsage | null>(`/accounts/${id}/usage`, { fresh: true });

/** 'lost' when the event socket closes, 'restored' when it opens again (never for the first open). */
export type Connection = 'lost' | 'restored';

export function useWs(onMessage: (m: WsMessage) => void, onConnection?: (c: Connection) => void): void {
  const handler = useRef(onMessage);
  handler.current = onMessage;
  const connection = useRef(onConnection);
  connection.current = onConnection;
  useEffect(() => {
    let socket: WebSocket | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;
    let reconnecting = false;
    let attempt = 0; // reconnects back off like the health poll (1, 2, 4, then every 5 s) instead of once a second forever
    const connect = () => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      socket = new WebSocket(`${proto}://${location.host}/api/events`);
      socket.onopen = () => {
        attempt = 0;
        // The daemon emits board/status changes (e.g. recover()) before any client can reconnect, so refresh everything.
        if (!reconnecting) return;
        reconnecting = false;
        for (const type of ['status', 'board', 'chat', 'repos'] as const) handler.current({ type });
        connection.current?.('restored');
      };
      socket.onmessage = (e) => { try { handler.current(JSON.parse(String(e.data)) as WsMessage); } catch { /* ignore malformed */ } };
      socket.onclose = () => { if (!stopped) { reconnecting = true; timer = setTimeout(connect, Math.min(5000, 1000 * 2 ** attempt++)); connection.current?.('lost'); } };
    };
    connect();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      const s = socket;
      // Closing a socket that is still connecting (StrictMode's first mount) makes the browser log an error; let it open, then close it.
      if (s?.readyState === 0) s.onopen = () => s.close(); else s?.close();
    };
  }, []);
}

export function fmtElapsed(ms: number | null): string {
  if (ms === null) return '';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

export function fmtCost(c: number | null): string { return c === null ? '' : `$${c.toFixed(2)}`; }
/**
 * A total with sessions that ended without reporting a cost (a worker stopped or crashed mid-turn never sends the harness's final
 * event, the only one that carries one): shown as a floor with the gap named in the tooltip, not as a clean number (round 14).
 */
export function fmtCostTotal(total: number, unknown: number): { text: string; title?: string } {
  if (!unknown) return { text: fmtCost(total) };
  const title = `At least: ${unknown === 1 ? '1 worker session' : `${unknown} worker sessions`} ended without a reported cost (stopped or crashed mid-turn, or a harness that reports none).`;
  // "≥ $0.00" is true and says nothing (round 15): with no known part the total is simply unknown.
  return { text: total > 0 ? `≥ ${fmtCost(total)}` : 'cost unknown', title };
}
/** A card whose worker has ended without a reported cost: said, so the card does not read as a free run. */
export const COST_UNKNOWN_TITLE = 'The worker ended without reporting a cost (stopped or crashed mid-turn, or a harness that reports none).';

/** What the daemon records as the verify output when no command is configured: nothing ran, and the pane must not print it under the heading. */
export const NO_VERIFY_RUN = '(no verify command configured)';
/** What a passed status means for the reader: when nothing ran, "pass" would claim a check. `ran` comes from the bead's own verify output where there is one. */
export const verifyPassLabel = (ran: boolean) => (ran ? 'pass' : 'not run (no verify command configured)');
/**
 * The recorded verify output is the run before this one's while a worker or a verification is going: the Board pane and the v1
 * Review pane head it "Previous verification" on exactly this, so the two cannot drift (fix round 23 review NB-1, NB-3).
 */
export const verifyIsPrevious = (state: CardState | undefined) => state === 'running' || state === 'settling' || state === 'verifying';
