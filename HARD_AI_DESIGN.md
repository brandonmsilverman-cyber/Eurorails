# Hard AI Decision Tree Design

## Overview

The Hard AI targets a 7.5/10 difficulty level — a strong, experienced player who rarely makes poor decisions but doesn't play optimally. It should beat intermediate players consistently and be competitive with experts, with clear gaps only in subtle multi-turn optimizations.

The Hard AI is a fully independent decision module (`ai-hard.js`) that shares low-level mechanical helpers with Easy AI (e.g., `computeBuildActions`, `findCheapestBuildPath`) only where those helpers are correct and don't contribute to known Easy AI bugs. All strategic logic — target selection, plan commitment, phase behavior — is written from scratch.

### Key differences from Easy AI

| Dimension | Easy AI | Hard AI |
|---|---|---|
| Target selection | Single best demand, re-evaluated every turn | Scores delivery *plans* (single or 2-batch), committed across turns |
| Affordability | Falls back to unaffordable routes | Hard cutoff — if you can't afford it, it doesn't exist |
| Batching | None | 2-delivery batches with sequential affordability |
| Build direction | Sometimes builds into major cities (5M) | Always builds out of major cities (1M) |
| Movement | Single move action, wastes points | Movement loop — uses all movement points every turn |
| Deploy | Sometimes deploys at wrong city | Always deploys at pickup 1 — anything else is a bug |
| Upgrades | Cash > 80M heuristic (rarely triggers) | Upgrade to Fast Freight when 20M surplus exists after route costs |
| Discard | After 2 idle turns | ECU/turn threshold (2 ECU/turn) with immediate discard when no viable plan |
| Ferries | Not considered | Naturally integrated into plan cost scoring |
| Foreign track | Never uses | Not used (reserved for Brutal AI) |

### Known Easy AI bugs this design addresses

1. **Deploys at wrong city** — Easy AI can change its mind about which delivery to pursue between initial building and the first operate phase. Hard AI commits to a plan and deploys at pickup 1. Period.
2. **Wasted movement points** — Easy AI plans a single move action. Hard AI uses a movement loop that continues moving after pickups and deliveries.
3. **Gets stuck / deadlocked** — Easy AI commits to unaffordable routes and can't make progress. Hard AI uses strict affordability checks and discards immediately when no viable plan exists.
4. **Builds into major cities (5M)** — Easy AI doesn't consistently optimize build direction. Hard AI always builds out of major cities.

---

## 1. Target Selection and Commitment

### 1.1 Plan structure

A *delivery plan* is either:

- **Single delivery:** Pick up good at source, deliver to destination. Three or four cities involved (major city origin, pickup source, dropoff destination — pickup and major city may coincide).
- **2-delivery batch:** Two pickups and two dropoffs, executed in a specific sequence. The batch is only worth pursuing if the shared corridor makes the combined trip disproportionately efficient.

3-delivery batches are reserved for Brutal AI and are out of scope.

### 1.2 Enumeration

**Single candidates:** For each demand on each card in hand, and for each source city of that demand's good, compute:

- `buildCost`: cost of unbuilt track needed to connect source and destination to the existing network
- `payout`: the demand's payout
- `tripTurns`: estimated turns to complete (see §1.4)
- `planValue`: `payout / tripTurns`

**Initial building (no existing network):** During initial building, there is no existing network — the AI must start from a major city. The selected major city's milepost is treated as the player's initial network (a single-node network). This means all downstream logic — `virtualTrack` initialization in §1.3, pathfinding from "the existing network," frontier movement in §3.3 — works without special-casing: the major city milepost is in the player's network set from the start. Plan enumeration evaluates each candidate plan against **all 8 major cities** as potential starting points, using the major city as the network origin for build cost computation. The (plan, majorCity) pair that produces the highest `planValue` wins. The selected major city is stored in the plan object (`plan.majorCity`) and used directly during initial building — `selectMajorCity` simply extracts it. See §2.2 for details.

**Initial building reachability filter:** During initial building, an additional constraint applies: the build cost from the major city to pickup 1 (the first stop in the visit sequence) must be ≤ 40M (the total initial building budget: 2 rounds × 20M). This ensures the AI can deploy at pickup 1 when the first operate phase begins (§3.1). Plans where pickup 1 is unreachable within the initial building budget are excluded, even if the total plan cost passes the normal affordability check (§1.3). The remaining route (pickup 1 onward) can exceed 40M — those segments are built during normal build phases.

**Batch candidates:** Pair single candidates using a pruning filter, then evaluate surviving pairs across all 6 valid visit sequences (see §1.2.1). For each sequence, compute segment-based affordability (see §1.3) and combined scoring.

**Batch pruning rule:** Only pair two singles if they share at least one city (a source or destination of one demand is the same as a source or destination of the other) OR if any of their cities (source or destination) is within **5 hex units** of the other delivery's straight-line route (source → destination). Distance is measured as **Euclidean point-to-line-segment distance** — the perpendicular distance from the candidate city to the nearest point on the line segment connecting the other delivery's source and destination, using world coordinates. This was validated by simulation against the actual game data: at 5 hexes, the pruning catches ~87% of good batches (>15% distance savings) and ~94% of great batches (>25% savings), while cutting the search space by ~56% (from ~228 pairs per hand to ~101). Pathfinding benchmark on 1,710 mileposts shows ~1.2ms per `findPath` call, putting total target selection at ~2.9 seconds for ~2,424 pathfinds (101 pairs × 6 orderings × ~4 segments) — well within server capacity on a Render starter instance (512MB RAM, shared CPU).

### 1.2.1 Visit sequences for batches

A batch plan is defined by a **visit sequence** — an ordered list of the 4 cities the AI must visit (2 pickups + 2 deliveries). The constraint is: a good must be picked up before it can be delivered. For deliveries A and B, the 6 valid visit sequences are:

```
pA → dA → pB → dB    (sequential A-first)
pB → dB → pA → dA    (sequential B-first)
pA → pB → dA → dB    (interleaved, pick up both, deliver A first)
pA → pB → dB → dA    (interleaved, pick up both, deliver B first)
pB → pA → dA → dB    (interleaved, pick up both, deliver A first)
pB → pA → dB → dA    (interleaved, pick up both, deliver B first)
```

All 6 are evaluated for each batch pair that passes pruning. The winning sequence is whichever passes affordability and scores highest on ECU/turn. Interleaved sequences can be more efficient when two pickups are near each other — the AI picks up both goods, then delivers them in the most efficient order, avoiding backtracking.

**Invariant:** Every generated visit sequence must end with a delivery stop. `enumeratePlans` must validate this before passing sequences to `checkAffordability`. The 6 hardcoded sequences above all satisfy this, but this validation is critical for Brutal AI's extensible sequence generation (§11.5). If a sequence fails validation, log an error and skip it.

### 1.3 Segment-based affordability model

The AI does not ask "can I afford the entire batch right now?" It asks "can I afford each segment at the point in time when I need to pay for it?" Cash is checked at each **delivery point** in the visit sequence, since that's when payout is earned and the cash balance changes.

**Network attachment point:** When computing the build cost from "the existing network" to a city, the AI uses the cheapest connection — i.e., the milepost on the existing network that minimizes total build cost to the target city, as determined by pathfinding. This applies to both singles and batches.

**For single deliveries**, affordability is simply: `totalBuildCost <= player.cash`. No unaffordable fallback. If you can't afford it, it doesn't exist as an option. The build cost is: cost of unbuilt track from the existing network to the source, plus cost of unbuilt track from the source to the destination, minus any segments already built.

**For batch deliveries**, the visit sequence defines 4 segments (network → stop 1, stop 1 → stop 2, stop 2 → stop 3, stop 3 → stop 4). Each segment's build cost accounts for track already built by earlier segments in the sequence. This is implemented using a **virtual track set** — a `Set<milepostId>` that accumulates mileposts from earlier segments. The pathfinder treats mileposts in this set as already built (cost = 0), preventing double-counting when segments share corridor:

```
effectiveCash = options.effectiveCash ?? player.cash
    // Default: player.cash. Override: passed by handleNoPlan (§5.4.4)
    // when evaluating borrowing — effectiveCash = player.cash + borrowAmount.
accumulatedBuildCost = 0
virtualTrack = Set(player's existing built mileposts)  // start with real track

for each stop in visitSequence:
    segmentPath = findCheapestBuildPath(previousStop or network, thisStop, virtualTrack)
        // virtualTrack mileposts are treated as already built (cost = 0)
    segmentCost = sum of build costs for mileposts in segmentPath not in virtualTrack
    virtualTrack.addAll(segmentPath)  // future segments see this track as built
    accumulatedBuildCost += segmentCost

    if this stop is a delivery:
        // Cash checkpoint: can we afford everything built since the last delivery?
        if accumulatedBuildCost > effectiveCash → REJECT this visit sequence
        effectiveCash = effectiveCash - accumulatedBuildCost + deliveryPayout
        accumulatedBuildCost = 0

// After the loop, assert accumulatedBuildCost === 0.
// The last stop in any valid sequence is always a delivery.
// If this assertion fails, the visit sequence is malformed — log an error
// with the full sequence and reject the plan. Do not silently continue.
```

All 6 valid visit sequences (§1.2.1) are evaluated for each batch pair. The sequence that passes affordability and scores highest on ECU/turn wins.

**Example:** Visit sequence pA → pB → dB → dA. Cash = 30M.

```
segment 1: network → pA = 8M     (accumulated: 8M)
  pA is a pickup, no cash check
segment 2: pA → pB = 5M          (accumulated: 13M)
  pB is a pickup, no cash check
segment 3: pB → dB = 7M          (accumulated: 20M)
  dB is a delivery! Check: 20M <= 30M ✓
  effectiveCash = 30 - 20 + 15(payout B) = 25M
  accumulatedBuildCost = 0
segment 4: dB → dA = 10M         (accumulated: 10M)
  dA is a delivery! Check: 10M <= 25M ✓
  effectiveCash = 25 - 10 + 20(payout A) = 35M
```

**Mid-execution affordability re-check:** When re-checking affordability for an in-progress plan (flood response §6.2.3, tax response §6.2.6), the check must be scoped to **remaining segments only** — segments at or after `plan.currentStopIndex`. Already-traversed segments are sunk costs: the AI has already picked up goods from those stops and does not need to revisit them, so destroyed track in those segments is irrelevant to completing the current plan. The re-check uses `player.cash` as `effectiveCash` and iterates only from the current segment forward. Payouts from already-completed deliveries are already reflected in `player.cash`, so cash checkpoints at remaining delivery stops work correctly. Already-traversed segments are **not** included in `virtualTrack` for cost computation — only the player's current built mileposts (with flood damage removed) and mileposts from earlier *remaining* segments are accumulated.

**Known approximation — partial segment overcount:** The "remaining segments" boundary is at segment granularity (`currentStopIndex`), not at the train's exact milepost within a segment. If the AI is mid-transit through a segment (left stop N-1, heading toward stop N) and a flood destroys track *behind* the train on the same segment (between stop N-1 and the train's current position), the re-check includes the rebuild cost of that behind-the-train track. This is conservative — the AI doesn't need that track to complete the plan (it only moves forward), so the re-check may overestimate remaining cost and trigger false abandonment. The same overcount affects `computeBuildOrder`: it may rebuild destroyed track behind the AI on the current segment, wasting build budget on track that will never be traversed again. Both are accepted approximations — a precise fix would require sub-segment position tracking, adding complexity disproportionate to the frequency and impact of the scenario (flood must hit a river crossing on the current segment, behind the train, with enough cost to change the affordability outcome). If playtesting reveals this causes visible misplays, the fix is to scope the re-check from the AI's current milepost forward within the current segment, and to teach `computeBuildOrder` to skip destroyed track behind the train.

### 1.4 Turn estimation

Build turns are estimated **per segment group**, where a segment group is the set of consecutive segments between two cash checkpoints (deliveries). This correctly accounts for mid-plan cash changes — the AI spends cash building early segments, earns payout from the first delivery, then has a different cash balance when estimating build time for later segments.

```
effectiveCash = options.effectiveCash ?? player.cash
    // Same override as §1.3 — threaded from selectPlan for borrowing evaluation.
totalBuildTurns = 0
groupBuildCost = 0

for each segment in plan.segments:
    groupBuildCost += segment.buildCost

    if this segment ends at a delivery stop:
        // Estimate build turns for this group
        cashPerTurn = min(20, effectiveCash) * 0.75
            // 20M = max build spend per turn
            // 0.75 factor accounts for terrain costs and inefficiency
        if cashPerTurn > 0:
            totalBuildTurns += groupBuildCost / cashPerTurn
        else:
            totalBuildTurns += Infinity  // can't afford → plan rejected

        // Update cash state for the next group
        effectiveCash = effectiveCash - groupBuildCost + deliveryPayout
        groupBuildCost = 0

// Note: groupBuildCost should be 0 here because the last stop
// in any valid visit sequence is always a delivery

operateTurns = ceil(tripDistance / trainSpeed)
    // tripDistance is measured as **track-based distance** (milepost count along
    // the planned build path), NOT Euclidean/straight-line distance. The build path
    // is already computed during plan selection (§3.3, A.25), so this is free.
    // For batches, sum the milepost count between consecutive visit-sequence stops
    // along the build path: (train → stop1) + (stop1 → stop2) + ... + (stopN-1 → stopN).
    // For the first plan (train not yet deployed), the train starts at pickup 1,
    // so travel-to-first-stop is 0. For subsequent plans, the train is already
    // on the map and must move along existing track to reach the first stop.
    // tripDistance = distanceFromTrainToFirstStop + distanceThroughVisitSequence

totalTurns = max(totalBuildTurns, operateTurns)
    // Build and operate phases are interleaved within each game turn — the AI
    // moves toward the build frontier during operate while extending track during
    // build. The total time is whichever phase takes longer, not the sum.
planValue = totalPayout / max(totalTurns, 1)
```

**For single deliveries**, there is only one segment group (all segments before the single delivery), so this simplifies to the same formula as before.

**Example** (pA → pB → dB → dA, cash = 30M, payout B = 15M, payout A = 20M):

```
Group 1 (network→pA + pA→pB + pB→dB): buildCost = 8+5+7 = 20M
  cashPerTurn = min(20, 30) * 0.75 = 15M
  buildTurns = 20/15 = 1.33

  effectiveCash = 30 - 20 + 15 = 25M

Group 2 (dB→dA): buildCost = 10M
  cashPerTurn = min(20, 25) * 0.75 = 15M
  buildTurns = 10/15 = 0.67

totalBuildTurns = 1.33 + 0.67 = 2.0
```

Compare to naive single-group: totalCost=30M, cashPerTurn=15M → 2.0 turns. In this example the results coincide, but they diverge when the first delivery's payout significantly changes the cash balance available for later segments.

### 1.5 Plan selection

Rank all viable plans (singles and affordable batches) by `planValue` (ECU per turn). Select the highest-scoring plan. Store in `aiState` as the committed plan.

`selectPlan` accepts an optional `options` object with an `effectiveCash` field. When provided, this overrides `player.cash` in the §1.3 affordability check and §1.4 turn estimation. This is used by `handleNoPlan` (§5.4.4) to evaluate plans under hypothetical borrowing amounts without mutating game state. The override is threaded through: `selectPlan` → `checkAffordability` → `effectiveCash` initialization. When omitted, `player.cash` is used as the default.

### 1.6 Commitment rules

The committed plan persists across phases and across turns. The AI does **not** re-evaluate between operate and build within a turn.

The plan is abandoned only when:

- All deliveries in the plan are complete → re-run full target selection
- **Cargo integrity failure:** A good the AI should be carrying (based on visited pickup stops) is missing from the player's actual cargo. This catches goods lost to derailment (§6.2.1) or any other external removal. → abandon plan, create residual plan for any surviving carried goods (§3.4), then re-run full target selection
- A flood event destroys track required for the plan **and** the rebuild cost makes the plan unaffordable (re-check §1.3 affordability with updated track state and current cash) → re-run full target selection. If the rebuild is affordable, keep the plan — the destroyed track will be rebuilt in the next build phase.
- The good needed for pickup is unavailable at the source (supply exhausted) → abandon plan immediately, deliver any good currently being carried, then re-run full target selection
- The AI has been stuck for 3+ consecutive turns with no progress → re-run full target selection

**Definition of "progress":** A turn counts as making progress if **any** of the following occurred:

1. Built at least one track segment toward the committed plan's route
2. Picked up a good from the visit sequence
3. Delivered a good from the visit sequence
4. Moved closer to the next target: if the next visit-sequence stop is reachable on owned track, track distance to that stop decreased. If not reachable (frontier movement), track distance to the **frontier milepost** (§3.3) decreased — the AI is positioning closer to the build frontier, not the unreachable stop itself. Once track is extended and the stop becomes reachable, the metric switches to measuring to the stop directly.

If none of these four conditions are met for 3 consecutive turns, the plan is abandoned. The stuck counter (`aiState.stuckTurnCounter`) resets to 0 whenever any condition is met. The threshold is 3 (not 2) to naturally absorb temporary event disruptions (strikes, fog, gales) without needing event-detection logic. Most events last 1 turn — the counter increments during the event, then resets when the AI resumes progress. Only genuinely stuck situations (can't afford to build, can't reach target, no delivery progress) persist for 3+ turns.

**Interaction with discard loop (§5.4):** The stuck counter and the consecutive discard counter can create a cycle: stuck → abandon → no affordable plan → discard twice → borrow → commit to marginal plan → stuck again. This cycle is self-correcting: each borrow adds 2× debt, raising the bar for future plans' effective ECU/turn, making the AI increasingly likely to discard rather than borrow again. Eventually the AI draws cards that align with its existing network (low build cost) and escapes naturally. This is expected behavior, not a bug — do not add a circuit breaker.

**Note:** Re-evaluation after each completed dropoff (mid-batch) is reserved for Brutal AI.

### 1.7 Cash crunch / no viable plan

If no candidate plan passes the affordability filter, discard hand immediately. Do not waste turns being stuck. Fresh cards that align with existing track will score much higher (build cost ≈ 0).

---

## 2. Initial Rail Building

### 2.1 Plan-driven building

The AI runs full target selection (§1) before its first build. It evaluates both single and 2-batch candidates and picks the best affordable plan. All initial building serves this committed plan.

### 2.2 Major city selection

Major city selection is **jointly optimized with plan selection** during initial building. When the AI has no existing network, `selectPlan` (§1.2) evaluates every candidate plan against all 8 major cities and picks the (plan, majorCity) pair with the highest `planValue`. The winning major city is stored in `plan.majorCity`.

`selectMajorCity` is a thin accessor: during initial building, it returns `plan.majorCity` (already determined by `selectPlan`). For subsequent plans (where an existing network exists), `selectMajorCity` is not called — the AI builds from its existing network, not a major city.

This joint optimization naturally favors major cities that are directionally aligned with the full delivery corridor. A major city "behind" the route (so that initial track contributes to the overall corridor) will cost less than one off to the side that creates a spur. No additional affordability filter is applied per major city — the plan already passed the affordability check (§1.3), and the AI has two initial building rounds (up to 40M total) to complete construction.

### 2.3 Build sequence

The AI always builds segments in **visit-sequence order** — the same order it plans to operate through them. It never builds a later segment before an earlier one. This is deliberate:

1. The AI can't operate (pick up / deliver) until the track to the next stop exists, so building later segments first would waste operate turns.
2. The segment-based affordability model (§1.3) and turn estimation (§1.4) both assume segments are built in visit-sequence order. Building out of order would break the cash checkpoint assumptions.
3. Out-of-order building adds complexity for marginal benefit. The Hard AI is disciplined, not clever.

Concretely, the AI builds cities in the order it plans to visit them on the trip:

**Round 1:**
1. Connect from the selected major city toward pickup 1 (the first city in the execution sequence)
2. If budget remains after reaching pickup 1, continue building toward the next city in the trip sequence

**Round 2:**
3. Continue building from wherever round 1 left off, following the trip sequence
4. Keep extending until budget is exhausted or the entire planned route is connected

**Important:** If the full route costs less than 40M (the combined budget of two initial building rounds), the AI stops building once the route is complete. It saves remaining cash for future plans. There is no speculative building beyond the committed plan.

### 2.4 Build direction rule

**Rule: always build out of major cities, never into them.**

If the AI needs to connect its existing track to a **major city**, it starts the build from that major city outward toward the existing track. Since building out of a disconnected major city is always legal (you can start a new build segment from any major city), the AI pays 1M for the first milepost instead of 5M to enter the city — a 4M savings per major city.

**This rule applies only to major cities.** Minor cities do not allow starting a disconnected build, so the AI must always build into them from the existing network, paying the 3M entry cost. There is no way to avoid this cost for minor cities.

This rule applies during initial building and all subsequent build phases.

**Cost computation interaction:** `findCheapestBuildPath` must account for this rule when computing segment costs. When a segment's target city is a major city not yet in the player's network (or `virtualTrack` set), `findCheapestBuildPath` computes the path as building **out** from the major city (1M exit cost) rather than **into** it (5M entry cost). This ensures the §1.3 affordability check and §1.4 turn estimation use the correct (lower) cost that `computeBuildOrder` will actually pay. Without this, affordability systematically overestimates by 4M per mid-route major city, causing the AI to reject plans it can actually afford. The `buildPath` milepost sequence returned by `findCheapestBuildPath` is stored in path order (source → target) for use by the movement loop (§3.2); `computeBuildOrder` reverses the build direction for major-city segments as needed (§4.2).

### 2.5 Batch ordering for initial building

For a 2-batch route, the AI builds in **visit-sequence order** — the same order determined by plan selection (§1.2.1). The visit sequence was chosen as the ordering that passes affordability and maximizes ECU/turn, so initial building simply follows it: connect the first stop first, then the second, and so on.

---

## 3. Operating Phase

### 3.1 Train deployment

**First plan (train not yet deployed):** Deploy at pickup 1 in the committed plan. Always. The deployment is implemented as a preamble in `planMovement` (§3.2) — before entering the movement loop, `planMovement` checks whether the train is deployed and emits a `{ type: 'deployTrain' }` action if not.

**Normal case (plan committed during initial building):** The initial building reachability filter (§1.2) guarantees that pickup 1 is reachable within the 40M initial building budget, so the track to pickup 1 will always be built by the time the first operate phase begins.

**Edge case (plan committed post-initial-building via borrowing):** If initial building failed to commit a plan (e.g., no affordable plan with starting cash) and the AI later commits a plan via `handleNoPlan`'s borrowing path (§5.4.4), the §1.2 reachability filter did not run — that filter only applies during initial building. To prevent deploying at an unreachable pickup 1, `selectPlan` applies a **deployment reachability guard** when the train has never been deployed: pickup 1 must be reachable on the player's existing track (i.e., the milepost for pickup 1 must be in the player's built track set, or connected to it via owned track). Plans failing this guard are excluded. If the player has no track at all, only plans where pickup 1 is a major city pass — the AI can deploy there and the build phase will extend track outward. If no plan passes the guard, `selectPlan` returns null and `handleNoPlan` discards (the AI must build track first via future build phases before any plan is viable).

If pickup 1 is not connected to the network at the time of deployment and neither the §1.2 filter nor the deployment reachability guard was applied, this is a bug. Log a detailed error with the committed plan, track built so far, current cash, and what happened during initial building. Do not attempt graceful fallback — fail loudly so the bug can be traced.

**Subsequent plans (train already on the map):** The train does not redeploy. It stays at its current location and moves along existing track toward the new plan's first stop. This means:

1. **Plan selection accounts for train position.** When scoring candidate plans for a subsequent plan, `tripHexDistance` (§1.4) includes the track-based travel distance from the train's current position to the first stop in the visit sequence. A plan whose first pickup is near the train scores higher than one requiring a long backtrack.
2. **No new track needed to reach the train.** The train is already on the network. It can reach any connected city by moving along owned track. The build cost for a subsequent plan only covers unbuilt segments between visit-sequence stops — not track from the train to the first stop (that track already exists or the AI moves there on existing track).
3. **Edge case: train on a disconnected segment.** If a flood destroyed track and isolated the train from the main network, this is a special case of §6.2.3 — the flood's rebuild cost includes reconnecting the train's segment. The §1.3 affordability re-check determines whether to keep the plan (rebuild in the next build phase) or abandon. While stranded, the movement loop (§3.2) finds no path to any stop and the train stays put. The build phase prioritizes rebuilding the destroyed crossing to reconnect the train. The 3-turn stuck counter (§1.6) provides a safety net if the rebuild takes too long.

### 3.2 Movement loop

The Hard AI uses a loop that consumes all available movement points. The committed plan's **visit sequence** (§1.2.1) defines the stops in order. The AI tracks its current position in the visit sequence (which stop it's heading toward next).

**Deployment preamble:** Before entering the movement loop, `planMovement` checks whether the train is deployed. If the train is not yet on the map (first operate phase after initial building), emit a `{ type: 'deployTrain', city: pickup1 }` action placing the train at pickup 1 in the committed plan. The initial building reachability filter (§1.2) guarantees pickup 1 is connected. After deployment, the train is at pickup 1 — the movement loop's first iteration will immediately trigger step 1's pickup logic for that city. If the train is already deployed (subsequent plans), skip this preamble — the train moves along existing track via the loop below.

```
// Deployment preamble
if train not deployed:
    emit { type: 'deployTrain', city: plan.visitSequence[0].city }
    // Train is now at pickup 1. Fall through to movement loop.

while movement_points_remain:
    nextStop = next unvisited stop in the visit sequence
    if no nextStop: break  // all deliveries complete — plan done

    1. Am I at nextStop?
       → If nextStop is a pickup city:
           Check if the good is available at this city.
           If available: pick up the good.
           If NOT available (supply exhausted): trigger §3.4 — abandon plan,
             create residual plan if carrying, break out of loop.
       → If nextStop is a delivery city: deliver the good
       → Advance to the next stop in the visit sequence
       → Continue loop (don't break — use remaining movement)

    2. Not at nextStop — is nextStop reachable on owned track?
       a. YES (track reaches nextStop):
          → Compute path to nextStop on owned track
          → Move as far along that path as movement points allow
          → If arrived at nextStop, go back to step 1
          → If not arrived (ran out of movement), end loop

       b. NO (track doesn't reach nextStop yet — frontier movement, §3.3):
          → Find the frontier milepost: the farthest milepost on owned track
            that is on the planned build path (plan.buildPath) toward nextStop
            AND is reachable from the train's current position on owned track
            (same connected component — see §3.3)
          → If no reachable owned track overlaps the build path, use the milepost
            on owned track reachable from the train that is closest (Euclidean)
            to the network attachment point
          → Compute path to the frontier milepost on owned track
          → Move as far along that path as movement points allow
          → End loop (can't make further progress until track is extended)

// After the loop: if all stops are visited (currentStopIndex >= visitSequence.length),
// clear the committed plan from aiState. The plan is complete. The build phase will
// see getCommittedPlan() return null and handle accordingly (§11.3, §4.3).
```

This is simpler than the Easy AI's approach because there's no conditional logic about what to do — the visit sequence already encodes the optimal order of pickups and deliveries, including any interleaving. The AI just follows the sequence.

**Example:** Visit sequence pA → pB → dB → dA. The AI moves to pA, picks up good A. Continues toward pB, picks up good B. Continues toward dB, delivers good B. Continues toward dA, delivers good A. Each pickup and delivery is just the next stop in the sequence.

### 3.3 Frontier movement (plan-aware)

When the track doesn't reach the next target city yet, the AI moves to the **frontier milepost on its existing track that is on the planned build path**. This is the milepost closest to where the next segment of track will be built. The `plan.buildPath` (full milepost-by-milepost route) is available because it is computed and stored during plan selection (§1.2) — the pathfinding that produces build costs also produces the milepost sequence as a side effect.

**Connected-component constraint:** The frontier milepost must be **reachable from the train's current position on owned track** — i.e., on the same connected component. The build-out-of-major-city rule (§2.4) can create disconnected track islands: when `computeBuildOrder` builds outward from an unconnected major city mid-route, those mileposts are on the `plan.buildPath` and on owned track, but not reachable from the train. Without this filter, the frontier logic would select an unreachable milepost, `findTrackPath` would return no path, and the train would be stuck with no fallback.

Implementation: compute the set of mileposts reachable from the train's current position on owned track (BFS/flood-fill, cached once per turn since track doesn't change within a turn). Filter `plan.buildPath` candidates to this reachable set before selecting the farthest.

**Fallback:** If no **reachable** owned track overlaps the planned build path (e.g., building hasn't started for the current segment, or all overlapping track is on disconnected islands from build-out), the AI moves to the milepost on **reachable** owned track that is closest (**Euclidean distance**) to the **network attachment point** — the spot where the planned build path will connect to the existing network. This positions the train so that once building begins and extends from that attachment point, the train is already nearby.

This is different from Easy AI's frontier logic (which uses Euclidean distance to the target city). The Hard AI knows its build plan and positions the train at the exact extension point so that when new track is built next turn, the train is already there.

### 3.4 Supply exhaustion

If the AI arrives at the planned pickup source and the good is not available (supply exhausted):

1. **Abandon the plan immediately.** Do not search for alternate source cities.
2. If the AI is currently carrying a good from a previous pickup in the batch, create a **residual single-delivery plan** for the carried good. This residual plan contains one delivery entry (the carried good and its destination from the original demand card) and a visit sequence with a single stop (the delivery destination). The build path is recomputed from the train's current position. All plan-based machinery (movement loop, build phase, commitment rules) works unchanged — the residual plan is just a normal single-delivery plan. The AI executes this residual plan to completion before replanning.
3. After delivering (or immediately if not carrying anything), re-run full target selection and commit to a new plan.

---

## 4. Build Phase (Post-Operate)

### 4.1 Build priority

Build the next unbuilt segment of the committed plan, in execution order. The AI knows the full route and what has been built — it picks up where it left off.

### 4.2 Build direction

Same universal rule as §2.4: **always build out of a major city, never into one.** If the next segment of the plan connects to a major city, start the build from that major city outward toward existing track.

**Build-order reversal for major-city segments:** The `plan.buildPath` stores mileposts in movement order (source → target), but when a segment's target is a major city, `computeBuildOrder` must reverse the build direction for that segment — constructing mileposts starting from the major city and working outward toward the existing network. Concretely, `computeBuildOrder` iterates through the plan's segments in visit-sequence order. For each segment with unbuilt mileposts, it checks whether the segment's target city is a major city not yet connected to the player's track. If so, it emits build actions in reverse milepost order (from the major city outward). If the target is not a major city (or is already connected), it emits build actions in forward milepost order (extending from existing track toward the target). The cost per milepost is identical in both directions — the savings come from paying 1M to exit the major city rather than 5M to enter it, and this cost difference is already reflected in the segment's `buildCost` (computed correctly by `findCheapestBuildPath` per §2.4's cost computation interaction note).

### 4.3 Budget discipline

Spend up to 20M (or remaining cash, whichever is less) extending track along the planned route. Stop when budget is exhausted or the route is fully built.

If the plan's route is fully built and budget remains — **save it**, unless the AI is in endgame mode (§8.3). In endgame mode, `computeBuildOrder` directs remaining budget toward connecting unconnected major cities (cheapest first). Outside of endgame, do not speculatively build. The AI will select a new plan after completing current deliveries.

### 4.4 Train upgrade evaluation

At the start of each build phase, before building track, evaluate whether to upgrade to **Fast Freight** (the only upgrade the Hard AI considers — Heavy Freight and Superfreight are deferred to Brutal AI). The upgrade costs 20M.

The decision is simple: upgrade when you can afford it without jeopardizing your current plan.

**Gate 1: Can the AI afford to complete its entire committed route?**

Compute the total remaining build cost for the committed plan's unbuilt segments. If `remainingBuildCost > player.cash`, the AI can't even finish its route — upgrading is out of the question.

**Gate 2: Is there 20M surplus after the route is fully funded?**

```
surplus = player.cash - remainingBuildCost
if surplus >= 20M → UPGRADE to Fast Freight
else → BUILD TRACK
```

That's it. No payback period calculation, no game-length estimation. The logic is: if you have 20M sitting around after your route is paid for, faster speed is always better than hoarding cash. The speed benefit compounds across every future delivery for the rest of the game.

**Upgrading consumes the entire build phase.** When the AI upgrades, it does not also build track that turn. The surplus gate (Gate 2) ensures this is low-cost — if 20M surplus exists after the route is funded, the route is either fully built or nearly so, meaning the "lost" build turn wastes little.

This naturally handles timing: early game, surplus cash is rare because track is expensive. The upgrade tends to happen mid-game once the AI has an established network and new plans require less building — which is exactly when a strong player would upgrade.

**Gate 3 (endgame only): Would the 20M be better spent on major city connections?**

When `aiState.endgameMode` is true and `citiesNeeded > 0`, `shouldUpgrade` computes the **total connection cost** for all needed major cities — the sum of build costs for the `citiesNeeded` cheapest unconnected major cities (each building out per §2.4). The decision:

```
totalCityConnectionCost = sum of cheapest citiesNeeded connection costs
surplusAfterUpgrade = surplus - 20  // what's left if we upgrade

if surplusAfterUpgrade >= totalCityConnectionCost:
    // Can afford both upgrade AND all city connections → UPGRADE
    // Speed helps complete the winning delivery faster
    UPGRADE to Fast Freight
else:
    // Upgrading would starve city connections → SKIP upgrade
    // Saving the 20M for connections is worth more than speed
    BUILD TRACK
```

This ensures the AI upgrades only when it won't jeopardize the win condition. With 2 cities needed costing 15M + 18M = 33M and surplus = 50M: `surplusAfterUpgrade = 30M >= 33M` is false → skip upgrade, save cash. With surplus = 60M: `surplusAfterUpgrade = 40M >= 33M` → upgrade. This duplicates a small piece of `computeBuildOrder`'s endgame logic (§8.3) but is necessary because the upgrade decision (§11.3) is evaluated before `computeBuildOrder` runs.

---

## 5. Hand Discard Timing

### 5.1 Immediate discard (no viable plan)

If no candidate plan passes the affordability filter during target selection, discard hand immediately. Do not waste turns being stuck.

### 5.2 Threshold-based discard (weak hand)

If the best viable plan scores below **2 ECU/turn**, discard — unless the AI has already discarded **2 consecutive times** via this threshold check. (The universal carrying guard in §5.3 prevents `shouldDiscard` from being reached when the AI is carrying a good, so no carrying check is needed here.)

The counter `aiState.consecutiveWeakDiscards` tracks this. It is incremented inside `shouldDiscard` as a side effect when the function returns true (weak plan triggers discard). It resets to 0 whenever the AI commits to a plan. After 2 consecutive weak discards, `shouldDiscard` returns false — the AI accepts the best available plan regardless of its ECU/turn. A bad delivery that earns cash and extends the network toward new corridors is always better than infinite discarding.

This is separate from `aiState.consecutiveDiscards` (§5.4), which tracks the no-viable-plan case. The two counters address different failure modes: `consecutiveDiscards` detects cash shortages (fixed by borrowing), `consecutiveWeakDiscards` detects network-position problems (fixed by accepting a marginal plan that improves position).

The 2 ECU/turn threshold is an initial value to be tuned through playtesting with the aid of decision logs.

### 5.3 Never discard while carrying

**This is the universal guard for all discard paths.** If the AI is carrying a good, `shouldDiscard` returns false immediately — before evaluating the §5.2 threshold or any other discard logic. The AI must deliver the carried good before considering a discard. Abandoning a delivery mid-transport wastes the pickup and movement investment.

---

### 5.4 Borrowing Decision

The game allows borrowing up to 20M from the bank, repaid at double (auto-deducted 10M per delivery until fully repaid). The 2× penalty is severe — it drags down every future delivery until the debt is cleared and can trap the AI in a debt spiral. The Hard AI strongly prefers discarding over borrowing.

#### 5.4.1 When to borrow: discard loop detection

The AI only borrows when it detects a **discard loop** — it has discarded **2 consecutive times** because no affordable plan existed either time. At this point the AI has already lost 2 full turns to discarding and is about to lose a third. Borrowing becomes the lesser evil.

```
if aiState.consecutiveDiscards >= 2:
    // Discard loop detected — borrow to break out
    evaluate borrowing (see §5.4.2)
else:
    // Prefer discarding — fresh cards might align with existing track
    discard and increment aiState.consecutiveDiscards
```

The counter `aiState.consecutiveDiscards` resets to 0 whenever the AI commits to a plan (i.e., does anything other than discard). It also resets to 0 when `shouldDiscard` triggers a weak-plan discard (§5.2) — the AI found a viable plan (proving cash isn't the problem), so the no-plan discard loop is broken. Only truly consecutive no-plan turns should trigger borrowing.

#### 5.4.2 Borrowing evaluation

When a discard loop is detected, the AI evaluates borrowing amounts [5, 10, 15, 20] (whichever are available given the 20M cap minus existing borrowing). For each amount, re-run plan evaluation with `effectiveCash = player.cash + borrowAmount`.

For each borrowAmount that unlocks a viable plan:

```
totalDebt = player.outstandingDebt + borrowAmount * 2
deductionsThisPlan = min(totalDebt, plan.numDeliveries * 10)
    // Each delivery auto-deducts 10M. A single delivery can only repay 10M,
    // a 2-batch can repay up to 20M. Remaining debt carries to future plans.
effectivePayout = plan.totalPayout - deductionsThisPlan
effectiveEcuPerTurn = effectivePayout / plan.estimatedTurns

if effectiveEcuPerTurn > 0:
    // Plan is viable even after repayment — borrow
    BORROW borrowAmount and commit to this plan
```

The AI picks the **smallest** borrowAmount that produces a positive effective ECU/turn. This minimizes the debt burden. If no borrowAmount produces a viable plan, discard again (the situation is truly dire — bad cards and bad network position).

#### 5.4.3 Restrictions

- **Borrowing while in debt is allowed if the math supports it.** The effective ECU/turn calculation (§5.4.2) accounts for total outstanding debt via per-delivery deductions (`min(totalDebt, numDeliveries * 10)`). The 2× repayment penalty on stacked debt naturally discourages repeated borrowing — more debt means more deductions per delivery, dragging down effective ECU/turn. No separate "avoid while in debt" rule is needed; the math handles it.
- **Never borrow during initial building.** The AI starts with 20M, which is always enough to begin building toward a plan.
- **Never borrow proactively.** Borrowing only happens to escape a discard loop, never to improve an already-viable plan. A plan that's affordable without borrowing will always score higher than the same plan with a 2× repayment drag.

#### 5.4.4 `handleNoPlan` function spec

`handleNoPlan(gs, playerIndex, ctx, strategy)` is called by `planTurn` (§11.3) when `selectPlan` returns null (no candidate plan passes affordability). It implements the discard-loop detection and borrowing flow from §5.4.1–§5.4.3.

**Returns:** An array of game actions — either `[{ type: 'discardHand' }]` or `[{ type: 'borrow', amount }, ...movementActions]` (borrow, then operate normally in the same turn via `strategy.planMovement`).

**Logic:**

```
function handleNoPlan(gs, playerIndex, ctx, strategy) {
    if aiState.consecutiveDiscards < 2:
        aiState.consecutiveDiscards += 1
        return [{ type: 'discardHand' }]

    // Discard loop detected — evaluate borrowing (§5.4.2)
    // Note: if the train has never been deployed, selectPlan applies the
    // deployment reachability guard (§3.1) — only plans whose pickup 1 is
    // reachable on existing track (or is a major city if no track exists)
    // are considered. This prevents deploying at an unreachable city.
    for borrowAmount in [5, 10, 15, 20] (filtered by borrowing cap):
        effectiveCash = player.cash + borrowAmount
        plan = strategy.selectPlan(gs, playerIndex, ctx, { effectiveCash })
        if plan exists:
            totalDebt = player.outstandingDebt + borrowAmount * 2
            deductionsThisPlan = min(totalDebt, plan.numDeliveries * 10)
            effectiveEcuPerTurn = (plan.totalPayout - deductionsThisPlan) / plan.estimatedTurns
            if effectiveEcuPerTurn > 0:
                aiState.consecutiveDiscards = 0
                commitPlan(gs, playerIndex, plan)
                movementActions = strategy.planMovement(gs, playerIndex, ctx, plan)
                // Borrow is an instant action — the AI borrows, then operates
                // normally in the same turn. It already lost 2 turns to discarding;
                // losing a 3rd to borrowing would be unnecessarily punishing.
                return [{ type: 'borrow', amount: borrowAmount }, ...movementActions]

    // No borrowing amount unlocks a viable plan — discard again
    // (consecutiveDiscards stays >= 2, so next turn will retry borrowing)
    return [{ type: 'discardHand' }]
}
```

---

## 6. Ferries and Events

### 6.1 Ferry Investment

Ferries are not a separate decision. They are integrated into the plan scoring framework.

When the AI evaluates candidate plans, some plans involve cities on landmasses only reachable by ferry (Britain, Scandinavia, etc.). The ferry cost is included in `remainingBuildCost` for that plan. The ECU/turn scoring handles the rest — a plan requiring an expensive ferry will score lower than an equivalent plan without one, but a high-payout delivery to London might still win if the ECU/turn beats all alternatives.

The reusability of ferries (once built, they benefit all future plans using that crossing) is not explicitly modeled. It will emerge naturally: future plans using an already-built ferry will have lower build costs and thus score higher. Explicit future-value modeling of ferry access is reserved for Brutal AI.

---

### 6.2 Event Card Response

The Hard AI does not predict events — it reacts when they fire. The AI's plan commitment model means events are handled as interruptions to an existing plan, not factors in plan selection.

#### 6.2.1 Derailments

If the AI's train is within the derailment radius, it loses its carried goods and its next turn. Response:

- If the lost goods were part of the committed plan (already picked up, en route to delivery), the AI **abandons the plan** and replans. The delivery is no longer completable without re-picking up the good.
- If the AI wasn't carrying anything relevant to the plan, no plan change — just lose the turn.
- The stuck counter (§1.6) increments normally for the lost turn. The 3-turn threshold absorbs this single-turn disruption without false abandonment, consistent with the general principle (§6.2.7) that the counter always increments with no event-detection logic.

**Abandonment mechanism:** Derailment is an event processed outside the AI's turn — the carried goods are removed from game state during event resolution, not during `planMovement`. The abandonment is detected by `shouldAbandon` (§11.3) at the start of the AI's next active turn via a **cargo integrity check**: `shouldAbandon` verifies that the AI's actual carried goods match what the plan expects at the current `currentStopIndex`. Specifically, for each pickup stop already visited (index < `currentStopIndex` with `action: "pickup"`), the corresponding good must still be in the player's cargo — unless a delivery stop for that good has also been visited. If any expected good is missing, `shouldAbandon` returns true. This check is general-purpose: it catches derailment losses, and any other future mechanism that might remove carried goods.

When `shouldAbandon` fires due to missing cargo, `abandonPlan` checks whether the AI is still carrying any goods relevant to the plan. If carrying nothing (typical after derailment destroys all goods), no residual plan is created — the committed plan is simply cleared and `planTurn` falls through to `selectPlan`. If carrying some goods but not others (e.g., derailment destroyed one of two carried goods — not possible in current rules but defensive), a residual plan is created for the surviving good per §3.4.

#### 6.2.2 Strikes (coast restriction, coastal blockade, rail closure)

Strikes block cities or track temporarily. Response:

- **During operate phase:** If the AI's next visit-sequence stop is in a blocked city, skip movement toward it this turn. The AI does **not** abandon the plan — strikes are temporary. Wait it out. Move toward the next reachable stop if possible, or stay put.
- **During build phase:** If rail closure prevents building, skip the build phase. Do not abandon the plan.
- The stuck counter increments normally during strike-affected turns, but the 3-turn threshold (§1.6) absorbs typical 1-turn disruptions without false abandonment.

#### 6.2.3 Floods (river crossing destruction)

Floods destroy all track crossing a specific river. Response:

- If the destroyed crossings are part of the committed plan's route (track already built that the AI needs for movement or that's part of unbuilt segments), the AI re-runs the §1.3 **mid-execution affordability re-check** with the updated track state (destroyed mileposts removed from the player's built set) and current cash. The re-check is scoped to remaining segments only (from `plan.currentStopIndex` forward) — already-traversed segments are sunk costs and destroyed track behind the AI is irrelevant to completing the current plan. If the remaining plan still passes affordability, continue — the destroyed track will be rebuilt in the next build phase. If unaffordable, **abandon and replan**.
- **Stranded train:** If the flood isolates the train from the main network, this is covered by the same affordability check — the rebuild cost includes reconnecting the train's segment. While stranded, the train stays put during operate (no reachable stops). The build phase prioritizes rebuilding the destroyed crossing. The 3-turn stuck counter (§1.6) abandons the plan if the rebuild takes too long.
- Floods are the only event that can trigger plan abandonment (§1.6) — they permanently destroy track.

#### 6.2.4 Snow and fog (half-speed, terrain impassable, no building)

These are temporary movement/building restrictions. Response:

- **Half-speed:** The AI's movement loop naturally handles reduced speed — it just gets fewer effective movement points that turn. No plan change needed.
- **Terrain impassable (snow in mountains/alpine):** If the AI's route passes through impassable terrain this turn, it cannot move along those segments. Wait it out — the restriction is temporary. Do not abandon the plan.
- **No building (fog):** Skip building in the affected area this turn. Do not abandon the plan.
- The stuck counter increments normally during weather-affected turns, but the 3-turn threshold (§1.6) absorbs typical 1-turn disruptions without false abandonment.

#### 6.2.5 Gales (ferry blocked, half-speed)

Gales block ferry crossings and reduce speed. Response:

- If the AI's plan requires a ferry crossing blocked by a gale, wait it out. Gales are temporary. Do not abandon the plan.
- Half-speed is handled the same as snow (§6.2.4).

#### 6.2.6 Tax

The AI pays the required tax. This reduces available cash, which may affect affordability for unbuilt segments. If the tax payment makes the remaining plan unaffordable (re-run the §1.3 **mid-execution affordability re-check** scoped to remaining segments from `plan.currentStopIndex` forward, with updated cash), **abandon and replan**.

#### 6.2.7 General principle

The Hard AI's event response follows a simple rule: **temporary disruptions are waited out, permanent damage triggers replanning.** Only floods and tax (cash reduction) can cause plan abandonment. All other events are temporary and the AI rides them out. The stuck counter (§1.6) increments normally during event-affected turns — the 3-turn threshold naturally absorbs 1-turn disruptions without false abandonment, eliminating the need for event-detection logic in the stuck counter.

---

## 7. Logging Requirements

Every decision point must log its inputs, alternatives considered, and reasoning. This is critical for debugging unexpected behavior and tuning parameters (discard threshold, upgrade payback period).

### 7.1 Target selection

```
AI {playerIndex} target selection:
  Candidates evaluated: {count single} singles, {count batch} batches
  Top 3 plans:
    1. [SINGLE|BATCH] {good1}:{source1}→{dest1} (+{good2}:{source2}→{dest2})
       buildCost={cost} payout={payout} turns={turns} ECU/turn={value}
    2. ...
    3. ...
  Selected: plan {N} — {reason}
  Cash: {cash}, Affordable plans: {count}
```

### 7.2 Build phase

```
AI {playerIndex} build:
  Plan: {plan summary}
  Segment: building from {from} toward {to}
  Direction: out of {majorCity} (saved {savings}M vs building in)
  Cost: {segmentCost}M, Budget remaining: {remaining}M
  Upgrade considered: {yes/no}
    Gate 1 (viable plan after upgrade): {pass/fail}
    Gate 2 (surplus): surplus={surplus}M (threshold: 20M) → {upgrade/skip}
    Gate 3 (endgame): citiesNeeded={N}, totalConnectionCost={cost}M, surplusAfterUpgrade={surplus-20}M → {upgrade/skip}
```

### 7.3 Operate phase

```
AI {playerIndex} operate:
  Plan: {plan summary}
  Deploy: at {city} (pickup 1) — ERROR if pickup 1 not connected
  Movement loop:
    Step 1: at {city}, {action} (pickup/deliver/move), {points} MP remaining
    Step 2: at {milepost}, moving toward {target}, {points} MP remaining
    ...
  Frontier: moving to {milepost} on planned build path (target: {nextCity})
```

### 7.4 Discard decision

```
AI {playerIndex} discard evaluation:
  Best plan ECU/turn: {value} (threshold: 2.0)
  Carrying goods: {yes/no} [{goods list}]
  Affordable plans: {count}
  Decision: {discard/keep} — {reason}
```

### 7.5 Plan abandonment

```
AI {playerIndex} plan abandoned:
  Reason: {supply exhausted | flood destroyed track | stuck 3+ turns}
  Previous plan: {plan summary}
  Currently carrying: {goods list}
  Action: {deliver then replan | replan immediately}
```

---

## 8. Endgame: Win Condition Pursuit

The victory condition requires **both** reaching a configurable cash threshold (`gameState.gameSettings.winCashThreshold`, default 250M) **and** having track connecting at least a configurable number of major cities (`gameState.gameSettings.winMajorCitiesRequired`, default 7 of 8). The AI's ECU/turn scoring engine naturally drives cash accumulation, but it will not necessarily build a connected network through enough major cities. The AI needs an explicit endgame mode to ensure it meets both conditions.

### 8.1 Endgame trigger

The AI enters endgame mode when:

```
netPayout = plan.totalPayout - min(player.outstandingDebt, plan.numDeliveries * 10)
player.cash + netPayout >= gameState.gameSettings.winCashThreshold
```

`netPayout` accounts for the debt auto-deductions that will reduce the plan's actual cash yield. Each delivery auto-deducts 10M toward outstanding debt, so the plan can repay at most `numDeliveries × 10M`. Any remaining debt carries forward but doesn't affect this plan's cash yield.

In other words: if *any* plan, when completed, would put the AI at or above the cash threshold after accounting for debt repayment, endgame mode activates. At this point, the AI must also ensure it meets the major city connectivity requirement.

**When to check:** Two points: (1) **during plan selection** — `scorePlan` evaluates the formula above for each *candidate* plan. If any candidate would cross the threshold, `aiState.endgameMode` is set to true and `scorePlan` switches to turns-to-win scoring (§8.4) for all candidates that cross the threshold; (2) **at the start of each build phase** — the formula is re-checked against the *committed* plan, so a delivery completed during the operate phase (which increased `player.cash`) can immediately trigger endgame build priority (§8.3). The flag `aiState.endgameMode` persists once set and is never unset (the AI only gets closer to winning, never further).

### 8.2 Major city connectivity check

A major city is **connected** if there is a continuous path of owned track from that city to the AI's main network (the largest connected component of the AI's track). Isolated track segments touching a major city but disconnected from the main network do not count. The win condition requires all counted major cities to be part of one contiguous network.

When the endgame trigger fires, the AI counts how many major cities are connected to its main network. If `connectedMajorCities >= gameState.gameSettings.winMajorCitiesRequired`, no adjustment needed — just execute the committed plan and win.

If the AI is short, it computes: `citiesNeeded = winMajorCitiesRequired - connectedMajorCities`.

### 8.3 Endgame build priority

When the AI is short on major cities, the **build phase** priority changes. This logic lives inside `computeBuildOrder` (§11.1) — when `aiState.endgameMode` is true and the committed plan's route is fully built, `computeBuildOrder` returns major city connection segments as additional build actions instead of returning nothing (which would trigger the "save budget" default in §4.3).

The logic within `computeBuildOrder` when in endgame mode:

```
1. If the committed plan has unbuilt segments, build those first
   (the AI needs this delivery's payout to reach the cash threshold)
2. With remaining build budget, identify all major cities NOT connected
   to the AI's track network
3. For each unconnected major city, compute the build cost to connect it
   to the existing network (always building OUT of the major city per §2.4)
4. Rank by build cost (cheapest first)
5. Build toward the cheapest unconnected major cities until
   citiesNeeded are connected or build budget is exhausted
```

This happens during the build phase of every turn while in endgame mode and `citiesNeeded > 0`. The AI still executes its committed delivery plan during the operate phase — it needs the cash from that delivery to win. Build budget is split: finish the committed plan's route first (to ensure the winning delivery can complete), then direct remaining budget toward major city connectivity.

### 8.4 Interaction with plan selection

When in endgame mode, plan selection scoring shifts from pure ECU/turn to **turns to win**. This shift is handled inside `scorePlan`, not `selectPlan`. When `aiState.endgameMode` is true, `scorePlan` checks whether `player.cash + netPayout - plan.totalBuildCost >= winCashThreshold` (where `netPayout` accounts for debt auto-deductions per §8.1, and `totalBuildCost` is subtracted because the AI must spend cash building before it can deliver). If so, the plan's score is based on turns-to-win (lower is better) rather than ECU/turn (higher is better). `selectPlan` always picks the highest-scoring plan — it doesn't need to know which scoring mode is active.

Between two plans that both put the AI over the cash threshold, the AI prefers the one that completes fastest — even if it has lower ECU/turn. Overshooting the cash threshold by 20M is worthless if it takes 3 extra turns.

If the AI needs additional major city connections, the turns-to-win estimate must account for both the plan's delivery and the city connection building. City connections are built during the build phase (§8.3) — after the plan's route is complete, remaining build budget each turn goes toward connections. This overlaps with the operate phase (the AI delivers while building connections). The correct formula separates total build work from operate work and takes the max, consistent with §1.4's A.39 fix:

```
// Compute city connection build turns
cashAfterPlan = player.cash + netPayout - plan.totalBuildCost
    // Cash available after the plan's delivery and build costs
totalCityConnectionCost = sum of build costs for the citiesNeeded
    cheapest unconnected major cities (each building OUT per §2.4)
cityBuildCashPerTurn = min(20, cashAfterPlan) * 0.75
    // Same formula as §1.4 — 20M max build spend, 0.75 inefficiency factor
if cityBuildCashPerTurn > 0:
    estimatedBuildTurnsForMajorCityConnections = totalCityConnectionCost / cityBuildCashPerTurn
else:
    estimatedBuildTurnsForMajorCityConnections = Infinity

// Combine plan and city connection work
totalBuildTurns = plan.totalBuildTurns + estimatedBuildTurnsForMajorCityConnections
    // Sequential in the build phase: plan route first (§8.3 step 1),
    // then city connections (§8.3 steps 2-5)
turnsToWin = max(totalBuildTurns, plan.operateTurns)
    // Build and operate overlap — same principle as §1.4 (A.39).
    // The AI delivers during operate while building connections during build.
```

**Note on `plan.totalBuildTurns` and `plan.operateTurns`:** These are the pre-max components from §1.4's turn estimation — `totalBuildTurns` (sum of per-group build turn estimates) and `operateTurns` (`ceil(tripDistance / trainSpeed)`). §1.4 combines them as `max(totalBuildTurns, operateTurns)` to produce `plan.estimatedTurns`. For endgame scoring, `scorePlan` needs the individual components to correctly model the additional city-connection build work. The plan object must store `totalBuildTurns` and `operateTurns` separately (see §11.5 update).

`estimatedBuildTurnsForMajorCityConnections` and `totalCityConnectionCost` are computed inside `scorePlan` when `aiState.endgameMode` is true — `scorePlan` has access to the game state and player's track, so it can compute `citiesNeeded` and the cheapest connection costs using the same logic as `computeBuildOrder` (§8.3). This minor duplication keeps `scorePlan` self-contained rather than depending on `checkEndgame` running first.

**Scoring inversion note:** In normal mode, higher `planValue` is better (more ECU/turn). In endgame mode, lower `turnsToWin` is better. `scorePlan` must normalize these so that `selectPlan` can always pick the max. In endgame mode, winning plans (those where `player.cash + netPayout - plan.totalBuildCost >= winCashThreshold`) are scored as `1000 - turnsToWin`. This guarantees every winning plan scores above every non-winning plan (whose ECU/turn will never approach 1000), and among winning plans, fewer turns = higher score. Plans that don't reach the cash threshold after accounting for build cost fall back to normal ECU/turn scoring.

### 8.5 Edge case: can't afford both delivery and city connections

If the AI doesn't have enough cash to both complete the winning delivery and build connections to the required major cities, it needs one more earning delivery first. Specifically, a plan qualifies as a "funding plan" if:

```
cashAfterPlan = player.cash + netPayout - plan.totalBuildCost
cashAfterPlan >= cheapestMajorCityConnectionsCost
```

Where `cheapestMajorCityConnectionsCost` is the sum of build costs for the `citiesNeeded` cheapest unconnected major cities (each computed as building out of the major city per §2.4). Among qualifying plans, the AI selects the fastest (fewest estimated turns). After that delivery completes, the AI enters full endgame mode with enough cash to fund the remaining connections.

**Note:** This is not a separate scoring mode. It falls out naturally from §8.4's turns-to-win scoring. `scorePlan` computes `turnsToWin` including `estimatedBuildTurnsForMajorCityConnections`, and plans that fund the city connections will score highest among winning plans because they represent the fastest path to victory. §8.5 describes the emergent behavior, not additional logic.

---

## 9. Parameters to Tune Through Playtesting

| Parameter | Initial value | What to watch in logs |
|---|---|---|
| Turn estimation inefficiency factor | 0.75 | Are actual build turns close to estimated? |
| Discard ECU/turn threshold | 2.0 | Does the AI discard too eagerly or too late? |
| Upgrade surplus threshold | 20M | Does the AI upgrade at reasonable times, or too early/late? |
| Batch pruning proximity threshold | 5 hexes | Are batches genuinely more efficient than singles? |
| Stuck turn counter for plan abandonment | 3 turns | Does the AI escape deadlocks quickly enough? (Set to 3 to absorb 1-turn event disruptions) |
| Weak-plan discard limit before force-commit | 2 discards | Does the AI accept marginal plans quickly enough, or too eagerly? |
| Endgame upgrade skip (Gate 3) | Skip when surplus after upgrade < total city connection cost | Does the AI upgrade at the right time in endgame? Watch for cases where upgrading speeds up the winning delivery enough to offset the delayed city connections. |

---

## 10. Deferred to Brutal AI

The following capabilities were explicitly excluded from the Hard AI design. Each section describes what was deferred, why, and the open decisions that need to be resolved before implementing it.

### 10.1 3-delivery batches

**What Hard AI does:** Evaluates single deliveries and 2-delivery batches only.

**What Brutal AI would do:** Evaluate 3-delivery batch permutations, chaining pickups and dropoffs to maximize goods carried simultaneously. Factors in train capacity (carry 2–3 goods at once) and plans routes where pickups for goods 2 and 3 happen while good 1 is still on board.

**Why deferred:** The permutation space grows significantly with 3 deliveries — six possible orderings per triple, each requiring sequential affordability checks with intermediate cash states. The complexity is disproportionate to the gain for a 7.5/10 AI.

**Open decisions for Brutal:**
- How to bound the combinatorial search. With 9 demands × multiple sources each, enumerating all triples is expensive. Need a pruning strategy — perhaps only consider triples where at least two of the three deliveries share a city or corridor.
- How to handle mid-batch replanning when 3 deliveries are in flight. If delivery 2 of 3 fails (supply exhaustion), does the AI replan the remaining delivery or continue with delivery 3 as planned?
- Whether the sequential affordability model extends cleanly to 3 legs or needs structural changes (it should — just add a third cash checkpoint after leg 2's payout).

### 10.2 Mid-batch replanning (re-evaluate after each dropoff)

**What Hard AI does:** Commits to the full 2-delivery batch and executes it to completion before replanning.

**What Brutal AI would do:** After completing each dropoff within a batch, re-run target selection. If the game state has changed enough (new track built by opponents, event cards, better demands on refreshed cards), the AI may abandon the remaining batch leg in favor of a higher-value new plan.

**Why deferred:** Mid-batch replanning adds significant complexity to the commitment model and risks the AI appearing erratic — constantly switching plans. For a 7.5/10 AI, disciplined execution of a good plan is more valuable than perfect adaptability.

**Open decisions for Brutal:**
- What threshold of improvement justifies abandoning a committed batch leg? The new plan would need to be significantly better (e.g., >50% higher ECU/turn) to justify the wasted positioning.
- How to account for sunk costs — track already built for the abandoned leg is not wasted if it overlaps with future plans, but the AI needs to factor this in.
- Whether to re-evaluate only after dropoffs or also after significant game events (opponent builds competing track, event card fires).

### 10.3 Foreign track usage (trackage rights)

**What Hard AI does:** Moves only on owned track.

**What Brutal AI would do:** Evaluate whether paying 4M trackage rights for an opponent's track segment is a net positive. If using foreign track saves enough turns to justify the cost, the AI takes the shortcut.

**Why deferred:** Foreign track adds a movement cost dimension that complicates both the plan scoring (trip cost now includes potential trackage fees) and the movement loop (need to decide at each junction whether to pay or go the long way). The Hard AI's own-track-only constraint keeps the decision space manageable.

**Open decisions for Brutal:**
- How to model trackage costs in plan evaluation. A plan that uses foreign track has a variable operating cost (4M per opponent segment per trip) in addition to the build cost. The ECU/turn formula needs to account for this.
- Whether to model trackage rights in the turn estimation or just in the movement loop. Pre-computing likely foreign track usage during plan selection is more accurate but more complex.
- How to handle the case where an opponent's track is destroyed by a flood mid-trip — the Brutal AI needs a fallback route.
- Whether to factor in trackage *income* (other AIs or players paying to use your track) as a consideration when choosing where to build.

### 10.4 Expected-value discard (deck-aware hand evaluation)

**What Hard AI does:** Uses a fixed 2 ECU/turn threshold to decide when to discard.

**What Brutal AI would do:** Compute the expected value of a fresh hand based on the remaining demand deck composition and the AI's current network. Compare this against the current hand's best plan value, accounting for the tempo cost of losing a turn to discard. Discard only when the expected replacement value minus the tempo cost exceeds the current hand value.

**Why deferred:** Estimating replacement hand value requires modeling the demand deck distribution and which cities the AI can cheaply reach — a significant computation. The fixed threshold is a good approximation and much simpler.

**Open decisions for Brutal:**
- Whether to track the demand deck composition (which cards have been drawn and discarded) or use the full statistical distribution. Tracking gives more accurate estimates but requires state that doesn't currently exist in `aiState`.
- How to value the tempo cost of discarding. Losing a full turn (operate + build) when the AI could have been delivering is significant. The tempo cost should be roughly equal to the current plan's ECU/turn — that's what you give up by discarding instead of playing.
- How often to re-evaluate the discard decision. Every turn? Only at the start of operate phase?

### 10.5 Speculative building (trunk routes, high-EV corridors)

**What Hard AI does:** Only builds track required by the committed plan. Saves unspent budget.

**What Brutal AI would do:** When the committed plan's route is fully built and build budget remains, invest in trunk routes through high-connectivity corridors. These are segments that connect major cities and goods hubs, increasing the probability that future demand cards are cheaply serviceable. Estimates the expected value of speculative track based on the density of goods sources and demand destinations reachable from the new track.

**Why deferred:** Speculative building requires modeling future hand value — the probability that new track will be useful for as-yet-undrawn demand cards. This is the domain of expected-value calculations over the demand deck, which is Brutal-tier complexity.

**Open decisions for Brutal:**
- How to estimate the future value of a track segment. One approach: for each candidate build segment, count how many (source, destination) pairs in the demand deck become cheaper to service. Weight by payout.
- How much budget to allocate to speculative building vs. saving cash. Building too aggressively could leave the AI cash-poor when a great demand appears.
- Whether to maintain a ranked list of high-value corridors and build toward them incrementally across turns, or evaluate fresh each turn.

### 10.6 Proactive ferry investment (future-value modeling)

**What Hard AI does:** Ferry costs are included in plan scoring. Ferries are only built when a current plan requires one.

**What Brutal AI would do:** Proactively evaluate whether building a ferry (even without a current demand requiring it) unlocks enough future value to justify the cost. Compute the expected demand-card value behind each ferry based on the number and payout of destinations on the connected landmass. Build high-value ferries early (e.g., Dover-Calais for Britain) even if no current card demands it.

**Why deferred:** This requires the same future-value modeling as speculative building (§10.5) — estimating the probability-weighted value of as-yet-undrawn demands. The Hard AI's reactive approach (build ferries when a plan needs one) is simpler and still competitive.

**Open decisions for Brutal:**
- How to compute the expected value of landmass access. Count the number of goods sources and demand destinations behind the ferry, weight by average payout and probability of drawing those demands.
- Whether to race opponents for contested ferry slots (max 2 owners per ferry). If an opponent has already built one slot, the second slot becomes more valuable (last chance to access that crossing) but also riskier (opponent may not have valuable demands there).
- How to factor ferry reusability into the calculation — a ferry used for 5+ deliveries over a game has massive ROI even if the first delivery alone doesn't justify the cost.

### 10.7 Optimal upgrade timing (break-even model)

**What Hard AI does:** Upgrade to Fast Freight when 20M surplus exists after remaining route costs (§4.4). No payback math or game-length estimation.

**What Brutal AI would do:** Calculate the precise break-even point — "how many turns until the extra movement/capacity pays back the 20M?" — using the expected remaining game length. Upgrade at the earliest turn where the payback period is shorter than the expected turns remaining. Skip intermediate upgrade tiers when the jump to a higher tier pays back faster (e.g., Freight → Superfreight, skipping Fast Freight and Heavy Freight if the game is young enough).

**Why deferred:** Estimating remaining game length requires modeling all players' progress toward the victory condition. The Hard AI's heuristic threshold is a reasonable approximation.

**Open decisions for Brutal:**
- How to estimate remaining game turns. One approach: look at the leading player's cash, their average ECU/turn, and the victory threshold. Estimate how many turns until someone wins.
- Whether to factor in the specific upgrade path. Freight → Fast Freight (speed) vs. Freight → Heavy Freight (capacity) have different payback profiles depending on whether the AI's bottleneck is movement or carrying capacity.
- Whether to model the opponent's upgrade status. If opponents are upgrading, staying on Freight becomes increasingly disadvantageous per turn.

---

## 11. Implementation Architecture (Hard → Brutal Extensibility)

The Hard AI should be structured so that the Brutal AI can override specific decision functions without rewriting the turn flow. Every decision the AI makes during a turn follows the same sequence regardless of difficulty — only the logic within each decision point changes.

### 11.1 Strategy pattern

Structure `ai-hard.js` as a collection of named strategy functions, each responsible for one decision:

```
module.exports = {
    // Core decision functions (Brutal AI overrides these)
    enumeratePlans,         // §1.2 — generate candidate plans
    scorePlan,              // §1.4 — compute ECU/turn for a plan
    checkAffordability,     // §1.3 — sequential affordability check (accepts options.effectiveCash)
    selectPlan,             // §1.5 — pick the best plan (accepts options.effectiveCash, threaded to checkAffordability)
    shouldDiscard,          // §5   — discard threshold check
    handleNoPlan,           // §5.4 — discard-loop detection, borrowing evaluation
    shouldUpgrade,          // §4.4 — upgrade gate 1 + gate 2
    computeBuildOrder,      // §2.3, §4.1 — determine what to build next
    planMovement,           // §3.2 — movement loop with target sequencing
    selectMajorCity,        // §2.2 — extracts major city from plan (initial build) or no-op (subsequent)
    checkEndgame,           // §8   — win condition trigger and major city connectivity

    // Turn orchestration (shared across difficulties, NOT overridden)
    planTurn,               // initial building entry point
    planOperate,            // operate phase entry point (§11.3.2)
    planBuild,              // build phase entry point (§11.3.3) — called by server after operate actions execute
}
```

### 11.2 What Brutal AI overrides vs. reuses

| Function | Hard AI | Brutal AI override |
|---|---|---|
| `enumeratePlans` | Singles + 2-batches | Add 3-batches with pruning |
| `scorePlan` | `payout / turns` | Add expected future value of track built |
| `checkAffordability` | Sequential 2-leg check | Extend to 3-leg sequential check |
| `selectPlan` | Highest ECU/turn | Same, but with richer scoring inputs |
| `shouldDiscard` | Fixed 2 ECU/turn threshold | EV comparison against deck distribution |
| `handleNoPlan` | Discard-loop detection (2 consecutive) + smallest viable borrow | EV-based: compare expected replacement hand value against borrowing cost |
| `shouldUpgrade` | Fast Freight when 20M surplus after route | Break-even against estimated remaining game length; considers all upgrade tiers |
| `computeBuildOrder` | Committed plan only | Add speculative trunk routes when plan is built |
| `planMovement` | Own track only | Add foreign track evaluation at each junction |
| `selectMajorCity` | Extract `plan.majorCity` (joint optimization in `selectPlan`) | Same (no change needed) |
| `checkEndgame` | Connect cheapest unconnected major cities | Factor major city connections into EV-based corridor planning |
| `planTurn` | **Not overridden** | **Not overridden** — same initial building flow |
| `planOperate` | **Not overridden** | **Not overridden** — same operate flow |
| `planBuild` | **Not overridden** | **Not overridden** — same build flow |

### 11.3 Shared turn flow (difficulty-agnostic)

The AI's turn is orchestrated by three entry points — `planTurn` (initial building), `planOperate` (operate phase), and `planBuild` (build phase). All three are shared across Hard and Brutal; only the strategy functions they call are overridden.

**Why three entry points instead of one:** Event cards fire during card draws, which happen as side effects of delivery and discard actions (see §11.3.4). A single `planTurn` that pre-computes the entire turn (operate + build) would plan the build phase with stale state — before events from operate-phase card draws have modified cash, track, or cargo. Splitting into separate entry points lets the server execute operate actions first, then call `planBuild` with the post-event game state. This preserves plan commitment (the committed plan is never re-evaluated between phases) while ensuring the build phase works with accurate state.

#### 11.3.1 `planTurn` — initial building only

```
function planTurn(gs, playerIndex, ctx, strategy) {
    // Only called during initial building. Normal turns use planOperate + planBuild.

    plan = getCommittedPlan(gs, playerIndex)  // check for plan committed in round 1
    if (!plan) {
        // Round 1 (or no committed plan): run full target selection.
        // selectPlan jointly optimizes plan + major city during initial building (§1.2, §2.2).
        // plan.majorCity is already set. selectMajorCity extracts it.
        plan = strategy.selectPlan(gs, playerIndex, ctx)
        if (!plan) return [{ type: 'endTurn' }]
        // Note: no shouldDiscard here — initial building phase is build-only,
        // discarding is not a legal action. If no plan is viable, we still build
        // toward the best available option (or end turn if nothing is affordable).
        commitPlan(gs, playerIndex, plan)  // persist in aiState for round 2 and operate phase
    }
    // Round 2 reuses the committed plan from round 1 — same plan, same major city.
    majorCity = strategy.selectMajorCity(gs, playerIndex, ctx, plan)
    buildOrder = strategy.computeBuildOrder(gs, playerIndex, ctx, plan, majorCity)
    return [...buildActions, { type: 'endTurn' }]
}
```

No event-timing issues during initial building — there are no card draws, no deliveries, and no events.

#### 11.3.2 `planOperate` — operate phase

Returns operate-phase actions only (movement, pickup, delivery, or discard/borrow). Does **not** plan or return build-phase actions.

```
function planOperate(gs, playerIndex, ctx, strategy) {
    plan = getCommittedPlan(gs, playerIndex)  // from aiState

    // Already have a committed plan from a previous turn — check §1.6
    // abandonment conditions, then continue executing.
    if (plan) {
        // Check §1.6 abandonment triggers:
        // - Cargo integrity failure: expected carried goods missing (§6.2.1 derailment)
        // - Supply exhaustion for next pickup (§3.4)
        // - Flood made plan unaffordable (§6.2.3)
        // - Stuck 3+ turns with no progress
        // If any trigger fires, abandon the plan (creating a residual plan
        // if carrying, per §3.4) and fall through to selectPlan below.
        if (shouldAbandon(gs, playerIndex, ctx, plan)) {
            abandonPlan(gs, playerIndex)  // clears committed plan, handles residual
            plan = getCommittedPlan(gs, playerIndex)  // residual plan if carrying
        } else {
            return strategy.planMovement(gs, playerIndex, ctx, plan)
        }
    }

    // No committed plan (completed, abandoned, or first turn after
    // initial building) — run target selection to get a new one.
    if (!plan) {
        plan = strategy.selectPlan(gs, playerIndex, ctx)  // no effectiveCash override — uses player.cash
    }

    // §5.1: No viable plan exists — handle discard/borrow before shouldDiscard.
    // selectPlan returns null when no candidate passes affordability.
    // This triggers the §5.4 borrowing evaluation (if in a discard loop)
    // or immediate discard. shouldDiscard is never called with a null plan.
    if (!plan) {
        return handleNoPlan(gs, playerIndex, ctx, strategy)
        // handleNoPlan checks aiState.consecutiveDiscards for discard loop (§5.4.1),
        // evaluates borrowing if needed (§5.4.2), and returns discard or borrow action.
        // Note: discardHand and handleNoPlan's discard end the entire turn —
        // the server must NOT call planBuild after a discard (see §11.3.4).
    }

    // §5.2: Plan exists but is weak — threshold check.
    // shouldDiscard only receives non-null, freshly selected plans.
    if (strategy.shouldDiscard(gs, playerIndex, ctx, plan)) return [{ type: 'discardHand' }]

    // Lock in the plan — persists across phases and turns (§1.6).
    // Called here (not earlier) so that discarded plans are never committed.
    commitPlan(gs, playerIndex, plan)
    return strategy.planMovement(gs, playerIndex, ctx, plan)
}
```

#### 11.3.3 `planBuild` — build phase

Called by the server **after** all operate-phase actions have executed (including any events triggered by card draws). Reads the committed plan from `aiState` — the same plan that `planOperate` used, never re-evaluated.

```
function planBuild(gs, playerIndex, ctx, strategy) {
    plan = getCommittedPlan(gs, playerIndex)

    // No committed plan (completed mid-turn or discarded). shouldUpgrade
    // requires a plan to evaluate Gate 1/2 — without one, skip upgrade
    // (avoids spending 20M with no route to justify the surplus check).
    // computeBuildOrder with null plan returns endgame actions (§8.3)
    // if in endgame mode, or nothing (save budget) otherwise.
    if (!plan) {
        buildOrder = strategy.computeBuildOrder(gs, playerIndex, ctx, null)
        return [...buildActions, { type: 'endTurn' }]
    }

    if (strategy.shouldUpgrade(gs, playerIndex, ctx)) return [upgradeAction, { type: 'endTurn' }]
    buildOrder = strategy.computeBuildOrder(gs, playerIndex, ctx, plan)
    return [...buildActions, { type: 'endTurn' }]
}
```

`planBuild` sees the real game state: post-delivery cash (including debt repayment), post-tax cash, post-flood track, post-derailment cargo. It does not re-run `shouldAbandon` — that check is deferred to the start of next turn's `planOperate`, ensuring the build phase always runs (the AI can build toward its plan even if an event degraded it, and `shouldAbandon` will evaluate the damage next turn with full information).

#### 11.3.4 Server execution contract

The server orchestrates the two-phase execution. This replaces the single `executeAITurn` → `planTurn` → flat action array model used by the Easy AI.

```
function executeHardAITurn(roomCode, room) {
    gs = room.gameState
    playerIndex = gs.currentPlayerIndex
    ctx = buildPathfindingCtx(gs)
    strategy = getStrategyForDifficulty(player.difficulty)

    if (phase === 'initialBuilding') {
        actions = strategy.planTurn(gs, playerIndex, ctx, strategy)
        executeActionSequence(actions)
        return
    }

    // Phase 1: Operate
    operateActions = strategy.planOperate(gs, playerIndex, ctx, strategy)
    executeActionSequence(operateActions, {
        onNonSkippableFailure: 'skip-remaining'
            // If a commitMove fails mid-sequence (e.g., flood destroyed track
            // during a card draw from an earlier delivery), skip the remaining
            // operate actions. Do NOT abort the turn — proceed to build phase.
            // The committed plan survives in aiState; shouldAbandon evaluates
            // the damage next turn.
    })

    // If operate ended with a discard or borrow-discard, the turn is over.
    // discardHand replaces the player's hand — no build phase follows.
    if (operateActions.some(a => a.type === 'discardHand')) {
        applyEndTurn(gs)
        return
    }

    // Phase 2: Build (with post-operate state)
    // gs now reflects all operate-phase side effects: deliveries, card draws,
    // events (floods, tax, derailments), debt repayment, cash changes.
    buildActions = strategy.planBuild(gs, playerIndex, ctx, strategy)
    executeActionSequence(buildActions)
        // buildActions always ends with { type: 'endTurn' }
}
```

**Key behaviors:**

1. **Operate action failure is non-fatal.** When an event fires during a card draw (from a delivery) and invalidates a later `commitMove` in the operate sequence, the server skips the remaining operate actions and proceeds to the build phase. The committed plan is not abandoned — `shouldAbandon` evaluates the damage at the start of next turn's `planOperate`. This means the AI may lose remaining movement points when a mid-operate event fires, the same penalty a human player would pay.

2. **Discard ends the turn.** If `planOperate` returns a `discardHand` action (from `shouldDiscard` or `handleNoPlan`), the server does not call `planBuild`. Discarding replaces the player's hand and ends the turn — no build phase follows. This is unchanged from the original design.

3. **`planBuild` sees real state.** The build phase is planned AFTER all operate actions execute, so `computeBuildOrder` and `shouldUpgrade` work with accurate cash (post-delivery, post-tax, post-debt-repayment) and accurate track (post-flood). This eliminates the stale-state problem where build actions were pre-computed with pre-event values.

4. **The committed plan is never re-evaluated between phases.** `planBuild` reads the same committed plan from `aiState` that `planOperate` used. No `selectPlan`, `shouldDiscard`, or `shouldAbandon` runs during the build phase. Plan evaluation only happens at the start of `planOperate`.

### 11.4 Creating the Brutal AI module

With this architecture, `ai-brutal.js` would look like:

```
const hard = require('./ai-hard');

module.exports = {
    // Inherit everything from Hard
    ...hard,

    // Override specific decision functions
    enumeratePlans: brutalEnumeratePlans,     // adds 3-batches
    scorePlan: brutalScorePlan,               // adds future-value modeling
    shouldDiscard: brutalShouldDiscard,        // EV-based
    shouldUpgrade: brutalShouldUpgrade,        // break-even model
    computeBuildOrder: brutalComputeBuildOrder, // adds speculative building
    planMovement: brutalPlanMovement,          // adds foreign track
}
```

### 11.5 Data structures that must support extensibility

The `plan` object stored in `aiState` should be structured around the visit sequence, supporting N stops (not hardcoded to 4):

```
plan = {
    majorCity: "Madrid",     // starting major city (set during initial building, null for subsequent plans)
    deliveries: [
        { cardIndex, demandIndex, sourceCity, destCity, good, payout },
        { cardIndex, demandIndex, sourceCity, destCity, good, payout },
        // Brutal AI may add a third
    ],
    visitSequence: [
        // Ordered list of stops. Each stop references a delivery and an action.
        { city: "Lyon", action: "pickup", deliveryIndex: 0, good: "Wheat" },
        { city: "München", action: "pickup", deliveryIndex: 1, good: "Beer" },
        { city: "Wien", action: "deliver", deliveryIndex: 1, cardIndex: 1, demandIndex: 0 },
        { city: "Roma", action: "deliver", deliveryIndex: 0, cardIndex: 0, demandIndex: 2 },
        // Brutal AI may have 6 stops (3 pickups + 3 deliveries)
    ],
    segments: [
        // Per-segment build cost breakdown, aligned with visitSequence
        { from: "(network)", to: "Lyon", buildCost: 8, cumCashAfter: null },
        { from: "Lyon", to: "München", buildCost: 5, cumCashAfter: null },
        { from: "München", to: "Wien", buildCost: 7, cumCashAfter: 25 },   // delivery checkpoint
        { from: "Wien", to: "Roma", buildCost: 10, cumCashAfter: 35 },     // delivery checkpoint
    ],
    totalBuildCost,
    totalPayout,
    totalBuildTurns,         // sum of per-group build turn estimates from §1.4 (pre-max component)
    operateTurns,            // ceil(tripDistance / trainSpeed) from §1.4 (pre-max component)
    estimatedTurns,          // max(totalBuildTurns, operateTurns) — the combined estimate
    ecuPerTurn,
    buildPath: [...],        // full planned route as milepost sequence (computed during plan selection)
    currentStopIndex: 0,     // tracks progress through the visit sequence
}
```

The movement loop uses `plan.visitSequence` and `plan.currentStopIndex` to determine the next stop. When a stop is completed (pickup or delivery), `currentStopIndex` advances. This makes the movement loop trivially extensible to 3+ deliveries — just more stops in the sequence.

Similarly, `checkAffordability` iterates over `plan.segments` and checks cash at each delivery stop, so Brutal can add more stops without changing the function signature.

---

## 12. Implementation Sequence

9 commits, each self-contained and testable. The module builds up incrementally — later commits fill in stubs left by earlier ones. All tests in `test/ai-hard.test.js` (unit) and `test/ai-hard-integration.test.js` (integration).

### Commit 1: Core plan engine (singles only)

**Sections:** §1.2–§1.5, §11.1, §11.5

**What ships:**
- Plan data structure (§11.5) — `deliveries`, `visitSequence`, `segments`, `buildPath`, `currentStopIndex`
- `enumeratePlans` for single-delivery candidates only (§1.2) — enumerate all (card, demand, sourceCity) triples, compute build cost and payout
- `checkAffordability` for singles (§1.3) — hard cutoff: `totalBuildCost <= player.cash`, no unaffordable fallback
- `scorePlan` with basic ECU/turn (§1.4) — turn estimation with `cashPerTurn = min(20, cash) * 0.75`, `totalTurns = max(buildTurns, operateTurns)`
- `selectPlan` (§1.5) — rank all viable plans by `planValue`, pick highest
- Strategy pattern skeleton (§11.1) — `module.exports` with all named functions (stubs for unimplemented ones)

**Tests:**
- Enumeration produces correct candidates for a given hand
- Unaffordable plans are excluded (hard cutoff, no fallback)
- Scoring ranks higher-payout/lower-cost plans above alternatives
- Selection picks the best plan from a set of candidates
- Turn estimation uses track-based distance, not Euclidean
- Plans with zero build cost (existing track) score correctly

### Commit 2: Initial building

**Sections:** §2.1–§2.5, §11.3.1

**What ships:**
- Joint optimization in `selectPlan` — during initial building (no existing network), evaluate every candidate plan against all 8 major cities, pick best (plan, majorCity) pair (§1.2, §2.2)
- `selectMajorCity` thin accessor (§2.2) — returns `plan.majorCity`
- `computeBuildOrder` for initial building (§2.3) — build segments in visit-sequence order, two rounds of 20M budget
- Build direction rule (§2.4) — always build out of major cities (1M exit vs 5M entry); `findCheapestBuildPath` computes major-city segments using build-out cost
- `planTurn` for `initialBuilding` phase (§11.3.1) — commit plan on round 1, reuse on round 2
- Initial building reachability filter (§1.2) — build cost from major city to pickup 1 must be ≤ 40M

**Tests:**
- Major city selection favors directionally aligned cities
- Build direction saves 4M per mid-route major city vs building in
- `planTurn` round 1 commits plan, round 2 reuses it
- Reachability filter excludes plans where pickup 1 is unreachable within 40M
- Budget stops when route is complete (no speculative building)

### Commit 3: Movement and operating phase

**Sections:** §3.1–§3.4, §11.3.2 (skeleton)

**What ships:**
- `planMovement` with deployment preamble (§3.1, §3.2) — deploy at pickup 1 if train not on map, then movement loop consuming all movement points
- Movement loop (§3.2) — follow visit sequence: pickup/deliver at stops, move along owned track between stops
- Frontier movement (§3.3) — when track doesn't reach next stop, move to farthest reachable milepost on `plan.buildPath`; connected-component constraint (BFS reachable set); Euclidean fallback to network attachment point
- Supply exhaustion (§3.4) — if good unavailable at pickup, abandon plan, create residual single-delivery plan for carried goods
- `planOperate` skeleton (§11.3.2) — calls `planMovement` for committed plans; stubs for `shouldAbandon` and `shouldDiscard` (filled in commit 6)
- Plan completion lifecycle — clear committed plan when all stops visited

**Tests:**
- Deployment always at pickup 1 (not dest, not nearest city)
- Movement loop uses all movement points (not just one move action)
- Pickup and delivery happen as stops in the visit sequence
- Frontier movement targets build path, not Euclidean-closest milepost
- Connected-component constraint prevents targeting disconnected build-out islands
- Supply exhaustion creates correct residual plan when carrying
- Supply exhaustion with no carried goods → clean abandon + replan

### Commit 4: Build phase and upgrades

**Sections:** §4.1–§4.4, §11.3.3

**What ships:**
- `computeBuildOrder` for post-operate (§4.1–§4.3) — build next unbuilt segment in visit-sequence order, budget discipline (spend up to 20M or remaining cash)
- Build direction reversal (§4.2) — `computeBuildOrder` emits build actions in reverse milepost order for segments targeting unconnected major cities
- Save unspent budget (§4.3) — if plan route fully built, save remaining cash (no speculative building outside endgame)
- `shouldUpgrade` Gates 1–2 (§4.4) — Gate 1: `remainingBuildCost <= player.cash`; Gate 2: `surplus >= 20M` → upgrade to Fast Freight; upgrade consumes entire build phase
- `planBuild` (§11.3.3) — check upgrade first, then compute build order, always end with `endTurn`

**Tests:**
- Build extends committed plan from where it left off
- Build direction reversal for major-city segments (out, not in)
- Budget stops at 20M or cash, whichever is less
- Fully-built route → save budget (no extra building)
- Upgrade fires when 20M surplus exists after route costs
- Upgrade skipped when surplus < 20M
- Upgrade consumes full build phase (no track built same turn)
- No upgrade when no committed plan exists

### Commit 5: 2-delivery batches

**Sections:** §1.2 (batch pruning), §1.2.1, §1.3 (virtual track), §1.4 (per-group estimation)

**What ships:**
- Batch pruning rule (§1.2) — pair singles if they share a city OR any city is within 5 hex units (Euclidean point-to-line-segment distance) of the other delivery's route
- Visit sequence generation (§1.2.1) — all 6 valid orderings for each batch pair; last-stop-is-delivery invariant validation
- Sequential affordability with virtual track (§1.3) — `Set<milepostId>` accumulates mileposts; pathfinder treats virtual track as cost 0; cash checkpoints at each delivery stop
- Per-segment-group turn estimation (§1.4) — build turns estimated per group of segments between deliveries, with `effectiveCash` updated at each delivery checkpoint
- Movement loop batch support — visit sequence with interleaved pickups/deliveries already works from commit 3; verify with batch plans

**Tests:**
- Pruning catches pairs sharing a city
- Pruning catches pairs within 5-hex proximity
- Pruning rejects distant, unrelated pairs
- All 6 visit sequences generated for a batch pair
- Malformed sequence (not ending in delivery) is rejected with error
- Virtual track prevents double-counting shared corridor costs
- Sequential affordability rejects sequence where mid-plan cash goes negative
- Sequential affordability accepts sequence where early delivery funds later segments
- Batch plan with higher ECU/turn beats equivalent singles
- Per-group turn estimation diverges from naive single-group when delivery payout changes cash balance

### Commit 6: Discard, borrowing, and plan commitment

**Sections:** §5.1–§5.4, §1.6

**What ships:**
- `shouldDiscard` carrying guard (§5.3) — return false immediately when carrying goods
- `shouldDiscard` threshold check (§5.2) — best plan < 2 ECU/turn → discard; `consecutiveWeakDiscards` counter; after 2 consecutive → accept plan
- `handleNoPlan` (§5.4.4) — discard-loop detection (`consecutiveDiscards >= 2`); borrowing evaluation: try [5, 10, 15, 20], pick smallest amount with positive effective ECU/turn after debt deductions; borrow + operate in same turn
- Plan commitment rules (§1.6) — committed plan persists across phases/turns
- `shouldAbandon` (§1.6, §6.2.1) — cargo integrity check (expected goods missing from cargo); stuck counter (3 turns with no progress — build, pickup, delivery, or closer-to-target); flood affordability trigger; supply exhaustion at next pickup
- Progress definition (§1.6) — 4 conditions; frontier distance metric during frontier movement
- Wire `shouldAbandon`, `shouldDiscard`, `handleNoPlan` into `planOperate` (completing §11.3.2)
- `consecutiveDiscards` resets on plan commitment and on weak-plan discard

**Tests:**
- Carrying guard prevents discard regardless of plan quality
- Weak plan (< 2 ECU/turn) triggers discard
- After 2 consecutive weak discards, AI accepts marginal plan
- `consecutiveWeakDiscards` resets on plan commitment
- No viable plan → discard, increment `consecutiveDiscards`
- 2 consecutive no-plan discards → borrow smallest viable amount
- Borrowing picks smallest amount with positive effective ECU/turn
- Borrowing while in debt allowed when math supports it
- Never borrow during initial building
- Cargo integrity catches missing good → abandon
- Stuck 3 turns → abandon; 2 turns → continue
- Progress (any of 4 conditions) resets stuck counter
- `consecutiveDiscards` resets on weak-plan discard (§A.59)
- Deployment reachability guard excludes unreachable pickup 1 when train never deployed (§3.1)

### Commit 7: Event response

**Sections:** §6.2.1–§6.2.7

**What ships:**
- Derailment response (§6.2.1) — cargo integrity check in `shouldAbandon` already handles this (commit 6); verify with derailment-specific test
- Strike response (§6.2.2) — skip movement toward blocked city during operate; skip build in rail-closure area; do not abandon
- Flood response (§6.2.3) — mid-execution affordability re-check scoped to remaining segments only (from `currentStopIndex` forward); virtual track excludes already-traversed segments; if affordable, keep plan and rebuild; if not, abandon
- Tax response (§6.2.6) — re-check remaining-segment affordability with updated cash
- Snow/fog response (§6.2.4) — reduced movement points handled naturally by movement loop; impassable terrain → wait; no building in fog area → skip
- Gale response (§6.2.5) — blocked ferry → wait; half-speed handled same as snow
- Known approximation documented (§A.81) — partial-segment overcount accepted

**Tests:**
- Derailment drops carried good → `shouldAbandon` fires → replan
- Derailment with no relevant cargo → plan unchanged, stuck counter increments
- Strike blocks next stop → skip movement, don't abandon
- Flood destroys affordable track → keep plan, rebuild next build phase
- Flood destroys unaffordable track → abandon and replan
- Flood mid-execution re-check uses remaining segments only (not full plan)
- Tax reduces cash below remaining build cost → abandon
- Tax reduces cash but plan still affordable → continue
- Stranded train (flood isolates) → stays put during operate, build reconnects

### Commit 8: Endgame

**Sections:** §8.1–§8.5, §4.4 Gate 3

**What ships:**
- `checkEndgame` trigger (§8.1) — `player.cash + netPayout >= winCashThreshold` (liberal, no build cost); `netPayout` accounts for debt auto-deductions; `aiState.endgameMode` flag, never unset
- Major city connectivity check (§8.2) — connected = continuous path of owned track from city to largest connected component
- Endgame build priority in `computeBuildOrder` (§8.3) — when plan route fully built, connect cheapest unconnected major cities; build out per §2.4
- Turns-to-win scoring in `scorePlan` (§8.4) — winning plans scored as `1000 - turnsToWin`; `turnsToWin = max(totalBuildTurns + cityConnectionBuildTurns, operateTurns)`; non-winning plans fall back to ECU/turn
- Gate 3 in `shouldUpgrade` (§4.4) — when endgame and `citiesNeeded > 0`, upgrade only if `surplus - 20M >= totalCityConnectionCost`

**Tests:**
- Endgame triggers when any candidate plan would cross cash threshold (after debt)
- Endgame flag never unsets
- Major city connectivity counts only cities on largest connected component
- Endgame build priority connects cheapest unconnected major cities first
- Turns-to-win scoring beats ECU/turn for winning plans
- Faster winning plan beats higher-payout winning plan
- Non-winning plans scored normally (ECU/turn) alongside winning plans
- Gate 3 skips upgrade when surplus after upgrade can't fund city connections
- Gate 3 allows upgrade when surplus covers both

### Commit 9: Logging and server integration

**Sections:** §7, §11.3.4

**What ships:**
- Decision logging at all points (§7.1–§7.5) — target selection, build phase, operate phase, discard decision, plan abandonment
- `executeHardAITurn` in `server.js` (§11.3.4) — two-phase execution: `planOperate` → execute → `planBuild` → execute
- Route `difficulty: 'hard'` to `ai-hard` strategy in `executeAITurn` / `maybeScheduleAITurn`
- Handle `borrow` action type in `executeAIAction`
- Operate action failure is non-fatal (skip remaining, proceed to build)
- Discard ends the turn (no build phase follows)
- `planBuild` sees post-event state (post-delivery cash, post-flood track)

**Tests (integration):**
- Hard AI turn executes operate then build phase in sequence
- Delivery mid-operate triggers card draw event → build phase sees updated state
- Discard in operate phase → no build phase follows
- Operate action failure → build phase still runs
- `borrow` action applies correctly via `executeAIAction`
- Full multi-turn game: Hard AI builds, deploys, picks up, delivers, replans
- Hard AI vs Easy AI in same game (mixed difficulty)

---

## Appendix A: Open Design Clarifications

Items identified during design review that need resolution before or during implementation. Each item references the section it affects. Items are resolved in place (the referenced section is updated with the answer) and then checked off here.

- [x] **A.1 — Batch pruning criteria (§1.2).** Resolved: 5-hex threshold, validated by simulation. ~101 pairs per hand, ~0.8s compute.
- [x] **A.2 — Leg build cost definition (§1.3).** Resolved: replaced leg-based model with segment-based model. Build cost is computed per-segment of the visit sequence (network → stop 1, stop 1 → stop 2, etc.), with each segment accounting for track already built by earlier segments. Cash is checked at each delivery point. Explicit example added to §1.3.
- [x] **A.3 — Turn estimation for batches (§1.4).** Resolved: build turns are estimated per segment group (segments between consecutive deliveries), not for the whole plan at once. Each group uses the effective cash at that point in the plan — after subtracting earlier build costs and adding earlier payouts. This correctly handles mid-plan cash changes. Worked example added to §1.4.
- [x] **A.4 — Trip sequence vs. build sequence (§2.3).** Resolved: always build in visit-sequence order. Building later segments first wastes operate turns (can't use track that doesn't connect to the next stop), breaks the cash checkpoint model, and adds complexity for no gain. Clarification added to §2.3.
- [x] **A.5 — Build direction for minor cities (§2.4).** Resolved: the "build out" rule applies only to major cities. You can only start a disconnected build from a major city, not a minor city. Minor cities must always be built into from the existing network (3M entry cost, unavoidable). §2.4 corrected to reflect this game rule.
- [x] **A.6 — Deploy logic for subsequent plans (§3.1).** Resolved: "deploy at pickup 1" is first-plan only. For subsequent plans, the train stays on the map and moves along existing track toward the new plan's first stop. Plan selection accounts for travel distance from current train position. Build cost only covers unbuilt segments between visit-sequence stops, not getting the train there. §3.1 updated with full subsequent-plan logic.
- [x] **A.7 — When to pick up good 2 in a batch (§3.2).** Resolved: the visit sequence (§1.2.1) encodes the full interleaved order of pickups and deliveries. The movement loop simply follows the visit sequence — no special "should I pick up good 2" logic needed. All 6 valid orderings (including interleaved ones like pA → pB → dB → dA) are evaluated during plan selection.
- [x] **A.8 — Carrying two goods simultaneously (§3.2).** Resolved: the visit sequence handles this. If the optimal ordering is pA → pB → dB → dA, the AI carries both goods between pB and dB. Which dropoff comes first is determined by the visit sequence that scored highest during plan selection.
- [x] **A.9 — Definition of "stuck with no progress" (§1.6).** Resolved: progress = built track toward plan, picked up a good, delivered a good, or moved closer to next stop. If none of these for 3 consecutive turns → abandon (raised from 2 to absorb 1-turn event disruptions per A.45). Counter stored in `aiState.stuckTurnCounter`, resets on any progress. Definition added to §1.6.
- [x] **A.10 — Event card handling.** Resolved: added §6.2 covering all event types. General principle: temporary disruptions (strikes, snow, fog, gales) are waited out; permanent damage (floods destroying track, tax reducing cash) can trigger plan abandonment. Derailments that destroy carried goods trigger replan. Stuck counter increments normally during event-affected turns — the 3-turn threshold absorbs typical 1-turn disruptions (see A.45).
- [x] **A.11 — Upgrade evaluation vs. committed plan (§4.4).** Resolved: simplified to two checks. Gate 1: can the AI afford its entire committed route? Gate 2: is there 20M surplus after route costs? If yes, upgrade to Fast Freight. No payback math, no game-length estimation. Surplus cash naturally gates timing — early game has no surplus, mid-game does. Hard AI only considers Fast Freight; heavier upgrades deferred to Brutal. §4.4 rewritten.
- [x] **A.12 — Endgame trigger timing (§8.1).** Resolved: check at two points: (1) during plan selection, so endgame scoring (turns-to-win) influences plan choice; (2) at the start of each build phase, so a delivery completed during operate can immediately trigger endgame build priority. Stored as `aiState.endgameMode` flag.
- [x] **A.13 — Major city "connected" definition (§8.2).** Resolved: a major city is connected if there is a continuous path of owned track from that city to the AI's main network (largest connected component). Isolated segments don't count. All counted major cities must be part of one contiguous network. §8.2 updated.
- [x] **A.14 — shouldDiscard in initialBuilding pseudocode (§11.3).** Resolved: removed `shouldDiscard` call from the `initialBuilding` branch. Added comment explaining that discarding is not a legal action during initial building. §11.3 pseudocode corrected.
- [x] **A.15 — Borrowing decision.** Resolved: the Hard AI strongly prefers discarding over borrowing (2× penalty is too severe). Borrowing only triggers after a **discard loop** — 2 consecutive discards with no viable plan either time. At that point, borrow the smallest amount that unlocks a plan with positive effective ECU/turn after repayment. Borrowing while in debt is allowed if the math supports it — the effective ECU/turn calculation accounts for total outstanding debt, and the 2× penalty naturally discourages stacking (§5.4.3). Never borrow during initial building or proactively. `aiState.consecutiveDiscards` counter tracks the loop. §5.4rewritten.
- [x] **A.16 — Train capacity in batch planning.** Resolved: all train types carry at least 2 goods (Freight/Fast Freight = 2, Heavy Freight/Superfreight = 3). Since 2-batches never require carrying more than 2 goods simultaneously, capacity is never a constraint for Hard AI batch planning. No code change needed. Brutal AI's 3-batches would need to check capacity (only Heavy Freight/Superfreight can carry 3).
- [x] **A.17 — Section numbering.** Resolved: §10 subsections renumbered from §11.x to §10.1–§10.7. Cross-references verified.
- [x] **A.18 — tripHexDistance for subsequent plans (§1.4, §3.1).** Resolved: `tripHexDistance` includes travel from the train's current position to the first visit-sequence stop. For first plans, this is 0 (deploy at pickup 1). For subsequent plans, it's the track-based distance from the train's current location. §1.4 formula comment and §3.1 updated.
- [x] **A.19 — shouldDiscard null plan handling (§5.1, §5.2, §11.3).** Resolved: `planTurn` handles null plan (no viable plan, §5.1) *before* calling `shouldDiscard`. Null triggers the §5.4 borrowing/discard flow via `handleNoPlan`. `shouldDiscard` only receives non-null plans and handles §5.2 threshold check. §11.3 pseudocode updated.
- [x] **A.20 — Upgrade consumes full build phase (§4.4, §11.3).** Resolved: upgrading consumes the entire build phase — no building occurs that turn. The surplus gate ensures this is low-cost. §4.4 updated with explicit statement.
- [x] **A.21 — Endgame scoring in selectPlan vs scorePlan (§8.4, §1.5).** Resolved: `scorePlan` handles the endgame scoring mode switch by reading `aiState.endgameMode`. In endgame, winning plans are scored as `1000 - turnsToWin`, guaranteeing they always outscore non-winning plans (ECU/turn << 1000) and faster wins rank higher. `selectPlan` always picks the max. §8.4 updated.
- [x] **A.22 — Borrowing while in debt (§5.4.3).** Resolved: dropped "avoid borrowing while in debt" language. The effective ECU/turn calculation already accounts for total outstanding debt — the 2× penalty on stacked debt naturally discourages repeated borrowing without needing a separate rule. §5.4.3 updated.
- [x] **A.23 — Batch pruning distance metric (§1.2).** Resolved: Euclidean point-to-line-segment distance in world coordinates. §1.2 updated with explicit definition.
- [x] **A.24 — Major city selection scope (§2.2).** Resolved: joint optimization — `selectPlan` evaluates every candidate plan against all 8 major cities during initial building, picking the best (plan, majorCity) pair. `selectMajorCity` is a thin accessor that returns `plan.majorCity`. No per-round budget filter; initial building spans two rounds (40M total). §1.2, §2.2, §11.1, §11.2, §11.3, §11.5 updated.
- [x] **A.25 — buildPath computation timing (§3.3, §11.5).** Resolved: `buildPath` is computed and stored during plan selection as a side effect of pathfinding for build cost. Available to both operate phase (frontier movement) and build phase. §3.3 and §11.5 updated.
- [x] **A.26 — Virtual track set for segment deduplication (§1.3).** Resolved: a `Set<milepostId>` accumulates mileposts from earlier segments. The pathfinder treats set members as already built (cost = 0). §1.3 pseudocode updated with explicit virtual track set.
- [x] **A.27 — Endgame build vs save budget (§4.3, §8.3).** Resolved: endgame major city connections are handled inside `computeBuildOrder`. When `aiState.endgameMode` is true and the plan route is complete, `computeBuildOrder` returns major city connection segments instead of nothing. §4.3's "save budget" is the default when `computeBuildOrder` has nothing to return. §4.3 and §8.3 updated.
- [x] **A.28 — Borrowing-while-in-debt contradiction (§5.4.3, A.15).** Resolved: A.15 previously said "never borrow while in debt," contradicting §5.4.3 which allows it when the math supports it. A.15 updated to match §5.4.3 — borrowing while in debt is allowed; the effective ECU/turn calculation accounts for total outstanding debt and the 2× penalty naturally discourages stacking.
- [x] **A.29 — Endgame scoring scale mismatch (§8.4).** Resolved: `1 / turnsToWin` scoring for winning plans produced values (~0.1–0.5) far below normal ECU/turn scores (~2–10+), so `selectPlan` would pick non-winning plans over winning ones. Changed to `1000 - turnsToWin`, guaranteeing all winning plans outscore all non-winning plans. §8.4 and A.21 updated.
- [x] **A.30 — `handleNoPlan` undefined (§5.4, §11.1, §11.3).** Resolved: `handleNoPlan` was called in `planTurn` pseudocode but never specified as a strategy function. Added to §11.1 strategy pattern, §11.2 override table (Brutal AI can replace with EV-based logic), and new §5.4.4 with full behavioral spec and pseudocode.
- [x] **A.31 — Build phase with no committed plan (§11.3).** Partially resolved: `discardHand` ends the entire turn (no build phase follows after discard). However, the plan can also be null if all deliveries completed during the operate phase. This case is now handled by the null-plan guard added in A.49 — skip upgrade, call `computeBuildOrder(null)` for endgame actions or save budget.
- [x] **A.32 — Visit sequence last-stop invariant unvalidated (§1.2.1, §1.3).** Resolved: defense in depth — validate at generation time in `enumeratePlans` (§1.2.1) and assert at consumption time in `checkAffordability` (§1.3). Both locations updated. Critical for Brutal AI's extensible sequence generation.
- [x] **A.33 — `tripHexDistance` undefined for batches (§1.4).** Resolved: renamed to `tripDistance`. Defined as track-based milepost count along the planned build path (not Euclidean). For batches, sum milepost count between consecutive visit-sequence stops. Build path is already available from plan selection (§3.3, A.25). §1.4 updated.
- [x] **A.34 — Stuck counter / discard loop cycle (§1.6, §5.4).** Resolved: the stuck counter and consecutive discard counter can create a cycle (stuck → abandon → discard → borrow → stuck). This is self-correcting — each borrow adds 2× debt, raising the bar for future plans until the AI discards instead of borrowing. No circuit breaker needed. §1.6 updated with documentation of expected behavior.
- [x] **A.35 — Plan selection / major city chicken-and-egg (§1.2, §2.2, §11.3).** Resolved: joint optimization — during initial building (no existing network), `selectPlan` evaluates every candidate plan against all 8 major cities, picking the best (plan, majorCity) pair. The major city is stored in `plan.majorCity`. `selectMajorCity` becomes a thin accessor. §1.2, §2.2, §11.1, §11.2, §11.3, §11.5 updated.
- [x] **A.36 — Endgame trigger ignores debt (§8.1, §8.4).** Resolved: the endgame trigger now computes `netPayout = totalPayout - min(outstandingDebt, numDeliveries * 10)` to account for per-delivery auto-deductions. The trigger check uses `player.cash + netPayout >= winCashThreshold` (liberal, no build cost subtracted — this is intentional so the AI enters endgame mode slightly early rather than late). The winning-plan check in `scorePlan` (§8.4) is stricter: `player.cash + netPayout - plan.totalBuildCost >= winCashThreshold`, ensuring only plans that actually produce enough cash after building are scored as winning plans. §8.1 and §8.4 updated.
- [x] **A.37 — Borrowing repayment formula doesn't match 10M/delivery mechanic (§5.4.2, §5.4.3, §5.4.4).** Resolved: replaced `repaymentCost = borrowAmount * 2 + existingDebt` with per-delivery deduction model: `totalDebt = outstandingDebt + borrowAmount * 2; deductionsThisPlan = min(totalDebt, numDeliveries * 10)`. This matches the actual game mechanic (10M auto-deducted per delivery). The old formula was overly conservative for single deliveries and could cause the AI to reject viable borrows when existing debt exceeded the plan's repayment capacity. §5.4.2, §5.4.3, §5.4.4 updated.
- [x] **A.38 — Upgrade endgame edge case can't be evaluated at decision time (§4.4, §11.3).** Resolved: added Gate 3 to `shouldUpgrade` — when in endgame mode and `citiesNeeded > 0`, check total city connection cost against surplus after upgrade. Upgrade only when `surplus - 20M >= totalCityConnectionCost` (can afford both). Originally checked only cheapest single city; corrected by A.75 to use total needed connections. §4.4 updated.
- [x] **A.39 — Turn estimation adds build + operate sequentially, but they're interleaved (§1.4).** Resolved: changed `totalTurns = totalBuildTurns + operateTurns` to `totalTurns = max(totalBuildTurns, operateTurns)`. Each game turn has both an operate and a build phase — the AI moves toward the frontier while building. The sum double-counted overlapping turns and systematically biased plan selection against build-heavy plans. §1.4 updated.
- [x] **A.40 — Weak-plan discard loop has no escape mechanism (§5.2, §5.4).** Resolved: added `aiState.consecutiveWeakDiscards` counter. Increments each time `shouldDiscard` triggers (plan < 2 ECU/turn). After 2 consecutive weak discards, `shouldDiscard` returns false — the AI accepts the best available plan. Resets to 0 on plan commitment. Separate from `consecutiveDiscards` (§5.4), which tracks the no-viable-plan case. §5.2 updated; §9 parameter table updated.
- [x] **A.41 — Movement loop pseudocode doesn't integrate frontier movement (§3.2, §3.3).** Resolved: added explicit branch in §3.2 pseudocode for when track doesn't reach the next stop. Branch 2b checks whether nextStop is reachable on owned track; if not, falls through to frontier movement — move to the farthest milepost on owned track that's on the planned build path, or (fallback) the milepost closest (Euclidean) to the network attachment point. §3.2 pseudocode updated; §3.3 fallback metric pinned to Euclidean distance.
- [x] **A.42 — Plan commitment to aiState never shown in planTurn (§11.3, §1.6).** Resolved: added explicit `commitPlan(gs, playerIndex, plan)` calls in §11.3 pseudocode. In `initialBuilding`: after `selectPlan` succeeds (persists into round 2). In `operate`: after `shouldDiscard` passes (so discarded plans are never committed). This also resolves the initial building round-unawareness issue — round 2 reads the committed plan via `getCommittedPlan` instead of re-running `selectPlan`.
- [x] **A.43 — Execution sequence defined by two conflicting criteria (§2.5, §1.2.1).** Resolved: §2.5 said "determined by which ordering minimizes total travel distance" while §1.2.1 said "scores highest on ECU/turn." These aren't the same optimization. Removed the conflicting sentence and edge case from §2.5 — initial building now simply follows the visit sequence already determined by plan selection (§1.2.1) as the single source of truth.
- [x] **A.44 — Virtual track set initialization wrong during initial building (§1.2, §1.3).** Resolved: defined the selected major city's milepost as the player's initial network during initial building. All downstream logic (`virtualTrack` initialization in §1.3, pathfinding from "the existing network," frontier movement in §3.3) works without special-casing — the major city milepost is in the player's network set from the start. §1.2 updated.
- [x] **A.45 — Stuck counter event-pause mechanism unspecified (§1.6, §6.2).** Resolved: raised stuck threshold from 2 to 3 turns. The counter always increments (no event-detection logic). The 3-turn threshold naturally absorbs typical 1-turn event disruptions (strikes, fog, gales, derailments) without false abandonment. Removed all "stuck counter does not increment during events" language from §6.2.1, §6.2.2, §6.2.4, §6.2.7. §1.6, §6.2, §7.5, §9 updated.
- [x] **A.46 — Flood replanning trigger inconsistency (§1.6, §6.2.3).** Resolved: §1.6 listed flood as an unconditional replan trigger; §6.2.3 added a condition (only if rebuild unaffordable). Aligned §1.6 with §6.2.3 — flood triggers replanning only when the rebuild cost makes the plan unaffordable, checked via §1.3 affordability with updated track state. If affordable, keep the plan and rebuild next build phase. §6.2.3 "within budget" pinned to the §1.3 framework.
- [x] **A.47 — Endgame trigger conflates committed plan and candidate plans (§8.1).** Resolved: §8.1 said "the AI's current committed plan" but check point (1) fires during plan selection when evaluating candidates. Clarified: during plan selection, `scorePlan` evaluates the endgame formula per candidate — if any candidate crosses the threshold, `aiState.endgameMode` activates and scoring switches to turns-to-win. During build phase, the formula is checked against the committed plan. §8.1 updated with explicit per-checkpoint language.
- [x] **A.48 — `handleNoPlan` returns undefined `planActions` (§5.4.4).** Resolved: `planActions` is now explicitly defined as `strategy.planMovement(gs, playerIndex, ctx, plan)` — the AI borrows and operates in the same turn. Borrowing is an instant action; the AI already lost 2 turns to discarding and shouldn't lose a 3rd. `handleNoPlan` calls `commitPlan` before `planMovement`. §5.4.4 pseudocode and Returns line updated.
- [x] **A.49 — Build phase with null/completed plan (§11.3).** Resolved: added null-plan guard in §11.3's build branch. If `getCommittedPlan` returns null (plan completed mid-turn), skip `shouldUpgrade` (no plan to evaluate surplus against — avoids spending 20M that may be needed for the next plan) and call `computeBuildOrder(null)` which returns endgame major city connections if applicable, or nothing (save budget). §11.3 pseudocode updated.
- [x] **A.50 — Disconnected train after flood mentioned but unresolved (§3.1, §6.2.3).** Resolved: stranding is a special case of §6.2.3 — the flood's rebuild cost includes reconnecting the train's segment, checked via §1.3 affordability. While stranded, the movement loop finds no path and the train stays put. The build phase prioritizes rebuilding the destroyed crossing. The 3-turn stuck counter (§1.6) provides a safety net. §3.1 edge case and §6.2.3 updated with explicit stranded-train behavior.
- [x] **A.51 — §8.5 "enough cash" formula not provided.** Resolved: added explicit formula: `cashAfterPlan = player.cash + netPayout - plan.totalBuildCost; cashAfterPlan >= cheapestMajorCityConnectionsCost`, where `cheapestMajorCityConnectionsCost` is the sum of build costs for the `citiesNeeded` cheapest unconnected major cities. Among qualifying plans, the AI selects the fastest. §8.5 updated.
- [x] **A.52 — Deployment assumes pickup 1 reachable after initial building (§1.2, §3.1).** Resolved: the §1.3 affordability check (`totalBuildCost <= player.cash`) doesn't guarantee pickup 1 is reachable within the 40M initial building budget (2 rounds × 20M). A plan costing 45M passes affordability with 50M starting cash but can't reach pickup 1 before the first operate phase. Added an initial building reachability filter to §1.2: during initial building, the build cost from the major city to pickup 1 must be ≤ 40M. Plans failing this filter are excluded. The remaining route (beyond pickup 1) can exceed 40M and is built during normal build phases. §3.1 updated to reference the filter.
- [x] **A.53 — §8.4 winning-plan check omits build cost (§8.1, §8.4, §8.5).** Resolved: §8.4's `scorePlan` check for winning plans used `player.cash + netPayout >= winCashThreshold`, but the AI must spend cash on building before it earns payout. A plan with high build cost could be incorrectly scored as winning. Changed §8.4 to `player.cash + netPayout - plan.totalBuildCost >= winCashThreshold`, consistent with §8.5. The §8.1 endgame trigger intentionally keeps the liberal formula (no build cost subtraction) so the AI enters endgame mode slightly early rather than late. §8.4, A.36 updated.
- [x] **A.54 — §11.3 initial building re-runs selectPlan on round 2 (§11.3, A.42).** Resolved: the `planTurn` pseudocode always ran `selectPlan` in the `initialBuilding` branch, contradicting A.42 which says round 2 should reuse the committed plan. On round 2, re-evaluating could pick a different plan/major city, wasting round 1's track. Fixed: added `getCommittedPlan` check at the top of the initial building branch. Only calls `selectPlan` if no committed plan exists (round 1). §11.3 pseudocode updated.
- [x] **A.55 — Abandoned plan with carried good has no delivery tracking (§3.4).** Resolved: §3.4 said "deliver that good first" after plan abandonment but didn't specify how the AI tracks the delivery destination without a plan. Fixed: when abandoning mid-batch while carrying a good, the AI creates a **residual single-delivery plan** containing the carried good's delivery info (destination from the original demand card) and a single-stop visit sequence. All plan-based machinery (movement loop, build phase, commitment) works unchanged. §3.4 updated.
- [x] **A.56 — Redundant carrying check in §5.2 and §5.3.** Resolved: §5.2 included "not currently carrying a good" as a discard condition, and §5.3 separately stated the same rule. Removed the carrying check from §5.2 and made §5.3 the single canonical guard — `shouldDiscard` returns false immediately when carrying, before any threshold logic runs. §5.2 now references §5.3 for this guard. §5.2 and §5.3 updated.
- [x] **A.57 — §6.2.1 stuck counter contradicts A.45 (§6.2.1, §1.6).** Resolved: §6.2.1 still said "stuck counter does not increment for the lost turn" for derailments, contradicting A.45's resolution that the counter always increments with no event-detection logic. Updated §6.2.1 to match — the counter increments normally, and the 3-turn threshold absorbs the single-turn disruption. A.45 updated to include §6.2.1 in the list of corrected sections.
- [x] **A.58 — §11.3 operate phase calls shouldDiscard on committed plans (§11.3, §1.6).** Resolved: `planTurn`'s operate branch ran `shouldDiscard` and `commitPlan` on plans retrieved from `getCommittedPlan`, potentially rejecting mid-execution plans and contradicting §1.6 commitment rules. Fixed: committed plans now get an early return path that checks §1.6 abandonment conditions (supply exhaustion, flood affordability, stuck counter) and then proceeds directly to `planMovement`. `shouldDiscard` and `commitPlan` only run on freshly selected plans. §11.3 pseudocode updated.
- [x] **A.59 — consecutiveDiscards not reset on weak-plan discards (§5.4.1, §5.2).** Resolved: `consecutiveDiscards` only reset when the AI committed to a plan, meaning a weak-plan discard (§5.2) between two no-plan discards didn't reset the counter — triggering borrowing after only 1 actual consecutive no-plan discard. Fixed: `consecutiveDiscards` now also resets to 0 when `shouldDiscard` triggers a weak-plan discard, since finding a viable plan proves cash isn't the issue. §5.4.1 updated.
- [x] **A.60 — Movement loop has no termination when all stops completed (§3.2).** Resolved: the movement loop pseudocode had no exit condition for when all visit-sequence stops were visited with movement points remaining. Added `if no nextStop: break` at the top of the loop. Remaining movement points are unused — the plan is complete, and speculative movement would require knowledge of the next plan. §3.2 updated.
- [x] **A.61 — Plan completion lifecycle unspecified (§3.2, §11.3).** Resolved: nothing in the design specified when a committed plan transitions to null after all stops are visited. Fixed: `planMovement` checks `currentStopIndex >= visitSequence.length` after the movement loop and clears the committed plan from `aiState` if complete. The build phase sees `getCommittedPlan()` return null and handles accordingly (endgame actions or save budget per §4.3). §3.2 pseudocode updated with post-loop completion logic.
- [x] **A.62 — "Moved closer" progress metric undefined (§1.6).** Resolved: progress condition 4 said "track distance to the next stop decreased" but during frontier movement (§3.3), the stop is unreachable on owned track — track distance is undefined. Fixed: when the next stop is reachable on owned track, measure track distance to the stop. During frontier movement, measure track distance to the **frontier milepost** (§3.3) instead. The two metrics converge once track is extended to reach the stop. §1.6 updated.
- [x] **A.63 — Movement loop doesn't check supply before pickup (§3.2, §3.4).** Resolved: the movement loop pseudocode picked up goods without checking availability, even though §3.4 defines supply exhaustion behavior. Added an availability check at pickup time in the movement loop — if the good is unavailable, trigger §3.4 (abandon plan, create residual plan if carrying, break out of loop). §3.2 pseudocode updated.
- [x] **A.64 — §6.2.6 tax re-check scope unclear (§6.2.6, §1.3).** Resolved: the tax affordability re-check didn't specify whether to use remaining or total build cost. Clarified: use **remaining** build cost (only unbuilt segments), since already-built segments are sunk costs. Now uses the §1.3 mid-execution affordability re-check (A.72) scoped to remaining segments from `plan.currentStopIndex` forward. §6.2.6 updated.
- [x] **A.65 — consecutiveWeakDiscards increment location unspecified (§5.2).** Resolved: §5.2 said the counter increments "each time shouldDiscard triggers" but didn't specify where. Clarified: incremented inside `shouldDiscard` as a side effect when the function returns true. Keeps `planTurn` clean as an orchestrator. §5.2 updated.
- [x] **A.66 — §7.2 logging template stale after §4.4 rewrite (§7.2, §4.4).** Resolved: the build phase log template still referenced "Gate 2 (payback): loss/benefit/payback" from the old upgrade evaluation. Updated to match §4.4's surplus-based check: "Gate 2 (surplus): surplus={surplus}M (threshold: 20M)". §7.2 updated.
- [x] **A.67 — turnsToWin computation location unclear (§8.4).** Resolved: `estimatedBuildTurnsForMajorCityConnections` was referenced in `scorePlan`'s turnsToWin formula but the computation lived in `checkEndgame`/`computeBuildOrder`. Clarified: computed inside `scorePlan` when `aiState.endgameMode` is true, using the same cheap-city-connection lookup as `computeBuildOrder`. Explicit formula added by A.76. Minor duplication keeps `scorePlan` self-contained. §8.4 updated.
- [x] **A.68 — §8.5 funding plan selection criteria unclear (§8.5, §8.4).** Resolved: §8.5 said "select the fastest" but didn't specify how this interacts with `scorePlan`'s scoring modes. Clarified: this is not a separate scoring mode — it falls out naturally from §8.4's `1000 - turnsToWin` scoring, where plans that fund city connections score highest because they represent the fastest path to victory. §8.5 updated with explanatory note.
- [x] **A.69 — Section numbering gaps (§5, §6).** Resolved: §5 jumped from §5.3 to §5.5 (no §5.4); §6 jumped from §6 to §6.5 (no §6.1–§6.4). Renumbered: §5.5 → §5.4, §6.5 → §6.2. All cross-references updated throughout the document and appendix.
- [x] **A.70 — §9 missing endgame upgrade tuning parameter (§4.4, §9).** Resolved: §4.4's Gate 3 always skips upgrade when cities are needed, even with surplus large enough for both. Added to §9 tuning table as a parameter to watch during playtesting. §9 updated.
- [x] **A.71 — Deployment action missing from `planMovement` pseudocode (§3.1, §3.2).** Resolved: §3.1 specified "deploy at pickup 1" but the §3.2 movement loop pseudocode had no deployment step — it assumed the train was already on the map. Added a deployment preamble to `planMovement` (§3.2): before the movement loop, check if the train is deployed; if not, emit `{ type: 'deployTrain', city: pickup1 }`. After deployment, the loop's first iteration immediately triggers pickup at that city. §3.1 updated to reference the preamble location. §3.2 pseudocode updated.
- [x] **A.72 — Flood affordability re-check over-counts already-traversed segments (§1.3, §6.2.3, §6.2.6).** Resolved: §6.2.3 said "re-run §1.3 affordability check" but §1.3 evaluates the full plan from segment 1. For a mid-execution flood, destroyed track in already-traversed segments (behind the AI) would be included in the rebuild cost, even though the AI has already picked up goods from those stops and doesn't need that track to complete the current plan. This caused false plan abandonment. Fixed: added a **mid-execution affordability re-check** variant to §1.3 that scopes to remaining segments only (from `plan.currentStopIndex` forward). Already-traversed segments are sunk costs. §6.2.3 and §6.2.6 updated to reference the scoped re-check.
- [x] **A.73 — `selectPlan` doesn't accept `effectiveCash` override (§1.3, §1.4, §1.5, §5.4.4, §11.1).** Resolved: `handleNoPlan` (§5.4.4) called `selectPlan` with `{ effectiveCash }` to evaluate hypothetical borrowing, but `selectPlan`'s signature had no such parameter and §1.3's pseudocode hardcoded `effectiveCash = player.cash`. Fixed: §1.3 and §1.4 pseudocode now read `effectiveCash` from an `options` parameter (defaulting to `player.cash`). §1.5 documents the parameter threading from `selectPlan` → `checkAffordability`. §11.1 strategy pattern comments updated.
- [x] **A.74 — `turnsToWin` double-counts overlapping build and operate phases (§8.4).** Resolved: §8.4 computed `turnsToWin = plan.estimatedTurns + estimatedBuildTurnsForMajorCityConnections`, but `plan.estimatedTurns` is already `max(buildTurns, operateTurns)`. City connections are built during the build phase while the AI delivers during the operate phase — these overlap. The sequential sum systematically overestimated winning plan times (same class of error as A.39). Fixed: §8.4 now uses `turnsToWin = max(plan.totalBuildTurns + estimatedBuildTurnsForMajorCityConnections, plan.operateTurns)`. Build work is sequential (plan route first, then city connections per §8.3), but overlaps with operate. §11.5 plan data structure updated to store `totalBuildTurns` and `operateTurns` as separate pre-max components.
- [x] **A.75 — Gate 3 compares against cheapest single city, not total needed connections (§4.4, §9).** Resolved: Gate 3 checked only the cheapest single unconnected major city's cost against surplus. With multiple cities needed, this produced wrong decisions: skipping upgrade when surplus was large enough for both, or skipping when the AI couldn't afford all connections regardless. Fixed: Gate 3 now computes `totalCityConnectionCost` (sum of all `citiesNeeded` cheapest connections) and upgrades only when `surplus - 20M >= totalCityConnectionCost` — ensuring the AI can afford both the upgrade and all remaining city connections. §9 tuning table entry updated to reflect the new logic.
- [x] **A.76 — `estimatedBuildTurnsForMajorCityConnections` formula undefined (§8.4).** Resolved: §8.4 referenced this value in the `turnsToWin` formula but never defined how to compute it. City connections don't fit §1.4's segment-group structure (no delivery cash checkpoints). Fixed: added explicit formula to §8.4 using `cashAfterPlan = player.cash + netPayout - plan.totalBuildCost` as the available cash, then `cityBuildCashPerTurn = min(20, cashAfterPlan) * 0.75` (same 20M cap and 0.75 inefficiency factor as §1.4), yielding `totalCityConnectionCost / cityBuildCashPerTurn`. §8.4 pseudocode updated.
- [x] **A.77 — No reachability guard for post-initial-building first deployment (§3.1, §5.4.4, §1.2).** Resolved: the §1.2 reachability filter ("build cost from major city to pickup 1 ≤ 40M") only runs during initial building. If initial building failed to commit a plan (no affordable plan with starting cash) and the AI later commits a plan via `handleNoPlan`'s borrowing path (§5.4.4), the filter never ran — `planMovement`'s deployment preamble could deploy at an unreachable city with no track. Fixed: `selectPlan` now applies a **deployment reachability guard** when the train has never been deployed: pickup 1 must be reachable on existing track (or be a major city if no track exists). Plans failing the guard are excluded. §3.1 updated with edge case documentation and guard spec. §5.4.4 pseudocode updated with a comment referencing the guard.
- [x] **A.78 — Derailment plan abandonment mechanism unspecified (§6.2.1, §1.6, §11.3).** Resolved: §6.2.1 said "abandon the plan and replan" but never specified how — derailment is processed during event resolution (outside the AI's turn), and `shouldAbandon` (§11.3) only checked three triggers (supply exhaustion, flood affordability, stuck counter), none of which detect lost cargo. Fixed: added a **cargo integrity check** to `shouldAbandon` — verifies that goods the plan expects to be carried (based on visited pickup stops vs. visited delivery stops) are still in the player's actual cargo. If any expected good is missing, `shouldAbandon` returns true. This is general-purpose (catches derailment and any future cargo-removal mechanism). §6.2.1 updated with full abandonment mechanism. §1.6 abandonment trigger list updated. §11.3 `shouldAbandon` comment updated.
- [x] **A.79 — Build direction reversal vs. pre-computed buildPath cost/order mismatch (§2.4, §4.2, §1.3).** Resolved: `findCheapestBuildPath` computed paths assuming building INTO major cities (5M entry cost), but `computeBuildOrder` builds OUT (1M exit cost per §2.4). This caused §1.3 affordability to overestimate by 4M per mid-route major city, and the `buildPath` milepost order didn't match `computeBuildOrder`'s reversed build direction. Fixed: (1) §2.4 updated — `findCheapestBuildPath` must compute major-city segments using the build-out cost (1M), not the build-in cost (5M), so affordability and turn estimation use correct costs. The `buildPath` milepost sequence is stored in movement order (source → target) for the operate phase. (2) §4.2 updated — `computeBuildOrder` detects segments whose target is an unconnected major city and emits build actions in reverse milepost order (from major city outward). Forward order is used for all other segments.
- [x] **A.80 — Frontier movement targets unreachable disconnected build-out segments (§3.2, §3.3).** Resolved: the build-out-of-major-city rule (§2.4, A.79) creates disconnected track islands — `computeBuildOrder` builds outward from an unconnected major city, producing mileposts that are on `plan.buildPath` and on owned track but disconnected from the train's network component. The frontier logic (§3.3) found these mileposts as the "farthest on owned track on the build path," then `findTrackPath` returned no path (unreachable). The Euclidean fallback didn't fire because owned track DID overlap the build path — just on the wrong component. Fixed: added a **connected-component constraint** to §3.3 — the frontier milepost must be reachable from the train's current position on owned track. Implementation: BFS/flood-fill from the train's position, cached once per turn. The fallback now also filters to reachable mileposts ("no reachable owned track overlaps the build path"). §3.2 pseudocode step 2b and §3.3 updated.
- [x] **A.81 — Mid-execution affordability re-check overcounts within partial segments (§1.3, A.72).** Documented as known approximation: the re-check scopes to segment granularity (`currentStopIndex`), not the train's exact milepost within a segment. If a flood destroys track behind the AI on the current segment (between the last completed stop and the train's position), the re-check includes the rebuild cost even though the AI only moves forward. Same overcount affects `computeBuildOrder` (may rebuild behind-the-AI track). Both are accepted conservative approximations — a precise fix requires sub-segment position tracking. §1.3 mid-execution re-check updated with explicit documentation of the approximation and conditions under which it would need to be fixed.
- [x] **A.82 — Event cards fire mid-action-sequence, invalidating pre-computed build actions (§11.3, §6.2).** Resolved: the spec modeled events as between-turn occurrences, but in the actual game, events fire during card draws — which happen as side effects of `deliverGood` (replacement card) and `discardHand` (3 new cards). A single `planTurn` that pre-computed the entire turn (operate + build) planned build actions with pre-event state: pre-tax cash, pre-flood track, pre-derailment cargo. This caused `commitBuild` actions to overspend (tax reduced cash), reference destroyed track (flood), or follow a stale plan (derailment dropped cargo). Fixed: split `planTurn` into three entry points — `planTurn` (initial building only, no events), `planOperate` (operate phase), and `planBuild` (build phase, called by server after operate actions execute with post-event state). The committed plan is never re-evaluated between phases — `planBuild` reads the same plan from `aiState`. `shouldAbandon` is deferred to next turn's `planOperate` start, preserving plan commitment. Server execution contract (§11.3.4) specifies: operate action failure is non-fatal (skip remaining, proceed to build), discard ends the turn (no build phase), and `planBuild` always sees real post-event state. §11.1, §11.2, §11.3 restructured.
