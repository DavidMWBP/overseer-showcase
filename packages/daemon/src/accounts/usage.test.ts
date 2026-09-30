import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { SessionRole } from '@overseer/shared';
import { openDb } from '../db/db';
import { loadConfig } from '../config';
import { AUTH_HOLD_UNTIL } from './status';
import { accountUsable, clearAccountUsageCache, fetchAccountUsage } from './usage';
import { Bus, type SessionEnded } from '../bus';
import { FakeAdapter } from '../harness/fake';
import { SessionManager } from '../sessions/manager';

const config = loadConfig({});
const versionRunner = async () => ({ code: 0, stdout: '2.1.0', stderr: '' });
const sessionManagers: { manager: SessionManager; ids: string[] }[] = [];
const tempDirs: string[] = [];

function account(id = 'claude') {
  const db = openDb(':memory:');
  db.accounts.insert({ id, name: id, harness: 'claude', kind: 'oauth_token', secret: 'token', home: null, created_at: 't', last_login_at: 't', last_verified_at: null });
  return db;
}

afterEach(async () => {
  clearAccountUsageCache(); vi.useRealTimers(); vi.restoreAllMocks();
  for (const { manager, ids } of sessionManagers.splice(0)) for (const id of ids) await manager.end(id);
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function sessions(db: ReturnType<typeof openDb>) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'overseer-usage-test-'));
  tempDirs.push(dataDir);
  const fake = new FakeAdapter();
  const bus = new Bus();
  const manager = new SessionManager(db, { claude: fake }, bus, path.join(dataDir, 'sessions'));
  const tracked = { manager, ids: [] as string[] };
  sessionManagers.push(tracked);
  return {
    fake,
    bus,
    manager,
    start(role: SessionRole, accountId: string) {
      const session = manager.start({ role, harness: 'claude', cwd: dataDir, prompt: 'test', account: accountId });
      tracked.ids.push(session.id);
      return session;
    },
  };
}

describe('fetchAccountUsage', () => {
  it('maps limits including model scopes', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ limits: [
      { percent: 12, resets_at: 'session-reset', scope: 'five_hour' },
      { percent: 34, resets_at: 'week-reset', scope: { type: 'seven_day' } },
      { percent: 56, resets_at: 'fable-reset', scope: { model: 'fable' } },
    ] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(fetchAccountUsage(account(), config, 'claude', versionRunner)).resolves.toMatchObject({ session: { percent: 12, resetsAt: 'session-reset' }, weekly: { percent: 34, resetsAt: 'week-reset' }, models: [{ model: 'fable', percent: 56, resetsAt: 'fable-reset' }] });
    expect(fetchMock.mock.calls[0]![1].headers).toMatchObject({ 'User-Agent': 'claude-code/2.1.0' });
  });

  it('falls back to top-level buckets when limits is absent', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ five_hour: { utilization: 10, resets_at: 'a' }, seven_day: { utilization: 20, resets_at: 'b' } }), { status: 200 })));
    await expect(fetchAccountUsage(account(), config, 'claude', versionRunner)).resolves.toMatchObject({ session: { percent: 10, resetsAt: 'a' }, weekly: { percent: 20, resetsAt: 'b' }, models: [] });
  });

  it('fills unrecognised limits buckets from top-level fields', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ limits: [{ percent: 99, scope: 'renamed' }], five_hour: { utilization: 10 }, seven_day: { utilization: 20 } }), { status: 200 })));
    await expect(fetchAccountUsage(account(), config, 'claude', versionRunner)).resolves.toMatchObject({ session: { percent: 10, resetsAt: null }, weekly: { percent: 20, resetsAt: null }, models: [] });
  });

  it('accepts null fields without throwing', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ five_hour: null, seven_day: null, seven_day_fable: null }), { status: 200 })));
    await expect(fetchAccountUsage(account(), config, 'claude', versionRunner)).resolves.toMatchObject({ session: null, weekly: null, models: [] });
  });

  it('returns an error with the last good values after a 429', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ five_hour: { utilization: 10 }, seven_day: { utilization: 20 } }), { status: 200 }))
      .mockResolvedValueOnce(new Response('', { status: 429 }));
    vi.stubGlobal('fetch', fetchMock);
    const db = account();
    const good = await fetchAccountUsage(db, config, 'claude', versionRunner);
    vi.advanceTimersByTime(180_000);
    await expect(fetchAccountUsage(db, config, 'claude', versionRunner)).resolves.toMatchObject({ fetchedAt: good!.fetchedAt, session: { percent: 10, resetsAt: null }, weekly: { percent: 20, resetsAt: null }, error: 'HTTP 429' });
  });

  it('caches each account for 180 seconds', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({}), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const db = account();
    await fetchAccountUsage(db, config, 'claude', versionRunner);
    await fetchAccountUsage(db, config, 'claude', versionRunner);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it.each(['clean', 'failed', 'stopped'] as const)('clears cached usage after a %s session end and fetches fresh usage', async (endKind) => {
    const thresholdConfig = loadConfig({ OVERSEER_USAGE_THRESHOLD: '85' });
    const fetchMock = vi.fn().mockImplementation(async () => new Response(JSON.stringify({ five_hour: { utilization: 85 } }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const db = account();
    const x = sessions(db);
    await fetchAccountUsage(db, config, 'claude', versionRunner);
    const session = x.start('worker', 'claude');
    await fetchAccountUsage(db, config, 'claude', versionRunner);
    expect(fetchMock).toHaveBeenCalledOnce();

    const ended = new Promise<SessionEnded>((resolve) => x.bus.once('session:ended', resolve));
    if (endKind === 'stopped') await x.manager.interrupt(session.id, { by: 'user', reason: 'test stop' });
    else {
      if (endKind === 'failed') x.fake.emit(x.manager.handleOf(session.id)!, { type: 'error', message: 'test failure' });
      await x.manager.end(session.id);
    }
    const event = await ended;
    expect(event.session.status).toBe(endKind === 'failed' ? 'failed' : 'ended');
    if (endKind === 'stopped') expect(event.stop?.by).toBe('user');

    await expect(accountUsable(db, thresholdConfig, 'claude', 'fable', versionRunner)).resolves.toEqual({
      usable: false,
      reason: 'account claude: session 85% >= 85% (85% - 0 running x 2%)',
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('shares an in-flight request between concurrent callers', async () => {
    let resolve!: (response: Response) => void;
    const fetchMock = vi.fn().mockImplementation(() => new Promise<Response>((r) => { resolve = r; }));
    vi.stubGlobal('fetch', fetchMock);
    const db = account();
    const first = fetchAccountUsage(db, config, 'claude', versionRunner);
    const second = fetchAccountUsage(db, config, 'claude', versionRunner);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    resolve(new Response(JSON.stringify({}), { status: 200 }));
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
  });

  it('returns null for non-Claude OAuth accounts', async () => {
    const db = account('codex');
    db.accounts.update('codex', { harness: 'codex', kind: 'codex_home' });
    const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock);
    await expect(fetchAccountUsage(db, config, 'codex', versionRunner)).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('accountUsable', () => {
  const usage = (body: unknown) => vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status: 200 })));

  it('blocks session, weekly, and matching model usage at the threshold', async () => {
    usage({ five_hour: { utilization: 95 } });
    await expect(accountUsable(account(), config, 'claude', 'fable', versionRunner)).resolves.toEqual({ usable: false, reason: 'account claude: session 95% >= 95% (95% - 0 running x 2%)' });
    clearAccountUsageCache(); usage({ seven_day: { utilization: 96 } });
    await expect(accountUsable(account(), config, 'claude', 'fable', versionRunner)).resolves.toEqual({ usable: false, reason: 'account claude: weekly 96% >= 95% (95% - 0 running x 2%)' });
    clearAccountUsageCache(); usage({ limits: [{ percent: 97, scope: { model: 'claude-fable-5-1' } }] });
    await expect(accountUsable(account(), config, 'claude', 'claude-fable-5-1-20260901', versionRunner)).resolves.toEqual({ usable: false, reason: 'account claude: model claude-fable-5-1 97% >= 95% (95% - 0 running x 2%)' });
  });

  it.each([
    { count: 0, roles: [] as SessionRole[], effective: 85 },
    { count: 1, roles: ['critic'] as SessionRole[], effective: 83 },
    { count: 6, roles: ['worker', 'worker', 'worker', 'worker', 'critic', 'orchestrator'] as SessionRole[], effective: 73 },
  ])('reserves headroom for $count running sessions', async ({ count, roles, effective }) => {
    const thresholdConfig = loadConfig({ OVERSEER_USAGE_THRESHOLD: '85' });
    const db = account();
    const x = sessions(db);
    for (const role of roles) x.start(role, 'claude');
    usage({ five_hour: { utilization: effective } });

    await expect(accountUsable(db, thresholdConfig, 'claude', 'fable', versionRunner)).resolves.toEqual({
      usable: false,
      reason: `account claude: session ${effective}% >= ${effective}% (85% - ${count} running x 2%)`,
    });
    expect(db.sessions.running()).toHaveLength(count);
  });

  it('does not reserve headroom against the session being resumed', async () => {
    const thresholdConfig = loadConfig({ OVERSEER_USAGE_THRESHOLD: '85' });
    const db = account();
    const x = sessions(db);
    const critic = x.start('critic', 'claude');
    x.start('worker', 'claude');
    usage({ five_hour: { utilization: 83 } });

    await expect(accountUsable(db, thresholdConfig, 'claude', 'fable', versionRunner, undefined, critic.id)).resolves.toEqual({
      usable: false,
      reason: 'account claude: session 83% >= 83% (85% - 1 running x 2%)',
    });
    expect(db.sessions.running().map((session) => session.id)).toContain(critic.id);
    clearAccountUsageCache();
    usage({ five_hour: { utilization: 83 } });
    await expect(accountUsable(db, thresholdConfig, 'claude', 'fable', versionRunner)).resolves.toEqual({
      usable: false,
      reason: 'account claude: session 83% >= 81% (85% - 2 running x 2%)',
    });
    clearAccountUsageCache();
    usage({ five_hour: { utilization: 83 } });
    await expect(accountUsable(db, thresholdConfig, 'claude', 'fable', versionRunner, undefined, 'removed-session')).resolves.toEqual({
      usable: false,
      reason: 'account claude: session 83% >= 81% (85% - 2 running x 2%)',
    });
  });

  it('applies the reserved threshold to the session, weekly, and matching model buckets', async () => {
    const thresholdConfig = loadConfig({ OVERSEER_USAGE_THRESHOLD: '85' });
    const buckets = [
      { body: { five_hour: { utilization: 83 } }, label: 'session' },
      { body: { seven_day: { utilization: 83 } }, label: 'weekly' },
      { body: { limits: [{ percent: 83, scope: { model: 'fable' } }] }, label: 'model fable' },
    ];
    for (const { body, label } of buckets) {
      clearAccountUsageCache();
      const db = account();
      sessions(db).start('critic', 'claude');
      usage(body);
      await expect(accountUsable(db, thresholdConfig, 'claude', 'fable', versionRunner)).resolves.toEqual({
        usable: false,
        reason: `account claude: ${label} 83% >= 83% (85% - 1 running x 2%)`,
      });
    }
  });

  it('floors the reserved threshold at half the configured threshold', async () => {
    const thresholdConfig = loadConfig({ OVERSEER_USAGE_THRESHOLD: '85' });
    const db = account();
    const x = sessions(db);
    const roles: SessionRole[] = [...Array<SessionRole>(20).fill('worker'), 'critic', 'orchestrator'];
    for (const role of roles) x.start(role, 'claude');
    usage({ five_hour: { utilization: 42.49 } });
    await expect(accountUsable(db, thresholdConfig, 'claude', 'fable', versionRunner)).resolves.toEqual({ usable: true });
    clearAccountUsageCache();
    usage({ five_hour: { utilization: 42.5 } });
    await expect(accountUsable(db, thresholdConfig, 'claude', 'fable', versionRunner)).resolves.toEqual({
      usable: false,
      reason: 'account claude: session 42.5% >= 42.5% (85% - 22 running x 2%, floored at 42.5%)',
    });
  });

  it('allows usage below the threshold and a non-matching model bucket', async () => {
    usage({ five_hour: { utilization: 94 } });
    await expect(accountUsable(account(), config, 'claude', 'fable', versionRunner)).resolves.toEqual({ usable: true });
    clearAccountUsageCache(); usage({ limits: [{ percent: 99, scope: { model: 'opus' } }] });
    await expect(accountUsable(account(), config, 'claude', 'fable', versionRunner)).resolves.toEqual({ usable: true });
  });

  it('allows non-Claude accounts and an unreachable first usage fetch', async () => {
    const codex = account('codex'); codex.accounts.update('codex', { harness: 'codex', kind: 'codex_home' });
    await expect(accountUsable(codex, config, 'codex', 'gpt-5.6-luna', versionRunner)).resolves.toEqual({ usable: true });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    await expect(accountUsable(account(), config, 'claude', 'fable', versionRunner)).resolves.toEqual({ usable: true });
  });

  it('blocks a future exhausted_until and allows a past value', async () => {
    const future = account(); future.accounts.update('claude', { exhausted_until: Date.now() + 60_000 });
    await expect(accountUsable(future, config, 'claude', 'fable', versionRunner)).resolves.toMatchObject({ usable: false, reason: expect.stringContaining('exhausted until') });
    const past = account(); past.accounts.update('claude', { exhausted_until: Date.now() - 1 });
    usage({});
    await expect(accountUsable(past, config, 'claude', 'fable', versionRunner)).resolves.toEqual({ usable: true });
  });

  it('reads an authentication hold as needing a re-login, not as exhausted', async () => {
    const parked = account(); parked.accounts.update('claude', { exhausted_until: AUTH_HOLD_UNTIL });
    await expect(accountUsable(parked, config, 'claude', 'fable', versionRunner)).resolves.toEqual({ usable: false, reason: 'account claude: authentication failed; log in again' });
  });
});
