import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { BoardResponse, OfficeSession } from '@overseer/shared';
import { Office } from './Office';
import { mockApi } from '../test/setup';
import { board as fixtureBoard, repo, reviewDetail } from '../test/fixtures';
import { badgeFor, contrastRatio, MARK_INK, ORCHESTRATOR_FILL, ORCHESTRATOR_INK, REPO_PALETTE, UNKNOWN_FILL } from './badges';
import { boxesOverlap, layoutLabels } from './labelLayout';
import BadgeLayer, { BADGE_SIZE, nearestBadge } from './components/BadgeLayer';
import { pixiBadgeInputs } from './pixi/OfficeStage';
import { deriveScene } from './officeModel';
import { PHONE_QUERY } from '../lib/phoneLayout';

const taps: ((id: string) => void)[] = [];
vi.mock('./pixi/scene', () => ({
  createScene: vi.fn(async (host: HTMLElement, options: { onTap: (id: string) => void }) => {
    host.appendChild(document.createElement('canvas'));
    taps.push(options.onTap);
    return { draw: vi.fn(), setLoop: vi.fn(), setViewport: vi.fn(), setPanning: vi.fn(), destroy: vi.fn() };
  }),
}));

const session = (over: Partial<OfficeSession> = {}): OfficeSession => ({
  session_id: 's1', role: 'worker', harness: 'claude', model: 'sonnet', resolved_model: null, account_label: null,
  bead_id: 'ov-5', bead_title: 'Review task', batch_id: 'r1-b1', repo_id: 'r1', state: 'working', stalled_since: null, ...over,
});
const second = session({ session_id: 's2', harness: 'codex', model: 'gpt-5.6-terra', bead_id: 'ov-3', bead_title: 'Running task', repo_id: 'r2', batch_id: null });
const orchestrator = session({ session_id: 'orch', role: 'orchestrator', model: 'opus', bead_id: null, bead_title: null, batch_id: null, repo_id: null });

/** Two repositories in API order: r1 (overseer's place, blue) then r2 (green). */
const board: BoardResponse = { ...fixtureBoard, repos: [...fixtureBoard.repos, { repo: { ...repo, id: 'r2', path: 'E:/Projects/other' }, batches: [], cards: [] }] };

const media = (phone: boolean) => (query: string) => ({ matches: query.includes('prefers-reduced-motion') || (phone && query === PHONE_QUERY), media: query, addEventListener: () => {}, removeEventListener: () => {} });

function measure(stageWidth: number): void {
  const original = HTMLElement.prototype.getBoundingClientRect;
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    if (this.classList.contains('office')) return { width: stageWidth, height: 900 } as DOMRect;
    if (this.classList.contains('office-stage')) return { width: stageWidth, height: stageWidth * 1056 / 1680 } as DOMRect;
    return original.call(this);
  });
}

const badges = () => [...document.querySelectorAll<HTMLElement>('.office-badge[data-badge-for]')];
const labels = () => document.querySelectorAll('.office-char-label');
const card = () => screen.queryByRole('dialog');
const created = () => waitFor(() => { if (taps.length === 0) throw new Error('no scene yet'); });

beforeEach(() => {
  mockApi((_m, url) => {
    if (url.endsWith('/api/tasks/ov-5')) return reviewDetail;
    throw Object.assign(new Error('unexpected ' + url), { status: 500 });
  });
});
afterEach(() => { taps.length = 0; vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('phone badges and desktop labels', () => {
  it('draws a badge per character and no text label on a phone', async () => {
    vi.stubGlobal('matchMedia', media(true));
    measure(366);
    render(<Office sessions={[session(), second]} board={board} />);
    await created();
    await waitFor(() => expect(badges()).toHaveLength(2));
    expect(labels()).toHaveLength(0);
  });

  it('draws the text labels and no badge on desktop', async () => {
    vi.stubGlobal('matchMedia', media(false));
    measure(1200);
    render(<Office sessions={[session(), second]} board={board} />);
    await created();
    await waitFor(() => expect(labels()).toHaveLength(2));
    expect(badges()).toHaveLength(0);
  });

  it('marks each badge with its harness on its repository colour', async () => {
    vi.stubGlobal('matchMedia', media(true));
    measure(366);
    const third = session({ session_id: 's3', harness: 'opencode', repo_id: 'r1', bead_id: 'ov-6' });
    render(<Office sessions={[session(), second, third]} board={board} />);
    await created();
    await waitFor(() => expect(badges()).toHaveLength(3));
    const read = (id: string) => { const el = document.querySelector<HTMLElement>(`[data-badge-for="${id}"]`)!; return [el.textContent, el.style.background]; };
    expect([read('s1'), read('s2'), read('s3')]).toEqual([['CL', 'rgb(29, 78, 216)'], ['CX', 'rgb(21, 128, 61)'], ['OC', 'rgb(29, 78, 216)']]);
  });
});

describe('badgeFor', () => {
  const order = ['overseer', 'acme-portal', 'third'];
  it('gives the first repository blue, the second green and a third the next palette colour', () => {
    expect(['overseer', 'acme-portal', 'third'].map((repoId) => badgeFor({ role: 'worker', harness: 'claude', repoId }, order).fill))
      .toEqual(['#1d4ed8', '#15803d', '#7e22ce']);
  });

  it('marks Claude CL, Codex CX and OpenCode OC', () => {
    expect(['claude', 'codex', 'opencode'].map((harness) => badgeFor({ role: 'worker', harness, repoId: 'overseer' }, order).mark)).toEqual(['CL', 'CX', 'OC']);
  });

  it('gives a critic the same mark and fill with the review ring kind, which the stylesheet rings', () => {
    const css = fs.readFileSync(path.resolve(__dirname, 'office.css'), 'utf8');
    expect({ badge: badgeFor({ role: 'critic', harness: 'codex', repoId: 'acme-portal' }, order), ring: /\.office-badge-critic \{[^}]*box-shadow: 0 0 0 2px #ffffff/.test(css) })
      .toEqual({ badge: { mark: 'CX', fill: '#15803d', ink: MARK_INK, kind: 'critic' }, ring: true });
  });

  it('gives the orchestrator a gold badge with its harness mark and no repository', () => {
    expect(badgeFor({ role: 'orchestrator', harness: 'claude', repoId: null }, order)).toEqual({ mark: 'CL', fill: ORCHESTRATOR_FILL, ink: ORCHESTRATOR_INK, kind: 'orchestrator' });
  });

  it('gives an unknown harness or an unlisted repository a grey question mark', () => {
    const unknown = { mark: '?', fill: UNKNOWN_FILL, ink: MARK_INK, kind: 'unknown' };
    expect([badgeFor({ role: 'worker', harness: 'gemini', repoId: 'overseer' }, order), badgeFor({ role: 'worker', harness: 'claude', repoId: 'gone' }, order), badgeFor({ role: 'worker', harness: 'claude', repoId: null }, order)])
      .toEqual([unknown, unknown, unknown]);
  });

  it('keeps every mark at least 4.5:1 on its fill', () => {
    const ratios = [...REPO_PALETTE, UNKNOWN_FILL].map((fill) => contrastRatio(MARK_INK, fill)).concat(contrastRatio(ORCHESTRATOR_INK, ORCHESTRATOR_FILL));
    expect(Math.min(...ratios)).toBeGreaterThanOrEqual(4.5);
  });
});

it('lays out 12 seated badges on a 390 px phone with no two overlapping', () => {
  const sessions = Array.from({ length: 12 }, (_, i) => session({ session_id: `s${i}`, bead_id: `ov-${i}`, role: i === 0 ? 'orchestrator' : i === 1 ? 'critic' : 'worker' }));
  const seated = deriveScene(sessions, null).agents.map((agent) => ({ ...agent, position: agent.deskPosition, pose: 'arrived' as const }));
  expect(seated).toHaveLength(12);
  // A 390 px phone gives the stage 366 px: k = 1 device pixel per art pixel at dpr 3, so the world is 560 x 352 CSS px.
  const boxes = layoutLabels(pixiBadgeInputs(seated, ['r1']), { width: 560, height: 352 }, 'overhead', BADGE_SIZE);
  const overlaps = boxes.flatMap((a, i) => boxes.slice(i + 1).filter((b) => boxesOverlap(a, b)).map((b) => `${a.id}/${b.id}`));
  const below = boxes.filter((box) => box.top + box.height > box.anchorY).map((box) => box.id);
  expect({ placed: boxes.length, overlaps, below }).toEqual({ placed: 12, overlaps: [], below: [] });
});

describe('phone card', () => {
  beforeEach(() => { vi.stubGlobal('matchMedia', media(true)); measure(366); });

  it('opens from a tap on the character', async () => {
    render(<Office sessions={[session()]} board={board} />);
    await created();
    act(() => taps[0]!('s1'));
    expect(card()?.getAttribute('aria-label')).toBe('Details of claude · sonnet · ov-5');
  });

  it('opens from a tap on the badge', async () => {
    render(<Office sessions={[session()]} board={board} />);
    await waitFor(() => expect(badges()).toHaveLength(1));
    fireEvent.click(badges()[0]!);
    expect(card()).toBeTruthy();
  });

  it('opens from the character button, which names harness, repository and task', async () => {
    render(<Office sessions={[session()]} board={board} />);
    const button = await screen.findByRole('button', { name: 'claude · sonnet · task ov-5 · repository r1 (shows details)' });
    button.focus();
    fireEvent.click(button);
    expect({ focused: document.activeElement === button, card: !!card() }).toEqual({ focused: true, card: true });
  });

  it('names the orchestrator button with task and repository none', async () => {
    render(<Office sessions={[orchestrator]} board={board} onOpenChat={() => {}} />);
    expect(await screen.findByRole('button', { name: 'claude · opus · task none · repository none · orchestrator (shows details)' })).toBeTruthy();
  });

  it('shows harness, model, task, batch, repository, role and state', async () => {
    render(<Office sessions={[session({ resolved_model: 'claude-sonnet-5' })]} board={board} />);
    await created();
    act(() => taps[0]!('s1'));
    const fields = [...card()!.querySelectorAll('dt')].map((dt) => [dt.textContent, dt.nextElementSibling?.textContent]);
    expect(fields).toEqual([['Harness', 'Claude'], ['Model', 'claude-sonnet-5'], ['Task', 'ov-5'], ['Batch', '#9310 Trend chart'], ['Repository', 'r1'], ['Role', 'worker'], ['State', 'working']]);
  });

  it('names a critic and the orchestrator by role and links the orchestrator to Chat', async () => {
    const onOpenChat = vi.fn();
    render(<Office sessions={[session({ role: 'critic', state: 'reviewing' }), orchestrator]} board={board} onOpenChat={onOpenChat} />);
    await created();
    act(() => taps[0]!('s1'));
    const critic = [within(card()!).getByText('Role').nextElementSibling?.textContent, within(card()!).getByText('State').nextElementSibling?.textContent];
    act(() => taps[0]!('orch'));
    const orch = [within(card()!).getByText('Role').nextElementSibling?.textContent, within(card()!).getByText('Repository').nextElementSibling?.textContent];
    fireEvent.click(within(card()!).getByRole('button', { name: 'Open Chat' }));
    expect({ critic, orch, chat: onOpenChat.mock.calls.length, card: card() }).toEqual({ critic: ['critic (review)', 'reviewing'], orch: ['orchestrator', 'none'], chat: 1, card: null });
  });

  it('links to the task pane the desktop click opens', async () => {
    render(<Office sessions={[session()]} board={board} />);
    await created();
    act(() => taps[0]!('s1'));
    fireEvent.click(within(card()!).getByRole('button', { name: 'Open task ov-5' }));
    expect(await screen.findByRole('complementary', { name: 'Details of ov-5' })).toBeTruthy();
  });

  it('closes on a tap on the room outside it', async () => {
    render(<Office sessions={[session()]} board={board} />);
    await created();
    act(() => taps[0]!('s1'));
    fireEvent.pointerDown(document.querySelector('.office-pixi-canvas')!);
    expect(card()).toBeNull();
  });

  it('stays open on a tap inside it', async () => {
    render(<Office sessions={[session()]} board={board} />);
    await created();
    act(() => taps[0]!('s1'));
    fireEvent.pointerDown(within(card()!).getByText('Harness'));
    expect(card()).toBeTruthy();
  });

  it('closes from its close button', async () => {
    render(<Office sessions={[session()]} board={board} />);
    await created();
    act(() => taps[0]!('s1'));
    fireEvent.click(screen.getByRole('button', { name: 'Close details' }));
    expect(card()).toBeNull();
  });

  it('closes on Escape', async () => {
    render(<Office sessions={[session()]} board={board} />);
    await created();
    act(() => taps[0]!('s1'));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(card()).toBeNull();
  });

  it('follows the session live and closes when it ends', async () => {
    const view = render(<Office sessions={[session()]} board={board} />);
    await created();
    act(() => taps[0]!('s1'));
    view.rerender(<Office sessions={[session({ state: 'verifying' })]} board={board} />);
    const live = within(card()!).getByText('State').nextElementSibling?.textContent;
    view.rerender(<Office sessions={[session({ state: 'leaving' })]} board={board} />);
    expect({ live, card: card() }).toEqual({ live: 'verifying', card: null });
  });

  it('shows one card at a time', async () => {
    render(<Office sessions={[session(), second]} board={board} />);
    await created();
    act(() => taps[0]!('s1'));
    act(() => taps[0]!('s2'));
    expect(screen.getAllByRole('dialog').map((dialog) => dialog.getAttribute('aria-label'))).toEqual(['Details of codex · gpt-5.6-terra · ov-3']);
  });
});

describe('badge touch targets', () => {
  const coarseMedia = (coarse: boolean) => (query: string) => ({
    matches: query.includes('prefers-reduced-motion') || query === PHONE_QUERY || (coarse && query === '(pointer: coarse)'),
    media: query, addEventListener: () => {}, removeEventListener: () => {},
  });
  const centre = (badge: HTMLElement) => ({ x: Number.parseFloat(badge.style.left) + BADGE_SIZE.width / 2, y: Number.parseFloat(badge.style.top) + BADGE_SIZE.height / 2 });
  const byId = (id: string) => badges().find((badge) => badge.dataset.badgeFor === id)!;
  // Two neighbouring boxes as the layout would place them: centres 30 px apart, so their 44 px targets overlap.
  const near = [
    { id: 'a', text: '', x: 0, y: 0, left: 100, top: 100, width: 24, height: 16, anchorX: 0, anchorY: 0, leaderX: 0, leaderY: 0 },
    { id: 'b', text: '', x: 0, y: 0, left: 130, top: 100, width: 24, height: 16, anchorX: 0, anchorY: 0, leaderX: 0, leaderY: 0 },
  ];

  /** A badge's target span in layer px: the badge's box plus the span's offset from the badge's padding box (1 px border). */
  const targetBox = (badge: HTMLElement) => {
    const span = badge.querySelector<HTMLElement>('.office-badge-target');
    if (!span) return null;
    const left = Number.parseFloat(badge.style.left) + 1 + Number.parseFloat(span.style.left);
    const top = Number.parseFloat(badge.style.top) + 1 + Number.parseFloat(span.style.top);
    return { left, top, width: Number.parseFloat(span.style.width), height: Number.parseFloat(span.style.height) };
  };

  /** The layout box a rendered badge sits in, as `nearestBadge` takes it. */
  const boxOf = (badge: HTMLElement) => ({ ...near[0]!, id: badge.dataset.badgeFor!, left: Number.parseFloat(badge.style.left), top: Number.parseFloat(badge.style.top) });

  it('gives each badge a 44 x 44 px target about its centre on a coarse pointer, drawn as nothing', () => {
    vi.stubGlobal('matchMedia', coarseMedia(true));
    render(<BadgeLayer stage={stage} inputs={pair} onOpen={() => {}} />);
    const css = fs.readFileSync(path.join(__dirname, 'office.css'), 'utf8');
    const rule = css.match(/\.office-badge-target \{[^}]*\}/)?.[0] ?? '';
    expect({
      targets: ['s1', 's2'].map((id) => { const box = targetBox(byId(id))!; const c = centre(byId(id)); return [box.width, box.height, box.left + box.width / 2 - c.x, box.top + box.height / 2 - c.y]; }),
      positioned: /position: absolute;/.test(rule), noFill: rule !== '' && !/background|border|box-shadow|content/.test(rule),
      badgeSize: BADGE_SIZE,
    }).toEqual({ targets: [[44, 44, 0, 0], [44, 44, 0, 0]], positioned: true, noFill: true, badgeSize: { width: 24, height: 16 } });
  });

  it('keeps a badge target at the stage edge whole and inside the stage, cut and grown back inward', () => {
    vi.stubGlobal('matchMedia', coarseMedia(true));
    const { rerender } = render(<BadgeLayer stage={stage} inputs={pair} onOpen={() => {}} />);
    const c = centre(byId('s1'));
    // The stage's top edge 10 px above s1's centre and its left edge 5 px left of it: a centred target would lose 12 px
    // above and 17 px to the left.
    const visible = { left: c.x - 5, top: c.y - 10, right: stage.width, bottom: stage.height };
    rerender(<BadgeLayer stage={stage} inputs={pair} onOpen={() => {}} visible={visible} />);
    const edge = targetBox(byId('s1'))!;
    expect({
      edge: [edge.left, edge.top, edge.width, edge.height],
      inside: edge.left >= visible.left && edge.top >= visible.top && edge.left + edge.width <= visible.right && edge.top + edge.height <= visible.bottom,
      // A tap inside the fitted target below the badge reaches it; the clipped strip above the stage edge reaches nothing.
      below: nearestBadge([boxOf(byId('s1'))], c.x, c.y + 30, visible)?.id,
      above: nearestBadge([boxOf(byId('s1'))], c.x, c.y - 15, visible),
    }).toEqual({ edge: [visible.left, visible.top, 44, 44], inside: true, below: 's1', above: null });
  });

  it('picks the badge whose centre is nearest a point in two targets, and none outside every target', () => {
    // a's centre (112, 108), b's (142, 108): 13 px right of a's centre is 17 px left of b's.
    expect([nearestBadge(near, 125, 108), nearestBadge(near, 129, 108), nearestBadge(near, 100, 140), nearestBadge([], 112, 108)]).toEqual([{ id: 'a', distance: 13 }, { id: 'b', distance: 13 }, null, null]);
  });

  // Two characters 30 px apart on a 366 px phone stage: their badges sit side by side and their 44 px targets overlap.
  const stage = { width: 366, height: 230 };
  const pair = (['s1', 's2'] as const).map((id, index) => ({
    id, text: '', x: ((150 + index * 30) / stage.width) * 100, y: 50, badge: badgeFor({ role: 'worker', harness: 'claude', repoId: 'r1' }, ['r1']),
  }));

  it('opens the badge whose centre is nearest a tap on the other badge target on a coarse pointer', () => {
    vi.stubGlobal('matchMedia', coarseMedia(true));
    const onOpen = vi.fn();
    render(<BadgeLayer stage={stage} inputs={pair} onOpen={onOpen} />);
    const [a, b] = [centre(byId('s1')), centre(byId('s2'))];
    const gap = Math.hypot(b.x - a.x, b.y - a.y);
    const towards = (from: typeof a, to: typeof a) => ({ x: from.x + (to.x - from.x) * (5 / gap), y: from.y + (to.y - from.y) * (5 / gap) });
    // 5 px off the second badge's centre, reported on the first badge; then 5 px off the first's, reported on the second.
    const nearSecond = towards(b, a);
    const nearFirst = towards(a, b);
    fireEvent.click(byId('s1'), { clientX: nearSecond.x, clientY: nearSecond.y });
    fireEvent.click(byId('s2'), { clientX: nearFirst.x, clientY: nearFirst.y });
    // And the midpoint, a hair towards the second.
    fireEvent.click(byId('s1'), { clientX: (a.x + b.x) / 2 + 0.5, clientY: (a.y + b.y) / 2 });
    expect({ overlap: gap < 44, opened: onOpen.mock.calls.map(([id]) => id), tapped: onOpen.mock.calls.every(([, tap]) => typeof tap?.distance === 'number') }).toEqual({ overlap: true, opened: ['s2', 's1', 's2'], tapped: true });
  });

  it('opens the tapped badge on a fine pointer wherever the click lands', () => {
    vi.stubGlobal('matchMedia', coarseMedia(false));
    const onOpen = vi.fn();
    render(<BadgeLayer stage={stage} inputs={pair} onOpen={onOpen} />);
    const b = centre(byId('s2'));
    fireEvent.click(byId('s1'), { clientX: b.x, clientY: b.y });
    expect({ opened: onOpen.mock.calls, targets: document.querySelectorAll('.office-badge-target').length }).toEqual({ opened: [['s1']], targets: 0 });
  });
});

describe('phone badge key', () => {
  beforeEach(() => { vi.stubGlobal('matchMedia', media(true)); measure(366); });
  const key = () => document.querySelector('.office-badge-key');

  it('lists only the repositories and harnesses present', async () => {
    render(<Office sessions={[session(), orchestrator]} board={board} />);
    await created();
    const el = key()!;
    expect({
      repos: [...el.querySelectorAll('[data-key-repo]')].map((item) => item.textContent),
      harnesses: [...el.querySelectorAll('[data-key-harness]')].map((item) => item.textContent),
      unknown: el.querySelector('[data-key-unknown]'),
    }).toEqual({ repos: ['r1'], harnesses: ['CL Claude'], unknown: null });
  });

  it('names the grey question mark when an unknown harness or unlisted repository is present', async () => {
    render(<Office sessions={[session({ repo_id: 'gone' })]} board={board} />);
    await created();
    const el = key()!;
    expect({
      repos: el.querySelectorAll('[data-key-repo]').length,
      harnesses: el.querySelectorAll('[data-key-harness]').length,
      unknown: el.querySelector('[data-key-unknown]')?.textContent,
    }).toEqual({ repos: 0, harnesses: 0, unknown: '?unknown' });
  });

  it('keeps a key wider than the room inside it, wrapping onto more lines instead of scrolling sideways', () => {
    const css = fs.readFileSync(path.resolve(__dirname, 'office.css'), 'utf8');
    const rule = css.match(/\.office-badge-key \{[^}]*\}/)![0];
    expect({ wrap: rule.includes('flex-wrap: wrap;'), cap: rule.includes('max-width: 100%;'), scroll: /overflow-x|nowrap/.test(rule) })
      .toEqual({ wrap: true, cap: true, scroll: false });
  });

  const entries = (el: Element) => ({
    orchestrator: [...el.querySelectorAll('[data-key-orchestrator]')].map((item) => item.textContent),
    repos: [...el.querySelectorAll('[data-key-repo]')].map((item) => item.textContent),
    harnesses: [...el.querySelectorAll('[data-key-harness]')].map((item) => item.textContent),
    unknown: [...el.querySelectorAll('[data-key-unknown]')].map((item) => item.textContent),
  });

  it('names the orchestrator gold pill when the orchestrator is alone, with no repository entry', async () => {
    render(<Office sessions={[orchestrator]} board={board} />);
    await created();
    const el = key()!;
    const pill = el.querySelector<HTMLElement>('[data-key-orchestrator] .office-key-orchestrator')!;
    expect({ ...entries(el), first: el.firstElementChild?.hasAttribute('data-key-orchestrator'), fill: pill.style.background })
      .toEqual({ orchestrator: ['orchestrator'], repos: [], harnesses: ['CL Claude'], unknown: [], first: true, fill: 'rgb(251, 191, 36)' });
  });

  it('names the orchestrator before the repositories of workers in two repositories', async () => {
    render(<Office sessions={[orchestrator, session(), second]} board={board} />);
    await created();
    expect(entries(key()!)).toEqual({ orchestrator: ['orchestrator'], repos: ['r1', 'r2'], harnesses: ['CL Claude', 'CX Codex'], unknown: [] });
  });

  it('drops the orchestrator entry while the orchestrator is leaving', async () => {
    // With motion, a leaving character stays in the frame walking out, which is the state the key has to skip.
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: query === PHONE_QUERY, media: query, addEventListener: () => {}, removeEventListener: () => {} }));
    const view = render(<Office sessions={[orchestrator, session()]} board={board} />);
    await created();
    const before = entries(key()!).orchestrator;
    view.rerender(<Office sessions={[{ ...orchestrator, state: 'leaving' }, session()]} board={board} />);
    expect({ before, walkingOut: !!document.querySelector('[data-badge-for="orch"]'), after: entries(key()!) })
      .toEqual({ before: ['orchestrator'], walkingOut: true, after: { orchestrator: [], repos: ['r1'], harnesses: ['CL Claude'], unknown: [] } });
  });

  it('covers an orchestrator with an unknown harness by the unknown entry, with no gold entry', async () => {
    render(<Office sessions={[{ ...orchestrator, harness: 'gemini' as OfficeSession['harness'] }]} board={board} />);
    await created();
    expect(entries(key()!)).toEqual({ orchestrator: [], repos: [], harnesses: [], unknown: ['?unknown'] });
  });

  it('lists each entry once when several characters repeat a state', async () => {
    const sessions = [
      orchestrator, session(), session({ session_id: 's3', bead_id: 'ov-6' }), session({ session_id: 's4', role: 'critic', bead_id: 'ov-7' }),
      second, session({ session_id: 's5', harness: 'codex', repo_id: 'r2', bead_id: 'ov-8' }),
      session({ session_id: 's6', harness: 'gemini' as OfficeSession['harness'], bead_id: 'ov-9' }), session({ session_id: 's7', repo_id: 'gone', bead_id: 'ov-10' }),
    ];
    render(<Office sessions={sessions} board={board} />);
    await created();
    expect(entries(key()!)).toEqual({ orchestrator: ['orchestrator'], repos: ['r1', 'r2'], harnesses: ['CL Claude', 'CX Codex'], unknown: ['?unknown'] });
  });

  it('is absent with no characters', async () => {
    render(<Office sessions={[]} board={board} />);
    await created();
    expect(key()).toBeNull();
  });

  it('is absent on desktop', async () => {
    vi.stubGlobal('matchMedia', media(false));
    render(<Office sessions={[session()]} board={board} />);
    await created();
    expect(key()).toBeNull();
  });
});
