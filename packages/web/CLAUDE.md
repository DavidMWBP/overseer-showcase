# packages/web

React UI; talks only to `/api` (types from `packages/shared`). Loaded when working under this directory. The root `CLAUDE.md` keeps commands, configuration and conventions; `packages/daemon/CLAUDE.md` describes the API behind each view; full behaviour is in the batches spec ("spec §" below).

## Commands

The shell rule, the jsdom test timeout and the browser install: root `CLAUDE.md` → Commands.

| Command | Purpose |
|---|---|
| `pnpm --filter @overseer/web test -- <pattern>` | vitest under jsdom (Pixi mocking: [Pixi modules and art](#pixi-modules-and-art)) |
| `pnpm --filter @overseer/web build` | `vite build` into `dist/` |
| `pnpm --filter @overseer/web typecheck` | the app and `test-only/` |
| `pnpm --filter @overseer/web test:<script>` | real-browser checks: [Layout tests](#layout-tests) |
| `pnpm --filter @overseer/web dev` | Vite alone on 5173; from a task use `pnpm --filter @overseer/web exec vite --port <free> --strictPort` instead |

## Map

- `src/App.tsx` — the shell: owns the board fetch, the socket, the view hash and the outage state every view reads. Every view is `#<view>` (`VIEWS` in `App.tsx`; `#needs` opens Office); with an id: `#board/<bead id>` keeps the open card, `#discussions/<id>` one discussion, `#evidence/<folder>` an evidence folder, `#plan/<id>` one plan (`#plan` is the plan list).
- `src/main.tsx` — entry; `src/api.ts` — the `/api` REST client (`api`, `ApiError`), the socket hook `useWs` and the cost and elapsed formatters; `src/test/` — vitest setup and shared fixtures (`setup.ts`, `fixtures.ts`, `phoneMedia.ts`, `viewportMedia.ts`, `fakeOfficeScene.ts`).
- `src/views/` — Board, Chat, Review (with `BatchReviewBlock.tsx` and `reviewState.ts`), BatchPane, TaskPane, Setup, Usage, Plan, PlanList, Programs, Discussions, Evidence, and `MascotSheet.tsx` with `MascotSheet.css` (one of the three `PHONE_QUERY` stylesheets).
- `src/office/` — Office, NeedsStrip, RoomProps, the DOM-free scene model (`officeModel.ts`, `sceneSim.ts`, `agentManager.ts`, `labelLayout.ts`) and the Pixi room in `office/pixi/` (see [Office](#office)).
- `src/styles.css` — the app stylesheet, with the `PHONE_QUERY`/`DESKTOP_QUERY` blocks and the shimmer rules; `office.css` and `MascotSheet.css` sit beside their components.
- `src/components/` — Rail, Mascot, Activity, Card, BatchRow, Trace, Diff, UsageChart, BrowseDialog, Toasts, PlainText, Loading, PushSettings, AttachmentPicker and the Setup forms. `RepoForm.tsx` edits the optional repository model filter with harness, account and model checkboxes and a remaining-candidate preview; clearing all selections restores global worker routing. Missing models and deleted accounts stay visible until removed, failed loads retain saved selections, and a failed save keeps the form open. `Setup.tsx` shows the saved filter summary; critics keep global routing. `src/office/components/` holds `LabelLayer` and `BadgeLayer`.
- `src/lib/` — helpers: `phoneLayout.ts`, `toasts.ts`, `actions.ts`, `jobs.ts`, `mascotFor.ts`, `needsYou.ts`, `planEdit.ts`, `usage.ts`, `evidence.ts` (`#evidence/<folder>` parsing, `<evidence-root>`), and `useFaviconBadge.ts`, which mirrors the needs-you count in the tab title and on the favicon (`9+` past 9).
- `scripts/compose-office-room.mjs` — rebuilds the static Office room PNGs from the PixelLab pieces (`node packages/web/scripts/compose-office-room.mjs [--raw <dir>] [--layout 2]`; see `public/office/pixi/room/SOURCE.md`).
- `test-only/` — fixtures and scripts for the browser layout tests ([Layout tests](#layout-tests)); typechecked by `pnpm typecheck` but not part of the app build.
- A view is handed the unloaded state (`null`) for a list it fetches, never an empty array, so it can tell loading from empty.

## Phone layout

- One condition: 767 px wide or less, or a touch screen (coarse primary pointer) 500 px tall or less, such as a phone in landscape. It is `PHONE_QUERY` in `lib/phoneLayout.ts`, with `usePhoneLayout` and `isPhoneLayout` for every JavaScript check, repeated in every `styles.css`, `office.css` and `MascotSheet.css` phone block. Every desktop block uses its exact complement `DESKTOP_QUERY` (a comma list, since Safari 16 does not read `not`).
- A mouse or trackpad keeps switching at 767/768 px; a resize or rotation across the condition switches without a reload.
- The rail becomes a bottom tab bar plus a two-row header (repo chips, one status line). A tab's count badge overlaps its label's top-right corner instead of sitting beside it.
- Office is the default and first phone tab. Review's badge counts batches ready for the user (in review, no `waiting_on`, in a user-approved repo); its tooltip and accessible name include the waiting count when nonzero, while the visible badge stays at the ready count.
- Evidence, Usage and Discussions are desktop-only (the tab bar is full at five tabs); phones reach them from Setup → General (an "Open usage" button and inline Evidence and Discussions links), and `#usage` works directly.
- A view switch scrolls `main` to the top; the Board and Review detail panes are full-screen sheets.
- Check phone layouts with a 390 px Playwright screenshot before calling them done: `playwright-cli` (the `.claude/skills/playwright-cli` skill) against `pnpm --filter @overseer/web exec vite --port <free> --strictPort`, or the matching [layout test](#layout-tests).

## Background actions and toasts

- `lib/actions.ts` names each action, the word its button reads while it runs, and its toast wording. `lib/toasts.ts` is the module-level toast store `App.tsx` fills from the `action_result` socket message.
- The eleven background actions show their pending state on the pressed button (the target's other buttons off) from the click until the job ends. `lib/jobs.ts` holds each target until its `action_result`, which `App.tsx` routes to it, or until a board requested after the 202 or 409 whose row no longer carries the job.
- Panes, the Board card and batch row, and Review's list and header badges read a row's `pending_action` through `useRunningJob` (`useRunningJobs` for a list). A row still naming a job whose result has arrived keeps no button pending and shows no badge; a newer job id still does. The `pending_action` badge on the Board card, the batch row and Review's list and header survives a reload.
- A second request answers 409 `{ error, job_id, action }`: the toast names the running action and the target stays pending under that action. (The daemon also refuses a second terminal batch action: `packages/daemon/CLAUDE.md` → REST API and socket.) Any other refusal restores the buttons and toasts why.
- Review's Merge, v1 Merge and Abandon replace their action row with an in-pane question (confirm, cancel, Escape); Cancel restores the note and attachment.
- Review closes the pane on the 202 with an accepted line ("Merging batch …"), which the result replaces with the outcome or removes on a failure. The rejection note stays in its draft until the rejection succeeds. The Office batch drawer stays open and shows the accepted and outcome lines beside the updated status.
- `components/Toasts.tsx` is the stack in a bottom corner: a success dismisses itself, a failure stays until dismissed and carries the daemon's message; its 44 px close target stays at the top-right beside wrapping text.

## Rail and mascot

- `lib/mascotFor.ts` maps activity, context and connection status to mascot state and energy for `components/Rail.tsx`.
- `components/Mascot.tsx` draws Me-1 from the pixel-art sheet (64 px full body, 32 px bust), with its SVG as the load fallback.

## Needs strip

- `lib/needsYou.ts` is the one definition of what is blocked on the user: `needsUser` (which the Board also imports for its "failed first" sort), batches in review that are not `waiting_on`, unanswered questions, a `plan` kind ordered first (nothing runs for that request while it waits) and a `repo` kind ordered after `plan` for a repo whose `verify_suspect` is set.
- `office/NeedsStrip.tsx` lists them above the default Office room: the readable title as the headline, the id, repo and state on a second line. Every line is clipped, never wrapped (a batch title is a sentence, and wrapping one pushed the row past the viewport at 390 px).
- A row is a router to the pane that already exists, never a second copy: a question row focuses the matching answer box once when selected, then preserves focus during paging and auto-advance (keeping Office open when Chat is docked, otherwise switching to Chat); a batch row opens its review details and actions in a drawer over Office; a `repo` row opens Setup → repositories.
- At most 3 item rows in the phone layout (`usePhoneLayout`) and 6 otherwise, then a `+N more` button row (`.needs-more`, not a `.needs-row`, so the Plans row and the cap leave it out) that expands the list in place and reads Show fewer at its end. The expanded state is local and collapses while the strip is hidden (its `active` prop) or on a reload.
- A top Plans row shows the draft count only and opens `PlanList`, so draft, approved and discarded plans are all reachable without browser history.

## Office

`office/Office.tsx` renders `office/pixi/OfficeStage.tsx` and keeps the needs strip, the dock rule, the task pane and the orchestrator click itself. The room is the Pixi one; there is no renderer setting. The retired per-browser choice (`LEGACY_OFFICE_RENDERER_KEY`, `overseer.officeRenderer` in localStorage) is removed once on load, so a stored `classic` or `pixi` changes nothing.

### Scene model and sessions

- One pixel-art character per running session from the `office` feed. `officeModel.ts` (`deriveScene`) and `SceneSim.step` are the DOM-free scene source; Office and `LabelLayer` read the same frame.
- Desks: the orchestrator has its own; a critic takes the first free meeting-table seat (`review-1` to `review-4`) and is drawn distinctly; workers never sit at the meeting table. Everyone else, and a critic once all four seats are taken, takes the first free of the 12 pod desks, then `qa-1`, `qa-2`, then the standing spots `coffee`, `fridge`, `sofa`, then the 20 standing `row-*` spots of zone `row` in five rows along the two back walls (`BACK_ROW` in `office/pixi/world.ts`, each row filled towards the corner, placed so the initial desktop view shows every head; bound in spec § UI). A character past `row-20` shares it. A character at a standing spot stands, never types (`SEATS` in `office/pixi/characters.ts`).
- Arrival changes only the local pose: a `walking_in` character stays neutral at its desk until the feed reports `working`, which alone shows the typing effect. Arrivals fade in over 400 ms; departures fade across the last 1.2 tiles.
- The empty-room note shows only once a snapshot has arrived and named no sessions (the set is `null` until then, so an unloaded office is not called empty).
- The room stays mounted while another view shows (hidden, loop paused), so desks and characters survive the switch: a return shows a seated character at its desk with no walk-in replay, a session that ended while away walks out then, and one that started walks in.
- While the socket is lost and until the snapshot after a reconnect arrives (`App.tsx`'s `officeStale`, so the held set is never read as current in that gap), the last-known room stays dimmed at 50% opacity with frozen frames and an "Activity unavailable, reconnecting" note; it is then rebuilt from that snapshot, so a gone session walks out and a new one walks in.
- A stalled session is drawn with a clock effect and a dimmed sprite (its assigned desk dims too); its tooltip and accessible name read `stalled since HH:MM` (the mark the stall sweep sets, cleared by the session's next event).
- The loop pauses while the tab is hidden, another view shows or the socket is lost; `prefers-reduced-motion` gives static poses.

### Labels, badges and clicks

- Desktop: a `harness · model · bead id` label per character in one overlay layer above the room, with a leader line to its character. The model is the id the CLI resolved once it reports one, otherwise the configured one; the segment is left out when neither is known. `labelLayout.ts` keeps every label unambiguous and whole at any desktop width (no overlap, no crossed leaders, no covered feet; rules in spec § UI).
- Phone: `OfficeStage`'s `badgeRepoOrder` swaps `LabelLayer` for `office/components/BadgeLayer.tsx`: one `BADGE_SIZE` badge per character anchored `BADGE_LIFT` above the feet, over the head and the bubble, laid out by `layoutLabels` with a fixed size and the `overhead` side (below only when nothing above is free).
- Capture option: `?capture=1` in the page URL (`captureMode` in `office/config.ts`, passed as `OfficeStage`'s `nameTags={false}`) draws neither `LabelLayer` nor `BadgeLayer`, for stills; bubbles, stall marks, `BadgeKey` and the character buttons' names are unchanged.
- `badges.ts` holds the fill per repository in `board.repos` order (`REPO_PALETTE`, blue then green), the `CL`/`CX`/`OC` harness marks, the critic ring, the gold orchestrator pill, the grey `?` for an unknown harness or repository, and the contrast ratios.
- A phone tap on a character or badge opens `PhoneBadges.tsx`'s `AgentCard`: one at a time; closed by an outside tap, its close button or Escape, returning focus to its character button; a tap on another character switches the card and its focus-return target; when the session leaves, the card closes and focus returns to the room stage. Its link runs Office's desktop opener, `openTarget`.
- `BadgeKey` under the room names the orchestrator's gold pill (first, while a present orchestrator's badge is gold), the present repositories and harnesses, plus the grey `?` when one is shown, and wraps onto more lines instead of scrolling sideways.
- The phone character button name is `characterName`'s phone form: harness, model, `task <id|none>`, `repository <name|none>` and the role for a non-worker.
- A click on a character opens the task's side pane over the room (the same `views/TaskPane.tsx` the Board renders) without leaving the view; closing it returns focus to the character button, or to the room stage if its session has ended.
- A click on the orchestrator (no task) closes any open side pane, focuses the docked Chat composer and scrolls its thread to latest while the dock is visible, and otherwise opens Chat; the tooltip and accessible name say so.

### Room, lighting and props

Behaviour in full (night hours and fades, which lights exist, every count animation, milestone timing, reading-folder page turns): spec § UI. What the code needs you to know:

- Lighting: `office/Office.tsx` hands the night share to the Pixi stage, which stacks its own day room and night windows and takes one dark, near-neutral night colour matrix (`sceneColorMatrix` in `lights.ts`) at that share, so the lamps do the lighting. `lightingAt(date)` reads local time; `SceneSim.nightShare` uses an injectable `sceneClock`; lighting refreshes once a minute only while the tab and Office view are visible.
- `lights.ts`: one shared smooth radial texture, three room masks, and `LIGHT_PROFILES` whose every `dayAlpha` is 0 (nothing lit by day), fading linearly with the night share to its `nightAlpha`. A multiply floor grade over the QA corner and meeting room floors (`FLOOR_GRADE`, under the furniture, off by day and rising linearly with the night share) brings their lighter floors to the main carpet's tone, so the three rooms share one night base. Each ceiling lamp and floor lamp throws a warm floor pool (`LAMP_POOL_COLOR`, the QA corner's lamp included): a floor lamp against the right wall onto the open floor in front of it, the one in the corner with the meeting room glass further along the glass, and the pendant over the meeting table past the table's glass-side edge. Glass-room pools use smaller, lower-alpha profiles, and the pendant bulbs are drawn unlit grey by day, the night overlay supplying the warm bulb.
- Screens (`furniture.ts`): a front-row `monitor-front` and each `qa-desk` show their `-off` file (black) until a character has arrived at the seat (`isSeated`: pose `arrived` at its own desk position, in any state); `monitor-back` and the orchestrator's `monitors-orch` show monitor backs and have no `-off` file. A screen glow and its `-lit` overlay need the working or verifying agent arrived at its seat; the overlay's alpha is `SCREEN_OVERLAY_ALPHA` (0.6) of the night share, so its rim reads as a soft edge, and the orchestrator's glow sits on its desk, clear of the question note.
- The PixelLab `-lit` overlays sort just after their base piece and stay out of the colour matrix, which each run of furniture and characters between them takes.
- The QA wall screen loops its tests-running frames only during verification (`SceneFrame.props.verifying`).
- Counts are room objects, never pills: Pixi sprites in `office/pixi/roomProps.ts` (art in `public/office/pixi/props/`), depth-sorted with the furniture and taking the same colour matrix; past 99 a count reads `99+`. Questions is a note on the orchestrator's monitor edge; Board is the six-column whiteboard on the right wall in the Board's order and colours, hung at `BOARD_AT` = p(6.95, 0, 2.05) just left of the door (i 9.92..11.92, `ENTRY` x 10.9), the lowest it hangs whole above the baseboard, so every header and count is inside the 1280 x 800 first view; its header counts are 15 px marker digits sheared onto the wall like the column labels. The whiteboard's Done column counts only tasks closed since local midnight and is labelled Done today, while the Board keeps every done task. Returning to a visible tab recalculates the local day boundary.
- In review counts every Board batch in review in every repository, including a batch `waiting_on` another and one the orchestrator approves, which the Review tab badge leaves out; each folder seat is keyed by repository and batch id.
- A count its data has not delivered (`null`, only while Office shows; 0 again once that fetch fails) shows no digit anywhere: no note, no folder, a bare whiteboard, object buttons reading `questions loading` / `columns loading`, phone count buttons shimmering. Questions wait on the chat page; In review and the whiteboard on `/board` alone.
- Desktop object buttons (`office/RoomProps.tsx`, `RoomPropButtons`): one transparent button per object in the order Questions, In review, Board, named `Open Chat, N questions`, `Open Review, N batches in review` and `Open Board, Ready: N, …` with each Office column and its current label, including Done today; focus ring; hit area of at least 24 CSS px (44 on a coarse pointer). The hover/focus chip is placed by `chipPlacement`: centred `CHIP_GAP` below the part of its object the stage shows (for the sheared whiteboard, `ROOM_PROP_SHEAR`, below its lowest visible point), or above when the stage ends first, held `CHIP_MARGIN` inside the stage from the chip's measured size, so it follows a pan and a resize. The chip is `visibility: hidden`, not `display: none`, so it can be measured.
- Phone: `OfficeCountRow` replaces the object buttons with one line of 44 px buttons under the room, with the same names and destinations.
- Milestones never change counts or labels. The In review folders glow green for three seconds; Pixi badges the matching bead character, greys and tilts it on verification failure, walks the passing bead to the board and hops it there on pass, and after a merge drops 90 confetti pieces (`CONFETTI_COUNT`) while all characters hop in order and face the board. Snapshots carry no milestones; hidden views and reconnects never replay them. Reduced motion omits hops and confetti, shows only each room-object change's end state, and turns the folder glow into a static tint.
- Reading folders: a character seated and arrived at a meeting-table seat reads an open manila folder drawn in code (`office/pixi/readingFolders.ts`), still under reduced motion and on frozen frames.
- Bubbles use atlas glyphs 112 px above the feet: `test`, `✎`, `z z` and `★`; the `?`, `!` and `✓` badges take precedence. Rain is omitted because the live Office has no weather source.

### Touch targets and hover

- On a coarse pointer every character's Pixi hit area and button (`characterTarget` in `office/pixi/characters.ts`; a fine pointer keeps `HIT_AREA`), every phone badge (a transparent `.office-badge-target` span, `badgeTarget`) and every object's hit area cover at least 44 × 44 CSS px about the same centre, cut to the part of the world the stage shows and grown back inward (`fitInside` in `office/touchTarget.ts`, `visibleWorld` in `office/pixi/viewport.ts`, refitted on every pan and resize), so a target at the stage's edge is whole and unclipped.
- A tap inside several characters' targets opens the one whose target centre is nearest (`nearestCharacter`); a badge tap weighs the nearest badge centre against the character targets it covers (`nearestBadge`, `badgeTapTarget`). A character takes the tap from an object behind it; empty floor opens nothing.
- Desktop: the canvas cursor is a pointer over a character or object a tap opens (Pixi's `cursor` on its hit area), and that hover target draws brighter through `HOVER_MATRIX` (`office/pixi/scene.ts`, the canvas's `data-office-hover`); a character in front of an object takes the hover as it takes the tap. A drag pan holds it (`OfficeScene.setPanning`), a character that leaves the room drops it, and a touch pointer and the phone layout never hover.

### Camera and scale

Formulas and initial-view priorities: spec § UI. The invariants to keep when editing `office/pixi/viewport.ts` and the stage:

- The measured 1680:1056 stage box is fixed and the room pans inside it; whatever does not fit is reached by dragging. Dimming and reconnecting cover the visible box. The camera goes by width alone, so a touch screen in the landscape phone layout takes the desktop rule.
- Desktop band (768 px and up): whole device-pixel scales only (k device pixels per art pixel, CSS scale k / dpr), never below one device pixel per art pixel and no fractional fit fallback. Its fit keeps the question note, folders, whiteboard and whole meeting table (`TABLE_BOX`) 8 px inside the box; at 1280 x 800 they do not fit, and the highest view the folders allow still shows the whole whiteboard, just inside its top edge.
- Phone band (below 768 px): the older formula k = max(1, round(stageWidthCss / 1680 × dpr)), zoomed out to fit those four objects when needed, with the initial view centred on p(6, H / 2) on overflowing axes.
- Resize keeps the world point at the box centre while that axis still overflows and the edges allow it, with the same zoom and shift; a pan is not shifted.
- Transformed vertices round to the device-pixel grid, and every texture uses a whole-number device-pixel scale except while the phone band zooms out.
- The night colour matrix and the hover highlight render at the canvas's resolution (`resolution: 'inherit'`), since a filter's default of 1 blurs every filtered sprite at dpr 2. At a whole-number dpr the canvas is also sized in whole CSS pixels (`canvasSize` in `office/pixi/viewport.ts`, the stage clipping the extra fraction), since Chromium resamples a canvas with a fractional CSS size (899.5 at dpr 2) and blends every art pixel's edge; `test:office-pixi-layout` checks it at 1280x800 dpr 2.

### Chat dock and outage

- On wide desktop screens Chat docks to the right of the room once the stage is at least 640 CSS px wide (`CHAT_DOCK_MIN_STAGE` in `Office.tsx`) and the measured content width is at least 380 px wider than it. The dock stays mounted beneath the fixed TaskPane, which overlays Chat without changing stage width.
- With the outage banner shown, `main` gives Office the remaining height, Office measures that height for its stage cap, and docked Chat fills the same Office box; the online stage size is unchanged.

### Pixi modules and art

- `office/pixi/`:
  - `world.ts`: projection, the layout-2 `FURN` and `SPOTS` (desk pods, the orchestrator's desk on the front middle of the work floor (i 7.4..9.4, j 10.9..11.9, clear of the i = 12 glass and the lounge wood at i < 5.5, a monstera at its front-left), the QA corner as zone `lab`, the meeting room as zone `review`, the kitchen and lounge) and the quarter-tile walk grid.
  - `OfficeStage.tsx`: stage shell (Pixi canvas, dim overlay, one transparent button per character for the name and keyboard, `LabelLayer` with `prefer="below"`, Office's props).
  - `scene.ts`: the `Application` (created and destroyed with the stage), room and night-window textures, the shared colour matrix, lighting filters and layer order. Entities split at each shown `-lit` overlay into runs that each take the matrix, so an overlay draws unfiltered but still behind a character in front of its piece.
  - `room.ts`: the generated room fallback, painted to data URLs when the PixelLab background files fail.
  - `furniture.ts`: depth-keyed furniture, pod dividers, the monitor each seat looks at, the QA wall screen and its states, glass and chairs; the glass partitions and door posts stand `GLASS_H` = 2.3 units, not 3.2, with 10% panes and 30% reflections baked by `scripts/compose-office-room.mjs`, so they no longer streak over the QA corner and the pods behind them. `lights.ts`: see Room, lighting and props.
  - `effects.ts`: glyph-atlas bubbles, milestone badges, `qaScreenState`, confetti and hop timing.
  - `characters.ts`: pose, frames, the seated typist's lean by seat `TYPING_LEAN` (the typing forearms reach the rest of the way to the keyboard), the hit area `HIT_AREA` (made a `Rectangle` on the root).
  - `assets.ts`: PixelLab character, furniture, room, night-window and glass textures with nearest sampling; per-character `charCanvas` and per-piece Graphics fallbacks; bubble glyphs packed into the generated atlas. `draw.ts`: shape lists painted to a canvas or Pixi Graphics.
- Missing character keys fall back to `charCanvas` for that character (`OfficeArt.fromAtlas` is false for it, and the canvas's `data-office-character-art` reads `placeholder`); missing furniture or glass textures keep that piece's Graphics fallback.
- When Pixi cannot start (`createScene` rejects, as under jsdom), the stage logs `office pixi` with the error and shows its empty dark box with the character buttons, labels and props. Unit tests mock `./pixi/scene` or `pixi.js` (`src/test/fakeOfficeScene.ts` for the App tests).
- Ported from Claude-Office under MIT (`src/office/LICENSE.txt`); none of its art ships. The shared, DOM-free parts are `officeModel.ts`, `sceneSim.ts`, `agentManager.ts` (seating and walking on the Pixi world), `config.ts`, `labelLayout.ts`, `office/components/LabelLayer.tsx` and `office.css`.
- Art lives under `public/office/pixi/`; `characters/SOURCE.md`, `furniture/SOURCE.md` and `room/SOURCE.md` record sources and placements. See `.claude/skills/pixellab/SKILL.md` for PixelLab generation, fitting and sidecar rules. `.claude/skills/office-critic/SKILL.md` (`/office-critic [area]`, `/office-critic fix [threshold] [max-rounds]`) critiques the `test:office-critic-capture` captures in a fresh foreground subagent against the lighting, layout, crispness, consistency and phone rubric and ends with `OFFICE-CRITIC score=<n> must=<a> should=<b> nit=<c>`, so a task can gate on it.

## Board

- `App.tsx` allows one `/api/board` request at a time. Triggers during it coalesce into one trailing request and retain a fresh trigger; the trailing request starts after success or failure. Answers apply in request order unless a newer answer has already landed, and each applied answer still runs `boardLoaded` and `settle`. `REFRESH_NOTE_MS` (400 ms) still controls the Board's "refreshing…" note.
- A Board row is a router too: it opens the bead's card or the batch in Review, where the actions and the diff already live.
- Card and pane actions follow `BoardCard.state` (root `CLAUDE.md` → Conventions).
- First-response placeholder (sizes and measured deltas in spec § Board speed): a fixed activity footprint for its empty and one-running-row states, the repository header, two live batch rows, the collapsed finished-batches disclosure, phone tabs and two cards per column. Both lines of a batch row wrap, so row height is a line count: the placeholder's title and branch copy the worst-case lengths a batch carries and break the same way, so a settled column only grows for cards or rows nobody could know before the response. A shorter real title is over-reserved, the unavoidable direction for a fixed placeholder.
- The card pane's placeholder is built from the card: `session_id` decides whether the last assistant text is reserved, and `verify_block` (`none`/`label`/`output`, which the daemon reads from the worktree's recorded verify output, since no card state predicts it — a failure survives a re-dispatch and a won't-do close never ran one) decides whether the verification heading and output are.

## Chat

- Multiple open questions page one at a time, oldest first, at every width (desktop too, since several questions' controls cannot fit the cap). The pinned question card is capped at 40% of the visible height (the visual viewport while the iOS keyboard is up, when the tab bar also hides through `.app:has(.chat-visual-viewport)`); only the line-break-keeping question text (a focusable "Question text" region) shrinks and scrolls. Chat re-measures on visibility return, pageshow, window resize and composer focusout, cancelling suspended frames so a dismissed keyboard restores the tab bar.
- The composer offers repo/global slash-command suggestions by name or description only while its textarea is focused, including after a restored slash draft. Escape dismisses the list before an open side pane.
- The composer records open question IDs on the first keystroke (or the first attachment for an attachment-only draft) and the send clears only those still pending; a question arriving mid-draft stays pinned with its answer box; clearing the empty draft resets the snapshot. `POST /api/chat` returns after storing the message and attachments; user-message deliveries continue serially after the response. The composer (`views/Chat.tsx` `send`) frees as soon as that POST replies; the refetch that shows the row is not awaited.
- Each tracked user message shows Waiting, Seen or Answered beside its time. A queued row is Waiting; an older null row before the first seen user row has no status. Chat refresh updates the labels without another poll.
- A message whose delivery failed shows a Retry button linked to the user message and to the failure row in the daemon's chat table; accepting Retry hides the button for good and requeues the message through the delivery queue after a daemon restart.
- Outcome chips under messages come from the board's `linked_chat_ids` and follow the existing board refresh. A chip (in Chat and the Office dock) opens a board-backed batch panel without changing the view, hash or history: task rows open `TaskPane` inside it, Back to batch returns, and review batches show the shared summary and actions while keeping Open in Review. The Needs batch row opens the same panel over Office. Switching views closes it.

## Review

- The left list puts **Ready for you** before **Waiting** and **Handled by orchestrator**, then **In progress** and **Finished**. Ready for you uses the Review badge's actionable-batch rule; Waiting lists review batches with `waiting_on` and hides itself when empty. Waiting rows are muted and carry a chip naming the blocker by title, or by id if it is absent from the board. Review batches without `waiting_on` whose effective approver is the orchestrator appear under Handled by orchestrator, so they stay visible without affecting the user-actionable badge. Empty groups are hidden; when there are no batches or review tasks, the existing empty state remains. After a blocker is merged, the next board refresh clears `waiting_on` and moves its released user-approved batch to Ready for you.
- `components/PlainText.tsx` strips markdown markers, renders inline code as `<code>` and every piece as a text node; Review opts into safe, scrollable markdown tables for its three notes.
- See [Background actions and toasts](#background-actions-and-toasts) for Merge, Reject and Abandon.

## Discussions

- Accepts up to four question images through the shared attachment picker, keeps them on a failed start, and shows linked thumbnails in the thread.

## Plans

- `views/Plan.tsx` is the `#plan/<id>` page a `plan` row or list row opens. Titles and descriptions read as prose until clicked or their Edit control is used, then save on leaving the field; step titles edit directly; a dependency toggle, a move, a remove or an added step saves at once. The content scrolls independently above a normal-flow footer holding Approve and Discard.
- Saves run in a chain, one at a time, each carrying the revision the previous one returned, and adopt the daemon's cleaned draft (titles trimmed, dependencies sorted and de-duplicated) unless the user has typed since; a stale save answers 409 and keeps the typed text.
- `views/PlanList.tsx` is `#plan`: every plan (`GET /api/plans/all`), newest first, each row naming title, status and step count.
- `views/Programs.tsx` sits below it on `#plan`: each open program's lanes and batch cards (a card opens the batch panel), merge order and entries. It fetches itself and refetches on the `version` App passes (`boardVersion + chatVersion`), never on a timer; every text breaks anywhere, and `test:programs-layout` checks it at 390, 767, 768 and 1280 px.
- Opening a plan from the list or a per-plan strip row pushes `#plan/<id>`; detail Back consumes that entry and returns to the opener, while a cold `#plan/<id>` link falls back to Office.
- `lib/planEdit.ts` holds the pure step edits — add, remove, reorder, `toggleDep` — including `moveStep`, which refuses an adjacent move when either step depends on the other.

## Usage

- `views/Usage.tsx` renders `GET /api/usage`: a range picker (7/30/90 days, 30 default), summary cards, the restart-gap and codex base-context-tier limits as two lines beside them, a stacked bar chart of cost per day by model (`components/UsageChart.tsx`, hand-drawn SVG, series colours `--chart-1..6`, a seventh model folded into "Other") with a switch between reported cost, estimated cost and tokens, and sortable breakdowns by model, account, harness and repo. `lib/usage.ts` holds the pure parts (range, cost wording, sort, stacking).
- The two cost sums are never added: an unpriced bucket reads "unknown", a partly priced one is a floor with its count, and every estimate wears an `est.` marker whose tooltip carries the codex caveat only where `codex_sessions` is above zero.

## Evidence

- `views/Evidence.tsx` renders folder summaries from `GET /api/evidence` in API order, with local newest times, and requests file metadata only after a folder opens. It shows 100 files per page and loads later pages on request. If a later page reports a different total or overlaps the rows already shown, it reloads from offset zero before appending, so additions or removals do not duplicate or skip files. It shows linked image thumbnails, video players, HTML and text links, and downloads for other files. Direct root files use the Evidence root label; `#evidence/<folder>` opens a folder directly.

## Loading placeholders

Which blocks shimmer and each placeholder's exact shape: spec § Board speed. The rules the code enforces:

- `components/Loading.tsx` is the one wrapper around `@shimmer-from-structure/react`: views use `<Loading loading placeholder={...}>` and never import the library. It hides the library's measuring copy (`.shimmer-measure-container` in `styles.css`), paints with `--line` (base) and `--muted` (wave), stops under `prefers-reduced-motion`, and while loading sets `aria-busy` and announces its `label` prop (default "Loading…") in a `role="status"` element, so a placeholder inside a live region such as the Chat thread is `aria-hidden`.
- The library measures the rendered DOM and skips zero-sized elements, so `placeholder` must render the arrived shape: real content that is still empty measures nothing and leaves the blank it exists to remove.
- Only the first fetch shimmers; a failed refetch keeps what is shown, under the warning line. A view stops passing `loading` once its first fetch has failed (invented content for a whole outage is worse than the blank): `App.tsx` keeps `failedPaths` (cleared per path on the next success) and stops passing `loading` to NeedsStrip, PlanList, Review, BatchPane, Setup and the Rail once `offline` or a path that view waits on is among them. Plan's own load error returns before the shimmer; Setup's daemon section gates on its own fetch error.
- Evidence uses the folder or file placeholder for its first request. After the first file page appears, later pages keep the grid visible and show their loading state on the **Load more files** button.
- A list whose arrived length is unknown gets a fixed-size placeholder (two cards per board column, four collapsed Trace rows, two PlanList rows, two Plan steps, two one-row sections in Review's list; the Rail's repo-chip cost shimmers too); a placeholder that sits in one shimmer wrapper loses the gap its arrived siblings get from their parent, so it carries it itself (`.account-rows-placeholder`).
- The Office strip placeholder is sized from `overseer.officeStripRows` in localStorage (written by `App.tsx` once board, chat, plans and repos have all loaded; default 1, 0 allowed; the uncapped count is stored and capped like the arrived strip, adding the `+N more` row's shape over the cap). Its Plans row is drawn as icon, title and sub line, not the solid bar the library paints a button as. `test:office-strip-layout` measures it against the arrived rows.
- Setup's Repositories heading and Add button stay outside the shimmer (the button disabled while `repos` is null), so the heading does not grow when the list lands; the restart-needed banner is an exception state and is not reserved.
- `components/PushSettings.tsx` is deliberately left alone: its height does not change when its data lands.

## Layout tests

- jsdom reports 0 for every layout value, so scroll or geometry logic needs a real-browser check.
- Every script except `test:office-pixi-layout` starts its own in-process Vite server (never 4400, 5173 or 5174) and exits when done. `test:chat-layout`, `test:office-chat-dock`, `test:office-offline` and `test:office-strip-layout` bind fixed ports 5291, 5293, 5294 and 5297 (`strictPort`), and `test:office-critic-capture` binds 5298, so don't run the same one from two worktrees at once; the others use port 0.
- `test:office-pixi-layout` needs a Vite server of this worktree already running on a free port, named in `OFFICE_PIXI_LAYOUT_BASE_URL`, and refuses 4400, 5173 and 5174. In a worker, start it with `start_server`, never in your shell; interactively, `pnpm --filter @overseer/web exec vite --port <free> --strictPort` in another terminal.
- Install the browsers once with the command in root `CLAUDE.md` → Commands (WebKit is needed by `test:chat-layout`); Playwright is a web-package dependency, so a bare `pnpm exec playwright` at the root is not found. Then run from the repo root:

| Command | Checks |
|---|---|
| `pnpm --filter @overseer/web test:discussions-layout` | the discussions layout at six widths (360, 390, 600, 767, 768, 900 px) |
| `pnpm --filter @overseer/web test:office-strip-layout` | every Office strip placeholder row against its arrived row within 2 px at 390, 768, 1280 and 1920 px with 0, 1, 3 and 7 items (7 is over both caps, so `+N more` and its placeholder are measured too), plus the props' digit-free loading state |
| `pnpm --filter @overseer/web test:review-table-layout` | a wide Review table scrolls inside its container at 360 px without page overflow |
| `pnpm --filter @overseer/web test:programs-layout` | the Programs section with long unbroken titles, lane name, wait badge and decision: no sideways scroll at 390, 767, 768 and 1280 px, one lane column at 390 |
| `pnpm --filter @overseer/web test:toast-layout` | toast card, wrapping text and the 44 px close button at 360 and 390 px |
| `pnpm --filter @overseer/web test:chat-layout` | see below |
| `pnpm --filter @overseer/web test:office-chat-dock` | the Chat dock beside the Pixi room |
| `pnpm --filter @overseer/web test:office-offline` | the dimmed, frozen room while offline |
| `pnpm --filter @overseer/web test:office-pixi-layout` | the Pixi room layout; pre-stores the retired `classic` renderer value |
| `pnpm --filter @overseer/web test:office-critic-capture [out dir]` | writes the room at 1280x800 and 390x844, 12:00 and 23:00, dpr 1 and 2, plus 4x nearest-neighbour object crops, to a temp folder outside the repository (`test-only/office-critic-capture.playwright.js`), waiting on the canvas's `data-office-night-share` rather than a sleep; it asserts nothing about the art except that every character draws from the atlas (the canvas's `data-office-character-art`, `<agent id>=<char>/<anim>/<view>:atlas|placeholder`) and fails on a `charCanvas` placeholder |

`test:chat-layout` covers, in WebKit at dpr 3 and Chromium: banner, scroll and Jump to latest placement; the reading position across a view change; hint and repository target layouts; an emulated visual-viewport keyboard in WebKit; the pinned question card's 40% cap, overflow, pager and controls at phone, breakpoint and desktop sizes and under that keyboard; and the tab bar hidden with the composer at the visual bottom. Each case's sizes and states are in `test-only/chat-layout.playwright.js`.

When a layout rule moves into CSS, keep a behaviour assertion paired with a stylesheet assertion, as `Setup.test.tsx` and `Rail.test.tsx` do.
