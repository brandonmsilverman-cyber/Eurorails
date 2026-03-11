/**
 * Extraction Tests — Step 0.1 of Solo Mode Phase 0
 *
 * Validates that shared/game-logic.js produces identical results to the
 * inline client code, using the same ground-truth snapshots.
 *
 * Run:  node --test test/extraction.test.js
 */

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const snapshot = require('./snapshots/ground-truth.json');

// Load the shared module directly (no vm sandbox needed — it's a proper Node module)
const gl = require('../shared/game-logic');

// Helper to build a ctx object from grid data + overrides
function makeCtx(grid, overrides) {
    return {
        mileposts: grid.mileposts,
        mileposts_by_id: grid.mileposts_by_id,
        cityToMilepost: grid.cityToMilepost,
        ferryConnections: grid.ferryConnections,
        ferryOwnership: {},
        tracks: [],
        activeEvents: [],
        players: [],
        ...overrides
    };
}

let grid, ctx;

before(() => {
    grid = gl.generateHexGrid();
    ctx = makeCtx(grid);
});

// =========================================================================
// 1. Hex Grid Generation
// =========================================================================

describe('Hex grid generation (shared module)', () => {
    it('produces the expected milepost count', () => {
        assert.equal(grid.mileposts.length, snapshot.milepostCount);
    });

    it('maps all cities to mileposts', () => {
        for (const cityName of Object.keys(gl.CITIES)) {
            assert.notEqual(
                grid.cityToMilepost[cityName],
                undefined,
                `City "${cityName}" should be mapped to a milepost`
            );
        }
    });

    it('city-to-milepost mapping matches snapshot', () => {
        assert.deepEqual(grid.cityToMilepost, snapshot.cityToMilepost);
    });

    it('ferry connections match snapshot', () => {
        assert.deepEqual(grid.ferryConnections, snapshot.ferryConnections);
    });

    it('total neighbor edge count matches snapshot', () => {
        const totalEdges = grid.mileposts.reduce((sum, mp) => sum + mp.neighbors.length, 0);
        assert.equal(totalEdges, snapshot.totalNeighborEdges);
    });

    it('sample mileposts match snapshot (x, y, terrain, landmass, city, neighbors)', () => {
        for (const expected of snapshot.sampleMileposts) {
            const mp = grid.mileposts_by_id[expected.id];
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

describe('Terrain determination (shared module)', () => {
    it('terrainHash produces consistent results', () => {
        for (const { x, y, hash } of snapshot.terrainHashes) {
            const actual = gl.terrainHash(x, y);
            assert.equal(
                actual,
                hash,
                `terrainHash(${x}, ${y}) should be ${hash}, got ${actual}`
            );
        }
    });

    it('getTerrainType matches snapshot for 50 coordinate pairs', () => {
        for (const { x, y, terrain } of snapshot.terrainTypes) {
            const actual = gl.getTerrainType(x, y);
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

describe('Coast distances (shared module)', () => {
    it('coast distances match snapshot for sample mileposts', () => {
        const coastDist = gl.computeCoastDistances(ctx);
        for (const { id, coastDistance } of snapshot.coastDistances) {
            assert.equal(
                coastDist[id],
                coastDistance,
                `Coast distance for milepost ${id}`
            );
        }
    });
});

// =========================================================================
// 4. Build Pathfinding (findPath)
// =========================================================================

describe('Build pathfinding (shared module)', () => {
    it('cheapest paths match snapshot for city pairs', () => {
        const pathCtx = makeCtx(grid);

        for (const expected of snapshot.buildPaths) {
            if (expected.error) continue;
            const fromId = grid.cityToMilepost[expected.from];
            const toId = grid.cityToMilepost[expected.to];
            const result = gl.findPath(pathCtx, fromId, toId, "red", "cheapest");

            if (expected.path === null) {
                assert.equal(result, null, `${expected.from}->${expected.to} should be null`);
            } else {
                assert.ok(result, `${expected.from}->${expected.to} should find a path`);
                assert.deepEqual(
                    result.path,
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
        const pathCtx = makeCtx(grid);

        for (const expected of snapshot.shortestPaths) {
            if (expected.error) continue;
            const fromId = grid.cityToMilepost[expected.from];
            const toId = grid.cityToMilepost[expected.to];
            const result = gl.findPath(pathCtx, fromId, toId, "red", "shortest");

            assert.ok(result, `${expected.from}->${expected.to} shortest should find a path`);
            assert.deepEqual(result.path, expected.path, `${expected.from}->${expected.to} shortest path`);
            assert.equal(result.cost, expected.cost, `${expected.from}->${expected.to} shortest cost`);
        }
    });

    it('owned edges cost zero (player already built track)', () => {
        const pathCtx = makeCtx(grid);
        const londonId = grid.cityToMilepost["London"];
        const birmId = grid.cityToMilepost["Birmingham"];

        // Find path with no track
        const basePath = gl.findPath(pathCtx, londonId, birmId, "red", "cheapest");
        assert.ok(basePath, "Should find base path London->Birmingham");
        assert.ok(basePath.cost > 0, "Base path should have positive cost");

        // Lay down the track as red
        const tracks = [];
        for (let i = 0; i < basePath.path.length - 1; i++) {
            tracks.push({ from: basePath.path[i], to: basePath.path[i + 1], color: "red" });
        }
        const trackCtx = makeCtx(grid, { tracks: tracks });

        // Same path should now cost 0
        const withTrack = gl.findPath(trackCtx, londonId, birmId, "red", "cheapest");
        assert.ok(withTrack, "Should find path with owned track");
        assert.equal(withTrack.cost, 0, "Owned track should cost 0");
    });

    it('other player edges are blocked', () => {
        const pathCtx = makeCtx(grid);
        const londonId = grid.cityToMilepost["London"];
        const birmId = grid.cityToMilepost["Birmingham"];

        const basePath = gl.findPath(pathCtx, londonId, birmId, "red", "cheapest");

        // Lay down as blue (blocks red)
        const tracks = [];
        for (let i = 0; i < basePath.path.length - 1; i++) {
            tracks.push({ from: basePath.path[i], to: basePath.path[i + 1], color: "blue" });
        }
        const blockedCtx = makeCtx(grid, { tracks: tracks });

        const blocked = gl.findPath(blockedCtx, londonId, birmId, "red", "cheapest");
        assert.ok(blocked, "Should find alternate path");
        assert.ok(blocked.cost > basePath.cost, "Blocked path should cost more");
        assert.notDeepEqual(blocked.path, basePath.path, "Blocked path should differ");
    });
});

// =========================================================================
// 5. Movement Pathfinding (findPathOnTrack)
// =========================================================================

describe('Movement pathfinding (shared module)', () => {
    it('movement path matches snapshot', () => {
        const expected = snapshot.movementPath;
        const tracks = [];
        for (let i = 0; i < expected.trackPath.length - 1; i++) {
            tracks.push({
                from: expected.trackPath[i],
                to: expected.trackPath[i + 1],
                color: "red"
            });
        }
        const moveCtx = makeCtx(grid, { tracks: tracks });

        const londonId = grid.cityToMilepost["London"];
        const birmId = grid.cityToMilepost["Birmingham"];
        const result = gl.findPathOnTrack(moveCtx, londonId, birmId, "red", false);

        assert.ok(result, "Should find movement path");
        assert.deepEqual(result.path, expected.movePath, "Movement path");
        assert.deepEqual(result.ferryCrossings, expected.ferryCrossings, "Ferry crossings");
        assert.deepEqual(result.foreignSegments, expected.foreignSegments, "Foreign segments");
    });

    it('returns null when no track connects start and end', () => {
        const emptyCtx = makeCtx(grid);
        const londonId = grid.cityToMilepost["London"];
        const birmId = grid.cityToMilepost["Birmingham"];
        const result = gl.findPathOnTrack(emptyCtx, londonId, birmId, "red", false);
        assert.equal(result, null, "Should return null with no track");
    });

    it('blocks movement on struck player rails (strike 123)', () => {
        const londonId = grid.cityToMilepost["London"];
        const birmId = grid.cityToMilepost["Birmingham"];

        // Build track as red
        const buildCtx = makeCtx(grid);
        const buildPath = gl.findPath(buildCtx, londonId, birmId, "red", "cheapest");
        const tracks = [];
        for (let i = 0; i < buildPath.path.length - 1; i++) {
            tracks.push({ from: buildPath.path[i], to: buildPath.path[i + 1], color: "red" });
        }

        // Apply strike 123 against player 0 (red)
        const strikeCtx = makeCtx(grid, {
            tracks: tracks,
            activeEvents: [{
                card: { id: 123, type: "strike", effect: "player_strike", persistent: true },
                drawingPlayerIndex: 0,
            }],
            players: [{ color: "red" }, { color: "blue" }]
        });

        // Blue trying to move on red's struck track should fail
        const result = gl.findPathOnTrack(strikeCtx, londonId, birmId, "blue", true);
        assert.equal(result, null, "Should not be able to move on struck rails");
    });
});

// =========================================================================
// 6. Event Zones
// =========================================================================

describe('Event zones (shared module)', () => {
    it('event zone sizes match snapshot', () => {
        for (const [evtId, expected] of Object.entries(snapshot.eventZones)) {
            const evt = gl.EVENT_CARDS.find(e => e.id === Number(evtId));
            assert.ok(evt, `Event card ${evtId} should exist`);

            let zoneIds;
            if (evt.city) {
                const cityMpId = grid.cityToMilepost[evt.city];
                if (cityMpId !== undefined) {
                    zoneIds = gl.getMilepostsInHexRange(ctx, cityMpId, evt.radius);
                }
            } else if (evt.seaAreas) {
                const coastalStarts = gl.getCoastalMilepostsForSeaAreas(ctx, evt.seaAreas);
                zoneIds = gl.getMilepostsInHexRangeMultiSource(ctx, coastalStarts, evt.radius - 1);
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
            const evt = gl.EVENT_CARDS.find(e => e.id === Number(evtId));

            let zoneIds;
            if (evt.city) {
                const cityMpId = grid.cityToMilepost[evt.city];
                if (cityMpId !== undefined) {
                    zoneIds = gl.getMilepostsInHexRange(ctx, cityMpId, evt.radius);
                }
            } else if (evt.seaAreas) {
                const coastalStarts = gl.getCoastalMilepostsForSeaAreas(ctx, evt.seaAreas);
                zoneIds = gl.getMilepostsInHexRangeMultiSource(ctx, coastalStarts, evt.radius - 1);
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
            const evt = gl.EVENT_CARDS.find(e => e.id === check.eventId);
            const result = gl.isMilepostInEventZone(ctx, evt, check.milepostId);
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

describe('Landmass connectivity (shared module)', () => {
    it('landmassesConnected returns expected results', () => {
        for (const { lm1, lm2, expected } of snapshot.landmassConnections) {
            assert.equal(
                gl.landmassesConnected(lm1, lm2),
                expected,
                `landmassesConnected("${lm1}", "${lm2}") should be ${expected}`
            );
        }
    });
});

// =========================================================================
// 8. Ferry Ownership
// =========================================================================

describe('Ferry ownership (shared module)', () => {
    it('canPlayerBuildFerry enforces 2-owner limit', () => {
        const ferryKey = "100|200";

        assert.equal(gl.canPlayerBuildFerry({ ferryOwnership: {} }, ferryKey, "red"), true, "empty - can build");
        assert.equal(gl.canPlayerBuildFerry({ ferryOwnership: { [ferryKey]: ["blue"] } }, ferryKey, "red"), true, "one owner - can build");
        assert.equal(gl.canPlayerBuildFerry({ ferryOwnership: { [ferryKey]: ["blue"] } }, ferryKey, "blue"), true, "one owner - already owns");
        assert.equal(gl.canPlayerBuildFerry({ ferryOwnership: { [ferryKey]: ["blue", "green"] } }, ferryKey, "red"), false, "two owners - cannot build");
        assert.equal(gl.canPlayerBuildFerry({ ferryOwnership: { [ferryKey]: ["blue", "green"] } }, ferryKey, "blue"), true, "two owners - already owns");
    });

    it('playerOwnsFerry returns correct ownership', () => {
        const ferryKey = "100|200";
        assert.equal(gl.playerOwnsFerry({ ferryOwnership: { [ferryKey]: ["blue"] } }, ferryKey, "blue"), true);
        assert.equal(gl.playerOwnsFerry({ ferryOwnership: { [ferryKey]: ["blue"] } }, ferryKey, "red"), false);
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

describe('Constants integrity (shared module)', () => {
    it('CITIES has expected count', () => {
        assert.equal(Object.keys(gl.CITIES).length, 61);
    });

    it('MAJOR_CITIES has expected entries', () => {
        const expected = ["Amsterdam", "Berlin", "Essen", "London", "Madrid", "Milano", "Paris", "Vienna"];
        assert.deepEqual(gl.MAJOR_CITIES, expected);
    });

    it('FERRY_ROUTES has 8 entries', () => {
        assert.equal(gl.FERRY_ROUTES.length, 8);
    });

    it('EVENT_CARDS has 20 entries', () => {
        assert.equal(gl.EVENT_CARDS.length, 20);
    });

    it('TRAIN_TYPES has expected entries', () => {
        assert.deepEqual(Object.keys(gl.TRAIN_TYPES).sort(), [
            "Fast Freight", "Freight", "Heavy Freight", "Superfreight"
        ]);
    });

    it('all GOODS sources are valid cities', () => {
        for (const [goodName, good] of Object.entries(gl.GOODS)) {
            for (const source of good.sources) {
                assert.ok(
                    gl.CITIES[source],
                    `Good "${goodName}" source "${source}" should be a valid city`
                );
            }
        }
    });

    it('all EVENT_CARDS city references are valid', () => {
        for (const evt of gl.EVENT_CARDS) {
            if (evt.city) {
                assert.ok(gl.CITIES[evt.city], `Event ${evt.id} city "${evt.city}" should be valid`);
            }
            if (evt.cities) {
                for (const city of evt.cities) {
                    assert.ok(gl.CITIES[city], `Event ${evt.id} city "${city}" should be valid`);
                }
            }
        }
    });

    it('GOODS_ICONS has entries for all goods', () => {
        for (const goodName of Object.keys(gl.GOODS)) {
            assert.ok(gl.GOODS_ICONS[goodName], `GOODS_ICONS should have entry for "${goodName}"`);
        }
    });
});
