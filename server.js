const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const { randomUUID } = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const DISCONNECT_GRACE_MS = parseInt(process.env.DISCONNECT_GRACE_MS) || 300000; // 5 minutes
const TURN_TIMER_MS = parseInt(process.env.TURN_TIMER_MS) || 90000; // 90 seconds

// Redirect root to the game
app.get('/', (req, res) => {
    res.redirect('/eurorails.html');
});

// Serve static files from public/
app.use(express.static(path.join(__dirname, 'public')));

// --- Game Constants (shared with client) ---

const MAJOR_CITIES = ["Amsterdam", "Berlin", "Essen", "London", "Madrid", "Milano", "Paris", "Vienna"];

const CITIES = {
    "Aberdeen": { x: 29.5, y: 13, type: "small", goods: ["Fish", "Oil"], country: "UK" },
    "Glasgow": { x: 27, y: 17, type: "small", goods: ["Sheep"], country: "UK" },
    "Belfast": { x: 22, y: 19, type: "small", goods: ["Potatoes"], country: "UK" },
    "Edinburgh": { x: 29, y: 17.5, type: "small", goods: [], country: "UK" },
    "Newcastle": { x: 30.5, y: 21, type: "small", goods: ["Oil"], country: "UK" },
    "Dublin": { x: 19, y: 24, type: "small", goods: ["Beer"], country: "Ireland" },
    "Manchester": { x: 30, y: 25, type: "medium", goods: ["Cars"], country: "UK" },
    "Birmingham": { x: 30.5, y: 28, type: "medium", goods: ["China", "Iron", "Steel", "Chocolate"], country: "UK" },
    "Cardiff": { x: 28, y: 30, type: "small", goods: ["Coal", "Hops"], country: "UK" },
    "London": { x: 33, y: 30, type: "major", goods: ["Tourists"], country: "UK" },
    "Cork": { x: 17, y: 29, type: "small", goods: ["Cork", "Sheep"], country: "Ireland" },
    "Oslo": { x: 44, y: 8, type: "medium", goods: ["Fish", "Oil", "Wood"], country: "Norway" },
    "Stockholm": { x: 53, y: 9, type: "medium", goods: ["Iron"], country: "Sweden" },
    "Göteborg": { x: 47, y: 13, type: "medium", goods: ["Machinery"], country: "Sweden" },
    "København": { x: 48, y: 19, type: "medium", goods: ["Cheese"], country: "Denmark" },
    "Århus": { x: 45.5, y: 17, type: "small", goods: ["Cheese"], country: "Denmark" },
    "Amsterdam": { x: 38, y: 27, type: "major", goods: ["Flowers", "Cheese"], country: "Netherlands" },
    "Antwerpen": { x: 38.5, y: 30, type: "medium", goods: ["Imports"], country: "Belgium" },
    "Bruxelles": { x: 38, y: 32, type: "medium", goods: ["Chocolate"], country: "Belgium" },
    "Luxembourg": { x: 40, y: 35, type: "small", goods: ["Steel"], country: "Luxembourg" },
    "Hamburg": { x: 44, y: 22, type: "medium", goods: ["Imports"], country: "Germany" },
    "Bremen": { x: 43, y: 24, type: "medium", goods: ["Machinery"], country: "Germany" },
    "Essen": { x: 41, y: 28, type: "major", goods: ["Steel", "Tourists"], country: "Germany" },
    "Berlin": { x: 50.5, y: 24, type: "major", goods: [], country: "Germany" },
    "Leipzig": { x: 49, y: 28, type: "medium", goods: ["China"], country: "Germany" },
    "Frankfurt": { x: 43, y: 32, type: "medium", goods: ["Beer", "Wine"], country: "Germany" },
    "Stuttgart": { x: 44, y: 36, type: "medium", goods: ["Cars"], country: "Germany" },
    "München": { x: 47, y: 38, type: "medium", goods: ["Beer", "Cars"], country: "Germany" },
    "Szczecin": { x: 52, y: 22, type: "small", goods: ["Potatoes"], country: "Poland" },
    "Warszawa": { x: 58, y: 26, type: "medium", goods: ["Ham"], country: "Poland" },
    "Lodz": { x: 57, y: 28, type: "small", goods: ["Potatoes"], country: "Poland" },
    "Wroclaw": { x: 54, y: 30, type: "medium", goods: ["Coal", "Copper"], country: "Poland" },
    "Krakow": { x: 57, y: 33, type: "medium", goods: ["Coal"], country: "Poland" },
    "Kaliningrad": { x: 58, y: 19, type: "small", goods: ["Iron"], country: "Russia" },
    "Paris": { x: 35, y: 37, type: "major", goods: [], country: "France" },
    "Nantes": { x: 28, y: 39, type: "medium", goods: ["Cattle", "Machinery"], country: "France" },
    "Bordeaux": { x: 30, y: 46, type: "medium", goods: ["Wine"], country: "France" },
    "Toulouse": { x: 33, y: 50, type: "medium", goods: ["Wheat"], country: "France" },
    "Lyon": { x: 38.5, y: 44, type: "medium", goods: ["Wheat"], country: "France" },
    "Marseille": { x: 38, y: 51, type: "medium", goods: ["Bauxite"], country: "France" },
    "Bilbao": { x: 27, y: 50, type: "small", goods: ["Sheep"], country: "Spain" },
    "Porto": { x: 19, y: 54, type: "medium", goods: ["Fish", "Wine", "Cork"], country: "Portugal" },
    "Madrid": { x: 24, y: 58, type: "major", goods: [], country: "Spain" },
    "Lisboa": { x: 17, y: 61, type: "medium", goods: ["Cork"], country: "Portugal" },
    "Sevilla": { x: 21, y: 66, type: "medium", goods: ["Cork", "Oranges"], country: "Spain" },
    "Valencia": { x: 28, y: 62, type: "medium", goods: ["Oranges"], country: "Spain" },
    "Barcelona": { x: 33, y: 56, type: "medium", goods: ["Machinery"], country: "Spain" },
    "Bern": { x: 41, y: 39, type: "medium", goods: ["Cattle", "Cheese"], country: "Switzerland" },
    "Zürich": { x: 43, y: 38, type: "medium", goods: ["Chocolate"], country: "Switzerland" },
    "Vienna": { x: 53, y: 36, type: "major", goods: ["Wine"], country: "Austria" },
    "Milano": { x: 43.5, y: 43, type: "major", goods: [], country: "Italy" },
    "Torino": { x: 41, y: 44, type: "medium", goods: ["Cars"], country: "Italy" },
    "Venezia": { x: 48, y: 43, type: "medium", goods: [], country: "Italy" },
    "Firenze": { x: 46, y: 48, type: "medium", goods: ["Marble"], country: "Italy" },
    "Roma": { x: 48, y: 54, type: "medium", goods: [], country: "Italy" },
    "Napoli": { x: 51, y: 58, type: "medium", goods: ["Tobacco"], country: "Italy" },
    "Zagreb": { x: 53, y: 42, type: "medium", goods: ["Labor"], country: "Croatia" },
    "Budapest": { x: 57, y: 38, type: "medium", goods: ["Bauxite"], country: "Hungary" },
    "Sarajevo": { x: 56, y: 47, type: "small", goods: ["Labor", "Wood"], country: "Bosnia" },
    "Beograd": { x: 59, y: 44, type: "medium", goods: ["Copper", "Labor", "Oil"], country: "Serbia" },
    "Praha": { x: 51, y: 31, type: "medium", goods: ["Beer"], country: "Czech" }
};

const GOODS = {
    "Bauxite": { chips: 3, sources: ["Budapest", "Marseille"] },
    "Beer": { chips: 4, sources: ["Dublin", "Frankfurt", "München", "Praha"] },
    "Cars": { chips: 3, sources: ["Manchester", "München", "Stuttgart", "Torino"] },
    "Cattle": { chips: 3, sources: ["Bern", "Nantes"] },
    "Cheese": { chips: 4, sources: ["Århus", "Bern", "Amsterdam", "København"] },
    "China": { chips: 3, sources: ["Birmingham", "Leipzig"] },
    "Chocolate": { chips: 3, sources: ["Bruxelles", "Zürich"] },
    "Coal": { chips: 3, sources: ["Cardiff", "Krakow", "Wroclaw"] },
    "Copper": { chips: 3, sources: ["Beograd", "Wroclaw"] },
    "Cork": { chips: 3, sources: ["Cork", "Lisboa", "Sevilla"] },
    "Fish": { chips: 3, sources: ["Aberdeen", "Oslo", "Porto"] },
    "Flowers": { chips: 3, sources: ["Amsterdam"] },
    "Ham": { chips: 3, sources: ["Warszawa"] },
    "Hops": { chips: 3, sources: ["Cardiff"] },
    "Imports": { chips: 3, sources: ["Antwerpen", "Hamburg"] },
    "Iron": { chips: 3, sources: ["Birmingham", "Kaliningrad", "Stockholm"] },
    "Labor": { chips: 3, sources: ["Beograd", "Sarajevo", "Zagreb"] },
    "Machinery": { chips: 4, sources: ["Barcelona", "Bremen", "Göteborg", "Nantes"] },
    "Marble": { chips: 3, sources: ["Firenze"] },
    "Oil": { chips: 4, sources: ["Aberdeen", "Beograd", "Newcastle", "Oslo"] },
    "Oranges": { chips: 3, sources: ["Sevilla", "Valencia"] },
    "Potatoes": { chips: 3, sources: ["Belfast", "Lodz", "Szczecin"] },
    "Sheep": { chips: 3, sources: ["Bilbao", "Cork", "Glasgow"] },
    "Steel": { chips: 3, sources: ["Birmingham", "Luxembourg", "Essen"] },
    "Tobacco": { chips: 3, sources: ["Napoli"] },
    "Tourists": { chips: 3, sources: ["London", "Essen"] },
    "Wheat": { chips: 3, sources: ["Lyon", "Toulouse"] },
    "Wine": { chips: 4, sources: ["Bordeaux", "Frankfurt", "Porto", "Vienna"] },
    "Wood": { chips: 3, sources: ["Oslo", "Sarajevo"] }
};

const EVENT_CARDS = [
    { id: 121, type: "strike", title: "Strike! Coast Restriction", description: "No train may pick up or deliver any load to any city more than 3 mileposts from any coast.", effect: "coastal", radius: 3, persistent: true },
    { id: 122, type: "strike", title: "Strike! Coastal Blockade", description: "No train may pick up or deliver any load at any city within 2 mileposts of any coast.", effect: "coastal_close", radius: 2, persistent: true },
    { id: 123, type: "strike", title: "Strike! Rail Closure", description: "No train may move on the drawing player's rail lines. Drawing player may not build track.", effect: "player_strike", persistent: true },
    { id: 124, type: "tax", title: "Excess Profit Tax!", description: "All players pay tax based on cash on hand: 0-50M=0, 51-100M=10M, 101-150M=15M, 151-200M=20M, 201+=25M", persistent: false },
    { id: 125, type: "derailment", title: "Derailment! Milano/Roma", description: "All trains within 3 mileposts of Milano/Roma lose 1 turn and 1 load.", cities: ["Milano", "Roma"], radius: 3, persistent: false },
    { id: 126, type: "derailment", title: "Derailment! London/Birmingham", description: "All trains within 2 mileposts of London/Birmingham lose 1 turn and 1 load.", cities: ["London", "Birmingham"], radius: 2, persistent: false },
    { id: 127, type: "derailment", title: "Derailment! Paris/Marseille", description: "All trains within 3 mileposts of Paris/Marseille lose 1 turn and 1 load.", cities: ["Paris", "Marseille"], radius: 3, persistent: false },
    { id: 128, type: "derailment", title: "Derailment! Berlin/Hamburg", description: "All trains within 3 mileposts of Berlin/Hamburg lose 1 turn and 1 load.", cities: ["Berlin", "Hamburg"], radius: 3, persistent: false },
    { id: 129, type: "derailment", title: "Derailment! Madrid/Barcelona", description: "All trains within 3 mileposts of Madrid/Barcelona lose 1 turn and 1 load.", cities: ["Madrid", "Barcelona"], radius: 3, persistent: false },
    { id: 130, type: "snow", title: "Snow! Torino", description: "All trains within 6 mileposts of Torino move at half rate.", city: "Torino", radius: 6, blockedTerrain: ["alpine"], persistent: true },
    { id: 131, type: "snow", title: "Snow! München", description: "All trains within 5 mileposts of München move at half rate.", city: "München", radius: 5, blockedTerrain: ["mountain"], persistent: true },
    { id: 132, type: "snow", title: "Snow! Praha", description: "All trains within 4 mileposts of Praha move at half rate.", city: "Praha", radius: 4, blockedTerrain: ["mountain"], persistent: true },
    { id: 133, type: "snow", title: "Snow! Krakow", description: "All trains within 6 mileposts of Krakow move at half rate.", city: "Krakow", radius: 6, blockedTerrain: ["mountain"], persistent: true },
    { id: 134, type: "fog", title: "Fog! Frankfurt", description: "All trains within 4 mileposts of Frankfurt move at half rate.", city: "Frankfurt", radius: 4, persistent: true },
    { id: 135, type: "flood", title: "Flood! Rhine River", description: "No train may cross the Rhine River. All rail lines over this river are destroyed.", river: "rhine", persistent: false },
    { id: 136, type: "flood", title: "Flood! Danube River", description: "No train may cross the Danube River. All rail lines over this river are destroyed.", river: "danube", persistent: false },
    { id: 137, type: "flood", title: "Flood! Loire River", description: "No train may cross the Loire River. All rail lines over this river are destroyed.", river: "loire", persistent: false },
    { id: 138, type: "gale", title: "Gale! North Sea & English Channel", description: "All trains within 6 mileposts of the North Sea or English Channel move at half rate.", seaAreas: ["North Sea", "English Channel"], radius: 6, persistent: true },
    { id: 139, type: "gale", title: "Gale! Baltic & Mediterranean", description: "All trains within 4 mileposts of the Baltic Sea or Mediterranean move at half rate.", seaAreas: ["Baltic Sea", "Mediterranean"], radius: 4, persistent: true },
    { id: 140, type: "gale", title: "Gale! Atlantic & Bay of Biscay", description: "All trains within 4 mileposts of the Atlantic or Bay of Biscay move at half rate.", seaAreas: ["Atlantic", "Bay of Biscay"], radius: 4, persistent: true }
];

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

    function generateDemand() {
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
        } while ((to === from || sources.includes(to) || minDist < DEMAND_MIN_DISTANCE) && attempts < 50);
        const payout = calculatePayout(minDist, GOODS[good].chips);
        return { good, from, to, payout, minDist };
    }

    for (let i = 0; i < 120; i++) {
        let demands, cardAttempts = 0;
        do {
            demands = [generateDemand(), generateDemand(), generateDemand()];
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

const RIVERS = {
    rhine: [[43,38], [42,36], [41,33], [41,30], [40,28], [39,27]],
    danube: [[48,38], [51,37], [53,36], [55,37], [57,38], [59,42], [60,44]],
    loire: [[35,38], [32,39], [29,39], [27.5,40]],
    elbe: [[50,24], [48,26], [46,24], [44,23]],
    vistula: [[56,20], [57,24], [58,26], [58,30]],
    po: [[42,44], [44,43], [46,43], [48,43]],
    rhone: [[39,43], [38,46], [38,50]],
    seine: [[33,35], [35,37]],
    garonne: [[29.5,47], [31,48], [33,50]],
    douro: [[19,54], [20,54], [22,55]]
};

function segmentsIntersect(ax1, ay1, ax2, ay2, bx1, by1, bx2, by2) {
    const dx1 = ax2 - ax1, dy1 = ay2 - ay1;
    const dx2 = bx2 - bx1, dy2 = by2 - by1;
    const denom = dx1 * dy2 - dy1 * dx2;
    if (Math.abs(denom) < 1e-10) return false;
    const t = ((bx1 - ax1) * dy2 - (by1 - ay1) * dx2) / denom;
    const u = ((bx1 - ax1) * dy1 - (by1 - ay1) * dx1) / denom;
    return t >= 0 && t <= 1 && u >= 0 && u <= 1;
}

function crossesRiver(x1, y1, x2, y2, river) {
    for (let i = 0; i < river.length - 1; i++) {
        const [rx1, ry1] = river[i];
        const [rx2, ry2] = river[i + 1];
        if (segmentsIntersect(x1, y1, x2, y2, rx1, ry1, rx2, ry2)) return true;
    }
    return false;
}

const TRAIN_TYPES = {
    "Freight": { movement: 9, capacity: 2 },
    "Fast Freight": { movement: 12, capacity: 2 },
    "Heavy Freight": { movement: 9, capacity: 3 },
    "Superfreight": { movement: 12, capacity: 3 }
};

// --- Game Logic Helpers ---

function getFerryKey(id1, id2) {
    return id1 < id2 ? id1 + "|" + id2 : id2 + "|" + id1;
}

function playerOwnsFerry(ferryOwnership, ferryKey, playerColor) {
    const owners = ferryOwnership[ferryKey] || [];
    return owners.includes(playerColor);
}

function getPlayerOwnedMileposts(gs, playerColor) {
    const owned = new Set();
    for (const track of gs.tracks) {
        if (track.color === playerColor) {
            owned.add(track.from);
            owned.add(track.to);
        }
    }
    if (gs.ferryConnections) {
        for (const fc of gs.ferryConnections) {
            const ferryKey = getFerryKey(fc.fromId, fc.toId);
            if (playerOwnsFerry(gs.ferryOwnership, ferryKey, playerColor)) {
                owned.add(fc.fromId);
                owned.add(fc.toId);
            }
        }
    }
    return owned;
}

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
            // Check ferry connections
            const ferryKey = getFerryKey(fromId, toId);
            if (ferryKey && playerOwnsFerry(gs.ferryOwnership, ferryKey, playerColor)) {
                ferryCrossings.push(i);
                found = true;
            }
        }

        if (!found) {
            return { valid: false, error: `No track connection between ${fromId} and ${toId}` };
        }

        if (isForeign) foreignSegments.push(i);
    }

    return { valid: true, foreignSegments, ferryCrossings };
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

// Draw one card for a player, skipping event cards (events handled separately during turns)
// Apply immediate event effects on the server
function serverApplyEventEffect(gs, eventCard, logs) {
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
                    gs.derailedPlayers[pIdx] = 1;
                    if (player.loads.length > 0) player.loads.pop();
                    const msg = `${player.name} derailed! Loses next turn and 1 load.`;
                    logs.push(msg);
                    gs.gameLog.push(msg);
                }
            }
        }
    } else if (eventCard.type === "flood" && gs.milepostPositions) {
        const river = RIVERS[eventCard.river];
        if (river) {
            const tracksToRemove = [];
            for (let i = 0; i < gs.tracks.length; i++) {
                const track = gs.tracks[i];
                const mp1 = gs.milepostPositions[track.from];
                const mp2 = gs.milepostPositions[track.to];
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
                    gs.derailedPlayers[pIdx] = 1;
                    if (player.loads.length > 0) player.loads.pop();
                    const msg = `${player.name} caught in gale at ferry port! Loses next turn and 1 load.`;
                    logs.push(msg);
                    gs.gameLog.push(msg);
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
            serverApplyEventEffect(gs, eventCard, logs);

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
    for (const [socketId, p] of room.players) {
        const state = getStateForPlayer(room.gameState, p.sessionToken, room.disconnectedPlayers);
        io.to(socketId).emit('stateUpdate', { state, uiEvent });
    }
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
        return {
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
    });

    return {
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
        buildHistory: []
    };
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

    socket.on('createRoom', ({ playerName, maxPlayers, password }, callback) => {
        const playerCount = Math.min(6, Math.max(1, parseInt(maxPlayers) || 3));
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
            password: password || null
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

        if (room.players.size === 0) {
            rooms.delete(roomCode);
            console.log(`Room ${roomCode} deleted (empty)`);
        } else {
            if (player && room.hostSessionToken === player.sessionToken) {
                // Transfer host to next player
                const nextPlayer = room.players.values().next().value;
                room.hostSessionToken = nextPlayer.sessionToken;
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

    socket.on('startGame', () => {
        const room = rooms.get(socket.roomCode);
        if (!room) return;
        // Host check: look up the socket's sessionToken and compare to hostSessionToken
        const callerPlayer = room.players.get(socket.id);
        if (!callerPlayer || callerPlayer.sessionToken !== room.hostSessionToken) return;
        if (room.players.size < room.maxPlayers) return;

        // Check all players have selected colors
        for (const [, p] of room.players) {
            if (!p.color) return;
        }

        room.gameStarted = true;

        // Build player list using sessionTokens as ids
        const playerList = [];
        for (const [, p] of room.players) {
            playerList.push({ id: p.sessionToken, name: p.name, color: p.color });
        }

        // Create authoritative game state on server
        room.gameState = createGameState(playerList);

        console.log(`Game started in room ${socket.roomCode} with ${playerList.length} players`);
        console.log(`Deck has ${room.gameState.demandCardDeck.length} cards remaining`);

        // Send each player their filtered game state
        for (const [socketId, p] of room.players) {
            const state = getStateForPlayer(room.gameState, p.sessionToken, room.disconnectedPlayers);
            io.to(socketId).emit('gameStart', { state });
        }
        broadcastRoomList();
    });

    // Client sends cityToMilepost mapping after generating hex grid
    socket.on('setCityToMilepost', ({ cityToMilepost, ferryConnections, coastDistance, milepostPositions, eventZones }) => {
        const room = rooms.get(socket.roomCode);
        if (!room || !room.gameState) return;
        // Only set once (first client to send it)
        if (!room.gameState.cityToMilepost) {
            room.gameState.cityToMilepost = cityToMilepost;
            room.gameState.ferryConnections = ferryConnections;
            room.gameState.coastDistance = coastDistance || {};
            room.gameState.milepostPositions = milepostPositions || {};
            room.gameState.eventZones = eventZones || {};
            console.log(`Room ${socket.roomCode}: received cityToMilepost (${Object.keys(cityToMilepost).length} cities), milepostPositions (${Object.keys(room.gameState.milepostPositions).length}), eventZones (${Object.keys(room.gameState.eventZones).length})`);
        }
    });

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
                // Validate: must be current player's turn
                if (playerIndex !== gs.currentPlayerIndex) {
                    return callback && callback({ success: false, error: 'Not your turn' });
                }

                console.log(`Room ${socket.roomCode}: ${gs.players[playerIndex].name} ends turn`);
                const result = serverEndTurn(gs);

                if (result.gameOver) {
                    broadcastStateUpdate(socket.roomCode, room, {
                        type: 'gameOver',
                        winner: result.winner,
                        logs: result.logs
                    });
                } else {
                    broadcastStateUpdate(socket.roomCode, room, {
                        type: 'turnChanged',
                        overlay: result.overlay,
                        logs: result.logs
                    });

                    startTurnTimerIfNeeded(socket.roomCode, room);
                }

                callback && callback({ success: true });
                break;
            }

            case 'upgradeTo': {
                if (playerIndex !== gs.currentPlayerIndex) {
                    return callback && callback({ success: false, error: 'Not your turn' });
                }

                const trainType = action.trainType;
                if (!TRAIN_TYPES[trainType]) {
                    return callback && callback({ success: false, error: 'Invalid train type' });
                }

                const upgradePlayer = gs.players[playerIndex];
                const upgradeCost = 20;

                if (upgradePlayer.cash < upgradeCost) {
                    return callback && callback({ success: false, error: 'Not enough cash' });
                }
                if (gs.buildingThisTurn > 0) {
                    return callback && callback({ success: false, error: 'Already built track this turn' });
                }

                upgradePlayer.cash -= upgradeCost;
                upgradePlayer.trainType = trainType;
                gs.buildingThisTurn = 20;

                const upgradeMsg = `${upgradePlayer.name} upgraded train to ${trainType} (ECU 20M)`;
                gs.gameLog.push(upgradeMsg);
                console.log(`Room ${socket.roomCode}: ${upgradeMsg}`);

                broadcastStateUpdate(socket.roomCode, room, {
                    type: 'action',
                    logs: [upgradeMsg]
                });

                callback && callback({ success: true });
                break;
            }

            case 'pickupGood': {
                if (playerIndex !== gs.currentPlayerIndex) {
                    return callback && callback({ success: false, error: 'Not your turn' });
                }

                const pickupPlayer = gs.players[playerIndex];
                const good = action.good;

                if (!GOODS[good]) {
                    return callback && callback({ success: false, error: 'Invalid good' });
                }

                const maxCapacity = TRAIN_TYPES[pickupPlayer.trainType].capacity;
                if (pickupPlayer.loads.length >= maxCapacity) {
                    return callback && callback({ success: false, error: 'Train is at full capacity' });
                }

                if (isEventBlocking(gs, "load", { milepostId: pickupPlayer.trainLocation })) {
                    return callback && callback({ success: false, error: 'Strike in effect — cannot pick up goods here' });
                }

                const goodData = GOODS[good];
                const inCirculation = getGoodsInCirculation(gs, good);
                if (inCirculation >= goodData.chips) {
                    return callback && callback({ success: false, error: `No ${good} available — all ${goodData.chips} chips are in use` });
                }

                pickupPlayer.loads.push(good);
                gs.operateHistory.push({ type: 'pickup', good });
                const pickupMsg = `${pickupPlayer.name} picked up ${good}`;
                gs.gameLog.push(pickupMsg);
                console.log(`Room ${socket.roomCode}: ${pickupMsg}`);

                broadcastStateUpdate(socket.roomCode, room, {
                    type: 'action',
                    logs: [pickupMsg]
                });

                callback && callback({ success: true });
                break;
            }

            case 'dropGood': {
                if (playerIndex !== gs.currentPlayerIndex) {
                    return callback && callback({ success: false, error: 'Not your turn' });
                }

                const dropPlayer = gs.players[playerIndex];
                const loadIndex = action.loadIndex;

                if (loadIndex < 0 || loadIndex >= dropPlayer.loads.length) {
                    return callback && callback({ success: false, error: 'Invalid load index' });
                }

                const droppedGood = dropPlayer.loads[loadIndex];
                dropPlayer.loads.splice(loadIndex, 1);
                gs.operateHistory.push({ type: 'drop', good: droppedGood, loadIndex });
                const dropMsg = `${dropPlayer.name} dropped ${droppedGood}`;
                gs.gameLog.push(dropMsg);
                console.log(`Room ${socket.roomCode}: ${dropMsg}`);

                broadcastStateUpdate(socket.roomCode, room, {
                    type: 'action',
                    logs: [dropMsg]
                });

                callback && callback({ success: true });
                break;
            }

            case 'deliverGood': {
                if (playerIndex !== gs.currentPlayerIndex) {
                    return callback && callback({ success: false, error: 'Not your turn' });
                }

                const deliverPlayer = gs.players[playerIndex];
                const { cardIndex, demandIndex } = action;
                const card = deliverPlayer.demandCards[cardIndex];

                if (!card || !card.demands[demandIndex]) {
                    return callback && callback({ success: false, error: 'Invalid demand card' });
                }

                const demand = card.demands[demandIndex];
                const matchingLoadIndex = deliverPlayer.loads.findIndex(g => g === demand.good);
                if (matchingLoadIndex === -1) {
                    return callback && callback({ success: false, error: `No ${demand.good} to deliver` });
                }

                // Check player is at the correct city
                const currentCity = getCityAtMilepost(gs, deliverPlayer.trainLocation);
                if (currentCity !== demand.to) {
                    return callback && callback({ success: false, error: `Must deliver to ${demand.to}` });
                }

                if (isEventBlocking(gs, "deliver", { milepostId: deliverPlayer.trainLocation })) {
                    return callback && callback({ success: false, error: 'Strike in effect — cannot deliver goods here' });
                }

                // Apply delivery — clear operate history (delivery commits the turn's moves)
                gs.operateHistory = [];
                deliverPlayer.loads.splice(matchingLoadIndex, 1);
                deliverPlayer.cash += demand.payout;
                const deliverMsg = `${deliverPlayer.name} delivered ${demand.good} to ${demand.to} for ECU ${demand.payout}M`;
                gs.gameLog.push(deliverMsg);
                console.log(`Room ${socket.roomCode}: ${deliverMsg}`);

                // Remove fulfilled card, draw replacement
                deliverPlayer.demandCards.splice(cardIndex, 1);
                if (deliverPlayer.selectedDemands) {
                    deliverPlayer.selectedDemands.splice(cardIndex, 1);
                    deliverPlayer.selectedDemands.push(null);
                }
                const drawResult = serverDrawCardForPlayer(gs, deliverPlayer, []);
                const allDeliverLogs = [deliverMsg, ...drawResult.logs];

                broadcastStateUpdate(socket.roomCode, room, {
                    type: 'delivery',
                    logs: allDeliverLogs,
                    cardIndex,
                    newCard: drawResult.card,
                    drawnEvents: drawResult.drawnEvents,
                    drawnBy: { name: deliverPlayer.name, color: deliverPlayer.color },
                    deliveryGood: demand.good,
                    deliveryTo: demand.to,
                    deliveryPayout: demand.payout
                });

                callback && callback({ success: true });
                break;
            }

            case 'commitBuild': {
                if (playerIndex !== gs.currentPlayerIndex) {
                    return callback && callback({ success: false, error: 'Not your turn' });
                }

                // Check strike 123: drawing player cannot build
                for (const ae of gs.activeEvents) {
                    if (ae.card.id === 123) {
                        const drawingPlayer = gs.players[ae.drawingPlayerIndex];
                        const currentP = gs.players[playerIndex];
                        if (currentP.color === drawingPlayer.color) {
                            return callback && callback({ success: false, error: 'Strike in effect — cannot build' });
                        }
                    }
                }

                const { buildPath, buildCost, majorCityCount, ferries } = action;
                const buildPlayer = gs.players[playerIndex];

                if (!buildPath || buildPath.length < 2) {
                    return callback && callback({ success: false, error: 'Invalid build path' });
                }
                if (typeof buildCost !== 'number' || buildCost < 0) {
                    return callback && callback({ success: false, error: 'Invalid build cost' });
                }

                const remainingBudget = 20 - gs.buildingThisTurn;
                if (buildCost > remainingBudget) {
                    return callback && callback({ success: false, error: 'Exceeds build budget' });
                }
                if (buildCost > buildPlayer.cash) {
                    return callback && callback({ success: false, error: 'Not enough cash' });
                }
                if (gs.majorCitiesThisTurn + (majorCityCount || 0) > 2) {
                    return callback && callback({ success: false, error: 'Major city limit exceeded' });
                }

                // Build owned/other edge sets for validation
                const ownedEdges = new Set();
                const otherEdges = new Set();
                for (const t of gs.tracks) {
                    const fwd = t.from + "|" + t.to;
                    const rev = t.to + "|" + t.from;
                    if (t.color === buildPlayer.color) {
                        ownedEdges.add(fwd);
                        ownedEdges.add(rev);
                    } else {
                        otherEdges.add(fwd);
                        otherEdges.add(rev);
                    }
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
                        if (!gs.ferryOwnership[ferryKey].includes(buildPlayer.color)) {
                            gs.ferryOwnership[ferryKey].push(buildPlayer.color);
                            newSegments++;
                        }
                    }
                    if (isFerryEdge) continue;

                    if (otherEdges.has(edgeKey)) continue;
                    if (!ownedEdges.has(edgeKey)) {
                        gs.tracks.push({
                            from: buildPath[i],
                            to: buildPath[i + 1],
                            color: buildPlayer.color
                        });
                        ownedEdges.add(edgeKey);
                        ownedEdges.add(buildPath[i + 1] + "|" + buildPath[i]);
                        newSegments++;
                    }
                }

                buildPlayer.cash -= buildCost;
                gs.buildingThisTurn += buildCost;
                gs.majorCitiesThisTurn += (majorCityCount || 0);

                // Record build for undo
                gs.buildHistory.push({
                    segments: newSegments,
                    cost: buildCost,
                    majorCities: majorCityCount || 0,
                    ferries: ferries ? ferries.filter(fk => gs.ferryOwnership[fk] && gs.ferryOwnership[fk].includes(buildPlayer.color)) : []
                });

                const buildMsg = `${buildPlayer.name} built track for ECU ${buildCost}M (${20 - gs.buildingThisTurn}M remaining this turn)`;
                gs.gameLog.push(buildMsg);
                logs.push(buildMsg);
                console.log(`Room ${socket.roomCode}: ${buildMsg}`);

                broadcastStateUpdate(socket.roomCode, room, {
                    type: 'action',
                    logs
                });

                callback && callback({ success: true });
                break;
            }

            case 'deployTrain': {
                if (playerIndex !== gs.currentPlayerIndex) {
                    return callback && callback({ success: false, error: 'Not your turn' });
                }

                const deployPlayer = gs.players[playerIndex];
                if (deployPlayer.trainLocation !== null) {
                    return callback && callback({ success: false, error: 'Train already deployed' });
                }

                const milepostId = action.milepostId;
                if (!milepostId) {
                    return callback && callback({ success: false, error: 'Invalid milepost' });
                }

                deployPlayer.trainLocation = milepostId;
                gs.operateHistory.push({ type: 'deploy' });
                const cityName = getCityAtMilepost(gs, milepostId) || "milepost";
                const deployMsg = `${deployPlayer.name} deployed train at ${cityName}`;
                gs.gameLog.push(deployMsg);
                console.log(`Room ${socket.roomCode}: ${deployMsg}`);

                broadcastStateUpdate(socket.roomCode, room, {
                    type: 'action',
                    logs: [deployMsg]
                });

                callback && callback({ success: true });
                break;
            }

            case 'discardHand': {
                if (playerIndex !== gs.currentPlayerIndex) {
                    return callback && callback({ success: false, error: 'Not your turn' });
                }

                const discardPlayer = gs.players[playerIndex];
                discardPlayer.demandCards = [];
                discardPlayer.selectedDemands = [null, null, null];

                const discardMsg = `${discardPlayer.name} discarded hand and drew 3 new cards`;
                gs.gameLog.push(discardMsg);
                console.log(`Room ${socket.roomCode}: ${discardMsg}`);

                // Draw 3 new demand cards (processing events along the way)
                const drawLogs = [];
                const allDrawnEvents = [];
                while (discardPlayer.demandCards.length < 3 && gs.demandCardDeck.length > 0) {
                    serverDrawCardForPlayer(gs, discardPlayer, drawLogs, allDrawnEvents);
                }

                // Discard hand also ends the turn
                const turnResult = serverEndTurn(gs);
                const allLogs = [discardMsg, ...drawLogs, ...turnResult.logs];

                const drawnBy = { name: discardPlayer.name, color: discardPlayer.color };
                if (turnResult.gameOver) {
                    broadcastStateUpdate(socket.roomCode, room, {
                        type: 'gameOver',
                        winner: turnResult.winner,
                        logs: allLogs,
                        drawnEvents: allDrawnEvents,
                        drawnBy
                    });
                } else {
                    broadcastStateUpdate(socket.roomCode, room, {
                        type: 'turnChanged',
                        overlay: turnResult.overlay,
                        logs: allLogs,
                        drawnEvents: allDrawnEvents,
                        drawnBy
                    });

                    startTurnTimerIfNeeded(socket.roomCode, room);
                }

                callback && callback({ success: true });
                break;
            }

            case 'endOperatePhase': {
                if (playerIndex !== gs.currentPlayerIndex) {
                    return callback && callback({ success: false, error: 'Not your turn' });
                }
                if (gs.phase !== 'operate') {
                    return callback && callback({ success: false, error: 'Not in operate phase' });
                }

                gs.phase = 'build';
                gs.buildingThisTurn = 0;
                gs.majorCitiesThisTurn = 0;
                gs.buildHistory = [];
                gs.operateHistory = [];
                gs.trackageRightsPaidThisTurn = {};
                gs.trackageRightsLog = [];

                const phaseMsg = `${gs.players[playerIndex].name} moved to Build Phase`;
                gs.gameLog.push(phaseMsg);
                console.log(`Room ${socket.roomCode}: ${phaseMsg}`);

                broadcastStateUpdate(socket.roomCode, room, {
                    type: 'action',
                    logs: [phaseMsg]
                });

                callback && callback({ success: true });
                break;
            }

            case 'undoBuild': {
                if (playerIndex !== gs.currentPlayerIndex) {
                    return callback && callback({ success: false, error: 'Not your turn' });
                }

                if (gs.buildHistory.length === 0) {
                    return callback && callback({ success: false, error: 'Nothing to undo' });
                }

                const undoBuildPlayer = gs.players[playerIndex];
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
                            const idx = owners.lastIndexOf(undoBuildPlayer.color);
                            if (idx !== -1) owners.splice(idx, 1);
                            if (owners.length === 0) delete gs.ferryOwnership[ferryKey];
                        }
                    }
                }

                // Refund cost
                undoBuildPlayer.cash += lastBuild.cost;
                gs.buildingThisTurn -= lastBuild.cost;
                gs.majorCitiesThisTurn -= lastBuild.majorCities;

                const undoBuildMsg = `${undoBuildPlayer.name} undid last build (refunded ECU ${lastBuild.cost}M)`;
                gs.gameLog.push(undoBuildMsg);
                console.log(`Room ${socket.roomCode}: ${undoBuildMsg}`);

                broadcastStateUpdate(socket.roomCode, room, {
                    type: 'action',
                    logs: [undoBuildMsg]
                });

                callback && callback({ success: true });
                break;
            }

            case 'commitMove': {
                if (playerIndex !== gs.currentPlayerIndex) {
                    return callback && callback({ success: false, error: 'Not your turn' });
                }
                if (gs.phase !== 'operate') {
                    return callback && callback({ success: false, error: 'Not in operate phase' });
                }

                const movePlayer = gs.players[playerIndex];
                if (movePlayer.trainLocation === null) {
                    return callback && callback({ success: false, error: 'Train not deployed' });
                }
                if (movePlayer.ferryState) {
                    return callback && callback({ success: false, error: 'Waiting for ferry' });
                }
                if (movePlayer.movement <= 0) {
                    return callback && callback({ success: false, error: 'No movement remaining' });
                }

                const { path } = action;
                if (!path || !Array.isArray(path) || path.length < 2) {
                    return callback && callback({ success: false, error: 'Invalid path' });
                }
                if (path[0] !== movePlayer.trainLocation) {
                    return callback && callback({ success: false, error: 'Path does not start at train location' });
                }

                // Validate path connectivity
                const validation = serverValidatePath(gs, path, movePlayer.color);
                if (!validation.valid) {
                    return callback && callback({ success: false, error: validation.error });
                }

                // Save state for undo
                const prevLocation = movePlayer.trainLocation;
                const prevMovement = movePlayer.movement;
                const prevFerryState = movePlayer.ferryState ? JSON.parse(JSON.stringify(movePlayer.ferryState)) : null;
                const prevCash = movePlayer.cash;
                const prevOwnerCash = {};
                for (const p of gs.players) {
                    if (p.color !== movePlayer.color) prevOwnerCash[p.color] = p.cash;
                }

                const logs = [];
                let newlyPaidOwners = [];

                // Handle ferry crossings
                if (validation.ferryCrossings.length > 0) {
                    const ferryIdx = validation.ferryCrossings[0];
                    const portMilepostId = path[ferryIdx];
                    const destPortId = path[ferryIdx + 1];

                    if (portMilepostId !== movePlayer.trainLocation) {
                        // Need to move to port first
                        const stepsToPort = ferryIdx;
                        const pathToPort = path.slice(0, stepsToPort + 1);
                        const costToPort = serverGetPathMovementCost(gs, pathToPort);

                        if (costToPort > movePlayer.movement) {
                            // Partial move toward ferry port
                            const maxSteps = serverGetMaxStepsForMovement(gs, path, movePlayer.movement);
                            const partialPath = path.slice(0, maxSteps + 1);
                            const partialDestId = path[maxSteps];

                            // Check and charge trackage rights for partial path
                            if (validation.foreignSegments.length > 0) {
                                const owners = serverGetForeignTrackOwners(gs, path, maxSteps, movePlayer.color, validation.foreignSegments);
                                let pendingFee = 0;
                                for (const oc of owners) {
                                    if (!gs.trackageRightsPaidThisTurn[oc]) pendingFee += 4;
                                }
                                if (!serverCheckTrackageStrandRisk(gs, partialPath, movePlayer.color, movePlayer.cash - pendingFee)) {
                                    return callback && callback({ success: false, error: "Cannot move here — you'd be stranded on foreign track without enough cash" });
                                }
                                const trResult = serverChargeTrackageRights(gs, movePlayer, path, validation.foreignSegments, maxSteps);
                                if (!trResult.ok) {
                                    return callback && callback({ success: false, error: trResult.error });
                                }
                                newlyPaidOwners = trResult.newlyPaidOwners;
                                if (trResult.logs) logs.push(...trResult.logs);
                            }

                            movePlayer.trainLocation = partialDestId;
                            movePlayer.movement = 0;
                            const partialCost = serverGetPathMovementCost(gs, partialPath);
                            const cityName = getCityAtMilepost(gs, partialDestId) || "milepost";
                            const moveMsg = `Partial move toward ferry: moved ${maxSteps} steps (${partialCost}mp) to ${cityName}`;
                            logs.push(moveMsg);
                            gs.gameLog.push(moveMsg);

                            gs.operateHistory.push({
                                type: 'move', prevLocation, prevMovement, prevFerryState, prevCash, newlyPaidOwners, prevOwnerCash
                            });

                            broadcastStateUpdate(socket.roomCode, room, { type: 'action', logs });
                            return callback && callback({ success: true });
                        }

                        // Can reach port — charge trackage rights for path to port
                        if (validation.foreignSegments.length > 0) {
                            const trResult = serverChargeTrackageRights(gs, movePlayer, path, validation.foreignSegments, stepsToPort);
                            if (!trResult.ok) {
                                return callback && callback({ success: false, error: trResult.error });
                            }
                            newlyPaidOwners = trResult.newlyPaidOwners;
                            if (trResult.logs) logs.push(...trResult.logs);
                        }

                        movePlayer.trainLocation = portMilepostId;
                        movePlayer.movement -= costToPort;
                    }

                    // Set ferry state
                    movePlayer.ferryState = { destPortId };
                    movePlayer.movement = 0;
                    const portCity = getCityAtMilepost(gs, portMilepostId) || "ferry port";
                    const ferryMsg = `Arrived at ${portCity}. Waiting for ferry. Turn ends.`;
                    logs.push(ferryMsg);
                    gs.gameLog.push(ferryMsg);

                    gs.operateHistory.push({
                        type: 'move', prevLocation, prevMovement, prevFerryState, prevCash, newlyPaidOwners, prevOwnerCash
                    });

                    broadcastStateUpdate(socket.roomCode, room, { type: 'action', logs });
                    return callback && callback({ success: true });
                }

                // Normal movement (no ferry crossing) — handle partial moves
                const movementCost = serverGetPathMovementCost(gs, path);
                let movePath = path;
                let actualCost = movementCost;

                if (movementCost > movePlayer.movement) {
                    const maxSteps = serverGetMaxStepsForMovement(gs, path, movePlayer.movement);
                    movePath = path.slice(0, maxSteps + 1);
                    actualCost = serverGetPathMovementCost(gs, movePath);
                }

                const actualSteps = movePath.length - 1;
                const destId = movePath[movePath.length - 1];

                // Charge trackage rights if using foreign track
                if (validation.foreignSegments.length > 0) {
                    const owners = serverGetForeignTrackOwners(gs, path, actualSteps, movePlayer.color, validation.foreignSegments);
                    let pendingFee = 0;
                    for (const oc of owners) {
                        if (!gs.trackageRightsPaidThisTurn[oc]) pendingFee += 4;
                    }
                    if (!serverCheckTrackageStrandRisk(gs, movePath, movePlayer.color, movePlayer.cash - pendingFee)) {
                        return callback && callback({ success: false, error: "Cannot move here — you'd be stranded on foreign track without enough cash" });
                    }
                    const trResult = serverChargeTrackageRights(gs, movePlayer, path, validation.foreignSegments, actualSteps);
                    if (!trResult.ok) {
                        return callback && callback({ success: false, error: trResult.error });
                    }
                    newlyPaidOwners = trResult.newlyPaidOwners;
                    if (trResult.logs) logs.push(...trResult.logs);
                }

                movePlayer.trainLocation = destId;
                movePlayer.movement -= actualCost;
                const locationName = getCityAtMilepost(gs, destId) || "milepost";
                const moveMsg = movePath.length < path.length
                    ? `Partial move: ${actualSteps} steps (${actualCost}mp) — moved to ${locationName} (${movePlayer.movement}mp left)`
                    : `Moved to ${locationName} (${actualCost}mp used, ${movePlayer.movement}mp left)`;
                logs.push(moveMsg);
                gs.gameLog.push(moveMsg);

                gs.operateHistory.push({
                    type: 'move', prevLocation, prevMovement, prevFerryState, prevCash, newlyPaidOwners, prevOwnerCash
                });

                console.log(`Room ${socket.roomCode}: ${movePlayer.name} ${moveMsg}`);
                broadcastStateUpdate(socket.roomCode, room, { type: 'action', logs });
                callback && callback({ success: true });
                break;
            }

            case 'undoMove': {
                if (playerIndex !== gs.currentPlayerIndex) {
                    return callback && callback({ success: false, error: 'Not your turn' });
                }

                if (gs.operateHistory.length === 0) {
                    return callback && callback({ success: false, error: 'Nothing to undo' });
                }

                const undoPlayer = gs.players[playerIndex];
                const last = gs.operateHistory.pop();

                if (last.type === 'move') {
                    undoPlayer.trainLocation = last.prevLocation;
                    undoPlayer.movement = last.prevMovement;
                    undoPlayer.ferryState = last.prevFerryState;
                    undoPlayer.cash = last.prevCash;

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

                    const undoMsg = `${undoPlayer.name} undid move`;
                    gs.gameLog.push(undoMsg);
                    console.log(`Room ${socket.roomCode}: ${undoMsg}`);

                    broadcastStateUpdate(socket.roomCode, room, {
                        type: 'action',
                        logs: [undoMsg]
                    });
                } else if (last.type === 'deploy') {
                    undoPlayer.trainLocation = null;
                    const undoMsg = `${undoPlayer.name} undid train deployment`;
                    gs.gameLog.push(undoMsg);
                    broadcastStateUpdate(socket.roomCode, room, {
                        type: 'action',
                        logs: [undoMsg]
                    });
                } else if (last.type === 'pickup') {
                    undoPlayer.loads.splice(undoPlayer.loads.lastIndexOf(last.good), 1);
                    const undoMsg = `${undoPlayer.name} undid pickup of ${last.good}`;
                    gs.gameLog.push(undoMsg);
                    broadcastStateUpdate(socket.roomCode, room, {
                        type: 'action',
                        logs: [undoMsg]
                    });
                } else if (last.type === 'drop') {
                    undoPlayer.loads.splice(last.loadIndex, 0, last.good);
                    const undoMsg = `${undoPlayer.name} undid drop of ${last.good}`;
                    gs.gameLog.push(undoMsg);
                    broadcastStateUpdate(socket.roomCode, room, {
                        type: 'action',
                        logs: [undoMsg]
                    });
                }

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

        // --- Lobby disconnect (game not started) ---
        if (!room.gameStarted) {
            room.sessionToSocketId.delete(player.sessionToken);
            room.players.delete(socket.id);

            if (room.players.size === 0) {
                rooms.delete(roomCode);
                console.log(`Room ${roomCode} deleted (empty)`);
            } else {
                // Transfer host if host left
                if (room.hostSessionToken === player.sessionToken) {
                    const nextPlayer = room.players.values().next().value;
                    room.hostSessionToken = nextPlayer.sessionToken;
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

        // Step 7: Transfer host if host disconnected in-game
        if (room.hostSessionToken === player.sessionToken && room.players.size > 0) {
            // Pick the next connected player (from room.players, not disconnectedPlayers)
            const nextHost = room.players.values().next().value;
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
    if (!newCurrentPlayer || !room.disconnectedPlayers.has(newCurrentPlayer.id)) return;

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

    // If ALL players are abandoned, delete the room — no need to advance turns
    const allAbandoned = gs.players.every(p => p.abandoned);
    if (allAbandoned) {
        for (const timer of room.graceTimers.values()) {
            clearTimeout(timer);
        }
        for (const timer of room.turnTimers.values()) {
            clearTimeout(timer);
        }
        rooms.delete(roomCode);
        console.log(`Room ${roomCode} deleted (all players abandoned)`);
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

        startTurnTimerIfNeeded(roomCode, room);
    }
}


function getRoomInfo(roomCode) {
    const room = rooms.get(roomCode);
    if (!room) return null;

    const players = [];
    for (const [, p] of room.players) {
        players.push({ id: p.sessionToken, name: p.name, color: p.color, isHost: p.sessionToken === room.hostSessionToken });
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
        list.push({
            roomCode,
            hostName,
            hasPassword: !!room.password,
            maxPlayers: room.maxPlayers,
            playerCount: room.players.size,
            gameStarted: room.gameStarted
        });
    }
    return list;
}

function broadcastRoomList() {
    io.emit('roomListUpdate', getRoomList());
}

// --- Start Server ---

const listener = server.listen(PORT, () => {
    console.log(`Eurorails server running at http://localhost:${PORT}`);
});

module.exports = listener;
