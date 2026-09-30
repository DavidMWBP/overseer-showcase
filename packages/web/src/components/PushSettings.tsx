import { useEffect, useState } from 'react';
import { api } from '../api';

/** The base64url VAPID key as PushManager wants it: a Uint8Array. */
function keyBytes(key: string): Uint8Array {
  const b64 = (key + '='.repeat((4 - (key.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b64);
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

type State = 'unsupported' | 'insecure' | 'denied' | 'off' | 'on' | 'busy';

/**
 * Push notifications for this browser: a question from the orchestrator, a batch ready for review, a bead awaiting a decision.
 * The subscription is per browser (each phone or desktop enables its own); the daemon keeps them and sends (push/push.ts).
 * iOS needs the app added to the Home Screen first; a plain Safari tab has no push.
 */
interface PushTestResult { endpoint_host: string; ok: boolean; statusCode?: number; body?: string; dropped?: boolean }
/** One line per device: 'ok', 'dropped (410)' or 'failed (403: <body>)', the host in front so a phone and a desktop tell apart. */
function describeResult(r: PushTestResult): string {
  const code = r.statusCode ?? 'no status';
  const outcome = r.ok ? 'ok' : r.dropped ? `dropped (${code})` : `failed (${code}: ${(r.body ?? '').slice(0, 80)})`;
  return `${r.endpoint_host}: ${outcome}`;
}

export function PushSettings() {
  const supported = typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  const [state, setState] = useState<State>(() => (!supported ? 'unsupported' : !window.isSecureContext ? 'insecure' : Notification.permission === 'denied' ? 'denied' : 'off'));
  const [error, setError] = useState<string | null>(null);
  const [count, setCount] = useState<number | null>(null);
  /** The daemon-wide `push_on_reply` setting: every orchestrator reply, not only questions, reviews and decisions. */
  const [onReply, setOnReply] = useState<boolean | null>(null);
  const [tested, setTested] = useState<string[] | null>(null);

  useEffect(() => {
    if (state === 'unsupported' || state === 'insecure') return;
    // Already subscribed in this browser? The registration is the source of truth, not local state.
    navigator.serviceWorker.getRegistration('/sw.js').then((r) => r?.pushManager.getSubscription()).then((s) => { if (s) setState('on'); }).catch(() => {});
    api.get<{ key: string | null; subscriptions: number }>('/push/key').then((r) => setCount(r.subscriptions)).catch(() => {});
    api.get<{ on_reply: boolean }>('/settings/push').then((r) => setOnReply(r.on_reply)).catch(() => {});
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const enable = async () => {
    setError(null); setState('busy');
    try {
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') { setState(perm === 'denied' ? 'denied' : 'off'); return; }
      const reg = await navigator.serviceWorker.register('/sw.js');
      await navigator.serviceWorker.ready;
      const { key } = await api.get<{ key: string | null }>('/push/key', { fresh: true });
      if (!key) throw new Error('the daemon has no push key');
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(key) as BufferSource });
      await api.post('/push/subscriptions', sub.toJSON());
      setState('on'); setCount((c) => (c ?? 0) + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e)); setState('off');
    }
  };
  const disable = async () => {
    setError(null); setState('busy');
    try {
      const reg = await navigator.serviceWorker.getRegistration('/sw.js');
      const sub = await reg?.pushManager.getSubscription();
      if (sub) { await fetch('/api/push/subscriptions', { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ endpoint: sub.endpoint }) }); await sub.unsubscribe(); }
      setState('off'); setCount((c) => Math.max(0, (c ?? 1) - 1));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e)); setState('on');
    }
  };

  const toggleOnReply = async (next: boolean) => {
    setError(null); setOnReply(next);
    try { await api.put('/settings/push', { on_reply: next }); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); setOnReply(!next); }
  };

  return (
    <section className="push-settings">
      <h2>Notifications</h2>
      <p className="muted">A push notification on this device when the orchestrator asks you something, a batch is ready for review, or a bead awaits your decision. Each device enables its own.{count !== null && count > 0 ? ` ${count} device${count === 1 ? '' : 's'} subscribed.` : ''}</p>
      {state === 'unsupported' && <p>This browser has no push support. On an iPhone, add Overseer to the Home Screen and open it from there.</p>}
      {state === 'insecure' && <p>Push needs HTTPS (or localhost); open Overseer through its https address.</p>}
      {state === 'denied' && <p>Notifications are blocked for this site in the browser settings.</p>}
      {(state === 'off' || state === 'busy') && <button className="primary" disabled={state === 'busy'} onClick={enable}>Enable on this device</button>}
      {state === 'on' && <button onClick={disable}>Disable on this device</button>}
      {state === 'on' && <button onClick={() => { setTested(null); api.post<{ results: PushTestResult[] }>('/push/test').then((r) => setTested(r.results.length ? r.results.map(describeResult) : ['No subscribed devices'])).catch((e: Error) => setTested([e.message])); }}>Send test notification</button>}
      {tested && <ul className="muted" role="status">{tested.map((line, i) => <li key={i}>{line}</li>)}</ul>}
      {state === 'on' && onReply !== null && (
        <label className="checkbox">
          <input type="checkbox" checked={onReply} onChange={(e) => void toggleOnReply(e.target.checked)} />
          <span>Also notify on every orchestrator reply</span>
        </label>
      )}
      {error && <div className="badge-warn" role="alert">{error}</div>}
    </section>
  );
}
