// server/ai-easy.js
// Easy AI decision-making strategy module.
// All functions are pure — they read game state and pathfinding context,
// returning action descriptors or data. No side effects, no sockets.

const gl = require('../shared/game-logic');
const GOODS = gl.GOODS;
const TRAIN_TYPES = gl.TRAIN_TYPES;
const MAJOR_CITIES = gl.MAJOR_CITIES;
const findPath = gl.findPath;
const findPathOnTrack = gl.findPathOnTrack;
const getMileppostCost = gl.getMileppostCost;
const getFerryKey = gl.getFerryKey;
const getPlayerOwnedMileposts = gl.getPlayerOwnedMileposts;

// 3a: Greedy demand selection — picks whichever demand has the cheapest
// total build cost (source → destination). Owned track costs 0.
// Does NOT consider payout — key Easy AI weakness.
function selectTargetDemand(gs, playerIndex, ctx) {
    const player = gs.players[playerIndex];
    let best = null;
    let bestCost = Infinity;

    for (let ci = 0; ci < player.demandCards.length; ci++) {
        const card = player.demandCards[ci];
        if (!card || !card.demands) continue;
        for (let di = 0; di < card.demands.length; di++) {
            const demand = card.demands[di];
            const sources = GOODS[demand.good] ? GOODS[demand.good].sources : [];
            for (const sourceCity of sources) {
                const srcId = ctx.cityToMilepost[sourceCity];
                const destId = ctx.cityToMilepost[demand.to];
                if (srcId === undefined || destId === undefined) continue;

                const result = findPath(ctx, srcId, destId, player.color, "cheapest");
                if (!result) continue;

                if (result.cost < bestCost) {
                    bestCost = result.cost;
                    best = {
                        cardIndex: ci,
                        demandIndex: di,
                        sourceCity: sourceCity,
                        cost: result.cost
                    };
                }
            }
        }
    }

    return best;
}

// 3b: Returns the minimum cost to complete ANY single delivery on the
// current hand. Used by Layer 1 bankruptcy protection.
function computeReserveFloor(gs, playerIndex, ctx) {
    const player = gs.players[playerIndex];
    let minCost = Infinity;

    for (let ci = 0; ci < player.demandCards.length; ci++) {
        const card = player.demandCards[ci];
        if (!card || !card.demands) continue;
        for (let di = 0; di < card.demands.length; di++) {
            const demand = card.demands[di];
            const sources = GOODS[demand.good] ? GOODS[demand.good].sources : [];
            for (const sourceCity of sources) {
                const srcId = ctx.cityToMilepost[sourceCity];
                const destId = ctx.cityToMilepost[demand.to];
                if (srcId === undefined || destId === undefined) continue;

                const result = findPath(ctx, srcId, destId, player.color, "cheapest");
                if (result && result.cost < minCost) {
                    minCost = result.cost;
                }
            }
        }
    }

    return minCost === Infinity ? 0 : minCost;
}

// 3c: Stuck check — can the AI complete at least one delivery given
// current track + cash?
function isStuck(gs, playerIndex, ctx) {
    const player = gs.players[playerIndex];

    // Check if carrying a good that can be delivered on existing track
    if (player.loads.length > 0 && player.trainLocation) {
        for (let ci = 0; ci < player.demandCards.length; ci++) {
            const card = player.demandCards[ci];
            if (!card || !card.demands) continue;
            for (let di = 0; di < card.demands.length; di++) {
                const demand = card.demands[di];
                if (player.loads.includes(demand.good)) {
                    const destId = ctx.cityToMilepost[demand.to];
                    if (destId === undefined) continue;
                    const trackPath = findPathOnTrack(ctx, player.trainLocation, destId, player.color, false);
                    if (trackPath) return false;
                }
            }
        }
    }

    // Check if any delivery is completable (source reachable + dest reachable + can afford gap)
    for (let ci = 0; ci < player.demandCards.length; ci++) {
        const card = player.demandCards[ci];
        if (!card || !card.demands) continue;
        for (let di = 0; di < card.demands.length; di++) {
            const demand = card.demands[di];
            const sources = GOODS[demand.good] ? GOODS[demand.good].sources : [];
            for (const sourceCity of sources) {
                const srcId = ctx.cityToMilepost[sourceCity];
                const destId = ctx.cityToMilepost[demand.to];
                if (srcId === undefined || destId === undefined) continue;

                const result = findPath(ctx, srcId, destId, player.color, "cheapest");
                if (result && result.cost <= player.cash) {
                    return false;
                }
            }
        }
    }

    return true;
}

// 3c: Recovery plan when stuck. Returns array of action descriptors.
// Follows 4-priority sequence from plan.
function getRecoveryPlan(gs, playerIndex, ctx) {
    const player = gs.players[playerIndex];

    // Priority 1: Carrying a good that can be delivered on existing track
    if (player.loads.length > 0 && player.trainLocation) {
        for (let ci = 0; ci < player.demandCards.length; ci++) {
            const card = player.demandCards[ci];
            if (!card || !card.demands) continue;
            for (let di = 0; di < card.demands.length; di++) {
                const demand = card.demands[di];
                if (player.loads.includes(demand.good)) {
                    const destId = ctx.cityToMilepost[demand.to];
                    if (destId === undefined) continue;
                    const trackPath = findPathOnTrack(ctx, player.trainLocation, destId, player.color, false);
                    if (trackPath) {
                        const actions = [];
                        actions.push({ type: 'commitMove', path: trackPath.path });
                        actions.push({ type: 'deliverGood', cardIndex: ci, demandIndex: di });
                        return actions;
                    }
                }
            }
        }
    }

    // Priority 2: A good can be picked up and delivered entirely on existing track
    if (player.trainLocation) {
        for (let ci = 0; ci < player.demandCards.length; ci++) {
            const card = player.demandCards[ci];
            if (!card || !card.demands) continue;
            for (let di = 0; di < card.demands.length; di++) {
                const demand = card.demands[di];
                const sources = GOODS[demand.good] ? GOODS[demand.good].sources : [];
                for (const sourceCity of sources) {
                    const srcId = ctx.cityToMilepost[sourceCity];
                    const destId = ctx.cityToMilepost[demand.to];
                    if (srcId === undefined || destId === undefined) continue;

                    // Can we reach source on track?
                    const toSource = findPathOnTrack(ctx, player.trainLocation, srcId, player.color, false);
                    if (!toSource) continue;
                    // Can we reach dest from source on track?
                    const toDest = findPathOnTrack(ctx, srcId, destId, player.color, false);
                    if (!toDest) continue;

                    const actions = [];
                    actions.push({ type: 'commitMove', path: toSource.path });
                    actions.push({ type: 'pickupGood', good: demand.good });
                    actions.push({ type: 'commitMove', path: toDest.path });
                    actions.push({ type: 'deliverGood', cardIndex: ci, demandIndex: di });
                    return actions;
                }
            }
        }
    }

    // Priority 3: Can build a short extension that connects source/dest
    // (Skip for now — Priority 3 is a refinement; Priority 4 handles the fallback)

    // Priority 4: Discard hand as last resort
    return [{ type: 'discardHand' }];
}

// Helper: compute the build path for AI given a full findPath result.
// Walks the path, finds unbuilt segments connecting to owned track,
// and accumulates segments within budget/cash/reserve constraints.
function computeBuildActions(gs, playerIndex, ctx, fullPathResult) {
    const player = gs.players[playerIndex];
    const fullPath = fullPathResult.path;

    // Build owned edge set
    const ownedEdges = new Set();
    for (const t of gs.tracks) {
        if (t.color === player.color) {
            ownedEdges.add(t.from + "|" + t.to);
            ownedEdges.add(t.to + "|" + t.from);
        }
    }

    // Build owned ferry set
    const ownedFerries = new Set();
    for (const fc of ctx.ferryConnections) {
        const fk = getFerryKey(fc.fromId, fc.toId);
        if (gl.playerOwnsFerry(ctx, fk, player.color)) {
            ownedFerries.add(fk);
        }
    }

    // Build set of ferry edge keys for lookup
    const ferryEdgeKeys = new Set();
    for (const fc of ctx.ferryConnections) {
        ferryEdgeKeys.add(getFerryKey(fc.fromId, fc.toId));
    }

    // Find the first unbuilt segment and accumulate from there
    const reserveFloor = computeReserveFloor(gs, playerIndex, ctx);
    const remainingBudget = 20 - gs.buildingThisTurn;
    const availableCash = player.cash - reserveFloor;

    if (availableCash <= 0 || remainingBudget <= 0) return null;

    let buildPath = [];
    let buildCost = 0;
    let majorCityCount = 0;
    let ferries = [];
    let started = false;

    for (let i = 0; i < fullPath.length - 1; i++) {
        const from = fullPath[i];
        const to = fullPath[i + 1];
        const edgeKey = from + "|" + to;
        const ferryKey = getFerryKey(from, to);
        const isFerry = ferryEdgeKeys.has(ferryKey);

        if (isFerry) {
            if (ownedFerries.has(ferryKey)) continue; // already own it

            // Compute ferry cost
            let ferryCost = 0;
            for (const fc of ctx.ferryConnections) {
                if (getFerryKey(fc.fromId, fc.toId) === ferryKey) {
                    ferryCost = fc.cost;
                    const destMp = ctx.mileposts_by_id[to];
                    if (destMp.city) {
                        ferryCost += MAJOR_CITIES.includes(destMp.city.name) ? 5 : 3;
                    }
                    break;
                }
            }

            if (buildCost + ferryCost > remainingBudget) break;
            if (buildCost + ferryCost > availableCash) break;

            if (!started) {
                buildPath.push(from);
                started = true;
            }
            buildPath.push(to);
            buildCost += ferryCost;
            ferries.push(ferryKey);
            continue;
        }

        if (ownedEdges.has(edgeKey)) {
            // Already own this segment — but we may need it to connect build path
            if (started) {
                // Don't add cost, but keep path contiguous
                buildPath.push(to);
            }
            continue;
        }

        // Unbuilt segment — compute cost
        const mp1 = ctx.mileposts_by_id[from];
        const mp2 = ctx.mileposts_by_id[to];
        const segCost = getMileppostCost(mp1, mp2);

        // Check major city limit
        let majorCities = 0;
        if (mp2.city && MAJOR_CITIES.includes(mp2.city.name)) {
            majorCities = 1;
        }
        if (gs.majorCitiesThisTurn + majorCityCount + majorCities > 2) break;

        if (buildCost + segCost > remainingBudget) break;
        if (buildCost + segCost > availableCash) break;

        if (!started) {
            buildPath.push(from);
            started = true;
        }
        buildPath.push(to);
        buildCost += segCost;
        majorCityCount += majorCities;
    }

    if (buildPath.length < 2 || buildCost === 0) return null;

    return { buildPath, buildCost, majorCityCount, ferries };
}

// Helper: find the best milepost on owned track to deploy the train.
// Prefers a city milepost that is a source for a demand good.
function chooseDeploy(gs, playerIndex, ctx) {
    const player = gs.players[playerIndex];
    const ownedMileposts = getPlayerOwnedMileposts(ctx, player.color);

    if (ownedMileposts.size === 0) return null;

    // Collect source cities from current demands
    const wantedSources = new Set();
    for (const card of player.demandCards) {
        if (!card || !card.demands) continue;
        for (const demand of card.demands) {
            const sources = GOODS[demand.good] ? GOODS[demand.good].sources : [];
            for (const src of sources) wantedSources.add(src);
        }
    }

    // Prefer source city on owned track
    for (const mpId of ownedMileposts) {
        const mp = ctx.mileposts_by_id[mpId];
        if (mp.city && wantedSources.has(mp.city.name)) {
            return mpId;
        }
    }

    // Fallback: any city on owned track
    for (const mpId of ownedMileposts) {
        const mp = ctx.mileposts_by_id[mpId];
        if (mp.city) return mpId;
    }

    // Fallback: any owned milepost
    return ownedMileposts.values().next().value;
}

// Helper: find the city name at a milepost (from ctx, not gs)
function getCityNameAt(ctx, milepostId) {
    for (const [cityName, mpId] of Object.entries(ctx.cityToMilepost)) {
        if (mpId === milepostId) return cityName;
    }
    return null;
}

// 3d: Main entry point. Returns array of action descriptors.
function planTurn(gs, playerIndex, ctx) {
    const player = gs.players[playerIndex];
    const actions = [];

    // --- Initial building phase ---
    if (gs.phase === 'initialBuilding') {
        // Select target demand
        const target = selectTargetFromState(gs, playerIndex, ctx);
        if (!target) {
            actions.push({ type: 'endTurn' });
            return actions;
        }

        // Compute full path from source to destination
        const srcId = ctx.cityToMilepost[target.sourceCity];
        const destId = ctx.cityToMilepost[target.destCity];
        const fullPath = findPath(ctx, srcId, destId, player.color, "cheapest");

        if (!fullPath) {
            actions.push({ type: 'endTurn' });
            return actions;
        }

        const buildAction = computeBuildActions(gs, playerIndex, ctx, fullPath);
        if (buildAction) {
            actions.push({ type: 'commitBuild', ...buildAction });
        }

        actions.push({ type: 'endTurn' });
        return actions;
    }

    // --- Operate phase ---
    if (gs.phase === 'operate') {
        // Layer 2: stuck check
        if (isStuck(gs, playerIndex, ctx)) {
            const recovery = getRecoveryPlan(gs, playerIndex, ctx);
            // If recovery is just discardHand, do it
            if (recovery.length === 1 && recovery[0].type === 'discardHand') {
                return recovery;
            }
            // Otherwise execute recovery actions then end operate
            actions.push(...recovery);
            actions.push({ type: 'endOperatePhase' });
            return actions;
        }

        // Deploy train if not deployed
        if (player.trainLocation === null) {
            const deployId = chooseDeploy(gs, playerIndex, ctx);
            if (deployId) {
                actions.push({ type: 'deployTrain', milepostId: deployId });
            }
            actions.push({ type: 'endOperatePhase' });
            return actions;
        }

        const target = selectTargetFromState(gs, playerIndex, ctx);
        if (!target) {
            actions.push({ type: 'endOperatePhase' });
            return actions;
        }

        const currentCity = getCityNameAt(ctx, player.trainLocation);

        // If carrying the target good and at destination, deliver
        if (player.loads.includes(target.good) && currentCity === target.destCity) {
            actions.push({ type: 'deliverGood', cardIndex: target.cardIndex, demandIndex: target.demandIndex });
            actions.push({ type: 'endOperatePhase' });
            return actions;
        }

        // If carrying the target good, move toward destination
        if (player.loads.includes(target.good)) {
            const destId = ctx.cityToMilepost[target.destCity];
            const trackPath = findPathOnTrack(ctx, player.trainLocation, destId, player.color, false);
            if (trackPath) {
                actions.push({ type: 'commitMove', path: trackPath.path });
                // Check if we arrived at destination
                const arrived = trackPath.path[trackPath.path.length - 1];
                const arrivedCity = getCityNameAt(ctx, arrived);
                if (arrivedCity === target.destCity) {
                    actions.push({ type: 'deliverGood', cardIndex: target.cardIndex, demandIndex: target.demandIndex });
                }
            }
            actions.push({ type: 'endOperatePhase' });
            return actions;
        }

        // If at source city, pick up
        if (currentCity === target.sourceCity) {
            actions.push({ type: 'pickupGood', good: target.good });
            // Try to move toward destination
            const destId = ctx.cityToMilepost[target.destCity];
            const trackPath = findPathOnTrack(ctx, player.trainLocation, destId, player.color, false);
            if (trackPath) {
                actions.push({ type: 'commitMove', path: trackPath.path });
                const arrived = trackPath.path[trackPath.path.length - 1];
                const arrivedCity = getCityNameAt(ctx, arrived);
                if (arrivedCity === target.destCity) {
                    actions.push({ type: 'deliverGood', cardIndex: target.cardIndex, demandIndex: target.demandIndex });
                }
            }
            actions.push({ type: 'endOperatePhase' });
            return actions;
        }

        // Move toward source city
        const srcId = ctx.cityToMilepost[target.sourceCity];
        const trackPath = findPathOnTrack(ctx, player.trainLocation, srcId, player.color, false);
        if (trackPath) {
            actions.push({ type: 'commitMove', path: trackPath.path });
            const arrived = trackPath.path[trackPath.path.length - 1];
            const arrivedCity = getCityNameAt(ctx, arrived);
            if (arrivedCity === target.sourceCity) {
                actions.push({ type: 'pickupGood', good: target.good });
            }
        }
        actions.push({ type: 'endOperatePhase' });
        return actions;
    }

    // --- Build phase (after operate) ---
    if (gs.phase === 'build') {
        // Train upgrade check: cash > 80 and haven't built yet this turn
        if (player.cash > 80 && gs.buildingThisTurn === 0) {
            const upgradeOrder = ['Freight', 'Fast Freight', 'Heavy Freight', 'Superfreight'];
            const currentIdx = upgradeOrder.indexOf(player.trainType);
            if (currentIdx >= 0 && currentIdx < upgradeOrder.length - 1) {
                // Upgrade to next tier
                const nextType = currentIdx === 0 ? 'Fast Freight' : 'Superfreight';
                actions.push({ type: 'upgradeTo', trainType: nextType });
            }
        }

        // Build toward target demand
        const target = selectTargetFromState(gs, playerIndex, ctx);
        if (target) {
            const srcId = ctx.cityToMilepost[target.sourceCity];
            const destId = ctx.cityToMilepost[target.destCity];
            const fullPath = findPath(ctx, srcId, destId, player.color, "cheapest");

            if (fullPath) {
                const buildAction = computeBuildActions(gs, playerIndex, ctx, fullPath);
                if (buildAction) {
                    actions.push({ type: 'commitBuild', ...buildAction });
                }
            }
        }

        actions.push({ type: 'endTurn' });
        return actions;
    }

    // Fallback
    actions.push({ type: 'endTurn' });
    return actions;
}

// Helper: select target demand, using persisted aiState if still valid.
// Returns { cardIndex, demandIndex, sourceCity, destCity, good } or null.
function selectTargetFromState(gs, playerIndex, ctx) {
    const player = gs.players[playerIndex];
    const aiState = player.aiState;

    // Check if current target is still valid
    if (aiState && aiState.targetCardIndex !== null && aiState.targetDemandIndex !== null) {
        const card = player.demandCards[aiState.targetCardIndex];
        if (card && card.demands[aiState.targetDemandIndex]) {
            const demand = card.demands[aiState.targetDemandIndex];
            return {
                cardIndex: aiState.targetCardIndex,
                demandIndex: aiState.targetDemandIndex,
                sourceCity: aiState.targetSourceCity,
                destCity: demand.to,
                good: demand.good
            };
        }
    }

    // Select new target
    const selected = selectTargetDemand(gs, playerIndex, ctx);
    if (!selected) return null;

    const card = player.demandCards[selected.cardIndex];
    const demand = card.demands[selected.demandIndex];

    // Persist to aiState
    if (aiState) {
        aiState.targetCardIndex = selected.cardIndex;
        aiState.targetDemandIndex = selected.demandIndex;
        aiState.targetSourceCity = selected.sourceCity;
    }

    return {
        cardIndex: selected.cardIndex,
        demandIndex: selected.demandIndex,
        sourceCity: selected.sourceCity,
        destCity: demand.to,
        good: demand.good
    };
}

module.exports = {
    selectTargetDemand,
    computeReserveFloor,
    isStuck,
    getRecoveryPlan,
    planTurn,
    computeBuildActions,
    selectTargetFromState
};
