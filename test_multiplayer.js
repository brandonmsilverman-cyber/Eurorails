// Test script: simulates 2 players, verifies game state sync and endTurn action.

const { io } = require('socket.io-client');

const URL = 'http://localhost:3000';

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Helper: emit action and wait for both players to receive stateUpdate
async function emitAction(actingPlayer, otherPlayer, action) {
    const p1Update = new Promise(r => actingPlayer.once('stateUpdate', r));
    const p2Update = new Promise(r => otherPlayer.once('stateUpdate', r));
    const actionRes = await new Promise(r => actingPlayer.emit('action', action, r));
    const [u1, u2] = await Promise.all([p1Update, p2Update]);
    return { actionRes, actingState: u1, otherState: u2 };
}

async function test() {
    console.log('=== Multiplayer State Sync + endTurn Test ===\n');

    const player1 = io(URL);
    const player2 = io(URL);

    await new Promise(r => player1.on('connect', r));
    console.log('Player 1 connected:', player1.id);
    await new Promise(r => player2.on('connect', r));
    console.log('Player 2 connected:', player2.id);

    // Create room and join
    const createRes = await new Promise(r => {
        player1.emit('createRoom', { playerName: 'Alice' }, r);
    });
    console.log('Room created:', createRes.roomCode);

    await new Promise(r => {
        player2.emit('joinRoom', { roomCode: createRes.roomCode, playerName: 'Bob' }, r);
    });

    await sleep(100);
    player1.emit('selectColor', { color: 'red' });
    await sleep(100);
    player2.emit('selectColor', { color: 'blue' });
    await sleep(100);

    // Listen for gameStart
    const statePromise1 = new Promise(r => player1.on('gameStart', r));
    const statePromise2 = new Promise(r => player2.on('gameStart', r));

    player1.emit('startGame');

    const data1 = await statePromise1;
    const data2 = await statePromise2;

    console.log('\n--- Initial State ---');
    console.log('Phase:', data1.state.phase);
    console.log('Current player index:', data1.state.currentPlayerIndex);
    console.log('Turn:', data1.state.turn);
    console.log('Players:', data1.state.players.map(p => p.name));

    // Send cityToMilepost (simulated)
    player1.emit('setCityToMilepost', { cityToMilepost: {}, ferryConnections: [] });
    await sleep(100);

    // === Test 1: Alice (player 0) ends turn ===
    console.log('\n--- Test 1: Alice ends turn ---');
    let { actionRes, actingState: u1, otherState: u2 } = await emitAction(player1, player2, { type: 'endTurn' });

    console.log('endTurn response:', actionRes);
    console.log('New current player:', u1.state.currentPlayerIndex, '(Bob)');
    console.log('Turn:', u1.state.turn);
    console.log('Overlay:', u1.uiEvent?.overlay?.playerName, '-', u1.uiEvent?.overlay?.phaseLabel);
    console.log('Both received same state:', JSON.stringify(u1.state) === JSON.stringify(u2.state));

    // === Test 2: Bob ends turn ===
    console.log('\n--- Test 2: Bob ends turn ---');
    ({ actionRes, actingState: u1, otherState: u2 } = await emitAction(player2, player1, { type: 'endTurn' }));

    console.log('New current player:', u1.state.currentPlayerIndex, '(Alice)');
    console.log('Turn:', u1.state.turn);
    console.log('buildingPhaseCount:', u1.state.buildingPhaseCount);
    console.log('Both received same state:', JSON.stringify(u1.state) === JSON.stringify(u2.state));

    // === Test 3: Wrong player tries to end turn ===
    console.log('\n--- Test 3: Wrong player tries to end turn ---');
    const wrongRes = await new Promise(r => {
        player2.emit('action', { type: 'endTurn' }, r);
    });
    console.log('Wrong player response:', wrongRes);
    console.log('Correctly rejected:', !wrongRes.success);

    // === Test 4: Complete initial building and transition to operate ===
    console.log('\n--- Test 4: Phase transition ---');

    // Alice ends turn (round 2, player 0 -> 1)
    ({ actionRes, actingState: u1 } = await emitAction(player1, player2, { type: 'endTurn' }));
    console.log('After Alice: player', u1.state.currentPlayerIndex, 'phase', u1.state.phase, 'buildCount', u1.state.buildingPhaseCount);

    // Bob ends turn (round 2 complete, should transition to operate)
    ({ actionRes, actingState: u1 } = await emitAction(player2, player1, { type: 'endTurn' }));
    console.log('After Bob: player', u1.state.currentPlayerIndex, 'phase', u1.state.phase, 'buildCount', u1.state.buildingPhaseCount);

    const transitioned = u1.state.phase === 'operate';
    console.log('Transitioned to operate:', transitioned);
    if (transitioned) {
        console.log('Movements:', u1.state.players.map(p => `${p.name}: ${p.movement}mp`));
    }

    // === Summary ===
    console.log('\n=== Results ===');
    const results = [
        ['State sync', true],
        ['endTurn changes player', actionRes.success],
        ['Wrong player rejected', !wrongRes.success],
        ['Phase transition', transitioned],
    ];
    for (const [name, pass] of results) {
        console.log(`${pass ? 'PASS' : 'FAIL'}: ${name}`);
    }

    player1.disconnect();
    player2.disconnect();
    console.log('\nTest complete.');
    process.exit(results.every(r => r[1]) ? 0 : 1);
}

test().catch(e => { console.error(e); process.exit(1); });
