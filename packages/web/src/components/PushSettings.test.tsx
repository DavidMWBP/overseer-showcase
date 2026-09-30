import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { PushSettings } from './PushSettings';
import { mockApi } from '../test/setup';

// jsdom has no push API: the browser pieces are stubbed per test and restored after.
afterEach(() => { vi.unstubAllGlobals(); });

function stubBrowser(permission: NotificationPermission, existing: { endpoint: string } | null = null) {
  const subscription = { endpoint: 'https://push.example/1', toJSON: () => ({ endpoint: 'https://push.example/1', keys: { p256dh: 'p', auth: 'a' } }), unsubscribe: vi.fn(async () => true) };
  const pushManager = { getSubscription: vi.fn(async () => existing ? subscription : null), subscribe: vi.fn(async () => subscription) };
  const reg = { pushManager };
  const sw = { register: vi.fn(async () => reg), getRegistration: vi.fn(async () => reg), ready: Promise.resolve(reg) };
  Object.defineProperty(navigator, 'serviceWorker', { value: sw, configurable: true });
  vi.stubGlobal('PushManager', function PushManager() {});
  vi.stubGlobal('Notification', { permission, requestPermission: vi.fn(async () => permission) });
  Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true });
  return { sw, pushManager, subscription };
}

describe('PushSettings', () => {
  it('subscribes this browser and posts the subscription to the daemon', async () => {
    const { pushManager } = stubBrowser('granted');
    const calls: { method: string; url: string; body?: unknown }[] = [];
    mockApi((method, url, body) => {
      calls.push({ method, url, body });
      if (url === '/api/push/key') return { key: 'BAAA', subscriptions: 0 };
      return new Response(null, { status: 204 });
    });
    render(<PushSettings />);
    fireEvent.click(await screen.findByRole('button', { name: 'Enable on this device' }));
    await screen.findByRole('button', { name: 'Disable on this device' });
    expect(pushManager.subscribe).toHaveBeenCalledWith(expect.objectContaining({ userVisibleOnly: true }));
    expect(calls.find((c) => c.method === 'POST')).toMatchObject({ url: '/api/push/subscriptions', body: { endpoint: 'https://push.example/1' } });
    expect(screen.getByText(/1 device subscribed/)).toBeTruthy();
  });

  it('reads an existing subscription as enabled and says when the browser cannot push', async () => {
    stubBrowser('granted', { endpoint: 'x' });
    mockApi((method, url) => url === '/api/push/test' && method === 'POST'
      ? { results: [{ endpoint_host: 'fcm.googleapis.com', ok: true }, { endpoint_host: 'web.push.apple.com', ok: false, statusCode: 410, dropped: true }, { endpoint_host: 'web.push.apple.com', ok: false, statusCode: 403, body: '{"reason":"BadJwtToken"}' }] }
      : { key: 'BAAA', subscriptions: 2 });
    render(<PushSettings />);
    await screen.findByRole('button', { name: 'Disable on this device' });
    expect(screen.getByText(/2 devices subscribed/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Send test notification' }));
    // One line per device: ok, dropped with the status, or failed with the status and the service's body.
    await screen.findByText('fcm.googleapis.com: ok');
    expect(screen.getByText('web.push.apple.com: dropped (410)')).toBeTruthy();
    expect(screen.getByText('web.push.apple.com: failed (403: {"reason":"BadJwtToken"})')).toBeTruthy();
  });

  it('says when the daemon has no subscribed devices to test', async () => {
    stubBrowser('granted', { endpoint: 'x' });
    mockApi((method, url) => url === '/api/push/test' && method === 'POST' ? { results: [] } : { key: 'BAAA', subscriptions: 0 });
    render(<PushSettings />);
    fireEvent.click(await screen.findByRole('button', { name: 'Send test notification' }));
    expect(await screen.findByText('No subscribed devices')).toBeTruthy();
    expect(screen.getByRole('status').textContent).toBe('No subscribed devices');
  });

  it('shows the reply checkbox only when push is on and saves it through the settings API', async () => {
    stubBrowser('granted', { endpoint: 'x' });
    const puts: unknown[] = [];
    mockApi((method, url, body) => {
      if (url === '/api/push/key') return { key: 'BAAA', subscriptions: 1 };
      if (url === '/api/settings/push' && method === 'PUT') { puts.push(body); return body; }
      if (url === '/api/settings/push') return { on_reply: true };
      return new Response(null, { status: 204 });
    });
    render(<PushSettings />);
    const box = await screen.findByRole('checkbox', { name: 'Also notify on every orchestrator reply' }) as HTMLInputElement;
    expect(box.closest('label')?.classList.contains('checkbox')).toBe(true);
    expect(box.checked).toBe(true);
    fireEvent.click(box);
    await waitFor(() => expect(puts).toEqual([{ on_reply: false }]));
    expect(box.checked).toBe(false);
    // Off on this device: the checkbox goes with the button.
    fireEvent.click(screen.getByRole('button', { name: 'Disable on this device' }));
    await screen.findByRole('button', { name: 'Enable on this device' });
    expect(screen.queryByRole('checkbox')).toBeNull();
  });

  it('explains a denied permission instead of offering the button', async () => {
    stubBrowser('denied');
    mockApi(() => ({ key: 'BAAA', subscriptions: 0 }));
    render(<PushSettings />);
    await waitFor(() => expect(screen.getByText(/blocked for this site/)).toBeTruthy());
    expect(screen.queryByRole('button', { name: /Enable/ })).toBeNull();
  });
});
