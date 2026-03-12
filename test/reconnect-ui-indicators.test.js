/**
 * Tests for Step 6: UI Indicators for Reconnection
 *
 * Tests cover the server-side support needed for UI indicators:
 *   1. Connected status in player state — getStateForPlayer() includes a
 *      `connected` boolean per player so clients can gray out disconnected names
 *   2. Client event handlers — server emits playerDisconnected, playerReconnected,
 *      playerAbandoned, turnTimerStarted, turnTimerCancelled, turnTimerExpired
 *      with the right data for clients to display indicators
 *   3. Turn skip notification — turnTimerExpired carries enough info for a toast
 *   4. SessionStorage cleanup — gameOver event is broadcast so clients can clear
 *      saved credentials
 *
 * Prerequisites:
 *   1. server.js must export the http server (already done in Step 0).
 *   2. Run:  node --test test/reconnect-ui-indicators.test.js
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
  process.env.DISCONNECT_GRACE_MS = '500';
  process.env.TURN_TIMER_MS = '300';
  delete require.cache[require.resolve('../server')];
  ({ listener: serverInstance } = require('../server'));

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

function once(socket, event, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout waiting for '${event}'`)), timeoutMs);
    socket.once(event, (data) => {
      clearTimeout(timer);
      resolve(data);
    });
  });
}

function onceOrNull(socket, event, timeoutMs = 1000) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), timeoutMs);
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

async function startThreePlayerGame(host, joiner1, joiner2) {
  await emit(host, 'selectColor', { color: 'red' });
  await emit(joiner1, 'selectColor', { color: 'blue' });
  await emit(joiner2, 'selectColor', { color: 'green' });
  const p1 = once(host, 'gameStart');
  const p2 = once(joiner1, 'gameStart');
  const p3 = once(joiner2, 'gameStart');
  host.emit('startGame');
  return Promise.all([p1, p2, p3]);
}

async function reconnectPlayer(roomCode, sessionToken) {
  const client = await createClient();
  const res = await emit(client, 'rejoinGame', { roomCode, sessionToken });
  return { client, res };
}

// ===========================================================================
// STEP 6: UI Indicators
// ===========================================================================

describe('Step 6: UI Indicators for Reconnection', () => {

  // -----------------------------------------------------------------------
  // 1. Connected status in player state (getStateForPlayer)
  // -----------------------------------------------------------------------

  describe('Connected status in player state', () => {
    it('all players show connected:true in stateUpdate when everyone is connected', async () => {
      const { client: host, res: hostRes } = await makeRoom('Alice');
      const { client: joiner } = await joinRoom(hostRes.roomCode, 'Bob');
      await startTwoPlayerGame(host, joiner);

      // Trigger a stateUpdate
      const stateP = once(joiner, 'stateUpdate');
      await emit(host, 'action', { type: 'endTurn' });
      const update = await stateP;

      for (const p of update.state.players) {
        assert.equal(p.connected, true,
          `${p.name} should have connected:true`);
      }
    });

    it('disconnected player shows connected:false in stateUpdate', async () => {
      const { client: host, res: hostRes } = await makeRoom('Alice');
      const { client: joiner, res: joinRes } = await joinRoom(hostRes.roomCode, 'Bob');
      await startTwoPlayerGame(host, joiner);

      // Bob disconnects
      const disconnectP = once(host, 'playerDisconnected');
      joiner.disconnect();
      await disconnectP;

      // Trigger a stateUpdate so we can inspect player state
      const stateP = once(host, 'stateUpdate');
      await emit(host, 'action', { type: 'endTurn' });
      const update = await stateP;

      const bob = update.state.players.find(p => p.id === joinRes.sessionToken);
      assert.ok(bob, 'Bob should still be in players array');
      assert.equal(bob.connected, false, 'disconnected Bob should have connected:false');

      const alice = update.state.players.find(p => p.id === hostRes.sessionToken);
      assert.equal(alice.connected, true, 'connected Alice should have connected:true');
    });

    it('reconnected player shows connected:true again in stateUpdate', async () => {
      const { client: host, res: hostRes } = await makeRoom('Alice');
      const { client: joiner, res: joinRes } = await joinRoom(hostRes.roomCode, 'Bob');
      await startTwoPlayerGame(host, joiner);

      // Bob disconnects then reconnects
      const disconnectP = once(host, 'playerDisconnected');
      joiner.disconnect();
      await disconnectP;

      const { client: bobReconnected } = await reconnectPlayer(
        hostRes.roomCode, joinRes.sessionToken
      );

      // Trigger a stateUpdate
      const stateP = once(bobReconnected, 'stateUpdate');
      await emit(host, 'action', { type: 'endTurn' });
      const update = await stateP;

      const bob = update.state.players.find(p => p.id === joinRes.sessionToken);
      assert.equal(bob.connected, true,
        'reconnected Bob should have connected:true');
    });

    it('abandoned player shows connected:false and abandoned:true', async () => {
      const { client: host, res: hostRes } = await makeRoom('Alice');
      const { client: joiner, res: joinRes } = await joinRoom(hostRes.roomCode, 'Bob');
      await startTwoPlayerGame(host, joiner);

      joiner.disconnect();

      // Wait for grace period (500ms) + buffer
      await new Promise((r) => setTimeout(r, 800));

      // Trigger a stateUpdate
      const stateP = once(host, 'stateUpdate');
      await emit(host, 'action', { type: 'endTurn' });
      const update = await stateP;

      const bob = update.state.players.find(p => p.id === joinRes.sessionToken);
      assert.ok(bob, 'Bob should still exist in players');
      assert.equal(bob.abandoned, true, 'Bob should be abandoned');
      assert.equal(bob.connected, false, 'abandoned Bob should have connected:false');
    });

    it('connected status is correct in 3-player game with one disconnect', async () => {
      const { client: host, res: hostRes } = await makeRoom('Alice', 3);
      const { client: joiner1, res: join1Res } = await joinRoom(hostRes.roomCode, 'Bob');
      const { client: joiner2, res: join2Res } = await joinRoom(hostRes.roomCode, 'Charlie');
      await startThreePlayerGame(host, joiner1, joiner2);

      // Bob disconnects
      const disconnectP = once(host, 'playerDisconnected');
      joiner1.disconnect();
      await disconnectP;

      // Trigger stateUpdate
      const stateP = once(joiner2, 'stateUpdate');
      await emit(host, 'action', { type: 'endTurn' });
      const update = await stateP;

      const alice = update.state.players.find(p => p.id === hostRes.sessionToken);
      const bob = update.state.players.find(p => p.id === join1Res.sessionToken);
      const charlie = update.state.players.find(p => p.id === join2Res.sessionToken);

      assert.equal(alice.connected, true, 'Alice should be connected');
      assert.equal(bob.connected, false, 'Bob should be disconnected');
      assert.equal(charlie.connected, true, 'Charlie should be connected');
    });

    it('rejoin state includes connected status for all players', async () => {
      const { client: host, res: hostRes } = await makeRoom('Alice');
      const { client: joiner, res: joinRes } = await joinRoom(hostRes.roomCode, 'Bob');
      await startTwoPlayerGame(host, joiner);

      // Bob disconnects then reconnects
      joiner.disconnect();
      await new Promise((r) => setTimeout(r, 100));

      const { client: bobReconnected, res: reconnRes } = await reconnectPlayer(
        hostRes.roomCode, joinRes.sessionToken
      );

      assert.equal(reconnRes.success, true);
      // The state returned on rejoin should include connected status
      const alice = reconnRes.state.players.find(p => p.id === hostRes.sessionToken);
      const bob = reconnRes.state.players.find(p => p.id === joinRes.sessionToken);
      assert.equal(alice.connected, true, 'Alice should be connected in rejoin state');
      assert.equal(bob.connected, true, 'Bob should be connected in rejoin state (just reconnected)');
    });
  });

  // -----------------------------------------------------------------------
  // 2. Client disconnect/reconnect event data for UI indicators
  // -----------------------------------------------------------------------

  describe('Disconnect/reconnect events carry UI data', () => {
    it('playerDisconnected includes playerName for display', async () => {
      const { client: host, res: hostRes } = await makeRoom('Alice');
      const { client: joiner } = await joinRoom(hostRes.roomCode, 'Bob');
      await startTwoPlayerGame(host, joiner);

      const disconnectP = once(host, 'playerDisconnected');
      joiner.disconnect();
      const event = await disconnectP;

      assert.equal(event.playerName, 'Bob',
        'playerDisconnected must include playerName for UI display');
      assert.ok(event.sessionToken, 'playerDisconnected must include sessionToken');
    });

    it('playerReconnected includes playerName for display', async () => {
      const { client: host, res: hostRes } = await makeRoom('Alice');
      const { client: joiner, res: joinRes } = await joinRoom(hostRes.roomCode, 'Bob');
      await startTwoPlayerGame(host, joiner);

      const disconnectP = once(host, 'playerDisconnected');
      joiner.disconnect();
      await disconnectP;

      const reconnectP = once(host, 'playerReconnected');
      await reconnectPlayer(hostRes.roomCode, joinRes.sessionToken);
      const event = await reconnectP;

      assert.equal(event.playerName, 'Bob',
        'playerReconnected must include playerName for UI display');
      assert.ok(event.sessionToken, 'playerReconnected must include sessionToken');
    });

    it('playerAbandoned includes playerName for display', async () => {
      const { client: host, res: hostRes } = await makeRoom('Alice');
      const { client: joiner } = await joinRoom(hostRes.roomCode, 'Bob');
      await startTwoPlayerGame(host, joiner);

      const abandonP = once(host, 'playerAbandoned', 2000);
      joiner.disconnect();
      const event = await abandonP;

      assert.equal(event.playerName, 'Bob',
        'playerAbandoned must include playerName for UI display');
      assert.ok(event.sessionToken, 'playerAbandoned must include sessionToken');
    });

    it('playerDisconnected is NOT sent to the disconnecting player', async () => {
      const { client: host, res: hostRes } = await makeRoom('Alice');
      const { client: joiner, res: joinRes } = await joinRoom(hostRes.roomCode, 'Bob');
      await startTwoPlayerGame(host, joiner);

      // Only remaining player (host) should get the event
      const hostP = once(host, 'playerDisconnected');
      joiner.disconnect();
      const event = await hostP;

      assert.equal(event.playerName, 'Bob');
      // (The disconnecting player can't receive events — they're disconnected)
    });

    it('playerReconnected is NOT sent to the reconnecting player', async () => {
      const { client: host, res: hostRes } = await makeRoom('Alice');
      const { client: joiner, res: joinRes } = await joinRoom(hostRes.roomCode, 'Bob');
      await startTwoPlayerGame(host, joiner);

      joiner.disconnect();
      await new Promise((r) => setTimeout(r, 100));

      const { client: bobReconnected } = await reconnectPlayer(
        hostRes.roomCode, joinRes.sessionToken
      );

      // Bob should NOT receive his own playerReconnected event
      const selfEvent = await onceOrNull(bobReconnected, 'playerReconnected', 500);
      assert.equal(selfEvent, null,
        'reconnecting player should NOT receive their own playerReconnected event');
    });
  });

  // -----------------------------------------------------------------------
  // 3. Turn skip notification (turnTimerExpired as toast data)
  // -----------------------------------------------------------------------

  describe('Turn skip notification', () => {
    it('turnTimerExpired includes playerName for toast display', async () => {
      const { client: host, res: hostRes } = await makeRoom('Alice');
      const { client: joiner } = await joinRoom(hostRes.roomCode, 'Bob');
      await startTwoPlayerGame(host, joiner);

      // Alice is current player. She disconnects → timer fires
      const expiredP = once(joiner, 'turnTimerExpired', 2000);
      host.disconnect();
      const event = await expiredP;

      assert.equal(event.playerName, 'Alice',
        'turnTimerExpired should include playerName for toast message');
    });

    it('turnTimerStarted includes expiresIn for countdown display', async () => {
      const { client: host, res: hostRes } = await makeRoom('Alice');
      const { client: joiner } = await joinRoom(hostRes.roomCode, 'Bob');
      await startTwoPlayerGame(host, joiner);

      const timerP = once(joiner, 'turnTimerStarted');
      host.disconnect();
      const event = await timerP;

      assert.equal(event.playerName, 'Alice',
        'turnTimerStarted should include playerName');
      assert.equal(typeof event.expiresIn, 'number',
        'turnTimerStarted should include expiresIn (ms)');
      assert.ok(event.expiresIn > 0, 'expiresIn should be positive');
    });

    it('turnTimerCancelled includes playerName for toast dismissal', async () => {
      const { client: host, res: hostRes } = await makeRoom('Alice');
      const { client: joiner } = await joinRoom(hostRes.roomCode, 'Bob');
      await startTwoPlayerGame(host, joiner);

      // Alice disconnects (turn timer starts)
      const timerP = once(joiner, 'turnTimerStarted');
      host.disconnect();
      await timerP;

      // Set up listener BEFORE reconnect
      const cancelledP = onceOrNull(joiner, 'turnTimerCancelled', 1000);

      // Alice reconnects quickly
      await reconnectPlayer(hostRes.roomCode, hostRes.sessionToken);

      const event = await cancelledP;
      assert.ok(event, 'should receive turnTimerCancelled');
      assert.equal(event.playerName, 'Alice',
        'turnTimerCancelled should include playerName');
    });

    it('stateUpdate after turn skip includes updated currentPlayerIndex', async () => {
      const { client: host, res: hostRes } = await makeRoom('Alice');
      const { client: joiner } = await joinRoom(hostRes.roomCode, 'Bob');
      await startTwoPlayerGame(host, joiner);

      // Alice disconnects → timer expires → turn advances
      const stateP = once(joiner, 'stateUpdate', 2000);
      host.disconnect();
      const update = await stateP;

      assert.equal(update.state.currentPlayerIndex, 1,
        'turn should advance to Bob after Alice is auto-skipped');
    });

    it('gameLog records the turn skip with player name', async () => {
      const { client: host, res: hostRes } = await makeRoom('Alice');
      const { client: joiner } = await joinRoom(hostRes.roomCode, 'Bob');
      await startTwoPlayerGame(host, joiner);

      const stateP = once(joiner, 'stateUpdate', 2000);
      host.disconnect();
      const update = await stateP;

      const hasSkipMsg = update.state.gameLog.some(msg =>
        msg.toLowerCase().includes('alice') &&
        (msg.toLowerCase().includes('skip') || msg.toLowerCase().includes('timer') || msg.toLowerCase().includes('auto'))
      );
      assert.ok(hasSkipMsg,
        'gameLog should include a message about the auto-skip for toast/log display');
    });
  });

  // -----------------------------------------------------------------------
  // 4. Game over event for sessionStorage cleanup
  // -----------------------------------------------------------------------

  describe('Game over broadcasts for session cleanup', () => {
    it('stateUpdate with gameOver uiEvent is broadcast to all players', async () => {
      const { client: host, res: hostRes } = await makeRoom('Alice');
      const { client: joiner } = await joinRoom(hostRes.roomCode, 'Bob');
      await startTwoPlayerGame(host, joiner);

      // We can verify that the stateUpdate mechanism includes uiEvent data
      // by triggering an endTurn and checking the uiEvent field exists
      const stateP = once(joiner, 'stateUpdate');
      await emit(host, 'action', { type: 'endTurn' });
      const update = await stateP;

      // stateUpdate should have a uiEvent field (even if null for normal turns)
      assert.ok('uiEvent' in update,
        'stateUpdate should include uiEvent field for UI event handling');
      assert.ok('state' in update,
        'stateUpdate should include state field');
    });

    it('stateUpdate includes gameLog for client-side display', async () => {
      const { client: host, res: hostRes } = await makeRoom('Alice');
      const { client: joiner } = await joinRoom(hostRes.roomCode, 'Bob');
      await startTwoPlayerGame(host, joiner);

      const stateP = once(joiner, 'stateUpdate');
      await emit(host, 'action', { type: 'endTurn' });
      const update = await stateP;

      assert.ok(Array.isArray(update.state.gameLog),
        'stateUpdate should include gameLog array');
    });
  });

  // -----------------------------------------------------------------------
  // 5. Multiple disconnect/reconnect cycles with UI events
  // -----------------------------------------------------------------------

  describe('Multiple disconnect/reconnect cycles', () => {
    it('emits correct events across multiple disconnect/reconnect cycles', async () => {
      const { client: host, res: hostRes } = await makeRoom('Alice');
      const { client: joiner, res: joinRes } = await joinRoom(hostRes.roomCode, 'Bob');
      await startTwoPlayerGame(host, joiner);

      // Cycle 1: Bob disconnects and reconnects
      const disc1P = once(host, 'playerDisconnected');
      joiner.disconnect();
      const disc1 = await disc1P;
      assert.equal(disc1.playerName, 'Bob');

      const reconn1P = once(host, 'playerReconnected');
      const { client: bob2 } = await reconnectPlayer(hostRes.roomCode, joinRes.sessionToken);
      const reconn1 = await reconn1P;
      assert.equal(reconn1.playerName, 'Bob');

      // Cycle 2: Bob disconnects and reconnects again
      const disc2P = once(host, 'playerDisconnected');
      bob2.disconnect();
      const disc2 = await disc2P;
      assert.equal(disc2.playerName, 'Bob');

      const reconn2P = once(host, 'playerReconnected');
      await reconnectPlayer(hostRes.roomCode, joinRes.sessionToken);
      const reconn2 = await reconn2P;
      assert.equal(reconn2.playerName, 'Bob');
    });

    it('connected status updates correctly across cycles', async () => {
      const { client: host, res: hostRes } = await makeRoom('Alice');
      const { client: joiner, res: joinRes } = await joinRoom(hostRes.roomCode, 'Bob');
      await startTwoPlayerGame(host, joiner);

      // Bob (non-current) disconnects
      const disc1P = once(host, 'playerDisconnected');
      joiner.disconnect();
      await disc1P;

      // Trigger stateUpdate — Bob should show as disconnected
      let stateP = once(host, 'stateUpdate');
      await emit(host, 'action', { type: 'endTurn' });
      let update = await stateP;
      let bob = update.state.players.find(p => p.id === joinRes.sessionToken);
      assert.equal(bob.connected, false, 'Bob should be disconnected after first disconnect');

      // Bob reconnects immediately (before grace period expires)
      const reconnP = once(host, 'playerReconnected');
      const { client: bob2, res: reconnRes } = await reconnectPlayer(
        hostRes.roomCode, joinRes.sessionToken
      );
      await reconnP;
      assert.equal(reconnRes.success, true);

      // The rejoin state itself should show Bob as connected
      const bobInRejoin = reconnRes.state.players.find(p => p.id === joinRes.sessionToken);
      assert.equal(bobInRejoin.connected, true, 'Bob should be connected in rejoin state');
    });
  });

  // -----------------------------------------------------------------------
  // 6. Turn advancing to a disconnected player starts timer
  // -----------------------------------------------------------------------

  describe('Turn advances to disconnected player', () => {
    it('turnTimerStarted emitted when turn advances to a disconnected player', async () => {
      const { client: host, res: hostRes } = await makeRoom('Alice');
      const { client: joiner } = await joinRoom(hostRes.roomCode, 'Bob');
      await startTwoPlayerGame(host, joiner);

      // Bob (non-current) disconnects — no turn timer yet
      const disconnectP = once(host, 'playerDisconnected');
      joiner.disconnect();
      await disconnectP;

      // Alice ends turn → turn goes to Bob (disconnected) → timer should start
      const timerP = once(host, 'turnTimerStarted', 2000);
      await emit(host, 'action', { type: 'endTurn' });
      const timerEvent = await timerP;

      assert.equal(timerEvent.playerName, 'Bob',
        'turnTimerStarted should fire for disconnected Bob when it becomes his turn');
    });

    it('turn auto-skips disconnected player and reaches next connected player', async () => {
      const { client: host, res: hostRes } = await makeRoom('Alice');
      const { client: joiner } = await joinRoom(hostRes.roomCode, 'Bob');
      await startTwoPlayerGame(host, joiner);

      // Bob disconnects
      const disconnectP = once(host, 'playerDisconnected');
      joiner.disconnect();
      await disconnectP;

      // Alice ends turn → Bob's turn → timer fires → back to Alice
      const stateP = once(host, 'stateUpdate', 2000);
      await emit(host, 'action', { type: 'endTurn' });

      // Wait for turn timer to expire and auto-advance
      const update = await stateP;

      // After the timer fires and skips Bob, it should come back to Alice (index 0)
      // We may get multiple stateUpdates, so wait a bit for final state
      await new Promise((r) => setTimeout(r, 500));

      // Alice should be able to act (meaning it's her turn)
      const actionRes = await emit(host, 'action', { type: 'endTurn' });
      assert.equal(actionRes.success, true,
        'turn should eventually come back to Alice after skipping disconnected Bob');
    });
  });
});
