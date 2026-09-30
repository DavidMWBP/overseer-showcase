import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { BOARD_COLUMNS } from '../views/Board';
import { CHIP_GAP, CHIP_MARGIN, chipPlacement, hitBox, MIN_HIT_PX, MIN_TOUCH_HIT_PX, OfficeCountRow, RoomPropButtons, type OfficeRoomProps } from './RoomProps';
import { ROOM_PROP_BOXES, ROOM_PROP_SHEAR } from './pixi/roomProps';

const busy = { ready: 4, blocked: 1, running: 5, verifying: 1, review: 2, done: 7 } as const;
const officeColumns = () => BOARD_COLUMNS.map(({ key, label }) => ({
  key,
  label: key === 'done' ? 'Done today' : label,
  ids: Array.from({ length: busy[key] }, (_, k) => `${key}-${k}`),
}));
const props = (over: Partial<OfficeRoomProps> = {}): OfficeRoomProps => ({
  questions: 3, reviewBatches: ['r1/r1-b1', 'r1/r1-b2'],
  columns: officeColumns(),
  onOpenChat: vi.fn(), onOpenReview: vi.fn(), onOpenBoard: vi.fn(), ...over,
});
const loading = (): Partial<OfficeRoomProps> => ({ questions: null, reviewBatches: null, columns: officeColumns().map((column) => ({ ...column, ids: null })) });
const coarse = (matches: boolean) => vi.stubGlobal('matchMedia', (query: string) => ({ matches: matches && query === '(pointer: coarse)', media: query, addEventListener: () => {}, removeEventListener: () => {} }));
const BOARD_NAME = 'Open Board, Ready: 4, Blocked: 1, Running: 5, Verifying: 1, Review: 2, Done today: 7';

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('the room object buttons', () => {
  it('name each object with its destination and counts, in tab order Questions, In review, Board', () => {
    render(<RoomPropButtons props={props()} scale={1} />);
    expect(screen.getAllByRole('button').map((button) => button.getAttribute('aria-label'))).toEqual(['Open Chat, 3 questions', 'Open Review, 2 batches in review', BOARD_NAME]);
  });
  it('use the singular at 1', () => {
    render(<RoomPropButtons props={props({ questions: 1, reviewBatches: ['r1/r1-b1'] })} scale={1} />);
    expect(screen.getAllByRole('button').slice(0, 2).map((button) => button.getAttribute('aria-label'))).toEqual(['Open Chat, 1 question', 'Open Review, 1 batch in review']);
  });
  it('keep every button at 0 so each object stays reachable', () => {
    render(<RoomPropButtons props={props({ questions: 0, reviewBatches: [], columns: officeColumns().map((column) => ({ ...column, ids: [] })) })} scale={1} />);
    const board = screen.getAllByRole('button').at(-1)!;
    expect({ name: board.getAttribute('aria-label'), chip: board.textContent }).toEqual({
      name: 'Open Board, Ready: 0, Blocked: 0, Running: 0, Verifying: 0, Review: 0, Done today: 0',
      chip: 'Ready 0 · Blocked 0 · Running 0 · Verifying 0 · Review 0 · Done today 0',
    });
  });
  it('put the full column names and counts in the whiteboard\'s tooltip and chip', () => {
    render(<RoomPropButtons props={props()} scale={1} />);
    const board = screen.getByRole('button', { name: BOARD_NAME });
    expect({ title: board.title, chip: board.textContent }).toEqual({ title: BOARD_NAME, chip: 'Ready 4 · Blocked 1 · Running 5 · Verifying 1 · Review 2 · Done today 7' });
  });
  it('show no digit in a name or chip before the counts load', () => {
    render(<RoomPropButtons props={props(loading())} scale={1} />);
    const texts = screen.getAllByRole('button').flatMap((button) => [button.getAttribute('aria-label') ?? '', button.textContent ?? '']);
    expect({ texts, digits: texts.some((value) => /\d/.test(value)) }).toEqual({
      texts: ['Open Chat, questions loading', 'Questions', 'Open Review, batches in review loading', 'In review', 'Open Board, columns loading', 'Board'],
      digits: false,
    });
  });
  it.each([
    ['Open Chat, 3 questions', 'onOpenChat'],
    ['Open Review, 2 batches in review', 'onOpenReview'],
    [BOARD_NAME, 'onOpenBoard'],
  ] as const)('opens today\'s destination from %s', (name, handler) => {
    const handlers = props();
    render(<RoomPropButtons props={handlers} scale={1} />);
    fireEvent.click(screen.getByRole('button', { name }));
    expect((['onOpenChat', 'onOpenReview', 'onOpenBoard'] as const).map((key) => (handlers[key] as ReturnType<typeof vi.fn>).mock.calls.length))
      .toEqual((['onOpenChat', 'onOpenReview', 'onOpenBoard'] as const).map((key) => (key === handler ? 1 : 0)));
  });
  it('are native buttons, so Enter and Space open them and Tab reaches them', () => {
    render(<RoomPropButtons props={props()} scale={1} />);
    expect(screen.getAllByRole('button').map((button) => [button.tagName, button.getAttribute('type'), button.tabIndex])).toEqual([['BUTTON', 'button', 0], ['BUTTON', 'button', 0], ['BUTTON', 'button', 0]]);
  });
  it('cover each object\'s world box at the stage scale', () => {
    render(<RoomPropButtons props={props()} scale={2} />);
    const [x, y, w, h] = ROOM_PROP_BOXES.board;
    const style = screen.getByRole('button', { name: BOARD_NAME }).style;
    expect([style.left, style.top, style.width, style.height]).toEqual([`${x * 2}px`, `${y * 2}px`, `${w * 2}px`, `${h * 2}px`]);
  });
  it('grow a small object\'s focus box to 24 CSS px about its centre with a fine pointer', () => {
    coarse(false);
    render(<RoomPropButtons props={props()} scale={0.1} />);
    const style = screen.getByRole('button', { name: 'Open Review, 2 batches in review' }).style;
    const [x, y, w, h] = ROOM_PROP_BOXES.review;
    expect({ size: [style.width, style.height], centre: [parseFloat(style.left) + MIN_HIT_PX / 2, parseFloat(style.top) + MIN_HIT_PX / 2].map((v) => v.toFixed(3)) })
      .toEqual({ size: ['24px', '24px'], centre: [(x + w / 2) * 0.1, (y + h / 2) * 0.1].map((v) => v.toFixed(3)) });
  });
  it('grow every focus box to 44 CSS px on a touch pointer', () => {
    coarse(true);
    render(<RoomPropButtons props={props()} scale={0.25} />);
    expect(screen.getAllByRole('button').map((button) => Math.min(parseFloat(button.style.width), parseFloat(button.style.height)) >= MIN_TOUCH_HIT_PX)).toEqual([true, true, true]);
  });
  it('keep a box larger than the minimum at its own size', () => expect(hitBox([10, 20, 100, 50], 1, 24)).toEqual({ left: 10, top: 20, width: 100, height: 50 }));
  it('mark the object the pointer is over, so its chip shows', () => {
    render(<RoomPropButtons props={props()} scale={1} hovered="board" />);
    expect(screen.getAllByRole('button').map((button) => button.classList.contains('office-room-prop-hover'))).toEqual([false, false, true]);
  });
  it('draw a focus ring, show the chip on hover and focus, and let pointer input through to the canvas', () => {
    const css = fs.readFileSync(path.resolve(__dirname, 'office.css'), 'utf8');
    expect({
      ring: /\.office-room-prop:focus-visible \{ outline: 2px solid #7fb8ff;/.test(css),
      chipHidden: /\.office-room-prop-chip \{\s*visibility: hidden;/.test(css),
      chipShown: /\.office-room-prop-hover \.office-room-prop-chip,\s*\.office-room-prop:focus-visible \.office-room-prop-chip \{ visibility: visible; \}/.test(css),
      passThrough: /\.office-room-prop \{[^}]*pointer-events: none;/.test(css),
    }).toEqual({ ring: true, chipHidden: true, chipShown: true, passThrough: true });
  });
  it('clip the stage without making it a scroll box, so focusing an object outside the visible room cannot scroll it', () => {
    const css = fs.readFileSync(path.resolve(__dirname, 'office.css'), 'utf8');
    expect(/\.office-stage \{[^}]*overflow: clip;/.test(css)).toBe(true);
  });
});

describe('the room object chip', () => {
  const stage = { left: 0, top: 0, right: 1000, bottom: 600 };
  const chip = { width: 320, height: 18 };
  it('centres the chip on its object, 4 px below it', () => {
    const hit = { left: 600, top: 100, width: 140, height: 150 };
    expect(chipPlacement(hit, chip, stage)).toEqual({ left: 70 - 160, top: 150 + CHIP_GAP });
  });
  it('centres it on the visible part of an object partly past the stage edge, and keeps it inside the stage', () => {
    const hit = { left: 900, top: 100, width: 140, height: 150 }; // 100 px of it in view
    const { left, top } = chipPlacement(hit, chip, stage);
    expect({ right: hit.left + left + chip.width, top }).toEqual({ right: stage.right - CHIP_MARGIN, top: 150 + CHIP_GAP });
  });
  it('keeps it inside the stage on the left too', () => {
    const hit = { left: -40, top: 100, width: 140, height: 150 };
    expect(hit.left + chipPlacement(hit, chip, stage).left).toBe(CHIP_MARGIN);
  });
  it('puts it above an object the stage ends below', () => {
    const hit = { left: 400, top: 500, width: 140, height: 90 };
    expect(chipPlacement(hit, chip, stage).top).toBe(-CHIP_GAP - chip.height);
  });
  it('hangs it under the lowest visible point of a sheared object, and over the highest one', () => {
    const hit = { left: 900, top: 100, width: 140, height: 150 }; // 100 px in view; the edges drop 0.5 px per px
    const below = chipPlacement(hit, chip, stage, 0.5).top;
    const above = chipPlacement({ ...hit, left: -40, top: 440 }, chip, stage, 0.5).top;
    expect({ below, above }).toEqual({ below: 150 - 0.5 * 40 + CHIP_GAP, above: 0.5 * 40 - CHIP_GAP - chip.height });
  });
  it('holds it at the stage\'s left edge when it is wider than the stage', () => {
    const hit = { left: 100, top: 100, width: 140, height: 150 };
    expect(100 + chipPlacement(hit, { width: 400, height: 18 }, { left: 0, top: 0, right: 300, bottom: 600 }).left).toBe(CHIP_MARGIN);
  });
  it('places each chip from its measured size, and moves it when the visible box moves (a pan or a resize)', () => {
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (this: HTMLElement) { return this.classList.contains('office-room-prop-chip') ? 320 : 0; });
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) { return this.classList.contains('office-room-prop-chip') ? 18 : 0; });
    const [x, y, w, h] = ROOM_PROP_BOXES.board;
    const boardChip = () => {
      const style = (screen.getByRole('button', { name: BOARD_NAME }).querySelector('.office-room-prop-chip') as HTMLElement).style;
      return { left: Number.parseFloat(style.left), top: Number.parseFloat(style.top) };
    };
    const inView = { left: x - 400, top: y - 100, right: x + w + 400, bottom: y + h + 300 };
    const view = render(<RoomPropButtons props={props()} scale={1} visible={inView} />);
    const centred = boardChip();
    // A pan that leaves 60 px of the whiteboard in view at the stage's right edge.
    view.rerender(<RoomPropButtons props={props()} scale={1} visible={{ ...inView, left: x + 60 - 900, right: x + 60 }} />);
    // The whiteboard is sheared onto the wall, so with its low right end past the stage its visible part ends higher.
    expect({ centred, panned: boardChip() }).toEqual({
      centred: { left: w / 2 - 160, top: h + CHIP_GAP },
      panned: { left: 60 - CHIP_MARGIN - 320, top: h - ROOM_PROP_SHEAR.board * (w - 60) + CHIP_GAP },
    });
  });
});

describe('the phone count row', () => {
  const row = () => within(screen.getByRole('group', { name: 'Office shortcuts' }));
  it('shows an icon and the number for each object, in order', () => {
    const { container } = render(<OfficeCountRow props={props()} />);
    expect([...container.querySelectorAll<HTMLElement>('.office-count')].map((button) => [button.dataset.officeCount, button.querySelector('img')!.getAttribute('src'), button.textContent]))
      .toEqual([
        ['questions', '/office/pixi/props/icon-question.png', '3'], ['in-review', '/office/pixi/props/folder.png', '2'],
        ...BOARD_COLUMNS.map(({ key }) => [key, `/office/pixi/props/icon-${key}.png`, String(busy[key])]),
      ]);
  });
  it('keys In review apart from the Board\'s Review column', () => {
    const { container } = render(<OfficeCountRow props={props()} />);
    const keys = [...container.querySelectorAll<HTMLElement>('.office-count')].map((button) => button.dataset.officeCount);
    expect(new Set(keys).size).toBe(8);
  });
  it('gives full names for screen readers', () => {
    render(<OfficeCountRow props={props()} />);
    const buttons = row().getAllByRole('button');
    expect(buttons.map((button) => button.getAttribute('aria-label'))).toEqual([
      'Open Chat, 3 questions', 'Open Review, 2 batches in review',
      ...officeColumns().map(({ key, label }) => `Open Board, ${label}: ${busy[key]}`),
    ]);
    expect(buttons.at(-1)?.title).toBe('Open Board, Done today: 7');
  });
  it('opens Chat, Review and the Board from its buttons', () => {
    const handlers = props();
    render(<OfficeCountRow props={handlers} />);
    for (const button of row().getAllByRole('button')) fireEvent.click(button);
    expect([handlers.onOpenChat, handlers.onOpenReview, handlers.onOpenBoard].map((fn) => (fn as ReturnType<typeof vi.fn>).mock.calls.length)).toEqual([1, 1, 6]);
  });
  it('dims a zero and nothing else', () => {
    const { container } = render(<OfficeCountRow props={props({ questions: 0, columns: officeColumns().map((column) => (column.key === 'done' ? { ...column, ids: [] } : column)) })} />);
    const done = container.querySelector<HTMLButtonElement>('.office-count[data-office-count="done"]')!;
    expect({
      dimmed: [...container.querySelectorAll('.office-count-zero')].map((button) => button.getAttribute('data-office-count')),
      done: [done.textContent, done.title],
    }).toEqual({ dimmed: ['questions', 'done'], done: ['0', 'Open Board, Done today: 0'] });
  });
  it('shows no digit before the counts load', () => {
    const { container } = render(<OfficeCountRow props={props(loading())} />);
    const outside = [...container.querySelectorAll<HTMLElement>('.office-count')].map((button) => [...button.childNodes]
      .filter((node) => !(node instanceof HTMLElement && node.dataset.testid === 'shimmer')).map((node) => node.textContent).join(''));
    expect({ outside, shimmers: container.querySelectorAll('.office-count [data-testid="shimmer"]').length }).toEqual({ outside: Array(8).fill(''), shimmers: 8 });
  });
  it('makes each button 44 px tall with a dimmed zero in the stylesheet', () => {
    const css = fs.readFileSync(path.resolve(__dirname, 'office.css'), 'utf8');
    expect({ height: /\.office-count \{[^}]*height: 44px;/.test(css), zero: /\.office-count-zero \{ color: var\(--muted\); \}/.test(css) }).toEqual({ height: true, zero: true });
  });
  // The row prints the exact count (the room objects cap theirs at 99+), so 120 is its widest three-character number.
  it('makes a button showing 0 and one showing a three-digit count at least 44 px wide on a coarse pointer, and keeps 32 px on a fine one', () => {
    const { container } = render(<OfficeCountRow props={props({ questions: 0, reviewBatches: Array.from({ length: 120 }, (_, k) => `r1/b${k}`) })} />);
    const button = (key: string) => container.querySelector<HTMLElement>(`.office-count[data-office-count="${key}"]`)!;
    const css = fs.readFileSync(path.resolve(__dirname, 'office.css'), 'utf8');
    expect({
      zero: [button('questions').textContent, button('questions').classList.contains('office-count')],
      max: [button('in-review').textContent, button('in-review').classList.contains('office-count')],
      coarse: /@media \(pointer: coarse\) \{ \.office-count \{ min-width: 44px; \} \}/.test(css),
      fine: /\.office-count \{[^}]*min-width: 32px;/.test(css),
    }).toEqual({ zero: ['0', true], max: ['120', true], coarse: true, fine: true });
  });
});
