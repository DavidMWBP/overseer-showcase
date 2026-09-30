import { describe, it, expect } from 'vitest';
import { api, fmtCostTotal } from './api';
import { mockApi } from './test/setup';

describe('fmtCostTotal', () => {
  it('reads "cost unknown" when nothing is known, a floor when part is, and a plain number when all is (round 15)', () => {
    expect(fmtCostTotal(0, 0)).toEqual({ text: '$0.00' });
    expect(fmtCostTotal(0, 1)).toMatchObject({ text: 'cost unknown', title: expect.stringMatching(/^At least: 1 worker session ended without a reported cost/) });
    expect(fmtCostTotal(0.36, 2)).toMatchObject({ text: '≥ $0.36', title: expect.stringMatching(/^At least: 2 worker sessions ended without a reported cost/) });
  });
});

describe('api.get', () => {
  it('shares one request between identical GETs in flight and issues a new one afterwards', async () => {
    const calls: string[] = [];
    mockApi((_m, url) => { calls.push(url); return { ok: true }; });
    const [a, b] = await Promise.all([api.get('/board'), api.get('/board')]);
    expect(a).toEqual({ ok: true });
    expect(b).toEqual({ ok: true });
    await api.get('/status');
    expect(calls).toEqual(['/api/board', '/api/status']);
    await api.get('/board');
    expect(calls).toEqual(['/api/board', '/api/status', '/api/board']);
  });
});
