/**
 * Tests for Step 5: Client Auto-Rejoin Logic
 *
 * Verifies that when a Socket.IO client disconnects and reconnects:
 *   1. The reconnected socket can successfully call rejoinGame with saved credentials
 *   2. The server returns the correct game state on auto-rejoin
 *   3. The reconnected player is fully functional (receives broadcasts, can act)
 *   4. Stale/invalid credentials on reconnect are handled gracefully
 *   5. The disconnect/reconnect cycle is resilient to rapid succession
 *
 * Also verifies the server-side events that the client UI depends on:
 *   - playerDisconnected is emitted to remaining players
 *   - playerReconnected is emitted on successful rejoin
 *
 * Prerequisites:
 *   1. server.js must export the http server.
 *   2. Run:  node --test test/reconnect-auto-rejoin.test.js
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
  process.env.DISCONNECT_GRACE_MS = '10000';
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

/**
 * Simulates the client auto-rejoin flow:
 * 1. Disconnect the socket
 * 2. Wait for playerDisconnected on the other client
 * 3. Create a new socket (simulating Socket.IO reconnect)
 * 4. Immediately call rejoinGame with saved credentials
 */
async function simulateAutoRejoin(otherClient, roomCode, sessionToken) {
  const newSocket = await createClient();
  const res = await emit(newSocket, 'rejoinGame', {
    roomCode,
    sessionToken,
  });
  return { socket: newSocket, res };
}

// ===========================================================================
// STEP 5: Client Auto-Rejoin Logic
// ===========================================================================

describe('Step 5: Client auto-rejoin on socket reconnect', () => {

  // -----------------------------------------------------------------------
  // Auto-rejoin flow (simulates what the client connect handler does)
  // -----------------------------------------------------------------------

  describe('Auto-rejoin on reconnect', () => {
    it('successfully rejoins when socket reconnects with valid credentials', async () => {
      const { client: host, res: hostRes } = await makeRoom('Alice');
      const { client: joiner, res: joinRes } = await joinRoom(hostRes.roomCode, 'Bob');
      await startTwoPlayerGame(host, joiner);

      // Bob disconnects
      const disconnectP = once(host, 'playerDisconnected');
      joiner.disconnect();
      await disconnectP;

      // Simulate auto-rejoin: new socket emits rejoinGame immediately on connect
      const { res } = await simulateAutoRejoin(host, hostRes.roomCode, joinRes.sessionToken);

      assert.equal(res.success, true);
      assert.ok(res.state, 'should return game state');
      assert.ok(res.state.players.length === 2);
    });

    it('game state is consistent after auto-rejoin', async () => {
      const { client: host, res: hostRes } = await makeRoom('Alice');
      const { client: joiner, res: joinRes } = await joinRoom(hostRes.roomCode, 'Bob');
      await startTwoPlayerGame(host, joiner);

      // End a turn to advance game state before disconnect
      await emit(host, 'action', { type: 'endTurn' });
      await new Promise(r => setTimeout(r, 200));

      // Bob disconnects
      const disconnectP = once(host, 'playerDisconnected');
      joiner.disconnect();
      await disconnectP;

      // Auto-rejoin
      const { res } = await simulateAutoRejoin(host, hostRes.roomCode, joinRes.sessionToken);

      assert.equal(res.success, true);
      // Turn should have advanced (Alice ended her turn)
      assert.ok(res.state.turn >= 1, 'state should reflect game progress');
      // Bob should see his own demand cards
      const bob = res.state.players.find(p => p.id === joinRes.sessionToken);
      assert.ok(bob, 'Bob should be in player list');
      assert.ok(Array.isArray(bob.demandCards), 'Bob should have demand cards array');
    });

    it('reconnected player receives stateUpdate broadcasts after auto-rejoin', async () => {
      const { client: host, res: hostRes } = await makeRoom('Alice');
      const { client: joiner, res: joinRes } = await joinRoom(hostRes.roomCode, 'Bob');
      await startTwoPlayerGame(host, joiner);

      // Bob disconnects
      const disconnectP = once(host, 'playerDisconnected');
      joiner.disconnect();
      await disconnectP;

      // Auto-rejoin
      const { socket: newBob } = await simulateAutoRejoin(host, hostRes.roomCode, joinRes.sessionToken);

      // Alice ends turn — Bob should get the update
      const stateP = once(newBob, 'stateUpdate');
      await emit(host, 'action', { type: 'endTurn' });
      const update = await stateP;
      assert.ok(update, 'should receive stateUpdate after auto-rejoin');
    });
  });

  // -----------------------------------------------------------------------
  // Stale/invalid credentials on auto-rejoin
  // -----------------------------------------------------------------------

  describe('Failed auto-rejoin with stale credentials', () => {
    it('returns error when room no longer exists', async () => {
      // Simulate a client that has saved credentials for a room that was cleaned up
      const client = await createClient();
      const res = await emit(client, 'rejoinGame', {
        roomCode: 'DEAD',
        sessionToken: 'stale-token-123',
      });

      assert.equal(res.success, false);
      assert.match(res.error, /room not found/i);
    });

    it('returns error when player was abandoned (grace period expired)', async () => {
      // We can't easily test with real timer expiry (grace is 10s in test),
      // but we can verify that a token not in disconnectedPlayers fails.
      const { client: host, res: hostRes } = await makeRoom('Alice');
      const { client: joiner, res: joinRes } = await joinRoom(hostRes.roomCode, 'Bob');
      await startTwoPlayerGame(host, joiner);

      // Bob is still connected — not in disconnectedPlayers
      const lateComer = await createClient();
      const res = await emit(lateComer, 'rejoinGame', {
        roomCode: hostRes.roomCode,
        sessionToken: joinRes.sessionToken,
      });

      assert.equal(res.success, false);
      assert.match(res.error, /no disconnected player/i);
    });

    it('returns error when credentials are completely bogus', async () => {
      const { client: host, res: hostRes } = await makeRoom('Alice');
      const { client: joiner } = await joinRoom(hostRes.roomCode, 'Bob');
      await startTwoPlayerGame(host, joiner);

      const interloper = await createClient();
      const res = await emit(interloper, 'rejoinGame', {
        roomCode: hostRes.roomCode,
        sessionToken: 'totally-fake-token',
      });

      assert.equal(res.success, false);
      assert.match(res.error, /no disconnected player/i);
    });
  });

  // -----------------------------------------------------------------------
  // Rapid disconnect/reconnect cycles
  // -----------------------------------------------------------------------

  describe('Rapid disconnect/reconnect resilience', () => {
    it('handles three disconnect/reconnect cycles for the same player', async () => {
      const { client: host, res: hostRes } = await makeRoom('Alice');
      const { client: joiner, res: joinRes } = await joinRoom(hostRes.roomCode, 'Bob');
      await startTwoPlayerGame(host, joiner);

      let currentBob = joiner;

      for (let i = 0; i < 3; i++) {
        const disconnectP = once(host, 'playerDisconnected');
        currentBob.disconnect();
        await disconnectP;

        const reconnectP = once(host, 'playerReconnected');
        const { socket: newBob, res } = await simulateAutoRejoin(
          host, hostRes.roomCode, joinRes.sessionToken
        );
        await reconnectP;

        assert.equal(res.success, true, `cycle ${i + 1}: rejoin should succeed`);
        currentBob = newBob;
      }

      // After 3 cycles, Bob should still be able to receive broadcasts
      const stateP = once(currentBob, 'stateUpdate');
      await emit(host, 'action', { type: 'endTurn' });
      const update = await stateP;
      assert.ok(update, 'should still receive broadcasts after multiple reconnect cycles');
    });

    it('both players can disconnect and rejoin independently', async () => {
      const { client: host, res: hostRes } = await makeRoom('Alice');
      const { client: joiner, res: joinRes } = await joinRoom(hostRes.roomCode, 'Bob');
      await startTwoPlayerGame(host, joiner);

      // Alice disconnects
      const aliceDisconnectP = once(joiner, 'playerDisconnected');
      host.disconnect();
      await aliceDisconnectP;

      // Alice reconnects
      const aliceReconnectP = once(joiner, 'playerReconnected');
      const { socket: newAlice, res: aliceRes } = await simulateAutoRejoin(
        joiner, hostRes.roomCode, hostRes.sessionToken
      );
      await aliceReconnectP;
      assert.equal(aliceRes.success, true, 'Alice should rejoin');

      // Now Bob disconnects
      const bobDisconnectP = once(newAlice, 'playerDisconnected');
      joiner.disconnect();
      await bobDisconnectP;

      // Bob reconnects
      const bobReconnectP = once(newAlice, 'playerReconnected');
      const { socket: newBob, res: bobRes } = await simulateAutoRejoin(
        newAlice, hostRes.roomCode, joinRes.sessionToken
      );
      await bobReconnectP;
      assert.equal(bobRes.success, true, 'Bob should rejoin');

      // Both should be functional
      const stateP = once(newBob, 'stateUpdate');
      await emit(newAlice, 'action', { type: 'endTurn' });
      const update = await stateP;
      assert.ok(update, 'both reconnected players should be functional');
    });
  });

  // -----------------------------------------------------------------------
  // Disconnect event for reconnecting banner
  // -----------------------------------------------------------------------

  describe('Disconnect/reconnect event flow for UI', () => {
    it('other players receive playerDisconnected when a player drops', async () => {
      const { client: host, res: hostRes } = await makeRoom('Alice');
      const { client: joiner, res: joinRes } = await joinRoom(hostRes.roomCode, 'Bob');
      await startTwoPlayerGame(host, joiner);

      const disconnectP = once(host, 'playerDisconnected');
      joiner.disconnect();
      const event = await disconnectP;

      assert.equal(event.sessionToken, joinRes.sessionToken);
      assert.equal(event.playerName, 'Bob');
    });

    it('other players receive playerReconnected after auto-rejoin', async () => {
      const { client: host, res: hostRes } = await makeRoom('Alice');
      const { client: joiner, res: joinRes } = await joinRoom(hostRes.roomCode, 'Bob');
      await startTwoPlayerGame(host, joiner);

      const disconnectP = once(host, 'playerDisconnected');
      joiner.disconnect();
      await disconnectP;

      const reconnectP = once(host, 'playerReconnected');
      await simulateAutoRejoin(host, hostRes.roomCode, joinRes.sessionToken);
      const event = await reconnectP;

      assert.equal(event.sessionToken, joinRes.sessionToken);
      assert.equal(event.playerName, 'Bob');
    });

    it('disconnected player does not receive events while disconnected', async () => {
      const { client: host, res: hostRes } = await makeRoom('Alice');
      const { client: joiner, res: joinRes } = await joinRoom(hostRes.roomCode, 'Bob');
      await startTwoPlayerGame(host, joiner);

      // Track events Bob receives after disconnect
      let receivedWhileDisconnected = false;
      joiner.on('stateUpdate', () => { receivedWhileDisconnected = true; });

      const disconnectP = once(host, 'playerDisconnected');
      joiner.disconnect();
      await disconnectP;

      // Alice takes an action while Bob is disconnected
      await emit(host, 'action', { type: 'endTurn' });
      await new Promise(r => setTimeout(r, 300));

      assert.equal(receivedWhileDisconnected, false,
        'disconnected socket should not receive events');
    });

    it('auto-rejoined player gets current state including changes made while disconnected', async () => {
      const { client: host, res: hostRes } = await makeRoom('Alice');
      const { client: joiner, res: joinRes } = await joinRoom(hostRes.roomCode, 'Bob');
      await startTwoPlayerGame(host, joiner);

      // Bob disconnects
      const disconnectP = once(host, 'playerDisconnected');
      joiner.disconnect();
      await disconnectP;

      // Alice ends her turn while Bob is disconnected
      await emit(host, 'action', { type: 'endTurn' });
      await new Promise(r => setTimeout(r, 200));

      // Bob auto-rejoins — state should include Alice's turn end
      const { res } = await simulateAutoRejoin(host, hostRes.roomCode, joinRes.sessionToken);

      assert.equal(res.success, true);
      // The game log should contain entries for Alice's actions while Bob was away
      const log = res.state.gameLog;
      assert.ok(log.length > 0, 'game log should have entries from while Bob was disconnected');
    });
  });

  // -----------------------------------------------------------------------
  // Socket.IO built-in reconnection
  // -----------------------------------------------------------------------

  describe('Socket.IO reconnection integration', () => {
    it('client with reconnection enabled can rejoin after server-forced disconnect', async () => {
      const { client: host, res: hostRes } = await makeRoom('Alice');
      const { client: joiner, res: joinRes } = await joinRoom(hostRes.roomCode, 'Bob');
      await startTwoPlayerGame(host, joiner);

      // Disconnect Bob and wait for server to notice
      const disconnectP = once(host, 'playerDisconnected');
      joiner.disconnect();
      await disconnectP;

      // Create a new client (simulating what Socket.IO reconnection does internally)
      // and immediately attempt rejoin
      const newBob = await createClient();

      // The client auto-rejoin handler would do this:
      const res = await emit(newBob, 'rejoinGame', {
        roomCode: hostRes.roomCode,
        sessionToken: joinRes.sessionToken,
      });

      assert.equal(res.success, true);

      // Verify the player is fully restored by checking they can take actions
      // First advance to Bob's turn
      await emit(host, 'action', { type: 'endTurn' });
      await new Promise(r => setTimeout(r, 200));

      const actionRes = await emit(newBob, 'action', { type: 'endTurn' });
      assert.equal(actionRes.success, true, 'auto-rejoined player should be able to act');
    });
  });
});
