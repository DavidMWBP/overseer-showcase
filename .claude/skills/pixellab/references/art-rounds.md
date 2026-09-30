# PixelLab art-round records

Counts below are PixelLab generations reported by the jobs. A round total includes rejected attempts unless stated otherwise. Keep per-job counts: the shared account balance changed while other sessions were using it.

## Workflow guidance from the art rounds

- **Characters:** `create_character` with 8 directions, 128 px, high top-down view, chibi proportions, single-colour black outline, detailed shading and high detail. Generate candidates and compare them at scene size; details varied, and Me-1 took 18 candidates. [`packages/web/public/office/pixi/characters/SOURCE.md`; character ledger; task `overseer-qjcp`]
- **Walking:** `animate_character` with a four-frame walk for south-west and north-west. Inspect every frame; dev-2's north-west walk had a loose ground shadow that needed removal. [`packages/web/public/office/pixi/characters/SOURCE.md`; task `overseer-qjcp`]
- **Seated typing:** `animate_with_skeleton_v3` with a posed seated skeleton, bent knees and hands forward. Keep furniture and keyboard out of the prompt; use `ARM` and `LEG` joints. The no-furniture job `8216667f` produced two typing frames. A chair in the prompt added a chair and ghost smears (`828b459f`); text animation v3 crouched, and `create_character_state` made a still, not typing frames. Its output is not attached to a character; when an animation must live on the character, interpolate between the skeleton frames with `animate_character` (v3) on that character. [task `overseer-ccz5`; `packages/web/public/office/pixi/characters/SOURCE.md`]
- **Furniture and props:** `create_map_object` worked with high top-down view, high detail, single-colour outline and medium shading. `create_image_pixflux` made the desk, but image-to-image retries kept its monitor facing the viewer. Remove and refill that area, then make the rear-facing monitor separately (`55b84281`), scale and shear it to the 2:1 axis, and anchor it at the seat. For 1:1 art, ask for a canvas about 10–20% larger than the piece's final size and crop: 64 × 80 gave 42 × 66 and 39 × 66 mesh chairs, 48 × 104 a 30 × 92 snake plant, and 32 × 104 a 24 × 102 floor lamp. Geometric pieces (desks, monitors, a table top) are more reliable drawn on exact faces by a script at 1:1. [task `overseer-bse4`; `packages/web/public/office/pixi/furniture/SOURCE.md`; task `overseer-72zy`]
- **Isometric tiles:** `create_tiles_pro` with isometric view, 96 px tile size, 30° angle, depth ratio 0, segmentation outline and 16 variations produced the floor diamonds. Crop each tile to 96 × 48. Top-down mode made squares and a style-image route ignored the diamond (`f39a13fd`, `3a16b446`). [`packages/web/public/office/pixi/room/SOURCE.md`]
- **Room background:** generate pieces instead of one scene image. `create_image_pro_flash` worked for orthographic walls, windows, door, board and glass; `create_image_pixflux` worked for day/night skies and the sconce. Crop each piece to content and compose on the handoff projection. [`packages/web/public/office/pixi/room/SOURCE.md`; task `overseer-q1ts`]
- **Glass:** `create_image_pro_flash` with a 48 × 156 canvas and no background produced panel `151244f5`. Crop `(3,5,42,147)` and repeat it as handoff-sized segments. The room source lists no failed glass-specific route. [`packages/web/public/office/pixi/room/SOURCE.md`; task `overseer-q1ts`]

## Character-size history

The earlier cast was sampled from a 180 px source to 48 × 87 cells at 0.5694, which softened the grid. By 2026-09-28 the cast had been regenerated at final cell size. Employee-2 was the final-size pilot: `create_character` with `size` 78 produced a 112 × 112 canvas and a 75 px body copied 1:1 into the cell; the pilot used 13 generations and 4 rerolls, and its outline still had gaps before the ink pass. [`packages/web/public/office/pixi/characters/SOURCE.md`; tasks `overseer-bse4`, `overseer-xaue`]

The first board made a leaning pose and viewer-facing monitor look seated and correct from a distance. Judge the asset itself as well as the assembled scene. [tasks `overseer-bse4`, `overseer-ccz5`, `overseer-qjcp`, `overseer-q1ts`]

## Cost by asset kind

| Asset kind | Observed cost | Source |
|---|---:|---|
| Character reference art | `create_character`: 1 per candidate. The nine-character pass used 9 calls; Me-1 character design selection used 18. | `packages/web/public/office/pixi/characters/SOURCE.md`, character ledger; task `overseer-qjcp` |
| Walking | `animate_character`: 1 per direction; south-west and north-west cost 2 per character. The nine-character pass used 18. | `characters/SOURCE.md`, character ledger; task `overseer-qjcp` |
| Seated typing | `animate_with_skeleton_v3`: 2 per job, two directions cost 4 per character before rerolls. The cast used 58 across 29 jobs; Me-1 used 4 without rerolls. | `packages/web/public/office/pixi/characters/SOURCE.md`; tasks `overseer-ccz5`, `overseer-qjcp` |
| Furniture and props | `create_map_object` and `create_image_pixflux`: 1 per call. Furniture used 16 generations: 9 selected, 7 rejected. The approved desk, monitor and chair were reused from earlier rounds at no cost to this task. | `packages/web/public/office/pixi/furniture/SOURCE.md`; task `overseer-72zy` |
| Isometric tiles | The selected `create_tiles_pro` floor job cost 25. The room round used 3 tile calls at 25 each; 2 were rejected. | `packages/web/public/office/pixi/room/SOURCE.md`; jobs `119cade8`, `f39a13fd`, `3a16b446` |
| Room pieces and glass | `create_image_pro_flash`: 6 per call; `create_image_pixflux`: 1 per call. The room round recorded 121 total across 3 tile, 7 Pro Flash and 4 PixFlux calls. Glass job `151244f5` cost 6. | `room/SOURCE.md`; task `overseer-q1ts` |

**Inferred selected-room subtotal:** 64 generations: one retained tile call (25), six retained Pro Flash calls including glass (36), and three retained PixFlux calls (3). The reported room total of 121 also includes rejected calls, so use it for round planning rather than as the final room's selected-asset cost.

Recorded budgets were 22/80 for the first style study, 50/60 for the seated style round, 85/800 for the nine-character cast and 24/120 for Me-1. Furniture used 16 generations and the room work 121. Final records for `overseer-bse4` and `overseer-ccz5` show Claude sessions; use Claude + hard for future Office art dispatch, as required by `SKILL.md`.

## Rejected routes and observed results

| Asset | Rejected route or result | Source |
|---|---|---|
| Style character and desk | A sitting-and-typing text prompt returned a standing figure leaning forward. Two PixFlux monitor attempts kept the monitor facing the viewer. The desk was fitted to the footprint but reached deeper than one tile. A 180 px character source reduced to 48 × 87 and softened the grid. | `packages/web/public/office/pixi/characters/SOURCE.md`; task `overseer-bse4`; evidence `office-pixi-style` |
| Seated typing | Skeleton plus chair (`828b459f`, 2 generations) drew a chair and ghost smears; `animate_character` v3 (3) crouched; `create_character_state` (`16384425`, 40) made a seated still without typing frames. The first skeleton request (`d9e448a9`) failed validation: valid joint names were `ARM` and `LEG`, not `WRIST` and `ANKLE`. | `packages/web/public/office/pixi/characters/SOURCE.md`; task `overseer-ccz5` |
| Chair and monitor | Chair `b4527274` faced away from the sitter. Image-to-image was unreliable for changing the monitor's facing. | `packages/web/public/office/pixi/furniture/SOURCE.md`; task `overseer-ccz5` |
| Character cast | Walk shadows and light-hair background ghosts needed frame-level review and cleanup. Security-auditor seated seeds 7, 11 and 23 ghosted the grey hair; a magenta first-frame reference helped but paired-frame cleanup was still needed. | `characters/SOURCE.md`, character ledger; task `overseer-qjcp` |
| Furniture props | Bare desk was plainer than the approved desk (`954b612d`); angled monitor came out flat (`26d352ca`); bench calls produced purple legs or opaque white backgrounds (`fdd7006f`, `3d70db0f`, `be92d7f3`); rig came with its own stand (`e23ca753`); a second printer was small and pale (`65169d1c`). | `furniture/SOURCE.md`; furniture ledger; task `overseer-72zy` |
| Isometric floor | Top-down seed 11 made square 96 × 96 tiles (`f39a13fd`); style-image seed 13 ignored the diamond (`3a16b446`). | `room/SOURCE.md` |
| Room and glass | Making the board background transparent removed its surface (`1b357e85`); the first PixFlux sconce curled its arm and did not read at 20 px (`26f14799`). The source lists no glass-specific failed route. | `room/SOURCE.md`; task `overseer-q1ts` |

## External-source suggestions (not from these art rounds)

These practices come from the external [Reddit r/aigamedev post](https://www.reddit.com/r/aigamedev/comments/1woix1m/opus_55_can_indeed_generate_pixel_art_scenes/), not our art-round results. Its example uses a fixed logical canvas, integer-factor display scaling, and a fixed palette (“Every pixel comes from this palette.”).

- **Resolution:** generate at display size or a whole-number multiple; downscale only by whole factors. This is external guidance, not a result from our rounds, which used 0.5694 for characters and 8/7 for a desk and reported softened pixels; the furniture was later generated or drawn again at 1:1. [`characters/SOURCE.md`; `furniture/SOURCE.md`; style-round 1 task `overseer-bse4`]
- **Palette:** map the complete asset set onto one fixed palette. As an application of the post's palette practice, use PixelLab `reduce_colors` with the same palette image for every asset; batch only same-sized frames together. This workflow was not tested in our rounds. [Reddit post above; PixelLab `reduce_colors` tool description]
- **Exact small edits:** use PixelLab `pixelart_workbench` to draw or correct pixels on a small prop before requesting another generation. This applies the post's procedural pixel-run approach through PixelLab's editing tool; our rounds do not test it. The monitor-back retries are the relevant failure case, not evidence that this tool works. [Reddit post above; PixelLab `pixelart_workbench` tool description; task `overseer-bse4`]

## Review evidence

- Task `overseer-72zy` passed the furniture review with no actionable defects; the review reported source notes and furniture art only.
- Task `overseer-qjcp` passed the character review: 126/126 atlas keys, 48 × 87 cells and row-82 baseline, with day/night captures.
- Task `overseer-q1ts` passed the room review; captures showed the room, night windows and glass segments.

The primary prompt, crop, anchor, licence and job records are in `packages/web/public/office/pixi/{characters,furniture,room}/SOURCE.md`.
