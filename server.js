const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const { randomUUID } = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const DISCONNECT_GRACE_MS = parseInt(process.env.DISCONNECT_GRACE_MS) || 300000; // 5 minutes
const TURN_TIMER_MS = parseInt(process.env.TURN_TIMER_MS) || 90000; // 90 seconds
const AI_ACTION_DELAY_MS = parseInt(process.env.AI_ACTION_DELAY_MS) || 1500; // delay between AI actions so human can watch
const SAVES_DIR = process.env.SAVES_DIR || path.join(__dirname, 'saves');
const ROOM_IDLE_MS = parseInt(process.env.ROOM_IDLE_MS) || 2 * 60 * 60 * 1000; // 2 hours

// --- Shared Game Logic Module ---
const gl = require('./shared/game-logic');
const MAJOR_CITIES = gl.MAJOR_CITIES;
const CITIES = gl.CITIES;
const GOODS = gl.GOODS;
const EVENT_CARDS = gl.EVENT_CARDS;
const RIVERS = gl.RIVERS;
const TRAIN_TYPES = gl.TRAIN_TYPES;
const crossesRiver = gl.crossesRiver;
const getFerryKey = gl.getFerryKey;
const playerOwnsFerry = gl.playerOwnsFerry;
const getPlayerOwnedMileposts = gl.getPlayerOwnedMileposts;
const generateHexGrid = gl.generateHexGrid;
const computeCoastDistances = gl.computeCoastDistances;
const getMilepostsInHexRange = gl.getMilepostsInHexRange;
const getCoastalMilepostsForSeaAreas = gl.getCoastalMilepostsForSeaAreas;
const getMilepostsInHexRangeMultiSource = gl.getMilepostsInHexRangeMultiSource;
const findPath = gl.findPath;
const findPathOnTrack = gl.findPathOnTrack;

// --- AI Action Handlers (extracted for AI reuse) ---
// Initialized after helper functions are defined (see below).
let aiActions = null;
const aiEasy = require('./server/ai-easy');

const LOBBY_COLORS = ["red", "blue", "green", "yellow", "purple", "orange"];

// Recent commits API — reads pre-generated file, falls back to live git log
const { execFile } = require('child_process');
const COMMITS_FILE = path.join(__dirname, 'data', 'commits.json');
app.get('/api/commits', (req, res) => {
    try {
        const commits = JSON.parse(fs.readFileSync(COMMITS_FILE, 'utf8'));
        if (commits.length) return res.json(commits);
    } catch (e) { /* file missing — fall back to git */ }
    execFile('git', ['log', '--format=%s||%ai', '-20'], { cwd: __dirname }, (err, stdout) => {
        if (err) return res.json([]);
        const commits = stdout.trim().split('\n').filter(Boolean).map(line => {
            const [message, rawDate] = line.split('||');
            const d = new Date(rawDate);
            const date = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
            return { message, date };
        });
        res.json(commits);
    });
});

// --- Game Stats Persistence ---
const STATS_FILE = path.join(__dirname, 'data', 'game-stats.json');
let gameStats = [];
try {
    gameStats = JSON.parse(fs.readFileSync(STATS_FILE, 'utf8'));
} catch (e) { /* file missing or corrupt — start fresh */ }

function saveStats() {
    fs.mkdirSync(path.dirname(STATS_FILE), { recursive: true });
    fs.writeFileSync(STATS_FILE, JSON.stringify(gameStats, null, 2));
}

function recordGame(mode) {
    const date = new Date().toISOString().slice(0, 10);
    gameStats.push({ date, mode });
    saveStats();
}

app.get('/api/game-stats', (req, res) => {
    const counts = {};
    for (const entry of gameStats) {
        if (!counts[entry.date]) counts[entry.date] = { solo: 0, multi: 0 };
        counts[entry.date][entry.mode] = (counts[entry.date][entry.mode] || 0) + 1;
    }
    const days = Object.entries(counts)
        .map(([date, c]) => {
            const d = new Date(date + 'T00:00:00');
            return {
                date: d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
                solo: c.solo,
                multi: c.multi,
                total: c.solo + c.multi
            };
        })
        .sort((a, b) => new Date(b.date) - new Date(a.date))
        .slice(0, 30);
    res.json(days);
});

// Redirect root to the game
app.get('/', (req, res) => {
    res.redirect('/eurorails.html');
});

// Serve static files from public/
app.use(express.static(path.join(__dirname, 'public')));

// Serve shared game logic module (used by both client and server)
app.use('/shared', express.static(path.join(__dirname, 'shared')));

// --- Deck Generation ---

function calculatePayout(distance, chips) {
    const rarityBonus = chips === 3 ? 1.12 : 1.0;
    return Math.round((5 + Math.pow(distance, 1.3) * 0.25) * rarityBonus);
}

const DEMAND_MIN_DISTANCE = 5;

function generateDeck() {
    const deck = [];
    const goodsKeys = Object.keys(GOODS);
    const cities = Object.keys(CITIES);
    const MIN_SPREAD = 15;
    const LONG_ROUTE_CARD_CHANCE = 0.15;

    // Sample distance distribution to find 80th percentile threshold
    const distSamples = [];
    for (let s = 0; s < 500; s++) {
        const good = goodsKeys[Math.floor(Math.random() * goodsKeys.length)];
        const sources = GOODS[good].sources;
        const to = cities[Math.floor(Math.random() * cities.length)];
        if (sources.includes(to)) continue;
        const toCoords = CITIES[to];
        const minDist = sources.reduce((min, src) => {
            if (src === to) return min;
            const sc = CITIES[src];
            return Math.min(min, Math.hypot(sc.x - toCoords.x, sc.y - toCoords.y));
        }, Infinity);
        if (minDist !== Infinity && minDist >= DEMAND_MIN_DISTANCE) distSamples.push(minDist);
    }
    distSamples.sort((a, b) => a - b);
    const longRouteThreshold = distSamples[Math.floor(distSamples.length * 0.8)] || 25;

    function generateDemand(minDistOverride) {
        const minDistRequired = minDistOverride || DEMAND_MIN_DISTANCE;
        const good = goodsKeys[Math.floor(Math.random() * goodsKeys.length)];
        const sources = GOODS[good].sources;
        const from = sources[Math.floor(Math.random() * sources.length)];
        let to, minDist, attempts = 0;
        do {
            to = cities[Math.floor(Math.random() * cities.length)];
            if (to === from || sources.includes(to)) { attempts++; continue; }
            const toCoords = CITIES[to];
            minDist = sources.reduce((min, src) => {
                if (src === to) return min;
                const sc = CITIES[src];
                return Math.min(min, Math.hypot(sc.x - toCoords.x, sc.y - toCoords.y));
            }, Infinity);
            attempts++;
        } while ((to === from || sources.includes(to) || minDist < minDistRequired) && attempts < 50);
        const payout = calculatePayout(minDist, GOODS[good].chips);
        return { good, from, to, payout, minDist };
    }

    for (let i = 0; i < 120; i++) {
        let demands, cardAttempts = 0;
        const isLongRouteCard = Math.random() < LONG_ROUTE_CARD_CHANCE;
        do {
            demands = [generateDemand(), generateDemand(), generateDemand()];
            // For long route cards, regenerate the longest demand with the elevated threshold
            if (isLongRouteCard) {
                demands.sort((a, b) => a.minDist - b.minDist);
                demands[2] = generateDemand(longRouteThreshold);
            }
            const dists = demands.map(d => d.minDist);
            const spread = Math.max(...dists) - Math.min(...dists);
            cardAttempts++;
        } while (demands.some(d => d.minDist === Infinity) ||
                 (Math.max(...demands.map(d => d.minDist)) - Math.min(...demands.map(d => d.minDist))) < MIN_SPREAD &&
                 cardAttempts < 30);
        demands.sort((a, b) => a.minDist - b.minDist);
        deck.push({ type: "demand", demands: demands.map(({ minDist, ...rest }) => rest), fulfilled: [false, false, false] });
    }

    for (let i = 0; i < EVENT_CARDS.length; i++) {
        deck.push({ type: "event", event: EVENT_CARDS[i] });
    }

    // Shuffle
    for (let i = deck.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [deck[i], deck[j]] = [deck[j], deck[i]];
    }

    return deck;
}

// --- Game Logic Helpers ---

function getConnectedMajorCities(gs, playerColor) {
    if (!gs.cityToMilepost) return [];

    const cityMileposts = {};
    for (const cityName in gs.cityToMilepost) {
        const mpId = gs.cityToMilepost[cityName];
        if (!cityMileposts[mpId]) cityMileposts[mpId] = [];
        cityMileposts[mpId].push(cityName);
    }

    const owned = getPlayerOwnedMileposts(gs, playerColor);
    const visited = new Set();
    const connectedCities = [];

    function bfs(startId) {
        const queue = [startId];
        const localVisited = new Set([startId]);

        while (queue.length > 0) {
            const current = queue.shift();
            if (cityMileposts[current]) {
                for (const cityName of cityMileposts[current]) {
                    if (MAJOR_CITIES.includes(cityName) && !connectedCities.includes(cityName)) {
                        connectedCities.push(cityName);
                    }
                }
            }
            for (const track of gs.tracks) {
                if (track.color === playerColor) {
                    let neighbor = null;
                    if (track.from === current) neighbor = track.to;
                    else if (track.to === current) neighbor = track.from;
                    if (neighbor && !localVisited.has(neighbor)) {
                        localVisited.add(neighbor);
                        queue.push(neighbor);
                    }
                }
            }
        }
    }

    for (const mpId of owned) {
        if (!visited.has(mpId)) {
            bfs(mpId);
            visited.add(mpId);
        }
    }

    return connectedCities;
}

function checkWinCondition(gs, player) {
    if (player.cash < 250) return false;
    if (!gs.cityToMilepost) return false; // Can't check without hex grid data
    const connectedCities = getConnectedMajorCities(gs, player.color);
    return connectedCities.length >= 7;
}

function getGoodsInCirculation(gs, good) {
    let count = 0;
    for (const player of gs.players) {
        for (const load of player.loads) {
            if (load === good) count++;
        }
    }
    return count;
}

function isEventBlocking(gs, action, context) {
    for (const activeEvent of gs.activeEvents) {
        const evt = activeEvent.card;
        if (action === "load" || action === "deliver") {
            // Strike 121: No loading/delivery more than radius mp from coast
            if (evt.id === 121 && context.milepostId !== undefined && gs.coastDistance) {
                const d = gs.coastDistance[context.milepostId];
                if (d !== undefined && d > evt.radius) return true;
            }
            // Strike 122: No loading/delivery within radius mp of coast
            if (evt.id === 122 && context.milepostId !== undefined && gs.coastDistance) {
                const d = gs.coastDistance[context.milepostId];
                if (d !== undefined && d <= evt.radius) return true;
            }
        }
    }
    return false;
}

// Reverse lookup: milepost ID -> city name (built from cityToMilepost)
function getCityAtMilepost(gs, milepostId) {
    if (!gs.cityToMilepost) return null;
    for (const [cityName, mpId] of Object.entries(gs.cityToMilepost)) {
        if (mpId === milepostId) return cityName;
    }
    return null;
}

// --- Server-side movement helpers ---

function serverIsInHalfSpeedZone(gs, milepostId) {
    for (const activeEvent of gs.activeEvents) {
        const evt = activeEvent.card;
        if (evt.type === "snow" || evt.type === "fog" || evt.type === "gale") {
            const zone = gs.eventZones && gs.eventZones[evt.id];
            if (zone && zone.includes(milepostId)) return true;
        }
    }
    return false;
}

function serverGetPathMovementCost(gs, path) {
    let cost = 0;
    for (let i = 1; i < path.length; i++) {
        cost += serverIsInHalfSpeedZone(gs, path[i]) ? 2 : 1;
    }
    return cost;
}

function serverGetMaxStepsForMovement(gs, path, availableMovement) {
    let spent = 0;
    for (let i = 1; i < path.length; i++) {
        const stepCost = serverIsInHalfSpeedZone(gs, path[i]) ? 2 : 1;
        if (spent + stepCost > availableMovement) return i - 1;
        spent += stepCost;
    }
    return path.length - 1;
}

// Validate that each edge in path exists in tracks (own or foreign) or ferryConnections
// Returns { valid, foreignSegments: [indices], ferryCrossings: [indices], error }
function serverValidatePath(gs, path, playerColor) {
    const foreignSegments = [];
    const ferryCrossings = [];

    for (let i = 0; i < path.length - 1; i++) {
        const fromId = path[i];
        const toId = path[i + 1];

        // Check ferry connections first (ferries take priority over any spurious track segments)
        const ferryKey = getFerryKey(fromId, toId);
        let isFerry = false;
        if (ferryKey) {
            for (const fc of gs.ferryConnections) {
                if (getFerryKey(fc.fromId, fc.toId) === ferryKey) {
                    isFerry = true;
                    break;
                }
            }
        }

        if (isFerry) {
            if (playerOwnsFerry(gs, ferryKey, playerColor)) {
                ferryCrossings.push(i);
            } else {
                return { valid: false, error: `No ferry ownership for crossing between ${fromId} and ${toId}` };
            }
            continue;
        }

        // Check track segments
        let found = false;
        let isForeign = false;
        for (const t of gs.tracks) {
            if ((t.from === fromId && t.to === toId) || (t.to === fromId && t.from === toId)) {
                found = true;
                if (t.color !== playerColor) isForeign = true;
                break;
            }
        }

        if (!found) {
            return { valid: false, error: `No track connection between ${fromId} and ${toId}` };
        }

        if (isForeign) foreignSegments.push(i);
    }

    return { valid: true, foreignSegments, ferryCrossings };
}

// Remove spurious track segments that overlap ferry connections.
// These can exist from a prior bug where building through an already-owned ferry
// created a regular track segment instead of recognizing the ferry edge.
function cleanupSpuriousFerryTracks(gs) {
    if (!gs.ferryConnections || !gs.tracks) return;
    const ferryEdges = new Set();
    for (const fc of gs.ferryConnections) {
        ferryEdges.add(fc.fromId + "|" + fc.toId);
        ferryEdges.add(fc.toId + "|" + fc.fromId);
    }
    const before = gs.tracks.length;
    gs.tracks = gs.tracks.filter(t => !ferryEdges.has(t.from + "|" + t.to));
    const removed = before - gs.tracks.length;
    if (removed > 0) {
        gs.gameLog.push(`Cleaned up ${removed} spurious track segment(s) overlapping ferry routes`);
    }
}

// Get unique foreign track owner colors along a path up to endIdx
function serverGetForeignTrackOwners(gs, path, endIdx, playerColor, foreignSegments) {
    const owners = new Set();
    for (let i = 0; i < endIdx; i++) {
        if (!foreignSegments.includes(i)) continue;
        const fromId = path[i];
        const toId = path[i + 1];
        for (const track of gs.tracks) {
            if (track.color === playerColor) continue;
            if ((track.from === fromId && track.to === toId) ||
                (track.to === fromId && track.from === toId)) {
                owners.add(track.color);
                break;
            }
        }
    }
    return owners;
}

// Charge trackage rights on the server. Returns { ok, newlyPaidOwners, totalFee, error }
function serverChargeTrackageRights(gs, movePlayer, path, foreignSegments, actualEndIdx) {
    const owners = serverGetForeignTrackOwners(gs, path, actualEndIdx, movePlayer.color, foreignSegments);
    if (owners.size === 0) return { ok: true, newlyPaidOwners: [], totalFee: 0 };

    const unpaid = [];
    for (const ownerColor of owners) {
        if (!gs.trackageRightsPaidThisTurn[ownerColor]) {
            unpaid.push(ownerColor);
        }
    }
    if (unpaid.length === 0) return { ok: true, newlyPaidOwners: [], totalFee: 0 };

    const totalFee = unpaid.length * 4;
    if (totalFee > movePlayer.cash) {
        return { ok: false, newlyPaidOwners: [], totalFee, error: `Not enough cash for trackage rights! Need ECU ${totalFee}M, have ECU ${movePlayer.cash}M` };
    }

    // Pay each unpaid owner
    const logs = [];
    for (const ownerColor of unpaid) {
        movePlayer.cash -= 4;
        const owner = gs.players.find(p => p.color === ownerColor);
        if (owner) {
            owner.cash += 4;
            gs.trackageRightsLog.push({ from: movePlayer.name, to: owner.name, amount: 4 });
            logs.push(`${movePlayer.name} paid ECU 4M to ${owner.name} for trackage rights`);
        }
        gs.trackageRightsPaidThisTurn[ownerColor] = true;
    }
    return { ok: true, newlyPaidOwners: unpaid, totalFee, logs };
}

// Check if a move would strand the player on foreign track without enough cash
function serverCheckTrackageStrandRisk(gs, movePath, playerColor, cashAfterFees) {
    if (!movePath || movePath.length === 0) return true;
    const destId = movePath[movePath.length - 1];

    // If destination is on the player's own network, they're fine
    const owned = getPlayerOwnedMileposts(gs, playerColor);
    if (owned.has(destId)) return true;

    // Player will end up on foreign track — need at least 4M for next turn's fee
    // But check if there's a viable delivery at any city along the path
    const currentPlayer = gs.players.find(p => p.color === playerColor);
    if (!currentPlayer) return cashAfterFees >= 4;

    let potentialCash = cashAfterFees;
    for (let i = 0; i < movePath.length; i++) {
        const cityName = getCityAtMilepost(gs, movePath[i]);
        if (!cityName) continue;
        for (const card of currentPlayer.demandCards) {
            for (const demand of card.demands) {
                if (demand.to === cityName && currentPlayer.loads.includes(demand.good)) {
                    potentialCash += demand.payout;
                }
            }
        }
    }

    return potentialCash >= 4;
}

// Shared helper: apply derailment/gale effects to a single player
function applyDerailmentToPlayer(gs, player, pIdx, logs, eventLabel, drawingPlayerIndex) {
    gs.derailedPlayers[pIdx] = 1;

    if (player.loads.length === 0) {
        const msg = `${player.name} ${eventLabel} Loses next turn.`;
        logs.push(msg);
        gs.gameLog.push(msg);
    } else {
        const dropIndex = Math.floor(Math.random() * player.loads.length);
        const droppedLoad = player.loads.splice(dropIndex, 1)[0];
        const msg = `${player.name} ${eventLabel} Loses next turn and drops ${droppedLoad}.`;
        logs.push(msg);
        gs.gameLog.push(msg);
    }

    // Drawing player in operate phase loses remaining movement immediately
    if (pIdx === drawingPlayerIndex && gs.phase === "operate") {
        player.movement = 0;
    }
}

// Draw one card for a player, skipping event cards (events handled separately during turns)
// Apply immediate event effects on the server
function serverApplyEventEffect(gs, eventCard, logs, drawingPlayerIndex) {
    if (eventCard.type === "tax") {
        for (const player of gs.players) {
            let tax = 0;
            if (player.cash > 200) tax = 25;
            else if (player.cash > 150) tax = 20;
            else if (player.cash > 100) tax = 15;
            else if (player.cash > 50) tax = 10;
            if (tax > 0) {
                const paid = Math.min(tax, player.cash);
                player.cash -= paid;
                const msg = `${player.name} pays ECU ${paid}M in taxes`;
                logs.push(msg);
                gs.gameLog.push(msg);
            }
        }
    } else if (eventCard.type === "derailment" && gs.eventZones) {
        const zone = gs.eventZones[eventCard.id];
        if (zone) {
            const zoneSet = new Set(zone);
            for (let pIdx = 0; pIdx < gs.players.length; pIdx++) {
                const player = gs.players[pIdx];
                if (player.trainLocation === null) continue;
                if (zoneSet.has(player.trainLocation)) {
                    applyDerailmentToPlayer(gs, player, pIdx, logs, "derailed!", drawingPlayerIndex);
                }
            }
        }
    } else if (eventCard.type === "flood" && gs.mileposts_by_id) {
        const river = RIVERS[eventCard.river];
        if (river) {
            const tracksToRemove = [];
            for (let i = 0; i < gs.tracks.length; i++) {
                const track = gs.tracks[i];
                const mp1 = gs.mileposts_by_id[track.from];
                const mp2 = gs.mileposts_by_id[track.to];
                if (mp1 && mp2 && crossesRiver(mp1.x, mp1.y, mp2.x, mp2.y, river)) {
                    tracksToRemove.push(i);
                    gs.destroyedRiverTracks.push(track);
                }
            }
            for (let i = tracksToRemove.length - 1; i >= 0; i--) {
                gs.tracks.splice(tracksToRemove[i], 1);
            }
            const msg = `${eventCard.title}: ${tracksToRemove.length} track segments destroyed.`;
            logs.push(msg);
            gs.gameLog.push(msg);
        }
    } else if (eventCard.type === "gale" && eventCard.id === 138 && gs.eventZones) {
        const zone = gs.eventZones[138];
        if (zone) {
            const zoneSet = new Set(zone);
            for (let pIdx = 0; pIdx < gs.players.length; pIdx++) {
                const player = gs.players[pIdx];
                if (player.trainLocation === null) continue;
                // Check if at a ferry port
                let atFerryPort = false;
                if (gs.ferryConnections) {
                    for (const fc of gs.ferryConnections) {
                        if (fc.fromId === player.trainLocation || fc.toId === player.trainLocation) {
                            atFerryPort = true;
                            break;
                        }
                    }
                }
                if (atFerryPort && zoneSet.has(player.trainLocation)) {
                    applyDerailmentToPlayer(gs, player, pIdx, logs, "caught in gale at ferry port!", drawingPlayerIndex);
                }
            }
        }
    }
}

// Draw one card for a player, processing events along the way.
// Returns { card, logs } where card is the demand card drawn (or null), logs are event messages.
function serverDrawCardForPlayer(gs, player, logs, drawnEvents) {
    if (!logs) logs = [];
    if (!drawnEvents) drawnEvents = [];
    while (gs.demandCardDeck.length > 0) {
        const card = gs.demandCardDeck.pop();

        if (card.type === "event") {
            const eventCard = card.event;

            // Only one gale active at a time
            if (eventCard.type === "gale" && gs.activeEvents.some(ae => ae.card.type === "gale")) {
                const msg = `${eventCard.title} skipped — a gale is already active.`;
                logs.push(msg);
                gs.gameLog.push(msg);
                continue;
            }

            const eventMsg = `EVENT: ${eventCard.title}`;
            logs.push(eventMsg);
            gs.gameLog.push(eventMsg);

            // Apply immediate effects
            serverApplyEventEffect(gs, eventCard, logs, gs.currentPlayerIndex);

            // Persistent events stay active
            if (eventCard.persistent) {
                gs.activeEvents.push({
                    card: eventCard,
                    drawingPlayerIndex: gs.currentPlayerIndex,
                    drawingPlayerTurnEnded: false
                });
                const persistMsg = `Event active for one full round`;
                logs.push(persistMsg);
                gs.gameLog.push(persistMsg);
            }

            drawnEvents.push(eventCard);
            continue; // Keep drawing until we get a demand card
        }

        // Demand card
        player.demandCards.push(card);
        return { card, logs, drawnEvents };
    }
    return { card: null, logs, drawnEvents };
}

// Server-side endTurn: mutates gameState, returns UI hints for clients
function serverEndTurn(gs, depth = 0) {
    const result = { logs: [], overlay: null, gameOver: false, winner: null };

    // Clean up any spurious track segments overlapping ferry routes (from prior bug)
    cleanupSpuriousFerryTracks(gs);

    // Guard against infinite recursion (all players abandoned/derailed)
    if (depth >= gs.players.length) {
        return result;
    }

    // Check win condition
    const currentPlayer = gs.players[gs.currentPlayerIndex];
    if (checkWinCondition(gs, currentPlayer)) {
        result.gameOver = true;
        result.winner = currentPlayer.name;
        result.logs.push(`${currentPlayer.name} wins the game!`);
        gs.gameLog.push(`${currentPlayer.name} wins the game!`);
        return result;
    }

    // Expire persistent events
    gs.activeEvents = gs.activeEvents.filter(ae => {
        if (gs.currentPlayerIndex === ae.drawingPlayerIndex) {
            if (ae.drawingPlayerTurnEnded) return false;
            ae.drawingPlayerTurnEnded = true;
        }
        return true;
    });

    // Reset building limits and history for new player
    gs.buildingThisTurn = 0;
    gs.majorCitiesThisTurn = 0;
    gs.trackageRightsPaidThisTurn = {};
    gs.trackageRightsLog = [];
    gs.operateHistory = [];
    gs.buildHistory = [];

    // Move to next player
    gs.currentPlayerIndex = (gs.currentPlayerIndex + 1) % gs.players.length;

    // Check if next player is abandoned - skip turn
    const nextPlayer = gs.players[gs.currentPlayerIndex];
    if (nextPlayer.abandoned) {
        const msg = `${nextPlayer.name} is abandoned and their turn is skipped`;
        result.logs.push(msg);
        gs.gameLog.push(msg);
        // Recurse to skip
        const innerResult = serverEndTurn(gs, depth + 1);
        result.logs.push(...innerResult.logs);
        result.overlay = innerResult.overlay;
        result.gameOver = innerResult.gameOver;
        result.winner = innerResult.winner;
        return result;
    }

    // Check if next player is derailed - skip turn
    if (gs.derailedPlayers[gs.currentPlayerIndex]) {
        gs.derailedPlayers[gs.currentPlayerIndex]--;
        if (gs.derailedPlayers[gs.currentPlayerIndex] === 0) {
            delete gs.derailedPlayers[gs.currentPlayerIndex];
        }
        const msg = `${nextPlayer.name} is derailed and loses this turn!`;
        result.logs.push(msg);
        gs.gameLog.push(msg);
        // Recurse to skip
        const innerResult = serverEndTurn(gs, depth + 1);
        result.logs.push(...innerResult.logs);
        result.overlay = innerResult.overlay;
        result.gameOver = innerResult.gameOver;
        result.winner = innerResult.winner;
        return result;
    }

    // Determine next phase
    if (gs.phase === "initialBuilding") {
        if (gs.currentPlayerIndex === 0) {
            gs.buildingPhaseCount++;
            if (gs.buildingPhaseCount >= gs.initialBuildingRounds) {
                gs.phase = "operate";
                for (const player of gs.players) {
                    player.movement = TRAIN_TYPES[player.trainType].movement;
                }
            }
        }
        if (gs.phase === "initialBuilding") {
            const msg = `Initial building round ${gs.buildingPhaseCount + 1}: ${gs.players[gs.currentPlayerIndex].name}`;
            result.logs.push(msg);
            gs.gameLog.push(msg);
        }
    } else if (gs.phase === "build" || gs.phase === "operate") {
        gs.phase = "operate";
        const player = gs.players[gs.currentPlayerIndex];
        const baseMovement = TRAIN_TYPES[player.trainType].movement;

        if (player.ferryState) {
            // TODO: gale ferry blocking check requires hex grid (isMilepostInEventZone)
            // For now, always allow ferry crossing
            const destPortId = player.ferryState.destPortId;
            player.trainLocation = destPortId;
            player.ferryState = null;
            player.movement = Math.floor(baseMovement / 2);
            const msg = `${player.name} crosses ferry. Half speed: ${player.movement}mp`;
            result.logs.push(msg);
            gs.gameLog.push(msg);
        } else {
            player.movement = baseMovement;
            const msg = `${player.name} starts Operate Phase (${player.movement}mp)`;
            result.logs.push(msg);
            gs.gameLog.push(msg);
        }
    }

    gs.turn++;

    // Build overlay info for clients
    let phaseLabel = "";
    if (gs.phase === "initialBuilding") phaseLabel = "Initial Building Phase";
    else if (gs.phase === "operate") phaseLabel = "Operate Phase";
    else phaseLabel = "Build Phase";

    result.overlay = {
        playerName: gs.players[gs.currentPlayerIndex].name,
        playerColor: gs.players[gs.currentPlayerIndex].color,
        phaseLabel
    };

    return result;
}

// Broadcast state update to all players in a room
function broadcastStateUpdate(roomCode, room, uiEvent) {
    room.lastActivity = Date.now();
    for (const [socketId, p] of room.players) {
        if (p.isAI) continue; // AI players have no socket
        const state = getStateForPlayer(room.gameState, p.sessionToken, room.disconnectedPlayers);
        io.to(socketId).emit('stateUpdate', { state, uiEvent });
    }
}

// --- Initialize AI Action Handlers ---
// All helper functions are now defined, so we can initialize the extracted actions module.
aiActions = require('./server/ai-actions')({
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
});

// --- AI Turn Loop ---

// Build pathfinding context from game state (used by AI strategy)
function buildPathfindingCtx(gs) {
    return {
        mileposts: gs.mileposts,
        mileposts_by_id: gs.mileposts_by_id,
        cityToMilepost: gs.cityToMilepost,
        ferryConnections: gs.ferryConnections,
        ferryOwnership: gs.ferryOwnership,
        tracks: gs.tracks,
        activeEvents: gs.activeEvents,
        players: gs.players
    };
}

// Schedule an AI turn if the current player is AI.
// Called after any turn advancement.
function maybeScheduleAITurn(roomCode, room) {
    const gs = room.gameState;
    if (!gs) return;
    const player = gs.players[gs.currentPlayerIndex];
    if (!player || !player.isAI) return;

    // Don't run AI turns if no human players are connected to watch
    const hasConnectedHuman = Array.from(room.players.values()).some(p => {
        const gsPlayer = gs.players.find(gp => gp.id === p.sessionToken);
        return gsPlayer && !gsPlayer.isAI;
    });
    if (!hasConnectedHuman) {
        console.log(`Room ${roomCode}: AI turn skipped for ${player.name} — no human players connected`);
        return;
    }

    // Cancel any existing AI timer for this room
    if (room.aiTurnTimer) {
        clearTimeout(room.aiTurnTimer);
    }

    room.aiTurnTimer = setTimeout(() => {
        room.aiTurnTimer = null;
        executeAITurn(roomCode, room);
    }, AI_ACTION_DELAY_MS);
}

// Dispatch a single AI action to the appropriate handler.
// Returns { success, error?, logs?, uiEvent? }
function executeAIAction(gs, playerIndex, action) {
    switch (action.type) {
        case 'endTurn':
            return aiActions.applyEndTurn(gs);
        case 'commitBuild':
            return aiActions.applyCommitBuild(gs, playerIndex, {
                buildPath: action.buildPath,
                buildCost: action.buildCost,
                majorCityCount: action.majorCityCount,
                ferries: action.ferries
            });
        case 'deployTrain':
            return aiActions.applyDeployTrain(gs, playerIndex, {
                milepostId: action.milepostId
            });
        case 'commitMove':
            return aiActions.applyCommitMove(gs, playerIndex, {
                path: action.path
            });
        case 'pickupGood':
            return aiActions.applyPickupGood(gs, playerIndex, {
                good: action.good
            });
        case 'deliverGood':
            return aiActions.applyDeliverGood(gs, playerIndex, {
                cardIndex: action.cardIndex,
                demandIndex: action.demandIndex
            });
        case 'upgradeTo':
            return aiActions.applyUpgradeTo(gs, playerIndex, {
                trainType: action.trainType
            });
        case 'discardHand':
            return aiActions.applyDiscardHand(gs, playerIndex);
        case 'endOperatePhase':
            return aiActions.applyEndOperatePhase(gs, playerIndex);
        default:
            return { success: false, error: `Unknown AI action type: ${action.type}` };
    }
}

// Execute an AI player's turn by computing a plan and running it step by step.
function executeAITurn(roomCode, room) {
    if (!rooms.has(roomCode)) return;
    const gs = room.gameState;
    if (!gs) return;
    const playerIndex = gs.currentPlayerIndex;
    const player = gs.players[playerIndex];
    if (!player || !player.isAI) return;

    let plan;
    try {
        const ctx = buildPathfindingCtx(gs);
        plan = aiEasy.planTurn(gs, playerIndex, ctx);
    } catch (err) {
        console.warn(`Room ${roomCode}: AI planTurn error: ${err.message}`);
        plan = [{ type: 'endTurn' }];
    }
    if (!plan || plan.length === 0) {
        console.warn(`Room ${roomCode}: ${player.name} planTurn returned empty plan, falling back to endTurn`);
        plan = [{ type: 'endTurn' }];
    }
    const hasSubstantiveAction = plan.some(a => !['endTurn', 'endOperatePhase'].includes(a.type));
    const logLevel = hasSubstantiveAction ? 'log' : 'warn';
    console[logLevel](`Room ${roomCode}: ${player.name} plan (phase=${gs.phase}, cash=${player.cash}, loads=${player.loads.length}): [${plan.map(a => a.type).join(', ')}]`);
    executeAIActionSequence(roomCode, room, plan, 0);
}

// Execute a sequence of AI actions with delays between each step.
function executeAIActionSequence(roomCode, room, plan, stepIndex) {
    if (!rooms.has(roomCode)) return;
    const gs = room.gameState;
    if (!gs) return;
    if (stepIndex >= plan.length) return;

    const action = plan[stepIndex];
    const playerIndex = gs.currentPlayerIndex;
    const player = gs.players[playerIndex];
    const actionSummary = action.type === 'commitBuild' ? `commitBuild(cost=${action.buildCost},len=${action.buildPath?.length})`
        : action.type === 'commitMove' ? `commitMove(len=${action.path?.length})`
        : action.type === 'deployTrain' ? `deployTrain(${action.milepostId})`
        : action.type === 'pickupGood' ? `pickupGood(${action.good})`
        : action.type === 'deliverGood' ? `deliverGood(card=${action.cardIndex},demand=${action.demandIndex})`
        : action.type;
    const result = executeAIAction(gs, playerIndex, action);
    if (result.success) {
        console.log(`Room ${roomCode}: ${player.name} AI action: ${actionSummary}${result.logs ? ' — ' + result.logs[result.logs.length - 1] : ''}`);
    }

    if (!result.success) {
        console.warn(`Room ${roomCode}: AI illegal action ${action.type}: ${result.error}`);
        // For non-critical actions (pickup/deliver), skip and continue the plan.
        // The pre-computed plan may have stale assumptions (e.g., partial move).
        const skippable = ['pickupGood', 'deliverGood'];
        if (skippable.includes(action.type)) {
            room.aiTurnTimer = setTimeout(() => {
                room.aiTurnTimer = null;
                executeAIActionSequence(roomCode, room, plan, stepIndex + 1);
            }, AI_ACTION_DELAY_MS);
            return;
        }
        const endResult = aiActions.applyEndTurn(gs);
        broadcastStateUpdate(roomCode, room, endResult.uiEvent);
        if (!endResult.uiEvent.gameOver) {
            maybeScheduleAITurn(roomCode, room);
            startTurnTimerIfNeeded(roomCode, room);
        }
        return;
    }

    broadcastStateUpdate(roomCode, room, result.uiEvent);

    // After a successful deliverGood by an AI with movement remaining,
    // re-plan the operate phase with fresh state. The delivery replaced a
    // demand card and cleared the AI target, so the pre-computed plan is stale.
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

    if (action.type === 'endTurn' || action.type === 'discardHand') {
        if (result.uiEvent?.gameOver) return;
        maybeScheduleAITurn(roomCode, room);
        startTurnTimerIfNeeded(roomCode, room);
        return;
    }

    // After endOperatePhase, the game transitions to build phase.
    // Re-plan for the new phase instead of continuing the old plan.
    if (action.type === 'endOperatePhase') {
        room.aiTurnTimer = setTimeout(() => {
            room.aiTurnTimer = null;
            if (!rooms.has(roomCode)) return;
            const freshGs = room.gameState;
            if (!freshGs) return;
            let buildPlan;
            try {
                const freshCtx = buildPathfindingCtx(freshGs);
                buildPlan = aiEasy.planTurn(freshGs, freshGs.currentPlayerIndex, freshCtx);
            } catch (err) {
                console.warn(`Room ${roomCode}: AI planTurn error (build re-plan): ${err.message}`);
                buildPlan = [{ type: 'endTurn' }];
            }
            if (!buildPlan || buildPlan.length === 0) {
                console.warn(`Room ${roomCode}: AI build re-plan returned empty, falling back to endTurn`);
                buildPlan = [{ type: 'endTurn' }];
            }
            const bp = freshGs.players[freshGs.currentPlayerIndex];
            const hasBuild = buildPlan.some(a => !['endTurn', 'endOperatePhase'].includes(a.type));
            console[hasBuild ? 'log' : 'warn'](`Room ${roomCode}: ${bp.name} plan (phase=${freshGs.phase}, cash=${bp.cash}): [${buildPlan.map(a => a.type).join(', ')}]`);
            executeAIActionSequence(roomCode, room, buildPlan, 0);
        }, AI_ACTION_DELAY_MS);
        return;
    }

    room.aiTurnTimer = setTimeout(() => {
        room.aiTurnTimer = null;
        executeAIActionSequence(roomCode, room, plan, stepIndex + 1);
    }, AI_ACTION_DELAY_MS);
}

// --- Game State Initialization ---

function createGameState(playerList) {
    const deck = generateDeck();

    const players = playerList.map(p => {
        const demandCards = [];
        while (demandCards.length < 3 && deck.length > 0) {
            const card = deck.pop();
            if (card.type === "demand") {
                demandCards.push(card);
            }
            // Event cards drawn during initial deal are discarded
        }
        const player = {
            id: p.id,
            name: p.name,
            color: p.color,
            cash: 50,
            trainType: "Freight",
            trainLocation: null,
            demandCards: demandCards,
            loads: [],
            movement: 0,
            ferryState: null,
            selectedDemands: [null, null, null]
        };
        if (p.isAI) {
            player.isAI = true;
            player.difficulty = p.difficulty || 'easy';
            player.aiState = {
                targetCardIndex: null,
                targetDemandIndex: null,
                targetSourceCity: null
            };
        }
        return player;
    });

    // Generate hex grid server-side (no longer depends on client sending it)
    const grid = generateHexGrid();
    const gridCtx = { mileposts: grid.mileposts, mileposts_by_id: grid.mileposts_by_id };
    const coastDistance = computeCoastDistances(gridCtx);

    // Precompute event zones for server-side checks (derailment, snow, fog, gale)
    const eventZones = {};
    for (const evt of EVENT_CARDS) {
        if (evt.type === "derailment" && evt.cities) {
            const zone = new Set();
            for (const cityName of evt.cities) {
                const cityMpId = grid.cityToMilepost[cityName];
                if (cityMpId !== undefined) {
                    for (const id of getMilepostsInHexRange(gridCtx, cityMpId, evt.radius)) {
                        zone.add(id);
                    }
                }
            }
            eventZones[evt.id] = Array.from(zone);
        } else if ((evt.type === "snow" || evt.type === "fog") && evt.city) {
            const cityMpId = grid.cityToMilepost[evt.city];
            if (cityMpId !== undefined) {
                const zone = getMilepostsInHexRange(gridCtx, cityMpId, evt.radius);
                eventZones[evt.id] = Array.from(zone);
            }
        } else if (evt.type === "gale" && evt.seaAreas) {
            const coastalStarts = getCoastalMilepostsForSeaAreas(gridCtx, evt.seaAreas);
            const zone = getMilepostsInHexRangeMultiSource(gridCtx, coastalStarts, evt.radius - 1);
            eventZones[evt.id] = Array.from(zone);
        }
    }

    return {
        gameId: randomUUID(),
        players,
        currentPlayerIndex: 0,
        turn: 1,
        phase: "initialBuilding",
        buildingPhaseCount: 0,
        initialBuildingRounds: 2,
        gameStarted: true,
        demandCardDeck: deck,
        tracks: [],
        ferryOwnership: {},
        gameLog: ["Game started! Initial building phase (2 rounds)"],
        buildingThisTurn: 0,
        majorCitiesThisTurn: 0,
        halfSpeedActive: {},
        activeEvents: [],
        derailedPlayers: {},
        destroyedRiverTracks: [],
        trackageRightsPaidThisTurn: {},
        trackageRightsLog: [],
        operateHistory: [],
        buildHistory: [],
        // Hex grid data (server-generated, no longer from client)
        mileposts: grid.mileposts,
        mileposts_by_id: grid.mileposts_by_id,
        cityToMilepost: grid.cityToMilepost,
        ferryConnections: grid.ferryConnections,
        coastDistance,
        eventZones
    };
}

// --- Save & Resume ---

const SAVE_SCHEMA_VERSION = 1;

function generateSeatCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < 4; i++) {
        code += chars[Math.floor(Math.random() * chars.length)];
    }
    return code;
}

function generateSeatCodes(players) {
    const seats = {};
    const usedCodes = new Set();
    for (const p of players) {
        if (p.abandoned) continue;
        let code;
        do {
            code = generateSeatCode();
        } while (usedCodes.has(code));
        usedCodes.add(code);
        seats[p.color] = { name: p.name, seatCode: code };
    }
    return seats;
}

function serializeForSave(gameState, gameName) {
    const seats = generateSeatCodes(gameState.players);
    const gs = gameState;

    const saveData = {
        schemaVersion: SAVE_SCHEMA_VERSION,
        gameId: gs.gameId,
        savedAt: new Date().toISOString(),
        gameName: gameName || null,

        seats,

        state: {
            players: gs.players.map(p => ({
                id: p.id,
                name: p.name,
                color: p.color,
                cash: p.cash,
                trainType: p.trainType,
                trainLocation: p.trainLocation,
                demandCards: p.demandCards,
                loads: p.loads,
                ferryState: p.ferryState,
                selectedDemands: p.selectedDemands,
                abandoned: p.abandoned || false,
                isAI: p.isAI || false,
                difficulty: p.difficulty || null,
                aiState: p.aiState || null
            })),
            currentPlayerIndex: gs.currentPlayerIndex,
            turn: gs.turn,
            phase: gs.phase,
            buildingPhaseCount: gs.buildingPhaseCount,
            initialBuildingRounds: gs.initialBuildingRounds,
            tracks: gs.tracks,
            ferryOwnership: gs.ferryOwnership,
            demandCardDeck: gs.demandCardDeck,
            activeEvents: gs.activeEvents,
            derailedPlayers: gs.derailedPlayers,
            destroyedRiverTracks: gs.destroyedRiverTracks,
            halfSpeedActive: gs.halfSpeedActive,
            trackageRightsPaidThisTurn: gs.trackageRightsPaidThisTurn,
            trackageRightsLog: gs.trackageRightsLog,
            gameLog: gs.gameLog
        }
    };

    return saveData;
}

function validateSaveFile(data) {
    if (!data || typeof data !== 'object') {
        throw new Error('Save file is not a valid object');
    }
    if (!data.gameId || typeof data.gameId !== 'string') {
        throw new Error('Save file missing gameId');
    }
    if (!data.seats || typeof data.seats !== 'object') {
        throw new Error('Save file missing seats');
    }
    if (!data.state || typeof data.state !== 'object') {
        throw new Error('Save file missing state');
    }
    const requiredStateFields = [
        'players', 'currentPlayerIndex', 'turn', 'phase',
        'tracks', 'demandCardDeck', 'gameLog'
    ];
    for (const field of requiredStateFields) {
        if (data.state[field] === undefined) {
            throw new Error(`Save file missing state.${field}`);
        }
    }
    if (!Array.isArray(data.state.players) || data.state.players.length === 0) {
        throw new Error('Save file has no players');
    }
}

function writeSaveFile(saveData) {
    const filePath = path.join(SAVES_DIR, `${saveData.gameId}.json`);
    fs.writeFileSync(filePath, JSON.stringify(saveData, null, 2));
    return filePath;
}

function readSaveFile(gameId) {
    const filePath = path.join(SAVES_DIR, `${gameId}.json`);
    if (!fs.existsSync(filePath)) {
        return null;
    }
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    validateSaveFile(data);
    return data;
}

function listSaveFiles() {
    if (!fs.existsSync(SAVES_DIR)) return [];
    const files = fs.readdirSync(SAVES_DIR).filter(f => f.endsWith('.json'));
    const results = [];
    for (const file of files) {
        try {
            const data = JSON.parse(fs.readFileSync(path.join(SAVES_DIR, file), 'utf8'));
            results.push({
                gameId: data.gameId,
                gameName: data.gameName || null,
                savedAt: data.savedAt,
                playerCount: data.state.players.filter(p => !p.abandoned).length,
                players: data.state.players.map(p => ({ name: p.name, color: p.color, abandoned: p.abandoned || false }))
            });
        } catch (e) {
            // Skip corrupt save files
        }
    }
    return results;
}

function loadGameStateFromSave(saveData) {
    // Regenerate hex grid (deterministic, not saved)
    const grid = generateHexGrid();
    const gridCtx = { mileposts: grid.mileposts, mileposts_by_id: grid.mileposts_by_id };
    const coastDistance = computeCoastDistances(gridCtx);

    // Recompute event zones
    const eventZones = {};
    for (const evt of EVENT_CARDS) {
        if (evt.type === "derailment" && evt.cities) {
            const zone = new Set();
            for (const cityName of evt.cities) {
                const cityMpId = grid.cityToMilepost[cityName];
                if (cityMpId !== undefined) {
                    for (const id of getMilepostsInHexRange(gridCtx, cityMpId, evt.radius)) {
                        zone.add(id);
                    }
                }
            }
            eventZones[evt.id] = Array.from(zone);
        } else if ((evt.type === "snow" || evt.type === "fog") && evt.city) {
            const cityMpId = grid.cityToMilepost[evt.city];
            if (cityMpId !== undefined) {
                const zone = getMilepostsInHexRange(gridCtx, cityMpId, evt.radius);
                eventZones[evt.id] = Array.from(zone);
            }
        } else if (evt.type === "gale" && evt.seaAreas) {
            const coastalStarts = getCoastalMilepostsForSeaAreas(gridCtx, evt.seaAreas);
            const zone = getMilepostsInHexRangeMultiSource(gridCtx, coastalStarts, evt.radius - 1);
            eventZones[evt.id] = Array.from(zone);
        }
    }

    const s = saveData.state;

    // Rebuild player objects with movement reset (turn-scoped state)
    const players = s.players.map(p => ({
        id: p.id,
        name: p.name,
        color: p.color,
        cash: p.cash,
        trainType: p.trainType,
        trainLocation: p.trainLocation,
        demandCards: p.demandCards,
        loads: p.loads,
        movement: 0,
        ferryState: p.ferryState || null,
        selectedDemands: p.selectedDemands || [null, null, null],
        abandoned: p.abandoned || false,
        isAI: p.isAI || false,
        difficulty: p.difficulty || null,
        aiState: p.aiState || null
    }));

    return {
        gameId: saveData.gameId,
        players,
        currentPlayerIndex: s.currentPlayerIndex,
        turn: s.turn,
        phase: s.phase,
        buildingPhaseCount: s.buildingPhaseCount || 0,
        initialBuildingRounds: s.initialBuildingRounds || 2,
        gameStarted: true,
        demandCardDeck: s.demandCardDeck,
        tracks: s.tracks,
        ferryOwnership: s.ferryOwnership || {},
        gameLog: s.gameLog,
        buildingThisTurn: 0,
        majorCitiesThisTurn: 0,
        halfSpeedActive: s.halfSpeedActive || {},
        activeEvents: s.activeEvents || [],
        derailedPlayers: s.derailedPlayers || {},
        destroyedRiverTracks: s.destroyedRiverTracks || [],
        trackageRightsPaidThisTurn: {},
        trackageRightsLog: [],
        operateHistory: [],
        buildHistory: [],
        // Regenerated data
        mileposts: grid.mileposts,
        mileposts_by_id: grid.mileposts_by_id,
        cityToMilepost: grid.cityToMilepost,
        ferryConnections: grid.ferryConnections,
        coastDistance,
        eventZones
    };
}

function validateSeatCode(saveData, seatCode) {
    for (const [color, seat] of Object.entries(saveData.seats)) {
        if (seat.seatCode === seatCode) {
            return color;
        }
    }
    return null;
}

function executePendingSave(roomCode, room) {
    if (!room.pendingSave) return null;
    const { gameName } = room.pendingSave;
    room.pendingSave = null;

    const gs = room.gameState;
    const saveData = serializeForSave(gs, gameName);
    writeSaveFile(saveData);

    const msg = `Game saved (ID: ${gs.gameId})`;
    const seatMsg = formatSeatCodesForLog(saveData);
    gs.gameLog.push(msg);
    gs.gameLog.push(seatMsg);
    console.log(`Room ${roomCode}: ${msg}`);

    return saveData;
}

function formatSeatCodesForLog(saveData) {
    const parts = Object.entries(saveData.seats).map(
        ([color, seat]) => `${color}: ${seat.seatCode}`
    );
    return `Seat codes — ${parts.join(', ')}`;
}

// Produce a version of gameState safe to send to a specific player.
// Each player sees their own demand cards in full, but only the count for opponents.
function getStateForPlayer(gameState, playerId, disconnectedPlayers) {
    return {
        players: gameState.players.map(p => {
            const connected = disconnectedPlayers ? !disconnectedPlayers.has(p.id) && !p.abandoned : true;
            if (p.id === playerId) {
                return { ...p, connected }; // Full data for yourself
            }
            // Hide demand card contents for other players
            const { demandCards, selectedDemands, ...rest } = p;
            return {
                ...rest,
                connected,
                demandCards: demandCards.map(() => ({ hidden: true })),
                selectedDemands: [null, null, null]
            };
        }),
        currentPlayerIndex: gameState.currentPlayerIndex,
        turn: gameState.turn,
        phase: gameState.phase,
        buildingPhaseCount: gameState.buildingPhaseCount,
        initialBuildingRounds: gameState.initialBuildingRounds,
        gameStarted: gameState.gameStarted,
        demandCardDeck: gameState.demandCardDeck.length, // only send count, not contents
        tracks: gameState.tracks,
        ferryOwnership: gameState.ferryOwnership,
        gameLog: gameState.gameLog,
        buildingThisTurn: gameState.buildingThisTurn,
        majorCitiesThisTurn: gameState.majorCitiesThisTurn,
        halfSpeedActive: gameState.halfSpeedActive,
        activeEvents: gameState.activeEvents,
        derailedPlayers: gameState.derailedPlayers,
        destroyedRiverTracks: gameState.destroyedRiverTracks,
        trackageRightsPaidThisTurn: gameState.trackageRightsPaidThisTurn,
        trackageRightsLog: gameState.trackageRightsLog,
        operateHistory: gameState.operateHistory,
        buildHistory: gameState.buildHistory
    };
}

// --- Room Management ---

const rooms = new Map(); // roomCode -> { players: Map<socketId, {name, color, sessionToken}>, hostSessionToken, sessionToSocketId: Map, disconnectedPlayers: Map, gameStarted, gameState }
const resumingGames = new Map(); // gameId -> roomCode (tracks which saved games are currently being resumed)

function generateRoomCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no ambiguous chars (0/O, 1/I)
    let code = '';
    for (let i = 0; i < 4; i++) {
        code += chars[Math.floor(Math.random() * chars.length)];
    }
    return code;
}

function getUniqueRoomCode() {
    let code;
    do {
        code = generateRoomCode();
    } while (rooms.has(code));
    return code;
}

// --- Socket.IO ---

io.on('connection', (socket) => {
    console.log(`Player connected: ${socket.id}`);

    socket.on('listRooms', (callback) => {
        callback(getRoomList());
    });

    socket.on('createRoom', ({ playerName, password }, callback) => {
        const playerCount = 6;
        const roomCode = getUniqueRoomCode();
        const sessionToken = randomUUID();
        const room = {
            players: new Map(),
            hostSessionToken: sessionToken,
            sessionToSocketId: new Map(),
            disconnectedPlayers: new Map(),
            graceTimers: new Map(),
            turnTimers: new Map(),
            gameStarted: false,
            gameState: null,
            maxPlayers: playerCount,
            password: password || null,
            lastActivity: Date.now()
        };
        room.players.set(socket.id, { name: playerName, color: null, sessionToken });
        room.sessionToSocketId.set(sessionToken, socket.id);
        rooms.set(roomCode, room);
        socket.join(roomCode);
        socket.roomCode = roomCode;

        console.log(`Room ${roomCode} created by ${playerName}${room.password ? ' (password protected)' : ''}`);
        callback({ success: true, roomCode, sessionToken });
        io.to(roomCode).emit('roomUpdate', getRoomInfo(roomCode));
        broadcastRoomList();
    });

    socket.on('joinRoom', ({ roomCode, playerName, password }, callback) => {
        const code = roomCode.toUpperCase();
        const room = rooms.get(code);

        if (!room) {
            return callback({ success: false, error: 'Room not found' });
        }
        if (room.gameStarted) {
            return callback({ success: false, error: 'Game already in progress' });
        }
        if (room.players.size >= room.maxPlayers) {
            return callback({ success: false, error: 'Room is full' });
        }
        if (room.password && room.password !== password) {
            return callback({ success: false, error: 'Incorrect password' });
        }

        const sessionToken = randomUUID();
        room.players.set(socket.id, { name: playerName, color: null, sessionToken });
        room.sessionToSocketId.set(sessionToken, socket.id);
        room.lastActivity = Date.now();
        socket.join(code);
        socket.roomCode = code;

        console.log(`${playerName} joined room ${code}`);
        callback({ success: true, roomCode: code, sessionToken });
        io.to(code).emit('roomUpdate', getRoomInfo(code));
        broadcastRoomList();
    });

    socket.on('leaveRoom', () => {
        const roomCode = socket.roomCode;
        if (!roomCode) return;

        const room = rooms.get(roomCode);
        if (!room) return;
        if (room.gameStarted) return; // can't leave mid-game

        const player = room.players.get(socket.id);
        console.log(`${player?.name || 'Unknown'} left room ${roomCode}`);
        if (player) {
            room.sessionToSocketId.delete(player.sessionToken);
        }
        room.players.delete(socket.id);
        socket.leave(roomCode);
        socket.roomCode = null;

        // Check if any human players remain
        let hasHumans = false;
        for (const [, p] of room.players) {
            if (!p.isAI) { hasHumans = true; break; }
        }

        if (room.players.size === 0 || !hasHumans) {
            // Remove AI players too — don't keep a room with only AI
            rooms.delete(roomCode);
            console.log(`Room ${roomCode} deleted (${room.players.size === 0 ? 'empty' : 'no humans remaining'})`);
        } else {
            if (player && room.hostSessionToken === player.sessionToken) {
                // Transfer host to next human player
                for (const [, p] of room.players) {
                    if (!p.isAI) {
                        room.hostSessionToken = p.sessionToken;
                        break;
                    }
                }
            }
            io.to(roomCode).emit('roomUpdate', getRoomInfo(roomCode));
        }
        broadcastRoomList();
    });

    socket.on('selectColor', ({ color }, callback) => {
        const room = rooms.get(socket.roomCode);
        if (!room) return;

        const player = room.players.get(socket.id);
        if (!player) return;

        // Check if color is already taken by another player
        for (const [id, p] of room.players) {
            if (id !== socket.id && p.color === color) return;
        }

        player.color = color;
        io.to(socket.roomCode).emit('roomUpdate', getRoomInfo(socket.roomCode));
        if (callback) callback({ success: true });
    });

    socket.on('addAIPlayer', ({ difficulty }, callback) => {
        const room = rooms.get(socket.roomCode);
        if (!room || room.gameStarted) {
            return callback && callback({ success: false, error: 'Cannot add AI player' });
        }

        // Host-only
        const callerPlayer = room.players.get(socket.id);
        if (!callerPlayer || callerPlayer.sessionToken !== room.hostSessionToken) {
            return callback && callback({ success: false, error: 'Only the host can add AI players' });
        }

        // Room full check
        if (room.players.size >= room.maxPlayers) {
            return callback && callback({ success: false, error: 'Room is full' });
        }

        // Validate difficulty
        const validDifficulties = ['easy'];
        if (!difficulty || !validDifficulties.includes(difficulty)) {
            return callback && callback({ success: false, error: 'Invalid difficulty' });
        }

        // Count existing AI players for naming
        let aiCount = 0;
        for (const [, p] of room.players) {
            if (p.isAI) aiCount++;
        }

        const aiKey = `ai-${randomUUID()}`;
        const aiSessionToken = `ai-${randomUUID()}`;
        room.players.set(aiKey, {
            name: `AI ${aiCount + 1}`,
            color: null,
            sessionToken: aiSessionToken,
            isAI: true,
            difficulty
        });

        console.log(`AI player added to room ${socket.roomCode} (${difficulty})`);
        io.to(socket.roomCode).emit('roomUpdate', getRoomInfo(socket.roomCode));
        callback && callback({ success: true });
        broadcastRoomList();
    });

    socket.on('updateAIPlayer', ({ sessionToken, color, difficulty }, callback) => {
        const room = rooms.get(socket.roomCode);
        if (!room || room.gameStarted) {
            return callback && callback({ success: false, error: 'Cannot update AI player' });
        }

        // Host-only
        const callerPlayer = room.players.get(socket.id);
        if (!callerPlayer || callerPlayer.sessionToken !== room.hostSessionToken) {
            return callback && callback({ success: false, error: 'Only the host can update AI players' });
        }

        // Find the AI player
        let aiPlayer = null;
        for (const [, p] of room.players) {
            if (p.sessionToken === sessionToken && p.isAI) {
                aiPlayer = p;
                break;
            }
        }
        if (!aiPlayer) {
            return callback && callback({ success: false, error: 'AI player not found' });
        }

        // Update color if provided
        if (color !== undefined) {
            if (color !== null && !LOBBY_COLORS.includes(color)) {
                return callback && callback({ success: false, error: 'Invalid color' });
            }
            if (color !== null) {
                for (const [, p] of room.players) {
                    if (p.sessionToken !== sessionToken && p.color === color) {
                        return callback && callback({ success: false, error: 'Color already taken' });
                    }
                }
            }
            aiPlayer.color = color;
        }

        // Update difficulty if provided
        if (difficulty !== undefined) {
            const validDifficulties = ['easy'];
            if (!validDifficulties.includes(difficulty)) {
                return callback && callback({ success: false, error: 'Invalid difficulty' });
            }
            aiPlayer.difficulty = difficulty;
        }

        io.to(socket.roomCode).emit('roomUpdate', getRoomInfo(socket.roomCode));
        callback && callback({ success: true });
    });

    socket.on('removeAIPlayer', ({ sessionToken }, callback) => {
        const room = rooms.get(socket.roomCode);
        if (!room || room.gameStarted) {
            return callback && callback({ success: false, error: 'Cannot remove AI player' });
        }

        // Host-only
        const callerPlayer = room.players.get(socket.id);
        if (!callerPlayer || callerPlayer.sessionToken !== room.hostSessionToken) {
            return callback && callback({ success: false, error: 'Only the host can remove AI players' });
        }

        // Find and remove the AI player by sessionToken
        let removed = false;
        for (const [key, p] of room.players) {
            if (p.sessionToken === sessionToken && p.isAI) {
                room.players.delete(key);
                removed = true;
                console.log(`AI player removed from room ${socket.roomCode} (${p.color})`);
                break;
            }
        }

        if (!removed) {
            return callback && callback({ success: false, error: 'AI player not found' });
        }

        io.to(socket.roomCode).emit('roomUpdate', getRoomInfo(socket.roomCode));
        callback && callback({ success: true });
        broadcastRoomList();
    });

    socket.on('startGame', () => {
        const room = rooms.get(socket.roomCode);
        if (!room) return;
        // Host check: look up the socket's sessionToken and compare to hostSessionToken
        const callerPlayer = room.players.get(socket.id);
        if (!callerPlayer || callerPlayer.sessionToken !== room.hostSessionToken) return;

        // Need at least 2 total players (human + AI)
        if (room.players.size < 2) return;

        // Check all players have selected colors (humans must pick; AI always has one)
        for (const [, p] of room.players) {
            if (!p.color) return;
        }

        room.gameStarted = true;

        // Build player list using sessionTokens as ids
        // Include AI flags so createGameState sets up AI state
        const playerList = [];
        for (const [, p] of room.players) {
            const entry = { id: p.sessionToken, name: p.name, color: p.color };
            if (p.isAI) {
                entry.isAI = true;
                entry.difficulty = p.difficulty;
            }
            playerList.push(entry);
        }

        // Create authoritative game state on server
        room.gameState = createGameState(playerList);

        const humanCount = playerList.filter(p => !p.isAI).length;
        const aiCount = playerList.filter(p => p.isAI).length;
        console.log(`Game started in room ${socket.roomCode} with ${humanCount} human(s) and ${aiCount} AI player(s)`);
        console.log(`Deck has ${room.gameState.demandCardDeck.length} cards remaining`);

        // Send each human player their filtered game state
        for (const [socketId, p] of room.players) {
            if (p.isAI) continue; // AI players have no socket
            const state = getStateForPlayer(room.gameState, p.sessionToken, room.disconnectedPlayers);
            io.to(socketId).emit('gameStart', { state });
        }
        recordGame('multi');
        broadcastRoomList();

        // If the first player is AI, schedule their turn
        maybeScheduleAITurn(socket.roomCode, room);
    });

    // No-op: server now generates its own hex grid at game start (Step 0.4).
    // Kept for one release cycle so stale cached clients don't error.
    socket.on('setCityToMilepost', () => {});

    // Game action handler
    socket.on('action', (action, callback) => {
        const room = rooms.get(socket.roomCode);
        if (!room || !room.gameState) {
            return callback && callback({ success: false, error: 'No active game' });
        }

        const gs = room.gameState;
        // Look up the caller's sessionToken from the room's player map, then find in game state
        const callerEntry = room.players.get(socket.id);
        const callerSessionToken = callerEntry ? callerEntry.sessionToken : null;
        const playerIndex = gs.players.findIndex(p => p.id === callerSessionToken);
        if (playerIndex === -1) {
            return callback && callback({ success: false, error: 'Not a player in this game' });
        }

        switch (action.type) {
            case 'endTurn': {
                if (playerIndex !== gs.currentPlayerIndex) {
                    return callback && callback({ success: false, error: 'Not your turn' });
                }
                console.log(`Room ${socket.roomCode}: ${gs.players[playerIndex].name} ends turn`);
                const endTurnResult = aiActions.applyEndTurn(gs);
                broadcastStateUpdate(socket.roomCode, room, endTurnResult.uiEvent);

                // Execute pending save at turn boundary
                const saveData = executePendingSave(socket.roomCode, room);
                if (saveData) {
                    for (const [socketId, p] of room.players) {
                        const pColor = gs.players.find(gp => gp.id === p.sessionToken)?.color;
                        const seat = pColor && saveData.seats[pColor];
                        if (seat) {
                            io.to(socketId).emit('gameSaved', {
                                gameId: gs.gameId,
                                gameName: saveData.gameName,
                                savedAt: saveData.savedAt,
                                seatCode: seat.seatCode,
                                color: pColor
                            });
                        }
                    }
                    const seatMsg = formatSeatCodesForLog(saveData);
                    broadcastStateUpdate(socket.roomCode, room, { type: 'action', logs: [`Game saved (ID: ${gs.gameId})`, seatMsg] });
                }

                if (!endTurnResult.uiEvent.gameOver) {
                    maybeScheduleAITurn(socket.roomCode, room);
                    startTurnTimerIfNeeded(socket.roomCode, room);
                }
                callback && callback({ success: true });
                break;
            }

            case 'upgradeTo': {
                if (playerIndex !== gs.currentPlayerIndex) {
                    return callback && callback({ success: false, error: 'Not your turn' });
                }
                const upgradeResult = aiActions.applyUpgradeTo(gs, playerIndex, { trainType: action.trainType });
                if (!upgradeResult.success) {
                    return callback && callback({ success: false, error: upgradeResult.error });
                }
                console.log(`Room ${socket.roomCode}: ${upgradeResult.logs[0]}`);
                broadcastStateUpdate(socket.roomCode, room, upgradeResult.uiEvent);
                callback && callback({ success: true });
                break;
            }

            case 'pickupGood': {
                if (playerIndex !== gs.currentPlayerIndex) {
                    return callback && callback({ success: false, error: 'Not your turn' });
                }
                const pickupResult = aiActions.applyPickupGood(gs, playerIndex, { good: action.good });
                if (!pickupResult.success) {
                    return callback && callback({ success: false, error: pickupResult.error });
                }
                console.log(`Room ${socket.roomCode}: ${pickupResult.logs[0]}`);
                broadcastStateUpdate(socket.roomCode, room, pickupResult.uiEvent);
                callback && callback({ success: true });
                break;
            }

            case 'dropGood': {
                if (playerIndex !== gs.currentPlayerIndex) {
                    return callback && callback({ success: false, error: 'Not your turn' });
                }
                const dropResult = aiActions.applyDropGood(gs, playerIndex, { loadIndex: action.loadIndex });
                if (!dropResult.success) {
                    return callback && callback({ success: false, error: dropResult.error });
                }
                console.log(`Room ${socket.roomCode}: ${dropResult.logs[0]}`);
                broadcastStateUpdate(socket.roomCode, room, dropResult.uiEvent);
                callback && callback({ success: true });
                break;
            }

            case 'deliverGood': {
                if (playerIndex !== gs.currentPlayerIndex) {
                    return callback && callback({ success: false, error: 'Not your turn' });
                }
                const deliverResult = aiActions.applyDeliverGood(gs, playerIndex, { cardIndex: action.cardIndex, demandIndex: action.demandIndex });
                if (!deliverResult.success) {
                    return callback && callback({ success: false, error: deliverResult.error });
                }
                console.log(`Room ${socket.roomCode}: ${deliverResult.logs[0]}`);
                broadcastStateUpdate(socket.roomCode, room, deliverResult.uiEvent);
                callback && callback({ success: true });
                break;
            }

            case 'commitBuild': {
                if (playerIndex !== gs.currentPlayerIndex) {
                    return callback && callback({ success: false, error: 'Not your turn' });
                }
                const buildResult = aiActions.applyCommitBuild(gs, playerIndex, {
                    buildPath: action.buildPath,
                    buildCost: action.buildCost,
                    majorCityCount: action.majorCityCount,
                    ferries: action.ferries
                });
                if (!buildResult.success) {
                    return callback && callback({ success: false, error: buildResult.error });
                }
                console.log(`Room ${socket.roomCode}: ${buildResult.logs[0]}`);
                broadcastStateUpdate(socket.roomCode, room, buildResult.uiEvent);
                callback && callback({ success: true });
                break;
            }

            case 'deployTrain': {
                if (playerIndex !== gs.currentPlayerIndex) {
                    return callback && callback({ success: false, error: 'Not your turn' });
                }
                const deployResult = aiActions.applyDeployTrain(gs, playerIndex, { milepostId: action.milepostId });
                if (!deployResult.success) {
                    return callback && callback({ success: false, error: deployResult.error });
                }
                console.log(`Room ${socket.roomCode}: ${deployResult.logs[0]}`);
                broadcastStateUpdate(socket.roomCode, room, deployResult.uiEvent);
                callback && callback({ success: true });
                break;
            }

            case 'discardHand': {
                if (playerIndex !== gs.currentPlayerIndex) {
                    return callback && callback({ success: false, error: 'Not your turn' });
                }
                console.log(`Room ${socket.roomCode}: ${gs.players[playerIndex].name} discarded hand`);
                const discardResult = aiActions.applyDiscardHand(gs, playerIndex);
                broadcastStateUpdate(socket.roomCode, room, discardResult.uiEvent);

                // Execute pending save at turn boundary (discardHand ends the turn)
                const discardSaveData = executePendingSave(socket.roomCode, room);
                if (discardSaveData) {
                    for (const [socketId, p] of room.players) {
                        const pColor = gs.players.find(gp => gp.id === p.sessionToken)?.color;
                        const seat = pColor && discardSaveData.seats[pColor];
                        if (seat) {
                            io.to(socketId).emit('gameSaved', {
                                gameId: gs.gameId,
                                gameName: discardSaveData.gameName,
                                savedAt: discardSaveData.savedAt,
                                seatCode: seat.seatCode,
                                color: pColor
                            });
                        }
                    }
                    const discardSeatMsg = formatSeatCodesForLog(discardSaveData);
                    broadcastStateUpdate(socket.roomCode, room, { type: 'action', logs: [`Game saved (ID: ${gs.gameId})`, discardSeatMsg] });
                }

                if (!discardResult.uiEvent.gameOver) {
                    maybeScheduleAITurn(socket.roomCode, room);
                    startTurnTimerIfNeeded(socket.roomCode, room);
                }
                callback && callback({ success: true });
                break;
            }

            case 'endOperatePhase': {
                if (playerIndex !== gs.currentPlayerIndex) {
                    return callback && callback({ success: false, error: 'Not your turn' });
                }
                const endOpResult = aiActions.applyEndOperatePhase(gs, playerIndex);
                if (!endOpResult.success) {
                    return callback && callback({ success: false, error: endOpResult.error });
                }
                console.log(`Room ${socket.roomCode}: ${endOpResult.logs[0]}`);
                broadcastStateUpdate(socket.roomCode, room, endOpResult.uiEvent);
                callback && callback({ success: true });
                break;
            }

            case 'undoBuild': {
                if (playerIndex !== gs.currentPlayerIndex) {
                    return callback && callback({ success: false, error: 'Not your turn' });
                }
                const undoBuildResult = aiActions.applyUndoBuild(gs, playerIndex);
                if (!undoBuildResult.success) {
                    return callback && callback({ success: false, error: undoBuildResult.error });
                }
                console.log(`Room ${socket.roomCode}: ${undoBuildResult.logs[0]}`);
                broadcastStateUpdate(socket.roomCode, room, undoBuildResult.uiEvent);
                callback && callback({ success: true });
                break;
            }

            case 'commitMove': {
                if (playerIndex !== gs.currentPlayerIndex) {
                    return callback && callback({ success: false, error: 'Not your turn' });
                }
                const moveResult = aiActions.applyCommitMove(gs, playerIndex, { path: action.path });
                if (!moveResult.success) {
                    return callback && callback({ success: false, error: moveResult.error });
                }
                console.log(`Room ${socket.roomCode}: ${gs.players[playerIndex].name} ${moveResult.logs[moveResult.logs.length - 1]}`);
                broadcastStateUpdate(socket.roomCode, room, moveResult.uiEvent);
                callback && callback({ success: true });
                break;
            }

            case 'undoMove': {
                if (playerIndex !== gs.currentPlayerIndex) {
                    return callback && callback({ success: false, error: 'Not your turn' });
                }
                const undoMoveResult = aiActions.applyUndoMove(gs, playerIndex);
                if (!undoMoveResult.success) {
                    return callback && callback({ success: false, error: undoMoveResult.error });
                }
                console.log(`Room ${socket.roomCode}: ${undoMoveResult.logs[0]}`);
                broadcastStateUpdate(socket.roomCode, room, undoMoveResult.uiEvent);
                callback && callback({ success: true });
                break;
            }

            default:
                callback && callback({ success: false, error: `Unknown action: ${action.type}` });
        }
    });

    // Step 3: Rejoin a game in progress using session token
    socket.on('rejoinGame', ({ roomCode, sessionToken }, callback) => {
        if (typeof roomCode !== 'string' || typeof sessionToken !== 'string') {
            return callback && callback({ success: false, error: 'Invalid parameters' });
        }
        const code = roomCode.toUpperCase();
        const room = rooms.get(code);

        if (!room) {
            return callback && callback({ success: false, error: 'Room not found' });
        }
        if (!room.gameStarted) {
            return callback && callback({ success: false, error: 'Game not started' });
        }

        // Must be in disconnectedPlayers
        const disconnected = room.disconnectedPlayers.get(sessionToken);
        if (!disconnected) {
            return callback && callback({ success: false, error: 'No disconnected player with that session' });
        }

        // Cancel grace timer
        const graceTimer = room.graceTimers.get(sessionToken);
        if (graceTimer) {
            clearTimeout(graceTimer);
            room.graceTimers.delete(sessionToken);
        }

        // Cancel turn timer
        const turnTimer = room.turnTimers.get(sessionToken);
        if (turnTimer) {
            clearTimeout(turnTimer);
            room.turnTimers.delete(sessionToken);
            io.to(code).emit('turnTimerCancelled', {
                playerName: disconnected.name,
                sessionToken,
            });
        }

        // Broadcast to other players BEFORE this socket joins the room
        // so the reconnecting player doesn't receive their own event
        io.to(code).emit('playerReconnected', {
            sessionToken,
            playerName: disconnected.name,
        });

        // Move back from disconnectedPlayers to active players
        room.disconnectedPlayers.delete(sessionToken);
        room.players.set(socket.id, {
            name: disconnected.name,
            color: disconnected.color,
            sessionToken,
        });
        room.sessionToSocketId.set(sessionToken, socket.id);
        socket.join(code);
        socket.roomCode = code;

        const reconnectMsg = `${disconnected.name} reconnected`;
        if (room.gameState) {
            room.gameState.gameLog.push(reconnectMsg);
        }
        console.log(`Room ${code}: ${reconnectMsg}`);

        // Send current state to reconnected player
        const state = getStateForPlayer(room.gameState, sessionToken, room.disconnectedPlayers);
        callback && callback({ success: true, state });

        // Resume AI turns if it's an AI player's turn (AI pauses when no human is connected)
        maybeScheduleAITurn(code, room);

        broadcastRoomList();
    });

    // --- Save & Resume socket handlers ---

    socket.on('syncSelectedDemands', ({ selectedDemands }) => {
        const room = rooms.get(socket.roomCode);
        if (!room || !room.gameState) return;
        if (!Array.isArray(selectedDemands) || selectedDemands.length !== 3) return;
        const player = room.players.get(socket.id);
        if (!player) return;
        const gsPlayer = room.gameState.players.find(p => p.id === player.sessionToken);
        if (gsPlayer) {
            gsPlayer.selectedDemands = selectedDemands;
        }
    });

    socket.on('saveGame', ({ gameName }, callback) => {
        const roomCode = socket.roomCode;
        const room = roomCode && rooms.get(roomCode);
        if (!room || !room.gameStarted || !room.gameState) {
            return callback && callback({ success: false, error: 'No active game' });
        }

        const player = room.players.get(socket.id);
        if (!player) {
            return callback && callback({ success: false, error: 'Not a player in this game' });
        }

        const gs = room.gameState;
        const playerIndex = gs.players.findIndex(p => p.id === player.sessionToken);
        if (playerIndex === -1) {
            return callback && callback({ success: false, error: 'Player not found in game state' });
        }

        // If it's the end of a turn (between turns), save immediately.
        // Otherwise, queue the save for after the current turn ends.
        const isCurrentPlayersTurn = playerIndex === gs.currentPlayerIndex;
        const isTurnBoundary = !isCurrentPlayersTurn ||
            (gs.phase === 'build' && gs.buildingThisTurn === 0 && gs.buildHistory.length === 0) ||
            (gs.phase === 'operate' && gs.operateHistory.length === 0);

        if (isTurnBoundary && !isCurrentPlayersTurn) {
            // Safe to save immediately — no mid-turn state
            const saveData = serializeForSave(gs, gameName);
            writeSaveFile(saveData);
            const msg = `Game saved (ID: ${gs.gameId})`;
            const seatMsg = formatSeatCodesForLog(saveData);
            gs.gameLog.push(msg);
            gs.gameLog.push(seatMsg);
            console.log(`Room ${roomCode}: ${msg}`);

            // Send each connected player their own seat code
            for (const [socketId, p] of room.players) {
                const pColor = gs.players.find(gp => gp.id === p.sessionToken)?.color;
                const seat = pColor && saveData.seats[pColor];
                if (seat) {
                    io.to(socketId).emit('gameSaved', {
                        gameId: gs.gameId,
                        gameName: saveData.gameName,
                        savedAt: saveData.savedAt,
                        seatCode: seat.seatCode,
                        color: pColor
                    });
                }
            }

            broadcastStateUpdate(roomCode, room, { type: 'action', logs: [msg, seatMsg] });
            callback && callback({ success: true, message: 'Game saved.' });
        } else {
            // Queue save for end of turn
            room.pendingSave = { gameName: gameName || null };
            const msg = 'Game will be saved at end of current turn.';
            gs.gameLog.push(msg);
            console.log(`Room ${roomCode}: Save queued`);
            broadcastStateUpdate(roomCode, room, { type: 'action', logs: [msg] });
            callback && callback({ success: true, message: msg });
        }
    });

    socket.on('listSavedGames', (callback) => {
        const saves = listSaveFiles();
        callback && callback({ success: true, saves });
    });

    socket.on('checkSavedGames', (gameIds, callback) => {
        if (!Array.isArray(gameIds)) {
            return callback && callback({ success: false, error: 'Expected array of game IDs' });
        }
        const valid = gameIds.filter(id =>
            typeof id === 'string' && fs.existsSync(path.join(SAVES_DIR, `${id}.json`))
        );
        callback && callback({ success: true, validGameIds: valid });
    });

    socket.on('resumeGame', ({ gameId, seatCode }, callback) => {
        if (!gameId || typeof gameId !== 'string' || !seatCode || typeof seatCode !== 'string') {
            return callback && callback({ success: false, error: 'Invalid parameters' });
        }

        // Read save file and validate seat code
        let saveData;
        try {
            saveData = readSaveFile(gameId);
        } catch (e) {
            return callback && callback({ success: false, error: 'Save file is corrupt' });
        }
        if (!saveData) {
            return callback && callback({ success: false, error: 'Save file not found' });
        }

        const color = validateSeatCode(saveData, seatCode);
        if (!color) {
            return callback && callback({ success: false, error: 'Invalid seat code' });
        }

        // Check if this game is already loaded into a room
        let roomCode = resumingGames.get(gameId);
        let room = roomCode ? rooms.get(roomCode) : null;

        // If the room was cleaned up, clear stale entry
        if (roomCode && !room) {
            resumingGames.delete(gameId);
            roomCode = null;
        }

        if (!room) {
            // Load game into a new room
            const loadedState = loadGameStateFromSave(saveData);
            roomCode = getUniqueRoomCode();

            room = {
                players: new Map(),
                hostSessionToken: null, // set to first player who joins
                sessionToSocketId: new Map(),
                disconnectedPlayers: new Map(),
                graceTimers: new Map(),
                turnTimers: new Map(),
                gameStarted: false, // will be set true once all seats filled
                gameState: loadedState,
                maxPlayers: saveData.state.players.filter(p => !p.abandoned && !p.isAI).length,
                password: null,
                resuming: true, // flag to indicate this room is in resume-waiting state
                saveData: saveData, // keep save data for seat code validation
                seatedPlayers: new Map(), // color -> sessionToken (tracks who has claimed which seat)
                lastActivity: Date.now()
            };

            rooms.set(roomCode, room);
            resumingGames.set(gameId, roomCode);
            console.log(`Room ${roomCode} created for resumed game ${gameId}`);
        }

        // Check if this seat is already taken
        if (room.seatedPlayers && room.seatedPlayers.has(color)) {
            return callback && callback({ success: false, error: 'This seat is already taken' });
        }

        // Assign this player to their seat
        const sessionToken = randomUUID();
        const playerData = saveData.seats[color];

        room.players.set(socket.id, { name: playerData.name, color, sessionToken });
        room.sessionToSocketId.set(sessionToken, socket.id);
        room.seatedPlayers.set(color, sessionToken);

        // Update the game state player's id to the new session token
        const gsPlayer = room.gameState.players.find(p => p.color === color);
        if (gsPlayer) {
            gsPlayer.id = sessionToken;
        }

        // First player to join becomes host
        if (!room.hostSessionToken) {
            room.hostSessionToken = sessionToken;
        }

        socket.join(roomCode);
        socket.roomCode = roomCode;

        console.log(`Room ${roomCode}: ${playerData.name} (${color}) seated [${room.seatedPlayers.size}/${room.maxPlayers}]`);

        // Check if all non-abandoned seats are now filled
        const allSeated = room.seatedPlayers.size >= room.maxPlayers;

        if (allSeated) {
            // All players are here — start the game
            room.gameStarted = true;
            room.resuming = false;
            resumingGames.delete(gameId);
            delete room.saveData;
            delete room.seatedPlayers;

            const resumeMsg = 'Game resumed from save';
            room.gameState.gameLog.push(resumeMsg);
            room.gameState.gameStarted = true;

            console.log(`Room ${roomCode}: All players seated, game resumed`);

            // Send each human player their filtered game state
            for (const [socketId, p] of room.players) {
                if (p.isAI) continue;
                const state = getStateForPlayer(room.gameState, p.sessionToken, room.disconnectedPlayers);
                io.to(socketId).emit('gameResumed', { state });
            }
            broadcastRoomList();

            // Schedule AI turn if current player is AI
            maybeScheduleAITurn(roomCode, room);
        } else {
            // Notify all players in the room about the updated waiting room state
            const waitingInfo = getResumeWaitingInfo(roomCode);
            io.to(roomCode).emit('resumeWaitingUpdate', waitingInfo);
        }

        const response = {
            success: true,
            roomCode,
            sessionToken,
            color,
            playerName: playerData.name,
            allSeated
        };
        // Include state in callback for the triggering player so they don't
        // depend on the gameResumed event arriving after myPlayerId is set.
        if (allSeated) {
            response.state = getStateForPlayer(room.gameState, sessionToken, room.disconnectedPlayers);
        }
        callback && callback(response);
    });

    socket.on('resumeForceStart', (callback) => {
        const roomCode = socket.roomCode;
        const room = roomCode && rooms.get(roomCode);
        if (!room || !room.resuming) {
            return callback && callback({ success: false, error: 'No resuming game' });
        }

        // Only host can force start
        const callerPlayer = room.players.get(socket.id);
        if (!callerPlayer || callerPlayer.sessionToken !== room.hostSessionToken) {
            return callback && callback({ success: false, error: 'Only the host can force start' });
        }

        // Mark unseated players as abandoned
        const gameId = room.gameState.gameId;
        for (const p of room.gameState.players) {
            if (!p.abandoned && !p.isAI && !room.seatedPlayers.has(p.color)) {
                p.abandoned = true;
                console.log(`Room ${roomCode}: ${p.name} (${p.color}) marked abandoned on force start`);
            }
        }

        room.gameStarted = true;
        room.resuming = false;
        resumingGames.delete(gameId);
        delete room.saveData;
        delete room.seatedPlayers;

        const resumeMsg = 'Game resumed from save (some seats abandoned)';
        room.gameState.gameLog.push(resumeMsg);
        room.gameState.gameStarted = true;

        console.log(`Room ${roomCode}: Force started with ${room.players.size} of ${room.maxPlayers} players`);

        for (const [socketId, p] of room.players) {
            if (p.isAI) continue;
            const state = getStateForPlayer(room.gameState, p.sessionToken, room.disconnectedPlayers);
            io.to(socketId).emit('gameResumed', { state });
        }
        broadcastRoomList();
        maybeScheduleAITurn(roomCode, room);
        callback && callback({ success: true });
    });

    socket.on('leaveResumeWaiting', () => {
        const roomCode = socket.roomCode;
        const room = roomCode && rooms.get(roomCode);
        if (!room || !room.resuming) return;

        const player = room.players.get(socket.id);
        if (!player) return;

        // Remove from seated players
        if (room.seatedPlayers) {
            room.seatedPlayers.delete(player.color);
        }

        // Restore original player id in game state
        const gsPlayer = room.gameState.players.find(p => p.color === player.color);
        if (gsPlayer) {
            gsPlayer.id = player.color; // reset to a placeholder
        }

        room.sessionToSocketId.delete(player.sessionToken);
        room.players.delete(socket.id);
        socket.leave(roomCode);
        socket.roomCode = null;

        // Transfer host if needed
        if (room.hostSessionToken === player.sessionToken) {
            const nextPlayer = room.players.values().next().value;
            room.hostSessionToken = nextPlayer ? nextPlayer.sessionToken : null;
        }

        // If room is empty, clean up
        if (room.players.size === 0) {
            const gameId = room.gameState.gameId;
            rooms.delete(roomCode);
            resumingGames.delete(gameId);
            console.log(`Room ${roomCode} deleted (resume waiting room emptied)`);
        } else {
            const waitingInfo = getResumeWaitingInfo(roomCode);
            io.to(roomCode).emit('resumeWaitingUpdate', waitingInfo);
        }
        broadcastRoomList();
    });

    socket.on('disconnect', () => {
        const roomCode = socket.roomCode;
        if (!roomCode) return;

        const room = rooms.get(roomCode);
        if (!room) return;

        const player = room.players.get(socket.id);
        console.log(`${player?.name || 'Unknown'} disconnected from room ${roomCode}`);

        if (!player) return;

        // --- Resume waiting room disconnect ---
        if (room.resuming) {
            if (room.seatedPlayers) {
                room.seatedPlayers.delete(player.color);
            }
            // Restore placeholder id in game state
            const gsPlayer = room.gameState.players.find(p => p.color === player.color);
            if (gsPlayer) gsPlayer.id = player.color;

            room.sessionToSocketId.delete(player.sessionToken);
            room.players.delete(socket.id);

            if (room.hostSessionToken === player.sessionToken) {
                const nextPlayer = room.players.values().next().value;
                room.hostSessionToken = nextPlayer ? nextPlayer.sessionToken : null;
            }

            if (room.players.size === 0) {
                const gameId = room.gameState.gameId;
                rooms.delete(roomCode);
                resumingGames.delete(gameId);
                console.log(`Room ${roomCode} deleted (resume waiting room emptied)`);
            } else {
                const waitingInfo = getResumeWaitingInfo(roomCode);
                io.to(roomCode).emit('resumeWaitingUpdate', waitingInfo);
            }
            broadcastRoomList();
            return;
        }

        // --- Lobby disconnect (game not started) ---
        if (!room.gameStarted) {
            room.sessionToSocketId.delete(player.sessionToken);
            room.players.delete(socket.id);

            // Check if any human players remain
            let hasHumans = false;
            for (const [, p] of room.players) {
                if (!p.isAI) { hasHumans = true; break; }
            }

            if (room.players.size === 0 || !hasHumans) {
                rooms.delete(roomCode);
                console.log(`Room ${roomCode} deleted (${room.players.size === 0 ? 'empty' : 'no humans remaining'})`);
            } else {
                // Transfer host if host left (to next human)
                if (room.hostSessionToken === player.sessionToken) {
                    for (const [, p] of room.players) {
                        if (!p.isAI) {
                            room.hostSessionToken = p.sessionToken;
                            break;
                        }
                    }
                }
                io.to(roomCode).emit('roomUpdate', getRoomInfo(roomCode));
            }
            broadcastRoomList();
            return;
        }

        // --- In-game disconnect (game started) ---
        room.sessionToSocketId.delete(player.sessionToken);
        room.players.delete(socket.id);

        // Move player to disconnectedPlayers keyed by sessionToken
        room.disconnectedPlayers.set(player.sessionToken, {
            name: player.name,
            color: player.color,
            sessionToken: player.sessionToken,
        });

        // Log to gameState
        const disconnectMsg = `${player.name} disconnected`;
        if (room.gameState) {
            room.gameState.gameLog.push(disconnectMsg);
        }
        console.log(`${player.name} disconnected from in-game room ${roomCode} (grace period started)`);

        // Broadcast playerDisconnected to remaining players
        io.to(roomCode).emit('playerDisconnected', {
            sessionToken: player.sessionToken,
            playerName: player.name,
        });

        // If no human players remain connected, clean up immediately
        let hasConnectedHumans = false;
        for (const [, p] of room.players) {
            if (!p.isAI) { hasConnectedHumans = true; break; }
        }
        if (!hasConnectedHumans) {
            for (const timer of room.graceTimers.values()) clearTimeout(timer);
            for (const timer of room.turnTimers.values()) clearTimeout(timer);
            if (room.aiTurnTimer) { clearTimeout(room.aiTurnTimer); room.aiTurnTimer = null; }
            rooms.delete(roomCode);
            console.log(`Room ${roomCode} deleted (all human players disconnected)`);
            broadcastRoomList();
            return;
        }

        // Transfer host if host disconnected in-game (to next connected human)
        if (room.hostSessionToken === player.sessionToken && room.players.size > 0) {
            let nextHost = null;
            for (const [, p] of room.players) {
                if (!p.isAI) { nextHost = p; break; }
            }
            if (!nextHost) nextHost = room.players.values().next().value; // fallback
            const oldHostToken = room.hostSessionToken;
            room.hostSessionToken = nextHost.sessionToken;

            const transferMsg = `Host transferred to ${nextHost.name}`;
            if (room.gameState) {
                room.gameState.gameLog.push(transferMsg);
            }
            console.log(`Room ${roomCode}: ${transferMsg}`);

            io.to(roomCode).emit('hostTransferred', {
                oldHostSessionToken: oldHostToken,
                newHostSessionToken: nextHost.sessionToken,
                newHostName: nextHost.name,
            });
        }

        // Start grace period timer
        const graceTimer = setTimeout(() => {
            expirePlayer(roomCode, player.sessionToken);
        }, DISCONNECT_GRACE_MS);

        // Store timer so it can be cancelled on reconnection
        room.graceTimers.set(player.sessionToken, graceTimer);

        // Step 3: If it's this player's turn, start a turn timer
        if (room.gameState) {
            const gs = room.gameState;
            const playerIndex = gs.players.findIndex(p => p.id === player.sessionToken);
            if (playerIndex === gs.currentPlayerIndex) {
                io.to(roomCode).emit('turnTimerStarted', {
                    playerName: player.name,
                    expiresIn: TURN_TIMER_MS,
                });

                const turnTimer = setTimeout(() => {
                    expireTurn(roomCode, player.sessionToken);
                }, TURN_TIMER_MS);

                room.turnTimers.set(player.sessionToken, turnTimer);
            }
        }

        broadcastRoomList();
    });
});

// Helper: if the new current player is disconnected, start a turn timer for them.
// Called after any serverEndTurn() to handle the case where the next player is offline.
function startTurnTimerIfNeeded(roomCode, room) {
    const gs = room.gameState;
    if (!gs) return;
    const newCurrentPlayer = gs.players[gs.currentPlayerIndex];
    if (!newCurrentPlayer) return;
    // AI players don't need turn timers — they play automatically
    if (newCurrentPlayer.isAI) return;
    if (!room.disconnectedPlayers.has(newCurrentPlayer.id)) return;

    // Only start if there's at least one connected player (avoid pointless cycling)
    const hasConnectedPlayer = gs.players.some(p =>
        !p.abandoned && !room.disconnectedPlayers.has(p.id)
    );
    if (!hasConnectedPlayer) return;

    // Clear any existing timer for this player to avoid duplicates
    const existingTimer = room.turnTimers.get(newCurrentPlayer.id);
    if (existingTimer) {
        clearTimeout(existingTimer);
    }

    io.to(roomCode).emit('turnTimerStarted', {
        playerName: newCurrentPlayer.name,
        expiresIn: TURN_TIMER_MS,
    });
    const turnTimer = setTimeout(() => {
        expireTurn(roomCode, newCurrentPlayer.id);
    }, TURN_TIMER_MS);
    room.turnTimers.set(newCurrentPlayer.id, turnTimer);
}

// Called when a disconnected current player's turn timer expires
function expireTurn(roomCode, sessionToken) {
    const room = rooms.get(roomCode);
    if (!room || !room.gameState) return;

    // Clean up turn timer reference
    room.turnTimers.delete(sessionToken);

    const gs = room.gameState;
    const playerIndex = gs.players.findIndex(p => p.id === sessionToken);

    // Only act if it's still this player's turn (they haven't reconnected and ended turn)
    if (playerIndex !== gs.currentPlayerIndex) return;

    const player = gs.players[playerIndex];
    const msg = `${player.name}'s turn was auto-skipped (disconnected)`;
    gs.gameLog.push(msg);
    console.log(`Room ${roomCode}: ${msg}`);

    io.to(roomCode).emit('turnTimerExpired', {
        playerName: player.name,
    });

    const result = serverEndTurn(gs);
    broadcastStateUpdate(roomCode, room, {
        type: 'turnChanged',
        overlay: result.overlay,
        logs: [...result.logs, msg],
    });

    maybeScheduleAITurn(roomCode, room);
    startTurnTimerIfNeeded(roomCode, room);
}

// Called when a disconnected player's grace period expires without reconnection
function expirePlayer(roomCode, sessionToken) {
    const room = rooms.get(roomCode);
    if (!room || !room.gameState) return;

    // Clean up grace timer reference
    if (room.graceTimers) {
        room.graceTimers.delete(sessionToken);
    }

    // Remove from disconnectedPlayers
    const disconnected = room.disconnectedPlayers.get(sessionToken);
    if (!disconnected) return; // already reconnected or expired

    room.disconnectedPlayers.delete(sessionToken);

    // Mark player as abandoned in gameState
    const gs = room.gameState;
    const player = gs.players.find(p => p.id === sessionToken);
    if (player) {
        player.abandoned = true;
        const msg = `${player.name} has been disconnected too long and is now abandoned`;
        gs.gameLog.push(msg);
        console.log(`Room ${roomCode}: ${msg}`);
    }

    // Broadcast playerAbandoned to remaining connected players
    io.to(roomCode).emit('playerAbandoned', {
        sessionToken,
        playerName: disconnected.name,
    });

    // If all human players are abandoned, delete the room — don't let AI play alone
    const allHumansAbandoned = gs.players.every(p => p.isAI || p.abandoned);
    if (allHumansAbandoned) {
        for (const timer of room.graceTimers.values()) {
            clearTimeout(timer);
        }
        for (const timer of room.turnTimers.values()) {
            clearTimeout(timer);
        }
        if (room.aiTurnTimer) {
            clearTimeout(room.aiTurnTimer);
            room.aiTurnTimer = null;
        }
        rooms.delete(roomCode);
        console.log(`Room ${roomCode} deleted (all human players abandoned)`);
        broadcastRoomList();
        return;
    }

    // Clear any pending turn timer for the abandoned player
    const turnTimer = room.turnTimers.get(sessionToken);
    if (turnTimer) {
        clearTimeout(turnTimer);
        room.turnTimers.delete(sessionToken);
    }

    // If it's the abandoned player's turn, auto-end it
    if (player && gs.currentPlayerIndex === gs.players.indexOf(player)) {
        const result = serverEndTurn(gs);
        broadcastStateUpdate(roomCode, room, {
            type: 'turnChanged',
            overlay: result.overlay,
            logs: [...result.logs, `${player.name}'s turn was auto-skipped (abandoned)`],
        });

        maybeScheduleAITurn(roomCode, room);
        startTurnTimerIfNeeded(roomCode, room);
    }
}


function getResumeWaitingInfo(roomCode) {
    const room = rooms.get(roomCode);
    if (!room || !room.resuming) return null;

    const seats = [];
    for (const p of room.gameState.players) {
        if (p.abandoned || p.isAI) continue;
        const claimed = room.seatedPlayers.has(p.color);
        seats.push({
            color: p.color,
            name: p.name,
            claimed,
            isYou: false // client will fill this in
        });
    }

    return {
        roomCode,
        gameId: room.gameState.gameId,
        seats,
        hostSessionToken: room.hostSessionToken,
        seatedCount: room.seatedPlayers.size,
        totalSeats: room.maxPlayers
    };
}

function getRoomInfo(roomCode) {
    const room = rooms.get(roomCode);
    if (!room) return null;

    const players = [];
    for (const [, p] of room.players) {
        const entry = { id: p.sessionToken, name: p.name, color: p.color, isHost: p.sessionToken === room.hostSessionToken, isAI: p.isAI || false };
        if (p.isAI) entry.difficulty = p.difficulty;
        players.push(entry);
    }
    return { roomCode, players, hostSessionToken: room.hostSessionToken, maxPlayers: room.maxPlayers, password: room.password || null };
}

function getRoomList() {
    const list = [];
    for (const [roomCode, room] of rooms) {
        // Find host by sessionToken
        let hostName = 'Unknown';
        for (const [, p] of room.players) {
            if (p.sessionToken === room.hostSessionToken) {
                hostName = p.name;
                break;
            }
        }
        // For started games, show total game players; for lobbies, show current/max
        const totalGamePlayers = room.gameState ? room.gameState.players.length : null;
        list.push({
            roomCode,
            hostName,
            hasPassword: !!room.password,
            maxPlayers: totalGamePlayers || room.maxPlayers,
            playerCount: room.players.size,
            gameStarted: room.gameStarted
        });
    }
    return list;
}

function broadcastRoomList() {
    io.emit('roomListUpdate', getRoomList());
}

// --- Idle Room Cleanup ---

setInterval(() => {
    const now = Date.now();
    for (const [roomCode, room] of rooms) {
        if (now - (room.lastActivity || 0) < ROOM_IDLE_MS) continue;

        console.log(`Room ${roomCode} deleted (idle for ${Math.round((now - (room.lastActivity || 0)) / 60000)} minutes)`);

        // Clean up timers
        if (room.graceTimers) {
            for (const timer of room.graceTimers.values()) clearTimeout(timer);
        }
        if (room.turnTimers) {
            for (const timer of room.turnTimers.values()) clearTimeout(timer);
        }
        if (room.aiTurnTimer) clearTimeout(room.aiTurnTimer);

        rooms.delete(roomCode);
    }
    if (rooms.size > 0) broadcastRoomList();
}, ROOM_IDLE_MS);

// --- Start Server ---

fs.mkdirSync(SAVES_DIR, { recursive: true });

const listener = server.listen(PORT, () => {
    console.log(`Eurorails server running at http://localhost:${PORT}`);
});

module.exports = {
    listener, rooms, serverApplyEventEffect, applyDerailmentToPlayer,
    // Save & Resume exports (for testing)
    serializeForSave, validateSaveFile, loadGameStateFromSave, validateSeatCode,
    generateSeatCodes, readSaveFile, writeSaveFile, listSaveFiles
};
