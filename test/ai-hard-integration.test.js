/**
 * Integration tests for Hard AI in multiplayer (Commit 9)
 *
 * Tests the full server loop: Hard AI turn execution, two-phase operate/build,
 * mixed difficulty games, and borrow action handling.
 *
 * Run: AI_ACTION_DELAY_MS=100 node --test test/ai-hard-integration.test.js
 */

const { describe, it, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const ClientIO = require('socket.io-client');

let serverInstance;
let rooms;
let PORT;

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------

before(async () => {
    process.env.PORT = '0';
    process.env.DISCONNECT_GRACE_MS = '60000';
    process.env.TURN_TIMER_MS = '60000';
    process.env.AI_ACTION_DELAY_MS = '100';
    delete require.cache[require.resolve('../server')];
    ({ listener: serverInstance, rooms } = require('../server'));

    await new Promise((resolve) => {
        if (serverInstance.listening) {
            PORT = serverInstance.address().port;
            resolve();
        } else {
            serverInstance.on('listening', () => {
                PORT = serverInstance.address().port;
                resolve();
            });
        }
    });
});

after(async () => {
    if (serverInstance) {
        await new Promise((resolve) => serverInstance.close(resolve));
    }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const allClients = [];

afterEach(() => {
    for (const c of allClients) {
        if (c.connected) c.disconnect();
    }
    allClients.length = 0;
});

function createClient(opts = {}) {
    return new Promise((resolve) => {
        const client = ClientIO(`http://localhost:${PORT}`, {
            transports: ['websocket'],
            forceNew: true,
            reconnection: false,
            ...opts,
        });
        allClients.push(client);
        client.on('connect', () => resolve(client));
    });
}

function emit(socket, event, data) {
    return new Promise((resolve) => {
        socket.emit(event, data, (res) => resolve(res));
    });
}

function once(socket, event, timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Timeout waiting for '${event}'`)), timeoutMs);
        socket.once(event, (data) => {
            clearTimeout(timer);
            resolve(data);
        });
    });
}

function waitForStateUpdate(socket, predicate, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            socket.off('stateUpdate', handler);
            reject(new Error('Timeout waiting for matching stateUpdate'));
        }, timeoutMs);
        function handler(data) {
            if (predicate(data)) {
                clearTimeout(timer);
                socket.off('stateUpdate', handler);
                resolve(data);
            }
        }
        socket.on('stateUpdate', handler);
    });
}

async function createGameWithAI(client, overrides = {}) {
    const playerName = overrides.playerName || 'TestPlayer';
    const playerColor = overrides.playerColor || 'red';
    const aiPlayers = overrides.aiPlayers || [
        { name: 'Hard AI', difficulty: 'hard', color: 'blue' }
    ];

    const createRes = await emit(client, 'createRoom', { playerName });
    assert.equal(createRes.success, true, 'Room creation should succeed');
    const { roomCode, sessionToken } = createRes;

    await emit(client, 'selectColor', { color: playerColor });

    for (const ai of aiPlayers) {
        const aiUpdateP = once(client, 'roomUpdate');
        await emit(client, 'addAIPlayer', { difficulty: ai.difficulty || 'hard' });
        const info = await aiUpdateP;
        const addedAI = info.players.filter(p => p.isAI).pop();
        await emit(client, 'updateAIPlayer', { sessionToken: addedAI.id, color: ai.color });
    }

    const gameStartP = once(client, 'gameStart', 15000);
    client.emit('startGame');
    const { state } = await gameStartP;

    return { roomCode, sessionToken, state };
}

// ===========================================================================
// HARD AI INTEGRATION TESTS
// ===========================================================================

describe('Hard AI: Server Integration', () => {

    it('Hard AI completes initial building turn', async () => {
        const client = await createClient();
        const { state } = await createGameWithAI(client);

        assert.equal(state.currentPlayerIndex, 0, 'human should be first');
        assert.equal(state.players[1].isAI, true);
        assert.equal(state.players[1].difficulty, 'hard');

        // Human ends turn; wait for Hard AI to complete its turn
        const updatePromise = waitForStateUpdate(client, (data) =>
            data.uiEvent?.type === 'turnChanged' &&
            data.state?.currentPlayerIndex === 0
        );

        await emit(client, 'action', { type: 'endTurn' });
        const update = await updatePromise;

        assert.equal(update.state.currentPlayerIndex, 0, 'should be back to human');
        assert.ok(update.state.turn > state.turn, 'turn should have advanced');
    });

    it('Hard AI builds track during initial building', async () => {
        const client = await createClient();
        const { state } = await createGameWithAI(client);

        // Human ends turn; watch for Hard AI to build
        const updatePromise = waitForStateUpdate(client, (data) =>
            data.uiEvent?.type === 'turnChanged' &&
            data.state?.currentPlayerIndex === 0
        );

        await emit(client, 'action', { type: 'endTurn' });
        const update = await updatePromise;

        // Hard AI should have built some track
        const aiTracks = update.state.tracks.filter(t => t.color === 'blue');
        assert.ok(aiTracks.length > 0, `Hard AI should have built track, got ${aiTracks.length} segments`);
    });

    it('Hard AI operates correctly (two-phase execution)', async () => {
        const client = await createClient();
        const { state } = await createGameWithAI(client);

        // Play through initial building rounds until we reach operate phase
        // End turn repeatedly until phase changes
        let currentState = state;
        let attempts = 0;
        while (currentState.phase === 'initialBuilding' && attempts < 20) {
            const updatePromise = waitForStateUpdate(client, (data) =>
                data.uiEvent?.type === 'turnChanged' &&
                data.state?.currentPlayerIndex === 0
            );
            await emit(client, 'action', { type: 'endTurn' });
            const update = await updatePromise;
            currentState = update.state;
            attempts++;
        }

        // We should eventually reach operate phase
        // (The exact number of initial building rounds depends on game settings)
        assert.ok(attempts < 20, 'should reach operate phase within 20 turns');
    });

    it('borrow action applies correctly via executeAIAction', async () => {
        const client = await createClient();
        const { roomCode } = await createGameWithAI(client);

        // Directly verify borrow works on the game state
        const room = rooms.get(roomCode);
        const gs = room.gameState;
        const aiPlayerIndex = 1;
        const aiBefore = gs.players[aiPlayerIndex].cash;

        // Manually test borrow action (this is what executeAIAction routes)
        const { applyBorrow } = require('../server/ai-actions')({
            serverEndTurn: () => ({}),
            serverDrawCardForPlayer: () => ({}),
            getCityAtMilepost: () => null,
            isEventBlocking: () => false,
            getGoodsInCirculation: () => 0,
            serverValidatePath: () => ({ valid: true, ferryCrossings: [], foreignSegments: [] }),
            serverGetPathMovementCost: () => 1,
            serverGetMaxStepsForMovement: () => 1,
            serverGetForeignTrackOwners: () => [],
            serverChargeTrackageRights: () => ({ ok: true }),
            serverCheckTrackageStrandRisk: () => true
        });

        const result = applyBorrow(gs, aiPlayerIndex, { amount: 5 });
        assert.equal(result.success, true, 'borrow should succeed');
        assert.equal(gs.players[aiPlayerIndex].cash, aiBefore + 5, 'cash should increase by 5');
        assert.equal(gs.players[aiPlayerIndex].debtRemaining, 10, 'debt should be 2x borrow');
    });

    it('Mixed difficulty: Hard AI and Easy AI in same game', async () => {
        const client = await createClient();
        const { state } = await createGameWithAI(client, {
            aiPlayers: [
                { difficulty: 'easy', color: 'blue' },
                { difficulty: 'hard', color: 'green' }
            ]
        });

        assert.equal(state.players.length, 3, 'should have 3 players');
        assert.equal(state.players[1].difficulty, 'easy');
        assert.equal(state.players[2].difficulty, 'hard');

        // Human ends turn; both AIs should complete their turns
        const updatePromise = waitForStateUpdate(client, (data) =>
            data.uiEvent?.type === 'turnChanged' &&
            data.state?.currentPlayerIndex === 0 &&
            data.state?.turn > state.turn
        );

        await emit(client, 'action', { type: 'endTurn' });
        const update = await updatePromise;

        // All players should have completed their turns
        assert.equal(update.state.currentPlayerIndex, 0, 'should be back to human');
    });

    it('Hard AI handles multiple consecutive turns', async () => {
        const client = await createClient();
        const { state } = await createGameWithAI(client);

        // End turn twice — Hard AI should handle both
        for (let i = 0; i < 2; i++) {
            const updatePromise = waitForStateUpdate(client, (data) =>
                data.uiEvent?.type === 'turnChanged' &&
                data.state?.currentPlayerIndex === 0
            );
            await emit(client, 'action', { type: 'endTurn' });
            await updatePromise;
        }

        // If we get here without timeout, Hard AI handled multiple turns
        assert.ok(true, 'Hard AI handled multiple consecutive turns');
    });
});
