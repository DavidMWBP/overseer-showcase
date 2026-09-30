# Office room objects (the count objects)

The room objects that replaced the Office count pills (task overseer-pzlw, approved from the round 2 prototype on
2026-09-26): the kanban whiteboard on the right wall, the manila folders on the meeting table, one sticky note per Board
task, and the icons of the phone count row. The files were built by the round 2 prototype's `work/art.py` (evidence
folder `office-feedback-2/props-prototype-2/`) from PixelLab art the room or round 1 already had; that round spent 0
generations. Every file is pixel art with a transparent background and binary alpha; scale it with `nearest` only.

The yellow question note, the numbered note on the folder stack and every count in marker (the whiteboard headers, the
note and the stack note) are not files: `packages/web/src/office/pixi/roomProps.ts` draws them as Pixi Graphics from the
same 3 x 5 marker font and colours as `art.py`, so any count can be drawn without a file per number. A whiteboard header count is drawn at 3 px per font pixel (15 px digits, one pixel apart; `99+` at 2 px), in frontal rows 14..28 between the column label and its rule, and sheared onto the wall as the labels are (each pixel column one row lower every second column, from an even board x).

## Files

| File | Size | Source | Placement |
|---|---|---|---|
| `kanban-board.png` | 140 x 156 | The room's PixelLab whiteboard `room/board.png` (`create_image_pro_flash`, `20c60aaa-ce0c-4229-ba0f-613b0865fddb`), stretched to a 140 x 86 frontal board by duplicating its middle column and row, six column rules and the headers `READY BLOCK RUN VERIF REVW DONE` in marker, then sheared onto the right wall (`y' = y + x // 2`). See `kanban-board.png.source.md`. | Top-left corner at `p(6.95, 0, 2.05)`, between the windows and the door, its frame just above the baseboard (moved from `p(6.05, 0, 2.6)` on 2026-09-28, with the door moved 0.92 tile along, so the whole board is inside the first view at 1280 x 800; no art change). Depth 0: nothing stands behind the wall. |
| `note-<column>.png` | 8 x 11 | Drawn: an 8 x 7 sticky note in the Board's column colour (`styles.css` `--ready` .. `--done`, lightened by 1.18), sheared to the wall. | Column slot `k` (0..9) of the whiteboard: frontal `(x0 + 1 + (k % 2) * 9, 32 + (k // 2) * 7)` with `x0 = 7 + 21 * column`, sheared. |
| `folder.png` | 42 x 27 | Round 1 PixelLab folder (`create_image_pixflux`, `69f98682-0c02-4484-8f42-1d68d6a0d5a6`), unchanged. See `folder.png.source.md`. | Bottom centre at `p(15.72 or 16.38, 8.9 or 10.45, 0.75)` on the meeting table, one per seat; the stack at `p(16.05, 9.68, 0.75)`, 3 px up per folder. Depth: the meeting table's + 0.01. |
| `icon-question.png` | 10 x 10 | Drawn: the upright yellow note with a `?` (`art.py` `qnote`). | Phone count row, Questions. |
| `icon-<column>.png` | 8 x 7 | Drawn: the upright note of each column. | Phone count row, one per Board column. |

The phone count row shows `folder.png` for In review.
