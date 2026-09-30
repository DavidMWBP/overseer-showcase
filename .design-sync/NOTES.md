# design-sync notes

- Since 2026-09-24 the sync is the converter's package shape with 11 prop-driven components from `packages/web/src/components` (Activity, AttachmentPicker, BatchRow, Card, Diff, Loading, Mascot, PlainText, Rail, Toasts, UsageChart). The styles-only sync before it (a hand-split `tokens/tokens.css` and a hand-made Tokens card) is retired and its files were deleted from the project.
- The web package has no library build, and the converter's synth-from-`src/` mode would export `main.tsx` (which mounts the whole app into every preview). `.design-sync/entry.ts` is the entry instead: it re-exports the 11 components plus `pushToast`, `dismissToast` and `useAttachments`, and imports `fonts.css` (the Google Fonts `@import`, which the app loads from `index.html`) and the app's `styles.css`, so `_ds_bundle.css` = fonts import + the whole app stylesheet, tokens included. `cfg.entry` makes the converter's package dir the repo root, so `srcDir`, `componentSrcMap` and `tsconfig` are repo-root-relative and `guidelinesGlob` is `[]` (the default `docs/*.md` picked up engineering docs).
- Prop contracts are hand-written in `cfg.dtsPropsFor`: there is no `.d.ts` tree to read (the `[DTS_REACT]` warning at build start comes from that empty tree and is harmless), and the props reference `@overseer/shared` types the design agent never sees, so the data shapes are inlined from `packages/shared/src/index.ts`.
- The card page is white (`body{background:#fff}` in the converter's emitter, not forkable); every preview wraps its story in a `var(--bg)` surface, because the app is dark-only and its text is unreadable on white.
- Rail needs `overrides.Rail.viewport` 900x900: its content is taller than the default 900x700 capture, which cut off New session.
- Render check: `.ds-sync/` needs `playwright@1.63.0` (the repo's pin, chromium-1243, cached in `%LOCALAPPDATA%\ms-playwright`). For a quick look at a single html outside the harness, headless system Chrome works; the ms-playwright Chromium binary launched directly hangs on the Google Fonts import and `playwright-cli` fails to start.
- App bug found by the header check: `packages/web/src/styles.css` line 175 opens `/* board` without closing it, which comments out the `.board-layout` rule in the app itself; the conventions header leaves the class out until that is fixed.
- Pages (one per rail view) live in a regular Claude Design project that uses this design system, not in it: the four stale `templates/` pages (Board, Chat, Review, Setup) were deleted on 2026-09-24. The DesignSync tool reaches design-system projects only, so a sync never writes pages.
- To prototype screens in Claude Design, paste screenshots of the running app (or a view's JSX) into the project chat; the synced components and CSS supply the look.

## Known render warns
- None as of 2026-09-24.

## Re-sync risks
- `dtsPropsFor` duplicates `BoardCard`, `BatchSummary`, `Repo`, `StatusResponse`, `CostsResponse`, `OrchestratorActivity` and the usage `Stacks` shape by hand; a field added in `packages/shared` does not reach the contracts until the matching body is edited. Diff those types against the config on every re-sync.
- A new component in `packages/web/src/components` is not synced until it is added to `entry.ts`, `componentSrcMap` and (for its props) `dtsPropsFor`. Components that fetch `/api` themselves (Trace, BrowseDialog, RepoForm, the Setup panels) were left out on purpose.
- Preview fixtures use relative times (`Date.now()`) in Rail and the pending-action chips; everything else is fixed data.
- Fonts come from Google Fonts at runtime (`[FONT_REMOTE]`); a design opened offline falls back to system fonts.
