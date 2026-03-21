// server/ai-hard.js
// Hard AI decision-making strategy module (7.5/10 difficulty).
// All functions are pure — they read game state and pathfinding context,
// returning action descriptors or data. No side effects, no sockets.
//
// Structured as named strategy functions that Brutal AI can override (§11.1).
// Turn orchestration (planTurn, planOperate, planBuild) is shared across
// difficulties and NOT overridden.

const gl = require('../shared/game-logic');
const GOODS = gl.GOODS;
const MAJOR_CITIES = gl.MAJOR_CITIES;
const findPath = gl.findPath;
const findPathOnTrack = gl.findPathOnTrack;
const getPlayerOwnedMileposts = gl.getPlayerOwnedMileposts;
const getTrainMovement = gl.getTrainMovement;
const getMileppostCost = gl.getMileppostCost;
const getFerryKey = gl.getFerryKey;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Recompute the true build cost of a plan by walking its buildPath edge-by-edge
// against actual owned edges. This corrects Dijkstra estimation errors caused by
// virtualTrack imprecision (city entry direction, non-edge milepost adjacency).
function recomputeBuildCost(ctx, player, buildPath) {
    if (!buildPath || buildPath.length < 2) return 0;

    const ownedEdges = new Set();
    for (const t of ctx.tracks) {
        if (t.color === player.color) {
            ownedEdges.add(t.from + '|' + t.to);
            ownedEdges.add(t.to + '|' + t.from);
        }
    }

    let cost = 0;
    for (let i = 0; i < buildPath.length - 1; i++) {
        const fromId = buildPath[i];
        const toId = buildPath[i + 1];
        if (ownedEdges.has(fromId + '|' + toId)) continue;

        // Check ferry
        const ferryKey = getFerryKey(fromId, toId);
        let isFerry = false;
        for (const fc of ctx.ferryConnections) {
            if (getFerryKey(fc.fromId, fc.toId) === ferryKey) {
                isFerry = true;
                if (!gl.playerOwnsFerry(ctx, ferryKey, player.color)) {
                    cost += fc.cost;
                    const destMp = ctx.mileposts_by_id[toId];
                    if (destMp && destMp.city) {
                        cost += MAJOR_CITIES.includes(destMp.city.name) ? 5 : 3;
                    }
                }
                break;
            }
        }
        if (isFerry) continue;

        const mp1 = ctx.mileposts_by_id[fromId];
        const mp2 = ctx.mileposts_by_id[toId];
        if (mp1 && mp2) cost += getMileppostCost(mp1, mp2);
    }
    return cost;
}

// Find the cheapest build path between two points, accounting for build
// direction. When the target is an unconnected major city, compute the path
// building OUT from the major city (1M exit) rather than INTO it (5M entry).
// The returned path is always in movement order (source → target).
function findCheapestBuildPath(ctx, idA, idB, playerColor, virtualTrack, virtualEdges) {
    // Try both directions and pick cheaper
    const fwd = findPath(ctx, idA, idB, playerColor, "cheapest", false, virtualTrack, virtualEdges);
    const rev = findPath(ctx, idB, idA, playerColor, "cheapest", false, virtualTrack, virtualEdges);

    let best = null;
    if (fwd && rev) {
        best = rev.cost < fwd.cost
            ? { path: [...rev.path].reverse(), cost: rev.cost }
            : fwd;
    } else {
        best = fwd || (rev ? { path: [...rev.path].reverse(), cost: rev.cost } : null);
    }
    if (!best) return null;

    return best;
}

// Get the milepost count along a path (track-based distance).
function getPathDistance(path) {
    return path.length > 0 ? path.length - 1 : 0;
}

// Get the city name at a milepost.
function getCityNameAt(ctx, milepostId) {
    if (!milepostId) return null;
    const mp = ctx.mileposts_by_id[milepostId];
    return mp && mp.city ? mp.city.name : null;
}

// ---------------------------------------------------------------------------
// §6.2 — Event awareness helpers
// ---------------------------------------------------------------------------

// Check if a city is blocked by an active strike for loading/delivery.
// Strike 121: blocks cities > radius from coast
// Strike 122: blocks cities <= radius from coast
function isStrikeBlockingCity(gs, cityMilepostId) {
    if (!gs.activeEvents || !cityMilepostId) return false;
    for (const ae of gs.activeEvents) {
        const evt = ae.card;
        if (evt.id === 121 && gs.coastDistance) {
            const d = gs.coastDistance[cityMilepostId];
            if (d !== undefined && d > evt.radius) return true;
        }
        if (evt.id === 122 && gs.coastDistance) {
            const d = gs.coastDistance[cityMilepostId];
            if (d !== undefined && d <= evt.radius) return true;
        }
    }
    return false;
}

// Check if the AI player is affected by rail closure (strike 123).
// Strike 123 blocks movement on the drawing player's track and blocks their building.
function isRailClosureActive(gs, playerIndex) {
    if (!gs.activeEvents) return false;
    const player = gs.players[playerIndex];
    for (const ae of gs.activeEvents) {
        if (ae.card.id === 123) {
            const drawingPlayer = gs.players[ae.drawingPlayerIndex];
            if (drawingPlayer && drawingPlayer.color === player.color) return true;
        }
    }
    return false;
}

// Compute remaining build cost from a specific stop index forward (§1.3 mid-execution re-check).
// Only counts segments at or after startStopIndex. Uses player's current built track.
function computeRemainingBuildCostFromIndex(gs, playerIndex, ctx, plan, startStopIndex) {
    if (!plan || !plan.buildPath || plan.buildPath.length < 2) return 0;

    const player = gs.players[playerIndex];
    const ownedEdges = new Set();
    for (const t of gs.tracks) {
        if (t.color === player.color) {
            ownedEdges.add(t.from + '|' + t.to);
            ownedEdges.add(t.to + '|' + t.from);
        }
    }

    let cost = 0;
    // Walk segments from startStopIndex forward
    for (let i = startStopIndex; i < plan.segments.length; i++) {
        const seg = plan.segments[i];
        const fromCity = seg.from === '(network)' || seg.from === '(current)' ? null : seg.from;
        const toCity = seg.to;
        const fromId = fromCity ? ctx.cityToMilepost[fromCity] : null;
        const toId = toCity ? ctx.cityToMilepost[toCity] : null;
        if (!toId) continue;

        // Extract this segment's path and sum unbuilt edge costs
        const segPath = extractSegmentPath(plan.buildPath, fromId, toId, ctx);
        if (!segPath) continue;

        for (let j = 0; j < segPath.length - 1; j++) {
            const edgeKey = segPath[j] + '|' + segPath[j + 1];
            if (ownedEdges.has(edgeKey)) continue;

            const mp1 = ctx.mileposts_by_id[segPath[j]];
            const mp2 = ctx.mileposts_by_id[segPath[j + 1]];
            if (mp1 && mp2) cost += getMileppostCost(mp1, mp2);
        }
    }

    return cost;
}

// Check remaining affordability from currentStopIndex forward, using sequential
// cash checkpoints for batch plans. This is the mid-execution version of
// checkAffordability — it accounts for delivery payouts between remaining segments.
function checkRemainingAffordability(gs, playerIndex, ctx, plan) {
    const player = gs.players[playerIndex];
    let cash = player.cash;
    let accumulatedBuildCost = 0;

    for (let i = plan.currentStopIndex; i < plan.segments.length; i++) {
        // Compute actual remaining build cost for this segment from the buildPath
        const seg = plan.segments[i];
        const fromCity = seg.from === '(network)' || seg.from === '(current)' ? null : seg.from;
        const toCity = seg.to;
        const fromId = fromCity ? ctx.cityToMilepost[fromCity] : null;
        const toId = toCity ? ctx.cityToMilepost[toCity] : null;

        // Sum unbuilt edge costs for this segment
        let segCost = 0;
        if (toId && plan.buildPath) {
            const segPath = extractSegmentPath(plan.buildPath, fromId, toId, ctx);
            if (segPath) {
                const ownedEdges = new Set();
                for (const t of gs.tracks) {
                    if (t.color === player.color) {
                        ownedEdges.add(t.from + '|' + t.to);
                        ownedEdges.add(t.to + '|' + t.from);
                    }
                }
                for (let j = 0; j < segPath.length - 1; j++) {
                    if (ownedEdges.has(segPath[j] + '|' + segPath[j + 1])) continue;
                    const mp1 = ctx.mileposts_by_id[segPath[j]];
                    const mp2 = ctx.mileposts_by_id[segPath[j + 1]];
                    if (mp1 && mp2) segCost += getMileppostCost(mp1, mp2);
                }
            }
        }

        accumulatedBuildCost += segCost;

        const stop = plan.visitSequence[i];
        if (stop && stop.action === 'deliver') {
            // Cash checkpoint
            if (accumulatedBuildCost > cash) return false;
            const delivery = plan.deliveries[stop.deliveryIndex];
            cash = cash - accumulatedBuildCost + delivery.payout;
            accumulatedBuildCost = 0;
        }
    }

    // Any leftover cost after last segment (defensive — shouldn't happen)
    if (accumulatedBuildCost > cash) return false;

    return true;
}

// ---------------------------------------------------------------------------
// §7 — Decision logging
// ---------------------------------------------------------------------------

function logDecision(playerIndex, category, message) {
    console.log(`Hard AI ${playerIndex} ${category}: ${message}`);
}

function formatPlanSummary(plan) {
    if (!plan) return 'NONE';
    const deliveries = plan.deliveries.map(d =>
        `${d.good}:${d.sourceCity}→${d.destCity}($${d.payout})`
    ).join(' + ');
    return `[${plan.deliveries.length > 1 ? 'BATCH' : 'SINGLE'}] ${deliveries} ` +
        `buildCost=${plan.totalBuildCost} ECU/turn=${plan.ecuPerTurn?.toFixed(2) || '?'} ` +
        `turns=${plan.estimatedTurns?.toFixed(1) || '?'}`;
}

// Get or initialize the hard AI state on a player object.
function getAIState(player) {
    if (!player.aiState) player.aiState = {};
    const s = player.aiState;
    if (!s.hard) {
        s.hard = {
            committedPlan: null,
            stuckTurnCounter: 0,
            consecutiveDiscards: 0,
            consecutiveWeakDiscards: 0,
            endgameMode: false
        };
    }
    return s.hard;
}

// Get the committed plan from aiState.
function getCommittedPlan(gs, playerIndex) {
    const aiState = getAIState(gs.players[playerIndex]);
    return aiState.committedPlan || null;
}

// Persist a plan to aiState.
function commitPlan(gs, playerIndex, plan) {
    const aiState = getAIState(gs.players[playerIndex]);
    aiState.committedPlan = plan;
    aiState.consecutiveDiscards = 0;
    aiState.consecutiveWeakDiscards = 0;
}

// Clear the committed plan.
function clearCommittedPlan(gs, playerIndex) {
    const aiState = getAIState(gs.players[playerIndex]);
    aiState.committedPlan = null;
}

// ---------------------------------------------------------------------------
// §1.2 — enumeratePlans (singles + 2-delivery batches)
// ---------------------------------------------------------------------------

// Euclidean point-to-line-segment distance. Returns the perpendicular distance
// from point (px, py) to the nearest point on the line segment (ax, ay)→(bx, by).
function pointToSegmentDistance(px, py, ax, ay, bx, by) {
    const dx = bx - ax;
    const dy = by - ay;
    const lenSq = dx * dx + dy * dy;
    if (lenSq === 0) return Math.hypot(px - ax, py - ay); // Degenerate segment
    let t = ((px - ax) * dx + (py - ay) * dy) / lenSq;
    t = Math.max(0, Math.min(1, t));
    const projX = ax + t * dx;
    const projY = ay + t * dy;
    return Math.hypot(px - projX, py - projY);
}

// §1.2 Batch pruning: two singles pass if they share a city OR any city of
// one is within 5 hex units of the other's source→dest line segment.
function passesBatchPruning(singleA, singleB, ctx) {
    const dA = singleA.deliveries[0];
    const dB = singleB.deliveries[0];
    const citiesA = [dA.sourceCity, dA.destCity];
    const citiesB = [dB.sourceCity, dB.destCity];

    // Check shared city
    for (const c of citiesA) {
        if (citiesB.includes(c)) return true;
    }

    // Check proximity: any city of A within 5 hexes of B's route, or vice versa
    const THRESHOLD = 5;
    const getXY = (city) => {
        const mpId = ctx.cityToMilepost[city];
        const mp = mpId ? ctx.mileposts_by_id[mpId] : null;
        return mp ? { x: mp.x, y: mp.y } : null;
    };

    const srcB = getXY(dB.sourceCity);
    const dstB = getXY(dB.destCity);
    if (srcB && dstB) {
        for (const city of citiesA) {
            const p = getXY(city);
            if (p && pointToSegmentDistance(p.x, p.y, srcB.x, srcB.y, dstB.x, dstB.y) <= THRESHOLD) {
                return true;
            }
        }
    }

    const srcA = getXY(dA.sourceCity);
    const dstA = getXY(dA.destCity);
    if (srcA && dstA) {
        for (const city of citiesB) {
            const p = getXY(city);
            if (p && pointToSegmentDistance(p.x, p.y, srcA.x, srcA.y, dstA.x, dstA.y) <= THRESHOLD) {
                return true;
            }
        }
    }

    return false;
}

// §1.2.1 The 6 valid visit sequences for a 2-delivery batch.
// Each sequence is [index into stops array]. Stops: pA=0, dA=1, pB=2, dB=3.
// Constraint: pickup before delivery for each good.
const BATCH_VISIT_SEQUENCES = [
    [0, 1, 2, 3], // pA → dA → pB → dB (sequential A-first)
    [2, 3, 0, 1], // pB → dB → pA → dA (sequential B-first)
    [0, 2, 1, 3], // pA → pB → dA → dB (interleaved, deliver A first)
    [0, 2, 3, 1], // pA → pB → dB → dA (interleaved, deliver B first)
    [2, 0, 1, 3], // pB → pA → dA → dB (interleaved, deliver A first)
    [2, 0, 3, 1], // pB → pA → dB → dA (interleaved, deliver B first)
];

// Build a batch plan for a given visit sequence of two deliveries.
// Returns null if paths can't be found or the sequence is invalid.
function buildBatchPlan(ctx, player, deliveryA, deliveryB, sequenceIndices, majorId, majorCity, effectiveCash) {
    // Define the 4 stops: pA(0), dA(1), pB(2), dB(3)
    const stops = [
        { city: deliveryA.sourceCity, action: 'pickup', deliveryIndex: 0, good: deliveryA.good },
        { city: deliveryA.destCity, action: 'deliver', deliveryIndex: 0, cardIndex: deliveryA.cardIndex, demandIndex: deliveryA.demandIndex },
        { city: deliveryB.sourceCity, action: 'pickup', deliveryIndex: 1, good: deliveryB.good },
        { city: deliveryB.destCity, action: 'deliver', deliveryIndex: 1, cardIndex: deliveryB.cardIndex, demandIndex: deliveryB.demandIndex },
    ];

    const visitSequence = sequenceIndices.map(i => stops[i]);

    // §1.2.1 invariant: last stop must be a delivery
    if (visitSequence[visitSequence.length - 1].action !== 'deliver') {
        console.error('Hard AI: batch visit sequence does not end with delivery', sequenceIndices);
        return null;
    }

    // Compute segments with virtual edge accumulation.
    // Track planned edges (not just mileposts) so later segments only get
    // free passage on edges that were actually planned by earlier segments.
    const virtualEdges = new Set();
    // Seed with owned edges so pathfinder treats them as free
    for (const t of ctx.tracks) {
        if (t.color === player.color) {
            virtualEdges.add(t.from + '|' + t.to);
            virtualEdges.add(t.to + '|' + t.from);
        }
    }

    const segments = [];
    const segmentPaths = [];
    let totalBuildCost = 0;
    let prevId = majorId || null; // Start from major city or network
    let prevCity = majorCity || '(network)';

    for (let i = 0; i < visitSequence.length; i++) {
        const stop = visitSequence[i];
        const stopId = ctx.cityToMilepost[stop.city];
        if (!stopId) return null;

        let segPath;
        if (prevId) {
            segPath = findCheapestBuildPath(ctx, prevId, stopId, player.color, null, virtualEdges);
        } else {
            // No specific prev — find from network
            segPath = findCheapestBuildPathFromNetwork(ctx, player, stopId);
            if (segPath) {
                // Adjust cost for virtual edges
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
        buildPath = combinePaths(buildPath, sp);
    }

    // Recompute segment and total build costs by walking each segment path
    // edge-by-edge against real owned edges (corrects Dijkstra virtualTrack errors).
    const ownedEdges = new Set();
    for (const t of ctx.tracks) {
        if (t.color === player.color) {
            ownedEdges.add(t.from + '|' + t.to);
            ownedEdges.add(t.to + '|' + t.from);
        }
    }
    // Track edges from earlier segments as "will be built" so they're free for later segments
    const builtEdges = new Set();
    let totalBuildCostActual = 0;
    for (let i = 0; i < segmentPaths.length; i++) {
        const sp = segmentPaths[i];
        let segCostActual = 0;
        for (let j = 0; j < sp.length - 1; j++) {
            const edgeKey = sp[j] + '|' + sp[j + 1];
            if (ownedEdges.has(edgeKey) || builtEdges.has(edgeKey)) continue;

            // Check ferry
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
        tripDistance += getPathDistance(sp);
    }
    // For subsequent plans, add distance from train to first stop
    if (player.trainLocation && !majorId) {
        const firstStopId = ctx.cityToMilepost[visitSequence[0].city];
        if (firstStopId) {
            const trainPath = findPathOnTrack(ctx, player.trainLocation, firstStopId, player.color, false);
            if (trainPath) tripDistance += getPathDistance(trainPath.path);
        }
    }

    return {
        majorCity: majorCity || null,
        deliveries: [
            { cardIndex: deliveryA.cardIndex, demandIndex: deliveryA.demandIndex, sourceCity: deliveryA.sourceCity, destCity: deliveryA.destCity, good: deliveryA.good, payout: deliveryA.payout },
            { cardIndex: deliveryB.cardIndex, demandIndex: deliveryB.demandIndex, sourceCity: deliveryB.sourceCity, destCity: deliveryB.destCity, good: deliveryB.good, payout: deliveryB.payout },
        ],
        visitSequence,
        segments,
        totalBuildCost,
        totalPayout: deliveryA.payout + deliveryB.payout,
        totalBuildTurns: 0,
        operateTurns: 0,
        estimatedTurns: 0,
        ecuPerTurn: 0,
        buildPath,
        tripDistance,
        currentStopIndex: 0
    };
}

// Enumerate all single-delivery and 2-delivery batch candidate plans.
function enumeratePlans(gs, playerIndex, ctx, options) {
    const player = gs.players[playerIndex];
    const effectiveCash = (options && options.effectiveCash) || player.cash;
    const isInitialBuilding = !gs.tracks.some(t => t.color === player.color);

    const candidates = [];

    // --- Singles ---
    // Collect singles keyed by (cardIndex, demandIndex, sourceCity) to avoid duplicates
    // and to facilitate batch pairing
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

                        const plan = buildSinglePlan(
                            ctx, player, ci, di, demand, sourceCity, srcId,
                            destCity, destId, majorId, majorCity, effectiveCash
                        );
                        if (plan) {
                            candidates.push(plan);
                            singles.push(plan);
                        }
                    }
                } else {
                    const plan = buildSinglePlan(
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

    // --- 2-delivery batches ---
    // Deduplicate singles by (cardIndex, demandIndex, sourceCity) — pick best per major city
    // For batch pairing, use the best single per unique delivery+source combo
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

    // Pair singles that pass the pruning filter
    for (let i = 0; i < uniqueSingles.length; i++) {
        for (let j = i + 1; j < uniqueSingles.length; j++) {
            const sA = uniqueSingles[i];
            const sB = uniqueSingles[j];

            // Skip pairs from the same card+demand (same delivery)
            const dA = sA.deliveries[0];
            const dB = sB.deliveries[0];
            if (dA.cardIndex === dB.cardIndex && dA.demandIndex === dB.demandIndex) continue;

            if (!passesBatchPruning(sA, sB, ctx)) continue;

            // Evaluate all 6 visit sequences
            const deliveryA = dA;
            const deliveryB = dB;

            for (const seq of BATCH_VISIT_SEQUENCES) {
                // For initial building, use the major city from the best single
                const majorCity = sA.majorCity || sB.majorCity || null;
                const majorId = majorCity ? ctx.cityToMilepost[majorCity] : null;

                const batchPlan = buildBatchPlan(
                    ctx, player, deliveryA, deliveryB, seq,
                    majorId || null, majorCity, effectiveCash
                );
                if (batchPlan) candidates.push(batchPlan);
            }
        }
    }

    return candidates;
}

// Build a single-delivery plan object. Returns null if path can't be found.
function buildSinglePlan(ctx, player, cardIndex, demandIndex, demand, sourceCity, srcId, destCity, destId, majorId, majorCity, effectiveCash) {
    // Compute path segments: network → source, source → dest
    // Use virtual edges (not mileposts) so the second segment only reuses
    // edges actually planned by the first segment, avoiding spurious loops.
    let segToSource, segToDest;
    const virtualEdges = new Set();
    // Seed with owned edges
    for (const t of ctx.tracks) {
        if (t.color === player.color) {
            virtualEdges.add(t.from + '|' + t.to);
            virtualEdges.add(t.to + '|' + t.from);
        }
    }

    if (majorId !== null) {
        // Initial building: major city is the "network"
        segToSource = findCheapestBuildPath(ctx, majorId, srcId, player.color, null, virtualEdges);
        if (!segToSource) return null;
        // Add source path edges to virtual set
        for (let j = 0; j < segToSource.path.length - 1; j++) {
            virtualEdges.add(segToSource.path[j] + '|' + segToSource.path[j + 1]);
            virtualEdges.add(segToSource.path[j + 1] + '|' + segToSource.path[j]);
        }
        segToDest = findCheapestBuildPath(ctx, srcId, destId, player.color, null, virtualEdges);
        if (!segToDest) return null;
    } else {
        // Existing network: find cheapest connection from owned track
        segToSource = findCheapestBuildPathFromNetwork(ctx, player, srcId);
        if (!segToSource) return null;
        for (let j = 0; j < segToSource.path.length - 1; j++) {
            virtualEdges.add(segToSource.path[j] + '|' + segToSource.path[j + 1]);
            virtualEdges.add(segToSource.path[j + 1] + '|' + segToSource.path[j]);
        }
        segToDest = findCheapestBuildPath(ctx, srcId, destId, player.color, null, virtualEdges);
        if (!segToDest) return null;
    }

    // Build the full path (milepost sequence) for movement/frontier
    const buildPath = combinePaths(segToSource.path, segToDest.path);

    // Recompute actual build costs by walking each segment path edge-by-edge
    // against real owned edges. The Dijkstra estimate can be off due to
    // virtualTrack imprecision (city entry direction, non-edge milepost adjacency).
    const segToSourceCost = recomputeBuildCost(ctx, player, segToSource.path);
    const segToDestCost = recomputeBuildCost(ctx, player, segToDest.path);
    const totalBuildCost = segToSourceCost + segToDestCost;

    // Compute trip distance (track-based milepost count)
    let tripDistance;
    if (player.trainLocation && majorId === null) {
        // Subsequent plan: include distance from train to first stop
        const trainToSource = findPathOnTrack(ctx, player.trainLocation, srcId, player.color, false);
        const distToSource = trainToSource ? getPathDistance(trainToSource.path) : 0;
        tripDistance = distToSource + getPathDistance(segToDest.path);
    } else {
        // First plan: train deploys at pickup 1, so distance is source → dest only
        tripDistance = getPathDistance(segToDest.path);
    }

    const visitSequence = [
        { city: sourceCity, action: 'pickup', deliveryIndex: 0, good: demand.good },
        { city: destCity, action: 'deliver', deliveryIndex: 0, cardIndex: cardIndex, demandIndex: demandIndex }
    ];

    const segments = [
        { from: majorCity || '(network)', to: sourceCity, buildCost: segToSourceCost, cumCashAfter: null },
        { from: sourceCity, to: destCity, buildCost: segToDestCost, cumCashAfter: null }
    ];

    // The last stop is a delivery — mark cash checkpoint
    segments[segments.length - 1].cumCashAfter = effectiveCash - totalBuildCost + demand.payout;

    return {
        majorCity: majorCity || null,
        deliveries: [
            { cardIndex, demandIndex, sourceCity, destCity, good: demand.good, payout: demand.payout }
        ],
        visitSequence,
        segments,
        totalBuildCost,
        totalPayout: demand.payout,
        totalBuildTurns: 0,    // computed by scorePlan
        operateTurns: 0,       // computed by scorePlan
        estimatedTurns: 0,     // computed by scorePlan
        ecuPerTurn: 0,         // computed by scorePlan
        buildPath,
        tripDistance,
        currentStopIndex: 0
    };
}

// Find cheapest build path from any milepost on the player's existing network
// to a target milepost. Returns { path, cost } or null.
// The pathfinder treats owned edges as zero-cost, so we try from owned city
// mileposts (good hubs) and pick the cheapest result.
function findCheapestBuildPathFromNetwork(ctx, player, targetId) {
    const ownedMps = getPlayerOwnedMileposts(ctx, player.color);
    if (ownedMps.size === 0) return null;

    // If target is already on owned track, cost is 0
    if (ownedMps.has(targetId)) {
        return { path: [targetId], cost: 0 };
    }

    // Try from owned city mileposts first (they're better hubs).
    const ownedCities = [];
    for (const mpId of ownedMps) {
        const mp = ctx.mileposts_by_id[mpId];
        if (mp && mp.city) ownedCities.push(mpId);
    }
    // Fallback to a sample of owned mileposts if no cities
    const startPoints = ownedCities.length > 0 ? ownedCities : [...ownedMps].slice(0, 10);

    let best = null;
    for (const startId of startPoints) {
        const pathResult = findCheapestBuildPath(ctx, startId, targetId, player.color);
        if (pathResult && (best === null || pathResult.cost < best.cost)) {
            best = pathResult;
        }
    }

    return best;
}

// Combine two paths, deduplicating the shared endpoint.
function combinePaths(path1, path2) {
    if (!path1 || path1.length === 0) return path2 || [];
    if (!path2 || path2.length === 0) return path1;
    // If the last milepost of path1 equals the first of path2, skip duplicate
    if (path1[path1.length - 1] === path2[0]) {
        return [...path1, ...path2.slice(1)];
    }
    return [...path1, ...path2];
}

// Rebuild a plan's buildPath by re-pathfinding between visit sequence stops.
// Used when foreign track blocks the existing path — preserves the plan's
// deliveries, visit sequence, and carried goods while routing around obstacles.
// Returns the new buildPath array, or null if any segment can't be routed.
function rebuildPlanPath(ctx, player, plan) {
    const virtualEdges = new Set();
    for (const t of ctx.tracks) {
        if (t.color === player.color) {
            virtualEdges.add(t.from + '|' + t.to);
            virtualEdges.add(t.to + '|' + t.from);
        }
    }

    // Collect the city mileposts for remaining stops
    const stops = plan.visitSequence;
    let prevId = null;

    // Find where the train or network connects
    if (player.trainLocation) {
        prevId = player.trainLocation;
    } else if (plan.majorCity) {
        prevId = ctx.cityToMilepost[plan.majorCity];
    }

    let newPath = [];
    for (let i = plan.currentStopIndex; i < stops.length; i++) {
        const stopId = ctx.cityToMilepost[stops[i].city];
        if (!stopId) return null;

        if (!prevId) {
            // Find from network
            const seg = findCheapestBuildPathFromNetwork(ctx, player, stopId);
            if (!seg) return null;
            newPath = combinePaths(newPath, seg.path);
            for (let j = 0; j < seg.path.length - 1; j++) {
                virtualEdges.add(seg.path[j] + '|' + seg.path[j + 1]);
                virtualEdges.add(seg.path[j + 1] + '|' + seg.path[j]);
            }
        } else {
            const seg = findCheapestBuildPath(ctx, prevId, stopId, player.color, null, virtualEdges);
            if (!seg) return null;
            newPath = combinePaths(newPath, seg.path);
            for (let j = 0; j < seg.path.length - 1; j++) {
                virtualEdges.add(seg.path[j] + '|' + seg.path[j + 1]);
                virtualEdges.add(seg.path[j + 1] + '|' + seg.path[j]);
            }
        }
        prevId = stopId;
    }

    return newPath.length >= 2 ? newPath : null;
}

// ---------------------------------------------------------------------------
// §1.3 — checkAffordability
// ---------------------------------------------------------------------------

// Check whether a plan is affordable.
// Singles: totalBuildCost <= cash with a small reserve.
// Batches: segment-based sequential check with cash checkpoints at each
// delivery stop (§1.3). Cash is updated after each delivery payout.
//
// Reserve applied during affordability checks to prevent the AI from committing
// every last dollar to building. Cost estimates have inherent imprecision (city
// entry direction, edge-based vs milepost-based deduplication) and zero-margin
// plans leave no room for recovery from tax events or cost surprises.
const AFFORDABILITY_RESERVE = 5;

function checkAffordability(plan, player, ctx, options) {
    const effectiveCash = (options && options.effectiveCash) || player.cash;

    // Single delivery: simple check with reserve
    if (plan.deliveries.length === 1) {
        return plan.totalBuildCost <= effectiveCash - AFFORDABILITY_RESERVE;
    }

    // Batch: sequential cash checkpoint check (§1.3)
    let accumulatedBuildCost = 0;
    let cash = effectiveCash;

    for (let i = 0; i < plan.segments.length; i++) {
        accumulatedBuildCost += plan.segments[i].buildCost;

        const stop = plan.visitSequence[i];
        if (stop && stop.action === 'deliver') {
            // Cash checkpoint: can we afford everything built since last delivery?
            if (accumulatedBuildCost > cash - AFFORDABILITY_RESERVE) return false;
            const delivery = plan.deliveries[stop.deliveryIndex];
            cash = cash - accumulatedBuildCost + delivery.payout;
            accumulatedBuildCost = 0;
        }
    }

    // §1.2.1 invariant: last stop must be delivery, so accumulatedBuildCost should be 0
    if (accumulatedBuildCost > 0) {
        console.error('Hard AI: checkAffordability — accumulatedBuildCost not zero after loop', accumulatedBuildCost);
        return accumulatedBuildCost <= cash;
    }

    return true;
}

// ---------------------------------------------------------------------------
// §1.4 — scorePlan (ECU/turn)
// ---------------------------------------------------------------------------

// Compute ECU/turn score for a plan. Mutates the plan object with computed
// fields: totalBuildTurns, operateTurns, estimatedTurns, ecuPerTurn.
function scorePlan(plan, player, gs, ctx, options) {
    const effectiveCash = (options && options.effectiveCash) || player.cash;
    const speedTier = (gs.gameSettings && gs.gameSettings.speedTier) || 'Standard';
    const trainSpeed = getTrainMovement(player.trainType, speedTier);

    // Build turns estimated per segment group (segments between deliveries)
    let totalBuildTurns = 0;
    let groupBuildCost = 0;
    let currentCash = effectiveCash;

    for (let i = 0; i < plan.segments.length; i++) {
        const seg = plan.segments[i];
        groupBuildCost += seg.buildCost;

        // Check if this segment ends at a delivery stop
        const stop = plan.visitSequence[i];
        if (stop && stop.action === 'deliver') {
            // Estimate build turns for this group
            const cashPerTurn = Math.min(20, currentCash) * 0.75;
            if (cashPerTurn > 0) {
                totalBuildTurns += groupBuildCost / cashPerTurn;
            } else {
                totalBuildTurns = Infinity;
            }

            // Find payout for this delivery
            const delivery = plan.deliveries[stop.deliveryIndex];
            currentCash = currentCash - groupBuildCost + delivery.payout;
            groupBuildCost = 0;
        }
    }

    // Handle case where last segment wasn't a delivery (shouldn't happen
    // per §1.2.1 invariant, but defensive)
    if (groupBuildCost > 0) {
        const cashPerTurn = Math.min(20, currentCash) * 0.75;
        if (cashPerTurn > 0) {
            totalBuildTurns += groupBuildCost / cashPerTurn;
        } else {
            totalBuildTurns = Infinity;
        }
    }

    // Operate turns: track-based distance / train speed
    const operateTurns = Math.ceil(plan.tripDistance / trainSpeed);

    // Total turns: build and operate are interleaved (§1.4, A.39)
    const estimatedTurns = Math.max(totalBuildTurns, operateTurns);

    // ECU/turn (normal scoring)
    let ecuPerTurn = plan.totalPayout / Math.max(estimatedTurns, 1);

    // Mutate plan with computed values
    plan.totalBuildTurns = totalBuildTurns;
    plan.operateTurns = operateTurns;
    plan.estimatedTurns = estimatedTurns;
    plan.ecuPerTurn = ecuPerTurn;

    // §8.4: Endgame scoring — switch to turns-to-win for winning plans
    const aiState = getAIState(player);
    if (aiState.endgameMode) {
        const settings = (gs.gameSettings) || { winCashThreshold: 250, winMajorCitiesRequired: 7 };
        const debtDeductions = Math.min(
            player.debtRemaining || 0,
            plan.deliveries.length * 10
        );
        const netPayout = plan.totalPayout - debtDeductions;
        const cashAfterPlan = player.cash + netPayout - plan.totalBuildCost;

        if (cashAfterPlan >= settings.winCashThreshold) {
            // This plan wins on cash — compute turns-to-win
            const cityInfo = getUnconnectedMajorCityCosts(ctx, player, gs);

            let turnsToWin;
            if (cityInfo.citiesNeeded === 0) {
                turnsToWin = estimatedTurns;
            } else {
                // City connections built during build phase after plan route completes
                const cityBuildCashPerTurn = Math.min(20, cashAfterPlan) * 0.75;
                const cityBuildTurns = cityBuildCashPerTurn > 0
                    ? cityInfo.totalCost / cityBuildCashPerTurn
                    : Infinity;
                // Build work is sequential (plan route + city connections),
                // overlaps with operate (§8.4, A.74)
                turnsToWin = Math.max(totalBuildTurns + cityBuildTurns, operateTurns);
            }

            // Score inversion: 1000 - turnsToWin guarantees winning plans
            // always outscore non-winning plans (ECU/turn << 1000)
            ecuPerTurn = 1000 - turnsToWin;
            plan.ecuPerTurn = ecuPerTurn;
        }
    }

    return ecuPerTurn;
}

// ---------------------------------------------------------------------------
// §1.5 — selectPlan
// ---------------------------------------------------------------------------

// Select the best plan from enumerated candidates. Returns the highest-scoring
// affordable plan, or null if none exists.
// Accepts options.effectiveCash to override player.cash (used by handleNoPlan
// for borrowing evaluation).
function selectPlan(gs, playerIndex, ctx, options) {
    const player = gs.players[playerIndex];
    const candidates = enumeratePlans(gs, playerIndex, ctx, options);

    let bestPlan = null;
    let bestScore = -Infinity;

    for (const plan of candidates) {
        // Affordability gate
        if (!checkAffordability(plan, player, ctx, options)) continue;

        // Initial building reachability filter (§1.2):
        // Build cost from major city to pickup 1 must be ≤ 40M
        if (plan.majorCity && plan.segments.length > 0) {
            const costToPickup1 = plan.segments[0].buildCost;
            if (costToPickup1 > 40) continue;
        }

        // Score the plan
        const score = scorePlan(plan, player, gs, ctx, options);

        if (score > bestScore) {
            bestScore = score;
            bestPlan = plan;
        }
    }

    // §7.1 Target selection logging
    const affordable = candidates.filter(p => checkAffordability(p, player, ctx, options));
    const singles = candidates.filter(p => p.deliveries.length === 1);
    const batches = candidates.filter(p => p.deliveries.length === 2);
    logDecision(playerIndex, 'target selection',
        `Candidates: ${singles.length} singles, ${batches.length} batches. ` +
        `Affordable: ${affordable.length}. Cash: ${(options && options.effectiveCash) || player.cash}M. ` +
        `Selected: ${formatPlanSummary(bestPlan)}`
    );

    return bestPlan;
}

// ---------------------------------------------------------------------------
// §2.2 — selectMajorCity
// ---------------------------------------------------------------------------

// Thin accessor: returns plan.majorCity (already determined by selectPlan
// during initial building). For subsequent plans, returns null.
function selectMajorCity(gs, playerIndex, ctx, plan) {
    return plan ? plan.majorCity : null;
}

// ---------------------------------------------------------------------------
// Stubs for functions implemented in later commits
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// §5.1–§5.3 — shouldDiscard
// ---------------------------------------------------------------------------

// Evaluate whether to discard the current hand. Only called with a non-null,
// freshly selected plan (null plans go through handleNoPlan instead).
//
// §5.3: Universal guard — never discard while carrying goods.
// §5.2: Discard if best plan < 2 ECU/turn, unless already discarded 2x via
//        this threshold (consecutiveWeakDiscards). Counter incremented as side
//        effect when returning true.
function shouldDiscard(gs, playerIndex, ctx, plan) {
    const player = gs.players[playerIndex];
    const aiState = getAIState(player);

    // Don't discard if carrying a good that matches an affordable delivery on
    // the current hand. The pickup is sunk cost — delivering is almost always
    // better than gambling on fresh cards.
    if (player.loads.length > 0) {
        for (const carried of player.loads) {
            for (const card of player.demandCards) {
                if (!card || !card.demands) continue;
                for (const demand of card.demands) {
                    if (demand.good === carried) return false;
                }
            }
        }
    }

    // §5.2: Threshold check
    const ECU_THRESHOLD = 2.0;
    if (plan.ecuPerTurn >= ECU_THRESHOLD) return false;

    // After 2 consecutive weak discards, accept the marginal plan
    if (aiState.consecutiveWeakDiscards >= 2) return false;

    // §7.4 Discard logging
    logDecision(playerIndex, 'discard',
        `Best plan ECU/turn: ${plan.ecuPerTurn.toFixed(2)} (threshold: ${ECU_THRESHOLD}). ` +
        `Carrying: ${player.loads.length > 0 ? player.loads.join(',') : 'none'}. ` +
        `Decision: discard (weak plan, consecutive=${aiState.consecutiveWeakDiscards + 1})`
    );

    // Weak plan → discard
    aiState.consecutiveWeakDiscards++;

    // §A.59: Reset consecutiveDiscards — finding a viable plan (even weak)
    // proves cash isn't the issue
    aiState.consecutiveDiscards = 0;

    return true;
}

// ---------------------------------------------------------------------------
// §5.4 — handleNoPlan (discard-loop detection + borrowing)
// ---------------------------------------------------------------------------

// Called when selectPlan returns null (no affordable plan exists).
// Implements discard-loop detection (§5.4.1) and borrowing evaluation (§5.4.2).
//
// Returns: [{ type: 'discardHand' }] or [{ type: 'borrow', amount }, ...moveActions]
function handleNoPlan(gs, playerIndex, ctx, strategy) {
    strategy = strategy || module.exports;
    const player = gs.players[playerIndex];
    const aiState = getAIState(player);

    // §5.4.3: Never borrow during initial building
    if (gs.phase === 'initialBuilding') {
        aiState.consecutiveDiscards++;
        return [{ type: 'discardHand' }];
    }

    // §5.4.1: Not yet in a discard loop — just discard
    if (aiState.consecutiveDiscards < 2) {
        aiState.consecutiveDiscards++;
        return [{ type: 'discardHand' }];
    }

    // §5.4.2: Discard loop detected — evaluate borrowing
    const maxBorrowable = 20 - (player.borrowedAmount || 0);
    const amounts = [5, 10, 15, 20].filter(a => a <= maxBorrowable);

    for (const borrowAmount of amounts) {
        const effectiveCash = player.cash + borrowAmount;
        const plan = strategy.selectPlan(gs, playerIndex, ctx, { effectiveCash });
        if (!plan) continue;

        const totalDebt = (player.debtRemaining || 0) + borrowAmount * 2;
        const deductionsThisPlan = Math.min(totalDebt, plan.deliveries.length * 10);
        const effectivePayout = plan.totalPayout - deductionsThisPlan;
        const effectiveEcuPerTurn = effectivePayout / Math.max(plan.estimatedTurns, 1);

        if (effectiveEcuPerTurn > 0) {
            // Viable plan found — borrow and commit
            aiState.consecutiveDiscards = 0;
            commitPlan(gs, playerIndex, plan);
            const movementActions = strategy.planMovement(gs, playerIndex, ctx, plan);
            return [{ type: 'borrow', amount: borrowAmount }, ...movementActions];
        }
    }

    // No borrowing amount unlocks a viable plan — discard again
    // consecutiveDiscards stays >= 2, so next turn will retry borrowing
    return [{ type: 'discardHand' }];
}

// ---------------------------------------------------------------------------
// §4.4 — shouldUpgrade
// ---------------------------------------------------------------------------

// Evaluate whether to upgrade to Fast Freight. The upgrade costs 20M and
// consumes the entire build phase (no track built that turn).
//
// Gate 1: Can the AI afford its entire committed route?
//   remainingBuildCost <= player.cash → pass
// Gate 2: Is there 20M surplus after the route is fully funded?
//   surplus = player.cash - remainingBuildCost >= 20M → UPGRADE
// Gate 3: Endgame city connection check — added in commit 8.
function shouldUpgrade(gs, playerIndex, ctx) {
    const player = gs.players[playerIndex];

    // Only upgrade to Fast Freight (Hard AI doesn't consider Heavy/Super)
    if (player.trainType !== 'Freight') return false;

    // Must not have already built this turn (upgrade consumes full build phase)
    if (gs.buildingThisTurn > 0) return false;

    const plan = getCommittedPlan(gs, playerIndex);
    if (!plan) return false;

    // Compute remaining build cost for unbuilt segments
    const remainingBuildCost = computeRemainingBuildCost(gs, playerIndex, ctx, plan);

    // Gate 1: Can the AI afford the entire remaining route?
    if (remainingBuildCost > player.cash) return false;

    // Gate 2: Is there 20M surplus?
    const surplus = player.cash - remainingBuildCost;
    if (surplus < 20) return false;

    // Gate 3: Can the AI still find an affordable plan after upgrading?
    // This directly answers "will I be able to keep playing?" rather than
    // using a fixed reserve. With extensive track, most plans are cheap and
    // this passes easily. Early game with little track, plans are expensive
    // and the gate blocks premature upgrades.
    //
    // Important: project cash forward to include pending delivery payouts from
    // the current plan, and exclude those demand cards from the test search.
    // Otherwise the AI may find its *current* delivery as the "next" plan,
    // approve the upgrade, then have no money for a real next plan.
    let pendingPayout = 0;
    const excludeCards = new Set();
    for (const stop of plan.visitSequence) {
        if (stop.action === 'deliver') {
            pendingPayout += plan.deliveries[stop.deliveryIndex].payout;
            excludeCards.add(stop.cardIndex);
        }
    }
    const cashAfterAll = surplus - 20 + pendingPayout; // cash after upgrade + route + deliveries
    const testPlan = selectPlan(gs, playerIndex, ctx, { effectiveCash: cashAfterAll, excludeCardIndices: excludeCards });
    if (!testPlan) {
        logDecision(playerIndex, 'build',
            `Upgrade skipped: Gate 3 — no affordable plan with ${cashAfterAll}M post-upgrade cash (pending payout: ${pendingPayout}M)`
        );
        return false;
    }

    // Gate 4: Endgame — would upgrading starve city connections?
    const aiState = getAIState(player);
    if (aiState.endgameMode) {
        const cityInfo = getUnconnectedMajorCityCosts(ctx, player, gs);
        if (cityInfo.citiesNeeded > 0) {
            if (cashAfterAll < cityInfo.totalCost) {
                logDecision(playerIndex, 'build',
                    `Upgrade skipped: Gate 4 (endgame) — post-upgrade cash ${cashAfterAll}M < ` +
                    `city connection cost ${cityInfo.totalCost}M (${cityInfo.citiesNeeded} cities needed)`
                );
                return false;
            }
        }
    }

    logDecision(playerIndex, 'build',
        `Upgrade to Fast Freight: surplus=${surplus}M, remaining route=${remainingBuildCost}M, ` +
        `post-upgrade cash=${cashAfterAll}M, next plan viable: ${formatPlanSummary(testPlan)}`
    );
    return true;
}

// Compute the remaining build cost for unbuilt segments of the committed plan.
function computeRemainingBuildCost(gs, playerIndex, ctx, plan) {
    if (!plan || !plan.buildPath || plan.buildPath.length < 2) return 0;

    const player = gs.players[playerIndex];
    const ownedEdges = new Set();
    for (const t of gs.tracks) {
        if (t.color === player.color) {
            ownedEdges.add(t.from + '|' + t.to);
            ownedEdges.add(t.to + '|' + t.from);
        }
    }

    let cost = 0;
    for (let i = 0; i < plan.buildPath.length - 1; i++) {
        const fromId = plan.buildPath[i];
        const toId = plan.buildPath[i + 1];
        const edgeKey = fromId + '|' + toId;

        if (ownedEdges.has(edgeKey)) continue; // Already built

        // Check if ferry
        const ferryKey = getFerryKey(fromId, toId);
        let isFerry = false;
        for (const fc of ctx.ferryConnections) {
            if (getFerryKey(fc.fromId, fc.toId) === ferryKey) {
                isFerry = true;
                if (!gl.playerOwnsFerry(ctx, ferryKey, player.color)) {
                    cost += fc.cost;
                    const destMp = ctx.mileposts_by_id[toId];
                    if (destMp && destMp.city) {
                        cost += MAJOR_CITIES.includes(destMp.city.name) ? 5 : 3;
                    }
                }
                break;
            }
        }
        if (isFerry) continue;

        const mp1 = ctx.mileposts_by_id[fromId];
        const mp2 = ctx.mileposts_by_id[toId];
        if (mp1 && mp2) {
            cost += getMileppostCost(mp1, mp2);
        }
    }

    return cost;
}

// ---------------------------------------------------------------------------
// §2.3, §4.1–§4.3 — computeBuildOrder
// ---------------------------------------------------------------------------

// Determine what track to build this turn. Returns an array of commitBuild
// action(s). Builds segments in visit-sequence order, respecting budget.
//
// §2.4: Always build OUT of unconnected major cities (1M exit vs 5M entry).
// §4.2: For segments targeting an unconnected major city, reverse the build
//        direction (emit mileposts from major city outward).
// §4.3: Save budget when route is complete (no speculative building outside
//        endgame mode, which is added in commit 8).
function computeBuildOrder(gs, playerIndex, ctx, plan, majorCity) {
    if (!plan) {
        // §8.3: Endgame — connect cheapest unconnected major cities
        const aiState = getAIState(gs.players[playerIndex]);
        if (aiState.endgameMode) {
            return buildEndgameCityConnections(gs, playerIndex, ctx);
        }
        return [];
    }

    // §6.2.2: Rail closure (strike 123) — skip building
    if (isRailClosureActive(gs, playerIndex)) return [];

    const player = gs.players[playerIndex];
    const remainingBudget = 20 - gs.buildingThisTurn;
    const spendLimit = Math.min(remainingBudget, player.cash);
    if (spendLimit <= 0) {
        if (player.cash <= 0) {
            logDecision(playerIndex, 'build', `No budget: cash=${player.cash}M. Plan: ${formatPlanSummary(plan)}`);
        }
        return [];
    }

    // Build sets of owned track and other players' track
    const ownedEdges = new Set();
    const otherEdges = new Set();
    const ownedMileposts = new Set();
    for (const t of gs.tracks) {
        if (t.color === player.color) {
            ownedEdges.add(t.from + '|' + t.to);
            ownedEdges.add(t.to + '|' + t.from);
            ownedMileposts.add(t.from);
            ownedMileposts.add(t.to);
        } else {
            otherEdges.add(t.from + '|' + t.to);
            otherEdges.add(t.to + '|' + t.from);
        }
    }

    // During initial building with a major city, the major city milepost
    // is a valid build origin even without owned track there
    if (majorCity) {
        const majorId = ctx.cityToMilepost[majorCity];
        if (majorId) ownedMileposts.add(majorId);
    }

    // Build ferry edge lookup
    const ferryEdgeKeys = new Set();
    for (const fc of ctx.ferryConnections) {
        ferryEdgeKeys.add(getFerryKey(fc.fromId, fc.toId));
    }

    // Collect all build actions for this turn
    const allBuildPaths = [];
    let totalCost = 0;
    let totalMajorCities = 0;
    const ferries = [];

    // For batch plans, stop building past the first undelivered delivery stop.
    // The affordability check assumes intermediate delivery payouts fund later
    // segments, so we must actually deliver before spending money on later segments.
    let buildSegmentLimit = plan.segments.length;
    if (plan.deliveries.length > 1) {
        for (let i = 0; i < plan.visitSequence.length; i++) {
            const stop = plan.visitSequence[i];
            if (stop.action === 'deliver' && i >= plan.currentStopIndex) {
                // Stop building after the segment that reaches this delivery
                // (segIdx corresponds to visitSequence index)
                buildSegmentLimit = i + 1;
                break;
            }
        }
    }

    // Walk through segments in visit-sequence order
    for (let segIdx = 0; segIdx < buildSegmentLimit; segIdx++) {
        const seg = plan.segments[segIdx];
        if (seg.buildCost === 0) continue; // nothing to build

        // Determine the mileposts for this segment from the buildPath.
        // The buildPath is the full route; we need to extract the sub-path
        // for this segment. Use the city mileposts as boundaries.
        const fromCity = seg.from === '(network)' ? majorCity : seg.from;
        const toCity = seg.to;
        const fromId = fromCity ? ctx.cityToMilepost[fromCity] : null;
        const toId = toCity ? ctx.cityToMilepost[toCity] : null;
        if (!toId) continue;

        // Find the sub-path for this segment
        let segmentPath = extractSegmentPath(plan.buildPath, fromId, toId, ctx);
        if (!segmentPath || segmentPath.length < 2) continue;

        // §4.2: Check if target is an unconnected major city — reverse build direction
        const targetMp = ctx.mileposts_by_id[toId];
        const targetIsMajorCity = targetMp && targetMp.city && MAJOR_CITIES.includes(targetMp.city.name);
        const targetIsUnconnected = targetIsMajorCity && !ownedMileposts.has(toId);
        if (targetIsUnconnected) {
            segmentPath = [...segmentPath].reverse();
        }

        // Walk the segment path, building unbuilt edges within budget
        let segBuildPath = [];
        let segBuildCost = 0;
        let segMajorCities = 0;
        let segFerries = [];
        let started = false;

        for (let i = 0; i < segmentPath.length - 1; i++) {
            const from = segmentPath[i];
            const to = segmentPath[i + 1];
            const edgeKey = from + '|' + to;
            const ferryKey = getFerryKey(from, to);
            const isFerry = ferryEdgeKeys.has(ferryKey);

            if (isFerry) {
                // Check if already owned
                if (gl.playerOwnsFerry(ctx, ferryKey, player.color)) {
                    if (started) segBuildPath.push(to);
                    continue;
                }
                // Compute ferry cost
                let ferryCost = 0;
                for (const fc of ctx.ferryConnections) {
                    if (getFerryKey(fc.fromId, fc.toId) === ferryKey) {
                        ferryCost = fc.cost;
                        const destMp = ctx.mileposts_by_id[to];
                        if (destMp && destMp.city) {
                            ferryCost += MAJOR_CITIES.includes(destMp.city.name) ? 5 : 3;
                        }
                        break;
                    }
                }
                if (totalCost + segBuildCost + ferryCost > spendLimit) break;
                if (!started) {
                    if (!canStartBuildFrom(from, ownedMileposts, ctx)) continue;
                    segBuildPath.push(from);
                    started = true;
                }
                segBuildPath.push(to);
                segBuildCost += ferryCost;
                segFerries.push(ferryKey);
                continue;
            }

            // Check if already built
            if (ownedEdges.has(edgeKey)) {
                if (started) segBuildPath.push(to);
                continue;
            }

            // Skip edges owned by other players — can't build on foreign track
            if (otherEdges.has(edgeKey)) break;

            // Compute segment cost
            const mp1 = ctx.mileposts_by_id[from];
            const mp2 = ctx.mileposts_by_id[to];
            if (!mp1 || !mp2) continue;
            const edgeCost = getMileppostCost(mp1, mp2);

            // Check major city limit
            let newMajorCities = 0;
            if (mp2.city && MAJOR_CITIES.includes(mp2.city.name)) {
                newMajorCities = 1;
            }
            if (gs.majorCitiesThisTurn + totalMajorCities + segMajorCities + newMajorCities > 2) break;

            if (totalCost + segBuildCost + edgeCost > spendLimit) break;

            if (!started) {
                if (!canStartBuildFrom(from, ownedMileposts, ctx)) continue;
                segBuildPath.push(from);
                started = true;
            }
            segBuildPath.push(to);
            segBuildCost += edgeCost;
            segMajorCities += newMajorCities;
        }

        if (segBuildPath.length >= 2 && segBuildCost > 0) {
            allBuildPaths.push({
                buildPath: segBuildPath,
                buildCost: segBuildCost,
                majorCityCount: segMajorCities,
                ferries: segFerries
            });
            totalCost += segBuildCost;
            totalMajorCities += segMajorCities;
            ferries.push(...segFerries);

            // Update owned sets for next segment
            for (let i = 0; i < segBuildPath.length - 1; i++) {
                const e1 = segBuildPath[i] + '|' + segBuildPath[i + 1];
                const e2 = segBuildPath[i + 1] + '|' + segBuildPath[i];
                ownedEdges.add(e1);
                ownedEdges.add(e2);
                ownedMileposts.add(segBuildPath[i]);
                ownedMileposts.add(segBuildPath[i + 1]);
            }
        }

        if (totalCost >= spendLimit) break;
    }

    // Convert to commitBuild actions
    const buildActions = allBuildPaths.map(bp => ({
        type: 'commitBuild',
        buildPath: bp.buildPath,
        buildCost: bp.buildCost,
        majorCityCount: bp.majorCityCount,
        ferries: bp.ferries
    }));

    // §8.3: If plan route is fully built and in endgame mode, use remaining
    // budget for major city connections
    const aiState = getAIState(gs.players[playerIndex]);
    if (aiState.endgameMode && totalCost < spendLimit) {
        const remainingBudgetAfterPlan = spendLimit - totalCost;
        if (remainingBudgetAfterPlan > 0) {
            const endgameActions = buildEndgameCityConnections(
                gs, playerIndex, ctx, remainingBudgetAfterPlan, totalMajorCities
            );
            buildActions.push(...endgameActions);
        }
    }

    return buildActions;
}

// §8.3: Build connections to cheapest unconnected major cities.
// Used when plan route is fully built or no plan exists in endgame mode.
function buildEndgameCityConnections(gs, playerIndex, ctx, budgetOverride, usedMajorCities) {
    const player = gs.players[playerIndex];
    const remainingBudget = budgetOverride !== undefined
        ? budgetOverride
        : 20 - gs.buildingThisTurn;
    const spendLimit = Math.min(remainingBudget, player.cash);
    if (spendLimit <= 0) return [];

    const cityInfo = getUnconnectedMajorCityCosts(ctx, player, gs);
    if (cityInfo.citiesNeeded === 0) return [];

    const actions = [];
    let spent = 0;
    let majorCityCount = usedMajorCities || 0;

    // Build toward cheapest unconnected major cities
    for (const conn of cityInfo.connections) {
        if (spent >= spendLimit) break;
        if (gs.majorCitiesThisTurn + majorCityCount >= 2) break;

        const majorId = ctx.cityToMilepost[conn.city];
        if (!majorId) continue;

        // Find path from major city outward to owned track (build OUT)
        const ownedMps = getPlayerOwnedMileposts(ctx, player.color);
        let bestPath = null;
        const ownedCities = [];
        for (const mpId of ownedMps) {
            const mp = ctx.mileposts_by_id[mpId];
            if (mp && mp.city) ownedCities.push(mpId);
        }
        const targets = ownedCities.length > 0 ? ownedCities : [...ownedMps].slice(0, 5);

        for (const targetId of targets) {
            const result = findPath(ctx, majorId, targetId, player.color, 'cheapest');
            if (result && (!bestPath || result.cost < bestPath.cost)) {
                bestPath = result;
            }
        }
        if (!bestPath || bestPath.cost === 0) continue;

        // Build as much as budget allows
        const ownedEdges = new Set();
        const otherEdgesEndgame = new Set();
        for (const t of gs.tracks) {
            if (t.color === player.color) {
                ownedEdges.add(t.from + '|' + t.to);
                ownedEdges.add(t.to + '|' + t.from);
            } else {
                otherEdgesEndgame.add(t.from + '|' + t.to);
                otherEdgesEndgame.add(t.to + '|' + t.from);
            }
        }

        let segPath = [];
        let segCost = 0;
        let segMajorCities = 0;
        let started = false;

        for (let i = 0; i < bestPath.path.length - 1; i++) {
            const from = bestPath.path[i];
            const to = bestPath.path[i + 1];

            if (ownedEdges.has(from + '|' + to)) {
                if (started) segPath.push(to);
                continue;
            }

            // Skip edges owned by other players
            if (otherEdgesEndgame.has(from + '|' + to)) break;

            const mp1 = ctx.mileposts_by_id[from];
            const mp2 = ctx.mileposts_by_id[to];
            if (!mp1 || !mp2) continue;
            const edgeCost = getMileppostCost(mp1, mp2);

            let newMajorCities = 0;
            if (mp2.city && MAJOR_CITIES.includes(mp2.city.name)) newMajorCities = 1;
            if (gs.majorCitiesThisTurn + majorCityCount + segMajorCities + newMajorCities > 2) break;

            if (spent + segCost + edgeCost > spendLimit) break;

            if (!started) {
                segPath.push(from);
                started = true;
            }
            segPath.push(to);
            segCost += edgeCost;
            segMajorCities += newMajorCities;
        }

        if (segPath.length >= 2 && segCost > 0) {
            actions.push({
                type: 'commitBuild',
                buildPath: segPath,
                buildCost: segCost,
                majorCityCount: segMajorCities,
                ferries: []
            });
            spent += segCost;
            majorCityCount += segMajorCities;
        }
    }

    return actions;
}

// Check if a milepost is a valid build origin (owned track or major city).
function canStartBuildFrom(mpId, ownedMileposts, ctx) {
    if (ownedMileposts.has(mpId)) return true;
    const mp = ctx.mileposts_by_id[mpId];
    return mp && mp.city && MAJOR_CITIES.includes(mp.city.name);
}

// Extract the sub-path from buildPath between two city mileposts.
// Returns the slice of buildPath from fromId to toId (inclusive).
function extractSegmentPath(buildPath, fromId, toId, ctx) {
    if (!buildPath || buildPath.length === 0) return null;

    let startIdx = -1;
    let endIdx = -1;

    // Find fromId in buildPath
    if (fromId) {
        for (let i = 0; i < buildPath.length; i++) {
            if (buildPath[i] === fromId) { startIdx = i; break; }
        }
    } else {
        startIdx = 0; // Start from beginning if no fromId
    }

    // Find toId in buildPath (search from startIdx forward)
    if (toId && startIdx >= 0) {
        for (let i = startIdx; i < buildPath.length; i++) {
            if (buildPath[i] === toId) { endIdx = i; break; }
        }
    }

    if (startIdx < 0 || endIdx < 0 || startIdx >= endIdx) return null;
    return buildPath.slice(startIdx, endIdx + 1);
}

// ---------------------------------------------------------------------------
// §3.1–§3.4 — planMovement
// ---------------------------------------------------------------------------

// Plan the operate phase: deploy train if needed, then move through the visit
// sequence consuming all available movement points. Returns an array of
// action descriptors (deployTrain, commitMove, pickupGood, deliverGood,
// endOperatePhase).
function planMovement(gs, playerIndex, ctx, plan) {
    const player = gs.players[playerIndex];
    const actions = [];

    // §3.1 Deployment preamble: deploy at pickup 1 if train not on map
    if (player.trainLocation === null) {
        const pickup1 = plan.visitSequence[0];
        if (!pickup1) return [{ type: 'endOperatePhase' }];
        const deployId = ctx.cityToMilepost[pickup1.city];
        if (!deployId) {
            console.error(`Hard AI: pickup 1 city "${pickup1.city}" has no milepost`);
            return [{ type: 'endOperatePhase' }];
        }
        actions.push({ type: 'deployTrain', milepostId: deployId });
        // After deployment, train is at pickup 1
        // Fall through to movement loop which will handle pickup at this city
    }

    const effectiveLocation = () => {
        // Find the last action that changes location
        for (let i = actions.length - 1; i >= 0; i--) {
            if (actions[i].type === 'deployTrain') return actions[i].milepostId;
            if (actions[i].type === 'commitMove') {
                const path = actions[i].path;
                return path[path.length - 1];
            }
        }
        return player.trainLocation;
    };

    // Track remaining movement (we simulate consumption locally since the
    // actions haven't been applied to gameState yet)
    let movementRemaining = player.movement;
    // Track carried goods locally (simulate pickups/deliveries)
    const carriedGoods = [...player.loads];

    // §3.2 Movement loop
    // Use a local simulation index — do NOT mutate plan.currentStopIndex here.
    // The real index is advanced by the server when actions actually succeed.
    let simStopIndex = plan.currentStopIndex;

    while (movementRemaining > 0 || actions.length <= 1) {
        // actions.length <= 1 allows the first iteration even with 0 movement
        // (to handle pickup at deploy location)
        if (simStopIndex >= plan.visitSequence.length) break; // all stops visited

        const nextStop = plan.visitSequence[simStopIndex];
        const stopId = ctx.cityToMilepost[nextStop.city];
        if (!stopId) break;

        const currentLoc = effectiveLocation();

        // §6.2.2: Skip movement toward strike-blocked cities
        if ((nextStop.action === 'pickup' || nextStop.action === 'deliver') &&
            isStrikeBlockingCity(gs, stopId)) {
            // City is blocked by strike — wait it out, don't abandon
            break;
        }

        // Step 1: Am I at the next stop?
        if (currentLoc === stopId) {
            if (nextStop.action === 'pickup') {
                // §3.4: Check supply before pickup
                if (!isGoodAvailable(gs, nextStop.good, carriedGoods)) {
                    // Supply exhausted — abandon plan
                    handleSupplyExhaustion(gs, playerIndex, plan, carriedGoods);
                    break;
                }
                // Check train capacity — drop an irrelevant good if needed
                const trainCapacity = gl.TRAIN_TYPES[player.trainType].capacity;
                if (carriedGoods.length >= trainCapacity) {
                    // Find a carried good not needed by this plan's remaining deliveries
                    const neededGoods = new Set();
                    for (let si = simStopIndex; si < plan.visitSequence.length; si++) {
                        const s = plan.visitSequence[si];
                        if (s.action === 'deliver') {
                            neededGoods.add(plan.deliveries[s.deliveryIndex].good);
                        }
                    }
                    // Also count the good we're about to pick up as needed
                    neededGoods.add(nextStop.good);

                    let dropIdx = -1;
                    for (let li = 0; li < carriedGoods.length; li++) {
                        if (!neededGoods.has(carriedGoods[li])) {
                            dropIdx = li;
                            break;
                        }
                    }
                    if (dropIdx >= 0) {
                        logDecision(playerIndex, 'drop',
                            `Dropping ${carriedGoods[dropIdx]} (not needed) to make room for ${nextStop.good}`
                        );
                        actions.push({ type: 'dropGood', loadIndex: dropIdx });
                        carriedGoods.splice(dropIdx, 1);
                    } else {
                        // All carried goods are needed — can't drop, abandon plan
                        logDecision(playerIndex, 'plan abandoned',
                            `Reason: train at capacity (${carriedGoods.length}/${trainCapacity}), all goods needed. ` +
                            `Carrying: [${carriedGoods}]. Plan: ${formatPlanSummary(plan)}`
                        );
                        clearCommittedPlan(gs, playerIndex);
                        break;
                    }
                }
                actions.push({ type: 'pickupGood', good: nextStop.good, _advanceStop: true });
                carriedGoods.push(nextStop.good);
            } else if (nextStop.action === 'deliver') {
                actions.push({
                    type: 'deliverGood',
                    cardIndex: nextStop.cardIndex,
                    demandIndex: nextStop.demandIndex,
                    _advanceStop: true
                });
                // Remove delivered good from local tracking
                const goodIdx = carriedGoods.indexOf(
                    plan.deliveries[nextStop.deliveryIndex].good
                );
                if (goodIdx >= 0) carriedGoods.splice(goodIdx, 1);
            }
            simStopIndex++;
            continue; // Don't break — use remaining movement for next stop
        }

        // Can't do anything with 0 movement from here
        if (movementRemaining <= 0) break;

        // Step 2: Move toward nextStop
        const trackPath = findPathOnTrack(ctx, currentLoc, stopId, player.color, false);

        if (trackPath) {
            // 2a: Stop IS reachable on owned track — move along it
            const movePath = trackPath.path;
            // Limit path to available movement
            const stepsToTake = Math.min(movePath.length - 1, movementRemaining);
            const truncatedPath = movePath.slice(0, stepsToTake + 1);

            if (truncatedPath.length >= 2) {
                actions.push({ type: 'commitMove', path: truncatedPath });
                movementRemaining -= stepsToTake;
            }

            // Check if we arrived at the stop
            const arrivedAt = truncatedPath[truncatedPath.length - 1];
            if (arrivedAt === stopId) {
                continue; // Loop back to step 1 to handle pickup/delivery
            } else {
                break; // Ran out of movement
            }
        } else {
            // 2b: Stop NOT reachable — frontier movement (§3.3)
            const frontierPath = findFrontierPath(ctx, currentLoc, plan, player.color, simStopIndex);
            if (frontierPath && frontierPath.length >= 2) {
                const stepsToTake = Math.min(frontierPath.length - 1, movementRemaining);
                const truncatedPath = frontierPath.slice(0, stepsToTake + 1);
                if (truncatedPath.length >= 2) {
                    actions.push({ type: 'commitMove', path: truncatedPath });
                    movementRemaining -= stepsToTake;
                }
            }
            break; // Can't make further progress until track is extended
        }
    }

    // Note: plan completion is handled by the server — as each pickup/deliver
    // action succeeds, currentStopIndex advances. When planOperate is called
    // next turn and currentStopIndex >= visitSequence.length, the plan is done.

    actions.push({ type: 'endOperatePhase' });
    return actions;
}

// ---------------------------------------------------------------------------
// §3.3 — Frontier movement helpers
// ---------------------------------------------------------------------------

// Find the path to the frontier milepost — the farthest milepost on owned
// track that is on the planned build path AND reachable from the train's
// current position (same connected component).
// Fallback: closest reachable milepost to the network attachment point.
function findFrontierPath(ctx, currentLoc, plan, playerColor, simStopIndex) {
    // Get reachable mileposts from current position (BFS on owned track)
    const reachable = getConnectedComponent(ctx, currentLoc, playerColor);
    if (reachable.size <= 1) return null;

    // Find the farthest reachable milepost on the build path that is
    // CLOSER to the next stop than our current location. This prevents
    // picking the current location itself as the frontier (e.g., when
    // the AI is at the end of the buildPath but needs to go backward
    // toward an earlier stop like a pickup city).
    const buildPathSet = new Set(plan.buildPath);

    // Find where the next stop is on the buildPath.
    // Use simStopIndex (the movement loop's simulated position) when provided,
    // falling back to plan.currentStopIndex (the committed position).
    const stopIdx = simStopIndex !== undefined ? simStopIndex : plan.currentStopIndex;
    const nextStop = plan.visitSequence[stopIdx];
    const nextStopId = nextStop ? ctx.cityToMilepost[nextStop.city] : null;
    let nextStopBuildIdx = -1;
    if (nextStopId) {
        for (let i = 0; i < plan.buildPath.length; i++) {
            if (plan.buildPath[i] === nextStopId) { nextStopBuildIdx = i; break; }
        }
    }

    let bestFrontier = null;
    let bestIdx = -1;

    if (nextStopBuildIdx >= 0) {
        // Search from the next stop backward toward current location —
        // find the farthest reachable point toward the next stop.
        // If the current location IS the closest reachable point (frontier),
        // return null — the AI is already at the frontier and should wait
        // for track to be built, not oscillate backward.
        for (let i = nextStopBuildIdx; i >= 0; i--) {
            const mpId = plan.buildPath[i];
            if (reachable.has(mpId)) {
                if (mpId === currentLoc) {
                    // Already at the frontier — nowhere useful to move
                    return null;
                }
                bestFrontier = mpId;
                bestIdx = i;
                break;
            }
        }
    }

    // Fallback: search from end of buildPath backward (original behavior)
    if (!bestFrontier) {
        for (let i = plan.buildPath.length - 1; i >= 0; i--) {
            const mpId = plan.buildPath[i];
            if (reachable.has(mpId) && buildPathSet.has(mpId) && mpId !== currentLoc) {
                bestFrontier = mpId;
                bestIdx = i;
                break;
            }
        }
    }

    // Fallback: closest reachable milepost to the network attachment point
    if (!bestFrontier) {
        // Network attachment point: first milepost on buildPath that's in reachable set
        let attachmentPoint = null;
        for (const mpId of plan.buildPath) {
            if (reachable.has(mpId)) {
                attachmentPoint = mpId;
                break;
            }
        }
        if (!attachmentPoint) {
            // No overlap — find closest reachable milepost (Euclidean) to first buildPath milepost
            const targetMp = ctx.mileposts_by_id[plan.buildPath[0]];
            if (!targetMp) return null;
            let closestDist = Infinity;
            for (const mpId of reachable) {
                const mp = ctx.mileposts_by_id[mpId];
                if (!mp) continue;
                const dist = Math.hypot(mp.x - targetMp.x, mp.y - targetMp.y);
                if (dist < closestDist) {
                    closestDist = dist;
                    attachmentPoint = mpId;
                }
            }
        }
        bestFrontier = attachmentPoint;
    }

    if (!bestFrontier || bestFrontier === currentLoc) return null;

    // Find track path from current location to frontier milepost
    const pathResult = findPathOnTrack(ctx, currentLoc, bestFrontier, playerColor, false);
    return pathResult ? pathResult.path : null;
}

// BFS to find all mileposts reachable from a start milepost on owned track.
function getConnectedComponent(ctx, startMpId, playerColor) {
    const component = new Set([startMpId]);
    const queue = [startMpId];
    // Build adjacency from owned track
    const adj = {};
    for (const t of ctx.tracks) {
        if (t.color !== playerColor) continue;
        if (!adj[t.from]) adj[t.from] = [];
        if (!adj[t.to]) adj[t.to] = [];
        adj[t.from].push(t.to);
        adj[t.to].push(t.from);
    }
    while (queue.length > 0) {
        const current = queue.shift();
        for (const neighbor of (adj[current] || [])) {
            if (!component.has(neighbor)) {
                component.add(neighbor);
                queue.push(neighbor);
            }
        }
    }
    return component;
}

// ---------------------------------------------------------------------------
// §3.4 — Supply exhaustion
// ---------------------------------------------------------------------------

// Check whether a good is available (not all chips in circulation).
function isGoodAvailable(gs, good, localCarriedGoods) {
    const goodData = GOODS[good];
    if (!goodData) return false;

    // Count goods in circulation across all players
    let inCirculation = 0;
    for (const p of gs.players) {
        for (const load of p.loads) {
            if (load === good) inCirculation++;
        }
    }
    // Also count goods we've locally "picked up" but not yet in game state
    for (const load of localCarriedGoods) {
        if (load === good && !gs.players.some(p => p.loads.includes(good))) {
            // Only count if not already counted in player loads
        }
    }

    return inCirculation < goodData.chips;
}

// Handle supply exhaustion: abandon plan, create residual plan if carrying.
function handleSupplyExhaustion(gs, playerIndex, plan, carriedGoods) {
    // Check if we're carrying goods relevant to the plan
    const planGoods = plan.deliveries.map(d => d.good);
    const carriedPlanGoods = carriedGoods.filter(g => planGoods.includes(g));

    if (carriedPlanGoods.length > 0) {
        // Create residual single-delivery plan for the first carried good
        const carriedGood = carriedPlanGoods[0];
        const delivery = plan.deliveries.find(d => d.good === carriedGood);
        if (delivery) {
            const residualPlan = {
                majorCity: null,
                deliveries: [{ ...delivery }],
                visitSequence: [
                    {
                        city: delivery.destCity,
                        action: 'deliver',
                        deliveryIndex: 0,
                        cardIndex: delivery.cardIndex,
                        demandIndex: delivery.demandIndex
                    }
                ],
                segments: [
                    { from: '(current)', to: delivery.destCity, buildCost: 0, cumCashAfter: null }
                ],
                totalBuildCost: 0,
                totalPayout: delivery.payout,
                totalBuildTurns: 0,
                operateTurns: 0,
                estimatedTurns: 0,
                ecuPerTurn: 0,
                buildPath: plan.buildPath,
                tripDistance: 0,
                currentStopIndex: 0
            };
            const aiState = getAIState(gs.players[playerIndex]);
            aiState.committedPlan = residualPlan;
            return;
        }
    }

    // Not carrying anything relevant — clean abandon
    clearCommittedPlan(gs, playerIndex);
}

// ---------------------------------------------------------------------------
// §8.1–§8.2 — checkEndgame
// ---------------------------------------------------------------------------

// Get major cities connected to the player's largest connected component.
function getConnectedMajorCities(ctx, playerColor) {
    const ownedMps = getPlayerOwnedMileposts(ctx, playerColor);
    if (ownedMps.size === 0) return [];

    // Find largest connected component
    const visited = new Set();
    let largestComponent = null;
    for (const mpId of ownedMps) {
        if (visited.has(mpId)) continue;
        const comp = getConnectedComponent(ctx, mpId, playerColor);
        for (const id of comp) visited.add(id);
        if (!largestComponent || comp.size > largestComponent.size) {
            largestComponent = comp;
        }
    }
    if (!largestComponent) return [];

    // Find major cities on the largest component
    const connected = [];
    for (const majorCity of MAJOR_CITIES) {
        const mpId = ctx.cityToMilepost[majorCity];
        if (mpId && largestComponent.has(mpId)) {
            connected.push(majorCity);
        }
    }
    return connected;
}

// Compute the build cost to connect an unconnected major city to the player's
// network, building OUT of the major city (§2.4).
function computeMajorCityConnectionCost(ctx, playerColor, majorCity) {
    const majorId = ctx.cityToMilepost[majorCity];
    if (!majorId) return Infinity;

    const ownedMps = getPlayerOwnedMileposts(ctx, playerColor);
    if (ownedMps.size === 0) return Infinity;

    // Find cheapest path from the major city to any owned milepost
    // (building OUT from major city = start pathfinding from major city)
    let bestCost = Infinity;
    const ownedCities = [];
    for (const mpId of ownedMps) {
        const mp = ctx.mileposts_by_id[mpId];
        if (mp && mp.city) ownedCities.push(mpId);
    }
    const targets = ownedCities.length > 0 ? ownedCities : [...ownedMps].slice(0, 10);

    for (const targetId of targets) {
        const result = findPath(ctx, majorId, targetId, playerColor, 'cheapest');
        if (result && result.cost < bestCost) {
            bestCost = result.cost;
        }
    }
    return bestCost;
}

// Get the cheapest unconnected major cities and their total connection cost.
// Returns { citiesNeeded, totalCost, connections: [{city, cost}] }.
function getUnconnectedMajorCityCosts(ctx, player, gs) {
    const settings = gs.gameSettings || { winMajorCitiesRequired: 7 };
    const connected = getConnectedMajorCities(ctx, player.color);
    const citiesNeeded = Math.max(0, settings.winMajorCitiesRequired - connected.length);
    if (citiesNeeded === 0) return { citiesNeeded: 0, totalCost: 0, connections: [] };

    // Compute connection cost for each unconnected major city
    const unconnected = MAJOR_CITIES.filter(c => !connected.includes(c));
    const costs = unconnected.map(city => ({
        city,
        cost: computeMajorCityConnectionCost(ctx, player.color, city)
    })).filter(c => c.cost < Infinity);

    // Sort by cost (cheapest first) and take citiesNeeded
    costs.sort((a, b) => a.cost - b.cost);
    const needed = costs.slice(0, citiesNeeded);
    const totalCost = needed.reduce((sum, c) => sum + c.cost, 0);

    return { citiesNeeded, totalCost, connections: needed };
}

// Check and set endgame mode. Called during plan selection and build phase.
// §8.1: endgame triggers when player.cash + netPayout >= winCashThreshold
// for any candidate plan. The flag persists once set.
function checkEndgame(gs, playerIndex, ctx) {
    const player = gs.players[playerIndex];
    const aiState = getAIState(player);

    // Already in endgame — never unset
    if (aiState.endgameMode) return true;

    const plan = getCommittedPlan(gs, playerIndex);
    if (!plan) return false;

    const settings = gs.gameSettings || { winCashThreshold: 250 };
    const debtDeductions = Math.min(
        player.debtRemaining || 0,
        plan.deliveries.length * 10
    );
    const netPayout = plan.totalPayout - debtDeductions;

    if (player.cash + netPayout >= settings.winCashThreshold) {
        aiState.endgameMode = true;
        return true;
    }

    return false;
}

// ---------------------------------------------------------------------------
// §1.6, §6.2.1 — shouldAbandon
// ---------------------------------------------------------------------------

// Check whether the committed plan should be abandoned. Returns true if any
// abandonment trigger fires.
//
// Triggers:
// 1. Cargo integrity failure — expected carried goods missing (§6.2.1 derailment)
// 2. Supply exhaustion for next pickup
// 3. Flood made plan unaffordable (re-check §1.3 with remaining segments)
// 4. Stuck 3+ turns with no progress
function shouldAbandon(gs, playerIndex, ctx, plan) {
    const player = gs.players[playerIndex];
    const aiState = getAIState(player);

    // 1. Cargo integrity check: verify expected carried goods are present
    // For each pickup stop already visited (index < currentStopIndex with action=pickup),
    // the corresponding good must be in player.loads — unless a delivery stop for
    // that good has also been visited.
    for (let i = 0; i < plan.currentStopIndex; i++) {
        const stop = plan.visitSequence[i];
        if (stop.action !== 'pickup') continue;

        // Check if a delivery for this good was already completed
        const delivery = plan.deliveries[stop.deliveryIndex];
        let delivered = false;
        for (let j = i + 1; j < plan.currentStopIndex; j++) {
            const laterStop = plan.visitSequence[j];
            if (laterStop.action === 'deliver' && laterStop.deliveryIndex === stop.deliveryIndex) {
                delivered = true;
                break;
            }
        }
        if (delivered) continue;

        // Good should be in player's cargo
        if (!player.loads.includes(delivery.good)) {
            // §7.5 Abandonment logging
            logDecision(playerIndex, 'plan abandoned',
                `Reason: cargo integrity (${delivery.good} missing). ` +
                `Previous plan: ${formatPlanSummary(plan)}. Carrying: [${player.loads}]`
            );
            // Cargo integrity failure — good was lost (derailment or other)
            // Create residual plan if carrying other goods
            const carriedPlanGoods = player.loads.filter(g =>
                plan.deliveries.some(d => d.good === g)
            );
            if (carriedPlanGoods.length > 0) {
                // Find the delivery for the first carried good
                const carriedGood = carriedPlanGoods[0];
                const carriedDelivery = plan.deliveries.find(d => d.good === carriedGood);
                if (carriedDelivery) {
                    const residualPlan = {
                        majorCity: null,
                        deliveries: [{ ...carriedDelivery }],
                        visitSequence: [{
                            city: carriedDelivery.destCity,
                            action: 'deliver',
                            deliveryIndex: 0,
                            cardIndex: carriedDelivery.cardIndex,
                            demandIndex: carriedDelivery.demandIndex
                        }],
                        segments: [{ from: '(current)', to: carriedDelivery.destCity, buildCost: 0, cumCashAfter: null }],
                        totalBuildCost: 0,
                        totalPayout: carriedDelivery.payout,
                        totalBuildTurns: 0,
                        operateTurns: 0,
                        estimatedTurns: 0,
                        ecuPerTurn: 0,
                        buildPath: plan.buildPath,
                        tripDistance: 0,
                        currentStopIndex: 0
                    };
                    aiState.committedPlan = residualPlan;
                }
            }
            return true;
        }
    }

    // 2. Supply exhaustion or capacity overflow for next pickup
    if (plan.currentStopIndex < plan.visitSequence.length) {
        const nextStop = plan.visitSequence[plan.currentStopIndex];
        if (nextStop.action === 'pickup') {
            if (!isGoodAvailable(gs, nextStop.good, player.loads)) {
                // Handle via handleSupplyExhaustion (creates residual if carrying)
                handleSupplyExhaustion(gs, playerIndex, plan, player.loads);
                return true;
            }
            // Note: capacity overflow is handled in planMovement, which drops
            // irrelevant goods or abandons if all goods are needed.
        }
    }

    // 3. Flood/tax affordability re-check (§6.2.3, §6.2.6)
    // Mid-execution: only check remaining segments from currentStopIndex forward.
    // Uses the same sequential checkpoint logic as checkAffordability —
    // for batch plans, mid-plan delivery payouts replenish cash.
    if (!checkRemainingAffordability(gs, playerIndex, ctx, plan)) {
        logDecision(playerIndex, 'plan abandoned',
            `Reason: unaffordable remaining segments (cash=${player.cash}M). ` +
            `Previous plan: ${formatPlanSummary(plan)}`
        );
        return true;
    }

    // 4. Foreign track blocks build path — opponent built on our planned route.
    //    Rebuild the path around foreign track instead of abandoning the plan,
    //    so carried goods and delivery targets are preserved.
    if (plan.buildPath && plan.buildPath.length >= 2) {
        const foreignEdges = new Set();
        for (const t of gs.tracks) {
            if (t.color !== player.color) {
                foreignEdges.add(t.from + '|' + t.to);
                foreignEdges.add(t.to + '|' + t.from);
            }
        }
        let blocked = false;
        for (let i = 0; i < plan.buildPath.length - 1; i++) {
            const edgeKey = plan.buildPath[i] + '|' + plan.buildPath[i + 1];
            if (foreignEdges.has(edgeKey)) {
                blocked = true;
                break;
            }
        }
        if (blocked) {
            const newPath = rebuildPlanPath(ctx, player, plan);
            if (newPath) {
                plan.buildPath = newPath;
                plan.totalBuildCost = recomputeBuildCost(ctx, player, newPath);
                logDecision(playerIndex, 'build path rerouted',
                    `Foreign track blocked planned route — rebuilt path around it (new cost: ${plan.totalBuildCost}M). ` +
                    `Plan: ${formatPlanSummary(plan)}`
                );
                // Re-check affordability with the new (potentially more expensive) route
                if (!checkRemainingAffordability(gs, playerIndex, ctx, plan)) {
                    logDecision(playerIndex, 'plan abandoned',
                        `Reason: rerouted path unaffordable (new cost: ${plan.totalBuildCost}M, cash: ${player.cash}M). ` +
                        `Previous plan: ${formatPlanSummary(plan)}`
                    );
                    return true;
                }
            } else {
                // Can't route around — abandon plan
                logDecision(playerIndex, 'plan abandoned',
                    `Reason: build path blocked by foreign track and no alternative route found. ` +
                    `Previous plan: ${formatPlanSummary(plan)}`
                );
                return true;
            }
        }
    }

    // 5. Stuck counter — 3+ turns with no progress
    if (aiState.stuckTurnCounter >= 3) {
        logDecision(playerIndex, 'plan abandoned',
            `Reason: stuck ${aiState.stuckTurnCounter}+ turns (cash=${player.cash}M). ` +
            `Previous plan: ${formatPlanSummary(plan)}. stopIdx=${plan.currentStopIndex}/${plan.visitSequence.length}. ` +
            `Carrying: [${player.loads}]`
        );
        aiState.stuckTurnCounter = 0;
        aiState.stuckAbandoned = true; // Signal planOperate to discard instead of reselect
        return true;
    }

    return false;
}

// Update stuck counter based on whether progress was made this turn.
// Called at the end of each turn (should be called by server integration).
// Progress = built track, picked up, delivered, or moved closer to target.
function updateStuckCounter(gs, playerIndex, ctx, progressMade) {
    const aiState = getAIState(gs.players[playerIndex]);
    if (progressMade) {
        aiState.stuckTurnCounter = 0;
    } else {
        aiState.stuckTurnCounter++;
    }
}

// ---------------------------------------------------------------------------
// §11.3.1 — planTurn (initial building only)
// ---------------------------------------------------------------------------

function planTurn(gs, playerIndex, ctx, strategy) {
    strategy = strategy || module.exports;

    let plan = getCommittedPlan(gs, playerIndex);
    if (!plan) {
        plan = strategy.selectPlan(gs, playerIndex, ctx);
        if (!plan) return [{ type: 'endTurn' }];
        commitPlan(gs, playerIndex, plan);
    }

    const majorCity = strategy.selectMajorCity(gs, playerIndex, ctx, plan);
    const buildActions = strategy.computeBuildOrder(gs, playerIndex, ctx, plan, majorCity);
    return [...buildActions, { type: 'endTurn' }];
}

// ---------------------------------------------------------------------------
// §11.3.2 — planOperate (operate phase)
// ---------------------------------------------------------------------------

function planOperate(gs, playerIndex, ctx, strategy) {
    strategy = strategy || module.exports;
    let plan = getCommittedPlan(gs, playerIndex);

    if (plan) {
        if (strategy.shouldAbandon(gs, playerIndex, ctx, plan)) {
            const wasStuck = getAIState(gs.players[playerIndex]).stuckAbandoned;
            clearCommittedPlan(gs, playerIndex);
            plan = getCommittedPlan(gs, playerIndex); // residual plan if any
            // If abandoned due to being stuck (not cargo/supply/affordability),
            // discard to get fresh cards instead of reselecting the same plan.
            if (wasStuck && !plan && gs.players[playerIndex].loads.length === 0) {
                getAIState(gs.players[playerIndex]).stuckAbandoned = false;
                return [{ type: 'discardHand' }];
            }
        } else {
            return strategy.planMovement(gs, playerIndex, ctx, plan);
        }
    }

    if (!plan) {
        plan = strategy.selectPlan(gs, playerIndex, ctx);
    }

    if (!plan) {
        return strategy.handleNoPlan(gs, playerIndex, ctx, strategy);
    }

    if (strategy.shouldDiscard(gs, playerIndex, ctx, plan)) {
        return [{ type: 'discardHand' }];
    }

    commitPlan(gs, playerIndex, plan);
    return strategy.planMovement(gs, playerIndex, ctx, plan);
}

// ---------------------------------------------------------------------------
// §11.3.3 — planBuild (build phase)
// ---------------------------------------------------------------------------

function planBuild(gs, playerIndex, ctx, strategy) {
    strategy = strategy || module.exports;
    let plan = getCommittedPlan(gs, playerIndex);

    if (!plan) {
        // No committed plan (completed mid-turn or discarded). Try to select
        // a new plan so we can build toward it instead of wasting the build phase.
        plan = strategy.selectPlan(gs, playerIndex, ctx);
        if (plan) {
            commitPlan(gs, playerIndex, plan);
        } else {
            const buildActions = strategy.computeBuildOrder(gs, playerIndex, ctx, null);
            return [...buildActions, { type: 'endTurn' }];
        }
    }

    const upgradeResult = strategy.shouldUpgrade(gs, playerIndex, ctx);
    if (upgradeResult) {
        // shouldUpgrade returns true (Hard AI) or a train type string (Brutal AI)
        const trainType = typeof upgradeResult === 'string' ? upgradeResult : 'Fast Freight';
        return [{ type: 'upgradeTo', trainType }, { type: 'endTurn' }];
    }

    const buildActions = strategy.computeBuildOrder(gs, playerIndex, ctx, plan);
    return [...buildActions, { type: 'endTurn' }];
}

// ---------------------------------------------------------------------------
// Exports — strategy pattern (§11.1)
// ---------------------------------------------------------------------------

module.exports = {
    // Core decision functions (Brutal AI overrides these)
    enumeratePlans,
    scorePlan,
    checkAffordability,
    selectPlan,
    shouldDiscard,
    handleNoPlan,
    shouldUpgrade,
    computeBuildOrder,
    planMovement,
    selectMajorCity,
    checkEndgame,
    shouldAbandon,

    // Turn orchestration (shared across difficulties, NOT overridden)
    planTurn,
    planOperate,
    planBuild,

    // Internal helpers (exported for testing)
    findCheapestBuildPath,
    getAIState,
    getCommittedPlan,
    commitPlan,
    clearCommittedPlan,
    buildSinglePlan,
    findCheapestBuildPathFromNetwork,
    combinePaths,
    getPathDistance,
    getCityNameAt,
    canStartBuildFrom,
    extractSegmentPath,
    getConnectedComponent,
    findFrontierPath,
    isGoodAvailable,
    handleSupplyExhaustion,
    computeRemainingBuildCost,
    pointToSegmentDistance,
    passesBatchPruning,
    buildBatchPlan,
    BATCH_VISIT_SEQUENCES,
    updateStuckCounter,
    isStrikeBlockingCity,
    isRailClosureActive,
    computeRemainingBuildCostFromIndex,
    getConnectedMajorCities,
    computeMajorCityConnectionCost,
    getUnconnectedMajorCityCosts,
    buildEndgameCityConnections,
    logDecision,
    formatPlanSummary,
    checkRemainingAffordability
};
