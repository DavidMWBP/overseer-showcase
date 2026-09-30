---
name: office-critic
description: Critique and score Office room pixel art from fresh captures, or loop fix-capture-critique until no findings. Use when asked to critique, grade, or gate its lighting, layout, crispness, consistency, or phone presentation, or on /office-critic. Not for generating or fitting art; use pixellab.
---

# Office critic

Grades the Office Pixi room the way a picky pixel-art reviewer would, from screenshots and the art's source records, and ends with one machine-readable line. It runs inside a headless Claude worker in a worktree, so every step stays in the foreground.

## Invocation

- `/office-critic [area]` — one critique round. Changes nothing, commits nothing.
- `/office-critic fix [threshold] [max-rounds] [area]` — the fix loop below. `threshold` defaults to 90, `max-rounds` to 5.
- `area` is an optional filter: `lighting`, `layout`, `crispness`, `consistency` or `phone`. With a filter, only that area's rubric is graded and only its findings count toward the gate, so a task can gate on its own area.
- `/loop /office-critic fix` also works: each loop firing runs one fix-mode invocation, and the loop stops once a round reports the gate met.

## One round

### a. Capture

Run in PowerShell on Windows (never Git Bash), from the repository root, with a new output folder outside the repository:

```powershell
$out = Join-Path $env:TEMP "office-critic\$(Get-Date -Format yyyyMMdd-HHmmss)"
pnpm --filter @overseer/web run test:office-critic-capture -- $out
```

Before choosing scenes or interpreting the manifest, read [the capture contract](references/capture-contract.md).

A non-zero exit is a failed round: report the error; do not critique stale captures. Open every PNG in the manifest with Read. Never cite a capture you have not viewed.

### b. Static crispness check

Read [the crispness checklist](references/crispness-check.md) and apply it to every `SOURCE.md` under `packages/web/public/office/pixi/` (`characters/`, `furniture/`, `props/`, `room/`). Report each failing factor with its file and line.

### c. Critique in a fresh subagent

The critique runs in a new subagent that did not make the change it grades. Start it with the Agent tool in the **foreground** (`run_in_background: false`; a headless worker ends its session when it starts a background subagent), `subagent_type: general-purpose`, on the session's model (critic work is never routed to a smaller model). Give it only:

1. the capture folder and the list of PNG paths, told to Read every one;
2. the static-check list from step b;
3. the rubric below, filtered to `area` when one was given;
4. the output format below.

Do not give it the diff, the task description, earlier rounds' findings or your own opinion. Relay its output verbatim.

### d. Output format

One line per finding, most severe first:

```
[must|should|nit] <area> — <what, where, naming the capture file> — fix: <suggested fix>
```

Then `Score: <0-100>` with one sentence on why, then as the last line exactly:

```
OFFICE-CRITIC score=<n> must=<a> should=<b> nit=<c>
```

`must` is a rubric point broken in a way a user sees at first glance; `should` is a visible flaw that does not break the point; `nit` is polish. With an `area` filter the counts cover that area only.

## Rubric

- **Lighting.** At night the three rooms (main floor, QA corner zone `lab`, meeting room zone `review`) share one base light, and none reads as daylight or as a separate colour filter. Every lit ceiling lamp and floor lamp puts a visible warm pool on the floor. Lit monitors appear only at occupied seats. By day every light is off (no halo, pool or screen glow; see the lighting paragraph in `CLAUDE.md`).
- **Layout.** No wall facing the camera hides a room's contents. The kanban whiteboard's counts are readable at 1280x800 without hovering. There is no large empty area at the front of the floor. Each piece reads as its purpose (the orchestrator's desk must not read as lounge furniture on the rug). Nothing important is cut off at the first view's edges.
- **Crispness.** No doubled or dropped pixel rows or columns in the 4x crops, and no smooth edges on pixel art except the light pools and glows. Every static-check factor from step b is a finding.
- **Consistency.** One art-pixel size across furniture, props, room and characters, one outline convention, and one palette and perspective.
- **Phone.** The same points at 390x844.

## Fix loop (`/office-critic fix`)

Repeat, starting at round 1:

1. Run one round (a–d). Record its last line.
2. Stop when `must=0`, `should=0` and `score >= threshold` (the gate), or when this was round `max-rounds`.
3. Fix the top findings: every `must` first, then `should` in listed order, as many as one round can carry. Art changes go through the `pixellab` skill (`.claude/skills/pixellab/SKILL.md`), including its sidecar `SOURCE.md` record; code changes follow `CLAUDE.md` and keep their tests. Commit each fix with explicit paths.
4. Go to 1 with new captures in a new folder and a new foreground critic subagent.

Report every round's last line, and at the end the findings still open and whether the gate was met. Fix mode never commits captures, crops or `manifest.json`; they stay in the temp folder. Critique mode (`/office-critic` without `fix`) edits and commits nothing.
