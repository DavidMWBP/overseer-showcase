---
name: pixellab
description: Generate and fit PixelLab art for Office Pixi characters, animations, furniture, props, tiles, room backgrounds, and glass. Use when asked to create or change artwork in the Office. Not for critiquing or gating captures; use office-critic.
---

# PixelLab art workflow

Use this for Office Pixi artwork. The `pixellab` MCP tools are available only in Claude sessions, so dispatch art work to Claude. Use **Claude + hard** for art work. These settings are observed in the cited jobs, not guarantees for every prompt. Keep each job's settings, cost and source ID with its asset; see [art-round records](references/art-rounds.md) for observed routes, budgets, and external-source suggestions.

## Choose tools by job

- **Characters and animation:** `create_character`, `create_character_pro_flash`, `create_character_state`, and `animate_character`; inspect and poll with `get_character`.
- **Props and objects:** `create_map_object`, `create_1_direction_object`, `create_8_direction_object`, or `create_object_pro_flash`; edit states or animate with the matching object tools, then inspect with `get_map_object` or `get_object`.
- **Floors and room pieces:** `create_topdown_tileset`, `create_sidescroller_tileset`, `create_isometric_tile`, `create_tiles_pro`, `create_path_tiles`, and `create_building_kit`; poll using the corresponding `get_*` tool.
- **Standalone images and edits:** `create_image_pro_flash` or another suitable image creation tool; use `edit_image_pro_flash`, `inpaint_image`, `correct_pixelart`, or other image tools for changes, then retrieve the result with its matching `get_*` tool.

Check the tool descriptions and the [PixelLab MCP guide](https://api.pixellab.ai/mcp/docs) for current parameters and matching status tools.

## Generate, retrieve, and save

Creation tools are non-blocking: they return a job or asset ID while generation runs in the background, typically 2–5 minutes. Poll the matching `get_*` tool with that ID until it reports completion. Use the download or storage URL it returns to retrieve the result. The guide says these download links use the UUID as the access key and need no authentication.

The Office art is PixelLab output; none of the Claude-Office art the room once used ships. Keep Office art in `packages/web/public/office/pixi/`, next to the `SOURCE.md` of its kind. For each PixelLab asset, add a neighboring `<asset filename>.source.md` sidecar with this record:

```markdown
PixelLab tool: <tool>
Job/asset ID: <id>
Prompt or edit: <exact text sent>
Download URL: <returned URL>
```

PixelLab's [Terms of Service](https://www.pixellab.ai/termsofservice) say creators retain copyright and may use, modify, and distribute outputs for commercial or non-commercial purposes, subject to applicable law and the Open RAIL-M license. The terms do not state an attribution requirement.

## Fit and check against the handoff

- **Characters:** generate frames at the cell's own size and copy them 1:1 into the 48 × 87 atlas cell. Keep the `(0.5,1)` anchor and row-82 feet baseline; keep walk frames on one vertical offset, idle and walk on the idle feet-centre anchor, and typing frames centred as a pair, with `type/<view>/1` rebuilt from frame 0 so only the hands move (`characters/SOURCE.md`, Keystroke pass); lengthen a typing forearm rather than lean a typist more than three steps (Reach pass). Use `characters/SOURCE.md` as the current cell, margin and baseline contract; see [art-round records](references/art-rounds.md) for final-size history.
- **Objects and room:** retain binary alpha and nearest scaling. Anchor box-like furniture at the footprint's front corner and small props at the centre of their base; keep the handoff depth order. Room outputs are 1680 × 1056, tile crops 96 × 48, and glass segments 48 × 135 (2.3 units tall). Anchor each glass segment by its listed top-left world position and depth; the pane is 10% opacity, reflections 30%, and frame opaque. [`packages/web/public/office/pixi/furniture/SOURCE.md`; `packages/web/public/office/pixi/room/SOURCE.md`]
- **Gate before continuing:** compare the asset in the handoff layout at 1× and in a 2× crop, by day and night. Check pose and direction, every animation frame, clipping and baseline, object footprint and anchor, occlusion order, tile seams, room regions, glass gaps and transparency. Use guide overlays for anchors and footprints. Run `pnpm --filter @overseer/web test -- src/office/pixi/assets.test.ts` for manifest keys and packing, compare cell margins and baseline with `characters/SOURCE.md`, and run `pnpm --filter @overseer/web run test:office-critic-capture` to catch characters drawn from the `charCanvas` placeholder. Judge the asset itself as well as the assembled scene; see art-round records for the first-board lesson.

## MCP only

These are MCP tools, not REST endpoints. Call the configured tools directly. If they are unavailable, report that PixelLab MCP is not configured; do not use `curl` against the v2 REST API as a substitute. The v2 API is a separate interface.
