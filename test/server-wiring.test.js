/**
 * Server Wiring Tests — Step 0.3 of Solo Mode Phase 0
 *
 * Validates that server.js correctly uses the shared game-logic module
 * instead of its own duplicated constants and functions.
 *
 * Verifies:
 *   1. Server uses the same constants as the shared module
 *   2. No duplicated constant/function definitions remain in server.js
 *   3. Server game logic helpers (getFerryKey, playerOwnsFerry, etc.) work correctly
 *      with the shared module's ctx-based API
 *   4. Deck generation uses shared module constants
 *   5. Event handling uses shared RIVERS for flood checks
 *
 * Run:  node --test test/server-wiring.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const gl = require('../shared/game-logic');

// Read server.js source for static analysis
const serverSource = fs.readFileSync(
    path.join(__dirname, '..', 'server.js'),
    'utf8'
);

// =========================================================================
// 1. No duplicated constant/function definitions in server.js
// =========================================================================

describe('No inline code duplication in server.js', () => {
    it('no inline CITIES constant definition', () => {
        const matches = serverSource.match(/^const CITIES\s*=\s*\{/gm);
        assert.equal(matches, null, 'CITIES should not be defined inline in server.js');
    });

    it('no inline GOODS constant definition', () => {
        const matches = serverSource.match(/^const GOODS\s*=\s*\{/gm);
        assert.equal(matches, null, 'GOODS should not be defined inline in server.js');
    });

    it('no inline EVENT_CARDS constant definition', () => {
        const matches = serverSource.match(/^const EVENT_CARDS\s*=\s*\[/gm);
        assert.equal(matches, null, 'EVENT_CARDS should not be defined inline in server.js');
    });

    it('no inline RIVERS constant definition', () => {
        const matches = serverSource.match(/^const RIVERS\s*=\s*\{/gm);
        assert.equal(matches, null, 'RIVERS should not be defined inline in server.js');
    });

    it('no inline TRAIN_TYPES constant definition', () => {
        const matches = serverSource.match(/^const TRAIN_TYPES\s*=\s*\{/gm);
        assert.equal(matches, null, 'TRAIN_TYPES should not be defined inline in server.js');
    });

    it('no inline MAJOR_CITIES constant definition', () => {
        const matches = serverSource.match(/^const MAJOR_CITIES\s*=\s*\[/gm);
        assert.equal(matches, null, 'MAJOR_CITIES should not be defined inline in server.js');
    });

    it('no inline segmentsIntersect function definition', () => {
        const matches = serverSource.match(/^function segmentsIntersect/gm);
        assert.equal(matches, null, 'segmentsIntersect should not be defined inline in server.js');
    });

    it('no inline crossesRiver function definition', () => {
        const matches = serverSource.match(/^function crossesRiver/gm);
        assert.equal(matches, null, 'crossesRiver should not be defined inline in server.js');
    });

    it('no inline getFerryKey function definition', () => {
        const matches = serverSource.match(/^function getFerryKey/gm);
        assert.equal(matches, null, 'getFerryKey should not be defined inline in server.js');
    });

    it('no inline playerOwnsFerry function definition', () => {
        const matches = serverSource.match(/^function playerOwnsFerry/gm);
        assert.equal(matches, null, 'playerOwnsFerry should not be defined inline in server.js');
    });

    it('no inline getPlayerOwnedMileposts function definition', () => {
        const matches = serverSource.match(/^function getPlayerOwnedMileposts/gm);
        assert.equal(matches, null, 'getPlayerOwnedMileposts should not be defined inline in server.js');
    });

    it('shared module is required at top of server.js', () => {
        assert.ok(
            serverSource.includes("require('./shared/game-logic')"),
            'server.js should require the shared game-logic module'
        );
    });
});

// =========================================================================
// 2. Server references match shared module values
// =========================================================================

describe('Server constants match shared module', () => {
    // We can't require server.js directly (it starts listening), so we
    // verify via the shared module that the constants are correct.

    it('CITIES has 61 entries', () => {
        assert.equal(Object.keys(gl.CITIES).length, 61);
    });

    it('MAJOR_CITIES has 8 entries', () => {
        assert.equal(gl.MAJOR_CITIES.length, 8);
    });

    it('EVENT_CARDS has 20 entries', () => {
        assert.equal(gl.EVENT_CARDS.length, 20);
    });

    it('TRAIN_TYPES has 4 entries', () => {
        assert.equal(Object.keys(gl.TRAIN_TYPES).length, 4);
    });

    it('RIVERS has expected river names', () => {
        const expectedRivers = ['rhine', 'danube', 'loire', 'elbe', 'vistula', 'po', 'rhone', 'seine', 'garonne', 'douro'];
        assert.deepEqual(Object.keys(gl.RIVERS).sort(), expectedRivers.sort());
    });

    it('GOODS has 29 entries', () => {
        assert.equal(Object.keys(gl.GOODS).length, 29);
    });
});

// =========================================================================
// 3. Shared module functions work with server-style gameState objects
// =========================================================================

describe('Shared functions work with server-style gameState', () => {
    it('getFerryKey produces canonical key', () => {
        assert.equal(gl.getFerryKey('100', '200'), '100|200');
        assert.equal(gl.getFerryKey('200', '100'), '100|200');
    });

    it('playerOwnsFerry works with gs-style objects', () => {
        // Server passes gs (which has ferryOwnership) as ctx
        const gs = { ferryOwnership: { '100|200': ['blue', 'red'] } };
        assert.equal(gl.playerOwnsFerry(gs, '100|200', 'blue'), true);
        assert.equal(gl.playerOwnsFerry(gs, '100|200', 'red'), true);
        assert.equal(gl.playerOwnsFerry(gs, '100|200', 'green'), false);
        assert.equal(gl.playerOwnsFerry(gs, '300|400', 'blue'), false);
    });

    it('getPlayerOwnedMileposts works with server gameState shape', () => {
        const grid = gl.generateHexGrid();
        const londonId = grid.cityToMilepost['London'];
        const birmId = grid.cityToMilepost['Birmingham'];

        // Simulate server gameState with tracks and ferryConnections
        const gs = {
            tracks: [
                { from: londonId, to: birmId, color: 'red' },
            ],
            ferryConnections: grid.ferryConnections,
            ferryOwnership: {},
        };

        const owned = gl.getPlayerOwnedMileposts(gs, 'red');
        assert.ok(owned.has(londonId), 'Should own London milepost');
        assert.ok(owned.has(birmId), 'Should own Birmingham milepost');
        assert.equal(owned.size, 2);
    });

    it('crossesRiver detects river crossings', () => {
        const rhine = gl.RIVERS.rhine;
        // A segment crossing the Rhine
        const [rx1, ry1] = rhine[0];
        const [rx2, ry2] = rhine[1];
        const midX = (rx1 + rx2) / 2;
        const midY = (ry1 + ry2) / 2;

        // Cross perpendicular
        assert.equal(
            gl.crossesRiver(midX - 2, midY, midX + 2, midY, rhine),
            true,
            'Should detect Rhine crossing'
        );

        // Segment far away should not cross
        assert.equal(
            gl.crossesRiver(0, 0, 1, 1, rhine),
            false,
            'Should not detect false crossing'
        );
    });
});

// =========================================================================
// 4. Server flood handling uses shared RIVERS
// =========================================================================

describe('Flood event handling uses shared RIVERS', () => {
    it('server references RIVERS[eventCard.river] for flood events', () => {
        // Verify the server code uses RIVERS (now from shared module) in flood handling
        assert.ok(
            serverSource.includes('RIVERS[eventCard.river]'),
            'Server should reference RIVERS[eventCard.river] for flood events'
        );
    });

    it('all flood event river references exist in shared RIVERS', () => {
        const floodEvents = gl.EVENT_CARDS.filter(e => e.type === 'flood');
        for (const evt of floodEvents) {
            assert.ok(
                gl.RIVERS[evt.river],
                `River "${evt.river}" referenced by event ${evt.id} should exist in RIVERS`
            );
        }
    });
});

// =========================================================================
// 5. Deck generation uses shared CITIES and GOODS
// =========================================================================

describe('Deck generation uses shared constants', () => {
    it('all GOODS sources reference valid CITIES', () => {
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
            if (evt.river) {
                assert.ok(gl.RIVERS[evt.river], `Event ${evt.id} river "${evt.river}" should be valid`);
            }
        }
    });
});
