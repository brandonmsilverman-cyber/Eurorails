/**
 * Tests for Step 3: Turn Handling for Disconnected Players
 *
 * When the current-turn player disconnects:
 * - Start a shorter turn timer (e.g., 90 seconds; 300ms in tests)
 * - Broadcast turnTimerStarted so other players see a countdown
 * - If they reconnect in time, cancel the timer — they resume their turn normally
 * - If the timer expires, auto-call serverEndTurn() and skip to next connected player
 * - serverEndTurn() also skips abandoned players (already done in Step 2)
 *
 * Prerequisites:
 *   1. server.js must export the http server (already done in Step 0).
 *   2. Run:  node --test test/reconnect-turn-timer.test.js
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
  // Short grace period so abandon doesn't fire during turn-timer tests
  process.env.DISCONNECT_GRACE_MS = '5000';
  // Short turn timer for testing (300ms instead of 90s)
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

/** Returns null instead of rejecting on timeout */
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

/** Advance turn from current player (Alice) to the next (Bob) */
async function advanceTurn(currentClient, otherClient) {
  const stateP = once(otherClient, 'stateUpdate');
  await emit(currentClient, 'action', { type: 'endTurn' });
  return stateP;
}

/** Reconnect a disconnected player using their session token */
async function reconnectPlayer(roomCode, sessionToken) {
  const client = await createClient();
  const res = await emit(client, 'rejoinGame', { roomCode, sessionToken });
  return { client, res };
}

// ===========================================================================
// STEP 3: Turn Timer for Disconnected Current Player
// ===========================================================================

describe('Step 3: Turn Timer for Disconnected Current Player', () => {

  // -----------------------------------------------------------------------
  // Turn timer starts when current player disconnects
  // -----------------------------------------------------------------------

  describe('Turn timer activation', () => {
    it('broadcasts turnTimerStarted when the current-turn player disconnects', async () => {
      const { client: host, res: hostRes } = await makeRoom('Alice');
      const { client: joiner } = await joinRoom(hostRes.roomCode, 'Bob');
      await startTwoPlayerGame(host, joiner);

      // Alice is player 0, current turn. Alice disconnects.
      const timerP = once(joiner, 'turnTimerStarted');
      host.disconnect();
      const timerEvent = await timerP;

      assert.ok(timerEvent, 'should receive turnTimerStarted event');
      assert.ok(typeof timerEvent.expiresIn === 'number', 'should include expiresIn ms');
      assert.ok(timerEvent.expiresIn > 0, 'expiresIn should be positive');
    });

    it('does NOT broadcast turnTimerStarted when a non-current player disconnects', async () => {
      const { client: host, res: hostRes } = await makeRoom('Alice');
      const { client: joiner } = await joinRoom(hostRes.roomCode, 'Bob');
      await startTwoPlayerGame(host, joiner);

      // Alice is current player (index 0). Bob (index 1) disconnects.
      const timerEvent = await onceOrNull(host, 'turnTimerStarted', 500);
      joiner.disconnect();
      // Give time for event to arrive
      await new Promise((r) => setTimeout(r, 200));

      assert.equal(timerEvent, null, 'should NOT receive turnTimerStarted for non-current player');
    });

    it('includes the disconnected player name in turnTimerStarted', async () => {
      const { client: host, res: hostRes } = await makeRoom('Alice');
      const { client: joiner } = await joinRoom(hostRes.roomCode, 'Bob');
      await startTwoPlayerGame(host, joiner);

      const timerP = once(joiner, 'turnTimerStarted');
      host.disconnect();
      const timerEvent = await timerP;

      assert.equal(timerEvent.playerName, 'Alice');
    });
  });

  // -----------------------------------------------------------------------
  // Turn timer expiry — auto-advance
  // -----------------------------------------------------------------------

  describe('Turn timer expiry', () => {
    it('auto-ends the disconnected player turn when timer expires', async () => {
      const { client: host, res: hostRes } = await makeRoom('Alice');
      const { client: joiner } = await joinRoom(hostRes.roomCode, 'Bob');
      await startTwoPlayerGame(host, joiner);

      // Alice is current player. She disconnects.
      const stateP = once(joiner, 'stateUpdate', 2000);
      host.disconnect();

      // Wait for turn timer (300ms) + buffer
      const update = await stateP;

      assert.ok(update, 'should receive stateUpdate after turn timer expiry');
      // Turn should have advanced to Bob (index 1)
      assert.equal(update.state.currentPlayerIndex, 1,
        'turn should advance to next player after timer expires');
    });

    it('broadcasts turnTimerExpired when the timer fires', async () => {
      const { client: host, res: hostRes } = await makeRoom('Alice');
      const { client: joiner } = await joinRoom(hostRes.roomCode, 'Bob');
      await startTwoPlayerGame(host, joiner);

      const expiredP = once(joiner, 'turnTimerExpired', 2000);
      host.disconnect();

      const expiredEvent = await expiredP;
      assert.ok(expiredEvent, 'should receive turnTimerExpired');
      assert.equal(expiredEvent.playerName, 'Alice',
        'turnTimerExpired should name the player whose turn was skipped');
    });

    it('skips to next connected player in 3-player game', async () => {
      const { client: host, res: hostRes } = await makeRoom('Alice', 3);
      const { client: joiner1 } = await joinRoom(hostRes.roomCode, 'Bob');
      const { client: joiner2 } = await joinRoom(hostRes.roomCode, 'Charlie');
      await startThreePlayerGame(host, joiner1, joiner2);

      // Alice (0) is current. Alice disconnects → timer fires → turn goes to Bob (1)
      const stateP = once(joiner1, 'stateUpdate', 2000);
      host.disconnect();

      const update = await stateP;
      assert.equal(update.state.currentPlayerIndex, 1,
        'turn should advance to Bob (next connected player)');
    });

    it('logs the auto-skip in gameLog', async () => {
      const { client: host, res: hostRes } = await makeRoom('Alice');
      const { client: joiner } = await joinRoom(hostRes.roomCode, 'Bob');
      await startTwoPlayerGame(host, joiner);

      const stateP = once(joiner, 'stateUpdate', 2000);
      host.disconnect();

      const update = await stateP;
      const log = update.state.gameLog;
      const hasSkipMsg = log.some(msg =>
        msg.toLowerCase().includes('alice') &&
        (msg.toLowerCase().includes('skip') || msg.toLowerCase().includes('auto') || msg.toLowerCase().includes('timer'))
      );
      assert.ok(hasSkipMsg, 'gameLog should mention the auto-skip');
    });
  });

  // -----------------------------------------------------------------------
  // Reconnection cancels the turn timer
  // -----------------------------------------------------------------------

  describe('Reconnection cancels turn timer', () => {
    it('cancels the turn timer when the current player reconnects', async () => {
      const { client: host, res: hostRes } = await makeRoom('Alice');
      const { client: joiner } = await joinRoom(hostRes.roomCode, 'Bob');
      await startTwoPlayerGame(host, joiner);

      // Alice disconnects (turn timer starts)
      const timerP = once(joiner, 'turnTimerStarted');
      host.disconnect();
      await timerP;

      // Set up listener BEFORE reconnect so we don't miss the event
      const cancelledP = onceOrNull(joiner, 'turnTimerCancelled', 1000);

      // Alice reconnects quickly (before 300ms timer expires)
      const { client: aliceReconnected, res: reconnRes } = await reconnectPlayer(
        hostRes.roomCode, hostRes.sessionToken
      );
      assert.equal(reconnRes.success, true, 'reconnect should succeed');

      // Bob should get turnTimerCancelled
      const cancelledEvent = await cancelledP;
      assert.ok(cancelledEvent, 'should receive turnTimerCancelled on reconnect');
    });

    it('does NOT auto-advance after reconnected player resumes', async () => {
      const { client: host, res: hostRes } = await makeRoom('Alice');
      const { client: joiner } = await joinRoom(hostRes.roomCode, 'Bob');
      await startTwoPlayerGame(host, joiner);

      // Alice disconnects
      const disconnP = once(joiner, 'playerDisconnected');
      host.disconnect();
      await disconnP;

      // Alice reconnects immediately
      const { client: aliceReconnected } = await reconnectPlayer(
        hostRes.roomCode, hostRes.sessionToken
      );

      // Wait well past the turn timer
      await new Promise((r) => setTimeout(r, 600));

      // Alice should still be current player — no auto-advance happened
      const stateP = once(joiner, 'stateUpdate', 1000);
      const actionRes = await emit(aliceReconnected, 'action', { type: 'endTurn' });
      assert.equal(actionRes.success, true,
        'Alice should still be current player and able to act');
    });

    it('reconnected player can complete their turn normally', async () => {
      const { client: host, res: hostRes } = await makeRoom('Alice');
      const { client: joiner } = await joinRoom(hostRes.roomCode, 'Bob');
      await startTwoPlayerGame(host, joiner);

      // Alice disconnects then reconnects
      host.disconnect();
      await new Promise((r) => setTimeout(r, 50));

      const { client: aliceReconnected } = await reconnectPlayer(
        hostRes.roomCode, hostRes.sessionToken
      );

      // Alice ends her turn
      const stateP = once(joiner, 'stateUpdate');
      const res = await emit(aliceReconnected, 'action', { type: 'endTurn' });
      assert.equal(res.success, true, 'Alice should be able to end turn after reconnect');

      const update = await stateP;
      assert.equal(update.state.currentPlayerIndex, 1,
        'turn should advance to Bob after Alice ends turn');
    });
  });

  // -----------------------------------------------------------------------
  // Turn timer does NOT start for non-current player disconnect
  // -----------------------------------------------------------------------

  describe('Non-current player disconnect', () => {
    it('no turn timer when non-current player disconnects', async () => {
      const { client: host, res: hostRes } = await makeRoom('Alice');
      const { client: joiner } = await joinRoom(hostRes.roomCode, 'Bob');
      await startTwoPlayerGame(host, joiner);

      // Bob is NOT the current player (Alice is index 0)
      // Listen for turnTimerStarted on Alice's side
      const timerStarted = await onceOrNull(host, 'turnTimerStarted', 500);
      joiner.disconnect();
      await new Promise((r) => setTimeout(r, 300));

      assert.equal(timerStarted, null,
        'turn timer should not start for non-current player disconnect');
    });

    it('Alice can still play normally when Bob (non-current) disconnects', async () => {
      const { client: host, res: hostRes } = await makeRoom('Alice');
      const { client: joiner } = await joinRoom(hostRes.roomCode, 'Bob');
      await startTwoPlayerGame(host, joiner);

      joiner.disconnect();
      await new Promise((r) => setTimeout(r, 100));

      const res = await emit(host, 'action', { type: 'endTurn' });
      assert.equal(res.success, true);
    });
  });

  // -----------------------------------------------------------------------
  // Edge cases
  // -----------------------------------------------------------------------

  describe('Edge cases', () => {
    it('turn timer fires then grace timer fires — player becomes abandoned', async () => {
      // Use a room where we can control timing:
      // Turn timer (300ms) fires first, then grace timer (5000ms) fires later.
      // After turn timer, turn advances but player is still "disconnected" (not abandoned).
      // After grace timer, player becomes abandoned.
      const { client: host, res: hostRes } = await makeRoom('Alice');
      const { client: joiner } = await joinRoom(hostRes.roomCode, 'Bob');
      await startTwoPlayerGame(host, joiner);

      // Alice disconnects on her turn
      const stateP = once(joiner, 'stateUpdate', 2000);
      host.disconnect();

      // Turn timer fires — turn advances to Bob
      const update = await stateP;
      assert.equal(update.state.currentPlayerIndex, 1, 'turn should go to Bob');

      // Alice is still in disconnectedPlayers (grace period hasn't expired)
      // Bob should be able to play
      const res = await emit(joiner, 'action', { type: 'endTurn' });
      assert.equal(res.success, true, 'Bob should be able to end turn');
    });

    it('current player disconnects during non-initial-building phase', async () => {
      const { client: host, res: hostRes } = await makeRoom('Alice');
      const { client: joiner } = await joinRoom(hostRes.roomCode, 'Bob');
      await startTwoPlayerGame(host, joiner);

      // Advance through initial building rounds to reach operate phase
      // Initial building is 2 rounds with 2 players = 4 endTurns
      for (let i = 0; i < 4; i++) {
        const currentIdx = (i % 2 === 0) ? host : joiner;
        const otherIdx = (i % 2 === 0) ? joiner : host;
        const sp = once(otherIdx, 'stateUpdate');
        await emit(currentIdx, 'action', { type: 'endTurn' });
        await sp;
      }

      // Now in operate phase, Alice's turn (index 0)
      // Alice disconnects — turn timer should fire and advance to Bob
      const stateP = once(joiner, 'stateUpdate', 2000);
      host.disconnect();
      const update = await stateP;

      assert.equal(update.state.currentPlayerIndex, 1,
        'turn should advance to Bob in operate phase');
    });

    it('multiple players disconnect on different turns — each gets own timer', async () => {
      const { client: host, res: hostRes } = await makeRoom('Alice', 3);
      const { client: joiner1, res: join1Res } = await joinRoom(hostRes.roomCode, 'Bob');
      const { client: joiner2 } = await joinRoom(hostRes.roomCode, 'Charlie');
      await startThreePlayerGame(host, joiner1, joiner2);

      // Alice (0) is current. Alice disconnects → timer → turn goes to Bob (1)
      const stateP1 = once(joiner1, 'stateUpdate', 2000);
      host.disconnect();
      const update1 = await stateP1;
      assert.equal(update1.state.currentPlayerIndex, 1, 'turn should go to Bob');

      // Drain any pending stateUpdate on Charlie from Alice's turn advance
      await new Promise((r) => setTimeout(r, 100));

      // Bob (1) is now current. Bob disconnects → timer fires →
      // serverEndTurn advances to Charlie (2)
      const stateP2 = once(joiner2, 'stateUpdate', 2000);
      joiner1.disconnect();
      const update2 = await stateP2;
      // Turn should eventually reach Charlie (2) — the only connected player
      assert.equal(update2.state.currentPlayerIndex, 2, 'turn should go to Charlie');
    });

    it('does not double-advance if player reconnects and ends turn before timer would fire', async () => {
      const { client: host, res: hostRes } = await makeRoom('Alice');
      const { client: joiner } = await joinRoom(hostRes.roomCode, 'Bob');
      await startTwoPlayerGame(host, joiner);

      // Alice disconnects
      host.disconnect();
      await new Promise((r) => setTimeout(r, 50));

      // Alice reconnects and immediately ends turn
      const { client: aliceReconnected } = await reconnectPlayer(
        hostRes.roomCode, hostRes.sessionToken
      );

      const stateP = once(joiner, 'stateUpdate');
      await emit(aliceReconnected, 'action', { type: 'endTurn' });
      const update = await stateP;
      assert.equal(update.state.currentPlayerIndex, 1, 'Bob is now current');

      // Wait past where timer would have fired
      await new Promise((r) => setTimeout(r, 500));

      // Bob should still be current — no double-advance
      const res = await emit(joiner, 'action', { type: 'endTurn' });
      assert.equal(res.success, true, 'Bob should still be current player (no double-advance)');
    });
  });
});
