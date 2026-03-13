/**
 * Derailment Event Card Tests
 *
 * Validates:
 *   1. Load dropping logic (0, 1, 2, 3 loads)
 *   2. Random selection when multiple loads present
 *   3. Movement budget zeroed for drawing player in operate phase
 *   4. Non-drawing players and non-operate phases unaffected
 *   5. Gale ferry port uses same logic
 *   6. Players outside zone or with null trainLocation unaffected
 *
 * Run:  node --test test/derailment.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

// We can't require server.js directly (it starts listening), so we
// import the exported functions after starting the server on a random port.
let serverApplyEventEffect;
let applyDerailmentToPlayer;
let serverInstance;

// ---------------------------------------------------------------------------
// Server lifecycle — start on random port, grab exported functions
// ---------------------------------------------------------------------------

const { before, after } = require('node:test');

before(async () => {
    process.env.PORT = '0';
    process.env.DISCONNECT_GRACE_MS = '10000';
    process.env.TURN_TIMER_MS = '10000';
    delete require.cache[require.resolve('../server')];
    const srv = require('../server');
    serverInstance = srv.listener;
    serverApplyEventEffect = srv.serverApplyEventEffect;
    applyDerailmentToPlayer = srv.applyDerailmentToPlayer;

    await new Promise((resolve) => {
        if (serverInstance.listening) resolve();
        else serverInstance.on('listening', resolve);
    });
});

after(() => {
    if (serverInstance) serverInstance.close();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ZONE_MILEPOST = 'mp_in_zone';
const OUT_OF_ZONE_MILEPOST = 'mp_outside';
const FERRY_PORT_MILEPOST = 'ferry_port_mp';

function makePlayer(overrides = {}) {
    return {
        name: overrides.name || 'TestPlayer',
        trainLocation: overrides.trainLocation !== undefined ? overrides.trainLocation : ZONE_MILEPOST,
        loads: overrides.loads || [],
        movement: overrides.movement !== undefined ? overrides.movement : 9,
        cash: 50,
        color: overrides.color || 'red',
        trainType: 'Freight',
        demandCards: [],
        ...overrides
    };
}

function makeGameState(overrides = {}) {
    return {
        players: overrides.players || [makePlayer()],
        derailedPlayers: {},
        eventZones: { 125: [ZONE_MILEPOST, FERRY_PORT_MILEPOST] },
        phase: overrides.phase || 'operate',
        currentPlayerIndex: overrides.currentPlayerIndex !== undefined ? overrides.currentPlayerIndex : 0,
        gameLog: [],
        ferryConnections: overrides.ferryConnections || [
            { fromId: FERRY_PORT_MILEPOST, toId: 'other_port' }
        ],
        activeEvents: [],
        tracks: [],
        destroyedRiverTracks: [],
        ...overrides
    };
}

const DERAILMENT_CARD = { id: 125, type: 'derailment', title: 'Derailment! Milano/Roma', cities: ['Milano', 'Roma'], radius: 3, persistent: false };
const GALE_CARD_138 = { id: 138, type: 'gale', title: 'Gale! North Sea/English Channel', seaAreas: ['North Sea', 'English Channel'], radius: 2, persistent: true };

// ---------------------------------------------------------------------------
// Derailment: load dropping
// ---------------------------------------------------------------------------

describe('Derailment load dropping', () => {
    it('0 loads: no load dropped, turn skipped', () => {
        const gs = makeGameState({ players: [makePlayer({ loads: [] })] });
        const logs = [];
        serverApplyEventEffect(gs, DERAILMENT_CARD, logs, 0);

        assert.equal(gs.derailedPlayers[0], 1);
        assert.equal(gs.players[0].loads.length, 0);
        assert.ok(logs.some(l => l.includes('Loses next turn.')));
        assert.ok(!logs.some(l => l.includes('drops')));
    });

    it('1 load: drops the only load', () => {
        const gs = makeGameState({ players: [makePlayer({ loads: ['Coal'] })] });
        const logs = [];
        serverApplyEventEffect(gs, DERAILMENT_CARD, logs, 0);

        assert.equal(gs.derailedPlayers[0], 1);
        assert.equal(gs.players[0].loads.length, 0);
        assert.ok(logs.some(l => l.includes('drops Coal')));
    });

    it('2 loads: drops one, keeps one', () => {
        const gs = makeGameState({ players: [makePlayer({ loads: ['Coal', 'Wine'] })] });
        const logs = [];
        serverApplyEventEffect(gs, DERAILMENT_CARD, logs, 0);

        assert.equal(gs.derailedPlayers[0], 1);
        assert.equal(gs.players[0].loads.length, 1);
        const remaining = gs.players[0].loads[0];
        assert.ok(remaining === 'Coal' || remaining === 'Wine', `Remaining load should be Coal or Wine, got ${remaining}`);
        assert.ok(logs.some(l => l.includes('drops')));
    });

    it('3 loads: drops one, keeps two', () => {
        const gs = makeGameState({ players: [makePlayer({ loads: ['Coal', 'Wine', 'Oil'] })] });
        const logs = [];
        serverApplyEventEffect(gs, DERAILMENT_CARD, logs, 0);

        assert.equal(gs.derailedPlayers[0], 1);
        assert.equal(gs.players[0].loads.length, 2);
        for (const load of gs.players[0].loads) {
            assert.ok(['Coal', 'Wine', 'Oil'].includes(load), `Unexpected load: ${load}`);
        }
    });

    it('2 loads: random selection covers both possibilities (statistical)', () => {
        // Run many times to verify randomness — at least one of each load should be dropped
        const dropped = new Set();
        for (let i = 0; i < 100; i++) {
            const gs = makeGameState({ players: [makePlayer({ loads: ['Coal', 'Wine'] })] });
            serverApplyEventEffect(gs, DERAILMENT_CARD, [], 0);
            // The remaining load tells us which was dropped
            const remaining = gs.players[0].loads[0];
            dropped.add(remaining === 'Coal' ? 'Wine' : 'Coal');
        }
        assert.ok(dropped.has('Coal'), 'Coal should be dropped at least once in 100 runs');
        assert.ok(dropped.has('Wine'), 'Wine should be dropped at least once in 100 runs');
    });
});

// ---------------------------------------------------------------------------
// Zone & location checks
// ---------------------------------------------------------------------------

describe('Derailment zone checks', () => {
    it('player not in zone is unaffected', () => {
        const gs = makeGameState({ players: [makePlayer({ trainLocation: OUT_OF_ZONE_MILEPOST, loads: ['Coal'] })] });
        const logs = [];
        serverApplyEventEffect(gs, DERAILMENT_CARD, logs, 0);

        assert.equal(gs.derailedPlayers[0], undefined);
        assert.equal(gs.players[0].loads.length, 1);
        assert.equal(logs.length, 0);
    });

    it('player with null trainLocation is unaffected', () => {
        const gs = makeGameState({ players: [makePlayer({ trainLocation: null, loads: ['Coal'] })] });
        const logs = [];
        serverApplyEventEffect(gs, DERAILMENT_CARD, logs, 0);

        assert.equal(gs.derailedPlayers[0], undefined);
        assert.equal(gs.players[0].loads.length, 1);
    });
});

// ---------------------------------------------------------------------------
// Movement budget: drawing player in operate phase
// ---------------------------------------------------------------------------

describe('Derailment movement budget', () => {
    it('drawing player in zone during operate phase: movement set to 0', () => {
        const gs = makeGameState({
            phase: 'operate',
            players: [makePlayer({ loads: ['Coal'], movement: 9 })],
            currentPlayerIndex: 0
        });
        serverApplyEventEffect(gs, DERAILMENT_CARD, [], 0);

        assert.equal(gs.players[0].movement, 0);
    });

    it('non-drawing player in zone: movement unchanged', () => {
        const p0 = makePlayer({ name: 'Drawer', loads: ['Coal'], movement: 9 });
        const p1 = makePlayer({ name: 'Other', loads: ['Wine'], movement: 12 });
        const gs = makeGameState({
            phase: 'operate',
            players: [p0, p1],
            currentPlayerIndex: 0
        });
        // drawingPlayerIndex = 0, so player 1 should keep movement
        serverApplyEventEffect(gs, DERAILMENT_CARD, [], 0);

        assert.equal(gs.players[1].movement, 12);
    });

    it('drawing player in zone during build phase: movement unchanged', () => {
        const gs = makeGameState({
            phase: 'build',
            players: [makePlayer({ loads: ['Coal'], movement: 9 })],
            currentPlayerIndex: 0
        });
        serverApplyEventEffect(gs, DERAILMENT_CARD, [], 0);

        assert.equal(gs.players[0].movement, 9);
    });

    it('drawing player in zone during initialBuilding phase: movement unchanged', () => {
        const gs = makeGameState({
            phase: 'initialBuilding',
            players: [makePlayer({ loads: ['Coal'], movement: 9 })],
            currentPlayerIndex: 0
        });
        serverApplyEventEffect(gs, DERAILMENT_CARD, [], 0);

        assert.equal(gs.players[0].movement, 9);
    });
});

// ---------------------------------------------------------------------------
// Multiple players
// ---------------------------------------------------------------------------

describe('Multiple players in derailment zone', () => {
    it('each player affected independently', () => {
        const p0 = makePlayer({ name: 'Alice', loads: [] });
        const p1 = makePlayer({ name: 'Bob', loads: ['Coal'] });
        const p2 = makePlayer({ name: 'Carol', loads: ['Wine', 'Oil'], trainLocation: OUT_OF_ZONE_MILEPOST });
        const gs = makeGameState({ players: [p0, p1, p2] });
        const logs = [];
        serverApplyEventEffect(gs, DERAILMENT_CARD, logs, 0);

        // Alice: derailed, no load to drop
        assert.equal(gs.derailedPlayers[0], 1);
        assert.equal(gs.players[0].loads.length, 0);

        // Bob: derailed, loses his one load
        assert.equal(gs.derailedPlayers[1], 1);
        assert.equal(gs.players[1].loads.length, 0);

        // Carol: out of zone, unaffected
        assert.equal(gs.derailedPlayers[2], undefined);
        assert.equal(gs.players[2].loads.length, 2);
    });
});

// ---------------------------------------------------------------------------
// Gale at ferry port: same logic
// ---------------------------------------------------------------------------

describe('Gale at ferry port', () => {
    it('player at ferry port in gale zone: random load drop and turn skip', () => {
        const gs = makeGameState({
            players: [makePlayer({ trainLocation: FERRY_PORT_MILEPOST, loads: ['Coal', 'Wine'] })],
            eventZones: { 138: [FERRY_PORT_MILEPOST] }
        });
        const logs = [];
        serverApplyEventEffect(gs, GALE_CARD_138, logs, 0);

        assert.equal(gs.derailedPlayers[0], 1);
        assert.equal(gs.players[0].loads.length, 1);
        assert.ok(logs.some(l => l.includes('caught in gale at ferry port!')));
        assert.ok(logs.some(l => l.includes('drops')));
    });

    it('player at ferry port in gale zone with 0 loads: no drop', () => {
        const gs = makeGameState({
            players: [makePlayer({ trainLocation: FERRY_PORT_MILEPOST, loads: [] })],
            eventZones: { 138: [FERRY_PORT_MILEPOST] }
        });
        const logs = [];
        serverApplyEventEffect(gs, GALE_CARD_138, logs, 0);

        assert.equal(gs.derailedPlayers[0], 1);
        assert.equal(gs.players[0].loads.length, 0);
        assert.ok(logs.some(l => l.includes('Loses next turn.')));
        assert.ok(!logs.some(l => l.includes('drops')));
    });

    it('player NOT at ferry port in gale zone: unaffected', () => {
        const gs = makeGameState({
            players: [makePlayer({ trainLocation: ZONE_MILEPOST, loads: ['Coal'] })],
            eventZones: { 138: [ZONE_MILEPOST] }
        });
        const logs = [];
        serverApplyEventEffect(gs, GALE_CARD_138, logs, 0);

        // ZONE_MILEPOST is not a ferry port, so player should be unaffected
        assert.equal(gs.derailedPlayers[0], undefined);
        assert.equal(gs.players[0].loads.length, 1);
    });

    it('drawing player at ferry port in gale zone during operate: movement zeroed', () => {
        const gs = makeGameState({
            phase: 'operate',
            players: [makePlayer({ trainLocation: FERRY_PORT_MILEPOST, loads: ['Coal'], movement: 12 })],
            eventZones: { 138: [FERRY_PORT_MILEPOST] },
            currentPlayerIndex: 0
        });
        serverApplyEventEffect(gs, GALE_CARD_138, [], 0);

        assert.equal(gs.players[0].movement, 0);
    });
});

// ---------------------------------------------------------------------------
// applyDerailmentToPlayer unit tests
// ---------------------------------------------------------------------------

describe('applyDerailmentToPlayer helper', () => {
    it('log message includes the event label', () => {
        const gs = makeGameState({ players: [makePlayer({ loads: ['Coal'] })] });
        const logs = [];
        applyDerailmentToPlayer(gs, gs.players[0], 0, logs, 'custom event!', null);

        assert.ok(logs.some(l => l.includes('custom event!')));
    });

    it('log message includes dropped good name', () => {
        const gs = makeGameState({ players: [makePlayer({ loads: ['Bauxite'] })] });
        const logs = [];
        applyDerailmentToPlayer(gs, gs.players[0], 0, logs, 'derailed!', null);

        assert.ok(logs.some(l => l.includes('Bauxite')));
    });
});
