# Office pixel-art crispness check

Read every `SOURCE.md` under `packages/web/public/office/pixi/` (`characters/`, `furniture/`, `props/`, `room/`). Narrow the search with this PowerShell command, then read every hit in context:

```powershell
Select-String -Path 'packages/web/public/office/pixi/*/SOURCE.md' -Pattern 'scaled|sampled|nearest'
```

Every recorded resize factor that is neither a whole number nor 1/whole number is a crispness finding naming the file, line and factor. Factors x2, x3, x0.5 and x0.25 pass; x0.932, 8/7, x1.1 and "x1.57 across the width" fail. A non-integer nearest-neighbour resample doubles or drops pixel rows and columns.

A resize recorded as a target size (for example, "scaled to 66 px tall") has the factor target size divided by source size. Work it out from the generation size on the same line or in its table and judge it the same way.

Historical inventory from 2026-09-28, not a substitute for checking current source records: `furniture/SOURCE.md` listed a desk at 8/7, orchestrator chair x1.1, monstera x0.932, snake plant x0.821, floor lamp x0.806, mesh chairs x0.8 and x0.82, and meeting table oak x1.57 / x1.18. `characters/SOURCE.md` listed the whole cast at 0.5694; every character was regenerated at 1:1 by 2026-09-28. The furniture assets were generated or drawn again at 1:1 on 2026-09-28 (`furniture/SOURCE.md`, "One pixel size"). Re-derive the list every round; a fixed file drops off it.
