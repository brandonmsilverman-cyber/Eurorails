// Test script: simulates 2 players, builds track, and tests server-authoritative train movement.

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

// Helper: emit action without waiting for stateUpdate (for rejected actions)
async function emitActionOnly(player, action) {
    return new Promise(r => player.emit('action', action, r));
}

async function test() {
    console.log('=== Train Movement Server-Authoritative Test ===\n');

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
    await statePromise2;

    console.log('Phase:', data1.state.phase);
    console.log('Players:', data1.state.players.map(p => p.name));

    // We need to send cityToMilepost data to the server
    // For testing, we'll construct a simple mock hex grid with a few connected mileposts
    // In real game, client generates this from hex grid
    const mockCityToMilepost = {
        'London': '33,30',
        'Paris': '34,42',
        'Amsterdam': '38,27',
        'Berlin': '50.5,24'
    };

    player1.emit('setCityToMilepost', {
        cityToMilepost: mockCityToMilepost,
        ferryConnections: [],
        coastDistance: {},
        milepostPositions: {
            '33,30': { x: 33, y: 30 },
            '33,31': { x: 33, y: 31 },
            '33,32': { x: 33, y: 32 },
            '34,32': { x: 34, y: 32 },
            '34,33': { x: 34, y: 33 }
        },
        eventZones: {}
    });
    await sleep(100);

    // === Build track for Alice ===
    // Build a simple 5-milepost path: 33,30 -> 33,31 -> 33,32 -> 34,32 -> 34,33
    console.log('\n--- Building track for Alice ---');
    let result;

    // Alice builds track (turn 1)
    result = await emitAction(player1, player2, {
        type: 'commitBuild',
        buildPath: ['33,30', '33,31', '33,32', '34,32', '34,33'],
        buildCost: 4,
        majorCityCount: 1,
        ferries: []
    });
    console.log('Alice build 1:', result.actionRes.success ? 'OK' : result.actionRes.error);

    // End Alice's turn
    result = await emitAction(player1, player2, { type: 'endTurn' });

    // Bob builds some track
    result = await emitAction(player2, player1, {
        type: 'commitBuild',
        buildPath: ['38,27', '38,28'],
        buildCost: 1,
        majorCityCount: 1,
        ferries: []
    });

    // End Bob's turn
    result = await emitAction(player2, player1, { type: 'endTurn' });

    // Alice's second initial building turn - build more track
    result = await emitAction(player1, player2, {
        type: 'commitBuild',
        buildPath: ['34,33', '34,34'],
        buildCost: 1,
        majorCityCount: 0,
        ferries: []
    });

    // End Alice's turn
    result = await emitAction(player1, player2, { type: 'endTurn' });

    // Bob builds more
    result = await emitAction(player2, player1, {
        type: 'commitBuild',
        buildPath: ['38,28', '38,29'],
        buildCost: 1,
        majorCityCount: 0,
        ferries: []
    });

    // End Bob's turn — this should transition to operate phase
    result = await emitAction(player2, player1, { type: 'endTurn' });
    console.log('Phase after initial building:', result.actingState.state.phase);
    console.log('Alice movement:', result.actingState.state.players[0].movement);

    const results = [];

    // === Test 1: Deploy train ===
    console.log('\n--- Test 1: Deploy train ---');
    result = await emitAction(player1, player2, {
        type: 'deployTrain',
        milepostId: '33,30'
    });
    const deployedLocation = result.actingState.state.players[0].trainLocation;
    console.log('Train deployed at:', deployedLocation);
    results.push(['Deploy train', deployedLocation === '33,30']);

    // === Test 2: Move train along track ===
    console.log('\n--- Test 2: Move train ---');
    result = await emitAction(player1, player2, {
        type: 'commitMove',
        path: ['33,30', '33,31', '33,32']
    });
    console.log('Move result:', result.actionRes.success ? 'OK' : result.actionRes.error);
    const afterMove = result.actingState.state.players[0];
    console.log('New location:', afterMove.trainLocation);
    console.log('Movement left:', afterMove.movement);
    console.log('Both synced:', JSON.stringify(result.actingState.state) === JSON.stringify(result.otherState.state));
    results.push(['Move train', result.actionRes.success && afterMove.trainLocation === '33,32']);
    results.push(['Movement deducted', afterMove.movement === 7]); // 9 - 2 = 7
    results.push(['Move state sync', JSON.stringify(result.actingState.state) === JSON.stringify(result.otherState.state)]);

    // === Test 3: Wrong player can't move ===
    console.log('\n--- Test 3: Wrong player tries to move ---');
    const wrongRes = await emitActionOnly(player2, {
        type: 'commitMove',
        path: ['38,27', '38,28']
    });
    console.log('Wrong player response:', wrongRes);
    results.push(['Wrong player rejected', !wrongRes.success]);

    // === Test 4: Move with no track connection fails ===
    console.log('\n--- Test 4: No track connection ---');
    const noTrackRes = await emitActionOnly(player1, {
        type: 'commitMove',
        path: ['33,32', '99,99']
    });
    console.log('No track response:', noTrackRes);
    results.push(['No track rejected', !noTrackRes.success]);

    // === Test 5: Path not starting at current location fails ===
    console.log('\n--- Test 5: Wrong starting location ---');
    const wrongStartRes = await emitActionOnly(player1, {
        type: 'commitMove',
        path: ['33,30', '33,31']
    });
    console.log('Wrong start response:', wrongStartRes);
    results.push(['Wrong start rejected', !wrongStartRes.success]);

    // === Test 6: Undo move ===
    console.log('\n--- Test 6: Undo move ---');
    result = await emitAction(player1, player2, { type: 'undoMove' });
    console.log('Undo result:', result.actionRes.success ? 'OK' : result.actionRes.error);
    const afterUndo = result.actingState.state.players[0];
    console.log('Location after undo:', afterUndo.trainLocation);
    console.log('Movement after undo:', afterUndo.movement);
    results.push(['Undo move', result.actionRes.success && afterUndo.trainLocation === '33,30' && afterUndo.movement === 9]);

    // === Test 7: Undo deploy ===
    console.log('\n--- Test 7: Undo deploy ---');
    result = await emitAction(player1, player2, { type: 'undoMove' });
    console.log('Undo deploy result:', result.actionRes.success ? 'OK' : result.actionRes.error);
    const afterUndoDeploy = result.actingState.state.players[0];
    console.log('Location after undo deploy:', afterUndoDeploy.trainLocation);
    results.push(['Undo deploy', result.actionRes.success && afterUndoDeploy.trainLocation === null]);

    // === Test 8: Undo with nothing to undo ===
    console.log('\n--- Test 8: Undo nothing ---');
    const undoNothingRes = await emitActionOnly(player1, { type: 'undoMove' });
    console.log('Undo nothing response:', undoNothingRes);
    results.push(['Undo nothing rejected', !undoNothingRes.success]);

    // === Test 9: Undo build ===
    console.log('\n--- Test 9: Undo build ---');
    // First end Alice's turn and go through Bob's turn to get back to Alice's build phase
    result = await emitAction(player1, player2, { type: 'endTurn' });
    // Bob's operate phase - end turn
    result = await emitAction(player2, player1, { type: 'endTurn' });
    // Now Alice is in operate again, end turn
    result = await emitAction(player1, player2, { type: 'endTurn' });
    // Bob end turn
    result = await emitAction(player2, player1, { type: 'endTurn' });
    // Alice should be in operate — let's just test undoBuild during a future build turn
    // For now, just test that undoBuild with nothing to undo returns error
    const undoBuildEmptyRes = await emitActionOnly(player1, { type: 'undoBuild' });
    console.log('Undo build (empty):', undoBuildEmptyRes);
    results.push(['Undo build empty rejected', !undoBuildEmptyRes.success]);

    // === Summary ===
    console.log('\n=== Results ===');
    let allPassed = true;
    for (const [name, pass] of results) {
        console.log(`${pass ? 'PASS' : 'FAIL'}: ${name}`);
        if (!pass) allPassed = false;
    }

    player1.disconnect();
    player2.disconnect();
    console.log('\nTest complete.');
    process.exit(allPassed ? 0 : 1);
}

test().catch(e => { console.error(e); process.exit(1); });
