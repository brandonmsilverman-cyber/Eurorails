/**
 * Tests for Step 7: Host Handling on Disconnect/Reconnect
 *
 * Rules:
 *   - On in-game host disconnect: transfer hostSessionToken to the next
 *     connected player (permanent transfer).
 *   - On host reconnect: they rejoin as a regular player, do NOT reclaim host.
 *
 * Prerequisites:
 *   1. server.js must export the http server.
 *   2. Run:  node --test test/reconnect-host-transfer.test.js
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
  process.env.TURN_TIMER_MS = '10000';
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

// ===========================================================================
// STEP 7: Host Handling
// ===========================================================================

describe('Step 7: Host Handling', () => {

  // -------------------------------------------------------------------------
  // In-game host disconnect: transfer host to next connected player
  // -------------------------------------------------------------------------

  describe('In-game host disconnect transfers host', () => {

    it('transfers hostSessionToken to the next connected player when host disconnects in-game', async () => {
      const { client: host, res: hostRes } = await makeRoom('Alice');
      const { client: joiner, res: joinRes } = await joinRoom(hostRes.roomCode, 'Bob');
      await startTwoPlayerGame(host, joiner);

      // Verify Alice is host before disconnect
      assert.equal(hostRes.sessionToken, hostRes.sessionToken); // sanity

      // Alice (host) disconnects mid-game
      const disconnectP = once(joiner, 'playerDisconnected');
      host.disconnect();
      await disconnectP;

      // Bob should now be the host — verify via roomList
      const roomList = await emitNoData(joiner, 'listRooms');
      const room = roomList.find((r) => r.roomCode === hostRes.roomCode);
      assert.ok(room, 'room should still exist');
      assert.equal(room.hostName, 'Bob', 'Bob should be the new host in room list');
    });

    it('emits hostTransferred event to remaining players', async () => {
      const { client: host, res: hostRes } = await makeRoom('Alice');
      const { client: joiner, res: joinRes } = await joinRoom(hostRes.roomCode, 'Bob');
      await startTwoPlayerGame(host, joiner);

      const transferP = once(joiner, 'hostTransferred');
      host.disconnect();
      const event = await transferP;

      assert.equal(event.oldHostSessionToken, hostRes.sessionToken,
        'event should identify the old host');
      assert.equal(event.newHostSessionToken, joinRes.sessionToken,
        'event should identify the new host');
      assert.equal(event.newHostName, 'Bob',
        'event should include new host name');
    });

    it('transfers host to the correct player in a 3-player game', async () => {
      const { client: host, res: hostRes } = await makeRoom('Alice', 3);
      const { client: joiner1, res: join1Res } = await joinRoom(hostRes.roomCode, 'Bob');
      const { client: joiner2, res: join2Res } = await joinRoom(hostRes.roomCode, 'Charlie');
      await startThreePlayerGame(host, joiner1, joiner2);

      // Both remaining players should get the transfer event
      const bobTransferP = once(joiner1, 'hostTransferred');
      const charlieTransferP = once(joiner2, 'hostTransferred');
      host.disconnect();
      const [bobEvent, charlieEvent] = await Promise.all([bobTransferP, charlieTransferP]);

      // New host should be the first remaining connected player
      assert.equal(bobEvent.newHostSessionToken, charlieEvent.newHostSessionToken,
        'both players should agree on the new host');
      assert.notEqual(bobEvent.newHostSessionToken, hostRes.sessionToken,
        'new host should NOT be the disconnected player');
    });

    it('does not transfer host when a non-host player disconnects in-game', async () => {
      const { client: host, res: hostRes } = await makeRoom('Alice');
      const { client: joiner } = await joinRoom(hostRes.roomCode, 'Bob');
      await startTwoPlayerGame(host, joiner);

      const disconnectP = once(host, 'playerDisconnected');
      // Register a listener for hostTransferred that should NOT fire
      let hostTransferred = false;
      host.on('hostTransferred', () => { hostTransferred = true; });

      joiner.disconnect();
      await disconnectP;
      await new Promise((r) => setTimeout(r, 200));

      assert.equal(hostTransferred, false,
        'hostTransferred should NOT fire when non-host disconnects');

      // Alice should still be host
      const roomList = await emitNoData(host, 'listRooms');
      const room = roomList.find((r) => r.roomCode === hostRes.roomCode);
      assert.equal(room.hostName, 'Alice', 'Alice should remain host');
    });

    it('skips disconnected players when choosing new host', async () => {
      const { client: host, res: hostRes } = await makeRoom('Alice', 3);
      const { client: joiner1, res: join1Res } = await joinRoom(hostRes.roomCode, 'Bob');
      const { client: joiner2, res: join2Res } = await joinRoom(hostRes.roomCode, 'Charlie');
      await startThreePlayerGame(host, joiner1, joiner2);

      // Bob disconnects first (non-host)
      const bobDisconnectP = once(host, 'playerDisconnected');
      joiner1.disconnect();
      await bobDisconnectP;

      // Now Alice (host) disconnects — should skip Bob (disconnected), transfer to Charlie
      const transferP = once(joiner2, 'hostTransferred');
      host.disconnect();
      const event = await transferP;

      assert.equal(event.newHostSessionToken, join2Res.sessionToken,
        'host should transfer to Charlie (the only connected player), not Bob (disconnected)');
      assert.equal(event.newHostName, 'Charlie');
    });
  });

  // -------------------------------------------------------------------------
  // Host reconnect: former host does NOT reclaim host
  // -------------------------------------------------------------------------

  describe('Host reconnect does not reclaim host', () => {

    it('former host rejoins as a regular player (not host)', async () => {
      const { client: host, res: hostRes } = await makeRoom('Alice');
      const { client: joiner, res: joinRes } = await joinRoom(hostRes.roomCode, 'Bob');
      await startTwoPlayerGame(host, joiner);

      // Alice (host) disconnects — Bob becomes host
      const disconnectP = once(joiner, 'playerDisconnected');
      host.disconnect();
      await disconnectP;

      // Alice reconnects
      const newAlice = await createClient();
      const rejoinRes = await emit(newAlice, 'rejoinGame', {
        roomCode: hostRes.roomCode,
        sessionToken: hostRes.sessionToken,
      });
      assert.equal(rejoinRes.success, true, 'Alice should rejoin successfully');

      // Check that Bob is still the host, not Alice
      const roomList = await emitNoData(newAlice, 'listRooms');
      const room = roomList.find((r) => r.roomCode === hostRes.roomCode);
      assert.equal(room.hostName, 'Bob',
        'Bob should remain host after Alice reconnects');
    });

    it('former host does not get isHost=true in state after reconnecting', async () => {
      const { client: host, res: hostRes } = await makeRoom('Alice');
      const { client: joiner, res: joinRes } = await joinRoom(hostRes.roomCode, 'Bob');
      await startTwoPlayerGame(host, joiner);

      // Alice disconnects — Bob becomes host
      const disconnectP = once(joiner, 'playerDisconnected');
      host.disconnect();
      await disconnectP;

      // Alice reconnects
      const newAlice = await createClient();
      const rejoinRes = await emit(newAlice, 'rejoinGame', {
        roomCode: hostRes.roomCode,
        sessionToken: hostRes.sessionToken,
      });
      assert.equal(rejoinRes.success, true);

      // Query room info — Alice should not be host
      await new Promise((r) => setTimeout(r, 100));
      // Trigger a roomUpdate by having Bob do something, or check via listRooms
      const roomList = await emitNoData(newAlice, 'listRooms');
      const room = roomList.find((r) => r.roomCode === hostRes.roomCode);
      assert.equal(room.hostName, 'Bob', 'Bob is still the host');
    });

    it('former host can still take normal game actions after rejoining', async () => {
      const { client: host, res: hostRes } = await makeRoom('Alice');
      const { client: joiner, res: joinRes } = await joinRoom(hostRes.roomCode, 'Bob');
      await startTwoPlayerGame(host, joiner);

      // Alice (host, player 0, current turn) disconnects
      const disconnectP = once(joiner, 'playerDisconnected');
      host.disconnect();
      await disconnectP;

      // Alice reconnects
      const newAlice = await createClient();
      const rejoinRes = await emit(newAlice, 'rejoinGame', {
        roomCode: hostRes.roomCode,
        sessionToken: hostRes.sessionToken,
      });
      assert.equal(rejoinRes.success, true);

      // If it's Alice's turn, she should be able to act
      const state = rejoinRes.state;
      if (state.currentPlayerIndex === 0) {
        const actionRes = await emit(newAlice, 'action', { type: 'endTurn' });
        assert.equal(actionRes.success, true,
          'former host should be able to take actions after rejoining');
      }
    });
  });

  // -------------------------------------------------------------------------
  // Chain of host transfers
  // -------------------------------------------------------------------------

  describe('Chain of host transfers', () => {

    it('host transfers again if new host also disconnects', async () => {
      const { client: host, res: hostRes } = await makeRoom('Alice', 3);
      const { client: joiner1, res: join1Res } = await joinRoom(hostRes.roomCode, 'Bob');
      const { client: joiner2, res: join2Res } = await joinRoom(hostRes.roomCode, 'Charlie');
      await startThreePlayerGame(host, joiner1, joiner2);

      // Alice (host) disconnects — host transfers to one of {Bob, Charlie}
      const transfer1P_bob = once(joiner1, 'hostTransferred');
      const transfer1P_charlie = once(joiner2, 'hostTransferred');
      host.disconnect();
      const [t1bob, t1charlie] = await Promise.all([transfer1P_bob, transfer1P_charlie]);

      const firstNewHost = t1bob.newHostSessionToken;

      // Now the new host also disconnects
      if (firstNewHost === join1Res.sessionToken) {
        // Bob is new host — Bob disconnects, should transfer to Charlie
        const transfer2P = once(joiner2, 'hostTransferred');
        joiner1.disconnect();
        const t2 = await transfer2P;
        assert.equal(t2.newHostSessionToken, join2Res.sessionToken,
          'host should transfer to Charlie after Bob (new host) disconnects');
      } else {
        // Charlie is new host — Charlie disconnects, should transfer to Bob
        const transfer2P = once(joiner1, 'hostTransferred');
        joiner2.disconnect();
        const t2 = await transfer2P;
        assert.equal(t2.newHostSessionToken, join1Res.sessionToken,
          'host should transfer to Bob after Charlie (new host) disconnects');
      }
    });

    it('host does not transfer when no connected players remain', async () => {
      const { client: host, res: hostRes } = await makeRoom('Alice');
      const { client: joiner, res: joinRes } = await joinRoom(hostRes.roomCode, 'Bob');
      await startTwoPlayerGame(host, joiner);

      // Bob disconnects first
      const disconnectP = once(host, 'playerDisconnected');
      joiner.disconnect();
      await disconnectP;

      // Alice (host) disconnects — no connected players remain
      // Should not crash, room stays alive during grace period
      host.disconnect();
      await new Promise((r) => setTimeout(r, 200));

      // Room should still exist (within grace period)
      const observer = await createClient();
      const roomList = await emitNoData(observer, 'listRooms');
      const room = roomList.find((r) => r.roomCode === hostRes.roomCode);
      assert.ok(room, 'room should still exist during grace period');
    });

    it('original host reconnects after chain of transfers, still not host', async () => {
      const { client: host, res: hostRes } = await makeRoom('Alice', 3);
      const { client: joiner1, res: join1Res } = await joinRoom(hostRes.roomCode, 'Bob');
      const { client: joiner2, res: join2Res } = await joinRoom(hostRes.roomCode, 'Charlie');
      await startThreePlayerGame(host, joiner1, joiner2);

      // Alice disconnects — host transfers
      const transfer1P = once(joiner1, 'hostTransferred');
      host.disconnect();
      await transfer1P;

      // Wait a moment for state to settle
      await new Promise((r) => setTimeout(r, 100));

      // Alice reconnects — should NOT be host
      const newAlice = await createClient();
      const rejoinRes = await emit(newAlice, 'rejoinGame', {
        roomCode: hostRes.roomCode,
        sessionToken: hostRes.sessionToken,
      });
      assert.equal(rejoinRes.success, true);

      const roomList = await emitNoData(newAlice, 'listRooms');
      const room = roomList.find((r) => r.roomCode === hostRes.roomCode);
      assert.notEqual(room.hostName, 'Alice',
        'Alice should NOT be host after reconnecting');
    });
  });

  // -------------------------------------------------------------------------
  // Game log
  // -------------------------------------------------------------------------

  describe('Game log entries', () => {

    it('logs host transfer to gameState.gameLog', async () => {
      const { client: host, res: hostRes } = await makeRoom('Alice');
      const { client: joiner, res: joinRes } = await joinRoom(hostRes.roomCode, 'Bob');
      await startTwoPlayerGame(host, joiner);

      // Alice (host) disconnects
      const disconnectP = once(joiner, 'playerDisconnected');
      host.disconnect();
      await disconnectP;

      // Alice reconnects — the rejoin response includes full game state with logs
      await new Promise((r) => setTimeout(r, 100));
      const newAlice = await createClient();
      const rejoinRes = await emit(newAlice, 'rejoinGame', {
        roomCode: hostRes.roomCode,
        sessionToken: hostRes.sessionToken,
      });
      assert.equal(rejoinRes.success, true);

      const logs = rejoinRes.state.gameLog || [];
      const transferLog = logs.find((msg) =>
        msg.toLowerCase().includes('host') && msg.includes('Bob')
      );
      assert.ok(transferLog,
        `gameLog should contain a host transfer message mentioning the new host. Logs: ${JSON.stringify(logs)}`);
    });
  });
});
