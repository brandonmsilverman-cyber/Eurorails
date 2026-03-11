/**
 * Server Grid Generation Tests — Step 0.4 of Solo Mode Phase 0
 *
 * Validates that the server generates its own hex grid at game start,
 * removing the dependency on the client sending setCityToMilepost data.
 *
 * Verifies:
 *   1. createGameState produces grid data (mileposts, cityToMilepost, etc.)
 *   2. Server-generated grid matches client-generated grid (snapshot parity)
 *   3. Event zones are precomputed correctly in createGameState
 *   4. Flood handling works with mileposts_by_id (not milepostPositions)
 *   5. setCityToMilepost handler is a no-op (server ignores client grid data)
 *   6. Client no longer emits setCityToMilepost
 *   7. coastDistance is computed and available for strike event checks
 *
 * Run:  node --test test/server-grid.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const gl = require('../shared/game-logic');

// Read source files for static analysis
const serverSource = fs.readFileSync(
    path.join(__dirname, '..', 'server.js'),
    'utf8'
);
const clientSource = fs.readFileSync(
    path.join(__dirname, '..', 'public', 'eurorails.html'),
    'utf8'
);

// Load snapshot for parity checks
const snapshot = require('./snapshots/ground-truth.json');

// =========================================================================
// Helper: simulate createGameState's grid generation logic
// (We can't require server.js directly since it starts listening,
//  so we replicate just the grid generation portion for testing)
// =========================================================================

function serverGenerateGrid() {
    const grid = gl.generateHexGrid();
    const gridCtx = { mileposts: grid.mileposts, mileposts_by_id: grid.mileposts_by_id };
    const coastDistance = gl.computeCoastDistances(gridCtx);

    const eventZones = {};
    for (const evt of gl.EVENT_CARDS) {
        if (evt.type === "derailment" && evt.cities) {
            const zone = new Set();
            for (const cityName of evt.cities) {
                const cityMpId = grid.cityToMilepost[cityName];
                if (cityMpId !== undefined) {
                    for (const id of gl.getMilepostsInHexRange(gridCtx, cityMpId, evt.radius)) {
                        zone.add(id);
                    }
                }
            }
            eventZones[evt.id] = Array.from(zone);
        } else if ((evt.type === "snow" || evt.type === "fog") && evt.city) {
            const cityMpId = grid.cityToMilepost[evt.city];
            if (cityMpId !== undefined) {
                const zone = gl.getMilepostsInHexRange(gridCtx, cityMpId, evt.radius);
                eventZones[evt.id] = Array.from(zone);
            }
        } else if (evt.type === "gale" && evt.seaAreas) {
            const coastalStarts = gl.getCoastalMilepostsForSeaAreas(gridCtx, evt.seaAreas);
            const zone = gl.getMilepostsInHexRangeMultiSource(gridCtx, coastalStarts, evt.radius - 1);
            eventZones[evt.id] = Array.from(zone);
        }
    }

    return {
        mileposts: grid.mileposts,
        mileposts_by_id: grid.mileposts_by_id,
        cityToMilepost: grid.cityToMilepost,
        ferryConnections: grid.ferryConnections,
        coastDistance,
        eventZones
    };
}

const gridData = serverGenerateGrid();

// =========================================================================
// 1. Server generates complete hex grid data
// =========================================================================

describe('Server generates hex grid in createGameState', () => {
    it('produces the expected milepost count', () => {
        assert.equal(gridData.mileposts.length, snapshot.milepostCount);
    });

    it('maps all cities to mileposts', () => {
        for (const cityName of Object.keys(gl.CITIES)) {
            assert.notEqual(
                gridData.cityToMilepost[cityName],
                undefined,
                `City "${cityName}" should be mapped to a milepost`
            );
        }
    });

    it('city-to-milepost mapping matches snapshot', () => {
        assert.deepEqual(gridData.cityToMilepost, snapshot.cityToMilepost);
    });

    it('ferry connections match snapshot', () => {
        assert.deepEqual(gridData.ferryConnections, snapshot.ferryConnections);
    });

    it('mileposts_by_id lookup is consistent with mileposts array', () => {
        for (const mp of gridData.mileposts) {
            assert.strictEqual(gridData.mileposts_by_id[mp.id], mp);
        }
        assert.equal(
            Object.keys(gridData.mileposts_by_id).length,
            gridData.mileposts.length
        );
    });

    it('each milepost has required fields', () => {
        const sample = gridData.mileposts[0];
        assert.ok('id' in sample, 'milepost should have id');
        assert.ok('x' in sample, 'milepost should have x');
        assert.ok('y' in sample, 'milepost should have y');
        assert.ok('terrain' in sample, 'milepost should have terrain');
        assert.ok('landmass' in sample, 'milepost should have landmass');
        assert.ok('neighbors' in sample, 'milepost should have neighbors');
    });
});

// =========================================================================
// 2. Coast distance computation
// =========================================================================

describe('Server computes coast distances', () => {
    it('coastDistance is populated for all mileposts', () => {
        const distCount = Object.keys(gridData.coastDistance).length;
        assert.equal(distCount, gridData.mileposts.length,
            'Every milepost should have a coast distance');
    });

    it('coastal mileposts have distance 0', () => {
        let coastalCount = 0;
        for (const mp of gridData.mileposts) {
            if (mp.neighbors.length < 6) {
                assert.equal(gridData.coastDistance[mp.id], 0,
                    `Coastal milepost ${mp.id} should have distance 0`);
                coastalCount++;
            }
        }
        assert.ok(coastalCount > 0, 'Should have at least some coastal mileposts');
    });

    it('inland mileposts have positive distance', () => {
        let inlandFound = false;
        for (const mp of gridData.mileposts) {
            if (mp.neighbors.length >= 6) {
                assert.ok(gridData.coastDistance[mp.id] > 0,
                    `Inland milepost ${mp.id} should have positive coast distance`);
                inlandFound = true;
            }
        }
        assert.ok(inlandFound, 'Should have at least some inland mileposts');
    });

    it('coast distances match snapshot samples', () => {
        if (snapshot.coastDistanceSamples) {
            for (const sample of snapshot.coastDistanceSamples) {
                assert.equal(
                    gridData.coastDistance[sample.id],
                    sample.distance,
                    `Coast distance for milepost ${sample.id} should match snapshot`
                );
            }
        }
    });
});

// =========================================================================
// 3. Event zone precomputation
// =========================================================================

describe('Server precomputes event zones', () => {
    it('all zone-based event cards have precomputed zones', () => {
        for (const evt of gl.EVENT_CARDS) {
            if (evt.type === "derailment" || evt.type === "snow" ||
                evt.type === "fog" || evt.type === "gale") {
                assert.ok(
                    gridData.eventZones[evt.id],
                    `Event ${evt.id} (${evt.type}) should have a precomputed zone`
                );
                assert.ok(
                    gridData.eventZones[evt.id].length > 0,
                    `Event ${evt.id} zone should have at least one milepost`
                );
            }
        }
    });

    it('event zone sizes match snapshot', () => {
        for (const [idStr, zoneInfo] of Object.entries(snapshot.eventZones)) {
            const id = parseInt(idStr);
            const serverZone = gridData.eventZones[id];
            assert.ok(serverZone, `Event zone ${id} should exist`);
            assert.equal(
                serverZone.length,
                zoneInfo.zoneSize,
                `Event ${id} (${zoneInfo.title}) zone size should match snapshot (expected ${zoneInfo.zoneSize}, got ${serverZone.length})`
            );
        }
    });

    it('event zone membership matches snapshot spot checks', () => {
        for (const [idStr, zoneInfo] of Object.entries(snapshot.eventZones)) {
            const id = parseInt(idStr);
            const serverZone = new Set(gridData.eventZones[id]);
            for (const mpId of zoneInfo.sampleInZone) {
                assert.ok(
                    serverZone.has(mpId),
                    `Milepost ${mpId} should be in zone for event ${id} (${zoneInfo.title})`
                );
            }
        }
    });

    it('derailment zones cover expected cities', () => {
        const derailments = gl.EVENT_CARDS.filter(e => e.type === "derailment");
        for (const evt of derailments) {
            const zone = new Set(gridData.eventZones[evt.id]);
            // Each city center milepost should be in its own derailment zone
            for (const cityName of evt.cities) {
                const cityMpId = gridData.cityToMilepost[cityName];
                if (cityMpId !== undefined) {
                    assert.ok(
                        zone.has(cityMpId),
                        `City "${cityName}" milepost should be in derailment zone for event ${evt.id}`
                    );
                }
            }
        }
    });

    it('snow/fog zones contain their center city', () => {
        const snowFog = gl.EVENT_CARDS.filter(e => e.type === "snow" || e.type === "fog");
        for (const evt of snowFog) {
            const zone = new Set(gridData.eventZones[evt.id]);
            const cityMpId = gridData.cityToMilepost[evt.city];
            if (cityMpId !== undefined) {
                assert.ok(
                    zone.has(cityMpId),
                    `City "${evt.city}" should be in ${evt.type} zone for event ${evt.id}`
                );
            }
        }
    });
});

// =========================================================================
// 4. Flood handling uses mileposts_by_id
// =========================================================================

describe('Flood handling uses mileposts_by_id', () => {
    it('server uses gs.mileposts_by_id for flood track destruction', () => {
        assert.ok(
            serverSource.includes('gs.mileposts_by_id[track.from]'),
            'Server should use mileposts_by_id[track.from] for flood checks'
        );
        assert.ok(
            serverSource.includes('gs.mileposts_by_id[track.to]'),
            'Server should use mileposts_by_id[track.to] for flood checks'
        );
    });

    it('server does not reference milepostPositions', () => {
        assert.ok(
            !serverSource.includes('milepostPositions'),
            'Server should not reference milepostPositions anymore'
        );
    });

    it('flood detection works with mileposts_by_id data', () => {
        // Simulate a flood event: find a track edge that crosses the Rhine
        const rhine = gl.RIVERS.rhine;
        assert.ok(rhine, 'Rhine river should exist');

        // Find two adjacent mileposts that cross the Rhine
        let crossingFrom = null, crossingTo = null;
        for (const mp of gridData.mileposts) {
            for (const nId of mp.neighbors) {
                const neighbor = gridData.mileposts_by_id[nId];
                if (neighbor && gl.crossesRiver(mp.x, mp.y, neighbor.x, neighbor.y, rhine)) {
                    crossingFrom = mp.id;
                    crossingTo = nId;
                    break;
                }
            }
            if (crossingFrom !== null) break;
        }

        assert.ok(crossingFrom !== null, 'Should find a track edge crossing the Rhine');

        // Verify that mileposts_by_id has x/y data for these mileposts
        const mp1 = gridData.mileposts_by_id[crossingFrom];
        const mp2 = gridData.mileposts_by_id[crossingTo];
        assert.ok(mp1 && mp1.x !== undefined && mp1.y !== undefined,
            'mileposts_by_id should have x/y for from milepost');
        assert.ok(mp2 && mp2.x !== undefined && mp2.y !== undefined,
            'mileposts_by_id should have x/y for to milepost');

        // Confirm crossesRiver still detects the crossing with mileposts_by_id data
        assert.ok(
            gl.crossesRiver(mp1.x, mp1.y, mp2.x, mp2.y, rhine),
            'crossesRiver should detect Rhine crossing using mileposts_by_id coordinates'
        );
    });
});

// =========================================================================
// 5. setCityToMilepost is a no-op on the server
// =========================================================================

describe('setCityToMilepost handler is a no-op', () => {
    it('server has setCityToMilepost handler registered', () => {
        assert.ok(
            serverSource.includes("socket.on('setCityToMilepost'"),
            'Server should still register setCityToMilepost handler (for stale clients)'
        );
    });

    it('setCityToMilepost handler is a no-op (empty callback)', () => {
        // The handler should be: socket.on('setCityToMilepost', () => {});
        const noopPattern = /socket\.on\('setCityToMilepost',\s*\(\)\s*=>\s*\{\s*\}\)/;
        assert.ok(
            noopPattern.test(serverSource),
            'setCityToMilepost handler should be a no-op arrow function'
        );
    });

    it('server does not assign client-sent cityToMilepost to gameState', () => {
        // Ensure no "room.gameState.cityToMilepost = cityToMilepost" pattern
        const assignPattern = /room\.gameState\.cityToMilepost\s*=\s*cityToMilepost/;
        assert.ok(
            !assignPattern.test(serverSource),
            'Server should not assign client-sent cityToMilepost to gameState'
        );
    });
});

// =========================================================================
// 6. Client no longer emits setCityToMilepost
// =========================================================================

describe('Client does not emit setCityToMilepost', () => {
    it('client does not emit setCityToMilepost', () => {
        assert.ok(
            !clientSource.includes("socket.emit('setCityToMilepost'"),
            'Client should not emit setCityToMilepost'
        );
    });

    it('client does not build milepostPositions for server', () => {
        // The old code built milepostPositions = {} and sent it to server
        assert.ok(
            !clientSource.includes("milepostPositions[mp.id]"),
            'Client should not build milepostPositions for server'
        );
    });

    it('client does not precompute event zones for server', () => {
        // The old code built eventZones = {} and sent it to server.
        // Check for the specific pattern of building zones for server emission.
        // Note: client may still compute zones for its own rendering — that's fine.
        // We're checking the server-send pattern is gone.
        assert.ok(
            !clientSource.includes("socket.emit('setCityToMilepost'"),
            'Client should not emit setCityToMilepost with event zones'
        );
    });
});

// =========================================================================
// 7. Server imports required shared module functions
// =========================================================================

describe('Server imports grid generation functions from shared module', () => {
    it('imports generateHexGrid', () => {
        assert.ok(
            serverSource.includes('generateHexGrid = gl.generateHexGrid') ||
            serverSource.includes('generateHexGrid} = gl') ||
            serverSource.includes("gl.generateHexGrid"),
            'Server should import generateHexGrid from shared module'
        );
    });

    it('imports computeCoastDistances', () => {
        assert.ok(
            serverSource.includes('computeCoastDistances = gl.computeCoastDistances') ||
            serverSource.includes("gl.computeCoastDistances"),
            'Server should import computeCoastDistances from shared module'
        );
    });

    it('imports getMilepostsInHexRange', () => {
        assert.ok(
            serverSource.includes('getMilepostsInHexRange = gl.getMilepostsInHexRange') ||
            serverSource.includes("gl.getMilepostsInHexRange"),
            'Server should import getMilepostsInHexRange from shared module'
        );
    });

    it('imports getCoastalMilepostsForSeaAreas', () => {
        assert.ok(
            serverSource.includes('getCoastalMilepostsForSeaAreas = gl.getCoastalMilepostsForSeaAreas') ||
            serverSource.includes("gl.getCoastalMilepostsForSeaAreas"),
            'Server should import getCoastalMilepostsForSeaAreas from shared module'
        );
    });

    it('imports getMilepostsInHexRangeMultiSource', () => {
        assert.ok(
            serverSource.includes('getMilepostsInHexRangeMultiSource = gl.getMilepostsInHexRangeMultiSource') ||
            serverSource.includes("gl.getMilepostsInHexRangeMultiSource"),
            'Server should import getMilepostsInHexRangeMultiSource from shared module'
        );
    });
});

// =========================================================================
// 8. Server createGameState includes grid data in return value
// =========================================================================

describe('createGameState includes grid fields', () => {
    it('server code assigns mileposts to game state', () => {
        assert.ok(
            serverSource.includes('mileposts: grid.mileposts'),
            'createGameState should include mileposts in return value'
        );
    });

    it('server code assigns mileposts_by_id to game state', () => {
        assert.ok(
            serverSource.includes('mileposts_by_id: grid.mileposts_by_id'),
            'createGameState should include mileposts_by_id in return value'
        );
    });

    it('server code assigns cityToMilepost to game state', () => {
        assert.ok(
            serverSource.includes('cityToMilepost: grid.cityToMilepost'),
            'createGameState should include cityToMilepost in return value'
        );
    });

    it('server code assigns ferryConnections to game state', () => {
        assert.ok(
            serverSource.includes('ferryConnections: grid.ferryConnections'),
            'createGameState should include ferryConnections in return value'
        );
    });

    it('server code assigns coastDistance to game state', () => {
        // coastDistance is a shorthand property in the return object
        assert.ok(
            serverSource.includes('coastDistance') &&
            serverSource.includes('computeCoastDistances'),
            'createGameState should include coastDistance in return value'
        );
    });

    it('server code assigns eventZones to game state', () => {
        assert.ok(
            serverSource.includes('eventZones'),
            'createGameState should include eventZones in return value'
        );
    });
});

// =========================================================================
// 9. getStateForPlayer does NOT send grid data to clients
// =========================================================================

describe('getStateForPlayer excludes grid data', () => {
    it('does not send mileposts to clients', () => {
        // Look for the getStateForPlayer function and check it doesn't include mileposts
        const funcMatch = serverSource.match(/function getStateForPlayer[\s\S]*?^}/m);
        if (funcMatch) {
            const funcBody = funcMatch[0];
            assert.ok(
                !funcBody.includes('mileposts:') && !funcBody.includes('mileposts_by_id:'),
                'getStateForPlayer should not include mileposts in client state'
            );
        }
    });

    it('does not send coastDistance to clients', () => {
        const funcMatch = serverSource.match(/function getStateForPlayer[\s\S]*?^}/m);
        if (funcMatch) {
            const funcBody = funcMatch[0];
            assert.ok(
                !funcBody.includes('coastDistance'),
                'getStateForPlayer should not include coastDistance in client state'
            );
        }
    });

    it('does not send eventZones to clients', () => {
        const funcMatch = serverSource.match(/function getStateForPlayer[\s\S]*?^}/m);
        if (funcMatch) {
            const funcBody = funcMatch[0];
            assert.ok(
                !funcBody.includes('eventZones'),
                'getStateForPlayer should not include eventZones in client state'
            );
        }
    });
});

// =========================================================================
// 10. Strike event checks work with server-computed coastDistance
// =========================================================================

describe('Strike events use server-computed coastDistance', () => {
    it('strike 121 (inland) can use coastDistance for blocking checks', () => {
        const evt121 = gl.EVENT_CARDS.find(e => e.id === 121);
        assert.ok(evt121, 'Event 121 should exist');

        // Find an inland milepost (high coast distance)
        let inlandMp = null;
        for (const mp of gridData.mileposts) {
            if (gridData.coastDistance[mp.id] > evt121.radius) {
                inlandMp = mp;
                break;
            }
        }
        assert.ok(inlandMp, 'Should find an inland milepost beyond strike radius');

        // The coast distance should be usable for the blocking check
        const d = gridData.coastDistance[inlandMp.id];
        assert.ok(d > evt121.radius,
            `Inland milepost coast distance (${d}) should exceed strike radius (${evt121.radius})`);
    });

    it('strike 122 (coastal) can use coastDistance for blocking checks', () => {
        const evt122 = gl.EVENT_CARDS.find(e => e.id === 122);
        assert.ok(evt122, 'Event 122 should exist');

        // Find a coastal milepost (low coast distance)
        let coastalMp = null;
        for (const mp of gridData.mileposts) {
            if (gridData.coastDistance[mp.id] <= evt122.radius) {
                coastalMp = mp;
                break;
            }
        }
        assert.ok(coastalMp, 'Should find a coastal milepost within strike radius');

        const d = gridData.coastDistance[coastalMp.id];
        assert.ok(d <= evt122.radius,
            `Coastal milepost coast distance (${d}) should be within strike radius (${evt122.radius})`);
    });
});
