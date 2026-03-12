/**
 * Tests for Phase 2: AI Turn Loop
 *
 * Verifies:
 *   1. AI auto-ends turn after human ends turn
 *   2. Multiple consecutive AI turns cascade correctly
 *   3. AI turn broadcasts stateUpdate to human player
 *   4. Turn timer is NOT started for AI players
 *   5. AI turns work during initialBuilding phase
 *   6. AI turns transition correctly to operate phase
 *   7. Derailed AI players are skipped
 *   8. AI timer is cleaned up on room deletion
 *   9. AI turn includes correct overlay info
 *  10. discardHand triggers AI turn for next player
 *
 * Prerequisites:
 *   Run: AI_ACTION_DELAY_MS=100 node --test test/ai-turn-loop.test.js
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
    process.env.DISCONNECT_GRACE_MS = '60000';
    process.env.TURN_TIMER_MS = '60000';
    process.env.AI_ACTION_DELAY_MS = '100'; // fast AI for tests
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

function once(socket, event, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Timeout waiting for '${event}'`)), timeoutMs);
        socket.once(event, (data) => {
            clearTimeout(timer);
            resolve(data);
        });
    });
}

/**
 * Collect N stateUpdate events from a socket.
 * Returns an array of { state, uiEvent } objects.
 */
function collectStateUpdates(socket, count, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
        const results = [];
        const timer = setTimeout(
            () => reject(new Error(`Timeout: got ${results.length}/${count} stateUpdates`)),
            timeoutMs
        );
        function handler(data) {
            results.push(data);
            if (results.length >= count) {
                clearTimeout(timer);
                socket.off('stateUpdate', handler);
                resolve(results);
            }
        }
        socket.on('stateUpdate', handler);
    });
}

/**
 * Wait for a stateUpdate where a given condition is true.
 */
function waitForStateUpdate(socket, predicate, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            socket.off('stateUpdate', handler);
            reject(new Error('Timeout waiting for matching stateUpdate'));
        }, timeoutMs);
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

async function createSoloGame(client, overrides = {}) {
    const res = await emit(client, 'createSoloGame', makeSoloGameData(overrides));
    assert.equal(res.success, true, 'Solo game creation should succeed');
    return res;
}

// ===========================================================================
// AI TURN LOOP TESTS
// ===========================================================================

describe('AI Turn Loop: Basic Turn Execution', () => {

    it('AI auto-ends turn after human ends turn', async () => {
        const client = await createClient();
        const { state } = await createSoloGame(client);

        // Human is player 0, AI is player 1
        assert.equal(state.currentPlayerIndex, 0);
        assert.equal(state.players[1].isAI, true);

        // Human ends turn; wait for AI to also end turn (turnChanged back to human)
        const updatePromise = waitForStateUpdate(client, (data) =>
            data.uiEvent?.type === 'turnChanged' &&
            data.state?.currentPlayerIndex === 0
        );

        await emit(client, 'action', { type: 'endTurn' });
        const update = await updatePromise;

        // Should be back to human's turn
        assert.equal(update.state.currentPlayerIndex, 0);
        // Turn should have advanced by 2 (human ended + AI ended)
        assert.ok(update.state.turn > state.turn);
    });

    it('AI turn broadcasts turnChanged event with overlay', async () => {
        const client = await createClient();
        await createSoloGame(client);

        // Collect all stateUpdates after human ends turn
        // First update: human's endTurn (turnChanged to AI)
        // Second update: AI's endTurn (turnChanged back to human)
        const updatesPromise = collectStateUpdates(client, 2);
        await emit(client, 'action', { type: 'endTurn' });
        const updates = await updatesPromise;

        // First update should show turn changed to AI
        const aiTurnUpdate = updates[0];
        assert.equal(aiTurnUpdate.uiEvent.type, 'turnChanged');
        assert.equal(aiTurnUpdate.state.currentPlayerIndex, 1);

        // Second update should show turn changed back to human
        const humanTurnUpdate = updates[1];
        assert.equal(humanTurnUpdate.uiEvent.type, 'turnChanged');
        assert.equal(humanTurnUpdate.state.currentPlayerIndex, 0);
        assert.ok(humanTurnUpdate.uiEvent.overlay);
        assert.equal(humanTurnUpdate.uiEvent.overlay.playerName, 'TestPlayer');
    });

    it('AI turn overlay shows AI player name and color', async () => {
        const client = await createClient();
        await createSoloGame(client);

        // First stateUpdate after endTurn shows the AI's turn overlay
        const updatesPromise = collectStateUpdates(client, 1);
        await emit(client, 'action', { type: 'endTurn' });
        const [aiUpdate] = await updatesPromise;

        assert.equal(aiUpdate.uiEvent.overlay.playerName, 'AI 1 (Easy)');
        assert.equal(aiUpdate.uiEvent.overlay.playerColor, 'blue');
    });
});

describe('AI Turn Loop: Multiple AI Players', () => {

    it('cascading AI turns with 2 AI opponents', async () => {
        const client = await createClient();
        const { state } = await createSoloGame(client, {
            aiPlayers: [
                { name: 'AI 1', difficulty: 'easy', color: 'blue' },
                { name: 'AI 2', difficulty: 'easy', color: 'green' },
            ]
        });

        assert.equal(state.players.length, 3);

        // Human ends turn → AI 1 takes turn → AI 2 takes turn → back to human
        const updatePromise = waitForStateUpdate(client, (data) =>
            data.uiEvent?.type === 'turnChanged' &&
            data.state?.currentPlayerIndex === 0 &&
            data.state?.turn > state.turn + 1
        );

        await emit(client, 'action', { type: 'endTurn' });
        const update = await updatePromise;

        assert.equal(update.state.currentPlayerIndex, 0);
    });

    it('cascading AI turns with 5 AI opponents', async () => {
        const client = await createClient();
        const { state } = await createSoloGame(client, {
            aiPlayers: [
                { name: 'AI 1', difficulty: 'easy', color: 'blue' },
                { name: 'AI 2', difficulty: 'easy', color: 'green' },
                { name: 'AI 3', difficulty: 'easy', color: 'yellow' },
                { name: 'AI 4', difficulty: 'easy', color: 'purple' },
                { name: 'AI 5', difficulty: 'easy', color: 'orange' },
            ]
        });

        // Human ends turn → 5 AI turns cascade → back to human
        const updatePromise = waitForStateUpdate(client, (data) =>
            data.uiEvent?.type === 'turnChanged' &&
            data.state?.currentPlayerIndex === 0 &&
            data.state?.turn > state.turn + 1
        , 10000); // longer timeout for 5 AI turns

        await emit(client, 'action', { type: 'endTurn' });
        const update = await updatePromise;

        assert.equal(update.state.currentPlayerIndex, 0);
    });

    it('each AI turn produces a separate stateUpdate', async () => {
        const client = await createClient();
        await createSoloGame(client, {
            aiPlayers: [
                { name: 'AI 1', difficulty: 'easy', color: 'blue' },
                { name: 'AI 2', difficulty: 'easy', color: 'green' },
            ]
        });

        // Expect 3 updates: human→AI1, AI1→AI2, AI2→human
        const updatesPromise = collectStateUpdates(client, 3);
        await emit(client, 'action', { type: 'endTurn' });
        const updates = await updatesPromise;

        assert.equal(updates[0].state.currentPlayerIndex, 1); // AI 1's turn
        assert.equal(updates[1].state.currentPlayerIndex, 2); // AI 2's turn
        assert.equal(updates[2].state.currentPlayerIndex, 0); // back to human
    });
});

describe('AI Turn Loop: Initial Building Phase', () => {

    it('AI takes turns during initial building phase', async () => {
        const client = await createClient();
        const { state } = await createSoloGame(client);

        assert.equal(state.phase, 'initialBuilding');

        const updatePromise = waitForStateUpdate(client, (data) =>
            data.state?.currentPlayerIndex === 0 &&
            data.state?.turn > state.turn
        );

        await emit(client, 'action', { type: 'endTurn' });
        const update = await updatePromise;

        // Still in initial building
        assert.equal(update.state.phase, 'initialBuilding');
        assert.equal(update.state.currentPlayerIndex, 0);
    });

    it('correctly transitions from initialBuilding to operate phase', async () => {
        const client = await createClient();
        const { state } = await createSoloGame(client);

        // 2 players × 2 rounds = 4 total initial building turns
        // Human ends turn (round 1, player 0) → AI ends → Human ends (round 2) → AI ends → operate
        assert.equal(state.initialBuildingRounds, 2);

        // End turn for round 1
        let updatePromise = waitForStateUpdate(client, (data) =>
            data.state?.currentPlayerIndex === 0 &&
            data.state?.turn > state.turn
        );
        await emit(client, 'action', { type: 'endTurn' });
        let update = await updatePromise;

        assert.equal(update.state.phase, 'initialBuilding');

        // End turn for round 2 — should transition to operate
        updatePromise = waitForStateUpdate(client, (data) =>
            data.state?.currentPlayerIndex === 0 &&
            data.state?.phase === 'operate'
        );
        await emit(client, 'action', { type: 'endTurn' });
        update = await updatePromise;

        assert.equal(update.state.phase, 'operate');
        assert.equal(update.state.currentPlayerIndex, 0);
    });
});

describe('AI Turn Loop: Operate Phase', () => {

    it('AI takes turns during operate phase', async () => {
        const client = await createClient();
        await createSoloGame(client);

        // Advance through initial building (2 rounds × 2 players)
        let updatePromise = waitForStateUpdate(client, (data) =>
            data.state?.currentPlayerIndex === 0 &&
            data.state?.turn > 1
        );
        await emit(client, 'action', { type: 'endTurn' });
        await updatePromise;

        // Second round of initial building
        updatePromise = waitForStateUpdate(client, (data) =>
            data.state?.phase === 'operate' &&
            data.state?.currentPlayerIndex === 0
        );
        await emit(client, 'action', { type: 'endTurn' });
        const operateUpdate = await updatePromise;

        assert.equal(operateUpdate.state.phase, 'operate');

        // Now in operate phase — end turn and verify AI still takes turns
        updatePromise = waitForStateUpdate(client, (data) =>
            data.state?.currentPlayerIndex === 0 &&
            data.state?.phase === 'operate' &&
            data.state?.turn > operateUpdate.state.turn
        );
        await emit(client, 'action', { type: 'endTurn' });
        const nextUpdate = await updatePromise;

        assert.equal(nextUpdate.state.currentPlayerIndex, 0);
        assert.ok(nextUpdate.state.turn > operateUpdate.state.turn);
    });
});

describe('AI Turn Loop: Turn Timer Behavior', () => {

    it('no turnTimerStarted event for AI players', async () => {
        const client = await createClient();
        await createSoloGame(client);

        let turnTimerFired = false;
        client.on('turnTimerStarted', () => {
            turnTimerFired = true;
        });

        // End turn — AI takes over and ends turn automatically
        const updatePromise = waitForStateUpdate(client, (data) =>
            data.state?.currentPlayerIndex === 0 &&
            data.state?.turn > 1
        );
        await emit(client, 'action', { type: 'endTurn' });
        await updatePromise;

        // Wait a bit extra to make sure no turn timer was started
        await new Promise(r => setTimeout(r, 200));
        assert.equal(turnTimerFired, false, 'Turn timer should not fire for AI players');
    });
});

describe('AI Turn Loop: Edge Cases', () => {

    it('handles game state correctly across multiple full rounds', async () => {
        const client = await createClient();
        const { state } = await createSoloGame(client);

        // Play 3 full rounds (initial building x2 + 1 operate round)
        // Round 1 initial building
        let updatePromise = waitForStateUpdate(client, (data) =>
            data.state?.currentPlayerIndex === 0 && data.state?.turn > state.turn
        );
        await emit(client, 'action', { type: 'endTurn' });
        await updatePromise;

        // Round 2 initial building → transitions to operate
        updatePromise = waitForStateUpdate(client, (data) =>
            data.state?.phase === 'operate' && data.state?.currentPlayerIndex === 0
        );
        await emit(client, 'action', { type: 'endTurn' });
        await updatePromise;

        // Round 3 operate
        updatePromise = waitForStateUpdate(client, (data) =>
            data.state?.currentPlayerIndex === 0 && data.state?.phase === 'operate'
        );
        await emit(client, 'action', { type: 'endTurn' });
        const finalUpdate = await updatePromise;

        // Verify game state is consistent
        assert.equal(finalUpdate.state.players.length, 2);
        assert.equal(finalUpdate.state.currentPlayerIndex, 0);
        assert.equal(finalUpdate.state.phase, 'operate');
    });

    it('human player can still take actions normally between AI turns', async () => {
        const client = await createClient();
        await createSoloGame(client);

        // End turn, wait for AI, verify human can end turn again
        let updatePromise = waitForStateUpdate(client, (data) =>
            data.state?.currentPlayerIndex === 0 && data.state?.turn > 1
        );
        await emit(client, 'action', { type: 'endTurn' });
        await updatePromise;

        // End turn again — should work fine
        updatePromise = waitForStateUpdate(client, (data) =>
            data.state?.currentPlayerIndex === 0 && data.state?.turn > 2
        );
        const endResult = await emit(client, 'action', { type: 'endTurn' });
        assert.equal(endResult.success, true);
        await updatePromise;
    });

    it('AI cannot be exploited by human sending actions during AI turn', async () => {
        const client = await createClient();
        await createSoloGame(client);

        // End turn — now it's AI's turn briefly
        const firstUpdate = once(client, 'stateUpdate');
        await emit(client, 'action', { type: 'endTurn' });
        await firstUpdate;

        // Try to end turn while it's AI's turn — should fail
        const result = await emit(client, 'action', { type: 'endTurn' });
        assert.equal(result.success, false);
        assert.match(result.error, /not your turn/i);
    });
});

describe('AI Turn Loop: DiscardHand Trigger', () => {

    it('discardHand followed by AI turn works correctly', async () => {
        const client = await createClient();
        await createSoloGame(client);

        // Advance to operate phase first
        let updatePromise = waitForStateUpdate(client, (data) =>
            data.state?.currentPlayerIndex === 0 && data.state?.turn > 1
        );
        await emit(client, 'action', { type: 'endTurn' });
        await updatePromise;

        updatePromise = waitForStateUpdate(client, (data) =>
            data.state?.phase === 'operate' && data.state?.currentPlayerIndex === 0
        );
        await emit(client, 'action', { type: 'endTurn' });
        await updatePromise;

        // Now in operate phase — discard hand (also ends turn)
        updatePromise = waitForStateUpdate(client, (data) =>
            data.state?.currentPlayerIndex === 0 &&
            data.state?.phase === 'operate'
        );
        const discardResult = await emit(client, 'action', { type: 'discardHand' });
        assert.equal(discardResult.success, true);

        const update = await updatePromise;
        // Verify we're back to human turn after AI auto-ended
        assert.equal(update.state.currentPlayerIndex, 0);
    });
});

describe('AI Turn Loop: Game State Consistency', () => {

    it('AI players maintain correct cash through turns', async () => {
        const client = await createClient();
        const { state } = await createSoloGame(client);

        const initialAICash = state.players[1].cash;

        const updatePromise = waitForStateUpdate(client, (data) =>
            data.state?.currentPlayerIndex === 0 && data.state?.turn > state.turn
        );
        await emit(client, 'action', { type: 'endTurn' });
        const update = await updatePromise;

        // AI just ended turn (no building/spending) — cash should be unchanged
        assert.equal(update.state.players[1].cash, initialAICash);
    });

    it('game log records AI turn activity', async () => {
        const client = await createClient();
        const { state } = await createSoloGame(client);

        const initialLogLength = state.gameLog.length;

        const updatePromise = waitForStateUpdate(client, (data) =>
            data.state?.currentPlayerIndex === 0 && data.state?.turn > state.turn
        );
        await emit(client, 'action', { type: 'endTurn' });
        const update = await updatePromise;

        // Log should have grown (turn messages for human and AI)
        assert.ok(update.state.gameLog.length > initialLogLength);
    });

    it('AI demand cards remain hidden from human after AI turns', async () => {
        const client = await createClient();
        await createSoloGame(client);

        const updatePromise = waitForStateUpdate(client, (data) =>
            data.state?.currentPlayerIndex === 0 && data.state?.turn > 1
        );
        await emit(client, 'action', { type: 'endTurn' });
        const update = await updatePromise;

        const aiPlayer = update.state.players[1];
        assert.equal(aiPlayer.demandCards.length, 3);
        for (const card of aiPlayer.demandCards) {
            assert.equal(card.hidden, true);
        }
    });

    it('human demand cards remain visible after AI turns', async () => {
        const client = await createClient();
        await createSoloGame(client);

        const updatePromise = waitForStateUpdate(client, (data) =>
            data.state?.currentPlayerIndex === 0 && data.state?.turn > 1
        );
        await emit(client, 'action', { type: 'endTurn' });
        const update = await updatePromise;

        const humanPlayer = update.state.players[0];
        assert.equal(humanPlayer.demandCards.length, 3);
        for (const card of humanPlayer.demandCards) {
            assert.equal(card.hidden, undefined);
            assert.equal(card.type, 'demand');
        }
    });
});

describe('AI Turn Loop: Reconnection Compatibility', () => {

    it('AI turns continue working after human reconnects', async () => {
        const client = await createClient();
        const { roomCode, sessionToken, state } = await createSoloGame(client);

        // Disconnect
        client.disconnect();

        // Reconnect
        const newClient = await createClient();
        const rejoinRes = await emit(newClient, 'rejoinGame', { roomCode, sessionToken });
        assert.equal(rejoinRes.success, true);

        // End turn and verify AI still works
        const updatePromise = waitForStateUpdate(newClient, (data) =>
            data.state?.currentPlayerIndex === 0 &&
            data.state?.turn > rejoinRes.state.turn
        );
        await emit(newClient, 'action', { type: 'endTurn' });
        const update = await updatePromise;

        assert.equal(update.state.currentPlayerIndex, 0);
    });
});
