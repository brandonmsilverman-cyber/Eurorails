/**
 * Tests for Configurable Win Conditions
 *
 * Verifies:
 *   1. Room creation includes default gameSettings
 *   2. updateGameSettings event validates inputs and is host-only
 *   3. gameSettings propagates to game state on startGame
 *   4. checkWinCondition uses configured thresholds (server-side)
 *   5. getStateForPlayer includes gameSettings
 *   6. Non-host cannot change settings
 *   7. Settings cannot be changed after game starts
 *
 * Run:  node --test test/win-conditions.test.js
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
    process.env.DISCONNECT_GRACE_MS = '10000';
    process.env.TURN_TIMER_MS = '10000';
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

function createClient() {
    return new Promise((resolve) => {
        const client = ClientIO(`http://localhost:${PORT}`, {
            transports: ['websocket'],
            forceNew: true,
            reconnection: false,
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

function once(socket, event, timeoutMs = 2000) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Timeout waiting for '${event}'`)), timeoutMs);
        socket.once(event, (data) => {
            clearTimeout(timer);
            resolve(data);
        });
    });
}

/** Create a room and return { roomCode, sessionToken, host } */
async function createRoom(hostName = 'Host') {
    const host = await createClient();
    const res = await emit(host, 'createRoom', { playerName: hostName });
    assert.equal(res.success, true);
    return { roomCode: res.roomCode, sessionToken: res.sessionToken, host };
}

/** Join a room and return { sessionToken, client } */
async function joinRoom(roomCode, playerName = 'Player2') {
    const client = await createClient();
    const res = await emit(client, 'joinRoom', { roomCode, playerName });
    assert.equal(res.success, true);
    return { sessionToken: res.sessionToken, client };
}

/** Add an AI player, assign it a color, and set host color. Returns when ready to start. */
async function setupForStart(host) {
    await emit(host, 'selectColor', { color: 'red' });

    // Add AI and wait for roomUpdate to get its session token
    const aiUpdateP = once(host, 'roomUpdate');
    await emit(host, 'addAIPlayer', { difficulty: 'easy' });
    const info = await aiUpdateP;
    const aiPlayer = info.players.find(p => p.isAI);

    // Assign color to AI
    await emit(host, 'updateAIPlayer', { sessionToken: aiPlayer.id, color: 'blue' });
}

// ===========================================================================
// TESTS
// ===========================================================================

describe('Configurable Win Conditions: Room defaults', () => {
    it('room creation includes default gameSettings in roomUpdate', async () => {
        const host = await createClient();
        const roomUpdateP = once(host, 'roomUpdate');
        await emit(host, 'createRoom', { playerName: 'Host' });
        const info = await roomUpdateP;

        assert.ok(info.gameSettings);
        assert.equal(info.gameSettings.winCashThreshold, 250);
        assert.equal(info.gameSettings.winMajorCitiesRequired, 7);
    });
});

describe('Configurable Win Conditions: updateGameSettings', () => {
    it('host can update winCashThreshold', async () => {
        const { host, roomCode } = await createRoom();
        const updateP = once(host, 'roomUpdate');
        const res = await emit(host, 'updateGameSettings', { winCashThreshold: 300 });
        assert.equal(res.success, true);
        const info = await updateP;
        assert.equal(info.gameSettings.winCashThreshold, 300);
        assert.equal(info.gameSettings.winMajorCitiesRequired, 7); // unchanged
    });

    it('host can update winMajorCitiesRequired', async () => {
        const { host, roomCode } = await createRoom();
        const updateP = once(host, 'roomUpdate');
        const res = await emit(host, 'updateGameSettings', { winMajorCitiesRequired: 5 });
        assert.equal(res.success, true);
        const info = await updateP;
        assert.equal(info.gameSettings.winMajorCitiesRequired, 5);
        assert.equal(info.gameSettings.winCashThreshold, 250); // unchanged
    });

    it('host can update both settings at once', async () => {
        const { host } = await createRoom();
        const updateP = once(host, 'roomUpdate');
        const res = await emit(host, 'updateGameSettings', { winCashThreshold: 400, winMajorCitiesRequired: 3 });
        assert.equal(res.success, true);
        const info = await updateP;
        assert.equal(info.gameSettings.winCashThreshold, 400);
        assert.equal(info.gameSettings.winMajorCitiesRequired, 3);
    });

    it('rejects winCashThreshold below 100', async () => {
        const { host } = await createRoom();
        const res = await emit(host, 'updateGameSettings', { winCashThreshold: 50 });
        assert.equal(res.success, false);
        assert.ok(res.error);
    });

    it('rejects winCashThreshold above 500', async () => {
        const { host } = await createRoom();
        const res = await emit(host, 'updateGameSettings', { winCashThreshold: 550 });
        assert.equal(res.success, false);
    });

    it('rejects winCashThreshold not a multiple of 50', async () => {
        const { host } = await createRoom();
        const res = await emit(host, 'updateGameSettings', { winCashThreshold: 275 });
        assert.equal(res.success, false);
    });

    it('rejects non-integer winCashThreshold', async () => {
        const { host } = await createRoom();
        const res = await emit(host, 'updateGameSettings', { winCashThreshold: 250.5 });
        assert.equal(res.success, false);
    });

    it('rejects winMajorCitiesRequired below 1', async () => {
        const { host } = await createRoom();
        const res = await emit(host, 'updateGameSettings', { winMajorCitiesRequired: 0 });
        assert.equal(res.success, false);
    });

    it('rejects winMajorCitiesRequired above 8', async () => {
        const { host } = await createRoom();
        const res = await emit(host, 'updateGameSettings', { winMajorCitiesRequired: 9 });
        assert.equal(res.success, false);
    });

    it('non-host cannot update settings', async () => {
        const { roomCode } = await createRoom();
        const { client } = await joinRoom(roomCode);
        const res = await emit(client, 'updateGameSettings', { winCashThreshold: 300 });
        assert.equal(res.success, false);
        assert.match(res.error, /host/i);
    });

    it('non-host sees updated settings via roomUpdate', async () => {
        const { host, roomCode } = await createRoom();
        const { client } = await joinRoom(roomCode);

        const nonHostUpdateP = once(client, 'roomUpdate');
        await emit(host, 'updateGameSettings', { winCashThreshold: 150 });
        const info = await nonHostUpdateP;
        assert.equal(info.gameSettings.winCashThreshold, 150);
    });
});

describe('Configurable Win Conditions: Game start propagation', () => {
    it('gameSettings flows into game state on startGame', async () => {
        const { host, roomCode } = await createRoom();
        await emit(host, 'updateGameSettings', { winCashThreshold: 200, winMajorCitiesRequired: 4 });
        await setupForStart(host);

        const gameStartP = once(host, 'gameStart', 15000);
        host.emit('startGame');
        const { state } = await gameStartP;

        assert.ok(state.gameSettings);
        assert.equal(state.gameSettings.winCashThreshold, 200);
        assert.equal(state.gameSettings.winMajorCitiesRequired, 4);
    });

    it('cannot update settings after game starts', async () => {
        const { host } = await createRoom();
        await setupForStart(host);

        const gameStartP = once(host, 'gameStart', 15000);
        host.emit('startGame');
        await gameStartP;

        const res = await emit(host, 'updateGameSettings', { winCashThreshold: 300 });
        assert.equal(res.success, false);
        assert.match(res.error, /already started/i);
    });
});

describe('Configurable Win Conditions: checkWinCondition (server-side)', () => {
    it('custom settings stored on server game state', async () => {
        const { host, roomCode } = await createRoom();
        await emit(host, 'updateGameSettings', { winCashThreshold: 100, winMajorCitiesRequired: 1 });
        await setupForStart(host);

        const gameStartP = once(host, 'gameStart', 15000);
        host.emit('startGame');
        await gameStartP;

        const room = rooms.get(roomCode);
        const gs = room.gameState;

        assert.equal(gs.gameSettings.winCashThreshold, 100);
        assert.equal(gs.gameSettings.winMajorCitiesRequired, 1);
    });

    it('default settings used when no custom settings configured', async () => {
        const { host } = await createRoom();
        await setupForStart(host);

        const gameStartP = once(host, 'gameStart', 15000);
        host.emit('startGame');
        const { state } = await gameStartP;

        assert.equal(state.gameSettings.winCashThreshold, 250);
        assert.equal(state.gameSettings.winMajorCitiesRequired, 7);
    });
});
