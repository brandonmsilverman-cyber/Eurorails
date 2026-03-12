/**
 * Tests for Phase 1: Solo Mode Lobby + AI Player Infrastructure
 *
 * Verifies:
 *   1. Solo game creation via createSoloGame event
 *   2. AI players are marked with isAI/difficulty in game state
 *   3. Validation of solo game inputs (colors, AI count, difficulty)
 *   4. Solo rooms are hidden from the public room list
 *   5. Human player receives correct filtered game state
 *   6. Game state structure is correct (players, turns, phases)
 *   7. AI players have demand cards and starting cash like human players
 *   8. Solo game reconnection works
 *
 * Prerequisites:
 *   1. server.js must export the http server.
 *   2. Run:  node --test test/solo-mode.test.js
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

function once(socket, event, timeoutMs = 2000) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Timeout waiting for '${event}'`)), timeoutMs);
        socket.once(event, (data) => {
            clearTimeout(timer);
            resolve(data);
        });
    });
}

function makeSoloGameData(overrides = {}) {
    return {
        playerName: 'TestPlayer',
        playerColor: 'red',
        aiPlayers: [
            { name: 'AI 1 (Easy)', difficulty: 'easy', color: 'blue' }
        ],
        ...overrides
    };
}

// ===========================================================================
// SOLO MODE TESTS
// ===========================================================================

describe('Solo Mode: Game Creation', () => {

    it('creates a solo game with 1 AI opponent', async () => {
        const client = await createClient();
        const res = await emit(client, 'createSoloGame', makeSoloGameData());

        assert.equal(res.success, true);
        assert.ok(res.roomCode);
        assert.ok(res.sessionToken);
        assert.ok(res.state);
        assert.equal(res.state.gameStarted, true);
    });

    it('creates a solo game with 5 AI opponents', async () => {
        const client = await createClient();
        const res = await emit(client, 'createSoloGame', makeSoloGameData({
            aiPlayers: [
                { name: 'AI 1', difficulty: 'easy', color: 'blue' },
                { name: 'AI 2', difficulty: 'easy', color: 'green' },
                { name: 'AI 3', difficulty: 'easy', color: 'yellow' },
                { name: 'AI 4', difficulty: 'easy', color: 'purple' },
                { name: 'AI 5', difficulty: 'easy', color: 'orange' },
            ]
        }));

        assert.equal(res.success, true);
        assert.equal(res.state.players.length, 6);
    });

    it('returns correct player count in game state', async () => {
        const client = await createClient();
        const res = await emit(client, 'createSoloGame', makeSoloGameData({
            aiPlayers: [
                { name: 'AI 1', difficulty: 'easy', color: 'blue' },
                { name: 'AI 2', difficulty: 'easy', color: 'green' },
            ]
        }));

        assert.equal(res.success, true);
        assert.equal(res.state.players.length, 3);
    });

    it('human player is first in the player list', async () => {
        const client = await createClient();
        const res = await emit(client, 'createSoloGame', makeSoloGameData({
            playerName: 'HumanPlayer',
            playerColor: 'red'
        }));

        assert.equal(res.state.players[0].name, 'HumanPlayer');
        assert.equal(res.state.players[0].color, 'red');
        assert.equal(res.state.players[0].isAI, undefined);
    });

    it('game starts in initialBuilding phase', async () => {
        const client = await createClient();
        const res = await emit(client, 'createSoloGame', makeSoloGameData());

        assert.equal(res.state.phase, 'initialBuilding');
        assert.equal(res.state.currentPlayerIndex, 0);
        assert.equal(res.state.turn, 1);
    });

    it('game state includes hex grid-dependent data', async () => {
        const client = await createClient();
        const res = await emit(client, 'createSoloGame', makeSoloGameData());

        // Deck count should be present (not the full deck)
        assert.equal(typeof res.state.demandCardDeck, 'number');
        assert.ok(res.state.demandCardDeck > 0);
        // Tracks should be empty
        assert.deepEqual(res.state.tracks, []);
        assert.deepEqual(res.state.ferryOwnership, {});
    });
});

describe('Solo Mode: AI Player Properties', () => {

    it('AI players are marked with isAI: true', async () => {
        const client = await createClient();
        const res = await emit(client, 'createSoloGame', makeSoloGameData());

        const aiPlayer = res.state.players[1];
        assert.equal(aiPlayer.isAI, true);
    });

    it('AI players have correct difficulty', async () => {
        const client = await createClient();
        const res = await emit(client, 'createSoloGame', makeSoloGameData());

        const aiPlayer = res.state.players[1];
        assert.equal(aiPlayer.difficulty, 'easy');
    });

    it('AI players have correct colors', async () => {
        const client = await createClient();
        const res = await emit(client, 'createSoloGame', makeSoloGameData({
            aiPlayers: [
                { name: 'AI 1', difficulty: 'easy', color: 'blue' },
                { name: 'AI 2', difficulty: 'easy', color: 'green' },
            ]
        }));

        assert.equal(res.state.players[1].color, 'blue');
        assert.equal(res.state.players[2].color, 'green');
    });

    it('AI players have correct names', async () => {
        const client = await createClient();
        const res = await emit(client, 'createSoloGame', makeSoloGameData({
            aiPlayers: [
                { name: 'AI 1 (Easy)', difficulty: 'easy', color: 'blue' },
            ]
        }));

        assert.equal(res.state.players[1].name, 'AI 1 (Easy)');
    });

    it('AI players have starting cash of 50', async () => {
        const client = await createClient();
        const res = await emit(client, 'createSoloGame', makeSoloGameData());

        const aiPlayer = res.state.players[1];
        assert.equal(aiPlayer.cash, 50);
    });

    it('AI players have Freight train type', async () => {
        const client = await createClient();
        const res = await emit(client, 'createSoloGame', makeSoloGameData());

        const aiPlayer = res.state.players[1];
        assert.equal(aiPlayer.trainType, 'Freight');
    });

    it('AI players have hidden demand cards (from human perspective)', async () => {
        const client = await createClient();
        const res = await emit(client, 'createSoloGame', makeSoloGameData());

        const aiPlayer = res.state.players[1];
        // AI demand cards should be hidden from the human player
        assert.equal(aiPlayer.demandCards.length, 3);
        for (const card of aiPlayer.demandCards) {
            assert.equal(card.hidden, true);
        }
    });

    it('human player sees their own demand cards in full', async () => {
        const client = await createClient();
        const res = await emit(client, 'createSoloGame', makeSoloGameData());

        const humanPlayer = res.state.players[0];
        assert.equal(humanPlayer.demandCards.length, 3);
        for (const card of humanPlayer.demandCards) {
            assert.equal(card.hidden, undefined);
            assert.equal(card.type, 'demand');
            assert.equal(card.demands.length, 3);
        }
    });

    it('AI players are marked as connected', async () => {
        const client = await createClient();
        const res = await emit(client, 'createSoloGame', makeSoloGameData());

        // AI players should always appear connected
        const aiPlayer = res.state.players[1];
        assert.equal(aiPlayer.connected, true);
    });
});

describe('Solo Mode: Input Validation', () => {

    it('rejects empty player name', async () => {
        const client = await createClient();
        const res = await emit(client, 'createSoloGame', makeSoloGameData({
            playerName: ''
        }));
        assert.equal(res.success, false);
        assert.match(res.error, /name/i);
    });

    it('rejects whitespace-only player name', async () => {
        const client = await createClient();
        const res = await emit(client, 'createSoloGame', makeSoloGameData({
            playerName: '   '
        }));
        assert.equal(res.success, false);
        assert.match(res.error, /name/i);
    });

    it('rejects invalid player color', async () => {
        const client = await createClient();
        const res = await emit(client, 'createSoloGame', makeSoloGameData({
            playerColor: 'pink'
        }));
        assert.equal(res.success, false);
        assert.match(res.error, /color/i);
    });

    it('rejects missing player color', async () => {
        const client = await createClient();
        const res = await emit(client, 'createSoloGame', makeSoloGameData({
            playerColor: null
        }));
        assert.equal(res.success, false);
    });

    it('rejects zero AI players', async () => {
        const client = await createClient();
        const res = await emit(client, 'createSoloGame', makeSoloGameData({
            aiPlayers: []
        }));
        assert.equal(res.success, false);
        assert.match(res.error, /1-5/i);
    });

    it('rejects more than 5 AI players', async () => {
        const client = await createClient();
        const res = await emit(client, 'createSoloGame', makeSoloGameData({
            aiPlayers: Array(6).fill(null).map((_, i) => ({
                name: `AI ${i + 1}`, difficulty: 'easy', color: ['blue', 'green', 'yellow', 'purple', 'orange', 'red'][i]
            }))
        }));
        assert.equal(res.success, false);
        assert.match(res.error, /1-5/i);
    });

    it('rejects duplicate colors between human and AI', async () => {
        const client = await createClient();
        const res = await emit(client, 'createSoloGame', makeSoloGameData({
            playerColor: 'red',
            aiPlayers: [{ name: 'AI 1', difficulty: 'easy', color: 'red' }]
        }));
        assert.equal(res.success, false);
        assert.match(res.error, /unique/i);
    });

    it('rejects duplicate colors between AI players', async () => {
        const client = await createClient();
        const res = await emit(client, 'createSoloGame', makeSoloGameData({
            aiPlayers: [
                { name: 'AI 1', difficulty: 'easy', color: 'blue' },
                { name: 'AI 2', difficulty: 'easy', color: 'blue' },
            ]
        }));
        assert.equal(res.success, false);
        assert.match(res.error, /unique/i);
    });

    it('rejects invalid AI color', async () => {
        const client = await createClient();
        const res = await emit(client, 'createSoloGame', makeSoloGameData({
            aiPlayers: [{ name: 'AI 1', difficulty: 'easy', color: 'magenta' }]
        }));
        assert.equal(res.success, false);
        assert.match(res.error, /color/i);
    });

    it('rejects AI without color', async () => {
        const client = await createClient();
        const res = await emit(client, 'createSoloGame', makeSoloGameData({
            aiPlayers: [{ name: 'AI 1', difficulty: 'easy', color: null }]
        }));
        assert.equal(res.success, false);
    });

    it('rejects invalid AI difficulty', async () => {
        const client = await createClient();
        const res = await emit(client, 'createSoloGame', makeSoloGameData({
            aiPlayers: [{ name: 'AI 1', difficulty: 'impossible', color: 'blue' }]
        }));
        assert.equal(res.success, false);
        assert.match(res.error, /difficulty/i);
    });

    it('rejects non-array aiPlayers', async () => {
        const client = await createClient();
        const res = await emit(client, 'createSoloGame', makeSoloGameData({
            aiPlayers: 'not-an-array'
        }));
        assert.equal(res.success, false);
    });
});

describe('Solo Mode: Room Privacy', () => {

    it('solo rooms do not appear in room list', async () => {
        const client = await createClient();
        await emit(client, 'createSoloGame', makeSoloGameData());

        // Create a second client to check room list
        const observer = await createClient();
        const roomList = await new Promise(resolve => {
            observer.emit('listRooms', resolve);
        });

        assert.equal(roomList.length, 0);
    });

    it('solo rooms do not appear alongside multiplayer rooms', async () => {
        const client1 = await createClient();
        // Create a normal multiplayer room first
        const mpRes = await emit(client1, 'createRoom', {
            playerName: 'MultiHost',
            maxPlayers: 2,
            password: null
        });
        assert.equal(mpRes.success, true);

        // Now create a solo game
        const client2 = await createClient();
        await emit(client2, 'createSoloGame', makeSoloGameData());

        // Check room list - should only show the multiplayer room
        const observer = await createClient();
        const roomList = await new Promise(resolve => {
            observer.emit('listRooms', resolve);
        });
        assert.equal(roomList.length, 1);
        assert.equal(roomList[0].hostName, 'MultiHost');
    });
});

describe('Solo Mode: Reconnection', () => {

    it('can rejoin a solo game after disconnect', async () => {
        const client = await createClient();
        const res = await emit(client, 'createSoloGame', makeSoloGameData());
        assert.equal(res.success, true);

        const { roomCode, sessionToken } = res;

        // Disconnect
        client.disconnect();

        // Reconnect with a new socket
        const newClient = await createClient();
        const rejoinRes = await emit(newClient, 'rejoinGame', {
            roomCode,
            sessionToken
        });

        assert.equal(rejoinRes.success, true);
        assert.ok(rejoinRes.state);
        assert.equal(rejoinRes.state.players.length, 2);
        // AI player should still be marked
        assert.equal(rejoinRes.state.players[1].isAI, true);
        assert.equal(rejoinRes.state.players[1].difficulty, 'easy');
    });
});

describe('Solo Mode: Multiple Solo Games', () => {

    it('allows multiple independent solo games', async () => {
        const client1 = await createClient();
        const res1 = await emit(client1, 'createSoloGame', makeSoloGameData({
            playerName: 'Player1',
            playerColor: 'red',
            aiPlayers: [{ name: 'AI', difficulty: 'easy', color: 'blue' }]
        }));

        const client2 = await createClient();
        const res2 = await emit(client2, 'createSoloGame', makeSoloGameData({
            playerName: 'Player2',
            playerColor: 'green',
            aiPlayers: [{ name: 'AI', difficulty: 'easy', color: 'yellow' }]
        }));

        assert.equal(res1.success, true);
        assert.equal(res2.success, true);
        assert.notEqual(res1.roomCode, res2.roomCode);

        // Each game should have its own state
        assert.equal(res1.state.players[0].name, 'Player1');
        assert.equal(res2.state.players[0].name, 'Player2');
    });
});

describe('Solo Mode: Game State Integrity', () => {

    it('game log contains start message', async () => {
        const client = await createClient();
        const res = await emit(client, 'createSoloGame', makeSoloGameData());

        assert.ok(res.state.gameLog.length > 0);
        assert.match(res.state.gameLog[0], /game started/i);
    });

    it('all players have empty loads at start', async () => {
        const client = await createClient();
        const res = await emit(client, 'createSoloGame', makeSoloGameData({
            aiPlayers: [
                { name: 'AI 1', difficulty: 'easy', color: 'blue' },
                { name: 'AI 2', difficulty: 'easy', color: 'green' },
            ]
        }));

        for (const p of res.state.players) {
            assert.deepEqual(p.loads, []);
        }
    });

    it('all players have null train location at start', async () => {
        const client = await createClient();
        const res = await emit(client, 'createSoloGame', makeSoloGameData());

        for (const p of res.state.players) {
            assert.equal(p.trainLocation, null);
        }
    });

    it('no active events at start', async () => {
        const client = await createClient();
        const res = await emit(client, 'createSoloGame', makeSoloGameData());

        assert.deepEqual(res.state.activeEvents, []);
    });

    it('initial building rounds is 2', async () => {
        const client = await createClient();
        const res = await emit(client, 'createSoloGame', makeSoloGameData());

        assert.equal(res.state.initialBuildingRounds, 2);
        assert.equal(res.state.buildingPhaseCount, 0);
    });
});
