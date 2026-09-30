import { describe, it, expect, vi } from 'vitest';
import { render, act, waitFor } from '@testing-library/react';
import type { ChatRow, Plan, Repo } from '@overseer/shared';
import { App } from './App';
import { mockApi } from './test/setup';
import { chat, doctorOk, repo, status } from './test/fixtures';

vi.mock('./office/pixi/scene', () => import('./test/fakeOfficeScene'));

/** What the shell handed the views: a list still being fetched arrives as null, not as an empty array. */
const probes = vi.hoisted(() => ({
  needs: [] as { chat: unknown; plans: unknown; repos: unknown }[],
  planLists: [] as unknown[],
}));

vi.mock('./lib/needsYou', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./lib/needsYou')>();
  return {
    ...actual,
    needsYouItems: (_board: unknown, chat: unknown, plans: unknown, repos: unknown) => {
      probes.needs.push({ chat, plans, repos });
      return [];
    },
  };
});

vi.mock('./views/PlanList', () => ({
  PlanList: (props: { plans: unknown }) => { probes.planLists.push(props.plans); return <span data-testid="plan-list-probe" />; },
}));

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

const plan: Plan = { id: 'r1-p1', repo_id: 'r1', title: 'Accounts plan', status: 'draft', batch_id: null, revision: 1, created_at: 't', updated_at: 't', steps: [{ title: 'a', description: '', dependsOn: [] }] };

describe('App unloaded state', () => {
  it('hands the views null before each fetch resolves and the fetched arrays after', async () => {
    const reposRes = deferred<Repo[]>();
    const plansRes = deferred<Plan[]>();
    const allPlansRes = deferred<Plan[]>();
    const chatRes = deferred<{ rows: ChatRow[]; has_more: boolean; oldest_id: number | null }>();
    mockApi((method, url) => {
      if (url.endsWith('/api/repos')) return reposRes.promise;
      if (url.endsWith('/api/plans/all')) return allPlansRes.promise;
      if (url.endsWith('/api/plans')) return plansRes.promise;
      if (url.startsWith('/api/chat')) return chatRes.promise;
      if (url.endsWith('/api/status')) return status;
      if (url.endsWith('/api/daemon')) return { pid: 1, started_at: 't', commit: 'a', source_head: 'a', restart_needed: false };
      if (url.endsWith('/api/doctor')) return doctorOk;
      if (url.endsWith('/api/board')) return { bd_ok: true, repos: [] };
      if (url.endsWith('/api/costs')) return { repos: [], batches: [] };
      throw Object.assign(new Error(`unexpected ${method} ${url}`), { status: 500 });
    });
    history.replaceState(null, '', '#plan');
    render(<App />);
    await waitFor(() => expect(probes.needs.length).toBeGreaterThan(0));
    const last = () => probes.needs[probes.needs.length - 1]!;
    expect(last().repos).toBeNull();
    expect(last().plans).toBeNull();
    expect(last().chat).toBeNull();
    expect(probes.planLists[probes.planLists.length - 1]).toBeNull();

    await act(async () => {
      reposRes.resolve([repo]);
      plansRes.resolve([plan]);
      allPlansRes.resolve([plan]);
      chatRes.resolve({ rows: chat, has_more: false, oldest_id: null });
    });
    await waitFor(() => {
      expect(last().repos).toEqual([repo]);
      expect(last().plans).toEqual([plan]);
      expect(last().chat).toEqual(chat);
      expect(probes.planLists[probes.planLists.length - 1]).toEqual([plan]);
    });
  });
});
