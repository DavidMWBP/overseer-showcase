import { afterEach, vi } from 'vitest';
import { cleanup } from '@testing-library/react';
import { resetInflight } from '../api';
import { resetJobs } from '../lib/jobs';
import { resetToasts } from '../lib/toasts';
import { resetLastKnown } from '../views/Review';

class FakeSocket {
  static instances: FakeSocket[] = [];
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onopen: (() => void) | null = null;
  readyState = 1;
  constructor(public url: string) { FakeSocket.instances.push(this); }
  close() { this.readyState = 3; this.onclose?.(); }
  send() {}
  push(m: unknown) { this.onmessage?.({ data: JSON.stringify(m) }); }
}
(globalThis as unknown as { WebSocket: unknown }).WebSocket = FakeSocket;
(globalThis as unknown as { __sockets: typeof FakeSocket }).__sockets = FakeSocket;
// The shimmer library constructs a ResizeObserver on mount; jsdom has none, and any view that renders <Loading> mounts one.
if (typeof (globalThis as { ResizeObserver?: unknown }).ResizeObserver === 'undefined') {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
}
// jsdom has no canvas implementation. The favicon hook treats this as title-only; individual tests replace it with a 2d stub.
if (typeof HTMLCanvasElement !== 'undefined') HTMLCanvasElement.prototype.getContext = () => null;

export type Route = (method: string, url: string, body?: unknown) => unknown;
export function mockApi(route: Route): void {
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    try {
      const data = await route(init?.method ?? 'GET', url, body);
      if (data instanceof Response) return data; // e.g. the dev proxy's bare 500 while the daemon boots
      return new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } });
    } catch (e) {
      if (e instanceof TypeError) throw e; // a network error: fetch itself rejects
      const err = e as { status?: number; message: string; body?: Record<string, unknown> };
      return new Response(JSON.stringify({ error: err.message, ...(err.body ?? {}) }), { status: err.status ?? 500, headers: { 'content-type': 'application/json' } });
    }
  }));
}
export function lastSocket(): FakeSocket { return FakeSocket.instances[FakeSocket.instances.length - 1]!; }

afterEach(() => { cleanup(); vi.unstubAllGlobals(); resetInflight(); resetLastKnown(); resetToasts(); resetJobs(); FakeSocket.instances = []; if (typeof history !== 'undefined') { history.replaceState(null, '', location.pathname); localStorage.clear(); sessionStorage.clear(); } /* absent under a node-environment test (vite-config.test.tsx) */ });
