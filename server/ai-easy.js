// server/ai-easy.js
// Easy AI decision-making strategy module.
// All functions are pure — they read game state and pathfinding context,
// returning action descriptors or data. No side effects, no sockets.

const gl = require('../shared/game-logic');
const GOODS = gl.GOODS;
const MAJOR_CITIES = gl.MAJOR_CITIES;
const findPath = gl.findPath;
const findPathOnTrack = gl.findPathOnTrack;
const getMileppostCost = gl.getMileppostCost;
const getFerryKey = gl.getFerryKey;
const getPlayerOwnedMileposts = gl.getPlayerOwnedMileposts;

// 3a: Demand selection — picks the demand with the best profit margin
// (payout - build cost) that the AI can afford. Strongly prefers affordable
// demands to avoid burning cash on unfinishable routes.
function selectTargetDemand(gs, playerIndex, ctx, { excludeFullyBuilt = false, excludeCardIndex = -1, excludeDemandIndex = -1 } = {}) {
    const player = gs.players[playerIndex];
    let bestAffordable = null;
    let bestAffordableScore = -Infinity;
    let bestUnaffordable = null;
    let bestUnaffordableCost = Infinity;

    // Precompute owned mileposts and owned city mileposts for connector cost checks
    const ownedMileposts = getPlayerOwnedMileposts(ctx, player.color);
    const ownedCities = [];
    for (const mpId of ownedMileposts) {
        const mp = ctx.mileposts_by_id[mpId];
        if (mp && mp.city) ownedCities.push(mpId);
    }
    // Fallback: train location or any owned milepost
    if (ownedCities.length === 0 && ownedMileposts.size > 0) {
        if (player.trainLocation && ownedMileposts.has(player.trainLocation)) {
            ownedCities.push(player.trainLocation);
        } else {
            ownedCities.push(ownedMileposts.values().next().value);
        }
    }

    for (let ci = 0; ci < player.demandCards.length; ci++) {
        const card = player.demandCards[ci];
        if (!card || !card.demands) continue;
        for (let di = 0; di < card.demands.length; di++) {
            if (ci === excludeCardIndex && di === excludeDemandIndex) continue;
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

                // Compute the true buildable cost: if the src→dest path doesn't
                // intersect owned track, add the cheapest connector cost.
                let totalCost = result.cost;
                if (ownedMileposts.size > 0 && totalCost > 0) {
                    const pathIntersectsOwned = result.path.some(mpId => ownedMileposts.has(mpId));
                    if (!pathIntersectsOwned) {
                        let connectorCost = Infinity;
                        for (const ownedId of ownedCities) {
                            for (const goalId of [srcId, destId]) {
                                if (goalId === ownedId) continue;
                                const conn = findPath(ctx, ownedId, goalId, player.color, "cheapest");
                                if (conn && conn.cost < connectorCost) {
                                    connectorCost = conn.cost;
                                }
                            }
                        }
                        if (connectorCost < Infinity) {
                            totalCost += connectorCost;
                        } else {
                            continue; // can't reach this route at all
                        }
                    }
                }

                let score = demand.payout - totalCost;
                // Strongly prefer routes that are already fully built — the AI
                // invested track-building turns into them and can deliver immediately.
                if (totalCost === 0) score += 10;

                if (totalCost <= player.cash) {
                    // Affordable — pick best profit margin
                    if (score > bestAffordableScore) {
                        bestAffordableScore = score;
                        bestAffordable = {
                            cardIndex: ci,
                            demandIndex: di,
                            sourceCity: sourceCity,
                            cost: totalCost
                        };
                    }
                } else {
                    // Unaffordable — track cheapest as fallback
                    if (totalCost < bestUnaffordableCost) {
                        bestUnaffordableCost = totalCost;
                        bestUnaffordable = {
                            cardIndex: ci,
                            demandIndex: di,
                            sourceCity: sourceCity,
                            cost: totalCost
                        };
                    }
                }
            }
        }
    }

    // Prefer affordable demands; fall back to cheapest unaffordable
    return bestAffordable || bestUnaffordable;
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

    const remainingBudget = 20 - gs.buildingThisTurn;
    if (remainingBudget <= 0) return null;

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
            if (buildCost + ferryCost > player.cash) break;

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
        if (buildCost + segCost > player.cash) break;

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
function findConnectorBuild(gs, playerIndex, ctx, srcId, destId, payout = 0) {
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
    let bestGoal = null;
    for (const ownedId of ownedCities) {
        for (const goalId of [srcId, destId]) {
            if (goalId === undefined || goalId === ownedId) continue;
            const result = findPath(ctx, ownedId, goalId, player.color, "cheapest");
            if (result && result.cost > 0 && result.cost < bestCost) {
                bestCost = result.cost;
                bestPath = result;
                bestGoal = goalId;
            }
        }
    }

    if (!bestPath) return null;

    // Block connector builds for unprofitable routes the AI can't afford
    if (bestPath.cost > player.cash && payout <= bestPath.cost) return null;

    // Extend connector with the main route so the AI can build past the
    // first connecting city if budget allows (connector → src/dest → other end).
    const otherEnd = (bestGoal === srcId) ? destId : srcId;
    if (otherEnd !== undefined) {
        const mainRoute = findPath(ctx, bestGoal, otherEnd, player.color, "cheapest");
        if (mainRoute && mainRoute.path.length > 1) {
            const combinedPath = [...bestPath.path, ...mainRoute.path.slice(1)];
            const combinedResult = { path: combinedPath, cost: bestPath.cost + mainRoute.cost };
            return computeBuildActions(gs, playerIndex, ctx, combinedResult);
        }
    }

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
// Priority: target source > target dest > closest city to target source > any source city > any city.
function chooseDeploy(gs, playerIndex, ctx, target) {
    const player = gs.players[playerIndex];
    const ownedMileposts = getPlayerOwnedMileposts(ctx, player.color);

    if (ownedMileposts.size === 0) return null;

    // If we have a target, find the component connected to the target's source/dest
    let preferredComponent = null;
    let targetSrcId = null;
    let targetDestId = null;
    if (target) {
        targetSrcId = ctx.cityToMilepost[target.sourceCity];
        targetDestId = ctx.cityToMilepost[target.destCity];
        if (targetSrcId && ownedMileposts.has(targetSrcId)) {
            preferredComponent = getConnectedComponent(ctx, targetSrcId, player.color);
        } else if (targetDestId && ownedMileposts.has(targetDestId)) {
            preferredComponent = getConnectedComponent(ctx, targetDestId, player.color);
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

    // 1. Deploy at target source if on owned track
    if (targetSrcId && preferredComponent.has(targetSrcId)) {
        return targetSrcId;
    }

    // 2. Deploy at target destination if on owned track
    if (targetDestId && preferredComponent.has(targetDestId)) {
        return targetDestId;
    }

    // 3. Deploy at the city closest (by track distance) to target source
    if (targetSrcId) {
        let bestId = null;
        let bestDist = Infinity;
        for (const mpId of preferredComponent) {
            const mp = ctx.mileposts_by_id[mpId];
            if (!mp || !mp.city) continue;
            const targetMp = ctx.mileposts_by_id[targetSrcId];
            if (!targetMp) continue;
            const dist = Math.hypot(mp.x - targetMp.x, mp.y - targetMp.y);
            if (dist < bestDist) {
                bestDist = dist;
                bestId = mpId;
            }
        }
        if (bestId) return bestId;
    }

    // 4. Any source city for any demand on preferred component
    const wantedSources = new Set();
    for (const card of player.demandCards) {
        if (!card || !card.demands) continue;
        for (const demand of card.demands) {
            const sources = GOODS[demand.good] ? GOODS[demand.good].sources : [];
            for (const src of sources) wantedSources.add(src);
        }
    }
    for (const mpId of preferredComponent) {
        const mp = ctx.mileposts_by_id[mpId];
        if (mp.city && wantedSources.has(mp.city.name)) {
            return mpId;
        }
    }

    // 5. Fallback: any city on preferred component
    for (const mpId of preferredComponent) {
        const mp = ctx.mileposts_by_id[mpId];
        if (mp.city) return mpId;
    }

    // No city milepost found on preferred component — cannot deploy
    return null;
}

// Helper: find the city name at a milepost (from ctx, not gs)
function getCityNameAt(ctx, milepostId) {
    for (const [cityName, mpId] of Object.entries(ctx.cityToMilepost)) {
        if (mpId === milepostId) return cityName;
    }
    return null;
}

// Helper: when the target milepost isn't reachable on own track, find the
// owned milepost closest (Euclidean) to the target and return a track path
// from the current location to that frontier milepost. This lets the AI
// move toward an unconnected target by advancing along existing track.
function findFrontierMove(ctx, fromId, targetId, playerColor) {
    const targetMp = ctx.mileposts_by_id[targetId];
    if (!targetMp) return null;

    const ownedMileposts = getPlayerOwnedMileposts(ctx, playerColor);
    if (ownedMileposts.size === 0) return null;

    // Find the owned milepost closest to the target
    let bestId = null;
    let bestDist = Infinity;
    for (const mpId of ownedMileposts) {
        const mp = ctx.mileposts_by_id[mpId];
        if (!mp) continue;
        const dist = Math.hypot(mp.x - targetMp.x, mp.y - targetMp.y);
        if (dist < bestDist) {
            bestDist = dist;
            bestId = mpId;
        }
    }

    if (!bestId || bestId === fromId) return null;

    // Path from current location to the frontier milepost
    return findPathOnTrack(ctx, fromId, bestId, playerColor, false);
}

// 3d: Main entry point. Returns array of action descriptors.
function planTurn(gs, playerIndex, ctx) {
    const player = gs.players[playerIndex];
    const actions = [];

    // --- Initial building phase ---
    if (gs.phase === 'initialBuilding') {
        // Select target demand, excluding routes already fully built
        const target = selectTargetFromState(gs, playerIndex, ctx, { excludeFullyBuilt: true });

        // Log demand cards and target for debugging
        const demandSummary = player.demandCards.map((card, ci) => {
            if (!card || !card.demands) return `card${ci}:empty`;
            return `card${ci}:[${card.demands.map(d => `${d.good}→${d.to}($${d.payout})`).join(', ')}]`;
        }).join(' | ');
        const targetSummary = target
            ? `${target.good} from ${target.sourceCity}→${target.destCity} (buildCost=${target.cost})`
            : 'NONE';
        console.log(`AI ${playerIndex} initialBuild: demands={${demandSummary}} target=${targetSummary} cash=${player.cash}`);

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
            let bestGoal = null;
            for (const majorCity of MAJOR_CITIES) {
                const majorId = ctx.cityToMilepost[majorCity];
                if (majorId === undefined) continue;
                for (const goalId of [srcId, destId]) {
                    if (goalId === undefined || goalId === majorId) continue;
                    const result = findPath(ctx, majorId, goalId, player.color, "cheapest");
                    if (result && result.cost < bestCost) {
                        bestCost = result.cost;
                        bestPath = result;
                        bestGoal = goalId;
                    }
                }
            }
            if (bestPath) {
                // Extend past the first city: append the main route so the AI
                // can build major city → src/dest → other end in one action.
                const otherEnd = (bestGoal === srcId) ? destId : srcId;
                if (otherEnd !== undefined) {
                    const mainRoute = findPath(ctx, bestGoal, otherEnd, player.color, "cheapest");
                    if (mainRoute && mainRoute.path.length > 1) {
                        const combinedPath = [...bestPath.path, ...mainRoute.path.slice(1)];
                        const combinedResult = { path: combinedPath, cost: bestPath.cost + mainRoute.cost };
                        buildAction = computeBuildActions(gs, playerIndex, ctx, combinedResult);
                    }
                }
                if (!buildAction) {
                    buildAction = computeBuildActions(gs, playerIndex, ctx, bestPath);
                }
            }
        } else {
            // Subsequent builds: extend from existing track toward target
            const fullPath = findPath(ctx, srcId, destId, player.color, "cheapest");
            if (fullPath) {
                buildAction = computeBuildActions(gs, playerIndex, ctx, fullPath);
            }
            // Fallback: build connector from owned track toward src or dest
            if (!buildAction) {
                const demand = player.demandCards[target.cardIndex]?.demands[target.demandIndex];
                buildAction = findConnectorBuild(gs, playerIndex, ctx, srcId, destId, demand ? demand.payout : 0);
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
        const aiState = player.aiState || {};

        // If the AI has been idle for 2+ consecutive turns, discard hand to get fresh cards
        if ((aiState.idleTurns || 0) >= 2 && player.loads.length === 0) {
            console.warn(`AI ${playerIndex} idle for ${aiState.idleTurns} turns — discarding hand`);
            aiState.targetCardIndex = null;
            aiState.targetDemandIndex = null;
            aiState.targetSourceCity = null;
            aiState.idleTurns = 0;
            return [{ type: 'discardHand' }];
        }

        // Select target — prefers affordable demands
        const target = selectTargetFromState(gs, playerIndex, ctx);

        // Log demand cards and target for debugging
        const demandSummary = player.demandCards.map((card, ci) => {
            if (!card || !card.demands) return `card${ci}:empty`;
            return `card${ci}:[${card.demands.map((d, di) => `${d.good}→${d.to}($${d.payout})`).join(', ')}]`;
        }).join(' | ');
        const targetSummary = target
            ? `${target.good} from ${target.sourceCity}→${target.destCity} (buildCost=${target.cost})`
            : 'NONE';
        console.log(`AI ${playerIndex} operate: demands={${demandSummary}} target=${targetSummary} loads=[${player.loads}] at=${getCityNameAt(ctx, player.trainLocation) || player.trainLocation} movement=${player.movement}`);

        // No target at all — discard hand to draw fresh cards
        if (!target) {
            return [{ type: 'discardHand' }];
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
            let trackPath = findPathOnTrack(ctx, effectiveLocation, destId, player.color, false);
            if (!trackPath) {
                // Destination not connected — move to frontier closest to it
                trackPath = findFrontierMove(ctx, effectiveLocation, destId, player.color);
            }
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
            let trackPath = findPathOnTrack(ctx, effectiveLocation, destId, player.color, false);
            if (!trackPath) {
                trackPath = findFrontierMove(ctx, effectiveLocation, destId, player.color);
            }
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
        let trackPath = findPathOnTrack(ctx, effectiveLocation, srcId, player.color, false);
        if (!trackPath) {
            // Source not connected — move to the frontier of own track closest to source
            trackPath = findFrontierMove(ctx, effectiveLocation, srcId, player.color);
        }
        if (trackPath) {
            actions.push({ type: 'commitMove', path: trackPath.path });
            const arrived = trackPath.path[trackPath.path.length - 1];
            const arrivedCity = getCityNameAt(ctx, arrived);
            if (arrivedCity === target.sourceCity) {
                actions.push({ type: 'pickupGood', good: target.good });
                // Continue toward destination with remaining movement
                const destId = ctx.cityToMilepost[target.destCity];
                let destPath = findPathOnTrack(ctx, arrived, destId, player.color, false);
                if (!destPath) {
                    destPath = findFrontierMove(ctx, arrived, destId, player.color);
                }
                if (destPath) {
                    actions.push({ type: 'commitMove', path: destPath.path });
                    const destArrived = destPath.path[destPath.path.length - 1];
                    const destArrivedCity = getCityNameAt(ctx, destArrived);
                    if (destArrivedCity === target.destCity) {
                        actions.push({ type: 'deliverGood', cardIndex: target.cardIndex, demandIndex: target.demandIndex });
                    }
                }
            }
        } else {
            console.log(`AI ${playerIndex} operate: no path to source ${target.sourceCity} from ${getCityNameAt(ctx, effectiveLocation) || effectiveLocation} — skipping movement`);
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
        let buildAction = null;
        if (target) {
            console.log(`AI ${playerIndex} build: target=${target.good} from ${target.sourceCity}→${target.destCity} (buildCost=${target.cost}) cash=${player.cash}`);
            const srcId = ctx.cityToMilepost[target.sourceCity];
            const destId = ctx.cityToMilepost[target.destCity];
            const demand = player.demandCards[target.cardIndex]?.demands[target.demandIndex];
            const payout = demand ? demand.payout : 0;

            // First try: build along the src→dest path
            const fullPath = findPath(ctx, srcId, destId, player.color, "cheapest");
            if (fullPath) {
                // Allow partial building if the route is profitable (payout > cost).
                // Block only unprofitable routes the AI can't afford outright.
                if (fullPath.cost <= player.cash || payout > fullPath.cost) {
                    buildAction = computeBuildActions(gs, playerIndex, ctx, fullPath);
                }
            }

            // Fallback: if src→dest path doesn't connect to owned track,
            // build a connector from owned track toward src or dest
            if (!buildAction) {
                // For connectors, check total cost (connector + remaining route).
                // Allow if the demand is profitable enough to justify the investment.
                buildAction = findConnectorBuild(gs, playerIndex, ctx, srcId, destId, payout);
            }
        }

        // If primary target's route is already fully built (nothing to build),
        // look ahead: pick the next-best demand and build toward it now so the
        // AI has track ready after the current delivery.
        if (!buildAction) {
            const secondary = selectTargetDemand(gs, playerIndex, ctx, {
                excludeCardIndex: target ? target.cardIndex : -1,
                excludeDemandIndex: target ? target.demandIndex : -1
            });
            if (secondary) {
                const card2 = player.demandCards[secondary.cardIndex];
                const demand2 = card2?.demands[secondary.demandIndex];
                const srcId2 = ctx.cityToMilepost[secondary.sourceCity];
                const destId2 = demand2 ? ctx.cityToMilepost[demand2.to] : undefined;
                if (srcId2 && destId2 && demand2) {
                    const payout2 = demand2.payout;
                    console.log(`AI ${playerIndex} build: lookahead target=${demand2?.good} from ${secondary.sourceCity}→${demand2?.to} (buildCost=${secondary.cost}) cash=${player.cash}`);

                    const fullPath2 = findPath(ctx, srcId2, destId2, player.color, "cheapest");
                    if (fullPath2 && (fullPath2.cost <= player.cash || payout2 > fullPath2.cost)) {
                        buildAction = computeBuildActions(gs, playerIndex, ctx, fullPath2);
                    }
                    if (!buildAction) {
                        buildAction = findConnectorBuild(gs, playerIndex, ctx, srcId2, destId2, payout2);
                    }
                }
            }
        }

        if (buildAction) {
            actions.push({ type: 'commitBuild', ...buildAction });
        }

        // Track idle turns for deadlock detection
        const hasBuild = actions.some(a => a.type === 'commitBuild');
        const aiStateBuild = player.aiState || {};
        if (!hasBuild && player.loads.length === 0) {
            // No build, no loads in transit — this turn was unproductive
            aiStateBuild.idleTurns = (aiStateBuild.idleTurns || 0) + 1;
            // Clear persisted target so the AI tries a different demand next turn
            if (aiStateBuild.idleTurns >= 1) {
                aiStateBuild.targetCardIndex = null;
                aiStateBuild.targetDemandIndex = null;
                aiStateBuild.targetSourceCity = null;
            }
        } else {
            aiStateBuild.idleTurns = 0;
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
                            good: demand.good,
                            cost: fullPath ? fullPath.cost : Infinity
                        };
                    }
                }
            } else {
                const srcId = ctx.cityToMilepost[aiState.targetSourceCity];
                const destId = ctx.cityToMilepost[demand.to];
                const pathResult = (srcId && destId) ? findPath(ctx, srcId, destId, player.color, "cheapest") : null;
                return {
                    cardIndex: aiState.targetCardIndex,
                    demandIndex: aiState.targetDemandIndex,
                    sourceCity: aiState.targetSourceCity,
                    destCity: demand.to,
                    good: demand.good,
                    cost: pathResult ? pathResult.cost : Infinity
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
        good: demand.good,
        cost: selected.cost
    };
}

module.exports = {
    selectTargetDemand,
    planTurn,
    computeBuildActions,
    selectTargetFromState,
    findFrontierMove
};
