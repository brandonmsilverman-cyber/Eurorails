/**
 * Generate ground-truth snapshots from the current client game logic.
 *
 * Run once before any code extraction to capture baseline values:
 *   node test/generate-snapshots.js
 *
 * Output: test/snapshots/ground-truth.json
 */

const fs = require('fs');
const path = require('path');
const { loadGameLogic } = require('./snapshot-helper');

const ctx = loadGameLogic();

// --- 1. Generate hex grid ---
ctx.generateHexGrid();
ctx.computeCoastDistances();

const gs = ctx.gameState;

const snapshot = {};

// --- 2. Hex grid generation ---
snapshot.milepostCount = gs.mileposts.length;
snapshot.cityToMilepost = gs.cityToMilepost;
snapshot.ferryConnections = gs.ferryConnections;

// Total neighbor edge count (sum of all neighbor array lengths)
snapshot.totalNeighborEdges = gs.mileposts.reduce((sum, mp) => sum + mp.neighbors.length, 0);

// ~20 sample mileposts spread across the grid: capture id, x, y, terrain, landmass, city name, neighbor count
const sampleIndices = [0, 50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 1000,
    1100, 1200, 1300, 1400, 1500, 1600, 1700, gs.mileposts.length - 1];
snapshot.sampleMileposts = sampleIndices
    .filter(i => i < gs.mileposts.length)
    .map(i => {
        const mp = gs.mileposts[i];
        return {
            id: mp.id,
            x: mp.x,
            y: mp.y,
            terrain: mp.terrain,
            landmass: mp.landmass,
            city: mp.city ? mp.city.name : null,
            neighborCount: mp.neighbors.length,
        };
    });

// --- 3. Terrain determination ---
// 50 coordinate pairs spanning all terrain types
const terrainTestPoints = [
    // Alpine region samples
    { x: 43, y: 38 }, { x: 45, y: 37 }, { x: 47, y: 38 }, { x: 50, y: 40 },
    { x: 44, y: 42 }, { x: 41, y: 40 }, { x: 48, y: 41 }, { x: 46, y: 44 },
    { x: 42, y: 45 }, { x: 51, y: 39 },
    // Mountain region samples
    { x: 29, y: 13 }, { x: 30, y: 14 }, { x: 41, y: 7 }, { x: 50, y: 30 },
    { x: 56, y: 32 }, { x: 57, y: 46 }, { x: 47, y: 51 }, { x: 25, y: 58 },
    { x: 52, y: 31 }, { x: 55, y: 36 },
    // Clear terrain samples
    { x: 30, y: 25 }, { x: 35, y: 37 }, { x: 40, y: 27 }, { x: 50, y: 24 },
    { x: 45, y: 20 }, { x: 38, y: 30 }, { x: 33, y: 30 }, { x: 58, y: 26 },
    { x: 20, y: 24 }, { x: 24, y: 58 },
    // Edge cases / boundaries
    { x: 39, y: 37 }, { x: 53, y: 36 }, { x: 55, y: 38 }, { x: 48, y: 44 },
    { x: 44, y: 48 }, { x: 27, y: 48 }, { x: 31, y: 47 }, { x: 48, y: 29 },
    { x: 54, y: 43 }, { x: 22, y: 55 },
    // Additional spread
    { x: 19, y: 54 }, { x: 33, y: 56 }, { x: 43.5, y: 43 }, { x: 28, y: 62 },
    { x: 47, y: 13 }, { x: 44, y: 8 }, { x: 59, y: 44 }, { x: 21, y: 66 },
    { x: 53, y: 9 }, { x: 17, y: 61 },
];
snapshot.terrainTypes = terrainTestPoints.map(({ x, y }) => ({
    x, y,
    terrain: ctx.getTerrainType(x, y),
}));

// --- 4. terrainHash determinism ---
const hashTestPoints = [
    { x: 30, y: 25 }, { x: 45.5, y: 17 }, { x: 43, y: 38 },
    { x: 0, y: 0 }, { x: 100, y: 100 }, { x: 33.33, y: 66.66 },
];
snapshot.terrainHashes = hashTestPoints.map(({ x, y }) => ({
    x, y,
    hash: ctx.terrainHash(x, y),
}));

// --- 5. Coast distances ---
// Sample 20 mileposts for coast distance
const coastSampleIds = sampleIndices
    .filter(i => i < gs.mileposts.length)
    .map(i => gs.mileposts[i].id);
snapshot.coastDistances = coastSampleIds.map(id => ({
    id,
    coastDistance: gs.coastDistance[id],
}));

// --- 6. Build pathfinding (findPath) ---
const pathCityPairs = [
    ["London", "Paris"],
    ["London", "Birmingham"],
    ["Berlin", "München"],
    ["Madrid", "Barcelona"],
    ["Amsterdam", "Vienna"],
    ["Oslo", "Stockholm"],
    ["Milano", "Roma"],
    ["Lisboa", "Porto"],
    ["Hamburg", "Warszawa"],
    ["Dublin", "Cork"],
];
// Note: "Wien" might be "Vienna" in the CITIES map
snapshot.buildPaths = pathCityPairs.map(([from, to]) => {
    // Handle city name variations
    const fromId = gs.cityToMilepost[from];
    const toId = gs.cityToMilepost[to];
    if (fromId === undefined || toId === undefined) {
        return { from, to, error: "city not found", fromId, toId };
    }
    const result = ctx.findPath(fromId, toId, "red", "cheapest");
    return {
        from,
        to,
        path: result ? result.path : null,
        cost: result ? result.cost : null,
    };
});

// Also test "shortest" mode for a couple paths
snapshot.shortestPaths = [
    ["London", "Paris"],
    ["Berlin", "München"],
].map(([from, to]) => {
    const fromId = gs.cityToMilepost[from];
    const toId = gs.cityToMilepost[to];
    if (fromId === undefined || toId === undefined) {
        return { from, to, error: "city not found" };
    }
    const result = ctx.findPath(fromId, toId, "red", "shortest");
    return {
        from,
        to,
        path: result ? result.path : null,
        cost: result ? result.cost : null,
    };
});

// --- 7. Movement pathfinding (findPathOnTrack) ---
// Build a track from London toward Birmingham using the build path,
// then test movement along it
const londonId = gs.cityToMilepost["London"];
const birmId = gs.cityToMilepost["Birmingham"];
const buildResult = ctx.findPath(londonId, birmId, "red", "cheapest");
if (buildResult) {
    // Lay down the track
    for (let i = 0; i < buildResult.path.length - 1; i++) {
        gs.tracks.push({ from: buildResult.path[i], to: buildResult.path[i + 1], color: "red" });
    }
    const moveResult = ctx.findPathOnTrack(londonId, birmId, "red", false);
    snapshot.movementPath = {
        from: "London",
        to: "Birmingham",
        trackPath: buildResult.path,
        movePath: moveResult ? moveResult.path : null,
        ferryCrossings: moveResult ? moveResult.ferryCrossings : null,
        foreignSegments: moveResult ? moveResult.foreignSegments : null,
    };
    // Clean up tracks
    gs.tracks = [];
}

// --- 8. Event zones ---
// For each event card with a zone, capture a few in-zone and out-of-zone milepost checks
snapshot.eventZones = {};
for (const evt of ctx.EVENT_CARDS) {
    if (evt.radius && (evt.city || evt.seaAreas)) {
        // Get the zone mileposts
        let zoneIds;
        if (evt.city) {
            const cityMpId = gs.cityToMilepost[evt.city];
            if (cityMpId !== undefined) {
                zoneIds = ctx.getMilepostsInHexRange(cityMpId, evt.radius);
            }
        } else if (evt.seaAreas) {
            const coastalStarts = ctx.getCoastalMilepostsForSeaAreas(evt.seaAreas);
            zoneIds = ctx.getMilepostsInHexRangeMultiSource(coastalStarts, evt.radius - 1);
        }

        if (zoneIds) {
            const zoneArray = [...zoneIds].sort((a, b) => a - b);
            snapshot.eventZones[evt.id] = {
                title: evt.title,
                zoneSize: zoneArray.length,
                // Store first 10 and last 10 IDs for verification
                sampleInZone: zoneArray.slice(0, 10),
                sampleOutZone: gs.mileposts
                    .filter(mp => !zoneIds.has(mp.id))
                    .slice(0, 5)
                    .map(mp => mp.id),
            };
        }
    }
}

// --- 9. isMilepostInEventZone spot checks ---
snapshot.eventZoneSpotChecks = [];
for (const evt of ctx.EVENT_CARDS) {
    if (!evt.radius || (!evt.city && !evt.seaAreas)) continue;

    // Check a known in-zone milepost (the city itself for city-based events)
    if (evt.city) {
        const cityMpId = gs.cityToMilepost[evt.city];
        if (cityMpId !== undefined) {
            snapshot.eventZoneSpotChecks.push({
                eventId: evt.id,
                milepostId: cityMpId,
                expected: true,
                actual: ctx.isMilepostInEventZone(evt, cityMpId),
            });
        }
    }

    // Check a milepost that should be far out of zone
    const farMp = gs.mileposts[0]; // first milepost is in the far north
    snapshot.eventZoneSpotChecks.push({
        eventId: evt.id,
        milepostId: farMp.id,
        actual: ctx.isMilepostInEventZone(evt, farMp.id),
    });
}

// --- 10. landmassesConnected ---
snapshot.landmassConnections = [
    ["continental", "italy", true],
    ["italy", "continental", true],
    ["continental", "iberia", true],
    ["britain", "continental", false],
    ["britain", "ireland", false],
    ["continental", "scandinavia", false],
    ["continental", "denmark", true],
    ["denmark", "scandinavia", true],
    ["zealand", "denmark", true],
    ["zealand", "scandinavia", true],
].map(([lm1, lm2, expected]) => ({
    lm1, lm2, expected,
    actual: ctx.landmassesConnected(lm1, lm2),
}));

// --- 11. canPlayerBuildFerry / playerOwnsFerry ---
// These use gameState.ferryOwnership directly
snapshot.ferryOwnershipTests = (() => {
    const ferryKey = "100|200";
    const results = [];

    gs.ferryOwnership = {};
    results.push({ desc: "empty - can build", result: ctx.canPlayerBuildFerry(ferryKey, "red") });

    gs.ferryOwnership = { [ferryKey]: ["blue"] };
    results.push({ desc: "one owner - can build", result: ctx.canPlayerBuildFerry(ferryKey, "red") });
    results.push({ desc: "one owner - already owns", result: ctx.canPlayerBuildFerry(ferryKey, "blue") });
    results.push({ desc: "one owner - playerOwnsFerry blue", result: ctx.playerOwnsFerry(ferryKey, "blue") });
    results.push({ desc: "one owner - playerOwnsFerry red", result: ctx.playerOwnsFerry(ferryKey, "red") });

    gs.ferryOwnership = { [ferryKey]: ["blue", "green"] };
    results.push({ desc: "two owners - cannot build", result: ctx.canPlayerBuildFerry(ferryKey, "red") });
    results.push({ desc: "two owners - already owns blue", result: ctx.canPlayerBuildFerry(ferryKey, "blue") });

    gs.ferryOwnership = {};
    return results;
})();

// --- Write snapshot ---
const outPath = path.join(__dirname, 'snapshots', 'ground-truth.json');
fs.writeFileSync(outPath, JSON.stringify(snapshot, null, 2));
console.log(`Snapshot written to ${outPath}`);
console.log(`  Milepost count: ${snapshot.milepostCount}`);
console.log(`  Cities mapped: ${Object.keys(snapshot.cityToMilepost).length}`);
console.log(`  Ferry connections: ${snapshot.ferryConnections.length}`);
console.log(`  Terrain samples: ${snapshot.terrainTypes.length}`);
console.log(`  Build paths: ${snapshot.buildPaths.length}`);
console.log(`  Event zones: ${Object.keys(snapshot.eventZones).length}`);
