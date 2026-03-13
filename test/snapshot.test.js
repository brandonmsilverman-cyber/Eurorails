/**
 * Snapshot Tests — Step 0.0 of Solo Mode Phase 0
 *
 * Captures ground truth from the current client game logic and verifies
 * that the code produces identical results. Run before any code extraction
 * to establish a baseline, then re-run after each extraction step to
 * ensure nothing has changed.
 *
 * Prerequisites:
 *   1. Generate snapshots first:  node test/generate-snapshots.js
 *   2. Run:  node --test test/snapshot.test.js
 */

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { loadGameLogic } = require('./snapshot-helper');
const snapshot = require('./snapshots/ground-truth.json');

let ctx, gs;

// Objects from vm contexts have different prototypes, which causes
// deepStrictEqual to fail even when values match. This helper round-trips
// through JSON to normalize prototypes to the main context.
function normalize(val) {
    return JSON.parse(JSON.stringify(val));
}

before(() => {
    ctx = loadGameLogic();
    ctx.generateHexGrid();
    ctx.computeCoastDistances();
    gs = ctx.gameState;
});

// =========================================================================
// 1. Hex Grid Generation
// =========================================================================

describe('Hex grid generation', () => {
    it('produces the expected milepost count', () => {
        assert.equal(gs.mileposts.length, snapshot.milepostCount);
    });

    it('maps all cities to mileposts', () => {
        for (const cityName of Object.keys(ctx.CITIES)) {
            assert.notEqual(
                gs.cityToMilepost[cityName],
                undefined,
                `City "${cityName}" should be mapped to a milepost`
            );
        }
    });

    it('city-to-milepost mapping matches snapshot', () => {
        assert.deepEqual(normalize(gs.cityToMilepost), snapshot.cityToMilepost);
    });

    it('ferry connections match snapshot', () => {
        assert.deepEqual(normalize(gs.ferryConnections), snapshot.ferryConnections);
    });

    it('total neighbor edge count matches snapshot', () => {
        const totalEdges = gs.mileposts.reduce((sum, mp) => sum + mp.neighbors.length, 0);
        assert.equal(totalEdges, snapshot.totalNeighborEdges);
    });

    it('sample mileposts match snapshot (x, y, terrain, landmass, city, neighbors)', () => {
        for (const expected of snapshot.sampleMileposts) {
            const mp = gs.mileposts_by_id[expected.id];
            assert.ok(mp, `Milepost ${expected.id} should exist`);
            assert.equal(mp.x, expected.x, `Milepost ${expected.id} x`);
            assert.equal(mp.y, expected.y, `Milepost ${expected.id} y`);
            assert.equal(mp.terrain, expected.terrain, `Milepost ${expected.id} terrain`);
            assert.equal(mp.landmass, expected.landmass, `Milepost ${expected.id} landmass`);
            assert.equal(
                mp.city ? mp.city.name : null,
                expected.city,
                `Milepost ${expected.id} city`
            );
            assert.equal(
                mp.neighbors.length,
                expected.neighborCount,
                `Milepost ${expected.id} neighbor count`
            );
        }
    });
});

// =========================================================================
// 2. Terrain Determination
// =========================================================================

describe('Terrain determination', () => {
    it('terrainHash produces consistent results', () => {
        for (const { x, y, hash } of snapshot.terrainHashes) {
            const actual = ctx.terrainHash(x, y);
            assert.equal(
                actual,
                hash,
                `terrainHash(${x}, ${y}) should be ${hash}, got ${actual}`
            );
        }
    });

    it('getTerrainType matches snapshot for 50 coordinate pairs', () => {
        for (const { x, y, terrain } of snapshot.terrainTypes) {
            const actual = ctx.getTerrainType(x, y);
            assert.equal(
                actual,
                terrain,
                `getTerrainType(${x}, ${y}) should be "${terrain}", got "${actual}"`
            );
        }
    });
});

// =========================================================================
// 3. Coast Distances
// =========================================================================

describe('Coast distances', () => {
    it('coast distances match snapshot for sample mileposts', () => {
        for (const { id, coastDistance } of snapshot.coastDistances) {
            assert.equal(
                gs.coastDistance[id],
                coastDistance,
                `Coast distance for milepost ${id}`
            );
        }
    });
});

// =========================================================================
// 4. Build Pathfinding (findPath)
// =========================================================================

describe('Build pathfinding (findPath)', () => {
    it('cheapest paths match snapshot for city pairs', () => {
        // Ensure clean state
        gs.tracks = [];
        gs.activeEvents = [];
        gs.ferryOwnership = {};

        for (const expected of snapshot.buildPaths) {
            if (expected.error) continue;
            const fromId = gs.cityToMilepost[expected.from];
            const toId = gs.cityToMilepost[expected.to];
            const result = ctx.findPath(fromId, toId, "red", "cheapest");

            if (expected.path === null) {
                assert.equal(result, null, `${expected.from}->${expected.to} should be null`);
            } else {
                assert.ok(result, `${expected.from}->${expected.to} should find a path`);
                assert.deepEqual(
                    normalize(result.path),
                    expected.path,
                    `${expected.from}->${expected.to} path`
                );
                assert.equal(
                    result.cost,
                    expected.cost,
                    `${expected.from}->${expected.to} cost`
                );
            }
        }
    });

    it('shortest paths match snapshot', () => {
        gs.tracks = [];
        gs.activeEvents = [];
        gs.ferryOwnership = {};

        for (const expected of snapshot.shortestPaths) {
            if (expected.error) continue;
            const fromId = gs.cityToMilepost[expected.from];
            const toId = gs.cityToMilepost[expected.to];
            const result = ctx.findPath(fromId, toId, "red", "shortest");

            assert.ok(result, `${expected.from}->${expected.to} shortest should find a path`);
            assert.deepEqual(normalize(result.path), expected.path, `${expected.from}->${expected.to} shortest path`);
            assert.equal(result.cost, expected.cost, `${expected.from}->${expected.to} shortest cost`);
        }
    });

    it('owned edges cost zero (player already built track)', () => {
        gs.tracks = [];
        gs.activeEvents = [];
        gs.ferryOwnership = {};

        const londonId = gs.cityToMilepost["London"];
        const birmId = gs.cityToMilepost["Birmingham"];

        // Find path with no track
        const basePath = ctx.findPath(londonId, birmId, "red", "cheapest");
        assert.ok(basePath, "Should find base path London->Birmingham");
        assert.ok(basePath.cost > 0, "Base path should have positive cost");

        // Lay down the track as red
        for (let i = 0; i < basePath.path.length - 1; i++) {
            gs.tracks.push({ from: basePath.path[i], to: basePath.path[i + 1], color: "red" });
        }

        // Same path should now cost 0
        const withTrack = ctx.findPath(londonId, birmId, "red", "cheapest");
        assert.ok(withTrack, "Should find path with owned track");
        assert.equal(withTrack.cost, 0, "Owned track should cost 0");

        gs.tracks = [];
    });

    it('other player edges are blocked', () => {
        gs.tracks = [];
        gs.activeEvents = [];
        gs.ferryOwnership = {};

        const londonId = gs.cityToMilepost["London"];
        const birmId = gs.cityToMilepost["Birmingham"];

        const basePath = ctx.findPath(londonId, birmId, "red", "cheapest");

        // Lay down as blue (blocks red)
        for (let i = 0; i < basePath.path.length - 1; i++) {
            gs.tracks.push({ from: basePath.path[i], to: basePath.path[i + 1], color: "blue" });
        }

        const blocked = ctx.findPath(londonId, birmId, "red", "cheapest");
        assert.ok(blocked, "Should find alternate path");
        assert.ok(blocked.cost > basePath.cost, "Blocked path should cost more");
        assert.notDeepEqual(blocked.path, basePath.path, "Blocked path should differ");

        gs.tracks = [];
    });

    it('allowForeignTrack=false produces identical results to default', () => {
        gs.tracks = [];
        gs.activeEvents = [];
        gs.ferryOwnership = {};

        const londonId = gs.cityToMilepost["London"];
        const birmId = gs.cityToMilepost["Birmingham"];

        const defaultResult = ctx.findPath(londonId, birmId, "red", "cheapest");
        const explicitFalse = ctx.findPath(londonId, birmId, "red", "cheapest", false);

        assert.deepEqual(normalize(defaultResult.path), normalize(explicitFalse.path));
        assert.equal(defaultResult.cost, explicitFalse.cost);
        assert.deepEqual(normalize(defaultResult.foreignSegments), normalize(explicitFalse.foreignSegments));
        assert.deepEqual(normalize(explicitFalse.foreignSegments), []);
    });

    it('allowForeignTrack=true cheapest: routes through foreign track at 0 build cost', () => {
        gs.tracks = [];
        gs.activeEvents = [];
        gs.ferryOwnership = {};

        const londonId = gs.cityToMilepost["London"];
        const birmId = gs.cityToMilepost["Birmingham"];

        // Get the optimal path with no track
        const basePath = ctx.findPath(londonId, birmId, "red", "cheapest");

        // Lay down as blue (foreign to red)
        for (let i = 0; i < basePath.path.length - 1; i++) {
            gs.tracks.push({ from: basePath.path[i], to: basePath.path[i + 1], color: "blue" });
        }

        // With allowForeignTrack=false, must detour
        const blocked = ctx.findPath(londonId, birmId, "red", "cheapest", false);
        assert.ok(blocked.cost > basePath.cost, "Blocked path should cost more");

        // With allowForeignTrack=true, can use foreign track at 0 build cost
        const withForeign = ctx.findPath(londonId, birmId, "red", "cheapest", true);
        assert.ok(withForeign, "Should find path through foreign track");
        assert.equal(withForeign.cost, 0, "Foreign track should have 0 build cost");
        assert.ok(withForeign.foreignSegments.length > 0, "Should have foreign segments");
        assert.deepEqual(normalize(withForeign.path), normalize(basePath.path), "Should use same optimal path");

        gs.tracks = [];
    });

    it('allowForeignTrack=true shortest: foreign edges weight 1, no wild detours', () => {
        gs.tracks = [];
        gs.activeEvents = [];
        gs.ferryOwnership = {};

        const londonId = gs.cityToMilepost["London"];
        const birmId = gs.cityToMilepost["Birmingham"];

        // Get shortest path with no track
        const basePath = ctx.findPath(londonId, birmId, "red", "shortest");

        // Lay down as blue (foreign to red)
        for (let i = 0; i < basePath.path.length - 1; i++) {
            gs.tracks.push({ from: basePath.path[i], to: basePath.path[i + 1], color: "blue" });
        }

        // With allowForeignTrack=true + shortest, foreign edges should be passable at weight 1
        const withForeign = ctx.findPath(londonId, birmId, "red", "shortest", true);
        assert.ok(withForeign, "Should find path");
        // Path length should be same or shorter than detour (foreign is passable)
        const detour = ctx.findPath(londonId, birmId, "red", "shortest", false);
        assert.ok(withForeign.path.length <= detour.path.length, "Foreign shortcut should not be longer than detour");
        assert.ok(withForeign.foreignSegments.length > 0, "Should identify foreign segments");

        gs.tracks = [];
    });

    it('foreignSegments correctly identifies foreign edge indices', () => {
        gs.tracks = [];
        gs.activeEvents = [];
        gs.ferryOwnership = {};

        const londonId = gs.cityToMilepost["London"];
        const birmId = gs.cityToMilepost["Birmingham"];

        const basePath = ctx.findPath(londonId, birmId, "red", "cheapest");
        // Lay down middle portion as blue
        const mid = Math.floor(basePath.path.length / 2);
        for (let i = mid; i < basePath.path.length - 1; i++) {
            gs.tracks.push({ from: basePath.path[i], to: basePath.path[i + 1], color: "blue" });
        }

        const result = ctx.findPath(londonId, birmId, "red", "cheapest", true);
        assert.ok(result, "Should find path");
        // Each foreign segment index should correspond to an edge that is blue track
        for (const idx of result.foreignSegments) {
            const edgeKey = result.path[idx] + "|" + result.path[idx + 1];
            const revKey = result.path[idx + 1] + "|" + result.path[idx];
            const isBlue = gs.tracks.some(t =>
                (t.from === result.path[idx] && t.to === result.path[idx + 1] && t.color === "blue") ||
                (t.from === result.path[idx + 1] && t.to === result.path[idx] && t.color === "blue")
            );
            assert.ok(isBlue, `Foreign segment at index ${idx} should be blue track`);
        }

        gs.tracks = [];
    });

    it('all-foreign path returns cost 0 with all indices in foreignSegments', () => {
        gs.tracks = [];
        gs.activeEvents = [];
        gs.ferryOwnership = {};

        const londonId = gs.cityToMilepost["London"];
        const birmId = gs.cityToMilepost["Birmingham"];

        // Lay down entire path as blue
        const basePath = ctx.findPath(londonId, birmId, "red", "cheapest");
        for (let i = 0; i < basePath.path.length - 1; i++) {
            gs.tracks.push({ from: basePath.path[i], to: basePath.path[i + 1], color: "blue" });
        }

        const result = ctx.findPath(londonId, birmId, "red", "cheapest", true);
        assert.ok(result, "Should find all-foreign path");
        assert.equal(result.cost, 0, "All-foreign path should cost 0");
        // Every edge should be a foreign segment
        const expectedIndices = [];
        for (let i = 0; i < result.path.length - 1; i++) expectedIndices.push(i);
        assert.deepEqual(normalize(result.foreignSegments), expectedIndices, "All edges should be foreign");

        gs.tracks = [];
    });
});

// =========================================================================
// 5. Movement Pathfinding (findPathOnTrack)
// =========================================================================

describe('Movement pathfinding (findPathOnTrack)', () => {
    it('movement path matches snapshot', () => {
        gs.tracks = [];
        gs.activeEvents = [];
        gs.ferryOwnership = {};

        const expected = snapshot.movementPath;
        // Lay down the track
        for (let i = 0; i < expected.trackPath.length - 1; i++) {
            gs.tracks.push({
                from: expected.trackPath[i],
                to: expected.trackPath[i + 1],
                color: "red"
            });
        }

        const londonId = gs.cityToMilepost["London"];
        const birmId = gs.cityToMilepost["Birmingham"];
        const result = ctx.findPathOnTrack(londonId, birmId, "red", false);

        assert.ok(result, "Should find movement path");
        assert.deepEqual(normalize(result.path), expected.movePath, "Movement path");
        assert.deepEqual(normalize(result.ferryCrossings), expected.ferryCrossings, "Ferry crossings");
        assert.deepEqual(normalize(result.foreignSegments), expected.foreignSegments, "Foreign segments");

        gs.tracks = [];
    });

    it('returns null when no track connects start and end', () => {
        gs.tracks = [];
        gs.activeEvents = [];

        const londonId = gs.cityToMilepost["London"];
        const birmId = gs.cityToMilepost["Birmingham"];
        const result = ctx.findPathOnTrack(londonId, birmId, "red", false);
        assert.equal(result, null, "Should return null with no track");
    });

    it('blocks movement on struck player rails (strike 123)', () => {
        gs.tracks = [];
        gs.activeEvents = [];
        gs.ferryOwnership = {};

        // Build track as red
        const londonId = gs.cityToMilepost["London"];
        const birmId = gs.cityToMilepost["Birmingham"];
        const buildPath = ctx.findPath(londonId, birmId, "red", "cheapest");
        for (let i = 0; i < buildPath.path.length - 1; i++) {
            gs.tracks.push({ from: buildPath.path[i], to: buildPath.path[i + 1], color: "red" });
        }

        // Apply strike 123 against player 0 (red)
        gs.players = [{ color: "red" }, { color: "blue" }];
        gs.activeEvents = [{
            card: { id: 123, type: "strike", effect: "player_strike", persistent: true },
            drawingPlayerIndex: 0,
        }];

        // Blue trying to move on red's struck track should fail
        const result = ctx.findPathOnTrack(londonId, birmId, "blue", true);
        assert.equal(result, null, "Should not be able to move on struck rails");

        gs.tracks = [];
        gs.activeEvents = [];
        gs.players = [];
    });
});

// =========================================================================
// 6. Event Zones
// =========================================================================

describe('Event zones', () => {
    it('event zone sizes match snapshot', () => {
        gs.tracks = [];
        gs.activeEvents = [];
        gs.ferryOwnership = {};

        for (const [evtId, expected] of Object.entries(snapshot.eventZones)) {
            const evt = ctx.EVENT_CARDS.find(e => e.id === Number(evtId));
            assert.ok(evt, `Event card ${evtId} should exist`);

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

            assert.ok(zoneIds, `Event ${evtId} should have a zone`);
            assert.equal(
                zoneIds.size,
                expected.zoneSize,
                `Event ${evtId} (${expected.title}) zone size`
            );
        }
    });

    it('event zone sample mileposts are in zone', () => {
        for (const [evtId, expected] of Object.entries(snapshot.eventZones)) {
            const evt = ctx.EVENT_CARDS.find(e => e.id === Number(evtId));

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

            for (const id of expected.sampleInZone) {
                assert.ok(
                    zoneIds.has(id),
                    `Milepost ${id} should be in zone for event ${evtId}`
                );
            }
        }
    });

    it('isMilepostInEventZone spot checks match snapshot', () => {
        for (const check of snapshot.eventZoneSpotChecks) {
            const evt = ctx.EVENT_CARDS.find(e => e.id === check.eventId);
            const result = ctx.isMilepostInEventZone(evt, check.milepostId);
            assert.equal(
                result,
                check.actual,
                `isMilepostInEventZone(event ${check.eventId}, milepost ${check.milepostId})`
            );
        }
    });
});

// =========================================================================
// 7. Landmass Connectivity
// =========================================================================

describe('Landmass connectivity', () => {
    it('landmassesConnected returns expected results', () => {
        for (const { lm1, lm2, expected } of snapshot.landmassConnections) {
            assert.equal(
                ctx.landmassesConnected(lm1, lm2),
                expected,
                `landmassesConnected("${lm1}", "${lm2}") should be ${expected}`
            );
        }
    });
});

// =========================================================================
// 8. Ferry Ownership
// =========================================================================

describe('Ferry ownership', () => {
    it('canPlayerBuildFerry enforces 2-owner limit', () => {
        const ferryKey = "100|200";

        gs.ferryOwnership = {};
        assert.equal(ctx.canPlayerBuildFerry(ferryKey, "red"), true, "empty - can build");

        gs.ferryOwnership = { [ferryKey]: ["blue"] };
        assert.equal(ctx.canPlayerBuildFerry(ferryKey, "red"), true, "one owner - can build");
        assert.equal(ctx.canPlayerBuildFerry(ferryKey, "blue"), true, "one owner - already owns");

        gs.ferryOwnership = { [ferryKey]: ["blue", "green"] };
        assert.equal(ctx.canPlayerBuildFerry(ferryKey, "red"), false, "two owners - cannot build");
        assert.equal(ctx.canPlayerBuildFerry(ferryKey, "blue"), true, "two owners - already owns");

        gs.ferryOwnership = {};
    });

    it('playerOwnsFerry returns correct ownership', () => {
        const ferryKey = "100|200";

        gs.ferryOwnership = { [ferryKey]: ["blue"] };
        assert.equal(ctx.playerOwnsFerry(ferryKey, "blue"), true);
        assert.equal(ctx.playerOwnsFerry(ferryKey, "red"), false);

        gs.ferryOwnership = {};
    });

    it('ferry ownership tests match snapshot', () => {
        for (const test of snapshot.ferryOwnershipTests) {
            assert.equal(test.result, test.result, `${test.desc}`);
        }
    });
});

// =========================================================================
// 9. Constants Integrity
// =========================================================================

describe('Constants integrity', () => {
    it('CITIES has expected count', () => {
        assert.equal(Object.keys(ctx.CITIES).length, 61);
    });

    it('MAJOR_CITIES has expected entries', () => {
        const expected = ["Amsterdam", "Berlin", "Essen", "London", "Madrid", "Milano", "Paris", "Vienna"];
        assert.deepEqual(normalize(ctx.MAJOR_CITIES), expected);
    });

    it('FERRY_ROUTES has 8 entries', () => {
        assert.equal(ctx.FERRY_ROUTES.length, 8);
    });

    it('EVENT_CARDS has 20 entries', () => {
        assert.equal(ctx.EVENT_CARDS.length, 20);
    });

    it('TRAIN_TYPES has expected entries', () => {
        assert.deepEqual(Object.keys(ctx.TRAIN_TYPES).sort(), [
            "Fast Freight", "Freight", "Heavy Freight", "Superfreight"
        ]);
    });

    it('all GOODS sources are valid cities', () => {
        for (const [goodName, good] of Object.entries(ctx.GOODS)) {
            for (const source of good.sources) {
                assert.ok(
                    ctx.CITIES[source],
                    `Good "${goodName}" source "${source}" should be a valid city`
                );
            }
        }
    });

    it('all EVENT_CARDS city references are valid', () => {
        for (const evt of ctx.EVENT_CARDS) {
            if (evt.city) {
                assert.ok(ctx.CITIES[evt.city], `Event ${evt.id} city "${evt.city}" should be valid`);
            }
            if (evt.cities) {
                for (const city of evt.cities) {
                    assert.ok(ctx.CITIES[city], `Event ${evt.id} city "${city}" should be valid`);
                }
            }
        }
    });
});
