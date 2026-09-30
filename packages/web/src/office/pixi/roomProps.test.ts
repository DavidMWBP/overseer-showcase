import { describe, expect, it } from 'vitest';
import type { BoardColumn } from '@overseer/shared';
import {
  BOARD_AT, countText, FLUTTER_MS, FOLDER_AT, headerBox, headerRects, markerNote, NOTE_FADE_MS, NOTE_MOVE_MS, NOTE_POP_MS, noteSlot, NUMBER_POP_MS, PEEL_MS,
  PROP_COLUMNS, propHitArea, QUESTION_NOTE_AT, ROOM_PROP_BOXES, RoomPropsAnimator, SLIDE_MS, textWidth, type PropItem, type RoomPropsInput,
} from './roomProps';

const empty = (): Record<BoardColumn, string[]> => ({ ready: [], blocked: [], running: [], verifying: [], review: [], done: [] });
const ids = (n: number, prefix = 't') => Array.from({ length: n }, (_, k) => `${prefix}-${k}`);
/** Batch keys in review: repository id and batch id. */
const batches = (...names: string[]) => names.map((name) => `r1/${name}`);
const many = (n: number) => batches(...Array.from({ length: n }, (_, k) => `b${k}`));
const input = (over: Partial<RoomPropsInput> = {}): RoomPropsInput => ({ questions: 0, reviewBatches: [], columns: empty(), reviewReady: null, ...over });

/** An animator that has seen `before` at time 0 and `after` at time 1000; `at(ms)` draws `ms` after the change. */
function changed(before: RoomPropsInput, after: RoomPropsInput, still = false) {
  const animator = new RoomPropsAnimator();
  animator.update(before, 0);
  animator.items(0, still);
  animator.update(after, 1000);
  return { animator, at: (ms: number) => animator.items(1000 + ms, still) };
}
function drawn(state: RoomPropsInput): PropItem[] {
  const animator = new RoomPropsAnimator();
  animator.update(state, 0);
  return animator.items(0, false);
}
const find = (items: readonly PropItem[], key: string) => items.find((entry) => entry.key === key);
const text = (entry: PropItem | undefined) => (entry && 'note' in entry.paint ? entry.paint.note : entry && 'marker' in entry.paint ? entry.paint.marker : undefined);
const keys = (items: readonly PropItem[], prefix: string) => items.filter((entry) => entry.key.startsWith(prefix)).map((entry) => entry.key);
const header = (items: readonly PropItem[], column: BoardColumn) => find(items, `header-${column}`)!.paint;

describe('the question note on the orchestrator\'s monitor', () => {
  it('is absent at 0', () => expect(find(drawn(input({ questions: 0 })), 'question-note')).toBeUndefined());
  it('reads 1? at 1', () => expect(text(find(drawn(input({ questions: 1 })), 'question-note'))).toBe('1?'));
  it('is exact to 99', () => expect(text(find(drawn(input({ questions: 99 })), 'question-note'))).toBe('99?'));
  it('reads 99+ past 99', () => expect(text(find(drawn(input({ questions: 100 })), 'question-note'))).toBe('99+'));
  it('draws nothing before the chat has loaded', () => expect(find(drawn(input({ questions: null })), 'question-note')).toBeUndefined());
  it('sits on the top edge of the right monitor, inside its button box', () => {
    const [bx, by, bw, bh] = ROOM_PROP_BOXES.questions;
    const [x, y] = QUESTION_NOTE_AT;
    expect(x >= bx && y >= by && x + textWidth('99+', 2) + 6 <= bx + bw && y + 14 <= by + bh).toBe(true);
  });

  it('starts its flutter on 0 -> 1 above the edge, turned and transparent', () => {
    const note = find(changed(input({ questions: 0 }), input({ questions: 1 })).at(0), 'question-note')!;
    expect({ alpha: note.alpha, y: note.y }).toEqual({ alpha: 0, y: QUESTION_NOTE_AT[1] - 16 });
  });
  it('ends its flutter on the edge, upright and opaque', () => {
    const note = find(changed(input({ questions: 0 }), input({ questions: 1 })).at(FLUTTER_MS), 'question-note')!;
    expect({ alpha: note.alpha, y: note.y, rotation: note.rotation, text: text(note) }).toEqual({ alpha: 1, y: QUESTION_NOTE_AT[1], rotation: 0, text: '1?' });
  });
  it('writes the new number as soon as the count changes', () => {
    expect(text(find(changed(input({ questions: 2 }), input({ questions: 3 })).at(0), 'question-note'))).toBe('3?');
  });
  it('ends a number change at its normal size', () => {
    expect(find(changed(input({ questions: 2 }), input({ questions: 3 })).at(FLUTTER_MS), 'question-note')!.scale).toBe(1);
  });
  it('starts its peel on 1 -> 0 still showing 1?', () => {
    const note = find(changed(input({ questions: 1 }), input({ questions: 0 })).at(0), 'question-note')!;
    expect({ alpha: note.alpha, text: text(note), y: note.y }).toEqual({ alpha: 1, text: '1?', y: QUESTION_NOTE_AT[1] });
  });
  it('is gone once the peel ends', () => {
    expect(find(changed(input({ questions: 1 }), input({ questions: 0 })).at(PEEL_MS), 'question-note')).toBeUndefined();
  });
  it('shows only the end state under reduced motion', () => {
    const note = find(changed(input({ questions: 0 }), input({ questions: 1 }), true).at(0), 'question-note')!;
    expect({ alpha: note.alpha, y: note.y, rotation: note.rotation }).toEqual({ alpha: 1, y: QUESTION_NOTE_AT[1], rotation: 0 });
  });
});

describe('the folders on the meeting table', () => {
  const folders = (items: readonly PropItem[]) => items.filter((entry) => /^(folder|stack)-/.test(entry.key) && !entry.key.endsWith('-glow') && entry.key !== 'stack-note');
  const at = (entry: PropItem | undefined) => entry && [entry.x, entry.y];
  it('leave the table empty at 0', () => expect(folders(drawn(input({ reviewBatches: [] })))).toHaveLength(0));
  it('put one folder, keyed by its batch, at the first seat at 1', () => {
    expect(folders(drawn(input({ reviewBatches: batches('a') }))).map((entry) => [entry.key, entry.x, entry.y])).toEqual([['folder-r1/a', ...FOLDER_AT[0]!]]);
  });
  it('are exact to 4, one per seat and no stack', () => {
    expect(folders(drawn(input({ reviewBatches: many(4) }))).map((entry) => entry.key)).toEqual(['folder-r1/b0', 'folder-r1/b1', 'folder-r1/b2', 'folder-r1/b3']);
  });
  it('stack past 4 with a numbered note', () => {
    const items = drawn(input({ reviewBatches: many(7) }));
    expect({ seats: keys(items, 'folder-').filter((key) => !key.endsWith('-glow')), stack: keys(items, 'stack-').filter((key) => !key.endsWith('-glow')), note: text(find(items, 'stack-note')) })
      .toEqual({ seats: ['folder-r1/b0', 'folder-r1/b1', 'folder-r1/b2', 'folder-r1/b3'], stack: ['stack-0', 'stack-1', 'stack-2', 'stack-note'], note: '7' });
  });
  it('cap the stack at four folders and write 99+ past 99', () => {
    const items = drawn(input({ reviewBatches: many(150) }));
    expect({ stack: keys(items, 'stack-').length, note: text(find(items, 'stack-note')) }).toEqual({ stack: 5, note: '99+' });
  });
  it('draw nothing before the board has loaded', () => expect(folders(drawn(input({ reviewBatches: null })))).toHaveLength(0));

  it('start a slide-on from the left, transparent', () => {
    const folder = find(changed(input({ reviewBatches: batches('a') }), input({ reviewBatches: batches('a', 'b') })).at(0), 'folder-r1/b')!;
    expect({ alpha: folder.alpha, x: folder.x, y: folder.y }).toEqual({ alpha: 0, x: FOLDER_AT[1]![0] - 22, y: FOLDER_AT[1]![1] + 11 });
  });
  it('end a slide-on at the seat', () => {
    const folder = find(changed(input({ reviewBatches: batches('a') }), input({ reviewBatches: batches('a', 'b') })).at(SLIDE_MS), 'folder-r1/b')!;
    expect({ alpha: folder.alpha, x: folder.x, y: folder.y }).toEqual({ alpha: 1, x: FOLDER_AT[1]![0], y: FOLDER_AT[1]![1] });
  });
  it('start a slide-off at the seat', () => {
    const folder = find(changed(input({ reviewBatches: batches('a', 'b') }), input({ reviewBatches: batches('a') })).at(0), 'folder-r1/b')!;
    expect({ alpha: folder.alpha, x: folder.x }).toEqual({ alpha: 1, x: FOLDER_AT[1]![0] });
  });
  it('are gone once a slide-off ends', () => {
    expect(find(changed(input({ reviewBatches: batches('a', 'b') }), input({ reviewBatches: batches('a') })).at(SLIDE_MS), 'folder-r1/b')).toBeUndefined();
  });
  it('swap the seat of a batch that left for one that entered at the same count: the old folder slides off as the new one slides on', () => {
    const items = changed(input({ reviewBatches: batches('a', 'b') }), input({ reviewBatches: batches('a', 'c') })).at(0);
    expect({ a: find(items, 'folder-r1/a')!.alpha, off: [find(items, 'folder-r1/b')!.alpha, find(items, 'folder-r1/b')!.x], on: [find(items, 'folder-r1/c')!.alpha, find(items, 'folder-r1/c')!.x] })
      .toEqual({ a: 1, off: [1, FOLDER_AT[1]![0]], on: [0, FOLDER_AT[1]![0] - 22] });
  });
  it('end that swap with the new batch alone on the seat', () => {
    const items = changed(input({ reviewBatches: batches('a', 'b') }), input({ reviewBatches: batches('a', 'c') })).at(SLIDE_MS);
    expect(folders(items).map((entry) => [entry.key, entry.x, entry.y])).toEqual([['folder-r1/a', ...FOLDER_AT[0]!], ['folder-r1/c', ...FOLDER_AT[1]!]]);
  });
  it('keep a staying batch on its seat when an earlier one leaves', () => {
    expect(at(find(changed(input({ reviewBatches: batches('a', 'b') }), input({ reviewBatches: batches('b') })).at(0), 'folder-r1/b'))).toEqual(FOLDER_AT[1]);
  });
  it('slide a stacked batch onto a seat that frees', () => {
    const folder = find(changed(input({ reviewBatches: many(5) }), input({ reviewBatches: many(5).slice(1) })).at(SLIDE_MS), 'folder-r1/b4')!;
    expect([folder.x, folder.y, folder.alpha]).toEqual([...FOLDER_AT[0]!, 1]);
  });
  it('show only the end state of a swap under reduced motion', () => {
    const items = changed(input({ reviewBatches: batches('a', 'b') }), input({ reviewBatches: batches('a', 'c') }), true).at(0);
    expect(folders(items).map((entry) => [entry.key, entry.x, entry.alpha])).toEqual([['folder-r1/a', FOLDER_AT[0]![0], 1], ['folder-r1/c', FOLDER_AT[1]![0], 1]]);
  });
  describe('the stack past 4', () => {
    const base = (items: readonly PropItem[], k = 0) => find(items, `stack-${k}`);
    const pose = (entry: PropItem | undefined) => entry && { x: entry.x, y: entry.y, alpha: entry.alpha };
    /** Where layer `k` rests, read from a settled stack of 8. */
    const rest = (k: number) => pose(base(drawn(input({ reviewBatches: many(8) })), k))!;
    it('slides on at 4 -> 5 from the left, transparent', () => {
      const { x, y } = rest(0);
      expect(pose(base(changed(input({ reviewBatches: many(4) }), input({ reviewBatches: many(5) })).at(0)))).toEqual({ x: x - 22, y: y + 11, alpha: 0 });
    });
    it('ends its slide-on at 4 -> 5 at rest and opaque', () => {
      expect(pose(base(changed(input({ reviewBatches: many(4) }), input({ reviewBatches: many(5) })).at(SLIDE_MS)))).toEqual(rest(0));
    });
    it('brings its note in with it at 4 -> 5, transparent at the start', () => {
      expect(find(changed(input({ reviewBatches: many(4) }), input({ reviewBatches: many(5) })).at(0), 'stack-note')!.alpha).toBe(0);
    });
    it('starts its slide-off at 5 -> 4 at rest, still showing its note', () => {
      const items = changed(input({ reviewBatches: many(5) }), input({ reviewBatches: many(4) })).at(0);
      expect({ layer: pose(base(items)), note: text(find(items, 'stack-note')) }).toEqual({ layer: rest(0), note: '5' });
    });
    it('slides off at 5 -> 4 to the right, fading', () => {
      const { x, y } = rest(0);
      const layer = base(changed(input({ reviewBatches: many(5) }), input({ reviewBatches: many(4) })).at(SLIDE_MS / 2))!;
      expect({ right: layer.x > x, up: layer.y < y, fading: layer.alpha > 0 && layer.alpha < 1 }).toEqual({ right: true, up: true, fading: true });
    });
    it('is gone with its note once the 5 -> 4 slide-off ends', () => {
      expect(keys(changed(input({ reviewBatches: many(5) }), input({ reviewBatches: many(4) })).at(SLIDE_MS), 'stack-')).toEqual([]);
    });
    it('slides the two layers 6 -> 8 adds on and leaves the others at rest', () => {
      const items = changed(input({ reviewBatches: many(6) }), input({ reviewBatches: many(8) })).at(0);
      expect([0, 1, 2, 3].map((k) => base(items, k)!.alpha)).toEqual([1, 1, 0, 0]);
    });
    it('slides the two layers 8 -> 6 takes away off and leaves the others at rest', () => {
      const items = changed(input({ reviewBatches: many(8) }), input({ reviewBatches: many(6) })).at(SLIDE_MS / 2);
      expect([0, 1, 2, 3].map((k) => { const layer = base(items, k)!; return layer.alpha === 1 && layer.x === rest(k).x; })).toEqual([true, true, false, false]);
    });
    it('drops the layers 8 -> 6 takes away once their slide-off ends', () => {
      expect(keys(changed(input({ reviewBatches: many(8) }), input({ reviewBatches: many(6) })).at(SLIDE_MS), 'stack-')).toEqual(['stack-0', 'stack-1', 'stack-note']);
    });
    it('still pops its note on an overflow change', () => {
      expect(find(changed(input({ reviewBatches: many(6) }), input({ reviewBatches: many(8) })).at(NUMBER_POP_MS / 2), 'stack-note')!.scale).toBeGreaterThan(1);
    });
    it('still pops its note as it arrives at 4 -> 5', () => {
      expect(find(changed(input({ reviewBatches: many(4) }), input({ reviewBatches: many(5) })).at(NUMBER_POP_MS / 2), 'stack-note')!.scale).toBeGreaterThan(1);
    });
    it('shows only the end state at 4 -> 5 under reduced motion', () => {
      const items = changed(input({ reviewBatches: many(4) }), input({ reviewBatches: many(5) }), true).at(0);
      expect({ layer: pose(base(items)), note: find(items, 'stack-note')!.alpha }).toEqual({ layer: rest(0), note: 1 });
    });
    it('shows only the end state at 5 -> 4 under reduced motion', () => {
      expect(keys(changed(input({ reviewBatches: many(5) }), input({ reviewBatches: many(4) }), true).at(0), 'stack-')).toEqual([]);
    });
  });
  it('glow green with a halo while the review-ready milestone lasts', () => {
    const items = drawn(input({ reviewBatches: batches('a', 'b'), reviewReady: { id: 1, startedAt: 0 } }));
    expect({ glow: find(items, 'folder-r1/a')!.glow > 0, halos: keys(items, 'folder-').filter((key) => key.endsWith('-glow')) }).toEqual({ glow: true, halos: ['folder-r1/a-glow', 'folder-r1/b-glow'] });
  });
  it('do not glow without the milestone', () => {
    const items = drawn(input({ reviewBatches: batches('a', 'b') }));
    expect({ glow: find(items, 'folder-r1/a')!.glow, halos: keys(items, 'folder-').filter((key) => key.endsWith('-glow')) }).toEqual({ glow: 0, halos: [] });
  });
  it('hold a steady full glow under reduced motion', () => {
    const animator = new RoomPropsAnimator();
    animator.update(input({ reviewBatches: batches('a'), reviewReady: { id: 1, startedAt: 0 } }), 0);
    expect([animator.items(100, true), animator.items(460, true)].map((items) => find(items, 'folder-r1/a')!.glow)).toEqual([1, 1]);
  });
});

describe('the kanban whiteboard', () => {
  const notes = (items: readonly PropItem[]) => items.filter((entry) => entry.key.startsWith('note-'));
  const at = (column: BoardColumn, n: number) => ({ ...empty(), [column]: ids(n) });

  it('hangs on the wall with no notes and no counts before the board has loaded', () => {
    expect(drawn(input({ columns: null })).map((entry) => entry.key)).toEqual(['board']);
  });
  it('shows a grey 0 in every header and no notes at 0', () => {
    const items = drawn(input());
    expect({ notes: notes(items).length, headers: PROP_COLUMNS.map((column) => header(items, column)) }).toEqual({ notes: 0, headers: PROP_COLUMNS.map(() => ({ marker: '0', zero: true })) });
  });
  it('puts one note in the first slot of its column at 1', () => {
    const items = drawn(input({ columns: at('running', 1) }));
    expect({ notes: notes(items).map((entry) => [entry.x, entry.y, entry.paint]), header: header(items, 'running') })
      .toEqual({ notes: [[...noteSlot(2, 0), { texture: 'props/note-running' }]], header: { marker: '1', zero: false } });
  });
  it('draws one note per task up to 10 per column', () => expect(notes(drawn(input({ columns: at('ready', 10) })))).toHaveLength(10));
  it('keeps 10 notes past 10 and the exact count in the header', () => {
    const items = drawn(input({ columns: at('done', 37) }));
    expect({ notes: notes(items).length, header: header(items, 'done') }).toEqual({ notes: 10, header: { marker: '37', zero: false } });
  });
  it('is exact to 99 in a header', () => expect(header(drawn(input({ columns: at('done', 99) })), 'done')).toEqual({ marker: '99', zero: false }));
  it('reads 99+ in a header past 99', () => expect(header(drawn(input({ columns: at('done', 100) })), 'done')).toEqual({ marker: '99+', zero: false }));
  it('fits 99+ inside a column', () => expect(textWidth(countText(100), 2)).toBeLessThanOrEqual(20));
  it('places the columns in the Board order and colours', () => {
    const items = drawn(input({ columns: Object.fromEntries(PROP_COLUMNS.map((column) => [column, [`${column}-1`]])) as Record<BoardColumn, string[]> }));
    expect(notes(items).map((entry) => entry.paint)).toEqual(PROP_COLUMNS.map((column) => ({ texture: `props/note-${column}` })));
  });
  it('draws the board before its notes and counts', () => {
    const items = drawn(input({ columns: at('ready', 1) }));
    expect(find(items, 'board')!.zIndex).toBeLessThan(find(items, 'note-t-0')!.zIndex);
  });
  it('does not pop the notes that are there when the board first loads', () => {
    const { at: draw } = changed(input({ columns: null }), input({ columns: at('ready', 2) }));
    expect(notes(draw(0)).map((entry) => entry.scale)).toEqual([1, 1]);
  });

  it('starts a new task\'s note at size 0', () => {
    expect(find(changed(input({ columns: at('ready', 3) }), input({ columns: at('ready', 4) })).at(0), 'note-t-3')!.scale).toBe(0);
  });
  it('ends a new task\'s note at its size in the next slot', () => {
    const note = find(changed(input({ columns: at('ready', 3) }), input({ columns: at('ready', 4) })).at(NOTE_POP_MS), 'note-t-3')!;
    expect({ scale: note.scale, at: [note.x, note.y] }).toEqual({ scale: 1, at: noteSlot(0, 3) });
  });
  it('switches a header halfway through its change', () => {
    const change = changed(input({ columns: at('ready', 3) }), input({ columns: at('ready', 4) }));
    expect([header(change.at(NOTE_POP_MS * 0.25), 'ready'), header(change.at(NOTE_POP_MS * 0.75), 'ready')]).toEqual([{ marker: '3', zero: false }, { marker: '4', zero: false }]);
  });

  describe('a task moving from Ready to Running', () => {
    const before = input({ columns: { ...empty(), ready: ['a', 'b'], running: ['c'] } });
    const after = input({ columns: { ...empty(), ready: ['b'], running: ['c', 'a'] } });
    it('moves exactly one note, the task\'s own', () => {
      const items = changed(before, after).at(NOTE_MOVE_MS / 2);
      expect({ notes: notes(items).length, own: keys(items, 'note-a') }).toEqual({ notes: 3, own: ['note-a'] });
    });
    it('starts the note at its Ready slot in the Ready colour', () => {
      const note = find(changed(before, after).at(0), 'note-a')!;
      expect({ at: [note.x, note.y], paint: note.paint }).toEqual({ at: noteSlot(0, 0), paint: { texture: 'props/note-ready' } });
    });
    it('ends the note at its Running slot in the Running colour', () => {
      const note = find(changed(before, after).at(NOTE_MOVE_MS), 'note-a')!;
      expect({ at: [note.x, note.y], paint: note.paint }).toEqual({ at: noteSlot(2, 1), paint: { texture: 'props/note-running' } });
    });
    it('keeps both headers on the old counts until halfway', () => {
      const items = changed(before, after).at(NOTE_MOVE_MS * 0.25);
      expect([header(items, 'ready'), header(items, 'running')]).toEqual([{ marker: '2', zero: false }, { marker: '1', zero: false }]);
    });
    it('shows both new counts at the end', () => {
      const items = changed(before, after).at(NOTE_MOVE_MS);
      expect([header(items, 'ready'), header(items, 'running')]).toEqual([{ marker: '1', zero: false }, { marker: '2', zero: false }]);
    });
    it('shows the note at its new slot at once under reduced motion', () => {
      const note = find(changed(before, after, true).at(0), 'note-a')!;
      expect([note.x, note.y]).toEqual(noteSlot(2, 1));
    });
  });

  it('starts a closed task\'s note where it was', () => {
    const note = find(changed(input({ columns: at('blocked', 1) }), input()).at(0), 'note-t-0')!;
    expect({ at: [note.x, note.y], alpha: note.alpha }).toEqual({ at: noteSlot(1, 0), alpha: 1 });
  });
  it('removes a closed task\'s note once it has shrunk away', () => {
    expect(find(changed(input({ columns: at('blocked', 1) }), input()).at(NOTE_FADE_MS), 'note-t-0')).toBeUndefined();
  });
  // Moved from p(6.05, 0, 2.6) ([986, 236]), whose left headers and counts sat above the first view at 1280 x 800.
  it('hangs the board with its top-left corner at p(6.95, 0, 2.05), left of the door', () => expect(BOARD_AT).toEqual([1030, 284]));
  // Rows 32, 39, .. 60 before the shear, below the colour rule at row 30; they started at row 29, 8 apart, before the header
  // counts grew to 15 px.
  it('puts the note slots below the column rule, 7 rows apart', () => expect([noteSlot(0, 0), noteSlot(0, 1), noteSlot(0, 8)])
    .toEqual([[BOARD_AT[0] + 8, BOARD_AT[1] + 36], [BOARD_AT[0] + 17, BOARD_AT[1] + 40], [BOARD_AT[0] + 8, BOARD_AT[1] + 64]]));

  /** A header's inked pixels in board-local frontal coordinates, the shear taken back out. */
  const headerPixels = (column: number, text: string) => {
    const [bx, by] = headerBox(column, text);
    return headerRects(text, 0).flatMap(([x, y, w, h]) => Array.from({ length: w * h }, (_, k) => {
      const fx = bx - BOARD_AT[0] + x + (k % w);
      return [fx, by - BOARD_AT[1] + y + Math.floor(k / w) - Math.floor(fx / 2)] as const;
    }));
  };
  it('writes a header count 15 px tall, between the column label (rows 7..12) and its rule (row 30), inside its column', () => {
    const texts = ['0', '7', '37', '99', '99+'];
    const outside = PROP_COLUMNS.flatMap((_, column) => texts.flatMap((text) => headerPixels(column, text)
      .filter(([x, y]) => x < 7 + 21 * column || x > 7 + 21 * column + 19 || y < 14 || y > 28).map(([x, y]) => `${column}:${text}@${x},${y}`)));
    const rows = (text: string) => new Set(headerPixels(0, text).map(([, y]) => y));
    expect({ outside, tall: ['0', '7', '37', '99'].map((text) => [Math.min(...rows(text)), Math.max(...rows(text))]) })
      .toEqual({ outside: [], tall: [[14, 28], [14, 28], [14, 28], [14, 28]] });
  });
  it('shears a header count onto the wall as the board\'s labels are, one row down every second pixel column', () => {
    const [bx] = headerBox(0, '1');
    const tops = new Map<number, number>();
    for (const [x, y, w] of headerRects('1', 0)) { expect(w).toBe(1); tops.set(x, Math.min(tops.get(x) ?? Infinity, y)); }
    expect({ even: (bx - BOARD_AT[0]) % 2, stem: [tops.get(3), tops.get(4), tops.get(5)] }).toEqual({ even: 0, stem: [1, 2, 2] });
  });
});

describe('the pointer hit areas', () => {
  it('keep a box larger than the minimum at its own size', () => expect(propHitArea('board', 1, 24)).toEqual(ROOM_PROP_BOXES.board));
  it('grow the question note\'s box to 24 CSS px about its centre at a small scale', () => {
    const [x, y, w, h] = ROOM_PROP_BOXES.questions;
    const [hx, hy, hw, hh] = propHitArea('questions', 0.2, 24);
    expect([hw * 0.2, hh * 0.2, hx + hw / 2, hy + hh / 2].map((v) => v.toFixed(3))).toEqual([24, 24, x + w / 2, y + h / 2].map((v) => v.toFixed(3)));
  });
  it('grow every box to 44 CSS px for a touch pointer', () => {
    expect((['questions', 'review', 'board'] as const).map((prop) => propHitArea(prop, 0.25, 44)).map(([, , w, h]) => Math.min(w, h) * 0.25 >= 44 - 1e-9)).toEqual([true, true, true]);
  });
});

describe('the marker note', () => {
  it('fits its text with a 3 px margin', () => expect(markerNote('3?').w).toBe(20));
});
