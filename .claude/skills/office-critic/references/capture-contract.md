# Office critic capture contract

The capture script (`packages/web/test-only/office-critic-capture.playwright.js`) starts its own Vite server on port 5298 (`strictPort`; it refuses 4400, 5173 and 5174) and opens the static fixture `test-only/office-chat-dock.html?items=3`. It starts no daemon and fakes only `/api`, so the PixelLab character atlas loads as in the app. The fixture has three questions, three folders in review, three notes per whiteboard column, one worker and the orchestrator.

The script sets the hour through `window.__officeChatDockSetHour`, then waits until the canvas reports that hour's `data-office-night-share`, every character button exists and the room props are drawn. It fails unless every character draws from the atlas (`data-office-character-art`), so the `charCanvas` placeholder is never graded. It runs under reduced motion so poses are settled.

Each `--scene=<name>` after the output folder adds a scene with that name as a file prefix: `orch-idle` (the orchestrator seated but not typing), `no-workers` (the orchestrator alone) and `workers-12` (every pod desk taken). With no scene option, it captures `default` alone.

It writes, for desktop 1280x800 and phone 390x844, at 12:00 (`day`) and 23:00 (`night`), at device scale 1 and 2:

- `<viewport>-<time>-dpr<n>.png`, the full page;
- `<viewport>-<time>-dpr<n>-crop-<object>-x4.png`, 4x nearest-neighbour crops of `worker-chair`, `plant`, `floor-lamp`, `glass-post`, `orchestrator-desk` and `character`, located by projecting the real layout (`world.ts`, `furniture.ts`) with the stage's camera and scale;
- `manifest.json`, listing the files and any crop skipped because its object is not in the first view. A skipped crop is itself a layout fact.

The script prints `Office critic captures in <outDir>`, then each written filename and any skipped crop.
