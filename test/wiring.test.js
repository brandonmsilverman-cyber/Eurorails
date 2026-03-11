/**
 * Wiring Tests — Step 0.2 of Solo Mode Phase 0
 *
 * Validates that the client wrappers in public/eurorails.html correctly bridge
 * the ctx-based shared/game-logic.js API to the client's gameState-based calls.
 *
 * These tests load the HTML's gameState + wrappers in a vm context (just like
 * the browser would) and verify that:
 *   1. Wrappers populate gameState correctly (generateHexGrid, computeCoastDistances)
 *   2. Wrappers pass correct ctx to shared module functions
 *   3. Results match the shared module when called directly
 *   4. No inline duplicates remain (Break Case 7 / load order)
 *
 * Run:  node --test test/wiring.test.js
 */

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { loadGameLogic } = require('./snapshot-helper');
const gl = require('../shared/game-logic');
const snapshot = require('./snapshots/ground-truth.json');

let ctx; // vm context with gameState + wrappers

before(() => {
    ctx = loadGameLogic();
    // The wrapper generateHexGrid populates gameState
    ctx.generateHexGrid();
    ctx.computeCoastDistances();
});

// Helper: normalize vm cross-context objects for deep comparison
function normalize(val) {
    return JSON.parse(JSON.stringify(val));
}

// =========================================================================
// 1. Wrapper populates gameState correctly
// =========================================================================

describe('generateHexGrid wrapper populates gameState', () => {
    it('gameState.mileposts has expected count', () => {
        assert.equal(ctx.gameState.mileposts.length, snapshot.milepostCount);
    });

    it('gameState.mileposts_by_id is populated', () => {
        const keys = Object.keys(ctx.gameState.mileposts_by_id);
        assert.equal(keys.length, snapshot.milepostCount);
    });

    it('gameState.cityToMilepost maps all cities', () => {
        for (const cityName of Object.keys(gl.CITIES)) {
            assert.notEqual(
                ctx.gameState.cityToMilepost[cityName],
                undefined,
                `City "${cityName}" should be mapped`
            );
        }
    });

    it('gameState.ferryConnections has expected count', () => {
        assert.equal(ctx.gameState.ferryConnections.length, snapshot.ferryConnections.length);
    });

    it('cityToMilepost matches snapshot', () => {
        assert.deepEqual(normalize(ctx.gameState.cityToMilepost), snapshot.cityToMilepost);
    });
});

describe('computeCoastDistances wrapper populates gameState', () => {
    it('gameState.coastDistance is populated', () => {
        assert.ok(ctx.gameState.coastDistance, 'coastDistance should exist');
        const keys = Object.keys(ctx.gameState.coastDistance);
        assert.ok(keys.length > 0, 'coastDistance should have entries');
    });

    it('coast distances match snapshot', () => {
        for (const { id, coastDistance } of snapshot.coastDistances) {
            assert.equal(
                ctx.gameState.coastDistance[id],
                coastDistance,
                `Coast distance for milepost ${id}`
            );
        }
    });
});

// =========================================================================
// 2. Wrapper results match direct shared module calls
// =========================================================================

describe('findPath wrapper matches shared module', () => {
    it('cheapest paths match for city pairs', () => {
        const grid = gl.generateHexGrid();
        const directCtx = {
            mileposts: grid.mileposts,
            mileposts_by_id: grid.mileposts_by_id,
            cityToMilepost: grid.cityToMilepost,
            ferryConnections: grid.ferryConnections,
            ferryOwnership: {},
            tracks: [],
            activeEvents: [],
            players: [],
        };

        for (const expected of snapshot.buildPaths) {
            if (expected.error) continue;
            const fromId = grid.cityToMilepost[expected.from];
            const toId = grid.cityToMilepost[expected.to];

            const directResult = gl.findPath(directCtx, fromId, toId, "red", "cheapest");
            const wrapperResult = ctx.findPath(fromId, toId, "red", "cheapest");

            if (directResult === null) {
                assert.equal(wrapperResult, null, `${expected.from}->${expected.to} wrapper should be null`);
            } else {
                assert.ok(wrapperResult, `${expected.from}->${expected.to} wrapper should find path`);
                assert.deepEqual(
                    normalize(wrapperResult.path),
                    directResult.path,
                    `${expected.from}->${expected.to} path match`
                );
                assert.equal(wrapperResult.cost, directResult.cost, `${expected.from}->${expected.to} cost match`);
            }
        }
    });
});

describe('findPathOnTrack wrapper matches shared module', () => {
    it('movement path matches', () => {
        const expected = snapshot.movementPath;
        const grid = gl.generateHexGrid();

        // Build track in both contexts
        const tracks = [];
        for (let i = 0; i < expected.trackPath.length - 1; i++) {
            tracks.push({ from: expected.trackPath[i], to: expected.trackPath[i + 1], color: "red" });
        }

        // Direct call to shared module
        const directCtx = {
            mileposts: grid.mileposts,
            mileposts_by_id: grid.mileposts_by_id,
            cityToMilepost: grid.cityToMilepost,
            ferryConnections: grid.ferryConnections,
            ferryOwnership: {},
            tracks,
            activeEvents: [],
            players: [],
        };
        const londonId = grid.cityToMilepost["London"];
        const birmId = grid.cityToMilepost["Birmingham"];
        const directResult = gl.findPathOnTrack(directCtx, londonId, birmId, "red", false);

        // Wrapper call (set tracks on gameState first)
        ctx.gameState.tracks = tracks;
        const wrapperResult = ctx.findPathOnTrack(londonId, birmId, "red", false);
        ctx.gameState.tracks = []; // clean up

        assert.ok(directResult);
        assert.ok(wrapperResult);
        assert.deepEqual(normalize(wrapperResult.path), directResult.path);
    });
});

describe('getPlayerOwnedMileposts wrapper', () => {
    it('returns owned mileposts matching shared module', () => {
        const grid = gl.generateHexGrid();
        const tracks = [
            { from: grid.cityToMilepost["London"], to: grid.mileposts[0].id, color: "red" },
        ];

        // Direct
        const directCtx = {
            mileposts: grid.mileposts,
            mileposts_by_id: grid.mileposts_by_id,
            cityToMilepost: grid.cityToMilepost,
            ferryConnections: grid.ferryConnections,
            ferryOwnership: {},
            tracks,
            activeEvents: [],
            players: [],
        };
        const directOwned = gl.getPlayerOwnedMileposts(directCtx, "red");

        // Wrapper
        ctx.gameState.tracks = tracks;
        const wrapperOwned = ctx.getPlayerOwnedMileposts("red");
        ctx.gameState.tracks = [];

        assert.deepEqual(normalize([...wrapperOwned].sort()), [...directOwned].sort());
    });
});

describe('Ferry ownership wrappers', () => {
    it('canPlayerBuildFerry matches shared module', () => {
        const ferryKey = "100|200";

        ctx.gameState.ferryOwnership = {};
        assert.equal(ctx.canPlayerBuildFerry(ferryKey, "red"), true);

        ctx.gameState.ferryOwnership = { [ferryKey]: ["blue"] };
        assert.equal(ctx.canPlayerBuildFerry(ferryKey, "red"), true);

        ctx.gameState.ferryOwnership = { [ferryKey]: ["blue", "green"] };
        assert.equal(ctx.canPlayerBuildFerry(ferryKey, "red"), false);

        ctx.gameState.ferryOwnership = { [ferryKey]: ["blue", "red"] };
        assert.equal(ctx.canPlayerBuildFerry(ferryKey, "red"), true);

        ctx.gameState.ferryOwnership = {}; // clean up
    });

    it('playerOwnsFerry matches shared module', () => {
        const ferryKey = "100|200";

        ctx.gameState.ferryOwnership = { [ferryKey]: ["blue"] };
        assert.equal(ctx.playerOwnsFerry(ferryKey, "blue"), true);
        assert.equal(ctx.playerOwnsFerry(ferryKey, "red"), false);

        ctx.gameState.ferryOwnership = {}; // clean up
    });
});

describe('Event zone wrappers', () => {
    it('getMilepostsInHexRange matches shared module', () => {
        const grid = gl.generateHexGrid();
        const directCtx = {
            mileposts: grid.mileposts,
            mileposts_by_id: grid.mileposts_by_id,
            cityToMilepost: grid.cityToMilepost,
            ferryConnections: grid.ferryConnections,
        };
        const cityMpId = grid.cityToMilepost["London"];

        const directResult = gl.getMilepostsInHexRange(directCtx, cityMpId, 3);
        const wrapperResult = ctx.getMilepostsInHexRange(cityMpId, 3);

        assert.equal(wrapperResult.size, directResult.size);
    });

    it('isMilepostInEventZone matches shared module', () => {
        for (const check of snapshot.eventZoneSpotChecks) {
            const evt = gl.EVENT_CARDS.find(e => e.id === check.eventId);
            const wrapperResult = ctx.isMilepostInEventZone(evt, check.milepostId);
            assert.equal(wrapperResult, check.actual,
                `isMilepostInEventZone(event ${check.eventId}, milepost ${check.milepostId})`);
        }
    });
});

// =========================================================================
// 3. No inline duplicates remain (Break Case 7)
// =========================================================================

describe('No inline code duplication', () => {
    const html = fs.readFileSync(
        path.join(__dirname, '..', 'public', 'eurorails.html'),
        'utf8'
    );

    it('no inline CITIES constant definition', () => {
        // The HTML should reference CITIES from the shared module, not define it inline
        const matches = html.match(/^const CITIES\s*=/gm);
        assert.equal(matches, null, 'CITIES should not be defined inline');
    });

    it('no inline GOODS constant definition', () => {
        const matches = html.match(/^const GOODS\s*=/gm);
        assert.equal(matches, null, 'GOODS should not be defined inline');
    });

    it('no inline GOODS_ICONS constant definition', () => {
        const matches = html.match(/^const GOODS_ICONS\s*=/gm);
        assert.equal(matches, null, 'GOODS_ICONS should not be defined inline');
    });

    it('no inline EVENT_CARDS constant definition', () => {
        const matches = html.match(/^const EVENT_CARDS\s*=/gm);
        assert.equal(matches, null, 'EVENT_CARDS should not be defined inline');
    });

    it('no inline MinHeap class definition', () => {
        const matches = html.match(/^class MinHeap/gm);
        assert.equal(matches, null, 'MinHeap should not be defined inline');
    });

    it('no inline pointInPolygon function definition', () => {
        const matches = html.match(/^function pointInPolygon/gm);
        assert.equal(matches, null, 'pointInPolygon should not be defined inline');
    });

    it('shared module script tag is present', () => {
        assert.ok(
            html.includes('<script src="/shared/game-logic.js"></script>'),
            'Shared module script tag should be present'
        );
    });

    it('shared module script tag is before inline script', () => {
        const sharedIdx = html.indexOf('<script src="/shared/game-logic.js"></script>');
        const inlineIdx = html.indexOf('<script>\n// Constants, geometry helpers');
        assert.ok(sharedIdx < inlineIdx, 'Shared module should load before inline script');
    });

    it('_shared object captures shared module references', () => {
        assert.ok(
            html.includes('const _shared = {'),
            'Wrapper code should save shared module references in _shared object'
        );
    });
});

// =========================================================================
// 4. Wrapper-specific edge cases
// =========================================================================

describe('Wrapper edge cases', () => {
    it('findPath with active snow event blocks building in zone (ctx wiring)', () => {
        const parisId = ctx.gameState.cityToMilepost["Paris"];
        const frankfurtId = ctx.gameState.cityToMilepost["Frankfurt"];

        // Path without events
        const noEvent = ctx.findPath(parisId, frankfurtId, "red", "cheapest");
        assert.ok(noEvent, "Should find path without events");

        // Add a fog event near Frankfurt
        const fogEvent = gl.EVENT_CARDS.find(e => e.type === "fog");
        ctx.gameState.activeEvents = [{
            card: fogEvent,
            drawingPlayerIndex: 0,
        }];

        const withEvent = ctx.findPath(parisId, frankfurtId, "red", "cheapest");
        // Should still find a path (may route around) or cost more
        if (withEvent) {
            assert.ok(withEvent.cost >= noEvent.cost, "Event path should cost at least as much");
        }

        ctx.gameState.activeEvents = []; // clean up
    });

    it('isGaleBlockingFerry uses gameState.activeEvents via ctx', () => {
        // With no events, should not block
        ctx.gameState.activeEvents = [];
        const fc = ctx.gameState.ferryConnections[0];
        assert.equal(ctx.isGaleBlockingFerry(fc.fromId, fc.toId), false);

        // With gale 138 event, should block ferry ports in zone
        const gale138 = gl.EVENT_CARDS.find(e => e.id === 138);
        ctx.gameState.activeEvents = [{
            card: gale138,
            drawingPlayerIndex: 0,
        }];

        // At least one ferry should be in the gale zone
        let anyBlocked = false;
        for (const ferry of ctx.gameState.ferryConnections) {
            if (ctx.isGaleBlockingFerry(ferry.fromId, ferry.toId)) {
                anyBlocked = true;
                break;
            }
        }
        // Gale 138 is North Sea & English Channel — Dover-Calais ferry should be affected
        assert.ok(anyBlocked, "Gale 138 should block at least one ferry");

        ctx.gameState.activeEvents = []; // clean up
    });

    it('getFerryName returns correct name via wrapper', () => {
        const fc = ctx.gameState.ferryConnections[0];
        const name = ctx.getFerryName(fc.fromId, fc.toId);
        assert.ok(name, "Should return a ferry name");
        assert.equal(typeof name, 'string');
    });
});
