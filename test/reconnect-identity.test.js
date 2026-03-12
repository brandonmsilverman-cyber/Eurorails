/**
 * Tests for Steps 0 & 1: Stable Player Identity + Updated Identity References
 *
 * Prerequisites:
 *   1. server.js must export the http server for testability. Add this at the
 *      bottom of server.js (replacing or after the listen call):
 *
 *        const listener = server.listen(PORT, () => { ... });
 *        module.exports = listener;
 *
 *   2. Run:  node --test test/reconnect-identity.test.js
 */

const { describe, it, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const ClientIO = require('socket.io-client');

let serverInstance;
let PORT;

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------

before(async () => {
  // Use a random port to avoid conflicts
  process.env.PORT = '0';
  // Clear cache so we get a fresh server
  delete require.cache[require.resolve('../server')];
  ({ listener: serverInstance } = require('../server'));

  // If server.listen(0) was used, .address() gives the actual port
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

function once(socket, event) {
  return new Promise((resolve) => {
    socket.once(event, (data) => resolve(data));
  });
}

async function makeRoom(hostName, maxPlayers = 2) {
  const client = await createClient();
  const res = await emit(client, 'createRoom', {
    playerName: hostName,
    maxPlayers,
    password: null,
  });
  return { client, res };
}

async function joinRoom(roomCode, name) {
  const client = await createClient();
  const res = await emit(client, 'joinRoom', {
    roomCode,
    playerName: name,
    password: null,
  });
  return { client, res };
}

/** Pick colors and start a 2-player game. Returns [hostGameData, joinerGameData]. */
async function startTwoPlayerGame(host, joiner) {
  await emit(host, 'selectColor', { color: 'red' });
  await emit(joiner, 'selectColor', { color: 'blue' });
  const p1 = once(host, 'gameStart');
  const p2 = once(joiner, 'gameStart');
  host.emit('startGame');
  return Promise.all([p1, p2]);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// ===========================================================================
// STEP 0: Foundation — Stable Player Identity
// ===========================================================================

describe('Step 0: Stable Player Identity', () => {
  // --- createRoom ---

  describe('createRoom', () => {
    it('returns a sessionToken', async () => {
      const { res } = await makeRoom('Alice');
      assert.equal(res.success, true);
      assert.ok(res.sessionToken, 'must include sessionToken');
    });

    it('sessionToken is a valid UUID v4', async () => {
      const { res } = await makeRoom('Alice');
      assert.match(res.sessionToken, UUID_RE);
    });

    it('different rooms get different tokens', async () => {
      const { res: r1 } = await makeRoom('Alice');
      const { res: r2 } = await makeRoom('Bob');
      assert.notEqual(r1.sessionToken, r2.sessionToken);
    });
  });

  // --- joinRoom ---

  describe('joinRoom', () => {
    it('returns a sessionToken', async () => {
      const { res: hostRes } = await makeRoom('Alice');
      const { res: joinRes } = await joinRoom(hostRes.roomCode, 'Bob');
      assert.equal(joinRes.success, true);
      assert.ok(joinRes.sessionToken);
    });

    it('joiner token differs from host token', async () => {
      const { res: hostRes } = await makeRoom('Alice');
      const { res: joinRes } = await joinRoom(hostRes.roomCode, 'Bob');
      assert.notEqual(hostRes.sessionToken, joinRes.sessionToken);
    });
  });

  // --- Room data structure ---

  describe('room info uses sessionTokens', () => {
    it('roomUpdate has hostSessionToken matching creator', async () => {
      const host = await createClient();
      const updateP = once(host, 'roomUpdate');
      const res = await emit(host, 'createRoom', {
        playerName: 'Alice',
        maxPlayers: 2,
        password: null,
      });
      const info = await updateP;

      assert.ok(
        info.hostSessionToken,
        'roomInfo should have hostSessionToken field'
      );
      assert.equal(info.hostSessionToken, res.sessionToken);
    });

    it('player ids in roomUpdate are sessionTokens, not socket ids', async () => {
      const { client: host, res: hostRes } = await makeRoom('Alice');
      const updateP = once(host, 'roomUpdate');
      const { res: joinRes } = await joinRoom(hostRes.roomCode, 'Bob');
      const info = await updateP;

      const alice = info.players.find((p) => p.name === 'Alice');
      const bob = info.players.find((p) => p.name === 'Bob');

      assert.equal(alice.id, hostRes.sessionToken);
      assert.equal(bob.id, joinRes.sessionToken);
      // UUIDs contain dashes; socket.ids don't
      assert.ok(alice.id.includes('-'), 'id should be a UUID, not a socket.id');
    });
  });

  // --- createGameState ---

  describe('game state player ids', () => {
    it('player.id in game state equals sessionToken', async () => {
      const { client: host, res: hostRes } = await makeRoom('Alice');
      const { client: joiner, res: joinRes } = await joinRoom(
        hostRes.roomCode,
        'Bob'
      );

      const [hostGame] = await startTwoPlayerGame(host, joiner);

      const alice = hostGame.state.players.find((p) => p.name === 'Alice');
      const bob = hostGame.state.players.find((p) => p.name === 'Bob');

      assert.equal(alice.id, hostRes.sessionToken);
      assert.equal(bob.id, joinRes.sessionToken);
    });

    it('player.id differs from socket.id', async () => {
      const { client: host, res: hostRes } = await makeRoom('Alice');
      const { client: joiner } = await joinRoom(hostRes.roomCode, 'Bob');

      const [hostGame] = await startTwoPlayerGame(host, joiner);

      const alice = hostGame.state.players.find((p) => p.name === 'Alice');
      assert.notEqual(alice.id, host.id, 'player.id must not be socket.id');
    });
  });
});

// ===========================================================================
// STEP 1: Update All Identity References
// ===========================================================================

describe('Step 1: Update All Identity References', () => {
  // --- getStateForPlayer ---

  describe('getStateForPlayer filters by sessionToken', () => {
    it('each player sees own cards but not the other player\'s', async () => {
      const { client: host, res: hostRes } = await makeRoom('Alice');
      const { client: joiner, res: joinRes } = await joinRoom(
        hostRes.roomCode,
        'Bob'
      );

      const [hostGame, joinerGame] = await startTwoPlayerGame(host, joiner);

      // Host's view
      const hostSelf = hostGame.state.players.find(
        (p) => p.id === hostRes.sessionToken
      );
      const hostViewBob = hostGame.state.players.find(
        (p) => p.id === joinRes.sessionToken
      );

      assert.ok(hostSelf, 'host finds self by sessionToken');
      assert.ok(
        hostSelf.demandCards.length > 0 && !hostSelf.demandCards[0].hidden,
        'host sees own full cards'
      );
      assert.ok(
        hostViewBob.demandCards.every((c) => c.hidden),
        'host sees Bob\'s cards as hidden'
      );

      // Joiner's view
      const joinerSelf = joinerGame.state.players.find(
        (p) => p.id === joinRes.sessionToken
      );
      const joinerViewAlice = joinerGame.state.players.find(
        (p) => p.id === hostRes.sessionToken
      );

      assert.ok(
        joinerSelf.demandCards.length > 0 && !joinerSelf.demandCards[0].hidden,
        'joiner sees own full cards'
      );
      assert.ok(
        joinerViewAlice.demandCards.every((c) => c.hidden),
        'joiner sees Alice\'s cards as hidden'
      );
    });
  });

  // --- broadcastStateUpdate ---

  describe('broadcastStateUpdate sends per-player state', () => {
    it('stateUpdate after endTurn contains sessionToken-based player ids', async () => {
      const { client: host, res: hostRes } = await makeRoom('Alice');
      const { client: joiner, res: joinRes } = await joinRoom(
        hostRes.roomCode,
        'Bob'
      );
      await startTwoPlayerGame(host, joiner);

      const hostP = once(host, 'stateUpdate');
      const joinerP = once(joiner, 'stateUpdate');

      const actionRes = await emit(host, 'action', { type: 'endTurn' });
      assert.equal(actionRes.success, true);

      const [hostUpdate, joinerUpdate] = await Promise.all([hostP, joinerP]);

      // Both updates should have players addressable by sessionToken
      assert.ok(
        hostUpdate.state.players.find((p) => p.id === hostRes.sessionToken),
        'host update has sessionToken-based ids'
      );
      assert.ok(
        joinerUpdate.state.players.find((p) => p.id === joinRes.sessionToken),
        'joiner update has sessionToken-based ids'
      );
    });

    it('each player\'s stateUpdate hides the other\'s cards', async () => {
      const { client: host, res: hostRes } = await makeRoom('Alice');
      const { client: joiner, res: joinRes } = await joinRoom(
        hostRes.roomCode,
        'Bob'
      );
      await startTwoPlayerGame(host, joiner);

      const hostP = once(host, 'stateUpdate');
      const joinerP = once(joiner, 'stateUpdate');
      await emit(host, 'action', { type: 'endTurn' });

      const [hostUpdate, joinerUpdate] = await Promise.all([hostP, joinerP]);

      // Host sees own cards, not joiner's
      const hostSelf = hostUpdate.state.players.find(
        (p) => p.id === hostRes.sessionToken
      );
      const hostViewBob = hostUpdate.state.players.find(
        (p) => p.id === joinRes.sessionToken
      );
      assert.ok(!hostSelf.demandCards[0].hidden);
      assert.ok(hostViewBob.demandCards[0].hidden);
    });
  });

  // --- Action handler ---

  describe('action handler resolves player by sessionToken', () => {
    it('current player can act', async () => {
      const { client: host, res: hostRes } = await makeRoom('Alice');
      const { client: joiner } = await joinRoom(hostRes.roomCode, 'Bob');
      await startTwoPlayerGame(host, joiner);

      const res = await emit(host, 'action', { type: 'endTurn' });
      assert.equal(res.success, true);
    });

    it('non-current player is rejected', async () => {
      const { client: host, res: hostRes } = await makeRoom('Alice');
      const { client: joiner } = await joinRoom(hostRes.roomCode, 'Bob');
      await startTwoPlayerGame(host, joiner);

      const res = await emit(joiner, 'action', { type: 'endTurn' });
      assert.equal(res.success, false);
      assert.match(res.error, /not your turn/i);
    });

    it('player found even though socket.id differs from player.id', async () => {
      const { client: host, res: hostRes } = await makeRoom('Alice');
      const { client: joiner } = await joinRoom(hostRes.roomCode, 'Bob');
      const [hostGame] = await startTwoPlayerGame(host, joiner);

      // Confirm the mapping works: action succeeds despite id != socket.id
      const alice = hostGame.state.players.find((p) => p.name === 'Alice');
      assert.notEqual(alice.id, host.id, 'precondition: player.id != socket.id');

      const res = await emit(host, 'action', { type: 'endTurn' });
      assert.equal(res.success, true, 'action should succeed via sessionToken lookup');
    });
  });

  // --- getRoomInfo host identification ---

  describe('getRoomInfo uses hostSessionToken', () => {
    it('host player is correctly identified by sessionToken', async () => {
      const { client: host, res: hostRes } = await makeRoom('Alice');
      const updateP = once(host, 'roomUpdate');
      await joinRoom(hostRes.roomCode, 'Bob');
      const info = await updateP;

      const hostPlayer = info.players.find((p) => p.isHost);
      assert.ok(hostPlayer);
      assert.equal(hostPlayer.name, 'Alice');
      assert.equal(hostPlayer.id, hostRes.sessionToken);
    });
  });

  // --- startGame host check ---

  describe('startGame host check via sessionToken', () => {
    it('non-host cannot start the game', async () => {
      const { client: host, res: hostRes } = await makeRoom('Alice');
      const { client: joiner } = await joinRoom(hostRes.roomCode, 'Bob');
      await emit(host, 'selectColor', { color: 'red' });
      await emit(joiner, 'selectColor', { color: 'blue' });

      let started = false;
      joiner.once('gameStart', () => { started = true; });
      joiner.emit('startGame');
      await new Promise((r) => setTimeout(r, 200));
      assert.equal(started, false, 'non-host must not start game');
    });

    it('host can start the game', async () => {
      const { client: host, res: hostRes } = await makeRoom('Alice');
      const { client: joiner } = await joinRoom(hostRes.roomCode, 'Bob');
      const [hostGame] = await startTwoPlayerGame(host, joiner);
      assert.ok(hostGame.state.players.length === 2);
    });
  });

  // --- Consistency ---

  describe('sessionToken consistency across lifecycle', () => {
    it('same token in createRoom callback, roomUpdate, and gameStart', async () => {
      const host = await createClient();

      const updateP = once(host, 'roomUpdate');
      const createRes = await emit(host, 'createRoom', {
        playerName: 'Alice',
        maxPlayers: 2,
        password: null,
      });
      const lobbyInfo = await updateP;

      const { client: joiner } = await joinRoom(createRes.roomCode, 'Bob');
      await emit(host, 'selectColor', { color: 'red' });
      await emit(joiner, 'selectColor', { color: 'blue' });

      const gameP = once(host, 'gameStart');
      host.emit('startGame');
      const gameData = await gameP;

      const lobbyId = lobbyInfo.players.find((p) => p.name === 'Alice').id;
      const gameId = gameData.state.players.find((p) => p.name === 'Alice').id;

      assert.equal(createRes.sessionToken, lobbyId, 'callback == lobby');
      assert.equal(createRes.sessionToken, gameId, 'callback == game');
    });
  });
});
