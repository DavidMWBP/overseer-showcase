import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { BoardColumn } from '@overseer/shared';
import { Loading } from '../components/Loading';
import { ROOM_PROP_BOXES, ROOM_PROP_KEYS, ROOM_PROP_SHEAR, type RoomPropKey, type RoomPropsInput } from './pixi/roomProps';

/**
 * The count objects' controls. The objects themselves are Pixi sprites (`pixi/roomProps.ts`) with their own hit areas
 * under every character, so a pointer tap reaches a character standing in front of an object first. On desktop each
 * object also has a transparent button over it, as each character has, carrying its name, the keyboard route, the focus
 * ring and the chip; on phones, where the room is too small to read them, a one-line count row under the room carries an
 * icon and the number per object. A `null` count is one whose data has not loaded: no digit is shown for
 * it anywhere, never a false 0.
 */
export interface OfficeRoomProps {
  questions: number | null;
  /** One key per Board batch in review (repository id and batch id), or null until the board has loaded. */
  reviewBatches: readonly string[] | null;
  /** Every Board column in its order, with one key per task (repository id and bead id), or null ids until the board has loaded. */
  columns: readonly { key: BoardColumn; label: string; ids: readonly string[] | null }[];
  onOpenChat: () => void;
  onOpenReview: () => void;
  onOpenBoard: () => void;
}

/** A hit area (and the button's focus box) is at least this many CSS px on each side, and 44 on a coarse (touch) pointer. */
export const MIN_HIT_PX = 24;
export const MIN_TOUCH_HIT_PX = 44;

export const questionsName = (count: number | null) => (count === null ? 'Open Chat, questions loading' : `Open Chat, ${count} ${count === 1 ? 'question' : 'questions'}`);
export const reviewName = (count: number | null) => (count === null ? 'Open Review, batches in review loading' : `Open Review, ${count} ${count === 1 ? 'batch' : 'batches'} in review`);
const reviewCount = (props: OfficeRoomProps) => props.reviewBatches?.length ?? null;
export const columnName = (label: string, count: number | null) => `Open Board, ${label}: ${count ?? 'loading'}`;
const columnsLoaded = (columns: OfficeRoomProps['columns']) => columns.every((column) => column.ids !== null);
export const boardName = (columns: OfficeRoomProps['columns']) => (columnsLoaded(columns)
  ? `Open Board, ${columns.map((column) => `${column.label}: ${column.ids!.length}`).join(', ')}`
  : 'Open Board, columns loading');

/** What the Pixi scene draws from the same counts; the review-ready milestone glows the folders while it lasts. */
export function roomPropsInput(props: OfficeRoomProps, reviewReady: RoomPropsInput['reviewReady']): RoomPropsInput {
  return {
    questions: props.questions,
    reviewBatches: props.reviewBatches,
    columns: columnsLoaded(props.columns)
      ? Object.fromEntries(props.columns.map((column) => [column.key, column.ids!])) as Record<BoardColumn, readonly string[]>
      : null,
    reviewReady,
  };
}

/** True on a coarse pointer (touch), where a hit area grows to 44 px. */
export function useCoarsePointer(): boolean {
  const [coarse, setCoarse] = useState(() => typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches);
  useEffect(() => {
    if (typeof matchMedia !== 'function') return;
    const media = matchMedia('(pointer: coarse)');
    const update = () => setCoarse(media.matches);
    update();
    media.addEventListener?.('change', update);
    return () => media.removeEventListener?.('change', update);
  }, []);
  return coarse;
}

/** A world box scaled by `k`, grown about its centre to the minimum hit size. */
export function hitBox([x, y, w, h]: readonly [number, number, number, number], k: number, min: number) {
  const width = Math.max(w * k, min);
  const height = Math.max(h * k, min);
  return { left: x * k - (width - w * k) / 2, top: y * k - (height - h * k) / 2, width, height };
}

/** A box in the room-props layer's coordinates: the part of the room the stage shows. */
export interface VisibleBox { left: number; top: number; right: number; bottom: number }
/** The chip sits this many CSS px from its object, and at least this far inside the stage box. */
export const CHIP_GAP = 4;
export const CHIP_MARGIN = 4;

/**
 * Where an object's chip goes, relative to its button: centred on the part of the object the stage shows and `CHIP_GAP`
 * below that part's lowest point, or above its highest when the stage ends first, then moved the least distance that
 * keeps it `CHIP_MARGIN` inside the stage (its left edge first, when it is wider than the stage). `shear` is how far the
 * object's drawn edges drop per pixel to the right (`ROOM_PROP_SHEAR`): a stage edge that cuts off the low end of the
 * whiteboard leaves its visible part ending higher than its box.
 */
export function chipPlacement(hit: ReturnType<typeof hitBox>, chip: { width: number; height: number }, visible: VisibleBox, shear = 0): { left: number; top: number } {
  const right = hit.left + hit.width;
  const shownLeft = Math.max(hit.left, visible.left);
  const shownRight = Math.min(right, visible.right);
  const shown = shownRight > shownLeft;
  const centre = shown ? (shownLeft + shownRight) / 2 : hit.left + hit.width / 2;
  const shownTop = hit.top + shear * ((shown ? shownLeft : hit.left) - hit.left);
  const shownBottom = hit.top + hit.height - shear * (right - (shown ? shownRight : right));
  const x = Math.max(visible.left + CHIP_MARGIN, Math.min(centre - chip.width / 2, visible.right - CHIP_MARGIN - chip.width));
  let y = shownBottom + CHIP_GAP;
  if (y + chip.height > visible.bottom - CHIP_MARGIN) y = shownTop - CHIP_GAP - chip.height;
  y = Math.max(visible.top + CHIP_MARGIN, Math.min(y, visible.bottom - CHIP_MARGIN - chip.height));
  return { left: x - hit.left, top: y - hit.top };
}

const UNBOUNDED: VisibleBox = { left: -Infinity, top: -Infinity, right: Infinity, bottom: Infinity };

/**
 * One transparent button over each object, in today's tab order: Questions, In review, Board; `hovered` shows its chip.
 * `visible` is the stage box in this layer's coordinates: each chip is placed next to the visible part of its object and
 * kept inside it (`chipPlacement`), from the chip's measured size, so it follows a pan and a resize.
 */
export function RoomPropButtons({ props, scale, hovered = null, visible = UNBOUNDED }: { props: OfficeRoomProps; scale: number; hovered?: RoomPropKey | null; visible?: VisibleBox }) {
  const min = useCoarsePointer() ? MIN_TOUCH_HIT_PX : MIN_HIT_PX;
  const loaded = columnsLoaded(props.columns);
  const chipRefs = useRef<Partial<Record<RoomPropKey, HTMLSpanElement | null>>>({});
  const [chipSizes, setChipSizes] = useState<Partial<Record<RoomPropKey, { width: number; height: number }>>>({});
  // A chip is laid out while hidden, so its size is known before it shows; it changes with its text.
  useLayoutEffect(() => {
    const next: Partial<Record<RoomPropKey, { width: number; height: number }>> = {};
    for (const key of ROOM_PROP_KEYS) {
      const chip = chipRefs.current[key];
      if (chip) next[key] = { width: chip.offsetWidth, height: chip.offsetHeight };
    }
    setChipSizes((current) => (ROOM_PROP_KEYS.every((key) => current[key]?.width === next[key]?.width && current[key]?.height === next[key]?.height) ? current : next));
  });
  const buttons = [
    { prop: 'questions', name: questionsName(props.questions), chip: props.questions === null ? 'Questions' : `${props.questions} Questions`, box: ROOM_PROP_BOXES.questions, onClick: props.onOpenChat },
    { prop: 'review', name: reviewName(reviewCount(props)), chip: props.reviewBatches === null ? 'In review' : `${props.reviewBatches.length} In review`, box: ROOM_PROP_BOXES.review, onClick: props.onOpenReview },
    {
      prop: 'board', name: boardName(props.columns),
      chip: loaded ? props.columns.map((column) => `${column.label} ${column.ids!.length}`).join(' · ') : 'Board',
      box: ROOM_PROP_BOXES.board, onClick: props.onOpenBoard,
    },
  ] as const;
  return (
    <div className="office-room-props" role="group" aria-label="Office shortcuts">
      {buttons.map(({ prop, name, chip, box, onClick }) => {
        const hit = hitBox(box, scale, min);
        const chipStyle = chipPlacement(hit, chipSizes[prop] ?? { width: 0, height: 0 }, visible, ROOM_PROP_SHEAR[prop]);
        return (
          <button key={prop} type="button" className={`office-room-prop${hovered === prop ? ' office-room-prop-hover' : ''}`} data-office-prop={prop} aria-label={name} title={name}
            style={hit} onClick={onClick}>
            <span ref={(element) => { chipRefs.current[prop] = element; }} className="office-room-prop-chip" aria-hidden="true" style={chipStyle}>{chip}</span>
          </button>
        );
      })}
    </div>
  );
}

/** Phones: one slim line under the room, an icon for each object and its number; a zero is dimmed. */
export function OfficeCountRow({ props }: { props: OfficeRoomProps }) {
  const items = [
    { key: 'questions', icon: 'icon-question', count: props.questions, name: questionsName(props.questions), label: 'Questions', onClick: props.onOpenChat },
    { key: 'in-review', icon: 'folder', count: reviewCount(props), name: reviewName(reviewCount(props)), label: 'In review', onClick: props.onOpenReview },
    ...props.columns.map((column) => {
      const count = column.ids?.length ?? null;
      return { key: column.key, icon: `icon-${column.key}`, count, name: columnName(column.label, count), label: column.label, onClick: props.onOpenBoard };
    }),
  ];
  return (
    <div className="office-count-row" role="group" aria-label="Office shortcuts">
      {items.map(({ key, icon, count, name, label, onClick }) => (
        <button key={key} type="button" className={`office-count${count === 0 ? ' office-count-zero' : ''}`} data-office-count={key}
          aria-label={name} title={name} onClick={onClick}>
          <img className="office-count-icon" src={`/office/pixi/props/${icon}.png`} alt="" draggable={false} />
          <Loading loading={count === null} label={`Loading ${label}…`} placeholder={<span className="office-count-value">0</span>}>
            <span className="office-count-value">{count}</span>
          </Loading>
        </button>
      ))}
    </div>
  );
}
