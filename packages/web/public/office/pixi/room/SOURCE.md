# Office room art (layouts 1c and 2): sources

The pieces in this folder are PixelLab generations in the approved variant B style (2026-09-25), each cropped to its
content. `packages/web/scripts/compose-office-room.mjs` composes them into the static room:

| Output | Size | Content |
|---|---|---|
| `../room-day.png` | 1680 x 1056 | Floor, both back walls and the wall items; transparent outside the room |
| `../room-night-windows.png` | 1680 x 1056 | The night sky in the window panes; transparent everywhere else |
| `../glass/*.png` | per segment | The glass partitions, one image per tile, plus the two door-gap posts |
| `layout2-day.png` | 1680 x 1056 | Layout 2 (`--layout 2`): as `../room-day.png` with the layout 2 floor regions and no done board |
| `layout2-night-windows.png` | 1680 x 1056 | Layout 2 (`--layout 2`): the night sky in the window panes, the same pixels as `../room-night-windows.png` since the walls and windows did not change |

The Pixi office draws the layout 2 pair; `../room-day.png` and `../room-night-windows.png` are layout 1c's and are no longer drawn.

## Licence

PixelLab's [Terms of Service](https://www.pixellab.ai/termsofservice) say creators retain copyright and may use, modify
and distribute outputs for commercial or non-commercial purposes, subject to applicable law and the Open RAIL-M
licence. The terms do not state an attribution requirement.

## Pieces

Every piece is the PixelLab output cropped to the rectangle given (x, y, width, height); nothing else is changed here.
Tile images come from `https://backblaze.pixellab.ai/file/pixellab-tiles/2da15841-ba1d-4e8c-a46b-da3f9ca4a5c6/<job>/tile_<n>.png`,
the other images from `https://api.pixellab.ai/mcp/images/<job>/download`.

| File | Tool | Job id | Source, crop | Settings |
|---|---|---|---|---|
| `floor-carpet-a.png` | `create_tiles_pro` | `119cade8-cc0f-4a08-b2ea-56d966ee2d93` | `tile_1`, 0 24 96 48 | prompt T |
| `floor-carpet-b.png` | `create_tiles_pro` | `119cade8-cc0f-4a08-b2ea-56d966ee2d93` | `tile_9`, 0 24 96 48 | prompt T |
| `floor-lab-a.png` | `create_tiles_pro` | `119cade8-cc0f-4a08-b2ea-56d966ee2d93` | `tile_3`, 0 24 96 48 | prompt T |
| `floor-lab-b.png` | `create_tiles_pro` | `119cade8-cc0f-4a08-b2ea-56d966ee2d93` | `tile_11`, 0 24 96 48 | prompt T |
| `floor-wood-a.png` | `create_tiles_pro` | `119cade8-cc0f-4a08-b2ea-56d966ee2d93` | `tile_6`, 0 24 96 48 | prompt T |
| `floor-wood-b.png` | `create_tiles_pro` | `119cade8-cc0f-4a08-b2ea-56d966ee2d93` | `tile_7`, 0 24 96 48 | prompt T |
| `wall.png` | `create_image_pro_flash` | `81021ef8-39b8-473f-90d6-3aeaa5686125` (image `2cc602ef-ac19-55f1-add0-71a10d96f824`) | 6 3 84 181 | 96 x 192, background on, seed 24, prompt W |
| `window-left.png` | `create_image_pro_flash` | `19d0b1cd-6741-4c3f-9d88-7d97cf1442b7` (image `7d7d3121-2f49-537c-804f-eb167386f9ff`) | 0 0 136 96 | 136 x 96, no background, seed 25, prompt L |
| `window-right.png` | `create_image_pro_flash` | `be149448-357b-4c00-a687-c0b7a60241bf` (image `4b2c078a-c125-572e-b6e1-c9b143c25f83`) | 0 0 192 95 | 192 x 96, no background, seed 22, prompt R |
| `sky-day.png` | `create_image_pixflux` | `92992a32-4642-471e-a99a-2eafc17079e0` (asset `5568eecf-ed29-5bd2-a39a-472562a840de`) | 0 0 192 96 | 192 x 96, background on, basic shading, seed 31, prompt D |
| `sky-night.png` | `create_image_pixflux` | `6f8e3a7d-41a8-4f3a-a390-8365539880d7` (asset `0f288fbf-9459-5ad1-82f2-ced2a461d80a`) | 0 0 192 96 | 192 x 96, background on, basic shading, seed 27, prompt N |
| `door.png` | `create_image_pro_flash` | `f4eeabcd-91b3-4683-b57d-730507442059` (image `91e1e28f-5e01-5b40-bc48-90f7bd1b0cf1`) | 14 8 67 135 | 96 x 144, no background, seed 21, prompt O |
| `board.png` | `create_image_pro_flash` | `20c60aaa-ce0c-4229-ba0f-613b0865fddb` (image `6d81b491-7e05-5b09-8b17-ad9b6e639b64`) | 21 13 122 67 | 164 x 96, background on, seed 29, prompt B |
| `glass.png` | `create_image_pro_flash` | `151244f5-be95-41f3-a93d-aff744737e27` (image `08cbfe30-60c4-509d-b46d-bbeb2b0b8257`) | 3 5 42 147 | 48 x 156, no background, seed 26, prompt G |
| `sconce.png` | `create_image_pixflux` | `6b43fc88-bbae-49b9-a2d2-9be35fd67a1a` (asset `57bbd79a-94bc-5194-adc8-ccc9a2070595`) | 12 6 8 20 | 32 x 32, no background, side view, single colour black outline, medium shading, highly detailed, seed 30, prompt S |

Prompts:

- **T** (isometric, tile size 96, view angle 30, depth ratio 0, outline mode segmentation, seed 12; 16 variations):
  "1). blue-grey low-pile office carpet floor, fine woven texture 2). blue-grey office carpet floor, subtle woven loops
  3). light grey laboratory vinyl floor, subtle speckles 4). light grey laboratory vinyl floor, fine speckles 5). muted
  lavender-purple office carpet floor, fine woven texture 6). muted lavender-purple office carpet floor, subtle loops 7).
  warm honey oak wooden plank floor, straight parallel planks with grain 8). warm honey oak wooden plank floor, straight
  parallel planks with grain and seams"
- **W**: "Pixel art texture, front view, flat orthographic, of a plain interior office wall: warm beige painted plaster
  with a very subtle fine texture, lit evenly. At the bottom a plain wooden skirting board about 11 pixels tall. At the
  top a dark brown wooden crown moulding about 8 pixels tall. Nothing on the wall. Fills the whole canvas edge to edge,
  seamless left and right edges, no perspective."
- **L**: "Pixel art, front view, flat orthographic, of an office window with a dark brown wooden frame and one vertical
  mullion in the middle, glass showing a bright light-blue daytime sky with one small soft white cloud and a faint
  diagonal glass reflection. The frame fills the whole canvas and touches all four edges. Dark near-black outlines,
  banded shading, no perspective, no wall, no curtains."
- **R**: "Pixel art, front view, flat orthographic, of a wide office window with a dark brown wooden frame and one
  vertical mullion in the middle, glass showing a bright light-blue daytime sky with two small soft white clouds and a
  faint diagonal glass reflection. The frame fills the whole canvas and touches all four edges. Dark near-black
  outlines, banded shading, no perspective, no wall, no curtains, no sill plants."
- **D**: "clear daytime sky seen through a window, soft light blue gradient, lighter near the bottom, two small fluffy
  white clouds, pixel art"
- **N**: "night sky seen through a window, deep navy blue, scattered tiny white and pale yellow stars, a few faint dark
  blue clouds, pixel art"
- **O**: "Pixel art, front view, flat orthographic, of a closed dark walnut wooden office door in a dark wood door frame.
  Two recessed panels, brass lever handle on the right, thin metal kick plate at the bottom. The frame fills the whole
  canvas and touches all four edges. Dark near-black outlines, banded shading, warm wood grain, no perspective, no wall,
  no floor."
- **B**: "Pixel art, front view, flat orthographic, of an empty office whiteboard: clean off-white glossy board surface
  with a faint diagonal sheen, thin grey aluminium frame with dark grey corner caps, nothing written on it. Dark
  near-black outlines, banded shading, no perspective. Plain beige painted wall around it."
- **G**: "Pixel art, front view, flat orthographic, of a tall glass office partition panel: a slim blue-grey aluminium
  frame on all four sides, thicker top rail, pale blue see-through glass with two faint diagonal white reflection
  streaks. The frame fills the whole canvas and touches all four edges. Dark outlines, banded shading, no perspective."
- **S**: "wall sconce lamp seen from the front: small flat brass back plate, short brass arm, frosted cream glass shade
  opening upward, warm glow, symmetrical, office interior prop"

### Generations

121 PixelLab generations, counted from each call's price: 25 for each of the three `create_tiles_pro` calls (the
first was measured on the balance; the tool quotes 20 to 40 by canvas size, so the ceiling is 151), 6 for each of the
seven `create_image_pro_flash` calls and 1 for each of the four `create_image_pixflux` calls. Not used:

| Tool | Job id | Why not |
|---|---|---|
| `create_tiles_pro`, top-down view, seed 11 | `f39a13fd-3317-41ff-9cc9-4450e3f5e4f4` | Square 96 x 96 diamonds, not the 2:1 isometric tile |
| `create_tiles_pro`, style image `tile_9`, seed 13 | `3a16b446-ffd7-4223-ba52-a0136a87f7c5` | Purple carpet drawn as square blocks with depth; the style mode ignored the diamond |
| `create_image_pro_flash`, whiteboard without background, seed 23 | `1b357e85-45ac-4c05-959d-7bb932b8e7db` | The board surface was removed as background |
| `create_image_pixflux`, isometric sconce, seed 28 | `26f14799-0151-4fcc-aa79-8b0439793226` | Its curled arm does not read as a wall lamp at 20 px |

## Composition

`node packages/web/scripts/compose-office-room.mjs` rebuilds the three outputs from the pieces. With
`--raw <dir>` it first re-crops the pieces from the downloads, saved as `<dir>/floor2/tile_<n>.png` for the tiles and
`<dir>/items/<name>.png` for the rest (the names are in the script's `PIECES` table). With `--layout 2` it writes the
layout 2 room to `layout2-day.png` and `layout2-night-windows.png` in this folder instead of the two room outputs
above (the glass is the same for both layouts). The script has no dependencies.

Everything is placed through the handoff projection `p(i, j, z) = [696 + (i - j) * 48, 216 + (i + j) * 24 - z * 48]`:

- **Floor.** Every world pixel is mapped back to its tile (i, j). The region follows the handoff table (lab i > 12, j < 7;
  review i > 12; break wood i > 6.5, j > 11; carpet elsewhere; tested at the tile's centre), and the tile takes its
  region's colour `(i + j) % 2`. Layout 2 keeps the lab floor under the QA corner and the review floor under the
  meeting room, and moves the wood under the kitchen and lounge (i < 5.5, j > 9); the old break area is carpet. The
  texture is one of the region's two pieces, picked by a hash of (i, j), and is tinted by scaling that colour with the
  texture's luminance over its mean. The review floor reuses the carpet pieces under its purple colours. Tile edges are
  darkened by 12%, the handoff's grid line.
- **Walls.** The left wall (j 0..14) and the right wall (i 0..20) are 4 units tall. `wall.png` is repeated along them,
  one screen column per texture column, which gives the 2:1 shear. Its rows map to an 8 px cap (`#5b4a39`), plaster and
  an 11 px baseboard (0.22 units, `#8e7a60`); the plaster takes `#cdbb9c` on the left wall, `#dccba9` on the right wall
  and `#d3d8dc` on its lab section (i 12..20). The outer end of each wall has a 2 px `#1b1f27` outline.
- **Wall items.** Each item is fitted to its handoff quad without scaling: flat columns and rows are duplicated or
  dropped until it has the quad's size, then it is sheared onto the wall. Windows: left wall j 3..5.8 and 6.2..9, right
  wall i 2..6, z 1.3..3.3. A pane pixel (see-through in the art, or its light cloud and glint pixels) shows `sky-day.png`
  tinted to `#a9d4ef` in `room-day.png`, and `sky-night.png` tinted to `#1c2745` in `room-night-windows.png`, which
  holds nothing else. Door: right wall i 9..11, z 0..3; in layout 2 at i 9.92..11.92,
  44 px along (moved 2026-09-28 so the kanban whiteboard to its left can hang whole in a 1280 x 800 first view; 17369 pixels changed, bounding box
  140 x 213 at 1128, 288; no PixelLab call). Done board: right wall i 16..19.4, z 1.4..3.4, with the painted
  wall around its corners and tray dropped; it stays empty, since the engine draws the notes. Layout 2 has no done
  board: the kanban whiteboard (`../props/kanban-board.png`) is its one board, so the QA corner's wall stays plain lab
  plaster there (removed 2026-09-26, 15276 pixels changed, all inside that quad, bounding box 163 x 172 at 1464, 438;
  no PixelLab call). Sconces: unsheared,
  centred at z 3 on the left wall at j 1.8 and 11 and on the right wall at i 7.5 and 14.5.
- **Glass.** Partitions at i = 12 (j 0..6 and 8..14) and j = 7 (i 14..20), 2.3 units tall (3.2 until 2026-09-28, which
  streaked over the QA corner and the pod desks behind it; `GLASS_H` in `furniture.ts`). `glass.png` is fitted to
  48 x 110 (rows dropped, no resample) and sheared onto each tile of a partition. The pane keeps the art's colour at 10%
  alpha and the reflections 30% (20% and 55% before 2026-09-28), and the frame is opaque. The two posts are 0.16 x 0.16 boxes at (11.92, 5.92) and (11.92, 7.92), in the frame's mean
  colour (top x 1.15, the +i face x 0.8) with a 1 px outline.

Each glass image's top-left corner sits at world (x, y). The depth keys are the handoff's (`12 + j + 0.5` for i = 12
segments, `i + 7.5` for j = 7 segments, 18 and 20 for the posts), so `zIndex = round(depth * 100)`.

| File | x | y | Size | Depth |
|---|---|---|---|---|
| `i12-j0.png` | 1224 | 393 | 48 x 135 | 12.5 |
| `i12-j1.png` | 1176 | 417 | 48 x 135 | 13.5 |
| `i12-j2.png` | 1128 | 441 | 48 x 135 | 14.5 |
| `i12-j3.png` | 1080 | 465 | 48 x 135 | 15.5 |
| `i12-j4.png` | 1032 | 489 | 48 x 135 | 16.5 |
| `i12-j5.png` | 984 | 513 | 48 x 135 | 17.5 |
| `i12-j8.png` | 840 | 585 | 48 x 135 | 20.5 |
| `i12-j9.png` | 792 | 609 | 48 x 135 | 21.5 |
| `i12-j10.png` | 744 | 633 | 48 x 135 | 22.5 |
| `i12-j11.png` | 696 | 657 | 48 x 135 | 23.5 |
| `i12-j12.png` | 648 | 681 | 48 x 135 | 24.5 |
| `i12-j13.png` | 600 | 705 | 48 x 135 | 25.5 |
| `j7-i14.png` | 1032 | 609 | 48 x 135 | 21.5 |
| `j7-i15.png` | 1080 | 633 | 48 x 135 | 22.5 |
| `j7-i16.png` | 1128 | 657 | 48 x 135 | 23.5 |
| `j7-i17.png` | 1176 | 681 | 48 x 135 | 24.5 |
| `j7-i18.png` | 1224 | 705 | 48 x 135 | 25.5 |
| `j7-i19.png` | 1272 | 729 | 48 x 135 | 26.5 |
| `post-i12-j6.png` | 976 | 533 | 16 x 119 | 18 |
| `post-i12-j8.png` | 880 | 581 | 16 x 119 | 20 |
