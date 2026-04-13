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

/** Wait for a stateUpdate whose uiEvent matches a predicate (or type string) */
function onceUiEvent(socket, typeOrPredicate, timeoutMs = 10000) {
    const predicate = typeof typeOrPredicate === 'function'
        ? typeOrPredicate
        : (data) => data.uiEvent && data.uiEvent.type === typeOrPredicate;
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Timeout waiting for matching uiEvent`)), timeoutMs);
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

// ===========================================================================
// Tournament Endgame (Equal Turns)
// ===========================================================================

/**
 * Helper: start a game with easy win settings and skip past initial building.
 * Returns { roomCode, host, gs } with gs in operate phase, player 0's turn.
 */
async function startGameForEndgame(host, roomCode) {
    const gameStartP = once(host, 'gameStart', 15000);
    host.emit('startGame');
    await gameStartP;

    const room = rooms.get(roomCode);
    const gs = room.gameState;

    // Skip initial building — go straight to operate phase
    gs.phase = 'operate';
    gs.currentPlayerIndex = 0;
    for (const p of gs.players) {
        p.movement = 12;
    }

    return { gs, room };
}

/**
 * Helper: give a player the win condition (connect 1 major city + enough cash).
 * Requires the game to have cityToMilepost populated (which it does after createGameState).
 */
function giveWinCondition(gs, playerIndex, cash = 200) {
    const player = gs.players[playerIndex];
    player.cash = cash;

    // Add a track at a major city milepost so the BFS finds it
    const majorCityMilepost = gs.cityToMilepost['Paris'];
    gs.tracks.push({ from: majorCityMilepost, to: majorCityMilepost, color: player.color });
}

describe('Tournament Endgame: Final round (equal turns)', () => {
    it('game does NOT end immediately when player meets win condition', async () => {
        const { host, roomCode } = await createRoom();
        await emit(host, 'updateGameSettings', { winCashThreshold: 100, winMajorCitiesRequired: 1 });
        await setupForStart(host);
        const { gs } = await startGameForEndgame(host, roomCode);

        // Player 0 (host) meets win condition
        giveWinCondition(gs, 0, 200);

        // End player 0's turn — should NOT end the game
        const stateP = once(host, 'stateUpdate', 5000);
        await emit(host, 'action', { type: 'endTurn' });
        const update = await stateP;

        assert.ok(update.uiEvent, 'should have a uiEvent');
        assert.equal(update.uiEvent.type, 'turnChanged', 'should be turnChanged, not gameOver');
        assert.ok(update.uiEvent.endgameTriggered, 'should have endgameTriggered');
        assert.equal(update.uiEvent.endgameTriggered.name, gs.players[0].name);
        assert.ok(gs.endgameTriggeredBy, 'gs.endgameTriggeredBy should be set');
        assert.equal(gs.endgameQualifiers.length, 1);
    });

    it('game ends after full round completes back to triggering player', async () => {
        const { host, roomCode } = await createRoom();
        await emit(host, 'updateGameSettings', { winCashThreshold: 100, winMajorCitiesRequired: 1 });
        await setupForStart(host);
        const { gs } = await startGameForEndgame(host, roomCode);

        // Player 0 meets win condition
        giveWinCondition(gs, 0, 200);

        // Start listening for gameOver BEFORE ending turn (AI actions emit multiple stateUpdates)
        const gameOverP = onceUiEvent(host, 'gameOver');

        // End player 0's turn — triggers endgame, AI plays, then round resolves
        await emit(host, 'action', { type: 'endTurn' });

        const update = await gameOverP;
        assert.equal(update.uiEvent.type, 'gameOver');
        assert.equal(update.uiEvent.winner, gs.players[0].name);
    });

    it('multiple qualifiers — highest cash wins', async () => {
        const { host, roomCode } = await createRoom();
        await emit(host, 'updateGameSettings', { winCashThreshold: 100, winMajorCitiesRequired: 1 });
        await setupForStart(host);
        const { gs } = await startGameForEndgame(host, roomCode);

        // Player 0 meets win condition with 200 cash
        giveWinCondition(gs, 0, 200);

        // Give player 1 (AI) win condition with MORE cash BEFORE triggering endgame
        // Use high value so AI still qualifies after spending on build
        giveWinCondition(gs, 1, 500);

        // Start listening for gameOver
        const gameOverP = onceUiEvent(host, 'gameOver');

        // End player 0's turn — triggers endgame
        await emit(host, 'action', { type: 'endTurn' });

        const update = await gameOverP;
        // Player 1 should win because they have more cash
        assert.equal(update.uiEvent.type, 'gameOver');
        assert.equal(update.uiEvent.winner, gs.players[1].name);
    });

    it('tied cash bumps threshold and continues play', async () => {
        // This test verifies tie resolution logic by using a 3-player setup
        // where 2 human players both qualify with identical cash, and the AI
        // is abandoned so it auto-skips.
        const { host, roomCode } = await createRoom('Player1');
        await emit(host, 'updateGameSettings', { winCashThreshold: 100, winMajorCitiesRequired: 1 });

        // Set up host color
        await emit(host, 'selectColor', { color: 'red' });

        // Add a second human player
        const { client: player2 } = await joinRoom(roomCode, 'Player2');
        await emit(player2, 'selectColor', { color: 'green' });

        // Add AI as third player
        const aiUpdateP = once(host, 'roomUpdate');
        await emit(host, 'addAIPlayer', { difficulty: 'easy' });
        const info = await aiUpdateP;
        const aiPlayer = info.players.find(p => p.isAI);
        await emit(host, 'updateAIPlayer', { sessionToken: aiPlayer.id, color: 'blue' });

        // Start game
        const gameStartP = once(host, 'gameStart', 15000);
        host.emit('startGame');
        await gameStartP;

        const room = rooms.get(roomCode);
        const gs = room.gameState;

        // Skip to operate phase
        gs.phase = 'operate';
        gs.currentPlayerIndex = 0;
        for (const p of gs.players) p.movement = 12;

        // Player 0 and Player 1 both meet win condition with identical cash
        giveWinCondition(gs, 0, 200);
        giveWinCondition(gs, 1, 200);

        // Abandon the AI so its turn auto-skips (no cash spending)
        gs.players[2].abandoned = true;

        // Player 0 ends turn → triggers endgame
        const endgameP = onceUiEvent(host, (data) =>
            data.uiEvent?.type === 'turnChanged' && data.uiEvent.endgameTriggered);
        await emit(host, 'action', { type: 'endTurn' });
        await endgameP;

        // Now it's player 1's turn. They also qualify.
        // Player 1 ends turn → AI is skipped → round resolves → tie detected
        const turnP = onceUiEvent(host, (data) =>
            data.uiEvent?.type === 'turnChanged' && !data.uiEvent.endgameTriggered);
        await emit(player2, 'action', { type: 'endTurn' });
        await turnP;

        // Threshold should have been bumped by 50
        assert.equal(gs.gameSettings.winCashThreshold, 150, 'threshold should bump by 50');
        assert.equal(gs.endgameTriggeredBy, null, 'endgameTriggeredBy should be cleared');
        assert.equal(gs.endgameQualifiers.length, 0, 'endgameQualifiers should be cleared');
    });

    it('endgameTriggeredBy and endgameQualifiers initialized as null/empty', async () => {
        const { host, roomCode } = await createRoom();
        await setupForStart(host);

        const gameStartP = once(host, 'gameStart', 15000);
        host.emit('startGame');
        await gameStartP;

        const room = rooms.get(roomCode);
        const gs = room.gameState;

        assert.equal(gs.endgameTriggeredBy, null);
        assert.deepEqual(gs.endgameQualifiers, []);
    });
});
