import { afterEach, describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { openDb } from '../db/db';
import { Bus } from '../bus';
import { FakeAdapter } from '../harness/fake';
import { SessionManager } from '../sessions/manager';
import { loadConfig } from '../config';
import { until } from '../test/until';
import type { OrchestratorActivity } from '@overseer/shared';
import { activitySummary, localZone, Orchestrator, pushBody, RetryError } from './orchestrator';
import { parseClaudeLine } from '../harness/claude';
import type { SessionHandle, StartOpts } from '../harness/types';
import { log } from '../util/log';
import { accountUsable } from '../accounts/usage';
import type { Push, PushMessage } from '../push/push';
import os from 'node:os';

const testDataDirs: string[] = [];
let nextTestPort = 45_000;

function setup(opts: { usageGate?: typeof accountUsable; claude?: FakeAdapter; persistent?: boolean } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'overseer-orchestrator-test-'));
  testDataDirs.push(dataDir);
  const dbFile = path.join(dataDir, 'overseer.db');
  const db = openDb(opts.persistent ? dbFile : ':memory:');
  const bus = new Bus();
  const fake = opts.claude ?? new FakeAdapter();
  const sessions = new SessionManager(db, { claude: fake }, bus, path.join(dataDir, 'sessions'));
  const config = { ...loadConfig({ OVERSEER_DATA_DIR: dataDir }), port: nextTestPort++, orchestratorDir: path.join(dataDir, 'orch') };
  const push = { notify: vi.fn(async (_m: PushMessage) => {}) };
  const usageGate = opts.usageGate ?? (async () => ({ usable: true as const }));
  const notes: [string, string][] = [];
  const noteBead = async (beadId: string, text: string) => { notes.push([beadId, text]); };
  const orch = new Orchestrator({ db, sessions, bus, config, push: push as unknown as Push, usageGate, noteBead });
  return { db, dbFile, bus, fake, sessions, config, orch, push, notes };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

afterEach(() => {
  for (const dir of testDataDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** A claude-like adapter that chooses a native session id at spawn, as Claude's `--session-id` does before any turn ends. */
class SpawnIdAdapter extends FakeAdapter {
  override start(o: StartOpts): SessionHandle {
    return { ...super.start(o), nativeId: 'spawn-native' };
  }
}

/** The account and orchestrator setting the token-rollover tests run on. */
function addOauthAccount(x: ReturnType<typeof setup>, overrides: { secret?: string; refresh_token?: string | null; token_expires_at?: number } = {}): void {
  x.db.accounts.insert({ id: 'a1', name: 'Primary', harness: 'claude', kind: 'oauth_token', secret: overrides.secret ?? 'access', refresh_token: overrides.refresh_token === undefined ? 'refresh-1' : overrides.refresh_token, token_expires_at: overrides.token_expires_at ?? Date.now() + 3 * 60 * 60_000, home: null, created_at: 't0', last_login_at: 't0', last_verified_at: null });
}
function useOauthAccount(x: ReturnType<typeof setup>): void {
  x.db.settings.set('orchestrator', { model: null, effort: null, promptOverride: null, account: 'a1' });
}

// The three recorded turns of overseer-a8uq's fixture: the expired and revoked 401 samples, then a recorded invalid-token run.
const AUTH_LINES = fs.readFileSync(new URL('../harness/fixtures/claude-auth-401.jsonl', import.meta.url), 'utf8').split('\n').filter(Boolean);
const AUTH_SESSION_ID = '7ca5b85d-2db9-4ac2-bba6-a2a3b7b50524';
const EXPIRED_TURN = AUTH_LINES.slice(0, 3);
const REVOKED_TURN = AUTH_LINES.slice(3, 6);
/** Emits one fixture turn's parsed events (auth_failed, then the result's error and 401 turn_end) on a fake session. */
function emitAuthTurn(x: ReturnType<typeof setup>, h: SessionHandle, turn: string[]): void {
  for (const event of turn.flatMap(parseClaudeLine)) x.fake.emit(h, event);
}

describe('Orchestrator', () => {
  it('attributes only the current user delivery to its session, not a notice or another caller', async () => {
    const x = setup();
    await x.orch.sendUser('first request');
    const session = x.db.sessions.latest('orchestrator')!.id;
    const user = x.db.chat.all().find((r) => r.role === 'user')!.id;
    expect(x.orch.originChatId(session)).toBe(user);
    expect(x.orch.originChatId('another-session')).toBeNull();
    expect(x.orch.originChatId(undefined)).toBeNull();
    x.bus.emit('event', { id: 1, session_id: session, type: 'turn_end', payload: {}, seq: 1, ts: new Date().toISOString() });
    await x.orch.systemMessage('review needed', { wake: true });
    expect(x.orch.originChatId(session)).toBeNull();
  });
  it('attaches the latest delivered user message, so a follow-up mid-turn outranks the one that started it', async () => {
    const x = setup();
    await x.orch.sendUser('first request');
    await x.orch.sendUser('follow-up while it runs');
    const session = x.db.sessions.latest('orchestrator')!.id;
    const users = x.db.chat.all().filter((r) => r.role === 'user');
    expect(x.orch.originChatId(session)).toBe(users[1]!.id);
    // Each turn's end closes the window: once no message is pending, a later turn attaches none.
    x.bus.emit('event', { id: 1, session_id: session, type: 'turn_end', payload: {}, seq: 1, ts: new Date().toISOString() });
    expect(x.orch.originChatId(session)).toBe(users[1]!.id); // the follow-up's own turn is still pending
    x.bus.emit('event', { id: 2, session_id: session, type: 'turn_end', payload: {}, seq: 2, ts: new Date().toISOString() });
    expect(x.orch.originChatId(session)).toBeNull();
  });
  it('uses a usable configured OAuth account without a fallback notice', async () => {
    const usageGate = vi.fn<typeof accountUsable>(async () => ({ usable: true }));
    const x = setup({ usageGate });
    x.db.accounts.insert({ id: 'a1', name: 'Primary', harness: 'claude', kind: 'oauth_token', secret: 'token', home: null, created_at: 't0', last_login_at: 't0', last_verified_at: null });
    x.db.settings.set('orchestrator', { model: 'fable', effort: null, promptOverride: null, account: 'a1' });

    await x.orch.sendUser('start');

    expect(x.db.sessions.latest('orchestrator')?.account).toBe('a1');
    expect(usageGate).toHaveBeenCalledWith(x.db, x.config, 'a1', 'fable');
    expect(x.db.chat.all().some((row) => row.text.includes('session started on account'))).toBe(false);
  });

  it('falls back once to the first usable Claude OAuth account', async () => {
    const usageGate = vi.fn<typeof accountUsable>(async (_db, _config, accountId) => accountId === 'a1' ? { usable: false, reason: 'account Primary: model fable 95% >= 95%' } : { usable: true });
    const x = setup({ usageGate });
    for (const [id, name] of [['a1', 'Primary'], ['a2', 'Backup'], ['a3', 'Later']] as const) x.db.accounts.insert({ id, name, harness: 'claude', kind: 'oauth_token', secret: 'token', home: null, created_at: id, last_login_at: 't0', last_verified_at: null });
    x.db.accounts.update('a1', { label: 'Work' });
    x.db.settings.set('orchestrator', { model: 'fable', effort: null, promptOverride: null, account: 'a1' });

    await x.orch.sendUser('start');

    expect(x.db.sessions.latest('orchestrator')?.account).toBe('a2');
    expect(usageGate.mock.calls.map((call) => call[2])).toEqual(['a1', 'a2']);
    expect(x.db.chat.all().filter((row) => row.text.includes('session started on account'))).toHaveLength(1);
    expect(x.db.chat.all().at(-1)?.text).toBe('[Overseer] orchestrator session started on account Backup: Primary (Work) is model fable 95% >= 95%');
  });

  it('refuses a fresh session when no Claude OAuth account is usable', async () => {
    const usageGate = vi.fn<typeof accountUsable>(async (_db, _config, accountId) => ({ usable: false, reason: `account ${accountId}: exhausted until 2026-09-17T10:00:00.000Z` }));
    const x = setup({ usageGate });
    for (const [id, name] of [['a1', 'Primary'], ['a2', 'Backup']] as const) x.db.accounts.insert({ id, name, harness: 'claude', kind: 'oauth_token', secret: 'token', home: null, created_at: id, last_login_at: 't0', last_verified_at: null });
    x.db.settings.set('orchestrator', { model: 'fable', effort: null, promptOverride: null, account: 'a1' });

    await x.orch.sendUser('start');

    expect(x.db.sessions.latest('orchestrator')).toBeUndefined();
    expect(x.db.chat.all().at(-1)?.text).toContain('account a1: exhausted until');
    expect(x.db.chat.all().at(-1)?.text).toContain('account a2: exhausted until');
  });

  it('deduplicates unusable-account refusals for consecutive wake notices', async () => {
    const usageGate = vi.fn<typeof accountUsable>(async () => ({ usable: false, reason: 'account Primary: session 95% >= 95%' }));
    const x = setup({ usageGate });
    x.db.accounts.insert({ id: 'a1', name: 'Primary', harness: 'claude', kind: 'oauth_token', secret: 'token', home: null, created_at: 't0', last_login_at: 't0', last_verified_at: null });
    x.db.settings.set('orchestrator', { model: 'fable', effort: null, promptOverride: null, account: 'a1' });

    await x.orch.systemMessage('first stalled bead', { wake: true });
    await x.orch.systemMessage('second stalled bead', { wake: true });

    expect(x.db.chat.all().filter((row) => row.text.startsWith('Account Primary is not usable'))).toHaveLength(1);
    expect(x.db.chat.queued().map((row) => row.text)).toEqual(['first stalled bead', 'second stalled bead']);
  });

  it('keeps non-OAuth configured accounts on their existing path', async () => {
    const usageGate = vi.fn<typeof accountUsable>(async () => ({ usable: false, reason: 'should not run' }));
    const x = setup({ usageGate });
    x.db.accounts.insert({ id: 'a1', name: 'API key', harness: 'claude', kind: 'api_key', secret: 'key', home: null, created_at: 't0', last_login_at: null, last_verified_at: null });
    x.db.settings.set('orchestrator', { model: 'fable', effort: null, promptOverride: null, account: 'a1' });

    await x.orch.sendUser('start');

    expect(x.db.sessions.latest('orchestrator')?.account).toBe('a1');
    expect(x.db.sessions.latest('orchestrator')?.token_expires_at).toBeNull();
    expect(usageGate).not.toHaveBeenCalled();
  });

  it('records the OAuth token expiry its session starts with', async () => {
    const x = setup();
    const expiry = Date.now() + 3 * 60 * 60_000;
    x.db.accounts.insert({ id: 'a1', name: 'Primary', harness: 'claude', kind: 'oauth_token', secret: 'token', refresh_token: 'refresh-1', token_expires_at: expiry, home: null, created_at: 't0', last_login_at: 't0', last_verified_at: null });
    x.db.settings.set('orchestrator', { model: 'fable', effort: null, promptOverride: null, account: 'a1' });

    await x.orch.sendUser('start');

    expect(x.db.sessions.latest('orchestrator')).toMatchObject({ account: 'a1', token_expires_at: expiry });
  });

  it('records the refreshed token expiry when its start refreshed the token', async () => {
    const x = setup();
    x.db.accounts.insert({ id: 'a1', name: 'Primary', harness: 'claude', kind: 'oauth_token', secret: 'stale-access', refresh_token: 'refresh-1', token_expires_at: Date.now() - 1, home: null, created_at: 't0', last_login_at: 't0', last_verified_at: null });
    x.db.settings.set('orchestrator', { model: 'fable', effort: null, promptOverride: null, account: 'a1' });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ access_token: 'fresh-access', refresh_token: 'rotated', expires_in: 7200 }), { status: 200 }));

    try {
      const before = Date.now();
      await x.orch.sendUser('start');
      const after = Date.now();
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const recorded = x.db.sessions.latest('orchestrator')!.token_expires_at!;
      expect(recorded).toBeGreaterThanOrEqual(before + 7_200_000);
      expect(recorded).toBeLessThanOrEqual(after + 7_200_000);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('records the fallback account\'s token expiry when it starts on the fallback', async () => {
    const usageGate = vi.fn<typeof accountUsable>(async (_db, _config, accountId) => accountId === 'a1' ? { usable: false, reason: 'account Primary: model fable 95% >= 95%' } : { usable: true });
    const x = setup({ usageGate });
    const backupExpiry = Date.now() + 4 * 60 * 60_000;
    x.db.accounts.insert({ id: 'a1', name: 'Primary', harness: 'claude', kind: 'oauth_token', secret: 'token-a1', refresh_token: 'r-a1', token_expires_at: Date.now() + 3 * 60 * 60_000, home: null, created_at: 't0', last_login_at: 't0', last_verified_at: null });
    x.db.accounts.insert({ id: 'a2', name: 'Backup', harness: 'claude', kind: 'oauth_token', secret: 'token-a2', refresh_token: 'r-a2', token_expires_at: backupExpiry, home: null, created_at: 't1', last_login_at: 't0', last_verified_at: null });
    x.db.settings.set('orchestrator', { model: 'fable', effort: null, promptOverride: null, account: 'a1' });

    await x.orch.sendUser('start');

    expect(x.db.sessions.latest('orchestrator')).toMatchObject({ account: 'a2', token_expires_at: backupExpiry });
  });

  it('posts a notice and preserves queued notices when its account is not logged in', async () => {
    const x = setup();
    x.db.accounts.insert({ id: 'a1', name: 'Logged out Claude', harness: 'claude', kind: 'oauth_token', home: null, created_at: 't0', last_login_at: null, last_verified_at: null });
    x.db.settings.set('orchestrator', { model: null, effort: null, promptOverride: null, account: 'a1' });
    await x.orch.systemMessage('Earlier queued notice');
    await x.orch.sendUser('start work');
    expect(x.db.sessions.latest('orchestrator')).toBeUndefined();
    expect(x.db.chat.queued().map((row) => row.text)).toContain('Earlier queued notice');
    expect(x.db.chat.all().at(-1)).toMatchObject({ role: 'system', text: 'Account Logged out Claude is not logged in, so the orchestrator was not started. Log in the account from Setup and try again.' });
  });

  it('explains every refused user message and answer without superseding open questions', async () => {
    const x = setup();
    x.db.accounts.insert({ id: 'a1', name: 'Logged out Claude', harness: 'claude', kind: 'oauth_token', home: null, created_at: 't0', last_login_at: null, last_verified_at: null });
    x.db.settings.set('orchestrator', { model: null, effort: null, promptOverride: null, account: 'a1' });
    const q1 = x.db.chat.insert({ role: 'assistant', kind: 'question', text: 'Which DB?' });
    const q2 = x.db.chat.insert({ role: 'assistant', kind: 'question', text: 'Which port?' });

    await x.orch.sendUser('use sqlite');
    await x.orch.sendUser('still there?');
    expect(x.db.chat.pendingQuestions().map((row) => row.id)).toEqual([q1.id, q2.id]);

    await x.orch.answer(q1.id, 'sqlite');
    const explanations = x.db.chat.all().filter((row) => row.text.startsWith('Account Logged out Claude is not logged in'));
    expect(explanations).toHaveLength(3);
    expect(x.db.chat.get(q1.id)?.answer).toBeNull();
    expect(x.db.chat.pendingQuestions().map((row) => row.id)).toEqual([q1.id, q2.id]);
    expect(x.db.sessions.latest('orchestrator')).toBeUndefined();

    x.db.accounts.update('a1', { secret: 'sk-ant-token' });
    await x.orch.answer(q1.id, 'sqlite');
    expect(x.db.chat.get(q1.id)?.answer).toBe('sqlite');
    expect(x.db.chat.pendingQuestions().map((row) => row.id)).toEqual([q2.id]);
  });

  it('clears only a refused send cutoff and closes the selected question on a delivered send', async () => {
    const gates = [deferred<Awaited<ReturnType<typeof accountUsable>>>(), deferred<Awaited<ReturnType<typeof accountUsable>>>()];
    let gateIndex = 0;
    const usageGate = vi.fn<typeof accountUsable>(() => gates[gateIndex++]!.promise);
    const x = setup({ usageGate });
    addOauthAccount(x);
    useOauthAccount(x);
    const refusedQuestion = x.db.chat.insert({ role: 'assistant', kind: 'question', text: 'Question for the refused send' });
    const deliveredQuestion = x.db.chat.insert({ role: 'assistant', kind: 'question', text: 'Question for the delivered send' });

    const refused = x.orch.sendUser('refused message', [], [refusedQuestion.id]);
    await until(() => usageGate.mock.calls.length === 1);
    gates[0]!.resolve({ usable: false, reason: 'account Primary: session 95% >= 95%' });
    await refused;
    expect(x.db.chat.pendingQuestions().map((row) => row.id)).toEqual([refusedQuestion.id, deliveredQuestion.id]);
    expect(x.db.chat.all().at(-1)?.text).toContain('Account Primary is not usable');

    const delivered = x.orch.sendUser('delivered message', [], [deliveredQuestion.id]);
    await until(() => usageGate.mock.calls.length === 2);
    gates[1]!.resolve({ usable: true });
    await delivered;
    expect(x.db.chat.pendingQuestions().map((row) => row.id)).toEqual([refusedQuestion.id]);
    expect(x.db.chat.get(deliveredQuestion.id)?.superseded_at).not.toBeNull();
  });

  it('does not close a later queued send question when an earlier turn ends before that send is refused', async () => {
    const refusal = deferred<Awaited<ReturnType<typeof accountUsable>>>();
    const usageGate = vi.fn<typeof accountUsable>()
      .mockResolvedValueOnce({ usable: true })
      .mockReturnValueOnce(refusal.promise);
    const x = setup({ usageGate });
    expect(x.config.dataDir).not.toBe(loadConfig({}).dataDir);
    expect(x.config.port).not.toBe(4400);
    addOauthAccount(x);
    useOauthAccount(x);
    await x.orch.sendUser('initial session');
    const session = x.db.sessions.latest('orchestrator')!;
    const handle = x.sessions.handleOf(session.id)!;
    x.fake.emit(handle, { type: 'turn_end', nativeSessionId: 'native-1', cost: 0 });
    await until(() => !x.orch.status().busy);
    const firstQuestion = x.db.chat.insert({ role: 'assistant', kind: 'question', text: 'Question for the first send' });

    const sendGate = deferred<void>();
    const send = x.sessions.send.bind(x.sessions);
    x.sessions.send = async (sessionId, text) => {
      await send(sessionId, text);
      if (text.includes('first in-flight send')) await sendGate.promise;
    };
    const first = x.orch.sendUser('first in-flight send', [], [firstQuestion.id]);
    let later: Promise<void> | undefined;
    try {
      await until(() => x.fake.sent(handle).some((text) => text.includes('first in-flight send')));
      const laterQuestion = x.db.chat.insert({ role: 'assistant', kind: 'question', text: 'Question for the later send' });
      later = x.orch.sendUser('later queued send', [], [laterQuestion.id]);

      x.fake.emit(handle, { type: 'turn_end', nativeSessionId: 'native-1', cost: 0 });
      await until(() => x.db.chat.get(firstQuestion.id)?.superseded_at !== null);
      expect(x.db.chat.pendingQuestions().map((question) => question.id)).toEqual([laterQuestion.id]);
      (x.orch as unknown as { lastActivityAt: number }).lastActivityAt = 0;
      sendGate.resolve();
      await until(() => usageGate.mock.calls.length === 2);
      refusal.resolve({ usable: false, reason: 'account Primary: session 95% >= 95%' });
      await Promise.all([first, later]);

      expect(x.db.chat.get(firstQuestion.id)?.superseded_at).not.toBeNull();
      expect(x.db.chat.get(laterQuestion.id)?.superseded_at).toBeNull();
      expect(x.db.chat.pendingQuestions().map((question) => question.id)).toEqual([laterQuestion.id]);
      expect(x.db.chat.all().some((row) => row.text.includes('Account Primary is not usable'))).toBe(true);
    } finally {
      sendGate.resolve();
      refusal.resolve({ usable: false, reason: 'account Primary: session 95% >= 95%' });
      await Promise.all([first, ...(later ? [later] : [])]);
    }
  });

  it('keeps an idle live session and its open question when its account logs out', async () => {
    const x = setup();
    await x.orch.sendUser('start');
    const session = x.db.sessions.latest('orchestrator')!;
    const question = x.db.chat.insert({ role: 'assistant', kind: 'question', text: 'Which DB?' });
    x.db.accounts.insert({ id: 'a1', name: 'Logged out Claude', harness: 'claude', kind: 'oauth_token', home: null, created_at: 't0', last_login_at: null, last_verified_at: null });
    x.db.settings.set('orchestrator', { model: null, effort: null, promptOverride: null, account: 'a1' });
    x.config.orchestratorIdleMs = -1;

    await x.orch.sendUser('use sqlite');

    expect(x.sessions.isLive(session.id)).toBe(true);
    expect(x.db.sessions.get(session.id)?.status).toBe('running');
    expect(x.db.chat.pendingQuestions().map((row) => row.id)).toEqual([question.id]);
  });

  it('keeps an idle live session and its open question when every account is unusable', async () => {
    const usageGate = vi.fn<typeof accountUsable>(async () => ({ usable: false, reason: 'account Primary: session 95% >= 95%' }));
    const x = setup({ usageGate });
    await x.orch.sendUser('start');
    const session = x.db.sessions.latest('orchestrator')!;
    const question = x.db.chat.insert({ role: 'assistant', kind: 'question', text: 'Which DB?' });
    x.db.accounts.insert({ id: 'a1', name: 'Primary', harness: 'claude', kind: 'oauth_token', secret: 'token', home: null, created_at: 't0', last_login_at: 't0', last_verified_at: null });
    x.db.settings.set('orchestrator', { model: 'fable', effort: null, promptOverride: null, account: 'a1' });
    x.config.orchestratorIdleMs = -1;

    await x.orch.sendUser('use sqlite');

    expect(x.sessions.isLive(session.id)).toBe(true);
    expect(x.db.sessions.get(session.id)?.status).toBe('running');
    expect(x.db.chat.pendingQuestions().map((row) => row.id)).toEqual([question.id]);
    expect(x.db.chat.all().at(-1)?.text).toContain('Account Primary is not usable');
  });

  it('joins a session started while an OAuth refresh is pending', async () => {
    const x = setup();
    x.db.accounts.insert({ id: 'a1', name: 'Refreshing Claude', harness: 'claude', kind: 'oauth_token', secret: 'expired-access', refresh_token: 'refresh-secret', token_expires_at: Date.now() - 1, home: null, created_at: 't0', last_login_at: 't0', last_verified_at: null });
    x.db.settings.set('orchestrator', { model: null, effort: null, promptOverride: null, account: 'a1' });
    let completeRefresh!: (response: Response) => void;
    const refresh = new Promise<Response>((resolve) => { completeRefresh = resolve; });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockReturnValue(refresh);
    const startSpy = vi.spyOn(x.sessions, 'start');

    try {
      const first = x.orch.sendUser('first delivery');
      await until(() => fetchSpy.mock.calls.length === 1);
      const second = x.orch.sendUser('second delivery');
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(startSpy).not.toHaveBeenCalled();
      completeRefresh(new Response(JSON.stringify({ access_token: 'fresh-access', refresh_token: 'rotated-refresh', expires_in: 3600 }), { headers: { 'Content-Type': 'application/json' } }));
      await Promise.all([first, second]);

      expect(startSpy).toHaveBeenCalledTimes(1);
      const session = x.db.sessions.latest('orchestrator')!;
      const sent = x.fake.sessions.get(x.sessions.handleOf(session.id)!.id)!.sent;
      const firstIndex = sent.findIndex((text) => text.includes('first delivery'));
      const secondIndex = sent.findIndex((text) => text.includes('second delivery'));
      expect(firstIndex).toBeGreaterThanOrEqual(0);
      expect(secondIndex).toBeGreaterThan(firstIndex);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('restarts an idle session once when concurrent OAuth refreshes finish', async () => {
    const x = setup();
    await x.orch.sendUser('initial session');
    const initial = x.db.sessions.latest('orchestrator')!;
    (x.orch as unknown as { lastActivityAt: number }).lastActivityAt = 0;
    x.db.accounts.insert({ id: 'a1', name: 'Refreshing Claude', harness: 'claude', kind: 'oauth_token', secret: 'expired-access', refresh_token: 'refresh-secret', token_expires_at: Date.now() - 1, home: null, created_at: 't0', last_login_at: 't0', last_verified_at: null });
    x.db.settings.set('orchestrator', { model: null, effort: null, promptOverride: null, account: 'a1' });
    let completeRefresh!: (response: Response) => void;
    const refresh = new Promise<Response>((resolve) => { completeRefresh = resolve; });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockReturnValue(refresh);
    const startSpy = vi.spyOn(x.sessions, 'start');

    try {
      const first = x.orch.sendUser('first restart delivery');
      await until(() => fetchSpy.mock.calls.length === 1);
      const second = x.orch.sendUser('second restart delivery');
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(startSpy).not.toHaveBeenCalled();
      completeRefresh(new Response(JSON.stringify({ access_token: 'fresh-access', refresh_token: 'rotated-refresh', expires_in: 3600 }), { headers: { 'Content-Type': 'application/json' } }));
      await Promise.all([first, second]);

      expect(startSpy).toHaveBeenCalledTimes(1);
      const session = x.db.sessions.latest('orchestrator')!;
      expect(session.id).not.toBe(initial.id);
      const sent = x.fake.sessions.get(x.sessions.handleOf(session.id)!.id)!.sent;
      const firstIndex = sent.findIndex((text) => text.includes('first restart delivery'));
      const secondIndex = sent.findIndex((text) => text.includes('second restart delivery'));
      expect(firstIndex).toBeGreaterThanOrEqual(0);
      expect(secondIndex).toBeGreaterThan(firstIndex);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('stores the next user message during a restart and delivers it after the first restart message', async () => {
    const gate = deferred<Awaited<ReturnType<typeof accountUsable>>>();
    const usageGate = vi.fn<typeof accountUsable>(() => gate.promise);
    const x = setup({ usageGate });
    await x.orch.sendUser('initial session');
    const initial = x.db.sessions.latest('orchestrator')!;
    (x.orch as unknown as { lastActivityAt: number }).lastActivityAt = 0;
    addOauthAccount(x);
    useOauthAccount(x);

    const first = x.orch.sendUser('first restart message');
    await until(() => usageGate.mock.calls.length === 1);
    const second = x.orch.sendUser('second restart message');
    expect(x.db.chat.all().filter((row) => row.role === 'user').map((row) => row.text)).toEqual([
      'initial session', 'first restart message', 'second restart message',
    ]);
    expect(x.db.sessions.latest('orchestrator')?.id).toBe(initial.id);
    expect(usageGate).toHaveBeenCalledTimes(1);

    gate.resolve({ usable: true });
    await Promise.all([first, second]);

    const replacement = x.db.sessions.latest('orchestrator')!;
    expect(replacement.id).not.toBe(initial.id);
    const sent = x.fake.sessions.get(x.sessions.handleOf(replacement.id)!.id)!.sent;
    const firstIndex = sent.findIndex((text) => text.includes('first restart message'));
    const secondIndex = sent.findIndex((text) => text.includes('second restart message'));
    expect(firstIndex).toBeGreaterThanOrEqual(0);
    expect(secondIndex).toBeGreaterThan(firstIndex);
  });

  it('queues a wake notice whose start its logged-out account refused, and explains it once', async () => {
    const x = setup();
    x.db.accounts.insert({ id: 'a1', name: 'Logged out Claude', harness: 'claude', kind: 'oauth_token', home: null, created_at: 't0', last_login_at: null, last_verified_at: null });
    x.db.settings.set('orchestrator', { model: null, effort: null, promptOverride: null, account: 'a1' });
    await x.orch.systemMessage('b1 awaits review', { wake: true, hint: 'Call request_batch_review.' });
    await x.orch.systemMessage('b2 awaits review', { wake: true });
    expect(x.db.sessions.latest('orchestrator')).toBeUndefined();
    // The events that asked for a start are kept, so the next live turn carries them instead of losing them.
    expect(x.db.chat.queued().map((row) => row.text)).toEqual(['b1 awaits review', 'b2 awaits review']);
    expect(x.db.chat.queued()[0]?.hint).toBe('Call request_batch_review.');
    const explanations = x.db.chat.all().filter((row) => row.text.startsWith('Account Logged out Claude is not logged in'));
    expect(explanations).toHaveLength(1);

    // Once the account is logged in the queue travels with the next turn.
    x.db.accounts.update('a1', { secret: 'sk-ant-token' });
    await x.orch.sendUser('carry on');
    expect(x.db.chat.queued()).toEqual([]);
    const started = x.db.sessions.latest('orchestrator')!;
    const prompt = x.fake.sessions.get(x.sessions.handleOf(started.id)!.id)!.opts.prompt;
    expect(prompt).toContain('b1 awaits review');
    expect(prompt).toContain('b2 awaits review');
  });

  it('carries a requeued notice on the next live-session turn', async () => {
    const x = setup();
    await x.orch.sendUser('start');
    const h = x.sessions.handleOf(x.db.sessions.latest('orchestrator')!.id)!;
    x.db.accounts.insert({ id: 'a1', name: 'Logged out Claude', harness: 'claude', kind: 'oauth_token', home: null, created_at: 't0', last_login_at: null, last_verified_at: null });
    x.db.settings.set('orchestrator', { model: null, effort: null, promptOverride: null, account: 'a1' });

    await x.orch.systemMessage('b1 awaits review', { wake: true, hint: 'Call request_batch_review.' });
    expect(x.db.chat.queued().map((row) => row.text)).toEqual(['b1 awaits review']);

    x.db.accounts.update('a1', { secret: 'sk-ant-token' });
    await x.orch.sendUser('carry on');
    expect(x.fake.sent(h).at(-1)).toBe('[Overseer] Notices while no orchestrator session was live:\n- b1 awaits review Call request_batch_review.\n\ncarry on');
    expect(x.db.chat.queued()).toEqual([]);
  });

  it('tells the orchestrator to use blocked-by: dependencies (bd 1.2.2 blocks: is the reverse relation)', () => {
    const prompt = fs.readFileSync(path.join(loadConfig({}).promptsDir, 'orchestrator.md'), 'utf8');
    expect(prompt).toContain('Every Definition of Done names the applicable edge states, with one assertion or read-back each');
    expect(prompt).toContain('Input fields that read, reformat or validate what the user enters: test each input path with real input events, starting from an empty value and from an already formatted value.');
    expect(prompt).toMatch(/typing key by key;\r?\n  - deleting;\r?\n  - inserting mid-value;\r?\n  - pasting and dropping, whole and partial;\r?\n  - replacing a selection;\r?\n  - each shipped locale's separators\./);
    expect(prompt).toContain('blocked-by:');
    expect(prompt).toContain("- follows the repo's MR/PR skill or template;");
    expect(prompt).toMatch(/The review note:\r?\n(- [^\r\n]*\r?\n)*- follows the repo's MR\/PR skill or template;/);
    expect(prompt).toContain('A lesson about how a managed repo works');
    expect(prompt).toContain("goes into that repo's instruction files, through a bead in that repo.");
    expect(prompt).toContain('If the user already decided the change, the reproduction is a finding to report, not a gate.');
    expect(prompt).toContain("Across packages, each bead's Definition of Done must be reachable with only its own files.");
    // overseer-rp7l: an ordinary bead is gated on focused tests, the full suite runs once per batch before review
    expect(prompt).toContain('An ordinary Definition of Done names the focused test files (`vitest run <file>` in the right mode) and `pnpm typecheck`. It never names the full suite, a wall clock or two green runs.');
    expect(prompt).toContain('With a `review_command`, quote `review_check` from `list_batches`.');
    expect(prompt).toContain('Otherwise run the full suite once yourself, with no worker on the machine, and quote the result.');
    expect(prompt).not.toContain('blocks:');
    // overseer-b15-vizv: same-file beads are chained, not dispatched in parallel
    expect(prompt).toContain('Beads that touch the same non-documentation file (a shared module, a prompt file) are chained with `blocked-by:`.');
    expect(prompt).toContain('Only beads with disjoint file sets run in parallel.');
    expect(prompt).toContain('Before a whole-file DoD requiring N passes under load or stress, run each file once on the base under it and list every failure.');
    // overseer-b85-bwp3: a shared component's contract is read out and each shell-owned requirement becomes its own blocking bead
    expect(prompt).toContain("Beads sharing a component: read the component's contract first.");
    expect(prompt).toContain('Each requirement that needs shell-owned state becomes its own bead. That bead lands first, and the others are blocked by it.');
    expect(prompt).toContain("Anything you tell a worker that must outlive the turn also goes in the bead's notes.");
    // overseer-pmb1: long, silent command routing follows adapter behavior and a stall is checked against child processes
    expect(prompt).toContain('The bead fixes a harness adapter, or its notes show a harness failing before any work (startup crash, argument error, hang before any API call). Use another CLI with usage headroom that fits; `claude` only if sole fit.');
    expect(prompt).toContain('The Definition of Done is a long, silent command (slow suite, full build). Choose a fitting CLI with usage headroom; Codex waits for `turn.completed` or exit; `claude` only if sole fit, because opencode\'s adapter ends a turn that is silent for 20 minutes.');
    expect(prompt).toContain('Force `claude` only for a Claude-only MCP tool (Figma) or user rules; automatic retries keep the harness pinned.');
    expect(prompt).toMatch(/Pass `harness` only in these cases:\r?\n    - The user asks for a CLI\./);
    expect(prompt).toContain('A stall notice: check `worker_status` and the child processes.');
    expect(prompt).toContain('or whose process uses CPU, is working: leave it and write nothing.');
    expect(prompt).toContain('Split a lifecycle change (merge, refresh, verification, landing)');
    expect(prompt).toContain('into one chained bead per behaviour.');
    expect(prompt).toContain('A description with more than two behaviours or more than one lifecycle path needs splitting.');
    expect(prompt).toContain("Moving where a view lands: list every entry point (grep the view's setter and the redirects into it)");
    expect(prompt).toContain('the redirects into it), each with a test.');
    expect(prompt).toContain('A review round that finds a missed entry point lists every remaining one before re-dispatch.');
    expect(prompt).toContain('A behaviour change in a repo whose `CLAUDE.md` names documentation surfaces (for overseer: `CLAUDE.md`, `README.md`, the `docs/guide/` page, the batches spec)');
    expect(prompt).toContain('lists each surface and section as a Definition-of-Done item, or names the bead that carries it.');
    expect(prompt).toContain('For paged/delta fetches, API beads list every consumer');
    expect(prompt).toContain('create_batch');
    expect(prompt).toContain('request_batch_review');
    // rules learned from the #9310 run (docs/lessons.md)
    expect(prompt).toContain('Evidence (screenshots, probe output, parity notes) never goes into the repository.');
    expect(prompt).toContain('A reference the user supplies in chat (a portrait, a screenshot, a design export) is copied at once to a named path outside the repository under the evidence folder. Every bead whose gate compares against it names that path. A gate that says "keep" a likeness or palette names the check that proves it (a side-by-side against the reference, or colour values per region).');
    expect(prompt).toContain("Browser proof uses the worktree's own server on a free or whitelisted port");
    expect(prompt).toContain("not the main checkout's server.");
    expect(prompt).toContain('Before a tool call expected to take over a minute, post one line saying what is running.');
    expect(prompt).toContain("Read every bead's final notes.");
    expect(prompt).toContain('commit in stages');
    expect(prompt).toContain('Verification-only beads (no code change: run checks, capture evidence, measure) are dispatched with `verify_only: true`.');
    expect(prompt).toContain('verify_only: true');
    expect(prompt).toContain('reopens as `verify_incomplete`');
    expect(prompt).toContain('A verification bead sent without the flag that comes back `no_commits` with every check passed is done.');
    // overseer-b43-ixy7: responsive proofs use the named worst-case states, not a short passing state
    expect(prompt).toContain('Use worst-case content: the longest state word, every optional badge, the longest configured value');
    expect(prompt).toContain('every locale and every data-driven wording variant.');
    expect(prompt).toContain('A responsive layout is measured at every breakpoint the stylesheet defines');
    expect(prompt).toContain('at each edge and at one width inside each band.');
    // overseer-b43-ixy7: repeated review on one surface needs a user decision, not another open-ended finding
    expect(prompt).toContain('After three review cycles on one surface');
    expect(prompt).toContain("get the user's exact prescription (layout, states, measurements), or accept the change.");
    // acme-portal-sample-015: a runaway bead, a comment-only finding, an evidence bead's preconditions and an unbuildable prescription all stop the same re-dispatch loop
    expect(prompt).toContain('Count re-dispatches per bead, not per surface');
    expect(prompt).toContain('After the third re-dispatch of a bead, stop and `ask_user` with what is left');
    expect(prompt).toContain('Findings that are only stale comments or doc sentences never get a round of their own.');
    expect(prompt).toContain('Findings with no `[must]` item: the bead lands, and its notice lists them under `review findings landed with (round N)`.');
    expect(prompt).toContain('The review round count is a cap. A chore bead gets one round. A standard bead gets a second only after a `[must]` finding or a diff over 400 lines. A hard bead gets rounds up to the cap.');
    expect(prompt).toContain('Before dispatching a live-evidence bead, check its preconditions and write them into the description or the instructions:');
    expect(prompt).toContain('the prescription itself cannot be built');
    expect(prompt).toContain('verify it once (`worker_diff`, the file). Then `ask_user`, explaining why it cannot be built and asking for a new prescription or a decision.');
    expect(prompt).toContain('Re-dispatch only with their answer.');
    expect(prompt).toContain('A notice you handle yourself gets no message');
    expect(prompt).toContain('End the turn silently after the tool calls.');
    expect(prompt).toContain("A helper's full report reaches Chat");
    expect(prompt).toContain('Progress lines between tool calls');
    // rules from the 2026-09-15 insights report (docs/lessons.md)
    expect(prompt).toContain('Never invent what the request leaves open (file contents, names, wording, placement).');
    expect(prompt).toContain('Never pre-authorise a fallback that degrades the user\'s stated flow ("if X fails, do the lesser Y").');
    expect(prompt).toContain('An external event or message type (stream event, webhook, API status): grep fixtures and logs');
    expect(prompt).toContain('quote one real sample, and name the triggering field and value.');
    expect(prompt).toContain('Never state an assumed shape as fact.');
    expect(prompt).toContain('name a comparable tool and read its implementation.');
    expect(prompt).toContain('If it reaches the goal another way, dispatch that path. Otherwise `ask_user`, naming the fallback and what it drops from the request.');
    expect(prompt).toContain('means the command is the suspect.');
    expect(prompt).toContain('ask the user to press Close bead. Never ask for a no-op commit.');
    expect(prompt).toContain('Artefact conventions state that helper files (`.playwright-cli/`, `.tmp-*.py`, `dist/`) are not committed.');
    expect(prompt).toContain('say which batch to merge first');
    expect(prompt).toContain('Only a `script_failure` with named failing tests justifies a fix bead.');
    expect(prompt).toContain('`runner_system_failure`, or an empty trace with runner `ERROR` lines, is infrastructure.');
    expect(prompt).toContain('Request review again as soon as they land; a landed bead does not reach GitLab by itself.');
    expect(prompt).toContain('compare the MR head SHA with the local batch branch');
    expect(prompt).toContain('If they differ, the fix is on the branch but unpushed: request review again.');
    // preflight gate and crash classes (2026-09-16 insights report)
    expect(prompt).toContain('When `spawn_worker` refuses because the saved command fails its base-branch probe, relay the refusal.');
    expect(prompt).toContain('a re-dispatch after a transient stream failure.');
    expect(prompt).toContain('A reopen naming a harness bug: never re-dispatch on that harness.');
    expect(prompt).not.toContain('In rule 6:');
    // acme-portal-sample-038: reference parity, merge-base restores and forced harnesses
    expect(prompt).toContain('`spawn_worker(repo, bead_id, tier?, harness?, instructions?, batch_id?, needs_server?, verify_only?, verify_command?)`');
    expect(prompt).toContain('`harness` (`claude`, `codex`, `opencode`) forces a CLI.');
    // overseer-fczf: a harness passed with a tier stays on that harness among that tier's candidates
    expect(prompt).toContain("With `tier`, it takes that tier's candidate on that CLI");
    expect(prompt).not.toContain('passing both lets the tier choose another harness');
    // overseer-wnxw: the needs_server flag keeps server work off a harness that cannot hold one
    expect(prompt).toContain('Pass `needs_server: true` whenever the bead starts a dev server, daemon or browser, including screenshot and evidence capture.');
    expect(prompt).toContain("Add `tier` if the work needs that tier's strength.");
    expect(prompt).toContain('MB=$(git merge-base origin/<base> HEAD)');
    expect(prompt).toContain('MB=$(git merge-base <base> HEAD)');
    expect(prompt).toContain("Otherwise, and always for the batch's own branch: `MB=$(git merge-base <base> HEAD)`.");
    expect(prompt).toContain('Restores in instructions use the merge base, never a branch tip:');
    expect(prompt).toContain('A pipeline or deploy config compared to a reference gets separate sections for lint, a parity table');
    expect(prompt).toContain('A written decision contradicts a reference system the user named.');
    expect(prompt).toContain('"Identical to X" means change only what differs.');
    // overseer-b20-ic4p: the merge check covers local-merge repos too, and a commit-less review re-dispatch goes to claude at once
    expect(prompt).toContain('<branch>` must exit 0. In `gitlab-mr` repos');
    expect(prompt).toContain('run it against `origin/<base>` after a fetch; in `local-merge` repos, against the local base.');
    expect(prompt).toContain('A re-dispatch that produced no new commits (HEAD unchanged): re-dispatch to `claude` at once. Give the findings as numbered file-and-line steps');
    // acme-portal-sample-037: evidence from a verification-only bead must survive the worktree
    expect(prompt).toContain('The worktree is removed when the worker ends, so evidence left there is invalid.');
    expect(prompt).toContain("Without a GitLab project, the evidence bead's description names a path outside the worktree, the worker copies the files there, and reports each file as `Evidence: <absolute path> - <caption>`.");
    expect(prompt).toContain('confirm the branch has new commits on top of <sha>');
    expect(prompt).toContain('An unrun check is never a Known limit.');
    expect(prompt).toContain('A batch whose goal is a passing check, with failures caused outside the repository');
    expect(prompt).toContain('Request review with their answer, never with the failures written as Known limits.');
    // acme-portal-sample-017 and acme-portal-sample-016: a removed behaviour is a user decision, persisted/shared state is named, and a tool-gated task picks a harness that has the tool
    expect(prompt).toContain('A behaviour the previous release had that this change removes or degrades');
    expect(prompt).toContain('removes or degrades: `ask_user` for a decision before requesting review.');
    expect(prompt).toContain('Never record a gate as Unverified on an unchecked claim');
    expect(prompt).toContain('A change to the precedence or meaning of a persisted value');
    expect(prompt).toContain('Moving state from browser-local to account-wide or onto a shared fixture');
    expect(prompt).toContain('The Definition of Done needs an MCP tool only some harnesses have (Figma, PixelLab: `claude`).');
    expect(prompt).toContain('A gate that needs an MCP tool names that tool in the description (for example Figma `get_design_context`) and goes to a harness that has it (`claude`).');
    // retrospective loop
    expect(prompt).toContain('## Retrospective');
    expect(prompt).toContain('batch_retrospective(repo, batch_id)');
    expect(prompt).toContain('batch_retrospective(repo, batch_id, full?, bead_id?)');
    expect(prompt).toContain('Compact by default; pass `full: true`');
    expect(prompt).toContain('`full: true` or `bead_id` for uncut text.');
    expect(prompt).toContain('Use `full` or `bead_id` when you need uncut text to quote.');
    expect(prompt).toContain('Lessons from <repo> <batch_id>');
    expect(prompt).toContain('A lesson about how a managed repo works becomes a bead in that repo that updates its instruction files.');
    expect(prompt).toContain('Orchestration and worker lessons join the open lessons batch');
    expect(prompt).toContain('either in its bead or in one bead chained after it.');
    expect(prompt).toContain('If no lessons batch is open, create a batch on `overseer`');
    expect(prompt).toContain('prove the wrapped and raw commands select the same files and tests');
    expect(prompt).toContain('A finding that would widen autonomous authority to merge, approve, delete or publish (for example, publishing automatically with no human step): `ask_user`');
    expect(prompt).toContain('An unreproduced defect gets a first bead that measures the named values, props, loop state or geometry without product changes.');
    expect(prompt).toContain("Close each consumer entry only with an assertion of the new kind's effect on it.");
    expect(prompt).toContain('greps touched doc counts, file names and claims against the merged code');
    expect(prompt).toContain('re-runs setup when dependencies changed.');
    // the shell rule: pnpm, vitest and builds run through PowerShell on Windows
    expect(prompt).toContain('On Windows, run `pnpm`, vitest and builds in PowerShell');
    expect(prompt).toContain('A corepack module-not-found error means the wrong shell.');
    // overseer-5nh: image attachments are delivered as [attached image: <path>] lines
    expect(prompt).toContain('`[attached image: <path>]` lines are screenshots the user attached: Read each one before answering');
  });
  it('tells the orchestrator a bd write answers compact and a bead is read with show', () => {
    const prompt = fs.readFileSync(path.join(loadConfig({}).promptsDir, 'orchestrator.md'), 'utf8');
    expect(prompt).toContain('write commands return only id, status and title');
    expect(prompt).toContain('Read with `["show", "<id>"]`');
  });
  it('tells the orchestrator to propose a plan and stop when the user asks to plan the work out', () => {
    const prompt = fs.readFileSync(path.join(loadConfig({}).promptsDir, 'orchestrator.md'), 'utf8');
    const start = prompt.indexOf('## Planning');
    const end = prompt.indexOf('## Batches and beads');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const how = prompt.slice(start, end);
    expect(how).toContain('propose_plan');
    expect(how).toMatch(/plan (it|the work) out/);
    expect(how).toContain('Say in one line that the plan waits on its page, then end the turn.');
    expect(prompt).toContain('\n1. Every request becomes one batch.');
  });
  it('starts lazily with the right options and mirrors assistant text to chat', async () => {
    const x = setup();
    expect(x.orch.status()).toEqual({ status: 'idle', native_session_id: null, last_activity_at: null, busy: false, model: null, context: null });
    await x.orch.sendUser('hello');
    const row = x.db.sessions.latest('orchestrator')!;
    expect(row.role).toBe('orchestrator');
    expect(row.cwd).toBe(x.config.orchestratorDir);
    const h = x.sessions.handleOf(row.id)!;
    const s = x.fake.sessions.get(h.id)!;
    expect(s.opts.prompt.endsWith('hello')).toBe(true);
    expect(s.opts.systemPromptFile).toBe(path.join(x.config.promptsDir, 'orchestrator.md'));
    // Every session gets the MCP server on its own URL, so a tool call carries a caller identity (`registerMcp`).
    expect(s.opts.mcpServers).toHaveLength(1);
    expect(s.opts.mcpServers![0]!.name).toBe('overseer');
    expect(s.opts.mcpServers![0]!.url).toMatch(new RegExp(`^http://127\\.0\\.0\\.1:${x.config.port}/mcp/[0-9a-f-]{36}$`));
    expect(s.opts.resumeId).toBeUndefined();
    expect(x.db.chat.all().map((c) => [c.role, c.text])).toEqual([['user', 'hello']]);
    let chatEvents = 0;
    x.bus.on('chat', () => chatEvents++);
    x.fake.emit(h, { type: 'assistant_text', text: 'hi there' });
    await until(() => x.db.chat.all().length === 2);
    expect(x.db.chat.all()[1]).toMatchObject({ role: 'assistant', kind: 'message', text: 'hi there', reply_to: 1 });
    expect(chatEvents).toBe(1);
    await x.orch.sendUser('second');
    const sent = x.fake.sent(h);
    expect(sent[0]!.endsWith('hello')).toBe(true);
    expect(sent[1]).toBe('second');
    // Text that arrives before the first turn ends still answers the first message, although a newer one is in the thread (round 16).
    x.fake.emit(h, { type: 'assistant_text', text: 'still on hello' });
    await until(() => x.db.chat.all().length === 4);
    expect(x.db.chat.all()[3]).toMatchObject({ role: 'assistant', text: 'still on hello', reply_to: 1 });
    x.fake.emit(h, { type: 'turn_end', nativeSessionId: 'native-1', cost: 1 });
    await until(() => x.orch.status().native_session_id === 'native-1');
    x.fake.emit(h, { type: 'assistant_text', text: 'now on second' });
    await until(() => x.db.chat.all().length === 5);
    expect(x.db.chat.all()[4]).toMatchObject({ role: 'assistant', text: 'now on second', reply_to: 3 });
    expect(x.orch.status().status).toBe('running');
    expect(x.sessions.isLive(row.id)).toBe(true);
  });

  it('marks a user message seen when handed to the session, then answered by the next assistant text', async () => {
    const x = setup();
    await x.orch.sendUser('hello');
    const user = x.db.chat.all().find((c) => c.role === 'user')!;
    expect(user.seen_at).toBeTruthy();
    expect(user.replied_at).toBeNull();
    const h = x.sessions.handleOf(x.db.sessions.latest('orchestrator')!.id)!;
    x.fake.emit(h, { type: 'assistant_text', text: 'hi' });
    await until(() => x.db.chat.get(user.id)!.replied_at !== null);
    expect(x.db.chat.get(user.id)!.replied_at).toBeTruthy();
  });

  it('marks a follow-up sent into a running turn seen at send and answered by the next text', async () => {
    const x = setup();
    await x.orch.sendUser('first');
    const h = x.sessions.handleOf(x.db.sessions.latest('orchestrator')!.id)!;
    x.fake.emit(h, { type: 'assistant_text', text: 'working on the first' });
    const first = x.db.chat.all().find((c) => c.text === 'first')!;
    await until(() => x.db.chat.get(first.id)!.replied_at !== null);
    await x.orch.sendUser('second');
    const second = x.db.chat.all().find((c) => c.text === 'second')!;
    expect(second.seen_at).toBeTruthy();
    // The earlier text already came and went, so it did not mark this follow-up.
    expect(second.replied_at).toBeNull();
    x.fake.emit(h, { type: 'assistant_text', text: 'now on the second' });
    await until(() => x.db.chat.get(second.id)!.replied_at !== null);
    // The reply still points at the head delivery, whatever replied_at now says (reply_to is unchanged).
    expect(x.db.chat.all().find((c) => c.text === 'now on the second')?.reply_to).toBe(first.id);
  });

  it('does not mark a follow-up sent after the last assistant text was written', async () => {
    const x = setup();
    await x.orch.sendUser('one');
    const h = x.sessions.handleOf(x.db.sessions.latest('orchestrator')!.id)!;
    x.fake.emit(h, { type: 'assistant_text', text: 'the only reply' });
    await until(() => x.db.chat.all().some((c) => c.text === 'the only reply'));
    await x.orch.sendUser('two');
    const two = x.db.chat.all().find((c) => c.text === 'two')!;
    expect(two.seen_at).toBeTruthy();
    expect(two.replied_at).toBeNull();
  });

  it('marks two follow-ups carried into one turn with the single reply that answers them', async () => {
    const x = setup();
    await x.orch.sendUser('one');
    await x.orch.sendUser('two');
    await x.orch.sendUser('three');
    const h = x.sessions.handleOf(x.db.sessions.latest('orchestrator')!.id)!;
    const users = () => x.db.chat.all().filter((c) => c.role === 'user');
    expect(users().every((c) => c.seen_at !== null)).toBe(true);
    x.fake.emit(h, { type: 'assistant_text', text: 'answered all three' });
    await until(() => x.db.chat.all().some((c) => c.text === 'answered all three'));
    expect(users().every((c) => c.replied_at !== null)).toBe(true);
  });

  it('marks a seen user message answered when the orchestrator asks a question', async () => {
    const x = setup();
    await x.orch.sendUser('hello');
    const user = x.db.chat.all().find((c) => c.role === 'user')!;
    const h = x.sessions.handleOf(x.db.sessions.latest('orchestrator')!.id)!;
    x.fake.emit(h, { type: 'tool_call', id: 'q1', name: 'mcp__overseer__ask_user', input: { question: 'which?' } });
    await until(() => x.db.chat.get(user.id)!.replied_at !== null);
    expect(x.db.chat.get(user.id)!.replied_at).toBeTruthy();
  });

  it('leaves a held (queued) row unseen until a turn carries it, then marks it seen', async () => {
    const x = setup();
    await x.orch.systemMessage('held notice');
    const held = x.db.chat.all().find((c) => c.text === 'held notice')!;
    expect(held.queued_at).toBeTruthy();
    expect(held.seen_at).toBeNull();
    await x.orch.sendUser('start');
    await until(() => x.db.chat.get(held.id)!.queued_at === null);
    expect(x.db.chat.get(held.id)!.seen_at).toBeTruthy();
  });

  it('records one failure row when a live-session send throws and keeps the daemon sending', async () => {
    const x = setup();
    await x.orch.sendUser('first');
    const h = x.sessions.handleOf(x.db.sessions.latest('orchestrator')!.id)!;
    x.fake.emit(h, { type: 'turn_end', nativeSessionId: 'n1', cost: 0 });
    await until(() => !x.orch.status().busy);
    const send = x.sessions.send.bind(x.sessions);
    x.sessions.send = async () => { throw new Error('pipe closed'); };
    const error = vi.spyOn(log, 'error').mockImplementation(() => {});
    try {
      await x.orch.sendUser('second');
      const second = x.db.chat.all().find((c) => c.text === 'second')!;
      expect(second.seen_at).toBeNull();
      expect(x.db.chat.all().filter((row) => row.text === 'Message saved but not delivered: pipe closed')).toHaveLength(1);

      x.sessions.send = send;
      await x.orch.sendUser('third');
      expect(x.fake.sent(h).at(-1)).toBe('third');
    } finally {
      x.sessions.send = send;
      error.mockRestore();
    }
  });

  it('leaves a message seen but not answered when the session ends without a reply', async () => {
    const x = setup();
    await x.orch.sendUser('hello');
    const first = x.db.sessions.latest('orchestrator')!;
    const user = x.db.chat.all().find((c) => c.role === 'user')!;
    expect(user.seen_at).toBeTruthy();
    await x.sessions.end(first.id);
    await until(() => !x.sessions.isLive(first.id));
    // The next session's reply answers only the message it saw, not the one the ended session left unanswered.
    await x.orch.sendUser('again');
    const h2 = x.sessions.handleOf(x.db.sessions.latest('orchestrator')!.id)!;
    x.fake.emit(h2, { type: 'assistant_text', text: 'back' });
    await until(() => x.db.chat.all().some((c) => c.text === 'back'));
    expect(x.db.chat.get(user.id)!.replied_at).toBeNull();
  });

  it('marks nothing on a notice-driven delivery with no user row', async () => {
    const x = setup();
    await x.orch.sendUser('hello');
    const user = x.db.chat.all().find((c) => c.role === 'user')!;
    const h = x.sessions.handleOf(x.db.sessions.latest('orchestrator')!.id)!;
    x.fake.emit(h, { type: 'assistant_text', text: 'hi' });
    await until(() => x.db.chat.get(user.id)!.replied_at !== null);
    const replied = x.db.chat.get(user.id)!.replied_at;
    await x.orch.systemMessage('ov-1 landed');
    const notice = x.db.chat.all().at(-1)!;
    expect(notice.seen_at).toBeNull();
    x.fake.emit(h, { type: 'assistant_text', text: 'noted' });
    await until(() => x.db.chat.all().some((c) => c.text === 'noted'));
    expect(x.db.chat.get(user.id)!.replied_at).toBe(replied);
  });

  it('stores attachments to disk, delivers image lines after the text, and keeps the row text plain (overseer-5nh)', async () => {
    const x = setup();
    const absoluteDir = fs.mkdtempSync(path.join(os.tmpdir(), 'overseer-relative-orch-'));
    x.config.orchestratorDir = path.relative(process.cwd(), absoluteDir);
    const data = Buffer.from('fake-png-bytes');
    await x.orch.sendUser('look at this', [{ name: 'shot.png', mime: 'image/png', data }]);
    const row = x.db.chat.all()[0]!;
    expect(row.text).toBe('look at this');
    expect(row.attachments).toEqual([{ name: 'shot.png', mime: 'image/png', size: data.length }]);
    const stored = x.db.chat.attachment(row.id, 0)!;
    expect(stored.path).toBe(path.join(absoluteDir, 'attachments', `${row.id}-0.png`));
    expect(path.isAbsolute(stored.path)).toBe(true);
    expect(fs.readFileSync(stored.path)).toEqual(data);
    const h = x.sessions.handleOf(x.db.sessions.latest('orchestrator')!.id)!;
    expect(x.fake.sent(h)[0]!.endsWith(`look at this\n\n[attached image: ${stored.path}]`)).toBe(true);
    fs.rmSync(absoluteDir, { recursive: true, force: true });
  });

  it('delivers only the image lines when the text is empty (overseer-5nh)', async () => {
    const x = setup();
    const data = Buffer.from('fake-gif-bytes');
    await x.orch.sendUser('', [{ name: 'shot.gif', mime: 'image/gif', data }]);
    const row = x.db.chat.all()[0]!;
    expect(row.text).toBe('');
    const stored = x.db.chat.attachment(row.id, 0)!;
    const h = x.sessions.handleOf(x.db.sessions.latest('orchestrator')!.id)!;
    expect(x.fake.sent(h)[0]!.endsWith(`[attached image: ${stored.path}]`)).toBe(true);
    fs.rmSync(x.config.orchestratorDir, { recursive: true, force: true });
  });

  it('pushes every reply (collapsed, cut to 160 chars) unless a question was asked this turn or push_on_reply is off', async () => {
    const x = setup();
    await x.orch.sendUser('hello');
    const h = x.sessions.handleOf(x.db.sessions.latest('orchestrator')!.id)!;
    const long = 'line one\n\n  line two ' + 'x'.repeat(200);
    x.fake.emit(h, { type: 'assistant_text', text: long });
    await until(() => x.db.chat.all().length === 2);
    expect(x.push.notify).toHaveBeenCalledTimes(1);
    const body = x.push.notify.mock.calls[0]![0];
    expect(body).toMatchObject({ title: 'Overseer', url: '#chat' });
    expect(body.body.startsWith('line one line two x')).toBe(true);
    expect(body.body.length).toBe(160);
    expect(body.body.endsWith('…')).toBe(true);
    // A notice is Overseer's own line, not a reply: no push.
    await x.orch.systemMessage('[Overseer] something happened');
    expect(x.push.notify).toHaveBeenCalledTimes(1);
    // ask_user already pushed the question (mcp/tools.ts); the reply that follows in the same turn is not pushed again, the next turn's is.
    x.fake.emit(h, { type: 'tool_call', id: 'q1', name: 'mcp__overseer__ask_user', input: { question: 'which?' } });
    x.fake.emit(h, { type: 'assistant_text', text: 'I asked you which one.' });
    await until(() => x.db.chat.all().length === 4);
    expect(x.push.notify).toHaveBeenCalledTimes(1);
    x.fake.emit(h, { type: 'turn_end', nativeSessionId: 'native-1', cost: 1 });
    await until(() => x.orch.status().native_session_id === 'native-1');
    x.fake.emit(h, { type: 'assistant_text', text: 'short' });
    await until(() => x.db.chat.all().length === 5);
    expect(x.push.notify).toHaveBeenCalledTimes(2);
    expect(x.push.notify.mock.calls[1]![0]).toEqual({ title: 'Overseer', body: 'short', url: '#chat' });
    x.db.settings.set('push_on_reply', false);
    x.fake.emit(h, { type: 'assistant_text', text: 'silent' });
    await until(() => x.db.chat.all().length === 6);
    expect(x.push.notify).toHaveBeenCalledTimes(2);
    expect(pushBody('a  b')).toBe('a b');
  });

  it('pushes the first reply of the next session after a session ended mid-turn with a question asked', async () => {
    const x = setup();
    await x.orch.sendUser('hello');
    const first = x.db.sessions.latest('orchestrator')!;
    const h = x.sessions.handleOf(first.id)!;
    x.fake.emit(h, { type: 'tool_call', id: 'q1', name: 'mcp__overseer__ask_user', input: { question: 'which?' } });
    x.fake.emit(h, { type: 'assistant_text', text: 'I asked you which one.' });
    await until(() => x.db.chat.all().length === 2);
    expect(x.push.notify).not.toHaveBeenCalled();
    // The session ends without a turn_end (crash or error mid-turn): the per-turn flag must not leak into the next session.
    await x.sessions.end(first.id);
    await until(() => !x.sessions.isLive(first.id));
    await x.orch.sendUser('again');
    const second = x.db.sessions.latest('orchestrator')!;
    expect(second.id).not.toBe(first.id);
    x.fake.emit(x.sessions.handleOf(second.id)!, { type: 'assistant_text', text: 'back' });
    await until(() => x.push.notify.mock.calls.length === 1);
    expect(x.push.notify.mock.calls[0]![0]).toEqual({ title: 'Overseer', body: 'back', url: '#chat' });
  });

  it('carries the orchestrator settings into a fresh session and reports the model in status', async () => {
    const x = setup();
    x.db.settings.set('orchestrator', { model: 'fable', effort: 'high', promptOverride: 'CUSTOM PROMPT' });
    await x.orch.sendUser('hello');
    const row = x.db.sessions.latest('orchestrator')!;
    expect(row.model).toBe('fable');
    const s = x.fake.sessions.get(x.sessions.handleOf(row.id)!.id)!;
    expect(s.opts.effort).toBe('high');
    const promptFile = path.join(x.config.orchestratorDir, 'prompt.md');
    expect(s.opts.systemPromptFile).toBe(promptFile);
    expect(fs.readFileSync(promptFile, 'utf8')).toBe('CUSTOM PROMPT');
    expect(x.orch.status().model).toBe('fable');
  });

  it('resumes the previous native session after a restart', async () => {
    const x = setup();
    x.db.accounts.insert({ id: 'a1', name: 'Work Claude', harness: 'claude', kind: 'oauth_token', secret: 'token', home: null, created_at: 't0', last_login_at: null, last_verified_at: null });
    x.db.settings.set('orchestrator', { model: null, effort: null, promptOverride: null, account: 'a1' });
    x.db.sessions.insert({ id: 'old', harness: 'claude', role: 'orchestrator', bead_id: null, repo_id: null, native_session_id: 'native-old', pid: null, pid_started_at: null, start_commit: null, cwd: x.config.orchestratorDir, status: 'ended', started_at: '2026-01-01T00:00:00.000Z', ended_at: new Date(Date.now() - 60_000).toISOString(), cost: null, batch_id: null, log_path: null, log_offset: 0, tier: null, model: null });
    await x.orch.sendUser('again');
    const row = x.db.sessions.latest('orchestrator')!;
    expect(row.id).not.toBe('old');
    const s = x.fake.sessions.get(x.sessions.handleOf(row.id)!.id)!;
    expect(s.opts.resumeId).toBe('native-old');
    expect(row.account).toBe('a1');
    expect(s.opts.env).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: 'token', ANTHROPIC_API_KEY: undefined });
  });

  it('records the running model on a resumed session without passing it to the CLI', async () => {
    const x = setup();
    x.db.accounts.insert({ id: 'a1', name: 'Work Claude', harness: 'claude', kind: 'oauth_token', secret: 'token', home: null, created_at: 't0', last_login_at: null, last_verified_at: null });
    x.db.settings.set('orchestrator', { model: 'opus', effort: 'high', promptOverride: null, account: 'a1' });
    // The live row this resumes: the setting was `opus`, but the old code recorded null and the harness resolved claude-opus-5.
    x.db.sessions.insert({ id: 'old', harness: 'claude', role: 'orchestrator', bead_id: null, repo_id: null, native_session_id: 'native-old', pid: null, pid_started_at: null, start_commit: null, cwd: x.config.orchestratorDir, status: 'ended', started_at: '2026-01-01T00:00:00.000Z', ended_at: new Date(Date.now() - 60_000).toISOString(), cost: null, batch_id: null, log_path: null, log_offset: 0, tier: null, model: null, resolved_model: 'claude-opus-5' });
    await x.orch.sendUser('again');
    const row = x.db.sessions.latest('orchestrator')!;
    const s = x.fake.sessions.get(x.sessions.handleOf(row.id)!.id)!;
    // The model setting cannot change the resumed CLI thread, so the CLI is not told one; the row still says what it runs.
    expect(s.opts.resumeId).toBe('native-old');
    expect(s.opts.model).toBeUndefined();
    expect(row.model).toBe('claude-opus-5');
  });

  it('records the configured model on a resumed session whose own row never learned one', async () => {
    const x = setup();
    x.db.accounts.insert({ id: 'a1', name: 'Work Claude', harness: 'claude', kind: 'oauth_token', secret: 'token', home: null, created_at: 't0', last_login_at: null, last_verified_at: null });
    x.db.settings.set('orchestrator', { model: 'opus', effort: null, promptOverride: null, account: 'a1' });
    x.db.sessions.insert({ id: 'old', harness: 'claude', role: 'orchestrator', bead_id: null, repo_id: null, native_session_id: 'native-old', pid: null, pid_started_at: null, start_commit: null, cwd: x.config.orchestratorDir, status: 'ended', started_at: '2026-01-01T00:00:00.000Z', ended_at: new Date(Date.now() - 60_000).toISOString(), cost: null, batch_id: null, log_path: null, log_offset: 0, tier: null, model: null });
    await x.orch.sendUser('again');
    const row = x.db.sessions.latest('orchestrator')!;
    const s = x.fake.sessions.get(x.sessions.handleOf(row.id)!.id)!;
    expect(s.opts.model).toBeUndefined();
    expect(row.model).toBe('opus');
  });

  it('does not resume a session older than the idle window and sends a preamble', async () => {
    const x = setup();
    x.db.repos.insert({ id: 'r1', path: '/r1', base_branch: 'main', verify_command: null, setup_command: null, merge_mode: 'local-merge', batch_approver: 'user', worker_limit: 2 , review_rounds: 2});
    x.db.repos.insert({ id: 'r2', path: '/r2', base_branch: 'dev', verify_command: 'pnpm test', setup_command: null, merge_mode: 'gitlab-mr', batch_approver: 'user', worker_limit: 1 , review_rounds: 2});
    x.db.accounts.insert({ id: 'account-1', name: 'Sample Claude Account', label: null, harness: 'claude', kind: 'oauth_token', secret: 'fixture-token', home: null, created_at: 't0', last_login_at: null, last_verified_at: null });
    x.db.repos.update('r1', { model_filter: { harnesses: ['claude'], models: ['future-model', 'opus-model'], accounts: ['account-1'] } });
    x.db.batches.insert({ id: 'r1-b1', repo_id: 'r1', title: 'Trend chart', branch: 'feature/trend-chart', base_branch: 'main', status: 'open', note: null, history: null, mr_url: null, conflict_files: null, created_at: 't', updated_at: 't', merged_at: null, merged_commit: null, setup_at: null, waiting_on: null, overlap_files: null });
    x.db.batches.insert({ id: 'r1-b2', repo_id: 'r1', title: 'Note file', branch: 'feature/note-file', base_branch: 'main', status: 'review', note: null, history: null, mr_url: null, conflict_files: null, created_at: 't2', updated_at: 't2', merged_at: null, merged_commit: null, setup_at: null, waiting_on: null, overlap_files: null });
    x.db.worktrees.upsert({ bead_id: 'ov-9', repo_id: 'r1', path: '/wt9', branch: 'bead/ov-9', base_branch: 'feature/note-file', verify_status: 'pass', verify_output: null, review_note: null, conflict_files: null, merged_at: 't2', mr_url: null, batch_id: 'r1-b2', closed_at: null, review_round: null, review_findings: null, accepted_note: null });
    x.db.batches.insert({ id: 'r1-b3', repo_id: 'r1', title: 'Old one', branch: 'feature/old-one', base_branch: 'main', status: 'merged', note: null, history: null, mr_url: null, conflict_files: null, created_at: 't0', updated_at: 't0', merged_at: 't0', merged_commit: 'abc', setup_at: null, waiting_on: null, overlap_files: null });
    x.db.sessions.insert({ id: 'old', harness: 'claude', role: 'orchestrator', bead_id: null, repo_id: null, native_session_id: 'native-old', pid: null, pid_started_at: null, start_commit: null, cwd: x.config.orchestratorDir, status: 'ended', started_at: '2026-01-01T00:00:00.000Z', ended_at: '2026-01-01T00:01:00.000Z', cost: null, batch_id: null, log_path: null, log_offset: 0, tier: null, model: null });
    await x.orch.sendUser('hello again');
    const row = x.db.sessions.latest('orchestrator')!;
    const s = x.fake.sessions.get(x.sessions.handleOf(row.id)!.id)!;
    expect(s.opts.resumeId).toBeUndefined();
    expect(s.opts.prompt).toMatch(/^\[Overseer\] New orchestrator session/);
    // Every batch carries its status; round 9: a fresh session read "1/1 beads done" on a batch in review as "already merged".
    expect(s.opts.prompt).toContain('Batches (a batch in review is awaiting the user\'s review and is not merged, whatever its beads-done count): r1-b1 "Trend chart" on feature/trend-chart: open, 0/0 beads done; r1-b2 "Note file" on feature/note-file: in review (awaiting the user\'s review, not merged), 1/1 beads done; finished: r1-b3 "Old one" on feature/old-one: merged, 0/0 beads done. Call list_tasks');
    // The repo configuration rides along, so the orchestrator knows the verify command and merge mode without guessing (round 7).
    expect(s.opts.prompt).toContain('Repositories: r1 (base main, merge mode local-merge, no verify command configured, model filter: harnesses claude; models future-model, opus-model; accounts Sample Claude Account); r2 (base dev, merge mode gitlab-mr, verify command `pnpm test`)');
    // The dashboard's clock rides along: a time read straight out of a tool is UTC and was quoted two hours off (round 19 R19-4).
    expect(s.opts.prompt).toContain(`Call list_tasks before acting. The dashboard shows local time, which is ${localZone()}.`);
    // Known offsets, so an inverted sign or a lost half hour fails here: getTimezoneOffset counts minutes behind UTC.
    const at = (offsetMinutes: number) => localZone({ getTimezoneOffset: () => offsetMinutes } as Date);
    expect(at(-330)).toBe('UTC+05:30'); // India, 5.5 hours ahead
    expect(at(300)).toBe('UTC-05:00'); // New York in winter, 5 hours behind
    expect(at(0)).toBe('UTC+00:00');
    expect(s.opts.prompt.endsWith('hello again')).toBe(true);
  });

  it('reports busy only while a turn is in progress', async () => {
    const x = setup();
    await x.orch.sendUser('hello');
    expect(x.orch.status()).toMatchObject({ status: 'running', busy: true });
    const h = x.sessions.handleOf(x.db.sessions.latest('orchestrator')!.id)!;
    x.fake.emit(h, { type: 'turn_end', nativeSessionId: 'n1', cost: 0.1 });
    await until(() => !x.orch.status().busy);
    expect(x.orch.status()).toMatchObject({ status: 'running', busy: false }); // live between turns: waiting, not thinking
    await x.orch.systemMessage('ov-1 landed');
    expect(x.orch.status().busy).toBe(true);
    // A notice delivered mid-turn pipelines a second turn: the first turn_end must not read as "waiting" while the second runs.
    await x.orch.systemMessage('ov-2 landed');
    x.fake.emit(h, { type: 'turn_end', nativeSessionId: 'n1', cost: 0.1 });
    expect(x.orch.status().busy).toBe(true);
    x.fake.emit(h, { type: 'turn_end', nativeSessionId: 'n1', cost: 0.1 });
    await until(() => !x.orch.status().busy);
    // A send that throws must not leave "thinking" stuck.
    const queued = x.db.chat.insert({ role: 'system', kind: 'message', text: 'ov-queued landed', queued: true });
    const send = x.sessions.send.bind(x.sessions);
    x.sessions.send = async () => { throw new Error('pipe closed'); };
    await expect(x.orch.systemMessage('ov-3 landed')).rejects.toThrow('pipe closed');
    x.sessions.send = send;
    expect(x.orch.status().busy).toBe(false);
    expect(x.db.chat.queued().map((row) => row.id)).toEqual([queued.id]);
  });

  it('reports the context of the last main-thread request once its model window is known', async () => {
    const x = setup();
    await x.orch.sendUser('hello');
    const h = x.sessions.handleOf(x.db.sessions.latest('orchestrator')!.id)!;
    x.fake.emit(h, { type: 'context', tokens: 50_000, model: 'claude-x' });
    x.fake.emit(h, { type: 'turn_end', nativeSessionId: 'n1', cost: 0.1 });
    await until(() => !x.orch.status().busy);
    expect(x.orch.status().context).toBeNull(); // no window reported yet
    x.fake.emit(h, { type: 'context', tokens: 60_000, model: 'claude-x' });
    x.fake.emit(h, { type: 'turn_end', nativeSessionId: 'n1', cost: 0.2, contextWindows: { 'claude-x': 200_000 } });
    await until(() => x.orch.status().context !== null);
    expect(x.orch.status().context).toEqual({ tokens: 60_000, window: 200_000 });
  });

  it('reports thinking at the start of a turn, tool during a call, thinking between calls and idle at turn end', async () => {
    const x = setup();
    const seen: OrchestratorActivity[] = [];
    x.bus.on('orchestrator:activity', (a) => seen.push(a));
    await x.orch.sendUser('hello');
    expect(seen.map((a) => a.state)).toEqual(['thinking']);
    const h = x.sessions.handleOf(x.db.sessions.latest('orchestrator')!.id)!;
    x.fake.emit(h, { type: 'tool_call', id: 't1', name: 'Bash', input: { command: 'pnpm test', description: 'Run the unit suite' } });
    await until(() => seen.length === 2);
    expect(seen[1]).toMatchObject({ state: 'tool', tool: 'Bash', summary: 'Run the unit suite' });
    expect(Date.parse(seen[1]!.started_at)).toBeGreaterThan(0);
    x.fake.emit(h, { type: 'tool_result', id: 't1', output: 'secret output that must not travel' });
    await until(() => seen.length === 3);
    expect(seen[2]).toMatchObject({ state: 'thinking', tool: null, summary: null });
    expect(JSON.stringify(seen)).not.toContain('secret output');
    x.fake.emit(h, { type: 'turn_end', nativeSessionId: 'n1', cost: 0.1 });
    await until(() => seen.length === 4);
    expect(seen[3]!.state).toBe('idle');
    expect(x.orch.currentActivity().state).toBe('idle');
    // A session that ends mid-turn goes idle too.
    await x.orch.systemMessage('ov-1 landed');
    expect(seen.at(-1)!.state).toBe('thinking');
    x.fake.emit(h, { type: 'error', message: 'exited with code 1' });
    await until(() => seen.at(-1)!.state === 'idle');
  });

  it('summarises a tool call without the full command or any output', () => {
    expect(activitySummary('Bash', { command: 'pnpm test', description: 'Run tests' })).toBe('Run tests');
    const long = 'x'.repeat(200);
    expect(activitySummary('Bash', { command: long })).toBe(`${'x'.repeat(80)}…`);
    expect(activitySummary('PowerShell', { command: 'git   status\n  --short' })).toBe('git status --short');
    expect(activitySummary('mcp__overseer__worker_status', { repo: 'r', bead_id: 'r-1' })).toBe('checking worker status for r-1');
    expect(activitySummary('mcp__overseer__list_batches', {})).toBe('listing batches');
    expect(activitySummary('mcp__overseer__bd', { repo: 'r', args: ['show', 'r-1'] })).toBe('running bd show');
    expect(activitySummary('mcp__overseer__new_tool', {})).toBe('new_tool');
    expect(activitySummary('Read', { file_path: '/x' })).toBe('Read');
  });

  it('keeps queued notices when the session cannot be started', async () => {
    const x = setup();
    const broken = new Orchestrator({ db: x.db, sessions: new SessionManager(x.db, {}, x.bus, path.join(x.config.dataDir, 'broken-sessions')), bus: x.bus, config: x.config }); // no claude adapter
    await broken.systemMessage('Batch r1-b1 merged by the user');
    const error = vi.spyOn(log, 'error').mockImplementation(() => {});
    try {
      await broken.sendUser('hello');
      expect(x.db.chat.queued().map((c) => c.text)).toEqual(['Batch r1-b1 merged by the user']); // still waiting for a turn that exists
      expect(x.db.chat.all().at(-1)?.text).toBe('Message saved but not delivered: harness claude is not available');
    } finally {
      error.mockRestore();
    }
  });

  it('ends an idle live session before delivering and on reset', async () => {
    const x = setup();
    x.config.orchestratorIdleMs = 50;
    await x.orch.sendUser('one');
    const first = x.db.sessions.latest('orchestrator')!;
    await new Promise((r) => setTimeout(r, 80));
    await x.orch.sendUser('two');
    await until(() => x.db.sessions.get(first.id)?.status === 'ended');
    const second = x.db.sessions.latest('orchestrator')!;
    expect(second.id).not.toBe(first.id);
    expect(x.fake.sessions.get(x.sessions.handleOf(second.id)!.id)!.opts.prompt).toContain('two');
    await x.orch.reset();
    await until(() => x.db.sessions.get(second.id)?.status === 'ended');
    expect(x.db.chat.all().at(-1)).toMatchObject({ role: 'system', text: expect.stringMatching(/^New orchestrator session/) });
    expect(x.orch.status().status).toBe('idle'); // not "ended": the next message starts a fresh session
    expect(x.orch.status().last_activity_at).toBeTruthy();
  });

  it('delivers answers and system messages', async () => {
    const x = setup();
    await x.orch.sendUser('start');
    const h = x.sessions.handleOf(x.db.sessions.latest('orchestrator')!.id)!;
    const q = x.db.chat.insert({ role: 'assistant', kind: 'question', text: 'Which DB?' });
    await x.orch.answer(q.id, 'sqlite');
    expect(x.db.chat.get(q.id)?.answer).toBe('sqlite');
    expect(x.fake.sent(h)[1]).toBe('Answer to question #' + q.id + ' ("Which DB?"): sqlite');
    await x.orch.systemMessage('Merge of ov-1 conflicted in: a.ts', { hint: 'Reject it and re-dispatch to rebase.' });
    expect(x.fake.sent(h)[2]).toBe('[Overseer] Merge of ov-1 conflicted in: a.ts Reject it and re-dispatch to rebase.');
    expect(x.db.chat.all().at(-1)).toMatchObject({ role: 'system', text: 'Merge of ov-1 conflicted in: a.ts' });
    expect(x.db.chat.all().at(-1)).not.toHaveProperty('hint');
    await expect(x.orch.answer(999, 'x')).rejects.toThrow(/question 999/);
  });

  it('queues notices while no session is live and carries them at the start of the next turn', async () => {
    const x = setup();
    let chatEvents = 0;
    x.bus.on('chat', () => chatEvents++);
    await x.orch.systemMessage('ov-1 landed on feature/x (1/2 beads done)');
    await x.orch.systemMessage('Batch r1-b2 merged by the user', { hint: 'Nothing to do.' });
    expect(x.db.sessions.latest('orchestrator')).toBeUndefined(); // nothing to wake: the notices wait
    expect(x.db.chat.all().map((c) => [c.role, c.queued_at !== null])).toEqual([['system', true], ['system', true]]);
    expect(chatEvents).toBe(2);
    await x.orch.sendUser('what happened?');
    const row = x.db.sessions.latest('orchestrator')!;
    const prompt = x.fake.sessions.get(x.sessions.handleOf(row.id)!.id)!.opts.prompt;
    expect(prompt).toContain('[Overseer] Notices while no orchestrator session was live:\n- ov-1 landed on feature/x (1/2 beads done)\n- Batch r1-b2 merged by the user Nothing to do.'); // the hint is queued with it
    expect(prompt.endsWith('what happened?')).toBe(true);
    expect(x.db.chat.queued()).toHaveLength(0);
    expect(x.db.chat.all().every((c) => c.queued_at === null)).toBe(true);
  });

  it('starts the orchestrator for a notice that needs a decision when no session is live', async () => {
    const x = setup();
    await x.orch.systemMessage('ov-1 reopened: verification failed', { wake: true });
    const row = x.db.sessions.latest('orchestrator')!;
    expect(x.orch.status().status).toBe('running');
    const prompt = x.fake.sessions.get(x.sessions.handleOf(row.id)!.id)!.opts.prompt;
    expect(prompt.endsWith('[Overseer] ov-1 reopened: verification failed')).toBe(true);
    expect(x.db.chat.all().at(-1)).toMatchObject({ role: 'system', text: 'ov-1 reopened: verification failed', queued_at: null });
    // With the session live, a plain notice goes straight to it, so nothing queues.
    await x.orch.systemMessage('ov-2 landed');
    expect(x.fake.sent(x.sessions.handleOf(row.id)!).at(-1)).toBe('[Overseer] ov-2 landed');
    expect(x.db.chat.queued()).toHaveLength(0);
  });

  it('writes a quiet notice to the chat and the bead notes without a turn and carries it once on the next turn', async () => {
    const x = setup();
    await x.orch.sendUser('start');
    const h = x.sessions.handleOf(x.db.sessions.latest('orchestrator')!.id)!;
    const sentBefore = x.fake.sent(h).length;
    const quiet = 'Batch r1-b1 no longer waits: r1-b0 left review, so its Merge is available.';
    await x.orch.systemMessage(quiet);
    await x.orch.systemMessage('ov-1 re-dispatched after a transient stream failure on claude (event stream failed).', { hint: 'This automatic re-dispatch needs no action.', beadId: 'ov-1' });
    expect(x.fake.sent(h)).toHaveLength(sentBefore); // no turn started
    // The bead's notes get the notice; the batch release names no bead, so it notes nothing.
    expect(x.notes).toEqual([['ov-1', 'ov-1 re-dispatched after a transient stream failure on claude (event stream failed).']]);
    expect(x.db.chat.all().filter((c) => c.role === 'system').map((c) => c.text)).toContain(quiet); // the user still sees it
    expect(x.db.chat.queued()).toHaveLength(2);

    await x.orch.systemMessage('ov-2 reopened: verification failed', { beadId: 'ov-2' }); // a notice that is not quiet still starts a turn
    expect(x.notes).toHaveLength(1); // and its notes stay the lifecycle's own
    expect(x.fake.sent(h)).toHaveLength(sentBefore + 1);
    expect(x.fake.sent(h).at(-1)).toBe(`[Overseer] Since your last turn:\n- ${quiet}\n- ov-1 re-dispatched after a transient stream failure on claude (event stream failed). This automatic re-dispatch needs no action.\n\n[Overseer] ov-2 reopened: verification failed`);
    expect(x.db.chat.queued()).toHaveLength(0);

    await x.orch.sendUser('next');
    expect(x.fake.sent(h).at(-1)).toBe('next'); // not delivered twice
  });

  it('holds a quiet notice while no session is live and delivers it with the first turn of the next one', async () => {
    const x = setup();
    await x.orch.systemMessage('Stopped 1 process(es) left running in C:/wt/r1/ov-1: 11 (node)', { beadId: 'ov-1' });
    expect(x.notes).toEqual([['ov-1', 'Stopped 1 process(es) left running in C:/wt/r1/ov-1: 11 (node)']]);
    await x.orch.systemMessage('ov-9 landed');
    expect(x.db.sessions.latest('orchestrator')).toBeUndefined();
    await x.orch.sendUser('hi');
    const row = x.db.sessions.latest('orchestrator')!;
    const prompt = x.fake.sessions.get(x.sessions.handleOf(row.id)!.id)!.opts.prompt;
    expect(prompt).toContain('[Overseer] Since your last turn:\n- Stopped 1 process(es) left running in C:/wt/r1/ov-1: 11 (node)\n\n[Overseer] Notices while no orchestrator session was live:\n- ov-9 landed\n\nhi');
    expect(x.db.chat.queued()).toHaveLength(0);
  });

  it('closes only IDs captured at draft start, immediately and at turn end', async () => {
    const x = setup();
    await x.orch.sendUser('start');
    const h = x.sessions.handleOf(x.db.sessions.latest('orchestrator')!.id)!;
    x.fake.emit(h, { type: 'turn_end', nativeSessionId: 'n', cost: 0 });
    const q1 = x.db.chat.insert({ role: 'assistant', kind: 'question', text: 'Which DB?' });
    const q2 = x.db.chat.insert({ role: 'assistant', kind: 'question', text: 'Which port?' });
    // An answer to one question does not close the other: the orchestrator may still wait for it.
    await x.orch.answer(q1.id, 'sqlite');
    x.fake.emit(h, { type: 'turn_end', nativeSessionId: 'n', cost: 0 });
    expect(x.db.chat.pendingQuestions().map((c) => c.id)).toEqual([q2.id]);
    // This question arrives after the draft starts, so it is older than the sent row but absent from the snapshot.
    const q3 = x.db.chat.insert({ role: 'assistant', kind: 'question', text: 'Anything else?' });
    let chatEvents = 0;
    x.bus.on('chat', () => chatEvents++);
    await x.orch.sendUser('forget the port, use the default', [], [q2.id]);
    // The orchestrator is told at once, in the delivery only: it otherwise reported the question as waiting for turns after the UI closed it (round 8).
    expect(x.fake.sent(h).at(-1)).toBe(`[Overseer] The user replied in the composer rather than in the answer box of question #${q2.id} ("Which port?"). If this message answers it, take it as the answer; either way the question is closed and no separate answer will come, so do not report it as waiting.\n\nforget the port, use the default`);
    expect(x.db.chat.all().at(-1)).toMatchObject({ role: 'user', text: 'forget the port, use the default' });
    expect(x.db.chat.get(q2.id)?.superseded_at).not.toBeNull();
    expect(x.db.chat.pendingQuestions().map((c) => c.id)).toEqual([q3.id]);
    expect(chatEvents).toBe(2); // the user row and the supersede
    x.fake.emit(h, { type: 'turn_end', nativeSessionId: 'n', cost: 0 });
    expect(x.db.chat.pendingQuestions().map((c) => c.id)).toEqual([q3.id]);
    expect(chatEvents).toBe(2); // the turn end cannot close a question outside the snapshot
    // A dismissed question is closed the same way.
    x.db.chat.supersede(q3.id);
    expect(x.db.chat.pendingQuestions()).toHaveLength(0);
  });

  it('treats an explicit empty snapshot as none and adds no delivery prefix', async () => {
    const x = setup();
    await x.orch.sendUser('start');
    const h = x.sessions.handleOf(x.db.sessions.latest('orchestrator')!.id)!;
    x.fake.emit(h, { type: 'turn_end', nativeSessionId: 'n', cost: 0 });
    const q1 = x.db.chat.insert({ role: 'assistant', kind: 'question', text: 'Which database?' });
    const q2 = x.db.chat.insert({ role: 'assistant', kind: 'question', text: 'Which port?' });
    await x.orch.sendUser('plain message', [], []);
    expect({ pending: x.db.chat.pendingQuestions().map((q) => q.id), delivery: x.fake.sent(h).at(-1) }).toEqual({ pending: [q1.id, q2.id], delivery: 'plain message' });
  });

  it('keeps legacy close-all behavior when the question list is absent', async () => {
    const x = setup();
    await x.orch.sendUser('start');
    const h = x.sessions.handleOf(x.db.sessions.latest('orchestrator')!.id)!;
    x.fake.emit(h, { type: 'turn_end', nativeSessionId: 'n', cost: 0 });
    const q1 = x.db.chat.insert({ role: 'assistant', kind: 'question', text: 'Which database?' });
    const q2 = x.db.chat.insert({ role: 'assistant', kind: 'question', text: 'Which port?' });
    await x.orch.sendUser('move on');
    expect({ pending: x.db.chat.pendingQuestions().map((q) => q.id), delivery: x.fake.sent(h).at(-1) }).toEqual({
      pending: [],
      delivery: `[Overseer] The user replied in the composer rather than in the answer box of question #${q1.id} (\"Which database?\") and question #${q2.id} (\"Which port?\"). If this message answers them, take it as the answer; either way the questions are closed and no separate answer will come, so do not report them as waiting.\n\nmove on`,
    });
  });

  it('ignores answered and dismissed IDs and names only the pending question it closes', async () => {
    const x = setup();
    await x.orch.sendUser('start');
    const h = x.sessions.handleOf(x.db.sessions.latest('orchestrator')!.id)!;
    x.fake.emit(h, { type: 'turn_end', nativeSessionId: 'n', cost: 0 });
    const answered = x.db.chat.insert({ role: 'assistant', kind: 'question', text: 'Answered already?' });
    const dismissed = x.db.chat.insert({ role: 'assistant', kind: 'question', text: 'Dismissed already?' });
    const selected = x.db.chat.insert({ role: 'assistant', kind: 'question', text: 'Still pending?' });
    const notSelected = x.db.chat.insert({ role: 'assistant', kind: 'question', text: 'Another pending?' });
    x.db.chat.answer(answered.id, 'yes');
    x.db.chat.supersede(dismissed.id);
    await x.orch.sendUser('reply', [], [answered.id, dismissed.id, selected.id, selected.id]);
    expect({ pending: x.db.chat.pendingQuestions().map((q) => q.id), delivery: x.fake.sent(h).at(-1) }).toEqual({
      pending: [notSelected.id],
      delivery: `[Overseer] The user replied in the composer rather than in the answer box of question #${selected.id} (\"Still pending?\"). If this message answers it, take it as the answer; either way the question is closed and no separate answer will come, so do not report it as waiting.\n\nreply`,
    });
  });

  it('New session supersedes the questions the ended session asked (round 22 R22-2)', async () => {
    const x = setup();
    await x.orch.sendUser('start');
    const q = x.db.chat.insert({ role: 'assistant', kind: 'question', text: 'Put the batch up for review?' });
    expect(x.db.chat.pendingQuestions().map((c) => c.id)).toEqual([q.id]);
    let pendingAtNotice: number[] | null = null;
    const insert = x.db.chat.insert;
    vi.spyOn(x.db.chat, 'insert').mockImplementation((c) => {
      if (c.text.startsWith('New orchestrator session')) pendingAtNotice = x.db.chat.pendingQuestions().map((p) => p.id);
      return insert(c);
    });
    await x.orch.reset();
    // Nothing waits for an answer the orchestrator that asked can no longer receive; the thread keeps the question, marked as closed.
    expect(x.db.chat.pendingQuestions()).toHaveLength(0);
    expect(x.db.chat.get(q.id)?.superseded_at).not.toBeNull();
    expect(x.db.chat.get(q.id)?.answered_at).toBeNull();
    // The question was asked before the click, so it keeps its place above the notice that closed it: the thread sorts a resolved
    // question by the moment it was resolved, and superseding before the notice row exists puts that moment at or before the
    // notice's (ties go to the lower id, which is the question's). Round 23 R23-2: the question sorted below the notice and still
    // read as "Orchestrator", so a fresh session appeared to ask something it immediately disowned.
    const notice = x.db.chat.all().at(-1)!;
    expect(notice.text).toMatch(/^New orchestrator session/);
    expect(notice.id).toBeGreaterThan(q.id);
    expect(x.db.chat.get(q.id)!.superseded_at! <= notice.ts).toBe(true);
    expect(pendingAtNotice).toEqual([]); // superseded before the notice row existed, whatever the clock does between the two writes
  });

  it('reports idle, not ended, in a daemon that has not started a session yet (after a restart)', async () => {
    const x = setup();
    await x.orch.sendUser('one');
    const first = x.db.sessions.latest('orchestrator')!;
    await x.sessions.end(first.id);
    await until(() => !x.sessions.isLive(first.id));
    const restarted = new Orchestrator({ db: x.db, sessions: x.sessions, bus: x.bus, config: x.config });
    expect(restarted.status()).toMatchObject({ status: 'idle', last_activity_at: expect.any(String) });
  });

  it('restarts the session after it ended', async () => {
    const x = setup();
    await x.orch.sendUser('one');
    const first = x.db.sessions.latest('orchestrator')!;
    await x.sessions.end(first.id);
    await until(() => !x.sessions.isLive(first.id));
    expect(x.orch.status().status).toBe('ended');
    await x.orch.sendUser('two');
    const second = x.db.sessions.latest('orchestrator')!;
    expect(second.id).not.toBe(first.id);
    expect(x.orch.status().status).toBe('running');
  });

  it('starts a fresh session when the previous one crashed before its first turn_end', async () => {
    const x = setup({ claude: new SpawnIdAdapter() });
    await x.orch.sendUser('first');
    const first = x.db.sessions.latest('orchestrator')!;
    // The adapter chose an id at spawn, but the process died before any turn_end: there is no transcript to resume.
    expect(x.sessions.handleOf(first.id)!.nativeId).toBe('spawn-native');
    expect(x.db.sessions.get(first.id)?.native_session_id).toBeNull();
    await x.sessions.end(first.id);
    await until(() => !x.sessions.isLive(first.id));

    await x.orch.sendUser('second');

    const second = x.db.sessions.latest('orchestrator')!;
    expect(second.id).not.toBe(first.id);
    const s = x.fake.sessions.get(x.sessions.handleOf(second.id)!.id)!;
    expect(s.opts.resumeId).toBeUndefined(); // no --resume on a session whose first turn never finished
    expect(s.opts.prompt).toMatch(/^\[Overseer\] New orchestrator session/);
  });

  it('sends to the running process when the session token still has more than the refresh margin', async () => {
    const x = setup();
    addOauthAccount(x);
    useOauthAccount(x);
    await x.orch.sendUser('hello');
    const first = x.db.sessions.latest('orchestrator')!;
    const h = x.sessions.handleOf(first.id)!;
    x.fake.emit(h, { type: 'turn_end', nativeSessionId: 'native-1', cost: 0 });
    await until(() => x.orch.status().native_session_id === 'native-1');

    const startSpy = vi.spyOn(x.sessions, 'start');
    await x.orch.sendUser('again');

    expect(startSpy).not.toHaveBeenCalled();
    expect(x.db.sessions.latest('orchestrator')!.id).toBe(first.id);
    expect(x.fake.sent(h)).toHaveLength(2);
    expect(x.fake.sent(h).at(-1)).toBe('again');
  });

  it('resumes on the account\'s refreshed token when it changed since the session started, keeping open questions', async () => {
    const x = setup();
    addOauthAccount(x);
    useOauthAccount(x);
    await x.orch.sendUser('hello');
    const first = x.db.sessions.latest('orchestrator')!;
    const h = x.sessions.handleOf(first.id)!;
    x.fake.emit(h, { type: 'turn_end', nativeSessionId: 'native-1', cost: 0 });
    await until(() => x.orch.status().native_session_id === 'native-1');
    const question = x.db.chat.insert({ role: 'assistant', kind: 'question', text: 'Which DB?' });
    // The account was refreshed or logged in again since the session started, so its stored token is newer than the session's.
    x.db.accounts.update('a1', { secret: 'new-access', token_expires_at: Date.now() + 5 * 60 * 60_000 });

    await x.orch.systemMessage('carry on');

    await until(() => x.db.sessions.latest('orchestrator')!.id !== first.id);
    const second = x.db.sessions.latest('orchestrator')!;
    const h2 = x.sessions.handleOf(second.id)!;
    await until(() => x.fake.sent(h2).length >= 1);
    expect(x.fake.sessions.get(h2.id)!.opts.resumeId).toBe('native-1');
    expect(x.fake.sessions.get(h2.id)!.opts.env).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: 'new-access', ANTHROPIC_API_KEY: undefined });
    expect(x.fake.sent(h2)).toEqual(['[Overseer] carry on']);
    expect(x.db.chat.all().some((row) => row.text.startsWith('New orchestrator session'))).toBe(false);
    expect(x.db.chat.pendingQuestions().map((row) => row.id)).toEqual([question.id]);
  });

  it('refreshes and resumes a live session inside the token margin even when the usage gate would refuse', async () => {
    const usageGate = vi.fn<typeof accountUsable>()
      .mockResolvedValueOnce({ usable: true })
      .mockResolvedValue({ usable: false, reason: 'account Primary: session 83% >= 83%' });
    const x = setup({ usageGate });
    addOauthAccount(x);
    useOauthAccount(x);
    x.db.settings.set('orchestrator', { model: 'fable', effort: null, promptOverride: null, account: 'a1' });
    await x.orch.sendUser('hello');
    const first = x.db.sessions.latest('orchestrator')!;
    const h = x.sessions.handleOf(first.id)!;
    x.fake.emit(h, { type: 'turn_end', nativeSessionId: 'native-1', cost: 0 });
    await until(() => x.orch.status().native_session_id === 'native-1');
    // The token now has an hour left, inside the two-hour refresh margin.
    const within = Date.now() + 60 * 60_000;
    x.db.sessions.update(first.id, { token_expires_at: within });
    x.db.accounts.update('a1', { token_expires_at: within });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ access_token: 'fresh-access', refresh_token: 'rotated', expires_in: 7200 }), { status: 200 }));

    try {
      await x.orch.sendUser('carry on');
      await until(() => x.db.sessions.latest('orchestrator')!.id !== first.id);
      const second = x.db.sessions.latest('orchestrator')!;
      const h2 = x.sessions.handleOf(second.id)!;
      await until(() => x.fake.sent(h2).length >= 1);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(x.fake.sessions.get(h2.id)!.opts.resumeId).toBe('native-1');
      expect(x.fake.sessions.get(h2.id)!.opts.env).toMatchObject({ CLAUDE_CODE_OAUTH_TOKEN: 'fresh-access' });
      expect(x.fake.sent(h2)).toEqual(['carry on']);
      expect(x.db.chat.all().some((row) => row.text.startsWith('New orchestrator session'))).toBe(false);
      expect(second.status).toBe('running');
      expect(x.sessions.isLive(second.id)).toBe(true);
      expect(x.db.sessions.running().filter((session) => session.role === 'orchestrator')).toHaveLength(1);
      expect(x.db.chat.all().find((row) => row.role === 'user' && row.text === 'carry on')).toMatchObject({ seen_at: expect.any(String), failed_for: null });
      expect(x.db.chat.all().some((row) => row.text.includes('was not resumed because'))).toBe(false);
      expect(usageGate).toHaveBeenCalledOnce();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('resumes and re-sends a user message whose turn failed on an expired token', async () => {
    const x = setup();
    addOauthAccount(x);
    useOauthAccount(x);
    await x.orch.sendUser('hello');
    const first = x.db.sessions.latest('orchestrator')!;
    const h = x.sessions.handleOf(first.id)!;
    x.fake.emit(h, { type: 'turn_end', nativeSessionId: AUTH_SESSION_ID, cost: 0 });
    await until(() => x.orch.status().native_session_id === AUTH_SESSION_ID);
    await x.orch.sendUser('do the thing');

    emitAuthTurn(x, h, EXPIRED_TURN);

    await until(() => x.db.sessions.latest('orchestrator')!.id !== first.id);
    const second = x.db.sessions.latest('orchestrator')!;
    const h2 = x.sessions.handleOf(second.id)!;
    await until(() => x.fake.sent(h2).length >= 1);
    expect(x.fake.sessions.get(h2.id)!.opts.resumeId).toBe(AUTH_SESSION_ID);
    expect(x.fake.sent(h2)).toEqual(['do the thing']);
    expect(x.db.chat.all().some((row) => row.text.includes('401'))).toBe(false);
    expect(x.db.chat.all().some((row) => row.text.includes('Failed to authenticate'))).toBe(false);
    // The reply to the re-sent delivery lands in the chat as usual.
    x.fake.emit(h2, { type: 'assistant_text', text: 'done' });
    await until(() => x.db.chat.all().some((row) => row.text === 'done'));
    expect(x.db.chat.all().find((row) => row.text === 'done')?.reply_to).toBe(2);
  });

  it('checks the usage gate before resuming an orchestrator session and keeps the message retryable', async () => {
    const usageGate = vi.fn<typeof accountUsable>()
      .mockResolvedValueOnce({ usable: true })
      .mockResolvedValueOnce({ usable: false, reason: 'account Primary: session 83% >= 83% (85% - 1 running x 2%)' });
    const x = setup({ usageGate });
    addOauthAccount(x);
    useOauthAccount(x);
    await x.orch.sendUser('hello');
    const first = x.db.sessions.latest('orchestrator')!;
    const h = x.sessions.handleOf(first.id)!;
    x.fake.emit(h, { type: 'turn_end', nativeSessionId: AUTH_SESSION_ID, cost: 0 });
    await until(() => x.orch.status().native_session_id === AUTH_SESSION_ID);
    await x.orch.sendUser('do the thing');
    const user = x.db.chat.all().find((row) => row.role === 'user' && row.text.includes('do the thing'))!;

    emitAuthTurn(x, h, EXPIRED_TURN);

    await until(() => x.db.chat.all().some((row) => row.text.includes('orchestrator was not resumed because account Primary: session 83%')));
    const refusal = x.db.chat.all().find((row) => row.text.includes('orchestrator was not resumed because'))!;
    expect(usageGate.mock.calls.map((call) => [call[2], call[3], call[6]])).toEqual([['a1', '', undefined], ['a1', '', first.id]]);
    expect(refusal.failed_for).toBe(user.id);
    expect(x.db.sessions.all().filter((session) => session.role === 'orchestrator')).toHaveLength(1);
    expect(x.db.accounts.get('a1')?.exhausted_until ?? null).toBeNull();
  });

  it('resumes and re-sends a user message whose turn failed on a revoked token', async () => {
    const x = setup();
    addOauthAccount(x);
    useOauthAccount(x);
    await x.orch.sendUser('hello');
    const first = x.db.sessions.latest('orchestrator')!;
    const h = x.sessions.handleOf(first.id)!;
    x.fake.emit(h, { type: 'turn_end', nativeSessionId: AUTH_SESSION_ID, cost: 0 });
    await until(() => x.orch.status().native_session_id === AUTH_SESSION_ID);
    await x.orch.sendUser('do the thing');

    emitAuthTurn(x, h, REVOKED_TURN);

    await until(() => x.db.sessions.latest('orchestrator')!.id !== first.id);
    const second = x.db.sessions.latest('orchestrator')!;
    const h2 = x.sessions.handleOf(second.id)!;
    await until(() => x.fake.sent(h2).length >= 1);
    expect(x.fake.sessions.get(h2.id)!.opts.resumeId).toBe(AUTH_SESSION_ID);
    expect(x.fake.sent(h2)).toEqual(['do the thing']);
    expect(x.db.chat.all().some((row) => row.text.includes('401') || row.text.includes('revoked'))).toBe(false);
  });

  /** A fallback-started orchestrator session: the configured account a1 is unusable, so the run lands on a2. */
  async function startOnFallback(x: ReturnType<typeof setup>) {
    await x.orch.sendUser('hello');
    const first = x.db.sessions.latest('orchestrator')!;
    const h = x.sessions.handleOf(first.id)!;
    return { first, h };
  }

  it('resumes a fallback-started session on its own account when the configured one becomes usable again', async () => {
    const usageGate = vi.fn<typeof accountUsable>(async (_db, _config, accountId) => accountId === 'a1' ? { usable: false, reason: 'account Primary: model fable 95% >= 95%' } : { usable: true });
    const x = setup({ usageGate });
    addOauthAccount(x);
    x.db.accounts.insert({ id: 'a2', name: 'Backup', harness: 'claude', kind: 'oauth_token', secret: 'token-a2', refresh_token: 'r-a2', token_expires_at: Date.now() + 3 * 60 * 60_000, home: null, created_at: 't1', last_login_at: 't0', last_verified_at: null });
    useOauthAccount(x);
    const { first, h } = await startOnFallback(x);
    expect(first.account).toBe('a2');
    x.fake.emit(h, { type: 'turn_end', nativeSessionId: AUTH_SESSION_ID, cost: 0 });
    await until(() => x.orch.status().native_session_id === AUTH_SESSION_ID);
    await x.orch.sendUser('do the thing');
    // a1 is usable again by the time the token fails: the recovery must not move the resume onto it.
    usageGate.mockImplementation(async () => ({ usable: true }));

    emitAuthTurn(x, h, EXPIRED_TURN);

    await until(() => x.db.sessions.latest('orchestrator')!.id !== first.id);
    const second = x.db.sessions.latest('orchestrator')!;
    expect(second.account).toBe('a2');
    const h2 = x.sessions.handleOf(second.id)!;
    await until(() => x.fake.sent(h2).length >= 1);
    expect(x.fake.sessions.get(h2.id)!.opts.resumeId).toBe(AUTH_SESSION_ID);
    expect(x.fake.sent(h2)).toEqual(['do the thing']);
  });

  it('resumes a fallback-started session when the configured account is logged out', async () => {
    const usageGate = vi.fn<typeof accountUsable>(async (_db, _config, accountId) => accountId === 'a1' ? { usable: false, reason: 'account Primary: model fable 95% >= 95%' } : { usable: true });
    const x = setup({ usageGate });
    addOauthAccount(x);
    x.db.accounts.insert({ id: 'a2', name: 'Backup', harness: 'claude', kind: 'oauth_token', secret: 'token-a2', refresh_token: 'r-a2', token_expires_at: Date.now() + 3 * 60 * 60_000, home: null, created_at: 't1', last_login_at: 't0', last_verified_at: null });
    useOauthAccount(x);
    const { first, h } = await startOnFallback(x);
    expect(first.account).toBe('a2');
    x.fake.emit(h, { type: 'turn_end', nativeSessionId: AUTH_SESSION_ID, cost: 0 });
    await until(() => x.orch.status().native_session_id === AUTH_SESSION_ID);
    await x.orch.sendUser('do the thing');
    // The configured account loses its login before the token fails: the session's own account still has a fresh token.
    x.db.accounts.update('a1', { secret: null, refresh_token: null });

    emitAuthTurn(x, h, EXPIRED_TURN);

    await until(() => x.db.sessions.latest('orchestrator')!.id !== first.id);
    const second = x.db.sessions.latest('orchestrator')!;
    expect(second.account).toBe('a2');
    const h2 = x.sessions.handleOf(second.id)!;
    await until(() => x.fake.sent(h2).length >= 1);
    expect(x.fake.sent(h2)).toEqual(['do the thing']);
    expect(x.db.chat.all().some((row) => row.text.startsWith('Account Primary is not logged in'))).toBe(false);
  });

  it('refreshes the failed session account once per recovery', async () => {
    const x = setup();
    addOauthAccount(x);
    useOauthAccount(x);
    await x.orch.sendUser('hello');
    const first = x.db.sessions.latest('orchestrator')!;
    const h = x.sessions.handleOf(first.id)!;
    x.fake.emit(h, { type: 'turn_end', nativeSessionId: AUTH_SESSION_ID, cost: 0 });
    await until(() => x.orch.status().native_session_id === AUTH_SESSION_ID);
    await x.orch.sendUser('do it');
    // The token now has an hour left, inside the two-hour margin, so the recovery refreshes it: exactly once, not again per delivery.
    x.db.accounts.update('a1', { token_expires_at: Date.now() + 60 * 60_000 });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ access_token: 'fresh-access', refresh_token: 'rotated', expires_in: 7200 }), { status: 200 }));

    try {
      emitAuthTurn(x, h, EXPIRED_TURN);
      await until(() => x.db.sessions.latest('orchestrator')!.id !== first.id);
      const second = x.db.sessions.latest('orchestrator')!;
      const h2 = x.sessions.handleOf(second.id)!;
      await until(() => x.fake.sent(h2).length >= 1);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(x.fake.sessions.get(h2.id)!.opts.env).toMatchObject({ CLAUDE_CODE_OAUTH_TOKEN: 'fresh-access' });
      expect(x.fake.sent(h2)).toEqual(['do it']);
      expect(x.db.chat.all().some((row) => row.text.startsWith('Account Primary is not logged in'))).toBe(false);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('resumes when a turn reports auth_failed and the session dies before its turn_end', async () => {
    const x = setup();
    addOauthAccount(x);
    useOauthAccount(x);
    await x.orch.sendUser('hello');
    const first = x.db.sessions.latest('orchestrator')!;
    const h = x.sessions.handleOf(first.id)!;
    x.fake.emit(h, { type: 'turn_end', nativeSessionId: AUTH_SESSION_ID, cost: 0 });
    await until(() => x.orch.status().native_session_id === AUTH_SESSION_ID);
    await x.orch.sendUser('do it');
    // The CLI reports the rejected token, then the process is gone before it ever writes a result line.
    x.fake.emit(h, { type: 'auth_failed', text: 'Failed to authenticate. API Error: 401 OAuth access token has expired. Re-authenticate to continue.', error: 'authentication_failed' });
    await until(() => x.db.events.forSession(first.id).some((event) => event.type === 'auth_failed'));
    await x.sessions.end(first.id);

    await until(() => x.db.sessions.latest('orchestrator')!.id !== first.id);
    const second = x.db.sessions.latest('orchestrator')!;
    const h2 = x.sessions.handleOf(second.id)!;
    await until(() => x.fake.sent(h2).length >= 1);
    expect(x.fake.sessions.get(h2.id)!.opts.resumeId).toBe(AUTH_SESSION_ID);
    expect(x.fake.sent(h2)).toEqual(['do it']);
    expect(x.db.chat.all().some((row) => row.text.includes('401'))).toBe(false);
  });

  it('re-sends a notice, and two deliveries pending at the failure, once each and in order', async () => {
    const x = setup();
    addOauthAccount(x);
    useOauthAccount(x);
    await x.orch.sendUser('hello');
    const first = x.db.sessions.latest('orchestrator')!;
    const h = x.sessions.handleOf(first.id)!;
    x.fake.emit(h, { type: 'turn_end', nativeSessionId: AUTH_SESSION_ID, cost: 0 });
    await until(() => x.orch.status().native_session_id === AUTH_SESSION_ID);

    // A notice turn that fails is delivered again.
    await x.orch.systemMessage('first notice');
    emitAuthTurn(x, h, EXPIRED_TURN);
    await until(() => x.db.sessions.latest('orchestrator')!.id !== first.id);
    const second = x.db.sessions.latest('orchestrator')!;
    const h2 = x.sessions.handleOf(second.id)!;
    await until(() => x.fake.sent(h2).length >= 1);
    expect(x.fake.sent(h2)).toEqual(['[Overseer] first notice']);

    // Two deliveries pending when the failure hits are both delivered again, in order, once each.
    x.fake.emit(h2, { type: 'turn_end', nativeSessionId: AUTH_SESSION_ID, cost: 0 });
    await until(() => !x.orch.status().busy);
    await x.orch.systemMessage('notice one');
    await x.orch.systemMessage('notice two');
    emitAuthTurn(x, h2, REVOKED_TURN);

    await until(() => x.db.sessions.latest('orchestrator')!.id !== second.id);
    const third = x.db.sessions.latest('orchestrator')!;
    const h3 = x.sessions.handleOf(third.id)!;
    await until(() => x.fake.sent(h3).length >= 2);
    expect(x.fake.sent(h3)).toEqual(['[Overseer] notice one', '[Overseer] notice two']);
  });

  it('reports the account as not logged in and re-sends nothing when the refresh is rejected', async () => {
    const x = setup();
    addOauthAccount(x);
    useOauthAccount(x);
    await x.orch.sendUser('hello');
    const first = x.db.sessions.latest('orchestrator')!;
    const h = x.sessions.handleOf(first.id)!;
    x.fake.emit(h, { type: 'turn_end', nativeSessionId: AUTH_SESSION_ID, cost: 0 });
    await until(() => x.orch.status().native_session_id === AUTH_SESSION_ID);
    await x.orch.sendUser('fix it');
    // The stored token now needs a refresh, and the refresh is rejected: the account is really logged out.
    x.db.accounts.update('a1', { token_expires_at: Date.now() - 1 });
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {}); // the rejected refresh is logged, not printed into the test output
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('invalid_grant'));

    try {
      emitAuthTurn(x, h, EXPIRED_TURN);
      await until(() => x.db.chat.all().some((row) => row.text.startsWith('Account Primary is not logged in')));
      const line = x.db.chat.all().find((row) => row.text.startsWith('Account Primary is not logged in'))!;
      expect(line.text).toBe('Account Primary is not logged in, so the orchestrator was not started. invalid_grant. Log in the account from Setup and try again.');
      expect(line.text).not.toContain('401');
      expect(x.fake.sessions.size).toBe(1); // no resumed session was started
      expect(x.fake.sent(h)).toHaveLength(2); // nothing was delivered again
      expect(x.fake.sent(h).at(-1)).toBe('fix it');
    } finally {
      fetchSpy.mockRestore();
      warn.mockRestore();
    }
  });

  it('reports the account as not logged in once when the resumed session fails again', async () => {
    const x = setup();
    addOauthAccount(x);
    useOauthAccount(x);
    await x.orch.sendUser('hello');
    const first = x.db.sessions.latest('orchestrator')!;
    const h = x.sessions.handleOf(first.id)!;
    x.fake.emit(h, { type: 'turn_end', nativeSessionId: AUTH_SESSION_ID, cost: 0 });
    await until(() => x.orch.status().native_session_id === AUTH_SESSION_ID);
    await x.orch.sendUser('do it');
    emitAuthTurn(x, h, EXPIRED_TURN);
    await until(() => x.db.sessions.latest('orchestrator')!.id !== first.id);
    const second = x.db.sessions.latest('orchestrator')!;
    const h2 = x.sessions.handleOf(second.id)!;
    await until(() => x.fake.sent(h2).length >= 1);

    // The resumed session's fresh token is rejected too: the account is really logged out, and there is no third try.
    emitAuthTurn(x, h2, REVOKED_TURN);
    await until(() => x.db.chat.all().some((row) => row.text.startsWith('Account Primary is not logged in')));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(x.db.chat.all().filter((row) => row.text.startsWith('Account Primary is not logged in'))).toHaveLength(1);
    expect(x.fake.sessions.size).toBe(2); // the failed first session and the resumed one, no third
    expect(x.db.chat.all().some((row) => row.text.includes('401'))).toBe(false);
  });

  it('explains a second rejected machine login without showing either raw 401', async () => {
    const x = setup();
    await x.orch.sendUser('hello');
    const first = x.db.sessions.latest('orchestrator')!;
    const h = x.sessions.handleOf(first.id)!;
    x.fake.emit(h, { type: 'turn_end', nativeSessionId: AUTH_SESSION_ID, cost: 0 });
    await until(() => x.orch.status().native_session_id === AUTH_SESSION_ID);
    await x.orch.sendUser('do it');
    emitAuthTurn(x, h, EXPIRED_TURN);
    await until(() => x.db.sessions.latest('orchestrator')!.id !== first.id);
    const second = x.db.sessions.latest('orchestrator')!;
    const h2 = x.sessions.handleOf(second.id)!;
    await until(() => x.fake.sent(h2).length === 1);
    expect(x.fake.sent(h2)).toEqual(['do it']);

    emitAuthTurn(x, h2, REVOKED_TURN);
    await until(() => x.db.chat.all().some((row) => row.text.includes("orchestrator's Claude login was rejected")));
    expect(x.db.chat.all().filter((row) => row.text.includes("orchestrator's Claude login was rejected")).map((row) => row.text))
      .toEqual(["The orchestrator's Claude login was rejected. Log in to the Claude CLI again and try again."]);
    expect(x.db.chat.all().some((row) => row.text.includes('401'))).toBe(false);
    expect(x.fake.sessions.size).toBe(2);
  });

  it('explains each user message refused on the rollover refresh path', async () => {
    const x = setup();
    addOauthAccount(x);
    useOauthAccount(x);
    await x.orch.sendUser('hello');
    const first = x.db.sessions.latest('orchestrator')!;
    const h = x.sessions.handleOf(first.id)!;
    x.fake.emit(h, { type: 'turn_end', nativeSessionId: AUTH_SESSION_ID, cost: 0 });
    await until(() => x.orch.status().native_session_id === AUTH_SESSION_ID);
    x.db.accounts.update('a1', { token_expires_at: Date.now() - 1 });
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('invalid_grant'));
    try {
      await x.orch.sendUser('first');
      await x.orch.sendUser('second');
      expect(x.db.chat.all().filter((row) => row.text.startsWith('Account Primary is not logged in')).map((row) => row.text)).toEqual([
        'Account Primary is not logged in, so the orchestrator was not started. invalid_grant. Log in the account from Setup and try again.',
        'Account Primary is not logged in, so the orchestrator was not started. invalid_grant. Log in the account from Setup and try again.',
      ]);
      expect(x.fake.sessions.size).toBe(1);
    } finally { fetchSpy.mockRestore(); warn.mockRestore(); }
  });

  it('explains each pending user delivery when recovery cannot refresh', async () => {
    const x = setup();
    addOauthAccount(x);
    useOauthAccount(x);
    await x.orch.sendUser('hello');
    const first = x.db.sessions.latest('orchestrator')!;
    const h = x.sessions.handleOf(first.id)!;
    x.fake.emit(h, { type: 'turn_end', nativeSessionId: AUTH_SESSION_ID, cost: 0 });
    await until(() => x.orch.status().native_session_id === AUTH_SESSION_ID);
    await x.orch.sendUser('first pending');
    await x.orch.sendUser('second pending');
    x.db.accounts.update('a1', { token_expires_at: Date.now() - 1 });
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('invalid_grant'));
    try {
      emitAuthTurn(x, h, EXPIRED_TURN);
      await until(() => x.db.chat.all().filter((row) => row.text.startsWith('Account Primary is not logged in')).length === 2);
      expect(x.fake.sessions.size).toBe(1);
      expect(x.db.chat.all().some((row) => row.text.includes('401'))).toBe(false);
    } finally { fetchSpy.mockRestore(); warn.mockRestore(); }
  });

  it('explains a real logout after a refused rollover and successful recovery', async () => {
    const x = setup();
    addOauthAccount(x);
    useOauthAccount(x);
    await x.orch.sendUser('hello');
    const first = x.db.sessions.latest('orchestrator')!;
    const h = x.sessions.handleOf(first.id)!;
    x.fake.emit(h, { type: 'turn_end', nativeSessionId: AUTH_SESSION_ID, cost: 0 });
    await until(() => x.orch.status().native_session_id === AUTH_SESSION_ID);
    x.db.accounts.update('a1', { token_expires_at: Date.now() - 1 });
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('invalid_grant'));
    try { await x.orch.sendUser('refused'); } finally { fetchSpy.mockRestore(); warn.mockRestore(); }
    x.db.accounts.update('a1', { secret: 'new-access', token_expires_at: Date.now() + 5 * 60 * 60_000 });
    await x.orch.sendUser('retry');
    const second = x.db.sessions.latest('orchestrator')!;
    const h2 = x.sessions.handleOf(second.id)!;
    emitAuthTurn(x, h2, EXPIRED_TURN);
    await until(() => x.db.sessions.latest('orchestrator')!.id !== second.id);
    const third = x.db.sessions.latest('orchestrator')!;
    const h3 = x.sessions.handleOf(third.id)!;
    await until(() => x.fake.sent(h3).length === 1);
    x.db.accounts.update('a1', { secret: null, refresh_token: null });
    await x.orch.sendUser('after logout');
    expect(x.db.chat.all().filter((row) => row.text.startsWith('Account Primary is not logged in'))).toHaveLength(2);
    expect(x.fake.sent(h3)).toEqual(['retry']);
  });

  it('allows one recovery after a fresh start following a rejected recovery', async () => {
    const x = setup();
    addOauthAccount(x);
    useOauthAccount(x);
    await x.orch.sendUser('hello');
    const first = x.db.sessions.latest('orchestrator')!;
    const h = x.sessions.handleOf(first.id)!;
    x.fake.emit(h, { type: 'turn_end', nativeSessionId: AUTH_SESSION_ID, cost: 0 });
    await until(() => x.orch.status().native_session_id === AUTH_SESSION_ID);
    await x.orch.sendUser('first try');
    emitAuthTurn(x, h, EXPIRED_TURN);
    await until(() => x.db.sessions.latest('orchestrator')!.id !== first.id);
    const second = x.db.sessions.latest('orchestrator')!;
    const h2 = x.sessions.handleOf(second.id)!;
    await until(() => x.fake.sent(h2).length === 1);
    emitAuthTurn(x, h2, REVOKED_TURN);
    await until(() => x.db.chat.all().some((row) => row.text.startsWith('Account Primary is not logged in')));

    x.db.accounts.update('a1', { secret: 'logged-in-again', token_expires_at: Date.now() + 5 * 60 * 60_000 });
    await x.orch.sendUser('after login');
    const third = x.db.sessions.latest('orchestrator')!;
    const h3 = x.sessions.handleOf(third.id)!;
    expect(third.id).not.toBe(second.id);
    emitAuthTurn(x, h3, EXPIRED_TURN);
    await until(() => x.db.sessions.latest('orchestrator')!.id !== third.id);
    const fourth = x.db.sessions.latest('orchestrator')!;
    const h4 = x.sessions.handleOf(fourth.id)!;
    await until(() => x.fake.sent(h4).length === 1);
    expect(x.fake.sent(h4)).toEqual(['after login']);
    expect(x.fake.sessions.get(h4.id)!.opts.resumeId).toBe(AUTH_SESSION_ID);
    expect(x.fake.sessions.size).toBe(4);
  });

  it('does not report the orchestrator as ended while a rejected token is being resumed', async () => {
    const x = setup();
    addOauthAccount(x);
    useOauthAccount(x);
    await x.orch.sendUser('hello');
    const first = x.db.sessions.latest('orchestrator')!;
    const h = x.sessions.handleOf(first.id)!;
    x.fake.emit(h, { type: 'turn_end', nativeSessionId: AUTH_SESSION_ID, cost: 0 });
    await until(() => x.orch.status().native_session_id === AUTH_SESSION_ID);
    await x.orch.sendUser('do it');
    // Read the rail status at the moment the failed session ends, before its replacement has started.
    const seen: string[] = [];
    x.bus.on('session:ended', (e) => { if (e.session.id === first.id) seen.push(x.orch.status().status); });
    const statuses: string[] = [];
    x.bus.on('status', () => statuses.push(x.orch.status().status));

    emitAuthTurn(x, h, EXPIRED_TURN);

    await until(() => x.db.sessions.latest('orchestrator')!.id !== first.id);
    expect(seen).toEqual(['idle']);
    expect(seen).not.toContain('ended');
    expect(statuses.length).toBeGreaterThan(0);
    expect(statuses).not.toContain('ended');
    expect(x.orch.status().status).toBe('running');
  });

  it('keeps a running turn alive when a delivery arrives after the account was refreshed', async () => {
    const x = setup();
    addOauthAccount(x);
    useOauthAccount(x);
    await x.orch.sendUser('hello');
    const first = x.db.sessions.latest('orchestrator')!;
    const h = x.sessions.handleOf(first.id)!;
    x.fake.emit(h, { type: 'turn_end', nativeSessionId: 'native-1', cost: 0 });
    await until(() => x.orch.status().native_session_id === 'native-1');
    // A long turn is running when the account is refreshed and a notice arrives.
    await x.orch.sendUser('long job');
    x.db.accounts.update('a1', { secret: 'new-access', token_expires_at: Date.now() + 5 * 60 * 60_000 });
    const startSpy = vi.spyOn(x.sessions, 'start');
    await x.orch.systemMessage('carry on');

    expect(startSpy).not.toHaveBeenCalled();
    expect(x.sessions.isLive(first.id)).toBe(true);
    expect(x.fake.sent(h).slice(1)).toEqual(['long job', '[Overseer] carry on']);
    // The earlier turn's reply lands, then the notice's.
    x.fake.emit(h, { type: 'assistant_text', text: 'long job done' });
    x.fake.emit(h, { type: 'turn_end', nativeSessionId: 'native-1', cost: 0 });
    x.fake.emit(h, { type: 'assistant_text', text: 'noted' });
    x.fake.emit(h, { type: 'turn_end', nativeSessionId: 'native-1', cost: 0 });
    await until(() => x.db.chat.all().some((row) => row.text === 'noted'));
    expect(x.db.chat.all().find((row) => row.text === 'long job done')?.reply_to).toBe(2);
    expect(x.db.chat.all().find((row) => row.text === 'noted')?.reply_to).toBeNull();
    expect(x.orch.status().busy).toBe(false);
  });

  it('does not report the orchestrator as ended while a token rollover resumes it', async () => {
    const x = setup();
    addOauthAccount(x);
    useOauthAccount(x);
    await x.orch.sendUser('hello');
    const first = x.db.sessions.latest('orchestrator')!;
    const h = x.sessions.handleOf(first.id)!;
    x.fake.emit(h, { type: 'turn_end', nativeSessionId: 'native-1', cost: 0 });
    await until(() => x.orch.status().native_session_id === 'native-1');
    x.db.accounts.update('a1', { secret: 'new-access', token_expires_at: Date.now() + 5 * 60 * 60_000 });
    const atEnd: string[] = [];
    const statuses: string[] = [];
    x.bus.on('session:ended', (e) => { if (e.session.id === first.id) atEnd.push(x.orch.status().status); });
    x.bus.on('status', () => statuses.push(x.orch.status().status));

    await x.orch.systemMessage('carry on');

    await until(() => x.db.sessions.latest('orchestrator')!.id !== first.id);
    expect(atEnd).toEqual(['idle']);
    expect(statuses.length).toBeGreaterThan(0);
    expect(statuses).not.toContain('ended');
    expect(x.orch.status().status).toBe('running');
  });

  it('does not report the orchestrator as ended when auth_failed arrives and the session dies before its turn_end', async () => {
    const x = setup();
    addOauthAccount(x);
    useOauthAccount(x);
    await x.orch.sendUser('hello');
    const first = x.db.sessions.latest('orchestrator')!;
    const h = x.sessions.handleOf(first.id)!;
    x.fake.emit(h, { type: 'turn_end', nativeSessionId: AUTH_SESSION_ID, cost: 0 });
    await until(() => x.orch.status().native_session_id === AUTH_SESSION_ID);
    await x.orch.sendUser('do it');
    x.fake.emit(h, { type: 'auth_failed', text: 'Failed to authenticate. API Error: 401 OAuth access token has expired. Re-authenticate to continue.', error: 'authentication_failed' });
    await until(() => x.db.events.forSession(first.id).some((event) => event.type === 'auth_failed'));
    const atEnd: string[] = [];
    const statuses: string[] = [];
    x.bus.on('session:ended', (e) => { if (e.session.id === first.id) atEnd.push(x.orch.status().status); });
    x.bus.on('status', () => statuses.push(x.orch.status().status));

    await x.sessions.end(first.id);

    await until(() => x.db.sessions.latest('orchestrator')!.id !== first.id);
    expect(atEnd).toEqual(['idle']);
    expect(statuses.length).toBeGreaterThan(0);
    expect(statuses).not.toContain('ended');
    expect(x.orch.status().status).toBe('running');
  });

  it('reflects the still-running row when ending the session for a token rollover throws', async () => {
    const x = setup();
    addOauthAccount(x);
    useOauthAccount(x);
    await x.orch.sendUser('hello');
    const first = x.db.sessions.latest('orchestrator')!;
    const h = x.sessions.handleOf(first.id)!;
    x.fake.emit(h, { type: 'turn_end', nativeSessionId: 'native-1', cost: 0 });
    await until(() => x.orch.status().native_session_id === 'native-1');
    // The account was refreshed since the session started, so the next delivery ends the process and resumes the same thread.
    x.db.accounts.update('a1', { secret: 'new-access', token_expires_at: Date.now() + 5 * 60 * 60_000 });
    vi.spyOn(x.sessions, 'end').mockRejectedValueOnce(new Error('end boom'));

    await expect(x.orch.systemMessage('carry on')).rejects.toThrow('end boom');

    // The end failed, so the row is still running: status must not stay idle because the rollover flag was never cleared.
    expect(x.sessions.isLive(first.id)).toBe(true);
    expect(x.orch.status()).toMatchObject({ status: 'running', native_session_id: 'native-1' });
  });

  it('re-queues a notice whose turn was rejected on a failed refresh, and carries it once after login', async () => {
    const x = setup();
    addOauthAccount(x);
    useOauthAccount(x);
    await x.orch.sendUser('hello');
    const first = x.db.sessions.latest('orchestrator')!;
    const h = x.sessions.handleOf(first.id)!;
    x.fake.emit(h, { type: 'turn_end', nativeSessionId: AUTH_SESSION_ID, cost: 0 });
    await until(() => x.orch.status().native_session_id === AUTH_SESSION_ID);
    // A wake notice is delivered to the live session, then that turn is rejected on the token.
    await x.orch.systemMessage('ov-1 reopened: verification failed', { wake: true });
    expect(x.db.chat.queued()).toHaveLength(0);
    x.db.accounts.update('a1', { token_expires_at: Date.now() - 1 });
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('invalid_grant'));

    try {
      emitAuthTurn(x, h, EXPIRED_TURN);
      await until(() => x.db.chat.all().some((row) => row.text.startsWith('Account Primary is not logged in')));
    } finally {
      fetchSpy.mockRestore();
      warn.mockRestore();
    }
    // The notice's chat row is back in the queue instead of being lost with the rejected turn.
    expect(x.db.chat.queued().map((row) => row.text)).toEqual(['ov-1 reopened: verification failed']);

    // Once the account is logged in, the next turn carries the notice exactly once.
    x.db.accounts.update('a1', { secret: 'new-access', token_expires_at: Date.now() + 5 * 60 * 60_000 });
    await x.orch.sendUser('carry on');
    const next = x.db.sessions.latest('orchestrator')!;
    const prompt = x.fake.sessions.get(x.sessions.handleOf(next.id)!.id)!.opts.prompt;
    expect(prompt.split('ov-1 reopened: verification failed').length - 1).toBe(1);
    expect(prompt.endsWith('carry on')).toBe(true);
    expect(x.db.chat.queued()).toHaveLength(0);
  });
});

describe('Retry of an undelivered user message', () => {
  /** A logged-in OAuth orchestrator account whose usage gate the test switches between refusing and allowing. */
  function gated() {
    let usable = false;
    const usageGate = vi.fn<typeof accountUsable>(async () => usable ? { usable: true } : { usable: false, reason: 'account Primary: session 95% >= 95%' });
    const x = setup({ usageGate });
    addOauthAccount(x);
    useOauthAccount(x);
    return { x, allow: (value: boolean) => { usable = value; } };
  }
  const failures = (x: ReturnType<typeof setup>) => x.db.chat.all().filter((row) => row.failed_for !== null);

  /** A live session whose next sends throw, so a user send records the saved-but-not-delivered row. */
  async function liveThenBroken() {
    const x = setup();
    await x.orch.sendUser('first');
    const h = x.sessions.handleOf(x.db.sessions.latest('orchestrator')!.id)!;
    x.fake.emit(h, { type: 'turn_end', nativeSessionId: 'n1', cost: 0 });
    await until(() => !x.orch.status().busy);
    const send = x.sessions.send.bind(x.sessions);
    const attempts: string[] = [];
    x.sessions.send = async (_id, text) => { attempts.push(text); throw new Error('pipe closed'); };
    return { x, h, send, attempts };
  }

  it('links each failure row of a user send to that user row, and no other system row', async () => {
    const x = setup();
    x.db.accounts.insert({ id: 'a1', name: 'Logged out Claude', harness: 'claude', kind: 'oauth_token', home: null, created_at: 't0', last_login_at: null, last_verified_at: null });
    x.db.settings.set('orchestrator', { model: null, effort: null, promptOverride: null, account: 'a1' });
    await x.orch.systemMessage('a wake notice', { wake: true });
    await x.orch.sendUser('start work');
    const user = x.db.chat.all().find((row) => row.role === 'user')!;
    const refusals = x.db.chat.all().filter((row) => row.text.startsWith('Account Logged out Claude is not logged in'));
    // The wake notice's refusal is not about a user send; the user send's refusal is, and keeps its text.
    expect(refusals.map((row) => row.failed_for)).toEqual([null, user.id]);
    expect(refusals[1]!.text).toBe('Account Logged out Claude is not logged in, so the orchestrator was not started. Log in the account from Setup and try again.');
    expect(x.db.chat.all().find((row) => row.text === 'a wake notice')!.failed_for).toBeNull();
  });

  it('links the unusable-account refusal and the saved-but-not-delivered row to the user row', async () => {
    const { x } = gated();
    await x.orch.sendUser('refused');
    const refused = x.db.chat.all().find((row) => row.text === 'refused')!;
    expect(failures(x)).toMatchObject([{ role: 'system', failed_for: refused.id, retried_at: null }]);
    expect(failures(x)[0]!.text).toMatch(/^Account Primary is not usable, so the orchestrator was not started\./);

    const y = await liveThenBroken();
    const error = vi.spyOn(log, 'error').mockImplementation(() => {});
    try { await y.x.orch.sendUser('second'); } finally { error.mockRestore(); }
    const second = y.x.db.chat.all().find((row) => row.text === 'second')!;
    expect(failures(y.x)).toMatchObject([{ text: 'Message saved but not delivered: pipe closed', failed_for: second.id }]);
  });

  it('delivers the stored message on Retry without a new user row, and marks the failure retried', async () => {
    const { x, allow } = gated();
    await x.orch.sendUser('refused');
    const failure = failures(x)[0]!;
    allow(true);
    await x.orch.retryUser(failure.id);
    const session = x.db.sessions.latest('orchestrator')!;
    expect(x.fake.sessions.get(x.sessions.handleOf(session.id)!.id)!.opts.prompt.endsWith('\n\nrefused')).toBe(true);
    expect(x.db.chat.all().filter((row) => row.role === 'user').map((row) => row.text)).toEqual(['refused']);
    expect(x.db.chat.get(failure.id)!.retried_at).toBeTruthy();
    expect(x.db.chat.all().find((row) => row.text === 'refused')!.seen_at).toBeTruthy();
    expect(failures(x)).toHaveLength(1);
  });

  it('writes a new failure row with its own Retry when the retry is refused again', async () => {
    const { x } = gated();
    await x.orch.sendUser('refused');
    const [first] = failures(x);
    await x.orch.retryUser(first!.id);
    const rows = failures(x);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.retried_at).toBeTruthy();
    expect(rows[1]).toMatchObject({ failed_for: first!.failed_for, retried_at: null });
    expect(x.db.sessions.latest('orchestrator')).toBeUndefined();
    // The second failure takes a Retry of its own.
    await x.orch.retryUser(rows[1]!.id);
    expect(failures(x)).toHaveLength(3);
  });

  it('accepts one Retry per failure row: a second is refused and nothing is sent twice', async () => {
    const { x, allow } = gated();
    await x.orch.sendUser('refused');
    const failure = failures(x)[0]!;
    allow(true);
    const accepted = x.orch.retryUser(failure.id);
    expect(() => x.orch.retryUser(failure.id)).toThrow(expect.objectContaining({ statusCode: 409 }));
    await accepted;
    const h = x.sessions.handleOf(x.db.sessions.latest('orchestrator')!.id)!;
    expect(x.fake.sessions.size).toBe(1);
    expect(x.fake.sent(h)).toHaveLength(1);
    expect(x.fake.sent(h)[0]!.endsWith('\n\nrefused')).toBe(true);
  });

  it('refuses a Retry on a row that reports no undelivered message', async () => {
    const x = setup();
    await x.orch.systemMessage('ov-1 landed');
    await x.orch.sendUser('hello');
    expect(x.db.chat.all().length).toBeGreaterThan(1);
    for (const row of x.db.chat.all()) expect(() => x.orch.retryUser(row.id)).toThrow(expect.objectContaining({ statusCode: 404 }));
    expect(() => x.orch.retryUser(9999)).toThrow(RetryError);
  });

  it('re-sends the same repo prefix and attachment lines the first delivery carried', async () => {
    const { x, h, send, attempts } = await liveThenBroken();
    const data = Buffer.from('fake-png-bytes');
    const error = vi.spyOn(log, 'error').mockImplementation(() => {});
    try { await x.orch.sendUser('[repo: web] look at this', [{ name: 'shot.png', mime: 'image/png', data }]); } finally { error.mockRestore(); }
    const user = x.db.chat.all().find((row) => row.text === '[repo: web] look at this')!;
    const stored = x.db.chat.attachment(user.id, 0)!;
    expect(attempts).toEqual([`[repo: web] look at this\n\n[attached image: ${stored.path}]`]);
    x.sessions.send = send;
    await x.orch.retryUser(failures(x)[0]!.id);
    expect(x.fake.sent(h).at(-1)).toBe(attempts[0]);
  });

  it('delivers a Retry and a Send made right after it in click order', async () => {
    const { x, h, send } = await liveThenBroken();
    const error = vi.spyOn(log, 'error').mockImplementation(() => {});
    try { await x.orch.sendUser('lost'); } finally { error.mockRestore(); }
    // Hold the retried send, so the new Send would overtake it if it did not queue behind it.
    const gate = deferred<void>();
    x.sessions.send = async (id, text) => { if (text === 'lost') await gate.promise; return send(id, text); };
    const retried = x.orch.retryUser(failures(x)[0]!.id);
    const sent = x.orch.sendUser('new message');
    gate.resolve();
    await Promise.all([retried, sent]);
    expect(x.fake.sent(h).slice(-2)).toEqual(['lost', 'new message']);
  });

  it('recovers an accepted Retry after reopening the database on daemon restart', async () => {
    const waiting = deferred<Awaited<ReturnType<typeof accountUsable>>>();
    const entered = deferred<void>();
    let holdRetry = false;
    const usageGate = vi.fn<typeof accountUsable>(async () => {
      if (!holdRetry) return { usable: false, reason: 'account Primary: session 95% >= 95%' };
      entered.resolve();
      return waiting.promise;
    });
    const x = setup({ usageGate, persistent: true });
    addOauthAccount(x);
    useOauthAccount(x);
    await x.orch.sendUser('refused');
    const failure = failures(x)[0]!;
    holdRetry = true;
    void x.orch.retryUser(failure.id);
    await entered.promise;
    expect(x.db.chat.get(failure.id)!.retried_at).toBeTruthy();
    x.db.sql.close();

    const db = openDb(x.dbFile);
    const bus = new Bus();
    const fake = new FakeAdapter();
    const sessions = new SessionManager(db, { claude: fake }, bus, path.join(x.config.dataDir, 'sessions'));
    const restarted = new Orchestrator({ db, sessions, bus, config: x.config, usageGate: async () => ({ usable: true }) });
    try {
      await restarted.recoverPendingUserRetries();
      expect(fake.sessions.size).toBe(1);
      expect(db.chat.all().filter((row) => row.role === 'user').map((row) => row.text)).toEqual(['refused']);
      expect(db.chat.get(failure.id)).toMatchObject({ failed_for: db.chat.all().find((row) => row.role === 'user')!.id, retried_at: expect.any(String) });
      expect(db.chat.pendingRetries()).toEqual([]);
      expect(db.chat.all().filter((row) => row.failed_for !== null)).toHaveLength(1);

      const restartedAgain = new Orchestrator({ db, sessions, bus, config: x.config, usageGate: async () => ({ usable: true }) });
      await restartedAgain.recoverPendingUserRetries();
      expect(fake.sessions.size).toBe(1);
    } finally {
      db.sql.close();
    }
  });
});
