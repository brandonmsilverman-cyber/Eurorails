# Cheapest/Shortest Foreign Track Consideration Logic

## Context

The "cheapest route" build pathfinder (`findPath()`) treats foreign track edges as completely blocked, forcing detours even when routing through opponent track would be cheaper. Players must mentally calculate whether using foreign track (paying 4M/opponent/turn during movement) is cheaper than building around it. This fix adds a toggle that lets the pathfinder consider foreign track as traversable during build planning, with the trackage rights fee displayed separately in the preview.

## Behavior Matrix

| | **Foreign track OFF (default)** | **Foreign track ON** |
|---|---|---|
| **Cheapest** | Current behavior. Foreign edges blocked. Finds cheapest self-sufficient route. | Foreign edges traversable at 0 build cost. Prefers foreign track over expensive terrain. Shows orange segments + trackage fee. |
| **Shortest** | Current behavior. Foreign edges blocked. Finds fewest-segment self-sufficient route. | Foreign edges traversable at weight 1 (same as any edge). Finds shortest total path, but foreign track is now passable instead of blocked. Acts as a shortcut, not free. |

Key difference: in **cheapest** mode, foreign edges are weight 0 (no build cost). In **shortest** mode, foreign edges are weight 1 (they're still a segment in the path, just not blocked). This prevents shortest mode from routing through long foreign detours to avoid building a single segment.

## Commit Sequence

### Commit 1: `findPath()` — add `allowForeignTrack` param + `foreignSegments` return

**Risk: Low** — default `false` preserves all existing behavior. Gated by existing snapshot tests.

**File: `shared/game-logic.js` — `findPath()` (line 1033)**

- New signature: `findPath(ctx, startId, endId, playerColor, mode, allowForeignTrack)`
- Default `allowForeignTrack` to `false`
- Always build a `foreignEdges` set from non-player tracks (lines 1040-1056)
- When `allowForeignTrack` is `false`: also add foreign edges to `blockedEdges` (current behavior)
- When `allowForeignTrack` is `true`: do NOT add to `blockedEdges`
- Edge weights when `allowForeignTrack` is `true`:
  - **Cheapest mode:** foreign edges get `realEdgeCost = 0`, `edgeWeight = 0`
  - **Shortest mode:** foreign edges get `realEdgeCost = 0`, `edgeWeight = 1`
  - Owned/new edges: unchanged
- After path reconstruction, identify foreign segments and return `{ path, cost, foreignSegments }`
- When `allowForeignTrack` is `false`, `foreignSegments` is always `[]`

**New tests (`test/snapshot.test.js` or new file):**
- `allowForeignTrack=false` produces identical results to existing snapshots
- `allowForeignTrack=true` + cheapest: path routes through foreign track, cost excludes foreign segments
- `allowForeignTrack=true` + shortest: foreign edges weight 1 (not 0), no wild detours
- `foreignSegments` array correctly identifies foreign edge indices
- All-foreign path returns cost 0 with all indices in `foreignSegments`

### Commit 2: UI toggle + state field

**Risk: Low** — UI-only, no logic wiring yet.

**File: `public/eurorails.html`**

- Add `useForeignTrackInBuild: false` to `gameState` (line ~1287, next to `useTrackageRights`)
- Add `toggleBuildForeignTrack()` function (near `setBuildPathMode()`, ~line 4262)
- Add "Use foreign track" toggle button near cheapest/shortest buttons (~line 4696), styled like the operate phase trackage rights toggle
- Reset `useForeignTrackInBuild` to `false` on phase transitions (alongside existing resets)

**Verification:** Visual — button appears in build phase, toggles state, resets on phase change.

### Commit 3: Wire toggle to hover preview + cost label

**Risk: Medium** — first user-visible behavior change in pathfinding.

**File: `public/eurorails.html`**

- **Hover preview (line 5668):** Pass `gameState.useForeignTrackInBuild` as 6th arg to `findPath()`. Set `gameState.pathPreviewForeignSegments = pathResult.foreignSegments || []`.
- **Partial-build cutoff (lines 5704-5744):** Treat foreign edges as 0 cost (skip like owned). Stop buildable cutoff at first foreign gap.
- **Cost label (lines 2712-2738):** Remove `gameState.phase === "operate"` gate on trackage fee computation (line 2714). Compute fee for build phase: distinct opponent colors in foreign segments × 4M. Display: `"5M build · 🚂4M/turn rent"`.

**Verification:** Hover over destinations with toggle on/off. Verify orange segments, cost label with trackage fee, partial-build cutoff stops at foreign gap.

### Commit 4: Wire toggle to build commit + truncation

**Risk: Medium** — affects actual track building.

**File: `public/eurorails.html`**

- **Build click handler (line 5380):** Pass `gameState.useForeignTrackInBuild` as 6th arg to `findPath()`.
- **All-foreign path:** If every segment is foreign, log "No track to build — route uses only foreign track", skip commit.
- **Truncate at first foreign gap:** Find first foreign segment index, truncate `buildPath` to end before it, recalculate `buildCost` for truncated portion only. Full path shown in preview, only connected portion committed.

**Verification:** Click to build with foreign segments in path. Verify only connected portion builds. Verify all-foreign path logs message, no track built.

## Files NOT Modified

- **`server/ai-actions.js`** — `applyCommitBuild()` (line 295) already skips foreign edges. Client sends truncated path, server validation correct as-is.
- **AI callers of `findPath()`** — All pass ≤5 args, new 6th param defaults to `false`. No behavior change.
- **`eurorails.html` (local version)** — Per project rules, not modified when working on multiplayer.

## Risks

| Risk | Severity | Mitigation |
|---|---|---|
| Existing `findPath()` snapshots break | High | Default `false` param — run tests immediately after commit 1 |
| Build commit creates disconnected track | High | Truncate at first foreign gap; server already skips foreign edges |
| AI regression | Medium | Default param preserves behavior; run AI tests after commit 1 |
| Shared module parity (extraction/wiring tests) | Medium | New param is additive; run extraction tests after commit 1 |
| Cost label displays wrong amount after truncation | Low | Build cost recalculated from truncated path, not original |

## Edge Cases

1. **Toggle off (default)** — Identical to current behavior in all modes.
2. **All-foreign path** — Show all-orange preview with trackage fee. On click, log informational message, skip commit.
3. **Foreign gap in middle** — Only build up to the gap. Show full path in preview with green → orange coloring.
4. **Multiple opponents in foreign section** — Each distinct opponent adds 4M/turn. Display total.
5. **Direct neighbor is foreign** — `directBlocked` check still prevents forcing a direct path onto foreign edges.
6. **Partial build + foreign** — Budget cutoff applies within the connected section before the foreign gap.
7. **Shortest + foreign ON** — Foreign edges weight 1. Shortcut, not free.

## Verification (End-to-End)

1. `npm test` — all existing tests pass after each commit
2. Start multiplayer game with 2+ players (multiple browser tabs)
3. **1a/ Foreign OFF + Cheapest:** Routes around foreign track (current behavior)
4. **1b/ Foreign OFF + Shortest:** Routes around foreign track, fewest own segments
5. **2a/ Foreign ON + Cheapest:** Routes through foreign track at 0 build cost. Orange segments. Cost: "XM build · 🚂4M/turn rent"
6. **2b/ Foreign ON + Shortest:** May shortcut through foreign track, doesn't wildly detour
7. Click to build — only commits segments up to first foreign gap
8. All-foreign path — preview shown, message logged on click, no track built
9. Toggle resets on phase change
10. AI players unaffected
