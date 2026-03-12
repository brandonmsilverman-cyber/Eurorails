// server/ai-actions.js
// Pure action-handler functions extracted from server.js socket handlers.
// Each function takes (gs, playerIndex, params) and returns { success, error?, logs?, uiEvent? }.
// No socket references, no broadcasting — just game state mutation + validation.

const gl = require('../shared/game-logic');
const CITIES = gl.CITIES;
const GOODS = gl.GOODS;
const MAJOR_CITIES = gl.MAJOR_CITIES;
const TRAIN_TYPES = gl.TRAIN_TYPES;
const getFerryKey = gl.getFerryKey;
const playerOwnsFerry = gl.playerOwnsFerry;

module.exports = function(deps) {
    const {
        serverEndTurn,
        serverDrawCardForPlayer,
        getCityAtMilepost,
        isEventBlocking,
        getGoodsInCirculation,
        serverValidatePath,
        serverGetPathMovementCost,
        serverGetMaxStepsForMovement,
        serverGetForeignTrackOwners,
        serverChargeTrackageRights,
        serverCheckTrackageStrandRisk
    } = deps;

    function applyEndTurn(gs) {
        const result = serverEndTurn(gs);
        if (result.gameOver) {
            return {
                success: true,
                logs: result.logs,
                uiEvent: { type: 'gameOver', winner: result.winner, logs: result.logs }
            };
        }
        return {
            success: true,
            logs: result.logs,
            uiEvent: { type: 'turnChanged', overlay: result.overlay, logs: result.logs }
        };
    }

    function applyUpgradeTo(gs, playerIndex, { trainType }) {
        if (!TRAIN_TYPES[trainType]) {
            return { success: false, error: 'Invalid train type' };
        }

        const player = gs.players[playerIndex];
        const upgradeCost = 20;

        if (player.cash < upgradeCost) {
            return { success: false, error: 'Not enough cash' };
        }
        if (gs.buildingThisTurn > 0) {
            return { success: false, error: 'Already built track this turn' };
        }

        player.cash -= upgradeCost;
        player.trainType = trainType;
        gs.buildingThisTurn = 20;

        const msg = `${player.name} upgraded train to ${trainType} (ECU 20M)`;
        gs.gameLog.push(msg);

        return {
            success: true,
            logs: [msg],
            uiEvent: { type: 'action', logs: [msg] }
        };
    }

    function applyPickupGood(gs, playerIndex, { good }) {
        if (!GOODS[good]) {
            return { success: false, error: 'Invalid good' };
        }

        const player = gs.players[playerIndex];

        // Validate player is at a city that produces this good
        const cityName = getCityAtMilepost(gs, player.trainLocation);
        if (!cityName) {
            return { success: false, error: 'Not at a city — cannot pick up goods' };
        }
        const cityData = CITIES[cityName];
        if (!cityData || !cityData.goods || !cityData.goods.includes(good)) {
            return { success: false, error: `${cityName} does not produce ${good}` };
        }

        const maxCapacity = TRAIN_TYPES[player.trainType].capacity;
        if (player.loads.length >= maxCapacity) {
            return { success: false, error: 'Train is at full capacity' };
        }

        if (isEventBlocking(gs, "load", { milepostId: player.trainLocation })) {
            return { success: false, error: 'Strike in effect — cannot pick up goods here' };
        }

        const goodData = GOODS[good];
        const inCirculation = getGoodsInCirculation(gs, good);
        if (inCirculation >= goodData.chips) {
            return { success: false, error: `No ${good} available — all ${goodData.chips} chips are in use` };
        }

        player.loads.push(good);
        gs.operateHistory.push({ type: 'pickup', good });
        const msg = `${player.name} picked up ${good}`;
        gs.gameLog.push(msg);

        return {
            success: true,
            logs: [msg],
            uiEvent: { type: 'action', logs: [msg] }
        };
    }

    function applyDropGood(gs, playerIndex, { loadIndex }) {
        const player = gs.players[playerIndex];

        if (loadIndex < 0 || loadIndex >= player.loads.length) {
            return { success: false, error: 'Invalid load index' };
        }

        const droppedGood = player.loads[loadIndex];
        player.loads.splice(loadIndex, 1);
        gs.operateHistory.push({ type: 'drop', good: droppedGood, loadIndex });
        const msg = `${player.name} dropped ${droppedGood}`;
        gs.gameLog.push(msg);

        return {
            success: true,
            logs: [msg],
            uiEvent: { type: 'action', logs: [msg] }
        };
    }

    function applyDeliverGood(gs, playerIndex, { cardIndex, demandIndex }) {
        const player = gs.players[playerIndex];
        const card = player.demandCards[cardIndex];

        if (!card || !card.demands[demandIndex]) {
            return { success: false, error: 'Invalid demand card' };
        }

        const demand = card.demands[demandIndex];
        const matchingLoadIndex = player.loads.findIndex(g => g === demand.good);
        if (matchingLoadIndex === -1) {
            return { success: false, error: `No ${demand.good} to deliver` };
        }

        const currentCity = getCityAtMilepost(gs, player.trainLocation);
        if (currentCity !== demand.to) {
            return { success: false, error: `Must deliver to ${demand.to}` };
        }

        if (isEventBlocking(gs, "deliver", { milepostId: player.trainLocation })) {
            return { success: false, error: 'Strike in effect — cannot deliver goods here' };
        }

        // Apply delivery — clear operate history (delivery commits the turn's moves)
        gs.operateHistory = [];
        player.loads.splice(matchingLoadIndex, 1);
        player.cash += demand.payout;
        const deliverMsg = `${player.name} delivered ${demand.good} to ${demand.to} for ECU ${demand.payout}M`;
        gs.gameLog.push(deliverMsg);

        // Remove fulfilled card, draw replacement
        player.demandCards.splice(cardIndex, 1);
        if (player.selectedDemands) {
            player.selectedDemands.splice(cardIndex, 1);
            player.selectedDemands.push(null);
        }
        const drawResult = serverDrawCardForPlayer(gs, player, []);
        const allLogs = [deliverMsg, ...drawResult.logs];

        return {
            success: true,
            logs: allLogs,
            uiEvent: {
                type: 'delivery',
                logs: allLogs,
                cardIndex,
                newCard: drawResult.card,
                drawnEvents: drawResult.drawnEvents,
                drawnBy: { name: player.name, color: player.color },
                deliveryGood: demand.good,
                deliveryTo: demand.to,
                deliveryPayout: demand.payout
            }
        };
    }

    function applyCommitBuild(gs, playerIndex, { buildPath, buildCost, majorCityCount, ferries }) {
        // Check strike 123: drawing player cannot build
        for (const ae of gs.activeEvents) {
            if (ae.card.id === 123) {
                const drawingPlayer = gs.players[ae.drawingPlayerIndex];
                const currentP = gs.players[playerIndex];
                if (currentP.color === drawingPlayer.color) {
                    return { success: false, error: 'Strike in effect — cannot build' };
                }
            }
        }

        const player = gs.players[playerIndex];

        if (!buildPath || buildPath.length < 2) {
            return { success: false, error: 'Invalid build path' };
        }
        if (typeof buildCost !== 'number' || buildCost < 0) {
            return { success: false, error: 'Invalid build cost' };
        }

        const remainingBudget = 20 - gs.buildingThisTurn;
        if (buildCost > remainingBudget) {
            return { success: false, error: 'Exceeds build budget' };
        }
        if (buildCost > player.cash) {
            return { success: false, error: 'Not enough cash' };
        }
        if (gs.majorCitiesThisTurn + (majorCityCount || 0) > 2) {
            return { success: false, error: 'Major city limit exceeded' };
        }

        // Build owned/other edge sets for validation
        const ownedEdges = new Set();
        const otherEdges = new Set();
        const ownedMileposts = new Set();
        for (const t of gs.tracks) {
            const fwd = t.from + "|" + t.to;
            const rev = t.to + "|" + t.from;
            if (t.color === player.color) {
                ownedEdges.add(fwd);
                ownedEdges.add(rev);
                ownedMileposts.add(t.from);
                ownedMileposts.add(t.to);
            } else {
                otherEdges.add(fwd);
                otherEdges.add(rev);
            }
        }

        // Build must start from owned track or a major city
        const startMp = gs.mileposts_by_id ? gs.mileposts_by_id[buildPath[0]] : null;
        const startsFromOwned = ownedMileposts.has(buildPath[0]);
        const startsFromMajorCity = startMp && startMp.city && MAJOR_CITIES.includes(startMp.city.name);
        if (!startsFromOwned && !startsFromMajorCity) {
            return { success: false, error: 'Build must start from owned track or a major city' };
        }

        // Add track segments
        let newSegments = 0;
        const logs = [];
        for (let i = 0; i < buildPath.length - 1; i++) {
            const edgeKey = buildPath[i] + "|" + buildPath[i + 1];
            const ferryKey = getFerryKey(buildPath[i], buildPath[i + 1]);

            // Check if this is a ferry edge
            let isFerryEdge = false;
            if (ferries && ferries.includes(ferryKey)) {
                isFerryEdge = true;
                if (!gs.ferryOwnership[ferryKey]) {
                    gs.ferryOwnership[ferryKey] = [];
                }
                if (!gs.ferryOwnership[ferryKey].includes(player.color)) {
                    gs.ferryOwnership[ferryKey].push(player.color);
                    newSegments++;
                }
            }
            if (isFerryEdge) continue;

            if (otherEdges.has(edgeKey)) continue;
            if (!ownedEdges.has(edgeKey)) {
                gs.tracks.push({
                    from: buildPath[i],
                    to: buildPath[i + 1],
                    color: player.color
                });
                ownedEdges.add(edgeKey);
                ownedEdges.add(buildPath[i + 1] + "|" + buildPath[i]);
                newSegments++;
            }
        }

        player.cash -= buildCost;
        gs.buildingThisTurn += buildCost;
        gs.majorCitiesThisTurn += (majorCityCount || 0);

        // Record build for undo
        gs.buildHistory.push({
            segments: newSegments,
            cost: buildCost,
            majorCities: majorCityCount || 0,
            ferries: ferries ? ferries.filter(fk => gs.ferryOwnership[fk] && gs.ferryOwnership[fk].includes(player.color)) : []
        });

        const buildMsg = `${player.name} built track for ECU ${buildCost}M (${20 - gs.buildingThisTurn}M remaining this turn)`;
        gs.gameLog.push(buildMsg);
        logs.push(buildMsg);

        return {
            success: true,
            logs,
            uiEvent: { type: 'action', logs }
        };
    }

    function applyDeployTrain(gs, playerIndex, { milepostId }) {
        const player = gs.players[playerIndex];
        if (player.trainLocation !== null) {
            return { success: false, error: 'Train already deployed' };
        }

        if (!milepostId) {
            return { success: false, error: 'Invalid milepost' };
        }

        player.trainLocation = milepostId;
        gs.operateHistory.push({ type: 'deploy' });
        const cityName = getCityAtMilepost(gs, milepostId) || "milepost";
        const msg = `${player.name} deployed train at ${cityName}`;
        gs.gameLog.push(msg);

        return {
            success: true,
            logs: [msg],
            uiEvent: { type: 'action', logs: [msg] }
        };
    }

    function applyDiscardHand(gs, playerIndex) {
        const player = gs.players[playerIndex];
        player.demandCards = [];
        player.selectedDemands = [null, null, null];

        const discardMsg = `${player.name} discarded hand and drew 3 new cards`;
        gs.gameLog.push(discardMsg);

        // Draw 3 new demand cards (processing events along the way)
        const drawLogs = [];
        const allDrawnEvents = [];
        while (player.demandCards.length < 3 && gs.demandCardDeck.length > 0) {
            serverDrawCardForPlayer(gs, player, drawLogs, allDrawnEvents);
        }

        // Discard hand also ends the turn
        const turnResult = serverEndTurn(gs);
        const allLogs = [discardMsg, ...drawLogs, ...turnResult.logs];

        const drawnBy = { name: player.name, color: player.color };
        if (turnResult.gameOver) {
            return {
                success: true,
                logs: allLogs,
                uiEvent: {
                    type: 'gameOver',
                    winner: turnResult.winner,
                    logs: allLogs,
                    drawnEvents: allDrawnEvents,
                    drawnBy
                }
            };
        }

        return {
            success: true,
            logs: allLogs,
            uiEvent: {
                type: 'turnChanged',
                overlay: turnResult.overlay,
                logs: allLogs,
                drawnEvents: allDrawnEvents,
                drawnBy
            }
        };
    }

    function applyEndOperatePhase(gs, playerIndex) {
        if (gs.phase !== 'operate') {
            return { success: false, error: 'Not in operate phase' };
        }

        gs.phase = 'build';
        gs.buildingThisTurn = 0;
        gs.majorCitiesThisTurn = 0;
        gs.buildHistory = [];
        gs.operateHistory = [];
        gs.trackageRightsPaidThisTurn = {};
        gs.trackageRightsLog = [];

        const msg = `${gs.players[playerIndex].name} moved to Build Phase`;
        gs.gameLog.push(msg);

        return {
            success: true,
            logs: [msg],
            uiEvent: { type: 'action', logs: [msg] }
        };
    }

    function applyUndoBuild(gs, playerIndex) {
        if (gs.buildHistory.length === 0) {
            return { success: false, error: 'Nothing to undo' };
        }

        const player = gs.players[playerIndex];
        const lastBuild = gs.buildHistory.pop();

        // Remove track segments (excluding ferry segments)
        const trackSegs = lastBuild.segments - (lastBuild.ferries ? lastBuild.ferries.length : 0);
        for (let i = 0; i < trackSegs; i++) {
            gs.tracks.pop();
        }

        // Remove ferry ownership
        if (lastBuild.ferries) {
            for (const ferryKey of lastBuild.ferries) {
                const owners = gs.ferryOwnership[ferryKey];
                if (owners) {
                    const idx = owners.lastIndexOf(player.color);
                    if (idx !== -1) owners.splice(idx, 1);
                    if (owners.length === 0) delete gs.ferryOwnership[ferryKey];
                }
            }
        }

        // Refund cost
        player.cash += lastBuild.cost;
        gs.buildingThisTurn -= lastBuild.cost;
        gs.majorCitiesThisTurn -= lastBuild.majorCities;

        const msg = `${player.name} undid last build (refunded ECU ${lastBuild.cost}M)`;
        gs.gameLog.push(msg);

        return {
            success: true,
            logs: [msg],
            uiEvent: { type: 'action', logs: [msg] }
        };
    }

    function applyCommitMove(gs, playerIndex, { path }) {
        if (gs.phase !== 'operate') {
            return { success: false, error: 'Not in operate phase' };
        }

        const player = gs.players[playerIndex];
        if (player.trainLocation === null) {
            return { success: false, error: 'Train not deployed' };
        }
        if (player.ferryState) {
            return { success: false, error: 'Waiting for ferry' };
        }
        if (player.movement <= 0) {
            return { success: false, error: 'No movement remaining' };
        }

        if (!path || !Array.isArray(path) || path.length < 2) {
            return { success: false, error: 'Invalid path' };
        }
        if (path[0] !== player.trainLocation) {
            return { success: false, error: 'Path does not start at train location' };
        }

        // Validate path connectivity
        const validation = serverValidatePath(gs, path, player.color);
        if (!validation.valid) {
            return { success: false, error: validation.error };
        }

        // Save state for undo
        const prevLocation = player.trainLocation;
        const prevMovement = player.movement;
        const prevFerryState = player.ferryState ? JSON.parse(JSON.stringify(player.ferryState)) : null;
        const prevCash = player.cash;
        const prevOwnerCash = {};
        for (const p of gs.players) {
            if (p.color !== player.color) prevOwnerCash[p.color] = p.cash;
        }

        const logs = [];
        let newlyPaidOwners = [];

        // Handle ferry crossings
        if (validation.ferryCrossings.length > 0) {
            const ferryIdx = validation.ferryCrossings[0];
            const portMilepostId = path[ferryIdx];
            const destPortId = path[ferryIdx + 1];

            if (portMilepostId !== player.trainLocation) {
                // Need to move to port first
                const stepsToPort = ferryIdx;
                const pathToPort = path.slice(0, stepsToPort + 1);
                const costToPort = serverGetPathMovementCost(gs, pathToPort);

                if (costToPort > player.movement) {
                    // Partial move toward ferry port
                    const maxSteps = serverGetMaxStepsForMovement(gs, path, player.movement);
                    const partialPath = path.slice(0, maxSteps + 1);
                    const partialDestId = path[maxSteps];

                    // Check and charge trackage rights for partial path
                    if (validation.foreignSegments.length > 0) {
                        const owners = serverGetForeignTrackOwners(gs, path, maxSteps, player.color, validation.foreignSegments);
                        let pendingFee = 0;
                        for (const oc of owners) {
                            if (!gs.trackageRightsPaidThisTurn[oc]) pendingFee += 4;
                        }
                        if (!serverCheckTrackageStrandRisk(gs, partialPath, player.color, player.cash - pendingFee)) {
                            return { success: false, error: "Cannot move here — you'd be stranded on foreign track without enough cash" };
                        }
                        const trResult = serverChargeTrackageRights(gs, player, path, validation.foreignSegments, maxSteps);
                        if (!trResult.ok) {
                            return { success: false, error: trResult.error };
                        }
                        newlyPaidOwners = trResult.newlyPaidOwners;
                        if (trResult.logs) logs.push(...trResult.logs);
                    }

                    player.trainLocation = partialDestId;
                    player.movement = 0;
                    const partialCost = serverGetPathMovementCost(gs, partialPath);
                    const cityName = getCityAtMilepost(gs, partialDestId) || "milepost";
                    const moveMsg = `Partial move toward ferry: moved ${maxSteps} steps (${partialCost}mp) to ${cityName}`;
                    logs.push(moveMsg);
                    gs.gameLog.push(moveMsg);

                    gs.operateHistory.push({
                        type: 'move', prevLocation, prevMovement, prevFerryState, prevCash, newlyPaidOwners, prevOwnerCash
                    });

                    return {
                        success: true,
                        logs,
                        uiEvent: { type: 'action', logs }
                    };
                }

                // Can reach port — charge trackage rights for path to port
                if (validation.foreignSegments.length > 0) {
                    const trResult = serverChargeTrackageRights(gs, player, path, validation.foreignSegments, stepsToPort);
                    if (!trResult.ok) {
                        return { success: false, error: trResult.error };
                    }
                    newlyPaidOwners = trResult.newlyPaidOwners;
                    if (trResult.logs) logs.push(...trResult.logs);
                }

                player.trainLocation = portMilepostId;
                player.movement -= costToPort;
            }

            // Set ferry state
            player.ferryState = { destPortId };
            player.movement = 0;
            const portCity = getCityAtMilepost(gs, portMilepostId) || "ferry port";
            const ferryMsg = `Arrived at ${portCity}. Waiting for ferry. Turn ends.`;
            logs.push(ferryMsg);
            gs.gameLog.push(ferryMsg);

            gs.operateHistory.push({
                type: 'move', prevLocation, prevMovement, prevFerryState, prevCash, newlyPaidOwners, prevOwnerCash
            });

            return {
                success: true,
                logs,
                uiEvent: { type: 'action', logs }
            };
        }

        // Normal movement (no ferry crossing) — handle partial moves
        const movementCost = serverGetPathMovementCost(gs, path);
        let movePath = path;
        let actualCost = movementCost;

        if (movementCost > player.movement) {
            const maxSteps = serverGetMaxStepsForMovement(gs, path, player.movement);
            movePath = path.slice(0, maxSteps + 1);
            actualCost = serverGetPathMovementCost(gs, movePath);
        }

        const actualSteps = movePath.length - 1;
        const destId = movePath[movePath.length - 1];

        // Charge trackage rights if using foreign track
        if (validation.foreignSegments.length > 0) {
            const owners = serverGetForeignTrackOwners(gs, path, actualSteps, player.color, validation.foreignSegments);
            let pendingFee = 0;
            for (const oc of owners) {
                if (!gs.trackageRightsPaidThisTurn[oc]) pendingFee += 4;
            }
            if (!serverCheckTrackageStrandRisk(gs, movePath, player.color, player.cash - pendingFee)) {
                return { success: false, error: "Cannot move here — you'd be stranded on foreign track without enough cash" };
            }
            const trResult = serverChargeTrackageRights(gs, player, path, validation.foreignSegments, actualSteps);
            if (!trResult.ok) {
                return { success: false, error: trResult.error };
            }
            newlyPaidOwners = trResult.newlyPaidOwners;
            if (trResult.logs) logs.push(...trResult.logs);
        }

        player.trainLocation = destId;
        player.movement -= actualCost;
        const locationName = getCityAtMilepost(gs, destId) || "milepost";
        const moveMsg = movePath.length < path.length
            ? `Partial move: ${actualSteps} steps (${actualCost}mp) — moved to ${locationName} (${player.movement}mp left)`
            : `Moved to ${locationName} (${actualCost}mp used, ${player.movement}mp left)`;
        logs.push(moveMsg);
        gs.gameLog.push(moveMsg);

        gs.operateHistory.push({
            type: 'move', prevLocation, prevMovement, prevFerryState, prevCash, newlyPaidOwners, prevOwnerCash
        });

        return {
            success: true,
            logs,
            uiEvent: { type: 'action', logs }
        };
    }

    function applyUndoMove(gs, playerIndex) {
        if (gs.operateHistory.length === 0) {
            return { success: false, error: 'Nothing to undo' };
        }

        const player = gs.players[playerIndex];
        const last = gs.operateHistory.pop();

        if (last.type === 'move') {
            player.trainLocation = last.prevLocation;
            player.movement = last.prevMovement;
            player.ferryState = last.prevFerryState;
            player.cash = last.prevCash;

            // Reverse trackage rights payments
            if (last.newlyPaidOwners && last.newlyPaidOwners.length > 0) {
                for (const ownerColor of last.newlyPaidOwners) {
                    const owner = gs.players.find(p => p.color === ownerColor);
                    if (owner && last.prevOwnerCash && last.prevOwnerCash[ownerColor] !== undefined) {
                        owner.cash = last.prevOwnerCash[ownerColor];
                    }
                    delete gs.trackageRightsPaidThisTurn[ownerColor];
                }
                gs.trackageRightsLog = gs.trackageRightsLog.filter(
                    entry => !last.newlyPaidOwners.some(oc => {
                        const owner = gs.players.find(p => p.color === oc);
                        return owner && entry.to === owner.name;
                    })
                );
            }

            const msg = `${player.name} undid move`;
            gs.gameLog.push(msg);
            return { success: true, logs: [msg], uiEvent: { type: 'action', logs: [msg] } };
        } else if (last.type === 'deploy') {
            player.trainLocation = null;
            const msg = `${player.name} undid train deployment`;
            gs.gameLog.push(msg);
            return { success: true, logs: [msg], uiEvent: { type: 'action', logs: [msg] } };
        } else if (last.type === 'pickup') {
            player.loads.splice(player.loads.lastIndexOf(last.good), 1);
            const msg = `${player.name} undid pickup of ${last.good}`;
            gs.gameLog.push(msg);
            return { success: true, logs: [msg], uiEvent: { type: 'action', logs: [msg] } };
        } else if (last.type === 'drop') {
            player.loads.splice(last.loadIndex, 0, last.good);
            const msg = `${player.name} undid drop of ${last.good}`;
            gs.gameLog.push(msg);
            return { success: true, logs: [msg], uiEvent: { type: 'action', logs: [msg] } };
        }

        return { success: false, error: 'Unknown undo type' };
    }

    return {
        applyEndTurn,
        applyUpgradeTo,
        applyPickupGood,
        applyDropGood,
        applyDeliverGood,
        applyCommitBuild,
        applyDeployTrain,
        applyDiscardHand,
        applyEndOperatePhase,
        applyUndoBuild,
        applyCommitMove,
        applyUndoMove
    };
};
