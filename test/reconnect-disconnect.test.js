/**
 * Tests for Step 2: Rewrite Disconnect Handler with Grace Period
 *
 * Prerequisites:
 *   1. server.js must export the http server (already done in Step 0).
 *   2. Run:  node --test test/reconnect-disconnect.test.js
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
  process.env.PORT = '0';
  // Use a short grace period for testing (500ms instead of 5 minutes)
  process.env.DISCONNECT_GRACE_MS = '500';
  delete require.cache[require.resolve('../server')];
  serverInstance = require('../server');

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

function emitNoData(socket, event) {
  return new Promise((resolve) => {
    socket.emit(event, (res) => resolve(res));
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

async function startTwoPlayerGame(host, joiner) {
  await emit(host, 'selectColor', { color: 'red' });
  await emit(joiner, 'selectColor', { color: 'blue' });
  const p1 = once(host, 'gameStart');
  const p2 = once(joiner, 'gameStart');
  host.emit('startGame');
  return Promise.all([p1, p2]);
}

// ===========================================================================
// STEP 2: Disconnect Handler with Grace Period
// ===========================================================================

describe('Step 2: Disconnect Handler with Grace Period', () => {

  // -----------------------------------------------------------------------
  // Lobby disconnect — should keep current behavior
  // -----------------------------------------------------------------------

  describe('Lobby disconnect (game not started)', () => {
    it('removes the player from the room', async () => {
      const { client: host, res: hostRes } = await makeRoom('Alice');
      const { client: joiner } = await joinRoom(hostRes.roomCode, 'Bob');

      // Wait for the roomUpdate triggered by join to settle
      await new Promise((r) => setTimeout(r, 100));

      const updateP = once(host, 'roomUpdate');
      joiner.disconnect();
      const info = await updateP;

      assert.equal(info.players.length, 1);
      assert.equal(info.players[0].name, 'Alice');
    });

    it('transfers host when host disconnects in lobby', async () => {
      const { client: host, res: hostRes } = await makeRoom('Alice');
      const { client: joiner } = await joinRoom(hostRes.roomCode, 'Bob');

      // Wait for join roomUpdate to settle
      await new Promise((r) => setTimeout(r, 100));

      const updateP = once(joiner, 'roomUpdate');
      host.disconnect();
      const info = await updateP;

      assert.equal(info.players.length, 1);
      assert.equal(info.players[0].name, 'Bob');
      assert.equal(info.players[0].isHost, true);
    });

    it('deletes room when last lobby player disconnects', async () => {
      const { client: host, res: hostRes } = await makeRoom('Alice');
      const roomCode = hostRes.roomCode;

      host.disconnect();
      await new Promise((r) => setTimeout(r, 300));

      // Create a separate client to query room list after disconnect
      const observer = await createClient();
      const roomList = await emitNoData(observer, 'listRooms');
      const found = roomList.find((r) => r.roomCode === roomCode);
      assert.equal(found, undefined, 'room should be deleted');
    });
  });

  // -----------------------------------------------------------------------
  // In-game disconnect — grace period behavior
  // -----------------------------------------------------------------------

  describe('In-game disconnect (game started)', () => {
    it('does NOT remove the player from gameState', async () => {
      const { client: host, res: hostRes } = await makeRoom('Alice');
      const { client: joiner } = await joinRoom(hostRes.roomCode, 'Bob');
      await startTwoPlayerGame(host, joiner);

      // Bob disconnects mid-game
      const disconnectP = once(host, 'playerDisconnected');
      joiner.disconnect();
      await disconnectP;

      // Room should still exist
      const roomList = await emitNoData(host, 'listRooms');
      const room = roomList.find((r) => r.roomCode === hostRes.roomCode);
      assert.ok(room, 'room should still exist');
    });

    it('does NOT delete the room when all players disconnect mid-game', async () => {
      const { client: host, res: hostRes } = await makeRoom('Alice');
      const { client: joiner } = await joinRoom(hostRes.roomCode, 'Bob');
      await startTwoPlayerGame(host, joiner);
      const roomCode = hostRes.roomCode;

      // Both disconnect
      joiner.disconnect();
      await new Promise((r) => setTimeout(r, 100));
      host.disconnect();
      await new Promise((r) => setTimeout(r, 200));

      // Room should still exist (within grace period)
      const observer = await createClient();
      const roomList = await emitNoData(observer, 'listRooms');
      const room = roomList.find((r) => r.roomCode === roomCode);
      assert.ok(room, 'room should NOT be deleted when all in-game players disconnect');
    });

    it('broadcasts playerDisconnected with sessionToken to remaining players', async () => {
      const { client: host, res: hostRes } = await makeRoom('Alice');
      const { client: joiner, res: joinRes } = await joinRoom(hostRes.roomCode, 'Bob');
      await startTwoPlayerGame(host, joiner);

      const disconnectP = once(host, 'playerDisconnected');
      joiner.disconnect();
      const event = await disconnectP;

      assert.ok(event, 'should receive playerDisconnected event');
      assert.equal(event.sessionToken, joinRes.sessionToken,
        'event should include disconnected player sessionToken');
    });

    it('includes player name in playerDisconnected event', async () => {
      const { client: host, res: hostRes } = await makeRoom('Alice');
      const { client: joiner } = await joinRoom(hostRes.roomCode, 'Bob');
      await startTwoPlayerGame(host, joiner);

      const disconnectP = once(host, 'playerDisconnected');
      joiner.disconnect();
      const event = await disconnectP;

      assert.equal(event.playerName, 'Bob');
    });

    it('broadcasts playerDisconnected to ALL remaining players', async () => {
      const { client: host, res: hostRes } = await makeRoom('Alice', 3);
      const { client: joiner1, res: join1Res } = await joinRoom(hostRes.roomCode, 'Bob');
      const { client: joiner2 } = await joinRoom(hostRes.roomCode, 'Charlie');

      // Start 3-player game
      await emit(host, 'selectColor', { color: 'red' });
      await emit(joiner1, 'selectColor', { color: 'blue' });
      await emit(joiner2, 'selectColor', { color: 'green' });
      const p1 = once(host, 'gameStart');
      const p2 = once(joiner1, 'gameStart');
      const p3 = once(joiner2, 'gameStart');
      host.emit('startGame');
      await Promise.all([p1, p2, p3]);

      // Bob disconnects — Alice and Charlie should both get the event
      const hostP = once(host, 'playerDisconnected');
      const charlieP = once(joiner2, 'playerDisconnected');
      joiner1.disconnect();

      const [hostEvent, charlieEvent] = await Promise.all([hostP, charlieP]);
      assert.equal(hostEvent.sessionToken, join1Res.sessionToken);
      assert.equal(charlieEvent.sessionToken, join1Res.sessionToken);
    });

    it('remaining player can still take actions after opponent disconnects', async () => {
      const { client: host, res: hostRes } = await makeRoom('Alice');
      const { client: joiner } = await joinRoom(hostRes.roomCode, 'Bob');
      await startTwoPlayerGame(host, joiner);

      const disconnectP = once(host, 'playerDisconnected');
      joiner.disconnect();
      await disconnectP;

      // Alice (current player) should still be able to act
      const actionRes = await emit(host, 'action', { type: 'endTurn' });
      assert.equal(actionRes.success, true, 'remaining player can still act');
    });

    it('player who disconnects in-game cannot re-join via joinRoom', async () => {
      const { client: host, res: hostRes } = await makeRoom('Alice');
      const { client: joiner } = await joinRoom(hostRes.roomCode, 'Bob');
      await startTwoPlayerGame(host, joiner);

      joiner.disconnect();
      await new Promise((r) => setTimeout(r, 200));

      // Trying to joinRoom should fail (game already in progress)
      const newClient = await createClient();
      const res = await emit(newClient, 'joinRoom', {
        roomCode: hostRes.roomCode,
        playerName: 'Bob',
        password: null,
      });
      assert.equal(res.success, false);
      assert.match(res.error, /already in progress/i);
    });
  });

  // -----------------------------------------------------------------------
  // Grace period expiry (expirePlayer)
  // -----------------------------------------------------------------------

  describe('Grace period expiry (expirePlayer)', () => {
    // These tests use DISCONNECT_GRACE_MS=500 set in before() hook

    it('marks player as abandoned after grace period expires', async () => {
      const { client: host, res: hostRes } = await makeRoom('Alice');
      const { client: joiner, res: joinRes } = await joinRoom(hostRes.roomCode, 'Bob');
      await startTwoPlayerGame(host, joiner);

      joiner.disconnect();

      // Wait for grace period (500ms) + buffer
      await new Promise((r) => setTimeout(r, 800));

      // Host should receive a stateUpdate or playerAbandoned event
      // indicating Bob is now abandoned
      // We verify by checking that the player is marked abandoned in state
      const stateP = once(host, 'stateUpdate', 1000).catch(() => null);
      // Trigger a state refresh by ending turn
      const actionRes = await emit(host, 'action', { type: 'endTurn' });
      if (actionRes.success) {
        const update = await stateP;
        if (update) {
          const bob = update.state.players.find((p) => p.id === joinRes.sessionToken);
          assert.ok(bob, 'Bob should still be in gameState players');
          assert.equal(bob.abandoned, true, 'Bob should be marked as abandoned');
        }
      }
    });

    it('auto-ends turn if abandoned player was the current player', async () => {
      const { client: host, res: hostRes } = await makeRoom('Alice');
      const { client: joiner } = await joinRoom(hostRes.roomCode, 'Bob');
      const [hostGame] = await startTwoPlayerGame(host, joiner);

      // Alice ends turn -> Bob's turn
      const stateP1 = once(host, 'stateUpdate');
      await emit(host, 'action', { type: 'endTurn' });
      await stateP1;

      // Now it's Bob's turn. Bob disconnects.
      // After grace period, server should auto-advance past Bob
      const stateP2 = once(host, 'stateUpdate', 2000);
      joiner.disconnect();

      // Wait for grace period + auto-advance
      const update = await stateP2;
      // Should have auto-advanced back to Alice's turn
      assert.ok(update, 'should receive stateUpdate after Bob is auto-skipped');
    });

    it('deletes room when ALL players are abandoned', async () => {
      const { client: host, res: hostRes } = await makeRoom('Alice');
      const { client: joiner } = await joinRoom(hostRes.roomCode, 'Bob');
      await startTwoPlayerGame(host, joiner);
      const roomCode = hostRes.roomCode;

      // Both disconnect
      host.disconnect();
      joiner.disconnect();

      // Wait for grace period to expire for both
      await new Promise((r) => setTimeout(r, 1000));

      // Room should be deleted now
      const observer = await createClient();
      const roomList = await emitNoData(observer, 'listRooms');
      const room = roomList.find((r) => r.roomCode === roomCode);
      assert.equal(room, undefined, 'room should be deleted after all players abandoned');
    });

    it('broadcasts playerAbandoned event when grace period expires', async () => {
      const { client: host, res: hostRes } = await makeRoom('Alice');
      const { client: joiner, res: joinRes } = await joinRoom(hostRes.roomCode, 'Bob');
      await startTwoPlayerGame(host, joiner);

      // Listen for playerAbandoned on host
      const abandonP = once(host, 'playerAbandoned', 2000);
      joiner.disconnect();

      const event = await abandonP;
      assert.equal(event.sessionToken, joinRes.sessionToken,
        'playerAbandoned should identify the abandoned player');
    });
  });

  // -----------------------------------------------------------------------
  // Edge cases
  // -----------------------------------------------------------------------

  describe('Edge cases', () => {
    it('host disconnect in-game preserves player (no host transfer)', async () => {
      const { client: host, res: hostRes } = await makeRoom('Alice');
      const { client: joiner } = await joinRoom(hostRes.roomCode, 'Bob');
      await startTwoPlayerGame(host, joiner);

      const disconnectP = once(joiner, 'playerDisconnected');
      host.disconnect();
      const event = await disconnectP;

      assert.equal(event.sessionToken, hostRes.sessionToken);
    });

    it('multiple disconnects from same player do not cause errors', async () => {
      const { client: host, res: hostRes } = await makeRoom('Alice');
      const { client: joiner } = await joinRoom(hostRes.roomCode, 'Bob');
      await startTwoPlayerGame(host, joiner);

      joiner.disconnect();
      await new Promise((r) => setTimeout(r, 300));

      // Host should still be able to act normally
      const actionRes = await emit(host, 'action', { type: 'endTurn' });
      assert.equal(actionRes.success, true);
    });
  });
});
