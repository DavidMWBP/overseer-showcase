import { describe, it, expect, vi } from 'vitest';
import { openDb } from '../db/db';
import { Push, isDeadSubscription, type PushSender, type PushSubscriptionJson } from './push';

const sub = (n: number): PushSubscriptionJson => ({ endpoint: `https://push.example/${n}`, keys: { p256dh: 'p', auth: 'a' } });

describe('Push', () => {
  it('generates one VAPID key pair and keeps it', () => {
    const db = openDb(':memory:');
    const p = new Push(db, async () => undefined);
    const key = p.publicKey();
    expect(key.length).toBeGreaterThan(40);
    expect(new Push(db).publicKey()).toBe(key); // the pair lives in settings, not in the instance
  });

  it('sends to every subscription, drops the gone ones and swallows other failures', async () => {
    const db = openDb(':memory:');
    const sent: string[] = [];
    const send: PushSender = async (s, payload) => {
      sent.push(s.endpoint);
      if (s.endpoint.endsWith('/2')) throw Object.assign(new Error('gone'), { statusCode: 410 });
      if (s.endpoint.endsWith('/3')) throw new Error('network');
      expect(JSON.parse(payload)).toEqual({ title: 'T', body: 'B', url: '#chat' });
    };
    const error = vi.spyOn(console, 'error').mockImplementation(() => {}); // the network failure is logged, not thrown
    const p = new Push(db, send);
    for (const n of [1, 2, 3]) p.subscribe(sub(n));
    p.subscribe(sub(1)); // a re-subscribe of the same endpoint is one row
    expect(p.count()).toBe(3);
    await p.notify({ title: 'T', body: 'B', url: '#chat' });
    expect(sent.sort()).toEqual(['https://push.example/1', 'https://push.example/2', 'https://push.example/3']);
    expect(db.push.list().map((r) => r.endpoint)).toEqual(['https://push.example/1', 'https://push.example/3']); // 410 dropped, the network failure kept
    p.unsubscribe('https://push.example/1');
    expect(p.count()).toBe(1);
    expect(error).toHaveBeenCalledTimes(1);
    error.mockRestore();
  });

  it('drops a 401/403 whose body names a dead subscription, keeps and logs any other code, and reports per device', async () => {
    const db = openDb(':memory:');
    const send: PushSender = async (s) => {
      if (s.endpoint.endsWith('/2')) throw Object.assign(new Error('unexpected response'), { statusCode: 403, body: '{"reason":"VapidPkHashMismatch"}' });
      if (s.endpoint.endsWith('/3')) throw Object.assign(new Error('unexpected response'), { statusCode: 500, body: 'x'.repeat(300) });
      if (s.endpoint.endsWith('/4')) throw Object.assign(new Error('unexpected response'), { statusCode: 403, body: '{"reason":"BadJwtToken"}' }); // the sender's JWT, not the subscription
      if (s.endpoint.endsWith('/5')) throw Object.assign(new Error('gone'), { statusCode: 404 });
    };
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const info = vi.spyOn(console, 'log').mockImplementation(() => {});
    const p = new Push(db, send);
    for (const n of [1, 2, 3, 4, 5]) p.subscribe(sub(n));
    const results = await p.notify({ title: 'T', body: 'B', url: '#chat' });
    expect(results).toEqual([
      { endpoint_host: 'push.example', ok: true },
      { endpoint_host: 'push.example', ok: false, statusCode: 403, body: '{"reason":"VapidPkHashMismatch"}', dropped: true },
      { endpoint_host: 'push.example', ok: false, statusCode: 500, body: 'x'.repeat(200) },
      { endpoint_host: 'push.example', ok: false, statusCode: 403, body: '{"reason":"BadJwtToken"}' },
      { endpoint_host: 'push.example', ok: false, statusCode: 404, body: 'gone', dropped: true },
    ]);
    expect(db.push.list().map((r) => r.endpoint)).toEqual(['https://push.example/1', 'https://push.example/3', 'https://push.example/4']);
    // The log names the status, the host and the path tail, never the full endpoint.
    const logged = error.mock.calls.map((c) => c[1] as Record<string, unknown>);
    expect(logged).toHaveLength(2);
    expect(logged[0]).toMatchObject({ statusCode: 500, host: 'push.example', path_tail: '/3' });
    expect(logged[0]?.created_at).toBeTypeOf('string');
    expect(JSON.stringify(logged)).not.toContain('https://push.example/3');
    expect(info.mock.calls.map((c) => c[1] as Record<string, unknown>)).toMatchObject([{ statusCode: 403 }, { statusCode: 404 }]);
    error.mockRestore(); info.mockRestore();
  });

  it('classifies dead subscriptions by status and body', () => {
    expect(isDeadSubscription(410, '')).toBe(true);
    expect(isDeadSubscription(404, 'NotRegistered')).toBe(true);
    expect(isDeadSubscription(401, 'Unauthorized')).toBe(false); // Mozilla 401: the sender's own VAPID header or TTL
    expect(isDeadSubscription(403, '{"reason":"ExpiredProviderToken"}')).toBe(false); // Apple: expired sender JWT
    expect(isDeadSubscription(403, '{"reason":"TopicDisallowed"}')).toBe(true);
    expect(isDeadSubscription(403, 'unsubscribed')).toBe(true);
    expect(isDeadSubscription(403, 'subscription expired')).toBe(true);
    expect(isDeadSubscription(403, '{"reason":"BadJwtToken"}')).toBe(false);
    expect(isDeadSubscription(400, 'VapidPkHashMismatch')).toBe(false);
    expect(isDeadSubscription(undefined, 'expired')).toBe(false);
  });

  it('uses a subject Apple accepts by default and takes an override', async () => {
    const db = openDb(':memory:');
    const seen: string[] = [];
    const send: PushSender = async (_s, _p, vapid) => { seen.push(vapid.subject); };
    const p = new Push(db, send); p.subscribe(sub(1));
    await p.notify({ title: 'T', body: 'B', url: '#chat' });
    const q = new Push(db, send, 'mailto:me@example.org');
    await q.notify({ title: 'T', body: 'B', url: '#chat' });
    expect(seen).toEqual(['mailto:overseer@example.com', 'mailto:me@example.org']);
  });

  it('does nothing without subscriptions', async () => {
    let calls = 0;
    const p = new Push(openDb(':memory:'), async () => { calls++; });
    await p.notify({ title: 'T', body: 'B', url: '#chat' });
    expect(calls).toBe(0);
  });
});
