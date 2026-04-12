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

const NETWORK_VALUE_WEIGHT = 0.25;       // Up to 25% bonus for building through city-rich areas
const NETWORK_EFFICIENCY_WEIGHT = 0.50;  // Up to 50% bonus for using existing track
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

    // Disconnection penalty: if the plan's buildPath doesn't touch any
    // existing track, the AI is building an isolated network. Penalize
    // heavily in early/mid game when capital is scarce and network
    // consolidation matters most.
    let disconnectionMultiplier = 1.0;
    if (plan.buildPath && plan.buildPath.length >= 2 && plan.totalBuildCost > 0) {
        const ownedTrackCount = ctx.tracks.filter(t => t.color === player.color).length;
        if (ownedTrackCount >= 5) { // Skip during very first builds
            const ownedMileposts = new Set();
            for (const t of ctx.tracks) {
                if (t.color === player.color) {
                    ownedMileposts.add(t.from);
                    ownedMileposts.add(t.to);
                }
            }
            const touchesNetwork = plan.buildPath.some(mp => ownedMileposts.has(mp));
            if (!touchesNetwork) {
                // Harsh penalty that decays as network grows (less important late game)
                disconnectionMultiplier = ownedTrackCount < 40 ? 0.4 : 0.7;
            }
        }
    }

    const adjustedScore = baseScore * bonus * disconnectionMultiplier;
    plan.ecuPerTurn = adjustedScore;
    return adjustedScore;
}

// ---------------------------------------------------------------------------
// §1.2.0 — Triple proximity pruning (relaxed vs batch pruning)
// ---------------------------------------------------------------------------

// Relaxed proximity check for extending a 2-batch into a triple.
// Passes if either the source or destination of singleC is already on the
// player's network (free to reach), OR if singleC is within 8 hexes of
// singleA's route (vs 5 hexes for standard batch pruning).
// Region-based triple pruning: the 3rd delivery passes if it shares a city
// with delivery A, or if its source and destination regions are compatible
// with delivery A's regions. Uses the same CITY_REGIONS / regionsCompatible
// from ai-hard.js. Replaces the old 8-hex geometric check + network
// connectivity shortcut.
function passesTriplePruning(singleA, singleC) {
    const dA = singleA.deliveries[0];
    const dC = singleC.deliveries[0];

    // Shared city check
    const citiesA = [dA.sourceCity, dA.destCity];
    const citiesC = [dC.sourceCity, dC.destCity];
    for (const c of citiesA) {
        if (citiesC.includes(c)) return true;
    }

    // Region compatibility
    const srcRegionA = hard.CITY_REGIONS[dA.sourceCity];
    const srcRegionC = hard.CITY_REGIONS[dC.sourceCity];
    const dstRegionA = hard.CITY_REGIONS[dA.destCity];
    const dstRegionC = hard.CITY_REGIONS[dC.destCity];

    if (srcRegionA && srcRegionC && dstRegionA && dstRegionC) {
        return hard.regionsCompatible(srcRegionA, srcRegionC) &&
               hard.regionsCompatible(dstRegionA, dstRegionC);
    }

    return false;
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
    // For subsequent plans, add distance from train to first stop.
    // segmentPaths[0] already covers the build path from an owned-city entry
    // point to the first stop; we need to add the train's owned-track
    // distance from its current location to that entry point.
    // Prior to this fix, when the direct owned-track path to the first stop
    // didn't exist, positioning distance was silently dropped, causing
    // systematic 2x turn underestimates on long-haul plans.
    let transitFerryCrossings = 0;
    if (player.trainLocation && !majorId) {
        const firstStopId = ctx.cityToMilepost[visitSequence[0].city];
        if (firstStopId) {
            const trainPath = findPathOnTrack(ctx, player.trainLocation, firstStopId, player.color, false);
            if (trainPath) {
                // First stop already on owned network; segmentPaths[0] is
                // trivial in this case. Add the owned-track distance.
                tripDistance += hard.getPathDistance(trainPath.path);
                transitFerryCrossings = trainPath.ferryCrossings.length;
            } else if (segmentPaths.length > 0 && segmentPaths[0].length > 0) {
                // First stop not reachable via owned track yet. Add only the
                // train→segStart portion; segmentPaths[0] (segStart→firstStop)
                // is already summed above.
                const segStartId = segmentPaths[0][0];
                const trainToSegStart = findPathOnTrack(ctx, player.trainLocation, segStartId, player.color, false);
                if (trainToSegStart) {
                    tripDistance += hard.getPathDistance(trainToSegStart.path);
                    transitFerryCrossings = trainToSegStart.ferryCrossings.length;
                }
            }
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
        ferryCrossingCount: hard.countFerryCrossings(buildPath, ctx) + transitFerryCrossings,
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
// Socket.IO pingTimeout is 30s. With batch budget (3s) + triple budget (3s)
// per call × 3 calls = ~18s worst case, staying under the limit.
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

    // Sort by payout descending so the O(n²) pairing loop evaluates
    // high-value combinations first. If the time budget cuts the tail,
    // we only lose low-payout × low-payout pairs.
    uniqueSingles.sort((a, b) => b.totalPayout - a.totalPayout);

    // Time budget for batch evaluation (matches ai-hard.js).
    const BATCH_TIME_LIMIT_MS = 3000;
    const batchStartTime = Date.now();

    // Track viable pairs and their best sequences for triple extension
    const viablePairs = []; // { deliveryA, deliveryB, bestSeq, majorCity, majorId, bestBatchScore }

    for (let i = 0; i < uniqueSingles.length; i++) {
        if (Date.now() - batchStartTime > BATCH_TIME_LIMIT_MS) break;
        for (let j = i + 1; j < uniqueSingles.length; j++) {
            if (Date.now() - batchStartTime > BATCH_TIME_LIMIT_MS) break;
            const sA = uniqueSingles[i];
            const sB = uniqueSingles[j];

            const dA = sA.deliveries[0];
            const dB = sB.deliveries[0];
            if (dA.cardIndex === dB.cardIndex) continue;

            if (!hard.passesBatchPruning(sA, sB, ctx)) continue;

            const majorCity = sA.majorCity || sB.majorCity || null;
            const majorId = majorCity ? ctx.cityToMilepost[majorCity] : null;

            let bestBatchPlan = null;
            let bestBatchSeq = null;
            let bestBatchScore = -Infinity;

            for (const seq of hard.BATCH_VISIT_SEQUENCES) {
                const batchPlan = hard.buildBatchPlan(
                    ctx, player, dA, dB, seq,
                    majorId || null, majorCity, effectiveCash
                );
                if (batchPlan) {
                    const score = hard.scorePlan(batchPlan, player, gs, ctx, options);
                    candidates.push(batchPlan);
                    if (score > bestBatchScore) {
                        bestBatchPlan = batchPlan;
                        bestBatchSeq = seq;
                        bestBatchScore = score;
                    }
                }
            }

            // Record viable pair for triple extension
            if (bestBatchPlan && bestBatchSeq) {
                viablePairs.push({
                    deliveryA: dA,
                    deliveryB: dB,
                    bestSeq: bestBatchSeq,
                    bestBuildCost: bestBatchPlan.totalBuildCost,
                    bestBatchScore,
                    majorCity,
                    majorId: majorId || null
                });
            }
        }
    }

    // Sort viable pairs by actual batch ECU/turn score so the triple budget
    // is spent on the most promising pairs first. This ensures high-scoring
    // directionally-aligned pairs get triple extension priority.
    viablePairs.sort((a, b) => b.bestBatchScore - a.bestBatchScore);

    // --- 3-delivery batches (Brutal AI exclusive) ---
    const trainCapacity = TRAIN_TYPES[player.trainType].capacity;
    let tripleCount = 0;
    const tripleStartTime = Date.now();

    // Tier singles by network connectivity: candidates already on the network
    // are cheaper to add as a 3rd delivery and more likely to produce valid plans.
    const ownedMps = getPlayerOwnedMileposts(ctx, player.color);
    const tier1 = [], tier2 = [], tier3 = [];
    for (const s of uniqueSingles) {
        const d = s.deliveries[0];
        const srcOn = ownedMps.has(ctx.cityToMilepost[d.sourceCity]);
        const dstOn = ownedMps.has(ctx.cityToMilepost[d.destCity]);
        if (srcOn && dstOn) tier1.push(s);
        else if (srcOn || dstOn) tier2.push(s);
        else tier3.push(s);
    }
    const tieredSingles = [...tier1, ...tier2, ...tier3];

    for (const pair of viablePairs) {
        if (tripleCount >= TRIPLE_BATCH_BUDGET) break;
        if (Date.now() - tripleStartTime > TRIPLE_BATCH_TIME_LIMIT_MS) break;

        for (const sC of tieredSingles) {
            if (tripleCount >= TRIPLE_BATCH_BUDGET) break;
            if (Date.now() - tripleStartTime > TRIPLE_BATCH_TIME_LIMIT_MS) break;

            const dC = sC.deliveries[0];

            // Skip if dC shares a card with either delivery in the pair.
            // Each demand card has 3 demands, but delivering any one of them
            // splices the entire card out (see ai-actions.js applyDeliverGood),
            // so a plan can never legally fulfill two demands from the same card.
            if (dC.cardIndex === pair.deliveryA.cardIndex) continue;
            if (dC.cardIndex === pair.deliveryB.cardIndex) continue;

            // Proximity pruning: dC must be near the pair's route or on the network.
            // Uses relaxed threshold (8 hexes) and network connectivity shortcut.
            const singleA = bestSingles.get(`${pair.deliveryA.cardIndex}:${pair.deliveryA.demandIndex}:${pair.deliveryA.sourceCity}`);
            const singleB = bestSingles.get(`${pair.deliveryB.cardIndex}:${pair.deliveryB.demandIndex}:${pair.deliveryB.sourceCity}`);
            if (!singleA || !singleB) continue;
            if (!passesTriplePruning(singleA, sC) && !passesTriplePruning(singleB, sC)) continue;

            // Generate insertion sequences from the best pair sequence
            const insertions = generateTripleInsertions(pair.bestSeq, trainCapacity);

            let consecutiveNulls = 0;
            for (const tripleSeq of insertions) {
                if (tripleCount >= TRIPLE_BATCH_BUDGET) break;

                const triplePlan = buildTripleBatchPlan(
                    ctx, player, pair.deliveryA, pair.deliveryB, dC, tripleSeq,
                    pair.majorId, pair.majorCity, effectiveCash
                );
                if (triplePlan) {
                    candidates.push(triplePlan);
                    consecutiveNulls = 0;
                } else {
                    consecutiveNulls++;
                    if (consecutiveNulls >= 3) break;
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
    let affordableCount = 0;
    const scoredPlans = [];

    // Minimum payout floor: in late game with a mature network, reject
    // low-payout singles that waste a full turn cycle for trivial income.
    const ownedTrackCount = gs.tracks.filter(t => t.color === player.color).length;
    const minPayoutFloor = ownedTrackCount >= 80 ? 15 : 0;

    for (const plan of candidates) {
        if (!hard.checkAffordability(plan, player, ctx, options)) continue;
        affordableCount++;

        // Late-game payout floor: skip low-value singles
        if (minPayoutFloor > 0 && plan.deliveries.length === 1 &&
            plan.totalPayout < minPayoutFloor) continue;

        // Initial building reachability filter
        if (plan.majorCity && plan.segments.length > 0) {
            const costToPickup1 = plan.segments[0].buildCost;
            if (costToPickup1 > 40) continue;
        }

        const score = scorePlan(plan, player, gs, ctx, enrichedOptions);
        scoredPlans.push({ plan, score });
        if (score > bestScore) {
            bestScore = score;
            bestPlan = plan;
        }
    }

    // Cash floor gate (shared with hard AI)
    if (bestPlan && gs.phase !== 'initialBuilding' &&
        !(options && options.effectiveCash) && bestPlan.ecuPerTurn < 900) {
        bestPlan = hard.applyCashFloorGate(bestPlan, player, candidates, playerIndex);
    }

    // Logging — count by type without re-checking affordability
    let singleCount = 0, batchCount = 0, tripleCount = 0;
    for (const p of candidates) {
        if (p.deliveries.length === 1) singleCount++;
        else if (p.deliveries.length === 2) batchCount++;
        else if (p.deliveries.length === 3) tripleCount++;
    }
    const tripleTime = candidates._tripleTimeMs || 0;
    const tripleBudgetUsed = candidates._tripleCount || 0;
    hard.logDecision(playerIndex, 'target selection',
        `Candidates: ${singleCount} singles, ${batchCount} batches, ${tripleCount} triples (${tripleBudgetUsed} evaluated, ${tripleTime}ms). ` +
        `Affordable: ${affordableCount}. Cash: ${(options && options.effectiveCash) || player.cash}M. ` +
        `Selected: ${hard.formatPlanSummary(bestPlan)}`
    );

    // Log runner-up plans for debugging route selection decisions
    if (scoredPlans.length > 1) {
        scoredPlans.sort((a, b) => b.score - a.score);
        const runnerUps = scoredPlans.slice(1, 4).map((sp, i) =>
            `  #${i + 2}: ${hard.formatPlanSummary(sp.plan)}`
        );
        hard.logDecision(playerIndex, 'target selection', `Runner-ups:\n${runnerUps.join('\n')}`);
    }

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

    // Gate 0: Network maturity. An upgrade only pays off when the AI has
    // enough owned track to exploit the speed/capacity gains. Upgrading
    // on a tiny network buys speed the AI can't use and drains cash that
    // was needed for the next plan, triggering discard spirals.
    //
    // Thresholds match the "early"/"mid"/"late" tiers used elsewhere in
    // scoring (ai-hard.js buildCostWeight, earlyGameMultiplier).
    const ownedTrackCount = gs.tracks.filter(t => t.color === player.color).length;
    const maturityThreshold = targetTrain === 'Fast Freight' ? 30 : 60;
    if (ownedTrackCount < maturityThreshold) {
        hard.logDecision(playerIndex, 'build',
            `Upgrade to ${targetTrain} skipped: Gate 0 — ownedTrackCount=${ownedTrackCount} < ${maturityThreshold} (network too small)`
        );
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
    // Credit pending delivery payouts to project post-upgrade cash.
    // If the route is fully funded post-upgrade, ALL deliveries will complete,
    // so credit the full remaining plan payout. Otherwise, conservatively
    // count only goods already picked up.
    let pendingPayout = 0;
    const excludeCards = new Set();
    const routeAffordablePostUpgrade = remainingBuildCost <= surplus - upgradeCost;
    if (routeAffordablePostUpgrade) {
        const deliveredIndices = new Set();
        for (let j = 0; j < plan.currentStopIndex; j++) {
            const prior = plan.visitSequence[j];
            if (prior.action === 'deliver') deliveredIndices.add(prior.deliveryIndex);
        }
        for (let di = 0; di < plan.deliveries.length; di++) {
            if (!deliveredIndices.has(di)) {
                pendingPayout += plan.deliveries[di].payout;
            }
        }
    } else {
        for (let i = 0; i < plan.visitSequence.length; i++) {
            const stop = plan.visitSequence[i];
            if (stop.action === 'deliver') {
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
            }
        }
    }
    for (let i = 0; i < plan.visitSequence.length; i++) {
        const stop = plan.visitSequence[i];
        if (stop.action === 'deliver') excludeCards.add(stop.cardIndex);
    }
    const cashAfterAll = surplus - upgradeCost + pendingPayout;
    const testPlan = selectPlan(gs, playerIndex, ctx, { effectiveCash: cashAfterAll, excludeCardIndices: excludeCards });
    if (!testPlan) {
        hard.logDecision(playerIndex, 'build',
            `Upgrade to ${targetTrain} skipped: Gate 3 — no affordable plan with ${cashAfterAll}M post-upgrade cash (pending payout: ${pendingPayout}M)`
        );
        return false;
    }

    // Gate 3b: Sustainability — after completing the next plan, will the AI
    // still have enough cash to avoid a discard spiral?
    const cashAfterNextPlan = cashAfterAll - testPlan.totalBuildCost + testPlan.totalPayout;
    if (cashAfterNextPlan < 15) {
        hard.logDecision(playerIndex, 'build',
            `Upgrade to ${targetTrain} skipped: Gate 3b — post-next-plan cash ${cashAfterNextPlan}M < 15M sustainability floor ` +
            `(next plan: ${hard.formatPlanSummary(testPlan)})`
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
        `post-upgrade cash=${cashAfterAll}M, next plan viable: ${hard.formatPlanSummary(testPlan)}, ` +
        `post-next-plan cash=${cashAfterNextPlan}M`
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
