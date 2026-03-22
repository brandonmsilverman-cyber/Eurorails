// server/ai-brutal.js
// Brutal AI decision-making strategy module (9.5/10 difficulty).
// Inherits all logic from ai-hard.js and adds:
//   1. 3-delivery batch planning (triples) via greedy insertion
//   2. Two-stage train upgrade path: Freight → Fast Freight → Superfreight
// Everything else — plan commitment, movement loop, build ordering, endgame,
// event response — is identical to Hard AI.

const hard = require('./ai-hard');
const gl = require('../shared/game-logic');
const CITIES = gl.CITIES;
const GOODS = gl.GOODS;
const MAJOR_CITIES = gl.MAJOR_CITIES;
const TRAIN_TYPES = gl.TRAIN_TYPES;
const getTrainMovement = gl.getTrainMovement;
const getPlayerOwnedMileposts = gl.getPlayerOwnedMileposts;
const getMileppostCost = gl.getMileppostCost;
const getFerryKey = gl.getFerryKey;
const findPathOnTrack = gl.findPathOnTrack;

// ---------------------------------------------------------------------------
// §1.6 — Scoring constants (Brutal AI exclusive)
// ---------------------------------------------------------------------------

const NETWORK_VALUE_WEIGHT = 0.15;       // Up to 15% bonus for building through city-rich areas
const NETWORK_EFFICIENCY_WEIGHT = 0.30;  // Up to 30% bonus for using existing track
const NETWORK_VALUE_CAP = 8;             // Max raw networkValue before normalization
const CITY_PROXIMITY_HOPS = 2;           // BFS radius for city proximity tagging

// ---------------------------------------------------------------------------
// §1.6.1 — buildCityProximityMap (precomputed once per selectPlan call)
// ---------------------------------------------------------------------------

// Tags each milepost with a score based on nearby cities within CITY_PROXIMITY_HOPS.
// Major cities = 3, medium cities with goods = 2, small cities with goods = 1.
// Cities already connected to the player's network score 0 (no incremental value).
function buildCityProximityMap(ctx, player) {
    const connectedCities = new Set(hard.getConnectedMajorCities(ctx, player.color));
    const ownedMps = getPlayerOwnedMileposts(ctx, player.color);
    const map = new Map();

    for (const cityName in CITIES) {
        const mpId = ctx.cityToMilepost[cityName];
        if (!mpId) continue;

        // Skip cities already on the player's network
        const mp = ctx.mileposts_by_id[mpId];
        if (ownedMps.has(mpId)) continue;

        // Assign city value based on type and goods
        const cityData = CITIES[cityName];
        let value;
        if (MAJOR_CITIES.includes(cityName)) {
            value = 3;
        } else if (cityData.goods && cityData.goods.length > 0) {
            value = cityData.type === 'medium' ? 2 : 1;
        } else {
            continue; // No goods, no strategic value
        }

        // BFS outward from this city's milepost, tagging nearby mileposts
        const visited = new Set([mpId]);
        let frontier = [mpId];
        for (let hop = 0; hop <= CITY_PROXIMITY_HOPS; hop++) {
            for (const id of frontier) {
                map.set(id, (map.get(id) || 0) + value);
            }
            if (hop < CITY_PROXIMITY_HOPS) {
                const nextFrontier = [];
                for (const id of frontier) {
                    const m = ctx.mileposts_by_id[id];
                    if (!m || !m.neighbors) continue;
                    for (const nId of m.neighbors) {
                        if (!visited.has(nId)) {
                            visited.add(nId);
                            nextFrontier.push(nId);
                        }
                    }
                }
                frontier = nextFrontier;
            }
        }
    }

    return map;
}

// ---------------------------------------------------------------------------
// §1.6.2 — computeNetworkValue
// ---------------------------------------------------------------------------

// Walk a plan's buildPath and sum proximity values for NEW edges only.
// Normalized by new edge count to avoid bias toward longer paths.
function computeNetworkValue(plan, player, ctx, cityProximityMap) {
    if (!plan.buildPath || plan.buildPath.length < 2) return 0;

    const ownedEdges = new Set();
    for (const t of ctx.tracks) {
        if (t.color === player.color) {
            ownedEdges.add(t.from + '|' + t.to);
            ownedEdges.add(t.to + '|' + t.from);
        }
    }

    let totalValue = 0;
    let newEdgeCount = 0;
    const counted = new Set();

    for (let i = 0; i < plan.buildPath.length - 1; i++) {
        const edgeKey = plan.buildPath[i] + '|' + plan.buildPath[i + 1];
        if (ownedEdges.has(edgeKey)) continue;

        newEdgeCount++;
        // Count each milepost's value once
        for (const mpId of [plan.buildPath[i], plan.buildPath[i + 1]]) {
            if (!counted.has(mpId)) {
                counted.add(mpId);
                totalValue += cityProximityMap.get(mpId) || 0;
            }
        }
    }

    return newEdgeCount > 0 ? totalValue / newEdgeCount : 0;
}

// ---------------------------------------------------------------------------
// §1.6.3 — computeNetworkEfficiency
// ---------------------------------------------------------------------------

// Returns a 0..1 score representing how much of the plan uses existing track.
// 1.0 = zero build cost (free delivery), 0.5 = build cost equals payout.
function computeNetworkEfficiency(plan) {
    return plan.totalPayout / Math.max(plan.totalPayout + plan.totalBuildCost, 1);
}

// ---------------------------------------------------------------------------
// §1.6.4 — scorePlan (override)
// ---------------------------------------------------------------------------

// Extends Hard AI scoring with network reusability and efficiency bonuses.
function scorePlan(plan, player, gs, ctx, options) {
    const baseScore = hard.scorePlan(plan, player, gs, ctx, options);

    // Don't modify endgame winning plan scores (inverted, 900-1000 range)
    if (baseScore >= 900) return baseScore;

    const cityProximityMap = (options && options.cityProximityMap) || new Map();
    const networkValue = computeNetworkValue(plan, player, ctx, cityProximityMap);
    const efficiency = computeNetworkEfficiency(plan);

    const normalizedNetworkValue = Math.min(networkValue / NETWORK_VALUE_CAP, 1.0);
    const bonus = 1.0
        + NETWORK_VALUE_WEIGHT * normalizedNetworkValue
        + NETWORK_EFFICIENCY_WEIGHT * efficiency;

    const adjustedScore = baseScore * bonus;
    plan.ecuPerTurn = adjustedScore;
    return adjustedScore;
}

// ---------------------------------------------------------------------------
// §1.2 — Capacity-aware sequence validation
// ---------------------------------------------------------------------------

// Check whether a visit sequence respects the train's cargo capacity.
// Returns false if the number of goods being carried ever exceeds capacity.
function sequenceRespectsCapacity(visitSequence, capacity) {
    let carrying = 0;
    for (const stop of visitSequence) {
        if (stop.action === 'pickup') {
            carrying++;
            if (carrying > capacity) return false;
        } else if (stop.action === 'deliver') {
            carrying--;
        }
    }
    return true;
}

// ---------------------------------------------------------------------------
// §1.2 — Greedy insertion of 3rd delivery into a 2-batch sequence
// ---------------------------------------------------------------------------

// Given a 2-batch visit sequence (4 stops) and a 3rd delivery (pickup + deliver),
// generate all valid insertion positions for the 3rd delivery's pickup and delivery.
// Constraints:
//   - Pickup must come before delivery
//   - Sequence must end with a delivery
//   - Capacity must not be exceeded at any point
// Returns an array of 6-element visit sequences (index arrays into the 6-stop array).
function generateTripleInsertions(basePairSequence, capacity) {
    // basePairSequence is a 4-element array of stop objects from a 2-batch.
    // We need to insert stops at indices 4 (pC) and 5 (dC) into the sequence.
    const results = [];
    const baseLen = basePairSequence.length; // 4

    // Try all positions for pC (index 4) and dC (index 5)
    for (let pPos = 0; pPos <= baseLen; pPos++) {
        for (let dPos = pPos + 1; dPos <= baseLen + 1; dPos++) {
            // Build the candidate sequence
            const seq = [];
            let baseIdx = 0;
            for (let i = 0; i <= baseLen + 1; i++) {
                if (i === pPos) {
                    seq.push(4); // pC
                } else if (i === dPos) {
                    seq.push(5); // dC
                } else {
                    if (baseIdx < baseLen) {
                        seq.push(basePairSequence[baseIdx]);
                        baseIdx++;
                    }
                }
            }

            // Validate: must have exactly 6 elements
            if (seq.length !== 6) continue;

            // Validate: last stop must be a delivery (odd index = delivery in stops array)
            // stops: pA(0), dA(1), pB(2), dB(3), pC(4), dC(5)
            const lastIdx = seq[seq.length - 1];
            if (lastIdx % 2 === 0) continue; // even indices are pickups

            results.push(seq);
        }
    }

    return results;
}

// ---------------------------------------------------------------------------
// §1.2 — buildTripleBatchPlan
// ---------------------------------------------------------------------------

// Build a triple-batch plan for 3 deliveries with a given visit sequence.
// Follows the same pattern as hard.buildBatchPlan but with 6 stops.
// Returns null if paths can't be found or the sequence is invalid.
function buildTripleBatchPlan(ctx, player, deliveryA, deliveryB, deliveryC, sequenceIndices, majorId, majorCity, effectiveCash) {
    // Define the 6 stops: pA(0), dA(1), pB(2), dB(3), pC(4), dC(5)
    const stops = [
        { city: deliveryA.sourceCity, action: 'pickup', deliveryIndex: 0, good: deliveryA.good },
        { city: deliveryA.destCity, action: 'deliver', deliveryIndex: 0, cardIndex: deliveryA.cardIndex, demandIndex: deliveryA.demandIndex },
        { city: deliveryB.sourceCity, action: 'pickup', deliveryIndex: 1, good: deliveryB.good },
        { city: deliveryB.destCity, action: 'deliver', deliveryIndex: 1, cardIndex: deliveryB.cardIndex, demandIndex: deliveryB.demandIndex },
        { city: deliveryC.sourceCity, action: 'pickup', deliveryIndex: 2, good: deliveryC.good },
        { city: deliveryC.destCity, action: 'deliver', deliveryIndex: 2, cardIndex: deliveryC.cardIndex, demandIndex: deliveryC.demandIndex },
    ];

    const visitSequence = sequenceIndices.map(i => stops[i]);

    // Invariant: last stop must be a delivery
    if (visitSequence[visitSequence.length - 1].action !== 'deliver') {
        return null;
    }

    // Capacity check
    const trainCapacity = TRAIN_TYPES[player.trainType].capacity;
    if (!sequenceRespectsCapacity(visitSequence, trainCapacity)) {
        return null;
    }

    // Compute segments with virtual edge accumulation.
    // Track planned edges (not just mileposts) so later segments only get
    // free passage on edges that were actually planned by earlier segments.
    const virtualEdges = new Set();
    for (const t of ctx.tracks) {
        if (t.color === player.color) {
            virtualEdges.add(t.from + '|' + t.to);
            virtualEdges.add(t.to + '|' + t.from);
        }
    }

    const segments = [];
    const segmentPaths = [];
    let totalBuildCost = 0;
    let prevId = majorId || null;
    let prevCity = majorCity || '(network)';

    for (let i = 0; i < visitSequence.length; i++) {
        const stop = visitSequence[i];
        const stopId = ctx.cityToMilepost[stop.city];
        if (!stopId) return null;

        let segPath;
        if (prevId) {
            segPath = hard.findCheapestBuildPath(ctx, prevId, stopId, player.color, null, virtualEdges);
        } else {
            segPath = hard.findCheapestBuildPathFromNetwork(ctx, player, stopId);
            if (segPath) {
                let adjustedCost = 0;
                for (let j = 0; j < segPath.path.length - 1; j++) {
                    const edgeKey = segPath.path[j] + '|' + segPath.path[j + 1];
                    if (virtualEdges.has(edgeKey)) continue;
                    const m1 = ctx.mileposts_by_id[segPath.path[j]];
                    const m2 = ctx.mileposts_by_id[segPath.path[j + 1]];
                    if (m1 && m2) adjustedCost += getMileppostCost(m1, m2);
                }
                segPath = { path: segPath.path, cost: adjustedCost };
            }
        }
        if (!segPath) return null;

        const segCost = segPath.cost;
        segments.push({
            from: prevCity,
            to: stop.city,
            buildCost: segCost,
            cumCashAfter: null
        });
        segmentPaths.push(segPath.path);

        // Add planned edges to virtual set
        for (let j = 0; j < segPath.path.length - 1; j++) {
            virtualEdges.add(segPath.path[j] + '|' + segPath.path[j + 1]);
            virtualEdges.add(segPath.path[j + 1] + '|' + segPath.path[j]);
        }
        totalBuildCost += segCost;

        prevId = stopId;
        prevCity = stop.city;
    }

    // Build the full path
    let buildPath = [];
    for (const sp of segmentPaths) {
        buildPath = hard.combinePaths(buildPath, sp);
    }

    // Recompute segment and total build costs edge-by-edge against real owned edges
    const ownedEdges = new Set();
    for (const t of ctx.tracks) {
        if (t.color === player.color) {
            ownedEdges.add(t.from + '|' + t.to);
            ownedEdges.add(t.to + '|' + t.from);
        }
    }
    const builtEdges = new Set();
    let totalBuildCostActual = 0;
    for (let i = 0; i < segmentPaths.length; i++) {
        const sp = segmentPaths[i];
        let segCostActual = 0;
        for (let j = 0; j < sp.length - 1; j++) {
            const edgeKey = sp[j] + '|' + sp[j + 1];
            if (ownedEdges.has(edgeKey) || builtEdges.has(edgeKey)) continue;

            const ferryKey = getFerryKey(sp[j], sp[j + 1]);
            let isFerry = false;
            for (const fc of ctx.ferryConnections) {
                if (getFerryKey(fc.fromId, fc.toId) === ferryKey) {
                    isFerry = true;
                    if (!gl.playerOwnsFerry(ctx, ferryKey, player.color)) {
                        let ferryCost = fc.cost;
                        const destMp = ctx.mileposts_by_id[sp[j + 1]];
                        if (destMp && destMp.city) {
                            ferryCost += MAJOR_CITIES.includes(destMp.city.name) ? 5 : 3;
                        }
                        segCostActual += ferryCost;
                    }
                    break;
                }
            }
            if (!isFerry) {
                const mp1 = ctx.mileposts_by_id[sp[j]];
                const mp2 = ctx.mileposts_by_id[sp[j + 1]];
                if (mp1 && mp2) segCostActual += getMileppostCost(mp1, mp2);
            }
            builtEdges.add(edgeKey);
            builtEdges.add(sp[j + 1] + '|' + sp[j]);
        }
        segments[i].buildCost = segCostActual;
        totalBuildCostActual += segCostActual;
    }
    totalBuildCost = totalBuildCostActual;

    // Compute trip distance
    let tripDistance = 0;
    for (const sp of segmentPaths) {
        tripDistance += hard.getPathDistance(sp);
    }
    if (player.trainLocation && !majorId) {
        const firstStopId = ctx.cityToMilepost[visitSequence[0].city];
        if (firstStopId) {
            const trainPath = findPathOnTrack(ctx, player.trainLocation, firstStopId, player.color, false);
            if (trainPath) tripDistance += hard.getPathDistance(trainPath.path);
        }
    }

    return {
        majorCity: majorCity || null,
        deliveries: [
            { cardIndex: deliveryA.cardIndex, demandIndex: deliveryA.demandIndex, sourceCity: deliveryA.sourceCity, destCity: deliveryA.destCity, good: deliveryA.good, payout: deliveryA.payout },
            { cardIndex: deliveryB.cardIndex, demandIndex: deliveryB.demandIndex, sourceCity: deliveryB.sourceCity, destCity: deliveryB.destCity, good: deliveryB.good, payout: deliveryB.payout },
            { cardIndex: deliveryC.cardIndex, demandIndex: deliveryC.demandIndex, sourceCity: deliveryC.sourceCity, destCity: deliveryC.destCity, good: deliveryC.good, payout: deliveryC.payout },
        ],
        visitSequence,
        segments,
        totalBuildCost,
        totalPayout: deliveryA.payout + deliveryB.payout + deliveryC.payout,
        totalBuildTurns: 0,
        operateTurns: 0,
        estimatedTurns: 0,
        ecuPerTurn: 0,
        buildPath,
        tripDistance,
        currentStopIndex: 0
    };
}

// ---------------------------------------------------------------------------
// §1.2 — enumeratePlans (override)
// ---------------------------------------------------------------------------

// Budget cap for triple batch evaluations to keep computation time bounded.
// Keep this low — enumeratePlans runs synchronously and blocks the event loop.
// selectPlan can be called multiple times per turn (planOperate, shouldUpgrade
// gate 3, handleNoPlan borrowing), so the total cost multiplies.
// enumeratePlans blocks the event loop synchronously. Socket.IO ping timeout
// is 20s — we must stay well under that. selectPlan can be called 2-3 times in
// a single synchronous block (planOperate + handleNoPlan borrowing), so budget
// per call × 3 must be < 20s. At ~17ms per triple, 3s ≈ ~175 triples.
const TRIPLE_BATCH_BUDGET = 200;
const TRIPLE_BATCH_TIME_LIMIT_MS = 3000;

// Enumerate all single, 2-delivery batch, and 3-delivery batch candidate plans.
function enumeratePlans(gs, playerIndex, ctx, options) {
    const player = gs.players[playerIndex];
    const effectiveCash = (options && options.effectiveCash) || player.cash;
    const isInitialBuilding = !gs.tracks.some(t => t.color === player.color);

    const candidates = [];

    // --- Singles ---
    const singles = [];
    const excludeCards = (options && options.excludeCardIndices) || null;

    for (let ci = 0; ci < player.demandCards.length; ci++) {
        if (excludeCards && excludeCards.has(ci)) continue;
        const card = player.demandCards[ci];
        if (!card || !card.demands) continue;

        for (let di = 0; di < card.demands.length; di++) {
            const demand = card.demands[di];
            const destCity = demand.to;
            const destId = ctx.cityToMilepost[destCity];
            if (destId === undefined) continue;

            const sources = GOODS[demand.good] ? GOODS[demand.good].sources : [];

            for (const sourceCity of sources) {
                const srcId = ctx.cityToMilepost[sourceCity];
                if (srcId === undefined) continue;

                if (isInitialBuilding) {
                    for (const majorCity of MAJOR_CITIES) {
                        const majorId = ctx.cityToMilepost[majorCity];
                        if (majorId === undefined) continue;

                        const plan = hard.buildSinglePlan(
                            ctx, player, ci, di, demand, sourceCity, srcId,
                            destCity, destId, majorId, majorCity, effectiveCash
                        );
                        if (plan) {
                            candidates.push(plan);
                            singles.push(plan);
                        }
                    }
                } else {
                    const plan = hard.buildSinglePlan(
                        ctx, player, ci, di, demand, sourceCity, srcId,
                        destCity, destId, null, null, effectiveCash
                    );
                    if (plan) {
                        candidates.push(plan);
                        singles.push(plan);
                    }
                }
            }
        }
    }

    // --- 2-delivery batches (identical to hard AI) ---
    const bestSingles = new Map();
    for (const s of singles) {
        const d = s.deliveries[0];
        const key = `${d.cardIndex}:${d.demandIndex}:${d.sourceCity}`;
        const existing = bestSingles.get(key);
        if (!existing || s.totalBuildCost < existing.totalBuildCost) {
            bestSingles.set(key, s);
        }
    }
    const uniqueSingles = [...bestSingles.values()];

    // Track viable pairs and their best sequences for triple extension
    const viablePairs = []; // { deliveryA, deliveryB, bestSeq, majorCity, majorId, bestScore }

    for (let i = 0; i < uniqueSingles.length; i++) {
        for (let j = i + 1; j < uniqueSingles.length; j++) {
            const sA = uniqueSingles[i];
            const sB = uniqueSingles[j];

            const dA = sA.deliveries[0];
            const dB = sB.deliveries[0];
            if (dA.cardIndex === dB.cardIndex && dA.demandIndex === dB.demandIndex) continue;

            if (!hard.passesBatchPruning(sA, sB, ctx)) continue;

            const majorCity = sA.majorCity || sB.majorCity || null;
            const majorId = majorCity ? ctx.cityToMilepost[majorCity] : null;

            let bestBatchPlan = null;
            let bestBatchSeq = null;

            for (const seq of hard.BATCH_VISIT_SEQUENCES) {
                const batchPlan = hard.buildBatchPlan(
                    ctx, player, dA, dB, seq,
                    majorId || null, majorCity, effectiveCash
                );
                if (batchPlan) {
                    candidates.push(batchPlan);
                    if (!bestBatchPlan || batchPlan.totalBuildCost < bestBatchPlan.totalBuildCost) {
                        bestBatchPlan = batchPlan;
                        bestBatchSeq = seq;
                    }
                }
            }

            // Record viable pair for triple extension
            if (bestBatchPlan && bestBatchSeq) {
                viablePairs.push({
                    deliveryA: dA,
                    deliveryB: dB,
                    bestSeq: bestBatchSeq,
                    majorCity,
                    majorId: majorId || null
                });
            }
        }
    }

    // --- 3-delivery batches (Brutal AI exclusive) ---
    const trainCapacity = TRAIN_TYPES[player.trainType].capacity;
    let tripleCount = 0;
    const tripleStartTime = Date.now();

    for (const pair of viablePairs) {
        if (tripleCount >= TRIPLE_BATCH_BUDGET) break;
        if (Date.now() - tripleStartTime > TRIPLE_BATCH_TIME_LIMIT_MS) break;

        for (const sC of uniqueSingles) {
            if (tripleCount >= TRIPLE_BATCH_BUDGET) break;
            if (Date.now() - tripleStartTime > TRIPLE_BATCH_TIME_LIMIT_MS) break;

            const dC = sC.deliveries[0];

            // Skip if dC duplicates either delivery in the pair
            if (dC.cardIndex === pair.deliveryA.cardIndex && dC.demandIndex === pair.deliveryA.demandIndex) continue;
            if (dC.cardIndex === pair.deliveryB.cardIndex && dC.demandIndex === pair.deliveryB.demandIndex) continue;

            // Proximity pruning: dC must be near the pair's route
            // Use passesBatchPruning against both singles in the pair
            const singleA = bestSingles.get(`${pair.deliveryA.cardIndex}:${pair.deliveryA.demandIndex}:${pair.deliveryA.sourceCity}`);
            const singleB = bestSingles.get(`${pair.deliveryB.cardIndex}:${pair.deliveryB.demandIndex}:${pair.deliveryB.sourceCity}`);
            if (!singleA || !singleB) continue;
            if (!hard.passesBatchPruning(singleA, sC, ctx) && !hard.passesBatchPruning(singleB, sC, ctx)) continue;

            // Generate insertion sequences from the best pair sequence
            const insertions = generateTripleInsertions(pair.bestSeq, trainCapacity);

            for (const tripleSeq of insertions) {
                if (tripleCount >= TRIPLE_BATCH_BUDGET) break;

                const triplePlan = buildTripleBatchPlan(
                    ctx, player, pair.deliveryA, pair.deliveryB, dC, tripleSeq,
                    pair.majorId, pair.majorCity, effectiveCash
                );
                if (triplePlan) {
                    candidates.push(triplePlan);
                }
                tripleCount++;
            }
        }
    }

    // Annotate for logging (non-enumerable so it doesn't affect iteration)
    candidates._tripleTimeMs = Date.now() - tripleStartTime;
    candidates._tripleCount = tripleCount;

    return candidates;
}

// ---------------------------------------------------------------------------
// §1.5 — selectPlan (override)
// ---------------------------------------------------------------------------

// Must override selectPlan to call our enumeratePlans and scorePlan (lexical binding).
function selectPlan(gs, playerIndex, ctx, options) {
    const player = gs.players[playerIndex];
    const candidates = enumeratePlans(gs, playerIndex, ctx, options);

    // Precompute city proximity map once for all plan evaluations
    const enrichedOptions = Object.assign({}, options || {}, {
        cityProximityMap: buildCityProximityMap(ctx, player)
    });

    let bestPlan = null;
    let bestScore = -Infinity;

    for (const plan of candidates) {
        if (!hard.checkAffordability(plan, player, ctx, options)) continue;

        // Initial building reachability filter
        if (plan.majorCity && plan.segments.length > 0) {
            const costToPickup1 = plan.segments[0].buildCost;
            if (costToPickup1 > 40) continue;
        }

        const score = scorePlan(plan, player, gs, ctx, enrichedOptions);
        if (score > bestScore) {
            bestScore = score;
            bestPlan = plan;
        }
    }

    // Logging
    const affordable = candidates.filter(p => hard.checkAffordability(p, player, ctx, options));
    const singles = candidates.filter(p => p.deliveries.length === 1);
    const batches = candidates.filter(p => p.deliveries.length === 2);
    const triples = candidates.filter(p => p.deliveries.length === 3);
    const tripleTime = candidates._tripleTimeMs || 0;
    const tripleBudgetUsed = candidates._tripleCount || 0;
    hard.logDecision(playerIndex, 'target selection',
        `Candidates: ${singles.length} singles, ${batches.length} batches, ${triples.length} triples (${tripleBudgetUsed} evaluated, ${tripleTime}ms). ` +
        `Affordable: ${affordable.length}. Cash: ${(options && options.effectiveCash) || player.cash}M. ` +
        `Selected: ${hard.formatPlanSummary(bestPlan)}`
    );

    return bestPlan;
}

// ---------------------------------------------------------------------------
// §4.4 — shouldUpgrade (override: two-stage upgrade path)
// ---------------------------------------------------------------------------

// Brutal AI upgrades in two stages:
//   Stage 1: Freight → Fast Freight (same gates as Hard AI)
//   Stage 2: Fast Freight → Superfreight (capacity 3, enables more triple sequences)
function shouldUpgrade(gs, playerIndex, ctx) {
    const player = gs.players[playerIndex];

    // Must not have already built this turn (upgrade consumes full build phase)
    if (gs.buildingThisTurn > 0) return false;

    const plan = hard.getCommittedPlan(gs, playerIndex);
    if (!plan) return false;

    // Determine target upgrade
    let targetTrain;
    if (player.trainType === 'Freight') {
        targetTrain = 'Fast Freight';
    } else if (player.trainType === 'Fast Freight') {
        targetTrain = 'Superfreight';
    } else {
        // Already at Superfreight or Heavy Freight — no upgrade
        return false;
    }

    const upgradeCost = 20;
    const remainingBuildCost = hard.computeRemainingBuildCost(gs, playerIndex, ctx, plan);

    // Gate 1: Can the AI afford the entire remaining route?
    if (remainingBuildCost > player.cash) return false;

    // Gate 2: Is there enough surplus for the upgrade?
    const surplus = player.cash - remainingBuildCost;
    if (surplus < upgradeCost) return false;

    // Gate 3: Viable next plan post-upgrade
    // Only count payout from deliveries where the good is already picked up
    // (i.e. pickup stop already visited). Unvisited deliveries may never
    // happen if the upgrade leaves the AI with 0 cash.
    let pendingPayout = 0;
    const excludeCards = new Set();
    for (let i = 0; i < plan.visitSequence.length; i++) {
        const stop = plan.visitSequence[i];
        if (stop.action === 'deliver') {
            // Check if the pickup for this delivery was already visited
            let pickedUp = false;
            for (let j = 0; j < plan.currentStopIndex; j++) {
                const prior = plan.visitSequence[j];
                if (prior.action === 'pickup' && prior.deliveryIndex === stop.deliveryIndex) {
                    pickedUp = true;
                    break;
                }
            }
            if (pickedUp) {
                pendingPayout += plan.deliveries[stop.deliveryIndex].payout;
            }
            excludeCards.add(stop.cardIndex);
        }
    }
    const cashAfterAll = surplus - upgradeCost + pendingPayout;
    const testPlan = selectPlan(gs, playerIndex, ctx, { effectiveCash: cashAfterAll, excludeCardIndices: excludeCards });
    if (!testPlan) {
        hard.logDecision(playerIndex, 'build',
            `Upgrade to ${targetTrain} skipped: Gate 3 — no affordable plan with ${cashAfterAll}M post-upgrade cash (pending payout: ${pendingPayout}M)`
        );
        return false;
    }

    // Gate 4: Endgame — would upgrading starve city connections?
    const aiState = hard.getAIState(player);
    if (aiState.endgameMode) {
        const cityInfo = hard.getUnconnectedMajorCityCosts(ctx, player, gs);
        if (cityInfo.citiesNeeded > 0) {
            if (cashAfterAll < cityInfo.totalCost) {
                hard.logDecision(playerIndex, 'build',
                    `Upgrade to ${targetTrain} skipped: Gate 4 (endgame) — post-upgrade cash ${cashAfterAll}M < ` +
                    `city connection cost ${cityInfo.totalCost}M (${cityInfo.citiesNeeded} cities needed)`
                );
                return false;
            }
        }
    }

    hard.logDecision(playerIndex, 'build',
        `Upgrade to ${targetTrain}: surplus=${surplus}M, remaining route=${remainingBuildCost}M, ` +
        `post-upgrade cash=${cashAfterAll}M, next plan viable: ${hard.formatPlanSummary(testPlan)}`
    );
    return targetTrain;
}

module.exports = {
    // Inherit everything from Hard AI
    ...hard,

    // Override: 3-delivery batches, scoring, 2-stage upgrades
    enumeratePlans,
    selectPlan,
    scorePlan,
    shouldUpgrade,

    // Exported for testing
    buildCityProximityMap,
    computeNetworkValue,
    computeNetworkEfficiency,
};
