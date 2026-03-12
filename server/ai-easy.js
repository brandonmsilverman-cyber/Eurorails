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
function selectTargetDemand(gs, playerIndex, ctx, { excludeFullyBuilt = false } = {}) {
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

                // Skip routes that are already fully built (nothing to build)
                if (excludeFullyBuilt && result.cost === 0) continue;

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
function computeBuildActions(gs, playerIndex, ctx, fullPathResult, reversed = false) {
    const player = gs.players[playerIndex];
    const fullPath = fullPathResult.path;

    // Build owned edge and milepost sets
    const ownedEdges = new Set();
    const ownedMileposts = new Set();
    for (const t of gs.tracks) {
        if (t.color === player.color) {
            ownedEdges.add(t.from + "|" + t.to);
            ownedEdges.add(t.to + "|" + t.from);
            ownedMileposts.add(t.from);
            ownedMileposts.add(t.to);
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

    // Helper: check if a milepost is a valid build origin (owned track or major city)
    function canStartFrom(mpId) {
        if (ownedMileposts.has(mpId)) return true;
        const mp = ctx.mileposts_by_id[mpId];
        return mp && mp.city && MAJOR_CITIES.includes(mp.city.name);
    }

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
                if (!canStartFrom(from)) continue; // skip — invalid build origin
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
            if (!canStartFrom(from)) continue; // skip — invalid build origin
            buildPath.push(from);
            started = true;
        }
        buildPath.push(to);
        buildCost += segCost;
        majorCityCount += majorCities;
    }

    if (buildPath.length < 2 || buildCost === 0) {
        // Forward walk failed — try reverse (owned track may be at end of path)
        if (!reversed) {
            const reversedResult = { path: [...fullPath].reverse(), cost: fullPathResult.cost };
            return computeBuildActions(gs, playerIndex, ctx, reversedResult, true);
        }
        return null;
    }

    return { buildPath, buildCost, majorCityCount, ferries };
}

// Helper: when the src→dest path doesn't intersect owned track, find a path
// from the nearest owned milepost to either src or dest and build along it.
function findConnectorBuild(gs, playerIndex, ctx, srcId, destId) {
    const player = gs.players[playerIndex];
    const ownedMileposts = getPlayerOwnedMileposts(ctx, player.color);
    if (ownedMileposts.size === 0) return null;

    // Find path from owned city mileposts to src or dest, pick cheapest
    const ownedCities = [];
    for (const mpId of ownedMileposts) {
        const mp = ctx.mileposts_by_id[mpId];
        if (mp && mp.city) ownedCities.push(mpId);
    }
    // If no owned cities, use train location or any owned milepost
    if (ownedCities.length === 0) {
        if (player.trainLocation && ownedMileposts.has(player.trainLocation)) {
            ownedCities.push(player.trainLocation);
        } else {
            ownedCities.push(ownedMileposts.values().next().value);
        }
    }

    let bestPath = null;
    let bestCost = Infinity;
    for (const ownedId of ownedCities) {
        for (const goalId of [srcId, destId]) {
            if (goalId === undefined || goalId === ownedId) continue;
            const result = findPath(ctx, ownedId, goalId, player.color, "cheapest");
            if (result && result.cost > 0 && result.cost < bestCost) {
                bestCost = result.cost;
                bestPath = result;
            }
        }
    }

    if (!bestPath) return null;
    return computeBuildActions(gs, playerIndex, ctx, bestPath);
}

// Helper: BFS to find all mileposts in the same connected component of owned track.
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

// Helper: find the best milepost on owned track to deploy the train.
// Prefers a city milepost that is a source for a demand good, on the
// connected component that contains the target route's source or destination.
function chooseDeploy(gs, playerIndex, ctx, target) {
    const player = gs.players[playerIndex];
    const ownedMileposts = getPlayerOwnedMileposts(ctx, player.color);

    if (ownedMileposts.size === 0) return null;

    // If we have a target, find the component connected to the target's source/dest
    let preferredComponent = null;
    if (target) {
        const srcId = ctx.cityToMilepost[target.sourceCity];
        const destId = ctx.cityToMilepost[target.destCity];
        if (srcId && ownedMileposts.has(srcId)) {
            preferredComponent = getConnectedComponent(ctx, srcId, player.color);
        } else if (destId && ownedMileposts.has(destId)) {
            preferredComponent = getConnectedComponent(ctx, destId, player.color);
        }
    }

    // If no preferred component found, use the largest connected component
    if (!preferredComponent) {
        const visited = new Set();
        let largest = null;
        for (const mpId of ownedMileposts) {
            if (visited.has(mpId)) continue;
            const comp = getConnectedComponent(ctx, mpId, player.color);
            comp.forEach(id => visited.add(id));
            if (!largest || comp.size > largest.size) {
                largest = comp;
            }
        }
        preferredComponent = largest;
    }

    // Collect source cities from current demands
    const wantedSources = new Set();
    for (const card of player.demandCards) {
        if (!card || !card.demands) continue;
        for (const demand of card.demands) {
            const sources = GOODS[demand.good] ? GOODS[demand.good].sources : [];
            for (const src of sources) wantedSources.add(src);
        }
    }

    // Prefer source city on preferred component
    for (const mpId of preferredComponent) {
        const mp = ctx.mileposts_by_id[mpId];
        if (mp.city && wantedSources.has(mp.city.name)) {
            return mpId;
        }
    }

    // Fallback: any city on preferred component
    for (const mpId of preferredComponent) {
        const mp = ctx.mileposts_by_id[mpId];
        if (mp.city) return mpId;
    }

    // Fallback: any milepost on preferred component
    return preferredComponent.values().next().value;
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
        // Select target demand, excluding routes already fully built
        const target = selectTargetFromState(gs, playerIndex, ctx, { excludeFullyBuilt: true });
        if (!target) {
            actions.push({ type: 'endTurn' });
            return actions;
        }

        const srcId = ctx.cityToMilepost[target.sourceCity];
        const destId = ctx.cityToMilepost[target.destCity];
        const hasTrack = gs.tracks.some(t => t.color === player.color);

        let buildAction = null;

        if (!hasTrack) {
            // First build: must start from a major city.
            // Find the cheapest route from any major city toward source or dest.
            let bestPath = null;
            let bestCost = Infinity;
            for (const majorCity of MAJOR_CITIES) {
                const majorId = ctx.cityToMilepost[majorCity];
                if (majorId === undefined) continue;
                for (const goalId of [srcId, destId]) {
                    if (goalId === undefined || goalId === majorId) continue;
                    const result = findPath(ctx, majorId, goalId, player.color, "cheapest");
                    if (result && result.cost < bestCost) {
                        bestCost = result.cost;
                        bestPath = result;
                    }
                }
            }
            if (bestPath) {
                buildAction = computeBuildActions(gs, playerIndex, ctx, bestPath);
            }
        } else {
            // Subsequent builds: extend from existing track toward target
            const fullPath = findPath(ctx, srcId, destId, player.color, "cheapest");
            if (fullPath) {
                buildAction = computeBuildActions(gs, playerIndex, ctx, fullPath);
            }
            // Fallback: build connector from owned track toward src or dest
            if (!buildAction) {
                buildAction = findConnectorBuild(gs, playerIndex, ctx, srcId, destId);
            }
        }

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

        // Select target first so deploy can use it for component preference
        const target = selectTargetFromState(gs, playerIndex, ctx);
        if (!target) {
            actions.push({ type: 'endOperatePhase' });
            return actions;
        }

        // Deploy train if not deployed
        let effectiveLocation = player.trainLocation;
        if (player.trainLocation === null) {
            const deployId = chooseDeploy(gs, playerIndex, ctx, target);
            if (deployId) {
                actions.push({ type: 'deployTrain', milepostId: deployId });
                effectiveLocation = deployId;
            } else {
                actions.push({ type: 'endOperatePhase' });
                return actions;
            }
        }

        const currentCity = getCityNameAt(ctx, effectiveLocation);

        // If carrying the target good and at destination, deliver
        if (player.loads.includes(target.good) && currentCity === target.destCity) {
            actions.push({ type: 'deliverGood', cardIndex: target.cardIndex, demandIndex: target.demandIndex });
            actions.push({ type: 'endOperatePhase' });
            return actions;
        }

        // If carrying the target good, move toward destination
        if (player.loads.includes(target.good)) {
            const destId = ctx.cityToMilepost[target.destCity];
            const trackPath = findPathOnTrack(ctx, effectiveLocation, destId, player.color, false);
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
            const trackPath = findPathOnTrack(ctx, effectiveLocation, destId, player.color, false);
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
        const trackPath = findPathOnTrack(ctx, effectiveLocation, srcId, player.color, false);
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
            let buildAction = null;

            // First try: build along the src→dest path
            const fullPath = findPath(ctx, srcId, destId, player.color, "cheapest");
            if (fullPath) {
                buildAction = computeBuildActions(gs, playerIndex, ctx, fullPath);
            }

            // Fallback: if src→dest path doesn't connect to owned track,
            // build a connector from owned track toward src or dest
            if (!buildAction) {
                buildAction = findConnectorBuild(gs, playerIndex, ctx, srcId, destId);
            }

            if (buildAction) {
                actions.push({ type: 'commitBuild', ...buildAction });
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
function selectTargetFromState(gs, playerIndex, ctx, { excludeFullyBuilt = false } = {}) {
    const player = gs.players[playerIndex];
    const aiState = player.aiState;

    // Check if current target is still valid
    if (aiState && aiState.targetCardIndex !== null && aiState.targetDemandIndex !== null) {
        const card = player.demandCards[aiState.targetCardIndex];
        if (card && card.demands[aiState.targetDemandIndex]) {
            const demand = card.demands[aiState.targetDemandIndex];

            // If excluding fully-built routes, check if this route still needs building
            if (excludeFullyBuilt) {
                const srcId = ctx.cityToMilepost[aiState.targetSourceCity];
                const destId = ctx.cityToMilepost[demand.to];
                if (srcId && destId) {
                    const fullPath = findPath(ctx, srcId, destId, player.color, "cheapest");
                    if (fullPath && fullPath.cost === 0) {
                        // Route fully built — clear persisted target and pick a new one
                        aiState.targetCardIndex = null;
                        aiState.targetDemandIndex = null;
                        aiState.targetSourceCity = null;
                        // Fall through to select new target below
                    } else {
                        return {
                            cardIndex: aiState.targetCardIndex,
                            demandIndex: aiState.targetDemandIndex,
                            sourceCity: aiState.targetSourceCity,
                            destCity: demand.to,
                            good: demand.good
                        };
                    }
                }
            } else {
                return {
                    cardIndex: aiState.targetCardIndex,
                    demandIndex: aiState.targetDemandIndex,
                    sourceCity: aiState.targetSourceCity,
                    destCity: demand.to,
                    good: demand.good
                };
            }
        }
    }

    // Select new target
    const selected = selectTargetDemand(gs, playerIndex, ctx, { excludeFullyBuilt });
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
