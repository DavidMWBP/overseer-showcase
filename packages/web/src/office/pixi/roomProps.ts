import { Container, Graphics, Sprite, type Texture } from 'pixi.js';
import type { BoardColumn } from '@overseer/shared';
import { FURN, p } from './world';
import { footprintDepth, seatScreens } from './furniture';
import { readingFolderArt } from './readingFolders';

/**
 * The count objects of the room, replacing the count pills (approved from the round 2 prototype on 2026-09-26):
 * - Questions: one yellow note on the edge of the orchestrator's right monitor with the open-question count in marker
 *   ("3?"). Absent at 0; it flutters in on 0 -> 1, pops its new number on each change and peels off on 1 -> 0.
 * - In review: one manila folder per batch on the meeting table, exact to 4, then a stack in the middle with a numbered
 *   note. Folders, the stack's layers included, slide on and off, the note pops its new number past 4, and all of them
 *   glow green while the review-ready milestone lasts.
 * - Board: the six-column kanban whiteboard on the right wall between the windows and the door, in the Board's order and
 *   colours, one note per task up to 10 per column and the exact count in each header. A new task's note pops in, a task
 *   that changes column travels there, a closed one shrinks away, and both headers switch halfway through and pop.
 * Past 99 a count reads `99+` (the question note too, without its `?`).
 *
 * `RoomPropsAnimator` is the DOM-free part: it turns the counts it is handed over time into `PropItem`s. Reduced motion
 * and frozen frames draw every end state. `createRoomPropsView` keeps one Pixi display per item for the scene's depth sort.
 */

/** The Board's columns in its order (`BOARD_COLUMNS` in `views/Board.tsx`). */
export const PROP_COLUMNS: readonly BoardColumn[] = ['ready', 'blocked', 'running', 'verifying', 'review', 'done'];

export interface RoomPropsInput {
  /** Open questions, or null until the chat has loaded. */
  questions: number | null;
  /** One key per batch in review (repository id and batch id, unique across repositories), or null until the board has loaded. */
  reviewBatches: readonly string[] | null;
  /** One key per task in each Board column (repository id and bead id, unique across repositories), or null until the board has loaded. */
  columns: Readonly<Record<BoardColumn, readonly string[]>> | null;
  /** The review-ready milestone while it lasts (`performance.now()` start). */
  reviewReady: { id: number; startedAt: number } | null;
}

export const FLUTTER_MS = 600;
export const PEEL_MS = 700;
export const NUMBER_POP_MS = 300;
export const SLIDE_MS = 500;
export const NOTE_POP_MS = 400;
export const NOTE_MOVE_MS = 900;
export const NOTE_FADE_MS = 400;
/** The glow's cycle, the retired pill's pulse. */
export const GLOW_CYCLE_MS = 720;

export const NOTES_PER_COLUMN = 10;
export const FOLDER_PLACES = 4;
const STACK_MAX = 4;

// ----- the marker font and notes of the round 2 prototype's art.py -----

const FONT: Record<string, readonly string[]> = {
  '0': ['111', '101', '101', '101', '111'], '1': ['010', '110', '010', '010', '111'],
  '2': ['111', '001', '111', '100', '111'], '3': ['111', '001', '011', '001', '111'],
  '4': ['101', '101', '111', '001', '001'], '5': ['111', '100', '111', '001', '111'],
  '6': ['111', '100', '111', '101', '111'], '7': ['111', '001', '010', '010', '010'],
  '8': ['111', '101', '111', '101', '111'], '9': ['111', '101', '111', '001', '111'],
  '+': ['000', '010', '111', '010', '000'], '?': ['111', '001', '011', '000', '010'],
};
export const MARKER = 0x2c344a;
export const MARKER_SOFT = 0x969caa;
const YELLOW = [246, 222, 104] as const;

export type Rect = readonly [x: number, y: number, w: number, h: number, color: number];

const rgb = ([r, g, b]: readonly number[]) => (r! << 16) | (g! << 8) | b!;
const shadeRgb = (color: readonly number[], factor: number) => color.map((v) => Math.max(0, Math.min(255, Math.round(v * factor))));

/** A `+` next to digits is drawn at half size, so `99+` fits a whiteboard column. */
const glyphScale = (c: string, scale: number) => (c === '+' && scale > 1 ? scale / 2 : scale);

/** `gap` is the space after each glyph, one font pixel by default. */
export function textWidth(text: string, scale: number, gap?: number): number {
  let width = 0;
  for (const c of text) width += FONT[c]![0]!.length * glyphScale(c, scale) + (gap ?? glyphScale(c, scale));
  return width - (gap ?? glyphScale(text.at(-1) ?? '0', scale));
}

export function markerRects(text: string, x: number, y: number, color: number, scale: number, gap?: number): Rect[] {
  const rects: Rect[] = [];
  let left = x;
  for (const c of text) {
    const s = glyphScale(c, scale);
    FONT[c]!.forEach((row, r) => [...row].forEach((bit, k) => { if (bit === '1') rects.push([left + k * s, y + r * s, s, s, color]); }));
    left += FONT[c]![0]!.length * s + (gap ?? s);
  }
  return rects;
}

/** A count as the objects write it: exact to 99, then `99+`. */
export const countText = (count: number): string => (count > 99 ? '99+' : String(count));

/** An upright yellow sticky note with `text` in marker. */
export function markerNote(text: string): { w: number; h: number; rects: Rect[] } {
  const w = textWidth(text, 2) + 6;
  const h = 14;
  return {
    w, h,
    rects: [
      [0, 0, w, h, rgb(shadeRgb(YELLOW, 0.55))],
      [1, 1, w - 2, h - 2, rgb(YELLOW)],
      [1, 1, w - 2, 1, rgb(shadeRgb(YELLOW, 0.85))],
      ...markerRects(text, 3, 2, MARKER, 2),
    ],
  };
}

/** The question note's text: the count and a `?`, or `99+` past 99. */
export const questionText = (count: number): string => (count > 99 ? '99+' : `${count}?`);

// ----- geometry -----

type Box = readonly [x: number, y: number, w: number, h: number];

const ORCH_SCREEN = seatScreens().find((screen) => screen.asset === 'monitors-orch')!;
/** The top-left corner of `monitors-orch.png` (anchor 37, 46). */
const MONITORS: readonly [number, number] = [ORCH_SCREEN.at[0] - 37, ORCH_SCREEN.at[1] - 46];
/** The question note's top-left corner: on the top edge of the right monitor. */
export const QUESTION_NOTE_AT: readonly [number, number] = [Math.round(MONITORS[0] + 50), Math.round(MONITORS[1] + 12)];
const QUESTION_Z = Math.round((ORCH_SCREEN.depth + 0.01) * 100);

const TABLE = FURN.find((furniture) => furniture.kind === 'meeting-table')!;
const FOLDER_W = 42;
const FOLDER_H = 27;
/** Just after the meeting table: over it, under a sitter with its back to the camera. The reviewers' folders share it. */
export const FOLDER_Z = Math.round((footprintDepth(TABLE) + 0.01) * 100);
/** The folder art's top face is centred 0.3 tile behind, in i and in j, the point its bottom centre stands on. */
const ART_BACK = 0.3;
const bottomCentre = ([x, y]: readonly [number, number], w: number, h: number): [number, number] => [Math.round(x - w / 2), Math.round(y - h)];
/**
 * Four places on the table's centre line, two each side of the stack, the inner ones first. The reviewers' open folders
 * lie at the table's two long edges in front of the seats (`readingFolders.ts`), so both can be on the table at once.
 */
export const FOLDER_AT = ([[16.02, 9.03], [16.02, 10.3], [16.02, 8.43], [16.02, 10.86]] as const)
  .map(([i, j]) => bottomCentre(p(i + ART_BACK, j + ART_BACK, 0.75), FOLDER_W, FOLDER_H));
/** The stack, on the centre line between the inner places. */
const STACK_BASE = p(16.02 + ART_BACK, 9.77 + ART_BACK, 0.75);
/** The folders in the stack at a review count: none up to the four places, then one per batch past them, capped. */
const stackLayers = (count: number) => Math.max(0, Math.min(count - FOLDER_PLACES, STACK_MAX));

/**
 * The whiteboard's top-left corner on the right wall (j = 0): i 6.95..9.87, just left of the door at i 9.92, its top at
 * z 2.05 and its frame 0.04 above the baseboard. At 1280 x 800 the first view has to keep the folders in, which leaves
 * world y 283 and below; this is the lowest the board hangs whole on that wall. It hung at p(6.05, 0, 2.6) before, with
 * its left columns' headers and counts above the view.
 */
export const BOARD_AT: readonly [number, number] = (() => { const [x, y] = p(6.95, 0, 2.05); return [Math.round(x), Math.round(y)]; })();
export const BOARD_W = 140;
export const BOARD_H = 156;
const NOTE_W = 8;
const NOTE_H = 11;
/** Nothing stands behind the wall: the board draws before everything on the floor, its notes and counts just after it. */
export const BOARD_Z = 0;
const BOARD_NOTE_Z = 1;
/**
 * Board-local frontal rows (before the shear): the column labels end at row 12, the header counts fill rows 14..28, each
 * column's colour rule is row 30 and the notes start at row 32, 7 rows apart, so the fifth row ends at 70, clear of the
 * marker tray at rows 73..76.
 */
const HEADER_TOP = 14;
const NOTE_TOP = 32;
const NOTE_PITCH = 7;
/**
 * A header count's marker: 15 px digits at scale 3, one pixel apart so two digits fit a column's 20 px; `99+` keeps the
 * notes' scale 2, centred on the same rows.
 */
export const headerStyle = (text: string): { scale: number; gap: number } => (text.length > 2 ? { scale: 2, gap: 2 } : { scale: 3, gap: 1 });

/** Frontal column `c` starts at x0 = 7 + 21c; sheared onto the wall, a point moves down by half its x. */
const columnX = (column: number) => 7 + 21 * column;
const sheared = (x: number, y: number): [number, number] => [x, y + Math.floor(x / 2)];
export function noteSlot(column: number, slot: number): [number, number] {
  const [x, y] = sheared(columnX(column) + 1 + (slot % 2) * 9, NOTE_TOP + Math.floor(slot / 2) * NOTE_PITCH);
  return [BOARD_AT[0] + x, BOARD_AT[1] + y];
}
/**
 * A header count's box, centred in its column on an even board x, so its sheared columns step as the board's own labels
 * do (`headerRects`).
 */
export function headerBox(column: number, text: string): Box {
  const { scale, gap } = headerStyle(text);
  const w = textWidth(text, scale, gap);
  const left = 2 * Math.round((columnX(column) + 10 - w / 2) / 2);
  const [x, y] = sheared(left, HEADER_TOP + Math.floor((15 - 5 * scale) / 2));
  return [BOARD_AT[0] + x, BOARD_AT[1] + y, w, 5 * scale + Math.floor((w - 1) / 2)];
}

/** A header count in marker, sheared onto the wall like the board's labels: each pixel column drops by half its x. */
export function headerRects(text: string, color: number): Rect[] {
  const { scale, gap } = headerStyle(text);
  return markerRects(text, 0, 0, color, scale, gap)
    .flatMap(([x, y, w, h, c]) => Array.from({ length: w }, (_, k): Rect => [x + k, y + Math.floor((x + k) / 2), 1, h, c]));
}

function union(boxes: readonly Box[]): Box {
  const x0 = Math.min(...boxes.map(([x]) => x));
  const y0 = Math.min(...boxes.map(([, y]) => y));
  const x1 = Math.max(...boxes.map(([x, , w]) => x + w));
  const y1 = Math.max(...boxes.map(([, y, , h]) => y + h));
  return [x0, y0, x1 - x0, y1 - y0];
}

export type RoomPropKey = 'questions' | 'review' | 'board';
export const ROOM_PROP_KEYS: readonly RoomPropKey[] = ['questions', 'review', 'board'];

/** Each object's button box in world pixels; it stays where the object is at 0, so the button is always there. */
export const ROOM_PROP_BOXES: Readonly<Record<RoomPropKey, Box>> = {
  questions: union([[MONITORS[0], MONITORS[1], 74, 40], [QUESTION_NOTE_AT[0], QUESTION_NOTE_AT[1], textWidth('99+', 2) + 6, 14]]),
  review: union([
    ...FOLDER_AT.map(([x, y]): Box => [x, y, FOLDER_W, FOLDER_H]),
    // The full stack's numbered note is the highest thing on the table.
    [Math.round(STACK_BASE[0] - FOLDER_W / 2), Math.round(STACK_BASE[1] - 10 - STACK_MAX * 3 - 14), FOLDER_W, 10 + STACK_MAX * 3 + 14],
  ]),
  board: [BOARD_AT[0], BOARD_AT[1], BOARD_W, BOARD_H],
};

/**
 * How far an object's drawn edges drop per pixel to the right inside its box: the whiteboard is sheared onto the right
 * wall (`sheared`), so its left side ends BOARD_W / 2 above the box's bottom and its right side starts as far below the top.
 */
export const ROOM_PROP_SHEAR: Readonly<Record<RoomPropKey, number>> = { questions: 0, review: 0, board: 0.5 };

/**
 * An object's pointer hit area in world pixels at `scale` CSS px per world pixel: its box, grown about its centre to at
 * least `minPx` CSS px on each side.
 */
export function propHitArea(prop: RoomPropKey, scale: number, minPx: number): Box {
  const [x, y, w, h] = ROOM_PROP_BOXES[prop];
  const width = Math.max(w, minPx / scale);
  const height = Math.max(h, minPx / scale);
  return [x - (width - w) / 2, y - (height - h) / 2, width, height];
}

// ----- items -----

export type PropPaint =
  | { texture: string }
  | { note: string }
  | { marker: string; zero: boolean }
  /** A reviewer's open folder: its seat id and page frame (`readingFolderArt`). */
  | { reading: string }
  | { halo: true };

export interface PropItem {
  key: string;
  zIndex: number;
  /** Top-left corner in world pixels, before the transform. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** The transform origin inside the item. */
  pivot: readonly [number, number];
  alpha: number;
  scale: number;
  /** Radians. */
  rotation: number;
  /** 0..1: how green a folder is tinted by the review-ready glow. */
  glow: number;
  paint: PropPaint;
}

const ease = (t: number) => 1 - (1 - t) ** 3;
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const clamp01 = (t: number) => Math.max(0, Math.min(1, t));
const pop = (t: number, amount: number) => (t > 0 && t < 1 ? 1 + Math.sin(t * Math.PI) * amount : 1);

function item(key: string, zIndex: number, x: number, y: number, w: number, h: number, paint: PropPaint, over: Partial<PropItem> = {}): PropItem {
  return { key, zIndex, x, y, w, h, pivot: [w / 2, h / 2], alpha: 1, scale: 1, rotation: 0, glow: 0, paint, ...over };
}

interface CountChange { from: number; to: number; at: number }
type NoteChange =
  | { kind: 'add'; column: number; at: number }
  | { kind: 'move'; from: number; fromSlot: number; column: number; at: number }
  | { kind: 'remove'; column: number; slot: number; at: number };
const NOTE_MS: Record<NoteChange['kind'], number> = { add: NOTE_POP_MS, move: NOTE_MOVE_MS, remove: NOTE_FADE_MS };
/** A folder sliding onto its seat, or off the seat it held. */
interface FolderChange { kind: 'on' | 'off'; seat: number; at: number }

/** Holds the last counts it saw and the changes still animating; `items` draws them at a time. */
export class RoomPropsAnimator {
  private last: RoomPropsInput | null = null;
  private questions: CountChange | null = null;
  /** The stack's count change, which pops its numbered note. */
  private stack: CountChange | null = null;
  /** Each seated batch's seat, which it keeps while it stays in review. */
  private seats = new Map<string, number>();
  private folders = new Map<string, FolderChange>();
  /** Each stack layer sliding on or off, by its height in the stack. */
  private layers = new Map<number, { kind: 'on' | 'off'; at: number }>();
  private notes = new Map<string, NoteChange>();
  private placed = new Map<string, { column: number; slot: number }>();

  /** Compare with the last input: a change between two loaded counts starts its animation at `now`. */
  update(input: RoomPropsInput, now: number): void {
    const last = this.last;
    this.last = input;
    if (last === input) return;
    if (last?.questions != null && input.questions !== null && input.questions !== last.questions) {
      this.questions = { from: this.shownQuestions(now) ?? last.questions, to: input.questions, at: now };
    }
    if (input.reviewBatches !== last?.reviewBatches) this.seatFolders(last?.reviewBatches ?? null, input.reviewBatches, now);
    if (input.columns === last?.columns) return;
    const placed = new Map<string, { column: number; slot: number }>();
    if (input.columns) {
      PROP_COLUMNS.forEach((key, column) => input.columns![key].forEach((id, slot) => placed.set(id, { column, slot })));
    }
    if (last?.columns && input.columns) {
      for (const [id, place] of placed) {
        const before = this.placed.get(id);
        if (!before) this.notes.set(id, { kind: 'add', column: place.column, at: now });
        else if (before.column !== place.column) {
          this.notes.set(id, { kind: 'move', from: before.column, fromSlot: Math.min(before.slot, NOTES_PER_COLUMN - 1), column: place.column, at: now });
        }
      }
      for (const [id, before] of this.placed) {
        if (!placed.has(id)) this.notes.set(id, { kind: 'remove', column: before.column, slot: Math.min(before.slot, NOTES_PER_COLUMN - 1), at: now });
      }
    } else {
      this.notes.clear();
    }
    this.placed = placed;
  }

  /**
   * Reconcile the seats by batch key: a batch that left review slides off the seat it held, and a batch without a seat
   * slides onto the lowest free one, so one batch leaving and another entering at the same count swap that seat's folder.
   * The first loaded list seats its batches without motion.
   */
  private seatFolders(before: readonly string[] | null, after: readonly string[] | null, now: number): void {
    if (after === null) return;
    if (before === null) {
      this.seats = new Map(after.slice(0, FOLDER_PLACES).map((key, seat) => [key, seat]));
      this.folders.clear();
      this.layers.clear();
      return;
    }
    if (before.length !== after.length) this.stack = { from: before.length, to: after.length, at: now };
    // Each stack layer the count adds slides on, and each one it takes away slides off.
    const [was, is] = [stackLayers(before.length), stackLayers(after.length)];
    for (let k = Math.min(was, is); k < Math.max(was, is); k++) this.layers.set(k, { kind: is > was ? 'on' : 'off', at: now });
    const staying = new Set(after);
    for (const [key, seat] of this.seats) {
      if (staying.has(key)) continue;
      this.seats.delete(key);
      this.folders.set(key, { kind: 'off', seat, at: now });
    }
    const taken = new Set(this.seats.values());
    const free = Array.from({ length: FOLDER_PLACES }, (_, seat) => seat).filter((seat) => !taken.has(seat));
    for (const key of after) {
      if (free.length === 0) break;
      if (this.seats.has(key)) continue;
      const seat = free.shift()!;
      this.seats.set(key, seat);
      this.folders.set(key, { kind: 'on', seat, at: now });
    }
  }

  /** The question count the note shows mid-peel, so a count that comes back during a peel starts from what is drawn. */
  private shownQuestions(now: number): number | null {
    const change = this.questions;
    if (!change || change.to !== 0 || now - change.at >= PEEL_MS) return null;
    return change.from;
  }

  /** Every item at `now`; `still` (reduced motion or a frozen frame) draws the end state of every change. */
  items(now: number, still: boolean): PropItem[] {
    const input = this.last;
    if (!input) return [];
    const progress = (at: number, ms: number) => (still ? 1 : clamp01((now - at) / ms));
    for (const [id, change] of this.notes) if (progress(change.at, NOTE_MS[change.kind]) >= 1) this.notes.delete(id);
    for (const [key, change] of this.folders) if (progress(change.at, SLIDE_MS) >= 1) this.folders.delete(key);
    for (const [k, change] of this.layers) if (progress(change.at, SLIDE_MS) >= 1) this.layers.delete(k);
    return [
      ...this.questionItems(input, progress),
      ...this.folderItems(input, now, still, progress),
      ...this.boardItems(input, progress),
    ];
  }

  private questionItems(input: RoomPropsInput, progress: (at: number, ms: number) => number): PropItem[] {
    if (input.questions === null) return [];
    const change = this.questions;
    const [x, y] = QUESTION_NOTE_AT;
    const noteAt = (count: number, over: Partial<PropItem> = {}) => {
      const text = questionText(count);
      const w = textWidth(text, 2) + 6;
      return [item('question-note', QUESTION_Z, x, y, w, 14, { note: text }, { pivot: [w / 2, 0], ...over })];
    };
    if (change && change.to === 0 && change.from > 0) {
      const t = progress(change.at, PEEL_MS);
      if (t >= 1) return [];
      const e = ease(t);
      // Peels from its top-left corner, falls and fades.
      return noteAt(change.from, { pivot: [0, 0], y: y + e * 22, rotation: e * (50 * Math.PI / 180), alpha: 1 - e });
    }
    if (input.questions === 0) return [];
    if (change && change.from === 0) {
      const t = progress(change.at, FLUTTER_MS);
      const e = ease(t);
      return noteAt(input.questions, {
        y: y - (1 - e) * 16,
        rotation: Math.sin(t * Math.PI * 3) * (14 * Math.PI / 180) * (1 - t),
        alpha: Math.min(1, t * 2.5),
      });
    }
    return noteAt(input.questions, { scale: change ? pop(progress(change.at, NUMBER_POP_MS), 0.3) : 1 });
  }

  private folderItems(input: RoomPropsInput, now: number, still: boolean, progress: (at: number, ms: number) => number): PropItem[] {
    if (input.reviewBatches === null) return [];
    const count = input.reviewBatches.length;
    const glow = input.reviewReady ? (still ? 1 : 0.55 + 0.45 * Math.sin(((now - input.reviewReady.startedAt) / GLOW_CYCLE_MS) * 2 * Math.PI)) : 0;
    const out: PropItem[] = [];
    const folder = (key: string, x: number, y: number, over: Partial<PropItem> = {}) => {
      if (glow > 0) out.push(item(`${key}-glow`, FOLDER_Z, x - 2, y - 2, FOLDER_W + 4, FOLDER_H + 4, { halo: true }, { alpha: 0.45 * glow * (over.alpha ?? 1) }));
      out.push(item(key, FOLDER_Z, x, y, FOLDER_W, FOLDER_H, { texture: 'props/folder' }, { glow, ...over }));
    };
    for (const [key, seat] of [...this.seats].sort(([, a], [, b]) => a - b)) {
      const [x, y] = FOLDER_AT[seat]!;
      const change = this.folders.get(key);
      const e = change?.kind === 'on' ? ease(progress(change.at, SLIDE_MS)) : 1;
      // A folder slides onto the table from the left.
      folder(`folder-${key}`, x - (1 - e) * 22, y + (1 - e) * 11, e < 1 ? { alpha: e } : {});
    }
    for (const [key, change] of this.folders) {
      if (change.kind !== 'off') continue;
      const [x, y] = FOLDER_AT[change.seat]!;
      const e = ease(progress(change.at, SLIDE_MS));
      // ...and off it to the right.
      folder(`folder-${key}`, x + e * 22, y - e * 11, { alpha: 1 - e });
    }
    const stack = stackLayers(count);
    const [sx, sy] = bottomCentre(STACK_BASE, FOLDER_W, FOLDER_H);
    // A stack layer slides on and off the way a seated folder does.
    const slide = (k: number) => {
      const change = this.layers.get(k);
      return change ? { kind: change.kind, e: ease(progress(change.at, SLIDE_MS)) } : null;
    };
    for (let k = 0; k < stack; k++) {
      const e = slide(k)?.kind === 'on' ? slide(k)!.e : 1;
      folder(`stack-${k}`, sx - (1 - e) * 22, sy - k * 3 + (1 - e) * 11, e < 1 ? { alpha: e } : {});
    }
    for (const [k, change] of this.layers) {
      if (change.kind !== 'off' || k < stack) continue;
      const e = slide(k)!.e;
      folder(`stack-${k}`, sx + e * 22, sy - k * 3 - e * 11, { alpha: 1 - e });
    }
    const noteAt = (shown: number, layers: number, over: Partial<PropItem>) => {
      const note = markerNote(countText(shown));
      const [nx, ny] = bottomCentre([STACK_BASE[0] + 2, STACK_BASE[1] - 10 - layers * 3], note.w, note.h);
      out.push(item('stack-note', FOLDER_Z, nx, ny, note.w, note.h, { note: countText(shown) }, over));
    };
    const change = this.stack;
    const base = slide(0);
    if (stack > 0) {
      // Past the four places only the number changes, so it pops; a stack that arrives brings its note with it.
      const scale = change && Math.min(change.from, change.to) >= FOLDER_PLACES ? pop(progress(change.at, NUMBER_POP_MS), 0.4) : 1;
      noteAt(count, stack, base?.kind === 'on' ? { scale, alpha: base.e } : { scale });
    } else if (base?.kind === 'off' && change && change.from > FOLDER_PLACES) {
      // A stack that leaves takes its last number with it.
      noteAt(change.from, stackLayers(change.from), { alpha: 1 - base.e });
    }
    return out;
  }

  private boardItems(input: RoomPropsInput, progress: (at: number, ms: number) => number): PropItem[] {
    const out: PropItem[] = [item('board', BOARD_Z, BOARD_AT[0], BOARD_AT[1], BOARD_W, BOARD_H, { texture: 'props/kanban-board' })];
    if (!input.columns) return out;
    const columns = input.columns;
    /** Per column: the count its header shows (switching halfway through each change) and whether it pops. */
    const shown = PROP_COLUMNS.map((key) => columns[key].length);
    const popping = PROP_COLUMNS.map(() => 1);
    const touch = (column: number, t: number, delta: number) => {
      if (t < 0.5) shown[column]! += delta;
      else popping[column] = Math.max(popping[column]!, pop(t * 2 - 1, 0.4));
    };
    for (const change of this.notes.values()) {
      const t = progress(change.at, NOTE_MS[change.kind]);
      if (change.kind === 'add') touch(change.column, t, -1);
      else if (change.kind === 'remove') touch(change.column, t, 1);
      else { touch(change.from, t, 1); touch(change.column, t, -1); }
    }
    PROP_COLUMNS.forEach((key, column) => {
      columns[key].slice(0, NOTES_PER_COLUMN).forEach((id, slot) => {
        const [x, y] = noteSlot(column, slot);
        const change = this.notes.get(id);
        const paint = { texture: `props/note-${key}` };
        if (change?.kind === 'move') {
          const t = progress(change.at, NOTE_MOVE_MS);
          const e = ease(t);
          const [fx, fy] = noteSlot(change.from, change.fromSlot);
          // It travels in its old colour until it lands, lifted off the board on the way.
          const travelling = t < 1 ? { texture: `props/note-${PROP_COLUMNS[change.from]}` } : paint;
          out.push(item(`note-${id}`, BOARD_NOTE_Z + (t < 1 ? 1 : 0), lerp(fx, x, e), lerp(fy, y, e) - Math.sin(t * Math.PI) * 6, NOTE_W, NOTE_H, travelling));
        } else if (change?.kind === 'add') {
          const t = progress(change.at, NOTE_POP_MS);
          out.push(item(`note-${id}`, BOARD_NOTE_Z, x, y, NOTE_W, NOTE_H, paint, { scale: t < 0.6 ? (t / 0.6) * 1.3 : 1.3 - ((t - 0.6) / 0.4) * 0.3 }));
        } else {
          out.push(item(`note-${id}`, BOARD_NOTE_Z, x, y, NOTE_W, NOTE_H, paint));
        }
      });
    });
    for (const [id, change] of this.notes) {
      if (change.kind !== 'remove' || change.slot >= NOTES_PER_COLUMN) continue;
      const e = ease(progress(change.at, NOTE_FADE_MS));
      const [x, y] = noteSlot(change.column, change.slot);
      out.push(item(`note-${id}`, BOARD_NOTE_Z, x, y, NOTE_W, NOTE_H, { texture: `props/note-${PROP_COLUMNS[change.column]}` }, { scale: 1 - e * 0.6, alpha: 1 - e }));
    }
    PROP_COLUMNS.forEach((key, column) => {
      const count = Math.max(0, shown[column]!);
      const text = countText(count);
      const [x, y, w, h] = headerBox(column, text);
      out.push(item(`header-${key}`, BOARD_NOTE_Z, x, y, w, h, { marker: text, zero: count === 0 }, { scale: popping[column]! }));
    });
    return out;
  }
}

// ----- Pixi -----

const HALO = 0x74e096;
const GLOW_TINT = [0x8d, 0xff, 0xb0] as const;
const tintFor = (glow: number) => rgb([0, 1, 2].map((c) => Math.round(lerp(255, GLOW_TINT[c]!, glow))));

function paintRects(graphic: Graphics, rects: readonly Rect[]): Graphics {
  for (const [x, y, w, h, color] of rects) graphic.rect(x, y, w, h).fill(color);
  return graphic;
}

export interface RoomPropsView {
  /** Update every display for `items`, and return them for the scene's depth sort. */
  displays(items: readonly PropItem[]): Container[];
  destroy(): void;
}

/** One Pixi display per item key, repainted only when its paint changes. A missing texture draws a flat stand-in. */
export function createRoomPropsView(texture: (key: string) => Texture | undefined): RoomPropsView {
  const views = new Map<string, { display: Sprite | Graphics; signature: string }>();
  const build = (entry: PropItem): Sprite | Graphics => {
    const { paint } = entry;
    if ('texture' in paint) {
      const loaded = texture(paint.texture);
      if (loaded) return new Sprite(loaded);
      return paintRects(new Graphics(), [[0, 0, entry.w, entry.h, 0xd8d2c4]]);
    }
    if ('note' in paint) return paintRects(new Graphics(), markerNote(paint.note).rects);
    if ('reading' in paint) {
      const [spotId, frame] = paint.reading.split('/');
      return paintRects(new Graphics(), readingFolderArt(spotId!, Number(frame)).rects);
    }
    if ('marker' in paint) return paintRects(new Graphics(), headerRects(paint.marker, paint.zero ? MARKER_SOFT : MARKER));
    return new Graphics().roundRect(0, 0, entry.w, entry.h, 4).fill(HALO);
  };
  return {
    displays(items) {
      const alive = new Set(items.map((entry) => entry.key));
      for (const [key, view] of views) if (!alive.has(key)) { view.display.destroy(); views.delete(key); }
      return items.map((entry) => {
        const signature = JSON.stringify(entry.paint);
        let view = views.get(entry.key);
        if (!view || view.signature !== signature) {
          view?.display.destroy();
          view = { display: build(entry), signature };
          view.display.label = `prop-${entry.key}`;
          views.set(entry.key, view);
        }
        const { display } = view;
        display.pivot.set(entry.pivot[0], entry.pivot[1]);
        display.position.set(entry.x + entry.pivot[0], entry.y + entry.pivot[1]);
        display.scale.set(entry.scale);
        display.rotation = entry.rotation;
        display.alpha = entry.alpha;
        display.zIndex = entry.zIndex;
        display.tint = tintFor(entry.glow);
        return display;
      });
    },
    destroy() {
      for (const view of views.values()) view.display.destroy();
      views.clear();
    },
  };
}
