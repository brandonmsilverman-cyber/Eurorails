# Solo Mode Implementation Plan

## Overview

Solo mode branches from the main lobby as its own game type. The player creates a private room and adds 1-5 AI opponents that take turns just like human players. AI difficulty tiers (Easy, Hard, Brutal) are built incrementally so the full loop is functional at each step.

## Phased Approach

### Phase 0: Shared Module Extraction (~3-4 days) — COMPLETE

Extract ~1,200 lines of constants, geometry, hex grid generation, and pathfinding into `shared/game-logic.js` — a single file usable by both the browser client and the Node.js server.

**Why this comes first:** The AI needs to compute paths server-side. Rather than duplicating pathfinding (and maintaining two copies that can drift), we extract once into a shared module. This also eliminates existing duplication — the server already has its own copies of `CITIES`, `GOODS`, `EVENT_CARDS`, `RIVERS`, `TRAIN_TYPES`, `MAJOR_CITIES`, `segmentsIntersect`, `crossesRiver`, and `getFerryKey`. Procedurally generated maps (future goal) make this extraction mandatory regardless.

**What gets extracted:**

| Layer | ~Lines | Contents |
|---|---|---|
| Constants | 350 | `WORLD_BOUNDS`, `MAJOR_CITIES`, `CITIES`, `GOODS`, `TRAIN_TYPES`, `EVENT_TYPES`, `COLOR_MAP`, `LANDMASSES`, `CONNECTED_LANDMASSES`, `TERRAIN_REGIONS`, `RIVERS`, `FERRY_ROUTES`, `SEA_AREAS`, `EVENT_CARDS`, `GOODS_ICONS` |
| Geometry helpers | 135 | `pointInPolygon`, `isLand`, `getLandmass`, `landmassesConnected`, `terrainHash`, `polygonDepth`, `getTerrainType`, `segmentDistance`, `segmentsIntersect`, `crossesRiver`, `edgeCrossesRiver` |
| Grid generation | 115 | `generateHexGrid()`, `computeCoastDistances()` |
| Pathfinding support | 190 | `MinHeap`, `getFerryPortCost`, `getFerryName`, `getMileppostCost`, `getFerryKey`, `canPlayerBuildFerry`, `playerOwnsFerry`, `getPlayerOwnedMileposts` |
| Pathfinding | 310 | `findPath()` (Dijkstra for building), `findPathOnTrack()` (BFS for movement), `isGaleBlockingFerry()` |
| Event zone helpers | 70 | `getMilepostsInHexRange`, `getMilepostsInHexRangeMultiSource`, `getCoastalMilepostsForSeaAreas`, `isMilepostInEventZone` |

**Key finding:** None of this code has DOM or canvas dependencies. It is all pure logic.

**Critical design decision — the `ctx` parameter:** Every function that currently reads `gameState` globals will instead receive a context object. The caller (client or server) assembles `ctx` from its own gameState:

```javascript
{
  mileposts,           // array
  mileposts_by_id,     // lookup object
  cityToMilepost,      // { cityName: milepostId }
  ferryConnections,    // array
  ferryOwnership,      // { ferryKey: [colors] }
  tracks,              // array of { from, to, color }
  activeEvents,        // array
  players              // array (only needed for strike color lookup)
}
```

**Browser/Node dual compatibility:**

```javascript
(function(root) {
  // ... all code ...

  const exports = { CITIES, GOODS, generateHexGrid, findPath, /* ... */ };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = exports;  // Node.js
  } else {
    for (const [k, v] of Object.entries(exports)) {
      root[k] = v;  // Browser global
    }
  }
})(typeof window !== 'undefined' ? window : this);
```

#### Phase 0 Implementation Steps

| Step | What | Risk |
|---|---|---|
| 0.0 | Create snapshot test suite against current client code (captures ground truth) — **DONE** | None — read-only |
| 0.1 | Create `shared/game-logic.js` with all extracted code — **DONE** | Low — new file, nothing depends on it yet |
| 0.2 | Wire client to use shared module, delete inline code from `public/eurorails.html` — **DONE** | **Medium** — highest-risk step |
| 0.3 | Wire server to use shared module, delete duplicated constants from `server.js` — **DONE** | **Medium** — changes server code paths |
| 0.4 | Server generates own hex grid at game start, remove `setCityToMilepost` dependency — **DONE** | Low-medium — simplifies server but changes startup flow |

Steps 0.2 and 0.3 should each be their own commit so they can be reverted independently.

#### Step 0.0 — Snapshot Test Suite (Complete)

**Files created:**

| File | Purpose |
|---|---|
| `test/snapshot-helper.js` | Extracts pure game logic (lines 1047–2423 and 3056–3151) from `public/eurorails.html` into a Node.js `vm` context. Converts `const`/`let`/`class` to `var` so symbols are accessible in the sandbox. |
| `test/generate-snapshots.js` | Runs all game logic functions and saves ground-truth values to JSON. Run once before extraction: `node test/generate-snapshots.js` |
| `test/snapshot.test.js` | 30 tests across 9 suites that compare live output against the saved snapshot. Run with: `node --test test/snapshot.test.js` |
| `test/snapshots/ground-truth.json` | Captured baseline data (milepost grid, paths, terrain, event zones, etc.) |

**Test coverage (30 tests, 9 suites):**

| Suite | Tests | What's verified |
|---|---|---|
| Hex grid generation | 6 | Milepost count (1710), city mapping (61 cities), ferry connections (8), neighbor edges, sample mileposts |
| Terrain determination | 2 | `terrainHash` determinism, `getTerrainType` for 50 coordinate pairs |
| Coast distances | 1 | BFS coast distances for 20 sample mileposts |
| Build pathfinding | 4 | 10 city-pair cheapest paths, 2 shortest paths, owned-edge-costs-zero, blocked-edge routing |
| Movement pathfinding | 3 | Path on track, no-track returns null, strike 123 blocks movement |
| Event zones | 3 | Zone sizes for 8 events, in-zone membership, `isMilepostInEventZone` spot checks |
| Landmass connectivity | 1 | 10 landmass pair checks |
| Ferry ownership | 3 | 2-owner limit, ownership checks |
| Constants integrity | 7 | CITIES count, MAJOR_CITIES, FERRY_ROUTES, EVENT_CARDS, TRAIN_TYPES, goods sources, event city refs |

**Note on vm cross-context objects:** Objects created inside the `vm` sandbox have different prototypes than main-context objects, so `assert.deepStrictEqual` fails on structurally identical values. The test uses a `normalize()` helper (JSON round-trip) for deep comparisons.

**Commands:**
```bash
# Regenerate snapshots after intentional changes
node test/generate-snapshots.js

# Run snapshot tests
node --test test/snapshot.test.js
```

---

### Phase 1: Lobby + AI Player Infrastructure (~1-2 days) — COMPLETE

**What:** Solo Mode button, AI setup screen (count/difficulty/color), private room creation, AI player slots in game state.

**Details:**
- Add "Solo Mode" button in lobby that emits `createRoom` with a `solo: true` flag
- UI for choosing 1-5 AI opponents with difficulty (Easy, Hard, Brutal) and color pickers
- Server marks AI players in the room's player map (e.g., `isAI: true, difficulty: 'easy'`)
- `createGameState(playerList)` doesn't need to change — AI players are just entries in the same player array

**Risk to existing game: Very low.** The solo room is private and the player array structure is unchanged.

---

### Phase 2: AI Turn Loop (~3-5 days) — COMPLETE

**What:** Server detects AI turns, executes actions with small delays so the human can watch, skips turn timer for AI, handles event cards.

**Details:**
- In `serverEndTurn()`, after advancing `currentPlayerIndex`, check if the next player `isAI`
- If so, skip the turn timer and kick off an AI turn sequence with `setTimeout` delays between actions
- The AI calls the same validated action functions used by human players: `commitBuild`, `commitMove`, `pickupGood`, `deliverGood`, `endTurn`, etc.
- Event cards drawn during AI delivery/discard go through the existing `serverDrawCardForPlayer` + `serverApplyEventEffect` pipeline — no changes needed
- Each AI action triggers a `stateUpdate` broadcast so the human player can watch in real-time

**Risk to existing game: Low-medium.** The main risk is in the turn advancement logic. Currently `serverEndTurn` assumes the next action comes from a socket event. Need to add an internal dispatch path for AI actions. If done as clean extraction of action handlers into callable functions (from both socket events and AI logic), it's safe.

---

### Phase 3: Easy AI Difficulty (~4-7 days) — COMPLETE

**What:** Complete but simple AI that plays a legal, functional game but is obviously beatable. Proves the turn loop works end-to-end. The Easy AI is myopic and serial — it does everything one step at a time with no strategic planning.

**Strategy dimensions:**

All AI difficulty tiers are evaluated against five strategic dimensions. Easy AI is deliberately weak on all five:

| Dimension | Easy AI behavior |
|---|---|
| **1. Route batching** | **None.** Pursues one demand at a time. Picks a single demand card row, builds toward that source/destination, picks up, delivers, then looks at the next card. Never considers whether two demands share a common city or corridor. Produces lots of deadhead (empty) movement and redundant track. |
| **2. Build ROI** | **Greedy, no projection.** Builds toward whichever demand destination is cheapest to reach right now (fewest unbuilt ECU). No consideration of future demand value or network topology. Won't route through a hub like Paris because it's a hub — only if Paris happens to be on the cheapest path to the current target. Produces spindly, dead-end track networks. |
| **3. Train upgrade timing** | **Fixed threshold.** Upgrades when cash exceeds a static amount (e.g., ECU 80). No evaluation of whether the extra movement/capacity would pay off given current network size or delivery distances. Sometimes upgrades too early (small network), sometimes too late (missing efficiency when it matters). |
| **4. Hand discard timing** | **Never (or near-never).** Plays whatever hand it's dealt. Doesn't evaluate whether current cards are weak relative to expected replacements. The only discard trigger is Layer 2 bankruptcy recovery (Priority 4) — a last resort, not a strategic choice. |
| **5. Ferry investment** | **Avoid unless forced.** Only builds a ferry if the current target demand requires crossing water and there's no land route. Never preemptively invests to open a landmass for future deliveries. Doesn't consider the competitive risk of an opponent claiming the second slot. |

**Why Phase 0 saves time here:** Pathfinding is already available server-side via the shared module. No porting needed.

#### Bankruptcy Protection

The official rules offer two safety valves for struggling players: **borrowing** (up to ECU 20 at 2x repayment from future deliveries) and a full **reset** (erase all track, return to ECU 50 + fresh cards). However, these are reactive mechanics designed for human judgment. An AI that relies on borrowing risks compounding debt, and a reset erases all progress. Instead, we use proactive protection that prevents the AI from ever reaching that state. If the AI spends all its cash on track without completing a deliverable route, it enters a permanent failure state — no money, no income, no way to build out. It will loop endlessly doing nothing. Two layers of protection prevent this.

**Layer 1: Pre-build budget reservation**

Before committing any build action, the AI computes a **minimum cash reserve** — the cheapest track extension that would complete at least one delivery on its current demand hand. The AI must not build if doing so would drop its cash below this reserve.

The check, run before every build commit:

1. For each demand card in hand, find the cheapest path from a source city (where the good is available) to the demand destination, considering track the AI already owns (cost 0) and unbuilt terrain (normal cost).
2. The **reserve floor** is the minimum cost across all cards — the cheapest single delivery the AI could complete.
3. If `cash - proposedBuildCost < reserveFloor`, **reject the build**. The AI ends its build phase early and moves to operate.

This guarantees the AI always retains enough cash to finish at least one route to a payout.

**Edge case — reserve floor exceeds cash before any build:** If the AI's cheapest completable delivery already costs more than its total cash (e.g., all demand destinations require expensive alpine/mountain routes), skip building entirely and go to Layer 2.

**Layer 2: Stuck detection and recovery**

At the start of each AI turn, before planning, run a stuck check: "Can I complete at least one delivery given my current track network + current cash?" A delivery is completable if:
- A source city for the demanded good is reachable on existing track (or the AI is already carrying the good), AND
- The destination city is reachable on existing track from that source, AND
- The AI can afford any remaining unbuilt gap between source and destination

If **not stuck**, proceed normally.

If **stuck**, execute recovery in priority order:

| Priority | Condition | Recovery action |
|---|---|---|
| 1 | AI is carrying a good that can be delivered somewhere on its existing network (even if not on a demand card — this won't happen in normal rules, but check anyway) | Move toward that destination and deliver |
| 2 | A good on the current hand can be picked up and delivered entirely on existing track (no new build needed) | Route to source, pick up, deliver — even if the payout is small |
| 3 | AI has enough cash to build a short extension (≤ remaining cash) that connects a source or destination to its network | Build the cheapest such extension, then pick up/deliver |
| 4 | None of the above are possible | Discard entire demand hand and draw 3 new cards, hoping for destinations that align with existing track |

Priority 4 is the last resort. In practice, Priorities 2–3 should cover most cases because the AI's track network grows over time and demand cards have a minimum distance of 5 hexes, meaning nearby cities on the network are likely to appear as sources or destinations eventually.

**Key invariant:** The AI never ends a build phase with 0 ECU and no completable delivery. Either it has cash to extend, or it has a route to earn income.

**Why this won't paralyze the AI:** The reserve floor is not static — it **shrinks every turn** as the AI builds toward a destination, because `findPath()` treats owned track as cost 0. A route that costs 25 ECU to complete on turn 1 might cost 10 ECU by turn 3 after two rounds of building. The AI is always making progress toward lowering its reserve. The only paralysis scenario is if all 3 demand cards require routes far exceeding current cash *and* no existing track helps — that's exactly when Layer 2 Priority 4 (discard and redraw) fires, giving the AI fresh cards that may align with its existing network.

**Implementation notes:**
- The reserve floor calculation reuses `findPath()` with the AI's current track context — no new pathfinding code needed.
- The stuck check runs once per turn (not per action), so performance impact is minimal.
- Layer 1 is the primary defense; Layer 2 is a safety net for situations where the AI enters the turn already in trouble (e.g., a flood destroyed a critical track segment).

#### Detailed Implementation Plan

##### File Plan

| File | Action | Purpose |
|---|---|---|
| `server/ai-actions.js` | **Create** | Extracted action-handler core logic callable without sockets |
| `server/ai-easy.js` | **Create** | Easy AI decision-making strategy module |
| `server.js` | **Modify** | Refactor inline handlers to delegate to `ai-actions.js`; rewrite `executeAITurn` to run multi-step action sequences using `ai-easy.js`. Also export `rooms` alongside the listener for test access. |
| `test/ai-easy.test.js` | **Create** | Unit + integration tests for Easy AI |

##### Test Infrastructure: Demand Card Injection

Integration tests that require the AI to complete deliveries are susceptible to infinite loops if the random demand deck gives the AI demands for unreachable cities (e.g., cross-water destinations the Easy AI won't ferry to). Tests must seed known demand cards to be deterministic.

**Solution:** Export `rooms` from `server.js` so tests can directly access and mutate server-side game state. One-line change to production code with zero runtime impact — no new socket events, no environment flags.

**Change to `server.js`:**
```javascript
// Before:
module.exports = listener;

// After:
module.exports = { listener, rooms };
```

**Change to existing tests:** All test files that do `serverInstance = require('../server')` update to:
```javascript
const { listener: serverInstance, rooms } = require('../server');
```

**Demand card injection pattern in integration tests:**
```javascript
// After createSoloGame, before the AI acts:
const room = Array.from(rooms.values()).find(r => r.gameState);
const aiPlayer = room.gameState.players.find(p => p.isAI);
aiPlayer.demandCards = [{
    id: 'test-1',
    demands: [
        { good: 'Coal', to: 'Frankfurt', payout: 15 },
        { good: 'Beer', to: 'München', payout: 20 },
        { good: 'Iron', to: 'Berlin', payout: 18 }
    ]
}];
```

Cities chosen for seeded demands should be on the continental landmass with short, cheap routes between source and destination (e.g., all within 5-8 hexes of each other through clear/plains terrain). This ensures the AI can build the full route within a few turns.

##### Step 1: Extract Action Handlers into `server/ai-actions.js` — COMPLETE

The inline `socket.on('action', ...)` handlers (server.js:1106–1845) each do three things mixed together: (A) validate the caller is the current player, (B) apply the game mutation + validation, (C) broadcast state and call the socket callback. The AI needs only (B).

Extract one pure function per action type into `server/ai-actions.js`. Each takes `(gs, playerIndex, params)` and returns `{ success, error?, logs?, uiEvent? }`. No broadcasting, no socket references.

Functions to extract:

| Function | Source Lines | Parameters |
|---|---|---|
| `applyCommitBuild(gs, playerIndex, { buildPath, buildCost, majorCityCount, ferries })` | 1321–1430 | Validates budget/cash/major-city limit, adds track segments + ferry ownership |
| `applyCommitMove(gs, playerIndex, { path })` | 1591–1767 | Validates operate phase, path connectivity, handles ferry crossings + trackage rights + partial moves |
| `applyDeployTrain(gs, playerIndex, { milepostId })` | 1433–1461 | Sets `trainLocation` |
| `applyPickupGood(gs, playerIndex, { good })` | 1189–1228 | Validates capacity/strikes/circulation, adds to loads |
| `applyDeliverGood(gs, playerIndex, { cardIndex, demandIndex })` | 1259–1318 | Validates load/city/strikes, applies payout, draws replacement card |
| `applyUpgradeTo(gs, playerIndex, { trainType })` | 1152–1186 | Validates 20 ECU + no builds yet, deducts cash, sets type |
| `applyDiscardHand(gs, playerIndex)` | 1464–1511 | Clears cards, draws 3 new, calls `serverEndTurn` |
| `applyEndOperatePhase(gs, playerIndex)` | 1514–1540 | Transitions to build phase |
| `applyEndTurn(gs)` | Wraps `serverEndTurn` (line 495) | Advances turn |

Refactoring pattern for `server.js` — each inline handler keeps its "is it my turn" guard and socket callback, but delegates core logic to the extracted function:

```javascript
case 'commitBuild': {
    if (playerIndex !== gs.currentPlayerIndex) { return callback({...}); }
    const result = applyCommitBuild(gs, playerIndex, action);
    if (!result.success) { return callback({ success: false, error: result.error }); }
    broadcastStateUpdate(socket.roomCode, room, result.uiEvent);
    callback({ success: true });
    break;
}
```

Pure mechanical refactoring — zero behavior change.

Dependencies: `applyDeliverGood` and `applyDiscardHand` call `serverDrawCardForPlayer` and `serverEndTurn`, which remain in `server.js`. `ai-actions.js` exports a factory that receives dependencies:

```javascript
module.exports = function(deps) {
    const { serverEndTurn, serverDrawCardForPlayer, ... } = deps;
    return { applyCommitBuild, applyCommitMove, ... };
};
```

**Step 1 tests — no new tests.** Run existing suite to verify behavior-preserving refactoring:

| Test file | Command | What it verifies |
|---|---|---|
| `test/ai-turn-loop.test.js` | `AI_ACTION_DELAY_MS=100 node --test test/ai-turn-loop.test.js` | Turn cycling, cascading AI turns, overlays, `discardHand` still work through extracted functions |
| `test/solo-mode.test.js` | `node --test test/solo-mode.test.js` | Game creation, AI player properties, validation, room privacy |
| All other existing tests | `npm test` | No regressions anywhere |

Update all existing test files that do `serverInstance = require('../server')` to destructure the new export format: `const { listener: serverInstance, rooms } = require('../server')`.

##### Step 2: Add `aiState` to AI Players — COMPLETE

In the `createSoloGame` handler (server.js:941–948), after setting `p.isAI` and `p.difficulty`, also set:

```javascript
p.aiState = {
    targetCardIndex: null,    // index into player.demandCards
    targetDemandIndex: null,  // index into card.demands
    targetSourceCity: null    // which source city to go to
};
```

This persists across turns on the game state object. It tracks which demand the AI is currently pursuing so multi-turn building toward a destination is coherent.

**Step 2 tests — no new tests.** Run existing suite to confirm adding the field breaks nothing:

| Test file | Command | What it verifies |
|---|---|---|
| `test/solo-mode.test.js` | `node --test test/solo-mode.test.js` | AI player creation still works |
| `test/ai-turn-loop.test.js` | `AI_ACTION_DELAY_MS=100 node --test test/ai-turn-loop.test.js` | Turn loop unaffected |

##### Step 3: Implement `server/ai-easy.js` — Core Strategy Functions — COMPLETE

**3a: `selectTargetDemand(gs, playerIndex, ctx)`** — Greedy selection: picks whichever demand has the cheapest total build cost (source → destination), using `findPath(ctx, srcId, destId, playerColor, "cheapest")`. Owned track costs 0, so partially-built routes are preferred. Iterates all demands on all cards, tries all source cities from `GOODS[demand.good].sources`. Returns `{ cardIndex, demandIndex, sourceCity }` with lowest cost. Does NOT consider payout — key Easy AI weakness.

**3b: `computeReserveFloor(gs, playerIndex, ctx)`** — Returns the minimum cost to complete ANY single delivery on the current hand. Same iteration as `selectTargetDemand` but returns the minimum `findPath().cost`. Used by Layer 1 bankruptcy protection.

**3c: `isStuck(gs, playerIndex, ctx)` and `getRecoveryPlan(gs, playerIndex, ctx)`** — Stuck check: can the AI complete at least one delivery given current track + cash? Recovery follows the 4-priority sequence described in Bankruptcy Protection above.

**3d: `planTurn(gs, playerIndex, ctx)` — Main entry point.** Returns an array of action descriptors. Logic by game phase:

*`initialBuilding` phase:* Select target demand if none → compute full path via `findPath` → build as much as 20 ECU budget and cash allow (respecting reserve floor) → end turn.

*`operate` phase:* Run Layer 2 stuck check → deploy train if not deployed → pickup if at source → deliver if at destination → otherwise move toward target using `findPathOnTrack` (Easy AI never uses foreign track) → end operate phase.

*`build` phase (after operate):* Check train upgrade (if `cash > 80` and `buildingThisTurn === 0`, upgrade Freight → Fast Freight → Superfreight) → select target demand → build toward target with Layer 1 reserve floor → end turn.

**Build path computation algorithm:**
1. Run `findPath(ctx, sourceId, destId, playerColor, "cheapest")` → full path with cost
2. Walk the path, identify segments the AI doesn't already own
3. Find first unbuilt segment connecting to owned track (or start at city for first build)
4. Accumulate segments until budget or cash (minus reserve floor) exhausted, or major city limit hit
5. Compute segment costs via `getMileppostCost()`, identify ferry keys via `getFerryKey()`
6. Return `{ buildPath, buildCost, majorCityCount, ferries }`

**Step 3 tests — 11 new unit tests** in `test/ai-easy.test.js`. Construct game state and pathfinding ctx directly — no server, no sockets, no infinite loop risk. All synchronous.

| Test | Function under test | What it verifies |
|---|---|---|
| Picks the lowest-cost demand | `selectTargetDemand` | Given a hand with 3 cards at varying distances, returns the cheapest one |
| Prefers routes using existing track | `selectTargetDemand` | With track built toward one destination, selects that demand over a cheaper raw-distance alternative |
| Returns minimum completion cost | `computeReserveFloor` | Given a hand, returns the cheapest single delivery cost across all demands |
| Shrinks as track is built | `computeReserveFloor` | Same hand with more owned track → lower reserve floor |
| Returns 0 when delivery is fully built | `computeReserveFloor` | Route fully on owned track → floor is 0 |
| Returns false when delivery is completable | `isStuck` | Track connects source to destination, cash covers any gap |
| Returns true when no delivery is affordable | `isStuck` | All destinations require more build cost than cash available |
| Returns false when carrying a deliverable good | `isStuck` | Good in loads, destination reachable on existing track |
| Priority 1: carrying deliverable good | `getRecoveryPlan` | Returns plan with move → deliver actions |
| Priority 2: track-only delivery exists | `getRecoveryPlan` | Returns plan with move → pickup → move → deliver |
| Priority 4: discard as last resort | `getRecoveryPlan` | No recovery possible, returns `[{ type: 'discardHand' }]` |

##### Step 4: Rewrite `executeAITurn` for Multi-Step Sequences — COMPLETE

Replace the placeholder at server.js:675 with an action sequence executor:

```javascript
function executeAITurn(roomCode, room) {
    if (!rooms.has(roomCode)) return;
    const gs = room.gameState;
    if (!gs) return;
    const playerIndex = gs.currentPlayerIndex;
    const player = gs.players[playerIndex];
    if (!player || !player.isAI) return;

    const ctx = buildPathfindingCtx(gs);
    const plan = aiEasy.planTurn(gs, playerIndex, ctx);
    executeAIActionSequence(roomCode, room, plan, 0);
}

function executeAIActionSequence(roomCode, room, plan, stepIndex) {
    if (!rooms.has(roomCode)) return;
    const gs = room.gameState;
    if (!gs) return;
    if (stepIndex >= plan.length) return;

    const action = plan[stepIndex];
    const playerIndex = gs.currentPlayerIndex;
    const result = executeAIAction(gs, playerIndex, action);

    if (!result.success) {
        console.warn(`Room ${roomCode}: AI illegal action ${action.type}: ${result.error}`);
        const endResult = applyEndTurn(gs);
        broadcastAndScheduleNext(roomCode, room, endResult);
        return;
    }

    broadcastStateUpdate(roomCode, room, result.uiEvent);

    if (action.type === 'endTurn' || action.type === 'discardHand') {
        if (result.uiEvent?.gameOver) return;
        maybeScheduleAITurn(roomCode, room);
        startTurnTimerIfNeeded(roomCode, room);
        return;
    }

    room.aiTurnTimer = setTimeout(() => {
        room.aiTurnTimer = null;
        executeAIActionSequence(roomCode, room, plan, stepIndex + 1);
    }, AI_ACTION_DELAY_MS);
}
```

Safety: `rooms.has(roomCode)` guards each step; `room.aiTurnTimer` enables cleanup on room deletion.

**Step 4 tests — 4 new integration tests** in `test/ai-easy.test.js`. No demand card seeding needed — building happens during `initialBuilding` phase where any demand is a valid target.

| Test | Infinite loop risk? | What it verifies |
|---|---|---|
| AI builds track during initialBuilding phase | No | After AI turns in initialBuilding, `state.tracks.length > 0` for the AI's color |
| AI turn produces multiple stateUpdate broadcasts | No | Human client receives >1 stateUpdate per AI turn (build + endTurn, not just endTurn) |
| AI action sequence handles room deletion mid-turn | No | Delete room during AI sequence, no crash or orphaned timers |
| Existing turn loop tests still pass | No | `ai-turn-loop.test.js` regression check |

Also run: `test/ai-turn-loop.test.js`, `test/solo-mode.test.js`.

##### Step 5: `planTurn` for Operate Phase — COMPLETE

Extend `planTurn` to handle the operate phase: deploy train, move, pickup, deliver.

**Step 5 tests — 5 new integration tests (seeded)** in `test/ai-easy.test.js`. These require the AI to reach specific game states and must seed demand cards to avoid infinite loops.

Seeding uses the exported `rooms` to overwrite `aiPlayer.demandCards` with known-achievable demands on the continental landmass (e.g., Coal from Wroclaw to Leipzig — ~4 hexes apart through clear terrain).

| Test | Seeds demands? | Max turns guard | What it verifies |
|---|---|---|---|
| AI deploys train when entering operate phase | Yes | 20 turns | AI player has `trainLocation !== null` |
| AI moves train along built track | Yes | 20 turns | `trainLocation` changes between stateUpdates |
| AI picks up a good at source city | Yes | 30 turns | `player.loads.length` increases |
| AI delivers good and earns payout | Yes | 30 turns | `player.cash` increases above starting 50 ECU |
| AI turn in operate produces deploy + move + pickup/deliver actions | Yes | 20 turns | Multiple action types in stateUpdates for a single AI turn |

Max turns guard: each test counts full AI turn cycles and calls `assert.fail('AI did not [deliver/pickup/deploy] within N turns')` instead of waiting for a generic timeout.

Example seeded demand cards:
```javascript
const testDemands = [{
    id: 'test-1',
    demands: [
        { good: 'Coal', to: 'Leipzig', payout: 12 },       // Coal source: Wroclaw (nearby)
        { good: 'China', to: 'Frankfurt', payout: 15 },     // China source: Leipzig (nearby)
        { good: 'Cars', to: 'Stuttgart', payout: 18 }       // Cars source: München (nearby)
    ]
}];
```

Also run: `test/ai-turn-loop.test.js`, `test/solo-mode.test.js`.

##### Step 6: `planTurn` for Build Phase (After Operate) — COMPLETE

Extend `planTurn` to handle the post-operate build phase: train upgrade check, build toward target with reserve floor protection.

**Step 6 tests — 1 new integration test (seeded) + 2 new unit tests:**

| Test | Seeds demands? | Max turns guard | What it verifies |
|---|---|---|---|
| AI upgrades train when cash > 80 | Yes — short, high-payout demand | 40 turns | `player.trainType` changes from `"Freight"` to `"Fast Freight"` |
| AI respects reserve floor during building | No — unit test | N/A | After building, `player.cash >= computeReserveFloor()` |
| AI skips building when reserve floor exceeds cash | No — unit test | N/A | `planTurn` returns plan with no `commitBuild` actions |

Also run: `test/ai-turn-loop.test.js`, `test/solo-mode.test.js`.

##### Step 7: Layer 2 Stuck Detection and Recovery — COMPLETE (Priority 3 deferred)

Add stuck detection at the start of each turn's planning. Implement the four recovery priorities.

**Note:** Priority 3 (build a short extension to connect source/dest) is deferred. Layer 1 reserve floor prevents most stuck states proactively, and when the AI does get stuck it's typically in a scenario where Priority 4 (discard hand) is the correct action anyway. The code falls through from Priority 2 directly to Priority 4. Priority 3 can be revisited if playtesting reveals cases where the AI discards unnecessarily.

**Step 7 tests — 4 new unit tests + 1 new integration test (seeded):**

Unit tests (no server, no infinite loop risk):

| Test | What it verifies |
|---|---|
| Stuck AI with deliverable load executes Priority 1 | `getRecoveryPlan` returns move → deliver |
| Stuck AI with track-only delivery executes Priority 2 | `getRecoveryPlan` returns move → pickup → move → deliver |
| Stuck AI with affordable extension executes Priority 3 | `getRecoveryPlan` returns build → move → pickup → deliver |
| Stuck AI with no options executes Priority 4 | `getRecoveryPlan` returns `[{ type: 'discardHand' }]` |

Integration test (seeded):

| Test | Seeds demands? | Max turns guard | What it verifies |
|---|---|---|---|
| AI discards hand when stuck with no recovery | Yes — demands for Britain with no ferry, cash = 1 ECU | 5 turns | AI calls `discardHand`, gets new cards, turn ends |

Also run: `test/ai-turn-loop.test.js`, `test/solo-mode.test.js`.

##### Step 8: Final Integration + Manual Playtest — IN PROGRESS

No new automated tests. Verify everything works together.

Run full test suite: `npm test` and `AI_ACTION_DELAY_MS=100 node --test test/ai-easy.test.js`.

Manual playtest (~15 minutes):
```
npm start
# Open http://localhost:3000/eurorails.html
# Create solo game with 2 Easy AI opponents
# Watch 15-20 turns
```

Verify:
- AI builds coherent track toward demand destinations (not random scattering)
- AI picks up and delivers goods (cash increases from payouts)
- AI upgrades train when cash exceeds 80 ECU
- AI never gets stuck looping with no actions
- AI never goes bankrupt (cash 0 with no deliverable route)
- Each AI action produces a visible state update with delay between actions
- Game log messages describe AI actions clearly
- Human player can still take normal actions during their turns
- Multiple AI players build independent track networks without interfering

##### Implementation Order Summary

| Step | What | Risk | Depends On | New Tests | Existing Tests | Status |
|---|---|---|---|---|---|---|
| 1 | Extract action handlers → `server/ai-actions.js` + export `rooms` | Medium | — | None | `npm test` (all existing) | **COMPLETE** |
| 2 | Add `aiState` to AI players in `createSoloGame` | Very low | — | None | `solo-mode.test.js`, `ai-turn-loop.test.js` | **COMPLETE** |
| 3 | Core strategy functions in `server/ai-easy.js` | Low | Step 1 | 11 unit tests | — | **COMPLETE** |
| 4 | `planTurn` for `initialBuilding` + wire `executeAITurn` action sequences | Low-medium | Steps 1–3 | 4 integration tests | `ai-turn-loop.test.js`, `solo-mode.test.js` | **COMPLETE** |
| 5 | `planTurn` for `operate` phase (deploy, move, pickup, deliver) | Medium | Step 4 | 5 integration tests (seeded) | `ai-turn-loop.test.js`, `solo-mode.test.js` | **COMPLETE** |
| 6 | `planTurn` for `build` phase (upgrade + reserve floor) | Low | Step 5 | 1 integration (seeded) + 2 unit tests | `ai-turn-loop.test.js`, `solo-mode.test.js` | **COMPLETE** |
| 7 | Layer 2 stuck detection and recovery | Low-medium | Step 6 | 4 unit + 1 integration (seeded) | `ai-turn-loop.test.js`, `solo-mode.test.js` | **COMPLETE** (Priority 3 deferred) |
| 8 | Final integration + manual playtest | None | Step 7 | None (manual) | `npm test` (full suite) | **IN PROGRESS** |

**Total new tests:** ~28 (18 unit + 10 integration)

##### Ferry Handling (Easy AI)

Easy AI avoids ferries unless forced. When `findPath` returns a path containing ferry edges, check if source and destination are on the same connected landmass using `landmassesConnected` from the shared module. If same landmass, accept the result (ferries are expensive so `findPath` already prefers land routes). If different landmasses with no land connection, the ferry is unavoidable — accept it. The Easy AI never proactively builds ferries to open new landmasses. For movement across owned ferries, `findPathOnTrack` already handles ferry traversal and the `commitMove` handler manages the ferry state machine.

##### Key Existing Functions to Reuse

| Function | Location | Purpose in AI |
|---|---|---|
| `findPath(ctx, startId, endId, playerColor, "cheapest")` | shared/game-logic.js:1033 | Build route planning (returns `{ path, cost }`) |
| `findPathOnTrack(ctx, startId, endId, playerColor, false)` | shared/game-logic.js:1250 | Movement pathfinding (returns `{ path, ferryCrossings, foreignSegments }`) |
| `buildPathfindingCtx(gs)` | server.js:633 | Builds the `ctx` object for pathfinding calls |
| `getMileppostCost(mp1, mp2)` | shared/game-logic.js (exported) | Cost of building one edge |
| `getFerryKey(id1, id2)` | shared/game-logic.js (exported) | Canonical key for ferry edges |
| `getPlayerOwnedMileposts(ctx, playerColor)` | shared/game-logic.js:1367 | Set of mileposts connected to player's track |
| `getCityAtMilepost(gs, milepostId)` | server.js:201 | Check if AI is at a city |
| `serverDrawCardForPlayer(gs, player, logs, drawnEvents)` | server.js:447 | Draw replacement demand card after delivery |
| `serverEndTurn(gs)` | server.js:495 | End turn, advance to next player |
| `landmassesConnected(a, b)` | shared/game-logic.js (exported) | Check if ferry is avoidable |
| `GOODS` | shared/game-logic.js:76 | Source city lookup for demand goods |
| `TRAIN_TYPES` | shared/game-logic.js:108 | Movement/capacity by train type |
| `MAJOR_CITIES` | shared/game-logic.js (exported) | Major city cost identification during building |

---

### Phase 4: Hard AI Difficulty

**What:** An AI that plays like an intelligent human with deliberate strategy across all five dimensions. Should feel like a competent opponent who makes good decisions but doesn't play perfectly.

| Dimension | Hard AI behavior |
|---|---|
| **1. Route batching** | **Opportunistic batching.** Before committing to a delivery, scans all demand cards for shared cities or overlapping corridors. Will pick up a second good en route if the detour is small relative to the payout. Plans 2 deliveries ahead when the geography aligns, but doesn't exhaustively search all permutations. |
| **2. Build ROI** | **Payout/cost scoring with network awareness.** Evaluates each demand by payout divided by build cost to reach it. Favors routes through high-connectivity cities (major cities, goods hubs) because they increase future delivery options. Considers the marginal value of new track: "does this segment open up multiple future demands, or just one?" |
| **3. Train upgrade timing** | **Situational.** Upgrades when the expected movement/capacity gain justifies the 20 ECU cost given current network size and delivery pipeline. Prefers Fast Freight early (movement is the bottleneck on short networks), Heavy Freight when carrying capacity matters (long routes, batched deliveries), Superfreight when both apply. Won't upgrade if cash is needed for a critical track extension. |
| **4. Hand discard timing** | **Active evaluation.** Compares current hand strength (total achievable payout relative to build cost) against expected replacement value. Discards when all 3 cards have poor payout/cost ratios or when destinations are geographically scattered far from existing track. Holds even mediocre cards if one is close to completion. |
| **5. Ferry investment** | **Deliberate evaluation.** Assesses whether a ferry opens enough demand card destinations to justify the cost over the next several hands. Will proactively build a ferry to access Britain or Scandinavia if multiple current demands point there. Considers whether an opponent is likely to claim the second slot. |

**Risk to existing game: Low.** Shares the same turn loop and action dispatch as Easy; only the decision logic differs.

---

### Phase 5: Brutal AI Difficulty

**What:** Near-optimal play across all five dimensions. Not perfect (no exhaustive game-tree search), but makes the best practical decision at every step. Should feel like playing against someone who has played hundreds of games.

| Dimension | Brutal AI behavior |
|---|---|
| **1. Route batching** | **Systematic multi-delivery planning.** Evaluates all permutations of pickup/delivery order across the full hand. Plans trips that chain 2–3 deliveries with minimal deadhead. Factors in train capacity (carry 2–3 goods simultaneously) and will hold a good on board while picking up a second if the combined route is shorter than sequential trips. |
| **2. Build ROI** | **Expected-value calculation over future hands.** For each candidate build, estimates not just the immediate delivery payout but the probability-weighted value of future demands it enables — based on the known distribution of goods, source cities, and destination cities in the demand deck. Builds trunk routes through the highest-EV corridors first. Avoids dead-end spurs unless the immediate payout is very high. |
| **3. Train upgrade timing** | **Optimal timing model.** Calculates the break-even point: "how many turns until the extra movement/capacity pays back the 20 ECU?" Upgrades at the earliest turn where the payback period is shorter than the expected remaining game length. Sequences upgrades optimally (e.g., Fast Freight → Superfreight, skipping Heavy Freight if movement matters more than capacity). |
| **4. Hand discard timing** | **EV comparison against deck distribution.** Computes expected hand value from fresh draws (based on remaining demand deck composition if trackable, or statistical distribution if not) and discards whenever current hand EV is below replacement EV by a meaningful margin. Accounts for the tempo cost of losing a turn to discard. |
| **5. Ferry investment** | **Full landmass access modeling.** Computes the expected demand-card value unlocked by each ferry based on the number and payout of destinations behind it. Proactively builds high-value ferries (e.g., Dover-Calais for Britain access) early in the game. Races to claim the second slot on contested ferries if an opponent has already built one. |

**Risk to existing game: Low.** Same turn loop and action dispatch; only the decision-making logic is more sophisticated.

---

## Effort Summary

| Phase | Effort | Risk to Existing Game | Status |
|---|---|---|---|
| Phase 0: Shared module extraction | 3-4 days | Medium (contained to wiring changes) | **COMPLETE** |
| Phase 1: Lobby + AI infrastructure | 1-2 days | Very low | **COMPLETE** |
| Phase 2: AI turn loop | 3-5 days | Low-medium | **COMPLETE** |
| Phase 3: Easy AI strategy | 4-7 days | Low | **COMPLETE** (playtest in progress) |
| Phase 4: Hard AI strategy | 5-8 days | Low | TODO |
| Phase 5: Brutal AI strategy | 7-12 days | Low | TODO |
| **Total** | **~5-8 weeks** | | |

---

## How the Product Can Break — Detailed Risk Analysis

### Break Case 1: Hex grid mismatch between client and server

**How it happens:** `terrainHash()` uses `Math.sin()`, which is not guaranteed to produce identical results across JavaScript engines (V8 in Node/Chrome vs SpiderMonkey in Firefox vs JavaScriptCore in Safari). A different hash value means a milepost gets a different terrain type on client vs server.

**Impact:** A milepost that's "alpine" on the server but "mountain" on the client means the client shows a path preview costing 2 ECU but the server charges 5. Or a milepost exists on one side but not the other, breaking pathfinding entirely.

**Likelihood:** Low for Chrome + Node (both V8), real for Firefox/Safari users.

**Mitigation:** If cross-engine `Math.sin` diverges, replace `terrainHash()` with a pure-integer hash (e.g., xorshift). The hash just needs to be deterministic, not cryptographic.

### Break Case 2: `findPath` behavior changes due to refactoring from globals to parameters

**How it happens:** When converting `findPath()` from reading `gameState.tracks` to reading `ctx.tracks`, a typo like `ctx.track` (singular) silently returns `undefined`, causing the owned/blocked edge sets to be empty. Pathfinding still "works" but ignores existing track.

**Impact:** Path costs are wrong. Players can build through other players' track. Build cost previews don't match server validation.

### Break Case 3: `findPathOnTrack` loses strike/snow event awareness

**How it happens:** `findPathOnTrack` reads `gameState.activeEvents` and `gameState.players` to check strikes (event 123 blocks movement on the drawing player's rails). If the ctx wiring misses `players`, the struck color lookup fails silently or throws.

**Impact:** Trains can move on struck rail lines, violating game rules.

### Break Case 4: Ferry ownership functions lose access to `ferryOwnership`

**How it happens:** `canPlayerBuildFerry` and `playerOwnsFerry` read `gameState.ferryOwnership`. If the ctx object doesn't include it, lookups throw or return undefined, making all ferries appear available or unavailable.

**Impact:** Ferry build limits (max 2 owners) stop being enforced, or no player can ever build a ferry.

### Break Case 5: Event zone precomputation produces different results when moved server-side

**How it happens:** If the hex grid differs at all between client and server (see Break Case 1), zones computed from it differ, and derailment/gale effects hit wrong mileposts.

**Impact:** Events affect wrong areas of the map.

### Break Case 6: Stale client cache after server update

**How it happens:** Client still has old cached version without the shared module `<script>` tag. Old client tries to `socket.emit('setCityToMilepost', ...)` to a server that no longer needs it.

**Impact:** Low — server generates its own grid now. But the stale client may have other incompatibilities.

**Mitigation:** Keep the `setCityToMilepost` handler on the server as a no-op for one release cycle. Consider adding a version handshake.

### Break Case 7: Script load order — shared module not loaded before main script

**How it happens:** If `game-logic.js` is loaded after or async with the main script, references to `CITIES`, `generateHexGrid`, etc. throw `ReferenceError` at startup.

**Impact:** White screen. Game doesn't load.

### Break Case 8: `CONNECTED_LANDMASSES` uses `Set` — not JSON-serializable

**How it happens:** `JSON.stringify(new Set(...))` produces `{}`. If any code path tries to serialize it over Socket.IO, it silently becomes empty.

**Impact:** None for this extraction (it stays module-internal), but worth knowing.

### Break Case 9: Flood event river crossing check — redundant data after extraction

**How it happens:** The server currently checks floods using `gs.milepostPositions[track.from]` (sent by client) to get x/y for `crossesRiver()`. After extraction, the server has full `mileposts_by_id` with the same x/y data. If flood logic isn't updated to use `mileposts_by_id`, you have redundant data that can diverge.

**Impact:** Low — functional but wasteful. Risk is updating one but not the other.

### Break Case 10: `getMileppostCost` typo propagation

**How it happens:** The function has a typo (double 'p'). During extraction, someone "fixes" it to `getMilepostCost`. Now call sites using the old name break.

**Mitigation:** Keep the typo as-is during extraction. Fix it in a separate commit that updates all call sites at once.

---

## Automated Test Suite

### Setup

No additional dependencies needed — tests use the Node.js built-in test runner (`node --test`).

### Snapshot Tests (Step 0.0 — COMPLETE)

Ground-truth snapshots have been captured and are verified by `test/snapshot.test.js`. See "Step 0.0 — Snapshot Test Suite" above for full details on files, coverage, and commands.

### Unit Tests by Break Case (for Steps 0.1–0.4)

> **Note:** The pseudocode below uses Jest-style syntax from the original plan. The actual test infrastructure uses Node's built-in `node --test` with `assert`. Many of these cases are already covered by `test/snapshot.test.js`. The remaining break-case tests should be added as new `it()` blocks in that file or in a new `test/extraction.test.js` as each extraction step is completed.

```javascript
// Break Case 1: Terrain determinism
test('terrainHash produces consistent results for known inputs', () => {
  expect(terrainHash(30, 25)).toBeCloseTo(SNAPSHOT_VALUE_1, 10);
  expect(terrainHash(45.5, 17)).toBeCloseTo(SNAPSHOT_VALUE_2, 10);
});

test('generateHexGrid produces expected milepost count', () => {
  const grid = generateHexGrid();
  expect(grid.mileposts.length).toBe(EXPECTED_COUNT);
});

test('generateHexGrid assigns all cities to mileposts', () => {
  const grid = generateHexGrid();
  for (const cityName of Object.keys(CITIES)) {
    expect(grid.cityToMilepost[cityName]).toBeDefined();
  }
});

test('city-to-milepost mapping matches snapshot', () => {
  const grid = generateHexGrid();
  expect(grid.cityToMilepost).toEqual(SNAPSHOT_CITY_TO_MILEPOST);
});

test('ferry connections match snapshot', () => {
  const grid = generateHexGrid();
  expect(grid.ferryConnections).toEqual(SNAPSHOT_FERRY_CONNECTIONS);
});

test('terrain types for sample coordinates match snapshot', () => {
  const testPoints = [
    { x: 43, y: 38, expected: "mountain" },
    { x: 30, y: 25, expected: "clear" },
    { x: 45, y: 42, expected: "alpine" },
  ];
  for (const { x, y, expected } of testPoints) {
    expect(getTerrainType(x, y)).toBe(expected);
  }
});

// Break Case 2: findPath parameter wiring
test('findPath respects owned edges (zero cost for existing track)', () => {
  const grid = generateHexGrid();
  const londonId = grid.cityToMilepost["London"];
  const birmId = grid.cityToMilepost["Birmingham"];

  const baseResult = findPath(makeCtx(grid, { tracks: [] }),
    londonId, birmId, "red", "cheapest");
  const ownedTrack = baseResult.path.slice(0, -1).map((id, i) =>
    ({ from: id, to: baseResult.path[i + 1], color: "red" }));
  const withTrack = findPath(makeCtx(grid, { tracks: ownedTrack }),
    londonId, birmId, "red", "cheapest");

  expect(withTrack.cost).toBe(0);
});

test('findPath blocks edges owned by other players', () => {
  const grid = generateHexGrid();
  const londonId = grid.cityToMilepost["London"];
  const birmId = grid.cityToMilepost["Birmingham"];

  const directPath = findPath(makeCtx(grid, { tracks: [] }),
    londonId, birmId, "red", "cheapest");
  const blueTrack = directPath.path.slice(0, -1).map((id, i) =>
    ({ from: id, to: directPath.path[i + 1], color: "blue" }));
  const blocked = findPath(makeCtx(grid, { tracks: blueTrack }),
    londonId, birmId, "red", "cheapest");

  expect(blocked.cost).toBeGreaterThan(directPath.cost);
  expect(blocked.path).not.toEqual(directPath.path);
});

test('findPath with fog event blocks zone mileposts', () => {
  const grid = generateHexGrid();
  const parisId = grid.cityToMilepost["Paris"];
  const leipzigId = grid.cityToMilepost["Leipzig"];
  const fogEvent = { type: "fog", city: "Frankfurt", radius: 4, persistent: true };

  const noFog = findPath(makeCtx(grid, { tracks: [], activeEvents: [] }),
    parisId, leipzigId, "red", "cheapest");
  const withFog = findPath(
    makeCtx(grid, { tracks: [], activeEvents: [{ card: fogEvent, drawingPlayerIndex: 0 }] }),
    parisId, leipzigId, "red", "cheapest");

  expect(withFog.cost).toBeGreaterThanOrEqual(noFog.cost);
});

// Break Case 3: Strike event awareness in movement
test('findPathOnTrack blocks movement on struck player rails', () => {
  const grid = generateHexGrid();
  const londonId = grid.cityToMilepost["London"];
  const birmId = grid.cityToMilepost["Birmingham"];

  const directPath = findPath(makeCtx(grid, { tracks: [] }),
    londonId, birmId, "red", "cheapest");
  const redTrack = directPath.path.slice(0, -1).map((id, i) =>
    ({ from: id, to: directPath.path[i + 1], color: "red" }));

  const strikeEvent = {
    card: { id: 123, type: "strike", effect: "player_strike", persistent: true },
    drawingPlayerIndex: 0
  };
  const ctx = makeCtx(grid, {
    tracks: redTrack,
    activeEvents: [strikeEvent],
    players: [{ color: "red" }, { color: "blue" }]
  });

  const result = findPathOnTrack(ctx, londonId, birmId, "blue", true);
  expect(result).toBeNull();
});

// Break Case 4: Ferry ownership enforcement
test('canPlayerBuildFerry enforces 2-owner limit', () => {
  const ferryKey = "100|200";
  const ctx1 = { ferryOwnership: {} };
  const ctx2 = { ferryOwnership: { [ferryKey]: ["blue"] } };
  const ctx3 = { ferryOwnership: { [ferryKey]: ["blue", "green"] } };
  const ctx4 = { ferryOwnership: { [ferryKey]: ["blue", "red"] } };

  expect(canPlayerBuildFerry(ctx1, ferryKey, "red")).toBe(true);
  expect(canPlayerBuildFerry(ctx2, ferryKey, "red")).toBe(true);
  expect(canPlayerBuildFerry(ctx3, ferryKey, "red")).toBe(false);
  expect(canPlayerBuildFerry(ctx4, ferryKey, "red")).toBe(true); // already owns
});

// Break Case 5: Event zone parity
test('event zone precomputation matches snapshot for each event card', () => {
  const grid = generateHexGrid();
  const eventZones = precomputeEventZones(grid, EVENT_CARDS);

  for (const evt of EVENT_CARDS) {
    if (eventZones[evt.id]) {
      expect(eventZones[evt.id].sort()).toEqual(SNAPSHOT_EVENT_ZONES[evt.id].sort());
    }
  }
});

test('gale 138 zone includes expected coastal mileposts', () => {
  const grid = generateHexGrid();
  const evt = EVENT_CARDS.find(e => e.id === 138);
  const coastalStarts = getCoastalMilepostsForSeaAreas(grid, evt.seaAreas);
  expect(coastalStarts.length).toBeGreaterThan(0);
});

// Break Case 7: Client load order
// (Puppeteer/Playwright test)
test('game loads without console errors', async () => {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto('http://localhost:3000/eurorails.html');
  expect(errors).toEqual([]);
  await expect(page.locator('#setupScreen')).toBeVisible();
});

// Break Case 8: Landmass connectivity
test('landmassesConnected works for all expected pairs', () => {
  expect(landmassesConnected("continental", "italy")).toBe(true);
  expect(landmassesConnected("italy", "continental")).toBe(true);
  expect(landmassesConnected("britain", "continental")).toBe(false);
  expect(landmassesConnected("continental", "scandinavia")).toBe(false);
  expect(landmassesConnected("continental", "denmark")).toBe(true);
  expect(landmassesConnected("denmark", "scandinavia")).toBe(true);
  expect(landmassesConnected("zealand", "denmark")).toBe(true);
  expect(landmassesConnected("zealand", "scandinavia")).toBe(true);
});

// Break Case 9: Flood river crossing
test('flood destroys tracks crossing the specified river', () => {
  const grid = generateHexGrid();
  // Find a track edge that crosses the Rhine
  const rhineCrossing = findTrackCrossingRiver(grid, "rhine");
  const ctx = makeCtx(grid, { tracks: [rhineCrossing] });

  const destroyed = applyFloodEffect(ctx, "rhine");
  expect(destroyed).toContainEqual(rhineCrossing);
});
```

### Test Helper

```javascript
function makeCtx(grid, overrides = {}) {
  return {
    mileposts: grid.mileposts,
    mileposts_by_id: grid.mileposts_by_id,
    cityToMilepost: grid.cityToMilepost,
    ferryConnections: grid.ferryConnections,
    ferryOwnership: {},
    tracks: [],
    activeEvents: [],
    players: [],
    ...overrides
  };
}
```

---

## Playtest Checklist

### What to Test After Each Extraction Step

| Step | What changed | What to verify | How |
|---|---|---|---|
| 0.1: Create shared module | New file only, nothing wired | Automated tests pass in Node.js | `npm test` |
| 0.2: Wire client to shared module | Client `<script>` tag added, inline code deleted | Game loads, map renders, all gameplay works | Open `http://localhost:3000/eurorails.html`, full playtest |
| 0.3: Wire server to shared module | Server uses shared constants, old duplicates deleted | Server validation still works, multiplayer plays correctly | Two-tab multiplayer, adversarial play |
| 0.4: Server generates own grid | `setCityToMilepost` removed, server self-sufficient | Game starts correctly, events affect right mileposts | Two-tab multiplayer, play until events fire |

### Full Manual Playtest (~10 minutes)

Run this after Steps 0.2, 0.3, and 0.4:

```
Start server: npm start
Open two tabs to http://localhost:3000/eurorails.html
Create room in tab 1, join in tab 2, start game
```

1. **Map renders correctly** — No missing landmasses, terrain colors look right, cities are in correct positions, zoom/pan works
2. **Build track** — Build from London toward Birmingham. Verify cost preview matches committed cost. Verify track appears on map in correct color
3. **Build blocking** — As player 2, try to build on player 1's edges. Verify you're routed around them and cost is higher
4. **Ferry build** — Build a ferry connection (e.g., Dover-Calais). Verify cost matches ferry route cost. Verify second player can also build same ferry. Verify third player cannot
5. **Deploy train** — Place train at a city milepost. Verify train icon appears
6. **Move train** — Move along built track. Verify movement count decreases correctly. Verify you can't move off your own track (without trackage rights)
7. **Pick up good** — Pick up a good at a source city. Verify it appears in your load
8. **Deliver good** — Deliver to a demand card destination. Verify payout, card removed, new card drawn
9. **Event card** — Continue playing until an event card is drawn. Verify:
   - Strike: blocked cities/rails are actually blocked
   - Derailment: affected trains lose turn and load
   - Snow/Fog: half-speed zone renders, movement costs double
   - Flood: river tracks are destroyed
   - Gale: ferry movement blocked in zone
10. **End game** — Verify turn cycling works correctly through multiple rounds

### Abbreviated Playtest (~3 minutes)

For smaller changes or quick verification:

1. Game loads, map renders
2. Build 3-4 track segments, verify cost
3. Deploy train, move 2-3 steps
4. Pick up and deliver one good
5. End turn, verify player switch

---

## How to Make Playtesting Faster

### Use `git stash` for uncommitted exploration

```bash
# Before making changes
git stash push -m "checkpoint before extraction step X"

# Make changes, test locally
npm start
# Test in browser...

# If broken
git stash pop  # back to checkpoint

# If good, commit
git add shared/game-logic.js public/eurorails.html
git commit -m "Step 0.2: Wire client to shared game logic module"
```

### Use a scratch branch for multi-step work

```bash
git checkout -b solo-mode-phase0
# Work through steps, committing each one
# If a step breaks, revert just that commit:
git revert HEAD
# When all steps pass, merge to master
git checkout master
git merge solo-mode-phase0
```

### Keep two terminal windows open

```
Terminal 1: npm start          (restart after server.js changes)
Terminal 2: npm test           (run after any code change)
```

Note: You must restart the server (`Ctrl+C` then `npm start`) after changing `server.js` or `shared/game-logic.js`. Client changes in `public/eurorails.html` only require a browser refresh.

### Use browser DevTools console for quick validation

After the game loads, run in the console to verify the shared module loaded correctly:

```javascript
// Check constants loaded
console.log(Object.keys(CITIES).length);        // should be 52
console.log(FERRY_ROUTES.length);                // should be 8

// Check hex grid generated
console.log(gameState.mileposts.length);         // should match snapshot
console.log(Object.keys(gameState.cityToMilepost).length);  // should be 52

// Check pathfinding works
const london = gameState.cityToMilepost["London"];
const paris = gameState.cityToMilepost["Paris"];
console.log(findPath(london, paris, "red", "cheapest"));  // should return { path: [...], cost: N }
```

### Automate the snapshot comparison

```bash
# Run full test suite (includes snapshot comparison)
npm test

# Run only snapshot tests
node --test test/snapshot.test.js

# Regenerate snapshots after intentional changes
node test/generate-snapshots.js
```
