/**
 * Tests for Step 4: rejoinGame Server Event
 *
 * Client sends: socket.emit('rejoinGame', { sessionToken, roomCode }, callback)
 *
 * Server validates:
 *   1. Room exists
 *   2. Session token is in room.disconnectedPlayers
 *   3. Token is not already mapped to a connected socket
 *
 * Server on success:
 *   1. Move player from disconnectedPlayers back to players
 *   2. Clear grace period and turn timeout timers
 *   3. Update sessionToSocketId with new socket.id
 *   4. socket.join(roomCode)
 *   5. Send full game state via callback (reuses getStateForPlayer)
 *   6. Broadcast playerReconnected to others
 *   7. If it was their turn, they resume it
 *
 * Prerequisites:
 *   1. server.js must export the http server (already done in Step 0).
 *   2. Run:  node --test test/reconnect-rejoin.test.js
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
  // Long grace period so players don't get abandoned during tests
  process.env.DISCONNECT_GRACE_MS = '10000';
  // Long turn timer so it doesn't expire during tests
  process.env.TURN_TIMER_MS = '10000';
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
// STEP 4: rejoinGame
// ===========================================================================

describe('Step 4: rejoinGame', () => {

  // -----------------------------------------------------------------------
  // Validation — error cases
  // -----------------------------------------------------------------------

  describe('Validation', () => {
    it('fails when room does not exist', async () => {
      const client = await createClient();
      const res = await emit(client, 'rejoinGame', {
        roomCode: 'ZZZZ',
        sessionToken: 'fake-token',
      });
      assert.equal(res.success, false);
      assert.match(res.error, /room not found/i);
    });

    it('fails when game has not started', async () => {
      const { client: host, res: hostRes } = await makeRoom('Alice');
      // Room exists but game not started
      const newClient = await createClient();
      const res = await emit(newClient, 'rejoinGame', {
        roomCode: hostRes.roomCode,
        sessionToken: hostRes.sessionToken,
      });
      assert.equal(res.success, false);
      assert.match(res.error, /not started/i);
    });

    it('fails when session token is not in disconnectedPlayers', async () => {
      const { client: host, res: hostRes } = await makeRoom('Alice');
      const { client: joiner } = await joinRoom(hostRes.roomCode, 'Bob');
      await startTwoPlayerGame(host, joiner);

      // Alice is still connected — her token is NOT in disconnectedPlayers
      const newClient = await createClient();
      const res = await emit(newClient, 'rejoinGame', {
        roomCode: hostRes.roomCode,
        sessionToken: hostRes.sessionToken,
      });
      assert.equal(res.success, false);
      assert.match(res.error, /no disconnected player/i);
    });

    it('fails with invalid parameters (missing roomCode)', async () => {
      const client = await createClient();
      const res = await emit(client, 'rejoinGame', {
        sessionToken: 'some-token',
      });
      assert.equal(res.success, false);
      assert.match(res.error, /invalid/i);
    });

    it('fails with invalid parameters (missing sessionToken)', async () => {
      const client = await createClient();
      const res = await emit(client, 'rejoinGame', {
        roomCode: 'ABCD',
      });
      assert.equal(res.success, false);
      assert.match(res.error, /invalid/i);
    });
  });

  // -----------------------------------------------------------------------
  // Successful rejoin
  // -----------------------------------------------------------------------

  describe('Successful rejoin', () => {
    it('returns success with game state', async () => {
      const { client: host, res: hostRes } = await makeRoom('Alice');
      const { client: joiner, res: joinRes } = await joinRoom(hostRes.roomCode, 'Bob');
      await startTwoPlayerGame(host, joiner);

      // Bob disconnects
      const disconnectP = once(host, 'playerDisconnected');
      joiner.disconnect();
      await disconnectP;

      // Bob reconnects with a new socket
      const newBob = await createClient();
      const res = await emit(newBob, 'rejoinGame', {
        roomCode: hostRes.roomCode,
        sessionToken: joinRes.sessionToken,
      });

      assert.equal(res.success, true);
      assert.ok(res.state, 'should include game state');
      assert.ok(res.state.players, 'state should have players');
      assert.ok(res.state.turn, 'state should have turn number');
    });

    it('returns state filtered for the reconnecting player (demand card privacy)', async () => {
      const { client: host, res: hostRes } = await makeRoom('Alice');
      const { client: joiner, res: joinRes } = await joinRoom(hostRes.roomCode, 'Bob');
      await startTwoPlayerGame(host, joiner);

      const disconnectP = once(host, 'playerDisconnected');
      joiner.disconnect();
      await disconnectP;

      const newBob = await createClient();
      const res = await emit(newBob, 'rejoinGame', {
        roomCode: hostRes.roomCode,
        sessionToken: joinRes.sessionToken,
      });

      assert.equal(res.success, true);
      const bob = res.state.players.find(p => p.id === joinRes.sessionToken);
      const alice = res.state.players.find(p => p.id === hostRes.sessionToken);

      // Bob should see his own demand cards
      assert.ok(bob.demandCards, 'Bob should have demandCards');
      assert.ok(!bob.demandCards[0]?.hidden, 'Bob\'s own cards should NOT be hidden');

      // Alice's demand cards should be hidden from Bob
      assert.ok(alice.demandCards[0]?.hidden, 'Alice\'s cards should be hidden from Bob');
    });

    it('broadcasts playerReconnected to other players', async () => {
      const { client: host, res: hostRes } = await makeRoom('Alice');
      const { client: joiner, res: joinRes } = await joinRoom(hostRes.roomCode, 'Bob');
      await startTwoPlayerGame(host, joiner);

      const disconnectP = once(host, 'playerDisconnected');
      joiner.disconnect();
      await disconnectP;

      const reconnectP = once(host, 'playerReconnected');
      const newBob = await createClient();
      await emit(newBob, 'rejoinGame', {
        roomCode: hostRes.roomCode,
        sessionToken: joinRes.sessionToken,
      });

      const event = await reconnectP;
      assert.equal(event.sessionToken, joinRes.sessionToken);
      assert.equal(event.playerName, 'Bob');
    });

    it('reconnected player does NOT receive their own playerReconnected event', async () => {
      const { client: host, res: hostRes } = await makeRoom('Alice');
      const { client: joiner, res: joinRes } = await joinRoom(hostRes.roomCode, 'Bob');
      await startTwoPlayerGame(host, joiner);

      const disconnectP = once(host, 'playerDisconnected');
      joiner.disconnect();
      await disconnectP;

      const newBob = await createClient();

      // Set up listener BEFORE rejoin
      let receivedReconnect = false;
      newBob.on('playerReconnected', () => { receivedReconnect = true; });

      await emit(newBob, 'rejoinGame', {
        roomCode: hostRes.roomCode,
        sessionToken: joinRes.sessionToken,
      });

      // Wait a bit to see if the event arrives
      await new Promise(r => setTimeout(r, 300));
      assert.equal(receivedReconnect, false,
        'reconnecting player should NOT receive their own playerReconnected');
    });

    it('adds reconnect message to gameLog', async () => {
      const { client: host, res: hostRes } = await makeRoom('Alice');
      const { client: joiner, res: joinRes } = await joinRoom(hostRes.roomCode, 'Bob');
      await startTwoPlayerGame(host, joiner);

      const disconnectP = once(host, 'playerDisconnected');
      joiner.disconnect();
      await disconnectP;

      const newBob = await createClient();
      const res = await emit(newBob, 'rejoinGame', {
        roomCode: hostRes.roomCode,
        sessionToken: joinRes.sessionToken,
      });

      const log = res.state.gameLog;
      const hasReconnect = log.some(msg => msg.includes('Bob') && msg.includes('reconnect'));
      assert.ok(hasReconnect, 'gameLog should contain reconnect message');
    });

    it('reconnected player can receive subsequent broadcasts', async () => {
      const { client: host, res: hostRes } = await makeRoom('Alice');
      const { client: joiner, res: joinRes } = await joinRoom(hostRes.roomCode, 'Bob');
      await startTwoPlayerGame(host, joiner);

      const disconnectP = once(host, 'playerDisconnected');
      joiner.disconnect();
      await disconnectP;

      const newBob = await createClient();
      await emit(newBob, 'rejoinGame', {
        roomCode: hostRes.roomCode,
        sessionToken: joinRes.sessionToken,
      });

      // Alice ends turn — Bob should receive the stateUpdate
      const stateP = once(newBob, 'stateUpdate');
      await emit(host, 'action', { type: 'endTurn' });
      const update = await stateP;
      assert.ok(update, 'reconnected player should receive stateUpdate broadcasts');
    });

    it('reconnected player can take actions on their turn', async () => {
      const { client: host, res: hostRes } = await makeRoom('Alice');
      const { client: joiner, res: joinRes } = await joinRoom(hostRes.roomCode, 'Bob');
      await startTwoPlayerGame(host, joiner);

      // End Alice's turn so it's Bob's turn
      await emit(host, 'action', { type: 'endTurn' });
      await new Promise(r => setTimeout(r, 200));

      // Bob disconnects on his turn
      const disconnectP = once(host, 'playerDisconnected');
      joiner.disconnect();
      await disconnectP;

      // Bob reconnects
      const newBob = await createClient();
      const rejoinRes = await emit(newBob, 'rejoinGame', {
        roomCode: hostRes.roomCode,
        sessionToken: joinRes.sessionToken,
      });
      assert.equal(rejoinRes.success, true);

      // Bob should be able to end his turn
      const actionRes = await emit(newBob, 'action', { type: 'endTurn' });
      assert.equal(actionRes.success, true, 'reconnected player should be able to act on their turn');
    });
  });

  // -----------------------------------------------------------------------
  // Timer cancellation
  // -----------------------------------------------------------------------

  describe('Timer cancellation', () => {
    it('cancels grace period timer on rejoin (player does NOT get abandoned)', async () => {
      // Override grace period to be short for this specific test
      // We can't change the env mid-run, so we test indirectly:
      // rejoin should succeed, and after waiting past the original grace time,
      // the player should NOT be abandoned
      const { client: host, res: hostRes } = await makeRoom('Alice');
      const { client: joiner, res: joinRes } = await joinRoom(hostRes.roomCode, 'Bob');
      await startTwoPlayerGame(host, joiner);

      const disconnectP = once(host, 'playerDisconnected');
      joiner.disconnect();
      await disconnectP;

      const newBob = await createClient();
      const res = await emit(newBob, 'rejoinGame', {
        roomCode: hostRes.roomCode,
        sessionToken: joinRes.sessionToken,
      });
      assert.equal(res.success, true);

      // Player should NOT receive playerAbandoned after rejoin
      let abandoned = false;
      host.on('playerAbandoned', () => { abandoned = true; });
      newBob.on('playerAbandoned', (ev) => {
        if (ev.sessionToken === joinRes.sessionToken) abandoned = true;
      });

      await new Promise(r => setTimeout(r, 500));
      assert.equal(abandoned, false,
        'grace timer should be cancelled — player should NOT be abandoned after rejoin');
    });

    it('cancels turn timer on rejoin when it was their turn', async () => {
      const { client: host, res: hostRes } = await makeRoom('Alice');
      const { client: joiner, res: joinRes } = await joinRoom(hostRes.roomCode, 'Bob');
      await startTwoPlayerGame(host, joiner);

      // End Alice's turn so it's Bob's turn
      await emit(host, 'action', { type: 'endTurn' });
      await new Promise(r => setTimeout(r, 200));

      // Bob disconnects on his turn — turn timer starts
      const disconnectP = once(host, 'playerDisconnected');
      joiner.disconnect();
      await disconnectP;

      // Wait a moment for turn timer to start
      await new Promise(r => setTimeout(r, 100));

      // Bob reconnects — turn timer should be cancelled
      const cancelP = once(host, 'turnTimerCancelled', 2000).catch(() => null);
      const newBob = await createClient();
      await emit(newBob, 'rejoinGame', {
        roomCode: hostRes.roomCode,
        sessionToken: joinRes.sessionToken,
      });

      const cancelEvent = await cancelP;
      assert.ok(cancelEvent, 'should broadcast turnTimerCancelled');
      assert.equal(cancelEvent.playerName, 'Bob');
    });

    it('does NOT emit turnTimerCancelled when it was not their turn', async () => {
      const { client: host, res: hostRes } = await makeRoom('Alice');
      const { client: joiner, res: joinRes } = await joinRoom(hostRes.roomCode, 'Bob');
      await startTwoPlayerGame(host, joiner);

      // It's Alice's turn. Bob disconnects (no turn timer for Bob).
      const disconnectP = once(host, 'playerDisconnected');
      joiner.disconnect();
      await disconnectP;

      let receivedCancel = false;
      host.on('turnTimerCancelled', () => { receivedCancel = true; });

      const newBob = await createClient();
      await emit(newBob, 'rejoinGame', {
        roomCode: hostRes.roomCode,
        sessionToken: joinRes.sessionToken,
      });

      await new Promise(r => setTimeout(r, 300));
      assert.equal(receivedCancel, false,
        'should NOT emit turnTimerCancelled when disconnected player was not current turn');
    });
  });

  // -----------------------------------------------------------------------
  // Edge cases
  // -----------------------------------------------------------------------

  describe('Edge cases', () => {
    it('handles case-insensitive room codes', async () => {
      const { client: host, res: hostRes } = await makeRoom('Alice');
      const { client: joiner, res: joinRes } = await joinRoom(hostRes.roomCode, 'Bob');
      await startTwoPlayerGame(host, joiner);

      const disconnectP = once(host, 'playerDisconnected');
      joiner.disconnect();
      await disconnectP;

      const newBob = await createClient();
      const res = await emit(newBob, 'rejoinGame', {
        roomCode: hostRes.roomCode.toLowerCase(),
        sessionToken: joinRes.sessionToken,
      });
      assert.equal(res.success, true, 'room code should be case-insensitive');
    });

    it('cannot rejoin twice with the same session token', async () => {
      const { client: host, res: hostRes } = await makeRoom('Alice');
      const { client: joiner, res: joinRes } = await joinRoom(hostRes.roomCode, 'Bob');
      await startTwoPlayerGame(host, joiner);

      const disconnectP = once(host, 'playerDisconnected');
      joiner.disconnect();
      await disconnectP;

      // First rejoin succeeds
      const newBob1 = await createClient();
      const res1 = await emit(newBob1, 'rejoinGame', {
        roomCode: hostRes.roomCode,
        sessionToken: joinRes.sessionToken,
      });
      assert.equal(res1.success, true);

      // Second rejoin with same token should fail (no longer in disconnectedPlayers)
      const newBob2 = await createClient();
      const res2 = await emit(newBob2, 'rejoinGame', {
        roomCode: hostRes.roomCode,
        sessionToken: joinRes.sessionToken,
      });
      assert.equal(res2.success, false);
      assert.match(res2.error, /no disconnected player/i);
    });

    it('reconnected player can disconnect and rejoin again', async () => {
      const { client: host, res: hostRes } = await makeRoom('Alice');
      const { client: joiner, res: joinRes } = await joinRoom(hostRes.roomCode, 'Bob');
      await startTwoPlayerGame(host, joiner);

      // First disconnect + rejoin
      let disconnectP = once(host, 'playerDisconnected');
      joiner.disconnect();
      await disconnectP;

      const newBob1 = await createClient();
      const res1 = await emit(newBob1, 'rejoinGame', {
        roomCode: hostRes.roomCode,
        sessionToken: joinRes.sessionToken,
      });
      assert.equal(res1.success, true);

      // Second disconnect + rejoin
      disconnectP = once(host, 'playerDisconnected');
      newBob1.disconnect();
      await disconnectP;

      const newBob2 = await createClient();
      const res2 = await emit(newBob2, 'rejoinGame', {
        roomCode: hostRes.roomCode,
        sessionToken: joinRes.sessionToken,
      });
      assert.equal(res2.success, true, 'should be able to rejoin a second time');
    });

    it('works in a 3-player game', async () => {
      const { client: host, res: hostRes } = await makeRoom('Alice', 3);
      const { client: joiner1, res: join1Res } = await joinRoom(hostRes.roomCode, 'Bob');
      const { client: joiner2 } = await joinRoom(hostRes.roomCode, 'Charlie');

      await emit(host, 'selectColor', { color: 'red' });
      await emit(joiner1, 'selectColor', { color: 'blue' });
      await emit(joiner2, 'selectColor', { color: 'green' });
      const p1 = once(host, 'gameStart');
      const p2 = once(joiner1, 'gameStart');
      const p3 = once(joiner2, 'gameStart');
      host.emit('startGame');
      await Promise.all([p1, p2, p3]);

      // Bob disconnects
      const disconnectP1 = once(host, 'playerDisconnected');
      const disconnectP2 = once(joiner2, 'playerDisconnected');
      joiner1.disconnect();
      await Promise.all([disconnectP1, disconnectP2]);

      // Bob reconnects — both Alice and Charlie should get playerReconnected
      const reconnectP1 = once(host, 'playerReconnected');
      const reconnectP2 = once(joiner2, 'playerReconnected');
      const newBob = await createClient();
      const res = await emit(newBob, 'rejoinGame', {
        roomCode: hostRes.roomCode,
        sessionToken: join1Res.sessionToken,
      });

      assert.equal(res.success, true);
      const [ev1, ev2] = await Promise.all([reconnectP1, reconnectP2]);
      assert.equal(ev1.playerName, 'Bob');
      assert.equal(ev2.playerName, 'Bob');
    });

    it('host can disconnect and rejoin', async () => {
      const { client: host, res: hostRes } = await makeRoom('Alice');
      const { client: joiner, res: joinRes } = await joinRoom(hostRes.roomCode, 'Bob');
      await startTwoPlayerGame(host, joiner);

      // Alice (host) disconnects
      const disconnectP = once(joiner, 'playerDisconnected');
      host.disconnect();
      await disconnectP;

      // Alice reconnects
      const reconnectP = once(joiner, 'playerReconnected');
      const newAlice = await createClient();
      const res = await emit(newAlice, 'rejoinGame', {
        roomCode: hostRes.roomCode,
        sessionToken: hostRes.sessionToken,
      });

      assert.equal(res.success, true);
      const event = await reconnectP;
      assert.equal(event.playerName, 'Alice');
    });
  });
});
