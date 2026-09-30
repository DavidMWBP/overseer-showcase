# Sidebar mascot: `me-1.png` and `me-1.json`

The sidebar mascot is the Office orchestrator character, Me-1 (see `../office/pixi/characters/SOURCE.md`). The design was approved on 2026-09-25:

- One pixel-art pose per state, using the Office's pose wherever the Office has one: idle standing, thinking with a hand on the chin, working typing, asking with the Office's yellow `?` bubble, sleeping with eyes closed and `z z`, error with the red `!` badge. Offline has no art: the component shows idle, greyed out.
- Energy shows as tired eyes when low, and as a livelier idle when high.
- The 32 px phone rail gets a head-and-shoulders crop of the same pose, because a full body is unreadable at that size.

## Frame contract

- **Full body:** 64 x 64 frames for the 64 px desktop box. The anchor is bottom-centre (`anchor: {x: 0.5, y: 1}` in the JSON), and the feet stand on row 63, the bottom row, in every frame. Frames are native size: one art pixel is one CSS pixel at 64 px. So they stay crisp at any integer device scale with `image-rendering: pixelated`.
- **Bust:** 32 x 32 frames for the 32 px phone rail, same anchor. Each is a 32 x 32 window of its full-body frame, taken before the bubble is drawn, so the face keeps the same pixels at both sizes. The window is fixed per state, so a frame's motion shows inside it. The bubble is then drawn into the window's top-right corner.
- **Facing:** all poses face south, towards the viewer. The Office characters keep facing south-west; the sidebar now faces the viewer too.
- **Registration:** a standing body stays in the same place across states. The 180 px rotation canvas and the 196 px canvas of the v3 animations each get one x offset, so the south rotation's feet centre sits on x 32. Each frame's lowest row is placed on row 63.
- **Keys:**
  - `<state>/default/<n>`, `<state>/low/<n>` and `idle/high/<n>` for the full body.
  - `<state>/bust/<n>`, `<state>/bust-low/<n>` and `idle/bust-high/<n>` for the bust.
  - States: `idle`, `thinking`, `working`, `asking`, `sleeping`, `error`.
  - Low-energy variants exist for `idle`, `thinking` and `working`; a high-energy variant exists for `idle` only. Any other state and energy pair has no frames of its own and uses `default` (or `bust`).
- **`animations`:** the play order of every sequence, keyed like the frames without the `<n>` (for example `working/bust-low`). Pixi's `Spritesheet` reads it as `sheet.animations`. The sequences:
  - `idle/high` plays the normal breath, `idle/default/0` to `3`, then the bounce, `idle/high/0`, `1`, `0`. `idle/bust-high` does the same with the busts. So `idle/high/<n>` holds only the two extra frames.
  - `working` has 6 frames. The typing pair alternates every frame, and the Office's working bubble cycles `.`, `..`, `...` every 3 frames. The Office steps its dots every 350 ms, so 350 ms per frame matches it.
  - `asking`, `sleeping` and `error` have 2 frames each. Their bubble sits 1 px lower in frame 1, a two-frame version of the Office's bob (±2 px on a sine in `effects.ts`).
- **Timing:** timing is the component's choice; the sheet holds no timing. Low energy plays the same order more slowly.
- **Layout:** `me-1.json` is a TexturePacker hash (`frames`, `animations`, `meta.image`, `meta.size`); the sheet is 600 x 660. Each sequence has one row, in this order: idle, idle low, idle high, thinking, thinking low, working, working low, asking, sleeping, error. A row holds that sequence's full-body cells (64 px plus a 2 px gutter), then its bust cells (32 px plus a 2 px gutter). Nothing touches a neighbouring frame.

## How the frames were made

All art is drawn by PixelLab from the Me-1 character through its MCP tools, except the bubbles, the keyboard and the eye edits, which are drawn in code at this size (see below). All poses are south. The animations stay on the character, so they can be reused.

| Sequence | Source | Frames used |
|---|---|---|
| idle | `animate_character` template `breathing-idle`, group `31985adb-2388-40c6-b26b-aa158004b6b5` (animation `c0141c7f-dbbf-49a4-abb7-08c8ed6d0675`) | 1, 2, 3, 0: the loop starts on frame 1, because frame 0 loses an eye's white in the downsample and the first frame is the one reduced motion holds |
| idle high (bounce) | `animate_character` v3, group `c0463db3-3db7-47e7-97ec-00adb333e771` (animation `eb7d9bf3-b7ee-4931-a749-6a03a89b5268`): "cheerful bouncy idle, a small happy bounce on the toes with arms swinging slightly" | 1, 2 |
| thinking | `animate_character` v3, group `63b456b8-f60c-4217-a345-ab13fe33651c` (animation `ffaa3ecf-dbc8-4b66-96fa-e7512f2698ca`): "thinking, lifts one hand and rests it on his chin, pondering" | 2, 4 |
| working | `animate_character` v3 interpolation, group `df6c4fa6-8f30-4daa-9059-4225acb43dd7` (animation `b72d4219-7347-4733-bd9b-7f987d096d82`): "seated, typing with both hands forward, fingers tapping", from `animate_with_skeleton_v3` job `2f28da60-59ec-4bea-97c5-b9648de42d59` frame 0 to its frame 1 (details below) | 0, 4 |
| asking | `animate_character` v3, group `2483d0b4-98b1-467c-a16b-e5b72a1e66d6` (animation `f4e9e98c-228f-400e-b5b3-90d3a8eec6e4`): "raises one hand high above his head to ask a question" | 4, used for both frames |
| sleeping | `animate_character` v3, group `34d65074-1d83-4224-be75-f5fc310d04d1` (animation `211b6476-a87d-4895-b3bb-5ee651648063`): "dozing off while standing, head drooping forward, eyes closed" | 3, 4 |
| error | `animate_character` v3, group `b14aea86-d678-40ff-8691-262eb3debde3` (animation `5d0e1baa-739f-4f22-aca5-16737d9edd7a`): "dismayed, puts both hands flat on top of his head with elbows pointing out to the sides, in alarm, face still visible" | 3, 4 |

- **v3 settings:** every v3 call used 4 frames plus the reference rotation as frame 0, on a 196 px canvas, with `directions: ["south"]`.
- **Changed descriptions:**
  - Thinking uses the first round's v3 description again, not a skeleton: facing the viewer, v3 put the hand on the chin, which it had not done facing south-west.
  - Error adds "flat", "with elbows pointing out to the sides" and "face still visible": facing the viewer, the original description put both hands over the face, which hides the face at 64 px.
- **Working:** the Office has only south-west typing frames, so the south typist is new. It took two calls: a skeleton job for the seated pose, then a v3 interpolation that stores the pose on the character.
  - The first-frame skeleton is measured from `rotations/south.png`. RIGHT is the character's right, the viewer's left.
  - The three keypoint frames seat the figure: the upper body drops 0.07, the knees come just below and outside the hips, the feet come forward to y 0.78, and both wrists reach in front of the belly at x 0.465 and 0.535. The frames alternate which wrist is lower (y 0.63 and 0.645), a typing tap.
  - Action "seated, typing with both hands forward".
  - Description: seated typing pose, both hands forward, transparent background, no objects.
  - A skeleton job is saved in the PixelLab gallery (asset `2469785c-ca88-5893-b4f6-dae46e07d41b`), not on the character. So its frames 0 and 1 are the `custom_start_frame_url` and `end_frame_url` of a v3 call with `directions: ["south"]` and 4 frames, which stores the typing animation on Me-1 for reuse. Its frame 0 is the skeleton frame 0 byte for byte, and its frame 4 differs from skeleton frame 1 in 36 source pixels.
- **Download links:**
  - An animation frame is `https://backblaze.pixellab.ai/file/pixellab-characters/2da15841-ba1d-4e8c-a46b-da3f9ca4a5c6/b567541b-9405-4ffc-a064-748cd73f86e5/animations/<animation id>/south/<n>.png`.
  - A skeleton frame is `https://api.pixellab.ai/mcp/images/<job id>/download?index=<n>`.
  - The rotation is `.../b567541b-9405-4ffc-a064-748cd73f86e5/rotations/south.png`.
- **Not used:**
  - Group `b1146292-7cda-476a-bccd-2b8488441a49` (animation `cc2c5493-5971-44bc-adf5-c42cc3d080e2`), v3 "dismayed, puts both hands on top of his head in alarm": both hands cover the face.
  - The south-west groups of the first round stay on the character but are no longer in the sheet: `7f7e20fa-071c-4c81-a63b-32131005a216`, `31ed08ed-de8b-49e1-8097-7df26bc9df10`, `79e046e8-a5ac-4b6f-a31e-d633ce151a05`, `517711f3-714c-40bc-a574-9ea65395fb16`, `258877fd-0ddc-445b-83c0-5691d5f2d55a`, `8cdf0958-4284-4e47-920a-cd31a7832fbb` and `cf8a1c63-666c-4351-8f5f-e3fd422bd9cb`, plus skeleton job `52e9bd43-03a8-4b01-a529-28aa9e8e695d` and the Office's type-front job `62c58554-e678-4057-b8d1-cc0ea55a842b`.

**Packing.** A script outside the repository builds the sheet: `mascot-me-1-south/work/build.mjs` in the evidence folder, with `frames.mjs` and `down.mjs`, copied from the first round's `mascot-me-1/work/`. The build is byte-reproducible. Its steps:

1. **Clean:** each source frame loses pixels at alpha 16 or below, and 4-connected specks under 40 px, as in the Office packing.
2. **Snap:** every pixel is snapped to the south rotation palette, which keeps the animation from flickering and keeps the mascot aligned with the Office art.
3. **Warm:** the sprite receives the same palette adjustment used by the Office character set.
4. **Downsample:** each 2 x 2 source block becomes one pixel, a 0.5 scale. The pixel takes the block's most common colour (ties go to the darker one) and is opaque when at least half the block is. The source grid keeps the rotation's phase against the feet (the lowest row and the left edge of the sneakers): the breathing template and some v3 frames move the whole figure by an odd number of source pixels, and a grid one pixel off lost the white of an eye. The 122 px rotation becomes 62 px tall. The Office uses 0.5694, so the mascot is 0.88 of the Office's size.
5. **Placement:** each frame's lowest row goes on row 63, and the x offset is -12 on the 180 px canvas and -16 on the 196 px canvas, so the south rotation's feet centre (x 44.1 and 48.1 after downsampling) sits on x 32. The breathing template moves the whole figure up to 3 rows, so the feet stay put and only the breath shows. The seated typist needs no x shift: its feet centre is the rotation's.
6. **Ghosts:**
   - Grey pixels on the silhouette edge above row 52 are background ghosts. Counting the next rule, the rules remove 1 px from the second idle high frame, 1 px from the first working frame and 1 px from the second error frame.
   - Background-tone pixels at row 56 or below form the ground shadow; frame cleanup keeps the shadow separate from the sprite.
7. **Keyboard:** the typing frames get a small keyboard on the lap, so the pose reads as typing without the Office's desk.
   - Seen from the front and above, it is a flat rectangle, x 22 to 42 and y 43 to 47: a 21 x 4 top face (a 1 px rim around two rows of keys in a checker) and a 1-row front edge facing the viewer. It uses the key colours of the Office's `keyboard-mouse.png`: body `#475465`, keys `#828b92`, rim `#2e364a` and front edge `#0b0c12`.
   - That keyboard itself is too large for this box and nearly black on the rail.
   - The keyboard overlays the seated sprite; the top key row stays clear so the hands align with the keys.
8. **Tired eyes (low energy):**
   - The low-energy edit locates existing facial-detail clusters in the south-facing frame box. Nearby pixels join one detail; small mouth shadows are excluded.
   - The top pixels of each detail cluster are darkened and the row below is shadowed to create the tired expression without changing the rest of the sprite.
9. **Bubbles:** they follow the Office's Pixi bubbles in `src/office/pixi/effects.ts`, redrawn as pixel art at this size:
   - Colours: a `#1b1f27` outline; `?` in `#1b1f27` on `#ffd166`, `!` in white on `#e04848`, and `z z` and the working dots in `#1b1f27` on `#fbf7ee`.
   - Shape: a box with one-pixel rounded corners and a 2-row tail pointing down-left toward the head. The `?`, `!` and dots box is 13 x 11 plus the tail; `z z` is 16 x 8 plus the tail.
   - Glyphs: `?` is 5 x 7, `!` is 2 x 7, each `z` is 4 x 4, and each dot is 2 x 2.
   - Full-body positions (top-left): asking (46, 0), error (47, 0), sleeping (39, 1), working (50, 0).
   - Bust positions: (19, 0), and (16, 0) for `z z`.
10. **Bust windows:** these are top-left corners in the full-body frame, with the south head centred on x 32. Idle (16, 1), thinking and working (16, 4), asking (14, 2), which shows the start of the raised arm, sleeping (16, 13), error (16, 2). The high-energy bounce uses the idle window, so the head dips inside it.

## Generations

The south round on 2026-09-26 used 23 PixelLab generations of the 40 allowed. The count comes from each call's reported cost:

- 1 for the `breathing-idle` template.
- 15 for five v3 animations, at 3 each: the lively idle, asking, sleeping, error and thinking.
- 2 for the typing skeleton job.
- 3 for the error v3 reroll.
- 2 for the typing interpolation that stores the typing pose on the character.

The account's "used" counter went from 373 to 394 over the first 21; by the typing interpolation it read 403, because another session used the account in between, so the count rests on the reported costs. The first, south-west round used 21 generations of 150; its sheet reused the Office's typing frames.

## Licence

PixelLab's [Terms of Service](https://www.pixellab.ai/termsofservice) say that creators retain copyright and may use, modify and distribute outputs for commercial or non-commercial purposes, subject to applicable law and the Open RAIL-M licence. The terms do not state an attribution requirement. The keyboard colours come from this repository's PixelLab furniture art (`../office/pixi/furniture/keyboard-mouse.png`), and the bubble design from its Office renderer.
