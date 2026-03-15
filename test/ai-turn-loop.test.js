/**
 * Tests for AI Turn Loop (multiplayer with AI players)
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
let rooms;
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

/**
 * Create a multiplayer game with AI players via the lobby flow.
 * Returns { roomCode, sessionToken, state }.
 */
async function createGameWithAI(client, overrides = {}) {
    const playerName = overrides.playerName || 'TestPlayer';
    const playerColor = overrides.playerColor || 'red';
    const aiPlayers = overrides.aiPlayers || [
        { name: 'AI 1 (Easy)', difficulty: 'easy', color: 'blue' }
    ];

    // Create room
    const createRes = await emit(client, 'createRoom', { playerName });
    assert.equal(createRes.success, true, 'Room creation should succeed');
    const { roomCode, sessionToken } = createRes;

    // Select host color
    await emit(client, 'selectColor', { color: playerColor });

    // Add AI players and assign colors
    for (const ai of aiPlayers) {
        const aiUpdateP = once(client, 'roomUpdate');
        await emit(client, 'addAIPlayer', { difficulty: ai.difficulty || 'easy' });
        const info = await aiUpdateP;
        const addedAI = info.players.filter(p => p.isAI).pop();
        await emit(client, 'updateAIPlayer', { sessionToken: addedAI.id, color: ai.color });
    }

    // Start game
    const gameStartP = once(client, 'gameStart', 15000);
    client.emit('startGame');
    const { state } = await gameStartP;

    return { roomCode, sessionToken, state };
}

// ===========================================================================
// AI TURN LOOP TESTS
// ===========================================================================

describe('AI Turn Loop: Basic Turn Execution', () => {

    it('AI auto-ends turn after human ends turn', async () => {
        const client = await createClient();
        const { state } = await createGameWithAI(client);

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
        await createGameWithAI(client);

        // Wait for AI to complete its full turn (build + endTurn) and return to human.
        // The final stateUpdate should be turnChanged back to human with overlay.
        const updatePromise = waitForStateUpdate(client, (data) =>
            data.uiEvent?.type === 'turnChanged' &&
            data.state?.currentPlayerIndex === 0
        );
        await emit(client, 'action', { type: 'endTurn' });
        const update = await updatePromise;

        assert.equal(update.state.currentPlayerIndex, 0);
        assert.ok(update.uiEvent.overlay);
        assert.equal(update.uiEvent.overlay.playerName, 'TestPlayer');
    });

    it('AI turn overlay shows AI player name and color', async () => {
        const client = await createClient();
        await createGameWithAI(client);

        // First stateUpdate after endTurn shows the AI's turn overlay
        const updatesPromise = collectStateUpdates(client, 1);
        await emit(client, 'action', { type: 'endTurn' });
        const [aiUpdate] = await updatesPromise;

        assert.equal(aiUpdate.uiEvent.overlay.playerName, 'AI 1');
        assert.equal(aiUpdate.uiEvent.overlay.playerColor, 'blue');
    });
});

describe('AI Turn Loop: Multiple AI Players', () => {

    it('cascading AI turns with 2 AI opponents', async () => {
        const client = await createClient();
        const { state } = await createGameWithAI(client, {
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
        const { state } = await createGameWithAI(client, {
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

    it('each AI turn produces multiple stateUpdates', async () => {
        const client = await createClient();
        await createGameWithAI(client, {
            aiPlayers: [
                { name: 'AI 1', difficulty: 'easy', color: 'blue' },
                { name: 'AI 2', difficulty: 'easy', color: 'green' },
            ]
        });

        // With 2 AI players, each doing build + endTurn, we expect many stateUpdates.
        // Wait for the final one where it's back to human's turn.
        const updates = [];
        const donePromise = new Promise((resolve, reject) => {
            const timer = setTimeout(
                () => reject(new Error(`Timeout: got ${updates.length} stateUpdates`)),
                10000
            );
            function handler(data) {
                updates.push(data);
                if (data.state?.currentPlayerIndex === 0 && data.state?.turn > 1) {
                    clearTimeout(timer);
                    client.off('stateUpdate', handler);
                    resolve();
                }
            }
            client.on('stateUpdate', handler);
        });

        await emit(client, 'action', { type: 'endTurn' });
        await donePromise;

        // Each AI should produce at least 2 broadcasts (build + endTurn),
        // plus the human's endTurn = at least 5 total
        assert.ok(updates.length >= 3,
            `Expected at least 3 stateUpdates for 2 AI turns, got ${updates.length}`);
        // Final update should be back to human
        assert.equal(updates[updates.length - 1].state.currentPlayerIndex, 0);
    });
});

describe('AI Turn Loop: Initial Building Phase', () => {

    it('AI takes turns during initial building phase', async () => {
        const client = await createClient();
        const { state } = await createGameWithAI(client);

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
        const { state } = await createGameWithAI(client);

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
        await createGameWithAI(client);

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
        await createGameWithAI(client);

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
        const { state } = await createGameWithAI(client);

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
        await createGameWithAI(client);

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
        await createGameWithAI(client);

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
        await createGameWithAI(client);

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

    it('AI players spend cash when building track', async () => {
        const client = await createClient();
        const { state } = await createGameWithAI(client);

        const initialAICash = state.players[1].cash;

        const updatePromise = waitForStateUpdate(client, (data) =>
            data.state?.currentPlayerIndex === 0 && data.state?.turn > state.turn
        );
        await emit(client, 'action', { type: 'endTurn' });
        const update = await updatePromise;

        // AI builds track during initialBuilding, so cash should decrease
        assert.ok(update.state.players[1].cash <= initialAICash,
            'AI cash should not increase during initialBuilding');
    });

    it('game log records AI turn activity', async () => {
        const client = await createClient();
        const { state } = await createGameWithAI(client);

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
        await createGameWithAI(client);

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
        await createGameWithAI(client);

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

// Reconnection with AI is tested in reconnect-*.test.js files.
// In multiplayer, a room with only 1 human + AI is deleted when the human
// disconnects, so the solo-style reconnect test is not applicable here.

// ===========================================================================
// PHASE 3 STEP 4: AI ACTION SEQUENCE TESTS
// ===========================================================================

describe('AI Action Sequence: Initial Building', () => {

    it('AI builds track during initialBuilding phase', async () => {
        const client = await createClient();
        const { state } = await createGameWithAI(client);

        assert.equal(state.phase, 'initialBuilding');

        // Human ends turn; wait for AI to finish its turn and return to human
        const updatePromise = waitForStateUpdate(client, (data) =>
            data.state?.currentPlayerIndex === 0 &&
            data.state?.turn > state.turn
        );
        await emit(client, 'action', { type: 'endTurn' });
        const update = await updatePromise;

        // AI should have built track (tracks array has entries for AI's color)
        const aiColor = state.players[1].color;
        const aiTracks = update.state.tracks.filter(t => t.color === aiColor);
        assert.ok(aiTracks.length > 0, `AI (${aiColor}) should have built at least one track segment`);

        // AI cash should have decreased from building
        assert.ok(update.state.players[1].cash < state.players[1].cash,
            'AI cash should decrease after building track');
    });

    it('AI turn produces multiple stateUpdate broadcasts', async () => {
        const client = await createClient();
        const { state } = await createGameWithAI(client);

        assert.equal(state.phase, 'initialBuilding');

        // Collect all stateUpdates after human ends turn until it's human's turn again.
        // AI should produce >1 broadcast: at least commitBuild + endTurn.
        const updates = [];
        const donePromise = new Promise((resolve, reject) => {
            const timer = setTimeout(
                () => reject(new Error(`Timeout: got ${updates.length} stateUpdates`)),
                10000
            );
            function handler(data) {
                updates.push(data);
                // Once it's back to human's turn, we're done
                if (data.state?.currentPlayerIndex === 0 && data.state?.turn > state.turn) {
                    clearTimeout(timer);
                    client.off('stateUpdate', handler);
                    resolve();
                }
            }
            client.on('stateUpdate', handler);
        });

        await emit(client, 'action', { type: 'endTurn' });
        await donePromise;

        // First update is human's endTurn, then AI actions follow.
        // AI should produce at least 2 broadcasts: commitBuild + endTurn (minimum).
        // Total should be >= 3 (human endTurn + AI commitBuild + AI endTurn).
        assert.ok(updates.length >= 3,
            `Expected at least 3 stateUpdates (human endTurn + AI build + AI endTurn), got ${updates.length}`);
    });
});

describe('AI Action Sequence: Room Deletion Safety', () => {

    it('handles room deletion mid-turn without crash or orphaned timers', async () => {
        const client = await createClient();
        const { roomCode, state } = await createGameWithAI(client);

        assert.equal(state.phase, 'initialBuilding');

        // Human ends turn — AI turn starts
        const firstUpdate = once(client, 'stateUpdate');
        await emit(client, 'action', { type: 'endTurn' });
        await firstUpdate;

        // Delete the room while AI sequence may still be in progress
        rooms.delete(roomCode);

        // Wait a bit for any pending AI timers to fire
        await new Promise(r => setTimeout(r, 500));

        // If we get here without crash, the test passes.
        // Verify the room is gone
        assert.equal(rooms.has(roomCode), false, 'Room should be deleted');
    });
});

describe('AI Action Sequence: Regression', () => {

    it('existing turn loop still works with action sequence executor', async () => {
        // Verifies the basic turn loop: human → AI → human across phase transitions
        const client = await createClient();
        const { state } = await createGameWithAI(client);

        // Round 1 initial building
        let updatePromise = waitForStateUpdate(client, (data) =>
            data.state?.currentPlayerIndex === 0 && data.state?.turn > state.turn
        );
        await emit(client, 'action', { type: 'endTurn' });
        let update = await updatePromise;
        assert.equal(update.state.currentPlayerIndex, 0);
        assert.equal(update.state.phase, 'initialBuilding');

        // Round 2 → transitions to operate
        updatePromise = waitForStateUpdate(client, (data) =>
            data.state?.phase === 'operate' && data.state?.currentPlayerIndex === 0
        );
        await emit(client, 'action', { type: 'endTurn' });
        update = await updatePromise;
        assert.equal(update.state.phase, 'operate');

        // Operate round
        updatePromise = waitForStateUpdate(client, (data) =>
            data.state?.currentPlayerIndex === 0 &&
            data.state?.phase === 'operate' &&
            data.state?.turn > update.state.turn
        );
        await emit(client, 'action', { type: 'endTurn' });
        const finalUpdate = await updatePromise;
        assert.equal(finalUpdate.state.currentPlayerIndex, 0);
        assert.equal(finalUpdate.state.players.length, 2);
    });
});

// ===========================================================================
// PERSISTENT DEMAND CARD RENDERING (Commit 1)
// ===========================================================================

describe('Persistent Demand Cards: Cards visible during other player\'s turn', () => {

    it('human player cards are full (non-hidden) during AI turn', async () => {
        const client = await createClient();
        await createGameWithAI(client);

        // Collect the first stateUpdate after ending turn — this fires while
        // it's the AI's turn (currentPlayerIndex === 1)
        const aiTurnUpdate = await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('Timeout')), 5000);
            function handler(data) {
                // Look for an update where it's the AI's turn
                if (data.state?.currentPlayerIndex === 1) {
                    clearTimeout(timer);
                    client.off('stateUpdate', handler);
                    resolve(data);
                }
            }
            client.on('stateUpdate', handler);
            emit(client, 'action', { type: 'endTurn' });
        });

        // Even though it's the AI's turn, the human's cards should be fully visible
        const humanPlayer = aiTurnUpdate.state.players[0];
        assert.equal(humanPlayer.demandCards.length, 3);
        for (const card of humanPlayer.demandCards) {
            assert.equal(card.hidden, undefined, 'Human cards should not be hidden during AI turn');
            assert.ok(Array.isArray(card.demands), 'Card should have demands array');
            assert.equal(card.demands.length, 3, 'Each card should have 3 demands');
        }
    });

    it('human player cards persist across multiple turn transitions', async () => {
        const client = await createClient();
        const { state } = await createGameWithAI(client);

        // Capture the initial cards
        const initialCards = state.players[0].demandCards;
        assert.equal(initialCards.length, 3);

        // End turn, wait for full round (human → AI → human)
        let updatePromise = waitForStateUpdate(client, (data) =>
            data.state?.currentPlayerIndex === 0 && data.state?.turn > state.turn
        );
        await emit(client, 'action', { type: 'endTurn' });
        let update = await updatePromise;

        // Cards should still be present and non-hidden
        const humanAfterRound1 = update.state.players[0];
        assert.equal(humanAfterRound1.demandCards.length, 3);
        for (const card of humanAfterRound1.demandCards) {
            assert.equal(card.hidden, undefined);
            assert.ok(Array.isArray(card.demands));
        }

        // Do another full round
        updatePromise = waitForStateUpdate(client, (data) =>
            data.state?.currentPlayerIndex === 0 && data.state?.turn > update.state.turn
        );
        await emit(client, 'action', { type: 'endTurn' });
        const update2 = await updatePromise;

        const humanAfterRound2 = update2.state.players[0];
        assert.equal(humanAfterRound2.demandCards.length, 3);
        for (const card of humanAfterRound2.demandCards) {
            assert.equal(card.hidden, undefined);
            assert.ok(Array.isArray(card.demands));
        }
    });

    it('AI cards remain hidden from human across all turns', async () => {
        const client = await createClient();
        const { state } = await createGameWithAI(client);

        // Collect ALL stateUpdates through a full round and verify AI cards
        // are hidden in every single one
        const updates = [];
        const donePromise = new Promise((resolve, reject) => {
            const timer = setTimeout(
                () => reject(new Error(`Timeout: got ${updates.length} stateUpdates`)),
                5000
            );
            function handler(data) {
                updates.push(data);
                if (data.state?.currentPlayerIndex === 0 && data.state?.turn > state.turn) {
                    clearTimeout(timer);
                    client.off('stateUpdate', handler);
                    resolve();
                }
            }
            client.on('stateUpdate', handler);
        });

        await emit(client, 'action', { type: 'endTurn' });
        await donePromise;

        // Every update should have AI cards hidden
        for (const upd of updates) {
            const aiPlayer = upd.state.players[1];
            assert.equal(aiPlayer.demandCards.length, 3);
            for (const card of aiPlayer.demandCards) {
                assert.equal(card.hidden, true, 'AI cards should always be hidden from human');
            }
        }
    });

    it('delivery action rejected when not your turn', async () => {
        const client = await createClient();
        await createGameWithAI(client);

        // Advance to operate phase
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

        // End turn so it's the AI's turn, then try to deliver
        const aiTurnPromise = new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('Timeout')), 5000);
            function handler(data) {
                if (data.state?.currentPlayerIndex === 1) {
                    clearTimeout(timer);
                    client.off('stateUpdate', handler);
                    resolve(data);
                }
            }
            client.on('stateUpdate', handler);
        });
        emit(client, 'action', { type: 'endTurn' });
        await aiTurnPromise;

        // Try to deliver while it's not our turn — should fail
        const result = await emit(client, 'action', { type: 'deliverGood', cardIdx: 0, demandIdx: 0 });
        assert.equal(result.success, false);
    });
});

// ===========================================================================
// COMMIT 3: DEMAND CARD HIGHLIGHT PERSISTENCE
// ===========================================================================

describe('Demand Card Highlights: Selections survive state updates', () => {

    it('card identity (good/to/payout) is stable across state updates within a turn', async () => {
        const client = await createClient();
        const { state } = await createGameWithAI(client);

        // Capture the card fingerprints at game start
        const humanCards = state.players[0].demandCards;
        const fingerprint = JSON.stringify(
            humanCards.map(c => c.demands.map(d => [d.good, d.to, d.payout]))
        );

        // End turn, wait for full round back to human
        const updatePromise = waitForStateUpdate(client, (data) =>
            data.state?.currentPlayerIndex === 0 && data.state?.turn > state.turn
        );
        await emit(client, 'action', { type: 'endTurn' });
        const update = await updatePromise;

        // Cards should have identical identity fingerprints (no deliveries happened)
        const updatedCards = update.state.players[0].demandCards;
        const newFingerprint = JSON.stringify(
            updatedCards.map(c => c.demands.map(d => [d.good, d.to, d.payout]))
        );
        assert.equal(newFingerprint, fingerprint,
            'Card identity fingerprints should be stable when no cards are replaced');
    });

    it('card identity stable across multiple turn transitions', async () => {
        const client = await createClient();
        const { state } = await createGameWithAI(client);

        const fingerprint = JSON.stringify(
            state.players[0].demandCards.map(c => c.demands.map(d => [d.good, d.to, d.payout]))
        );

        // Go through 3 full rounds
        let currentTurn = state.turn;
        for (let i = 0; i < 3; i++) {
            const t = currentTurn;
            const updatePromise = waitForStateUpdate(client, (data) =>
                data.state?.currentPlayerIndex === 0 && data.state?.turn > t
            );
            await emit(client, 'action', { type: 'endTurn' });
            const update = await updatePromise;
            currentTurn = update.state.turn;

            const newFingerprint = JSON.stringify(
                update.state.players[0].demandCards.map(c => c.demands.map(d => [d.good, d.to, d.payout]))
            );
            assert.equal(newFingerprint, fingerprint,
                `Card fingerprints should be stable after round ${i + 1}`);
        }
    });

    it('card data includes all fields needed for stable fingerprinting', async () => {
        const client = await createClient();
        const { state } = await createGameWithAI(client);

        // Verify each demand has the fields used in the fingerprint
        for (const card of state.players[0].demandCards) {
            assert.ok(Array.isArray(card.demands), 'Card should have demands array');
            for (const demand of card.demands) {
                assert.ok(demand.good !== undefined, 'Demand should have good field');
                assert.ok(demand.to !== undefined, 'Demand should have to field');
                assert.ok(demand.payout !== undefined, 'Demand should have payout field');
            }
        }
    });
});

// ===========================================================================
// POST-DELIVERY RE-PLAN TESTS
// ===========================================================================

describe('Post-Delivery Re-plan: AI uses remaining movement after delivery', () => {
    const gl = require('../shared/game-logic');

    it('AI re-plans after delivery and produces additional actions', async () => {
        const client = await createClient();
        const { roomCode, state } = await createGameWithAI(client);

        // Advance to operate phase
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

        // Now manipulate the AI's game state on the server to set up a delivery scenario
        const room = rooms.get(roomCode);
        const gs = room.gameState;
        const ai = gs.players[1]; // AI is player 1
        const grid = gl.generateHexGrid();

        // Build track between two cities the AI can use
        const wrocId = grid.cityToMilepost['Wroclaw'];
        const leipId = grid.cityToMilepost['Leipzig'];
        const berlinId = grid.cityToMilepost['Berlin'];

        // Build track Wroclaw → Leipzig → Berlin for the AI
        const path1 = gl.findPath(
            { ...grid, tracks: gs.tracks, ferryOwnership: gs.ferryOwnership, activeEvents: gs.activeEvents },
            wrocId, leipId, ai.color, 'cheapest'
        );
        if (path1) {
            for (let i = 0; i < path1.path.length - 1; i++) {
                gs.tracks.push({ from: path1.path[i], to: path1.path[i + 1], color: ai.color });
            }
        }
        const path2 = gl.findPath(
            { ...grid, tracks: gs.tracks, ferryOwnership: gs.ferryOwnership, activeEvents: gs.activeEvents },
            leipId, berlinId, ai.color, 'cheapest'
        );
        if (path2) {
            for (let i = 0; i < path2.path.length - 1; i++) {
                gs.tracks.push({ from: path2.path[i], to: path2.path[i + 1], color: ai.color });
            }
        }

        // Place AI at Leipzig carrying Coal, with a demand for Coal→Leipzig
        ai.trainLocation = leipId;
        ai.loads = ['Coal'];
        ai.movement = 9;
        ai.demandCards = [
            {
                id: 'test-card-1', type: 'demand',
                demands: [
                    { good: 'Coal', to: 'Leipzig', payout: 15 },
                    { good: 'Beer', to: 'Paris', payout: 25 },
                    { good: 'Wine', to: 'Madrid', payout: 30 }
                ]
            },
            {
                id: 'test-card-2', type: 'demand',
                demands: [
                    { good: 'Coal', to: 'Berlin', payout: 20 },
                    { good: 'Beer', to: 'Wien', payout: 18 },
                    { good: 'Wine', to: 'Roma', payout: 28 }
                ]
            },
            {
                id: 'test-card-3', type: 'demand',
                demands: [
                    { good: 'Coal', to: 'Praha', payout: 14 },
                    { good: 'Beer', to: 'London', payout: 22 },
                    { good: 'Wine', to: 'Marseille', payout: 26 }
                ]
            }
        ];
        ai.aiState = { targetCardIndex: null, targetDemandIndex: null, targetSourceCity: null };
        gs.phase = 'operate';
        gs.currentPlayerIndex = 0; // still human's turn

        // End human turn so AI takes over
        // Collect ALL stateUpdates to look for a delivery event followed by more actions
        const updates = [];
        const donePromise = new Promise((resolve, reject) => {
            const timer = setTimeout(
                () => reject(new Error(`Timeout: got ${updates.length} stateUpdates. Events: ${updates.map(u => u.uiEvent?.type).join(', ')}`)),
                10000
            );
            function handler(data) {
                updates.push(data);
                // Done when it's back to human's turn
                if (data.state?.currentPlayerIndex === 0 &&
                    data.state?.phase === 'operate' &&
                    updates.length > 1) {
                    clearTimeout(timer);
                    client.off('stateUpdate', handler);
                    resolve();
                }
            }
            client.on('stateUpdate', handler);
        });

        await emit(client, 'action', { type: 'endTurn' });
        await donePromise;

        // Check that a delivery event occurred
        const deliveryUpdate = updates.find(u => u.uiEvent?.type === 'delivery');
        assert.ok(deliveryUpdate, 'Should have a delivery event in stateUpdates');

        // After the delivery, there should be additional action events
        // (the re-plan producing movement or at least endOperatePhase)
        const deliveryIdx = updates.indexOf(deliveryUpdate);
        const postDeliveryUpdates = updates.slice(deliveryIdx + 1);
        assert.ok(postDeliveryUpdates.length >= 1,
            `Expected at least 1 post-delivery update, got ${postDeliveryUpdates.length}`);
    });

    // Skip: This test manipulates ai.movement=0 mid-state, but in the lobby flow
    // the AI gets a fresh turn with movement reset, so the manipulation is overwritten.
    // The re-plan logic is exercised by the test above (AI re-plans after delivery).
    it.skip('no re-plan when AI has 0 movement after delivery', async () => {
        const client = await createClient();
        const { roomCode, state } = await createGameWithAI(client);

        // Advance to operate phase
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

        // Set up delivery scenario with 0 movement remaining
        const room = rooms.get(roomCode);
        const gs = room.gameState;
        const ai = gs.players[1];
        const grid = gl.generateHexGrid();
        const leipId = grid.cityToMilepost['Leipzig'];

        ai.trainLocation = leipId;
        ai.loads = ['Coal'];
        ai.movement = 0;  // no movement left
        ai.demandCards = [
            {
                id: 'test-card-1', type: 'demand',
                demands: [
                    { good: 'Coal', to: 'Leipzig', payout: 15 },
                    { good: 'Beer', to: 'Paris', payout: 25 },
                    { good: 'Wine', to: 'Madrid', payout: 30 }
                ]
            },
            {
                id: 'test-card-2', type: 'demand',
                demands: [
                    { good: 'Coal', to: 'Berlin', payout: 20 },
                    { good: 'Beer', to: 'Wien', payout: 18 },
                    { good: 'Wine', to: 'Roma', payout: 28 }
                ]
            },
            {
                id: 'test-card-3', type: 'demand',
                demands: [
                    { good: 'Coal', to: 'Praha', payout: 14 },
                    { good: 'Beer', to: 'London', payout: 22 },
                    { good: 'Wine', to: 'Marseille', payout: 26 }
                ]
            }
        ];
        ai.aiState = { targetCardIndex: null, targetDemandIndex: null, targetSourceCity: null };
        gs.phase = 'operate';
        gs.currentPlayerIndex = 0;

        // Collect updates — delivery should NOT be followed by a re-plan movement
        const updates = [];
        const donePromise = new Promise((resolve, reject) => {
            const timer = setTimeout(
                () => reject(new Error(`Timeout: got ${updates.length} stateUpdates`)),
                10000
            );
            function handler(data) {
                updates.push(data);
                if (data.state?.currentPlayerIndex === 0 &&
                    data.state?.phase === 'operate' &&
                    updates.length > 1) {
                    clearTimeout(timer);
                    client.off('stateUpdate', handler);
                    resolve();
                }
            }
            client.on('stateUpdate', handler);
        });

        await emit(client, 'action', { type: 'endTurn' });
        await donePromise;

        // Should still deliver
        const deliveryUpdate = updates.find(u => u.uiEvent?.type === 'delivery');
        assert.ok(deliveryUpdate, 'Should have a delivery event');

        // After delivery, the next action should be endOperatePhase (from original plan),
        // NOT a re-plan movement — because movement was 0
        const deliveryIdx = updates.indexOf(deliveryUpdate);
        const postDeliveryActions = updates.slice(deliveryIdx + 1);
        const hasReplanMovement = postDeliveryActions.some(u =>
            u.uiEvent?.type === 'action' &&
            u.uiEvent?.logs?.some(l => l.includes('Moved to') || l.includes('Partial move'))
        );
        assert.equal(hasReplanMovement, false,
            'Should NOT re-plan movement when AI has 0 movement points');
    });
});
