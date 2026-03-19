# AI Movement Improvements Plan

Two independent fixes for AI trains sitting idle after delivering goods. Each can be implemented separately.

---

## Fix 1: Re-plan After Delivery (Use Remaining Movement)

### Problem

After `deliverGood`, the AI immediately does `endOperatePhase`, wasting remaining movement points. The pre-computed plan is `[..., deliverGood, endOperatePhase]` — it never re-evaluates after delivery changes the game state (card replaced, loads updated, target cleared).

### Approach

Mirror the existing `endOperatePhase` re-plan pattern in `executeAIActionSequence` (server.js:953). After a successful `deliverGood`, interrupt the stale plan and re-plan the operate phase with fresh game state.

### Changes

| File | Change |
|------|--------|
| `server.js` ~line 942 | Add `deliverGood` re-plan block after `broadcastStateUpdate` — if AI and `player.movement > 0`, discard remaining plan, re-call `planTurn` with fresh state, execute new plan |
| `server/ai-easy.js` | No changes needed — `planTurn` already handles mid-operate scenarios correctly |

### Implementation Detail

Insert a new block in `executeAIActionSequence` after line 942 (`broadcastStateUpdate`) and before line 944 (`if (action.type === 'endTurn')`):

```javascript
// After a successful deliverGood by an AI, re-plan the rest of the operate
// phase with fresh state. The delivery replaced a demand card and cleared
// the AI target, so the remaining pre-computed plan is stale.
if (action.type === 'deliverGood' && player.isAI && player.movement > 0) {
    room.aiTurnTimer = setTimeout(() => {
        room.aiTurnTimer = null;
        if (!rooms.has(roomCode)) return;
        const freshGs = room.gameState;
        if (!freshGs) return;
        const pi = freshGs.currentPlayerIndex;
        const p = freshGs.players[pi];
        if (!p || !p.isAI) return;
        let operatePlan;
        try {
            const freshCtx = buildPathfindingCtx(freshGs);
            operatePlan = aiEasy.planTurn(freshGs, pi, freshCtx);
        } catch (err) {
            console.warn(`Room ${roomCode}: AI planTurn error (post-delivery re-plan): ${err.message}`);
            operatePlan = [{ type: 'endOperatePhase' }];
        }
        if (!operatePlan || operatePlan.length === 0) {
            operatePlan = [{ type: 'endOperatePhase' }];
        }
        console.log(`Room ${roomCode}: ${p.name} post-delivery re-plan (movement=${p.movement}): [${operatePlan.map(a => a.type).join(', ')}]`);
        executeAIActionSequence(roomCode, room, operatePlan, 0);
    }, AI_ACTION_DELAY_MS);
    return;
}
```

### Edge Cases

- **Movement = 0 after delivery:** No re-plan; original `endOperatePhase` proceeds normally.
- **Chained deliveries:** Each re-plan gets fresh state. Terminates naturally as movement decreases — movement is finite (max 12) and each `commitMove` consumes points.
- **No viable target after delivery:** Re-plan returns `[endOperatePhase]` or `[discardHand]`.
- **Non-AI player:** The `player.isAI` guard ensures this code path only triggers for AI. Human `deliverGood` flows through socket handlers.

### Tests

| # | Test | Setup | Assert |
|---|------|-------|--------|
| 1 | `planTurn` mid-operate produces movement | Phase=operate, no loads, movement=6, reachable target | Plan contains `commitMove` |
| 2 | Integration: delivery triggers re-plan | AI at city A carrying good X for delivery at A, track to city B | After delivery, AI moves toward new target |
| 3 | No re-plan when movement=0 | AI delivers after full move (movement=0) | `endOperatePhase` executes from original plan |
| 4 | Chained delivery at same city | AI at city A carrying goods X and Y, both deliverable at A | Both delivered, then AI moves with remaining movement |
| 5 | No target available after delivery | All demands unreachable after new card drawn | Graceful fallback to `endOperatePhase` or `discardHand` |
| 6 | Primary: move toward new source | AI delivers at city A with 6mp left, new target source city B reachable | AI moves toward city B |

---

## Fix 2: Foreign Track Movement with Cost Analysis

### Problem

AI calls `findPathOnTrack(..., false)` at all 3 movement planning locations (ai-easy.js lines 496, 515, 530). It can only move on its own track. If target cities aren't connected by own track, the AI sits idle even though game rules allow using other players' track for a fee (4 ECU per foreign track owner, once per turn per owner).

### Approach

Try own track first (free). If unreachable, try foreign track with profitability and affordability checks. The existing `applyCommitMove` in ai-actions.js already handles trackage rights charging — the AI just needs to make smart decisions about WHEN to use foreign track.

### Changes

| File | Change |
|------|--------|
| `server/ai-easy.js` | Add `computeTrackageRightsCost(gs, trackPath, playerColor)` — predicts trackage fee from a `findPathOnTrack` result (4 ECU per unique unpaid foreign owner) |
| `server/ai-easy.js` | Add `planMovement(gs, playerIndex, ctx, fromId, toId)` — tries own track first, falls back to foreign track with affordability + strand-risk checks |
| `server/ai-easy.js` L496, L515, L530 | Replace 3 direct `findPathOnTrack(..., false)` calls with `planMovement(...)` + profitability guards |
| `server/ai-easy.js` `selectTargetDemand` | Add `includeTrackageCosts` option — when true, factor predicted trackage fees into demand scoring |
| `server/ai-easy.js` `selectTargetFromState` | Pass through `includeTrackageCosts` from operate-phase callers |
| `server/ai-easy.js` exports | Expose new helpers for testability |

No changes needed to: `ai-actions.js` (already charges trackage rights), `game-logic.js` (`findPathOnTrack` already supports `allowForeignTrack=true`), `server.js` (trackage rights infrastructure already works).

### New Helper: computeTrackageRightsCost

```javascript
// Predict trackage rights cost for a path with foreign segments.
// Returns { cost, ownerCount } where cost = ownerCount * 4.
function computeTrackageRightsCost(gs, trackPath, playerColor) {
    if (!trackPath?.foreignSegments?.length) return { cost: 0, ownerCount: 0 };

    const owners = new Set();
    for (const segIdx of trackPath.foreignSegments) {
        const fromId = trackPath.path[segIdx];
        const toId = trackPath.path[segIdx + 1];
        for (const track of gs.tracks) {
            if (track.color === playerColor) continue;
            if ((track.from === fromId && track.to === toId) ||
                (track.to === fromId && track.from === toId)) {
                owners.add(track.color);
                break;
            }
        }
    }

    let unpaidCount = 0;
    for (const ownerColor of owners) {
        if (!gs.trackageRightsPaidThisTurn?.[ownerColor]) unpaidCount++;
    }

    return { cost: unpaidCount * 4, ownerCount: unpaidCount, totalOwners: owners.size };
}
```

### New Helper: planMovement

```javascript
// Plan movement trying own track first, falling back to foreign track.
// Returns { path, trackageCost, foreignSegments? } or null.
function planMovement(gs, playerIndex, ctx, fromId, toId) {
    const player = gs.players[playerIndex];

    // Prefer own track (free)
    const ownPath = findPathOnTrack(ctx, fromId, toId, player.color, false);
    if (ownPath) return { path: ownPath.path, trackageCost: 0 };

    // Try with foreign track
    const foreignPath = findPathOnTrack(ctx, fromId, toId, player.color, true);
    if (!foreignPath) return null;

    const trackageInfo = computeTrackageRightsCost(gs, foreignPath, player.color);

    // Can the AI afford the fee?
    if (trackageInfo.cost > player.cash) return null;

    // Strand risk: if destination isn't on own track, need cash to leave next turn
    const ownedMileposts = getPlayerOwnedMileposts(ctx, player.color);
    if (!ownedMileposts.has(toId) && (player.cash - trackageInfo.cost) < 4) return null;

    return { path: foreignPath.path, trackageCost: trackageInfo.cost, foreignSegments: foreignPath.foreignSegments };
}
```

### Profitability Guards in planTurn

When using foreign track, the AI checks profitability before committing:

- **Moving to destination with goods (L496):** `payout > trackageCost` required.
- **Moving after pickup (L515):** Same check.
- **Moving to source (L530):** Estimate TOTAL trackage (to source + to destination) and require `payout > totalTrackage`.

### Demand Selection Integration

In `selectTargetDemand`, when `includeTrackageCosts: true`, add predicted trackage fees to the route cost for scoring purposes. This makes the AI prefer demands reachable on own track over higher-payout demands requiring expensive foreign track.

### Key Design Decisions

- Own track always preferred (cost 0) — foreign track is a fallback only.
- Conservative cost estimation: sums both legs' trackage (even though `trackageRightsPaidThisTurn` might make the second leg cheaper).
- Strand risk check prevents the AI from ending up on foreign track without enough cash to leave.
- BFS-based `findPathOnTrack` finds fewest-hops path, not cheapest-trackage path. The "try own first, fall back to foreign" approach sidesteps this limitation.

### Tests

| # | Test | Setup | Assert |
|---|------|-------|--------|
| 1 | Uses foreign track when own doesn't connect | Red has A→B, Blue has B→C, Red needs to reach C | `planMovement` returns path through B→C, `trackageCost=4` |
| 2 | Prefers own track when both exist | Red has direct A→C, Blue also has A→C | `planMovement` returns own-track path, `trackageCost=0` |
| 3 | Proceeds when payout > trackage | Payout=10, trackage=4 | Move planned |
| 4 | Rejects when payout ≤ trackage | Payout=3, trackage=4 | Move NOT planned via foreign track |
| 5 | Rejects when can't afford fee | Cash=2, trackage=4 | `planMovement` returns null |
| 6 | Multiple foreign owners | Path crosses Blue + Green track | `computeTrackageRightsCost` returns `cost=8, ownerCount=2` |
| 7 | Own-track path returns cost 0 | Path has no foreign segments | Returns `{ cost: 0, ownerCount: 0 }` |
| 8 | Strand risk rejection | Destination off own network, cash - trackage < 4, no delivery at destination | `planMovement` returns null |
| 9 | Trackage in demand scoring | Demand A: payout 20, trackage 8 (net 12). Demand B: payout 15, own track (net 15) | `selectTargetDemand` with `includeTrackageCosts` picks B |
| 10 | Partial move on foreign track | Movement points insufficient to reach destination | Move still planned (partial); `applyCommitMove` handles truncation |
| 11 | `trackageRightsPaidThisTurn` avoids double-count | Blue already paid this turn | `computeTrackageRightsCost` returns 0 for Blue's segments |
