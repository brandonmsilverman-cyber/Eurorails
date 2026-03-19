#!/usr/bin/env node
// Benchmark findCheapestBuildPath to measure actual per-call cost

const gl = require('../shared/game-logic');
const { generateHexGrid, findPath, computeCoastDistances } = gl;
const CITIES = gl.CITIES;

// Generate the hex grid (same as game startup)
const grid = generateHexGrid();
computeCoastDistances(grid);

const ctx = {
    mileposts: grid.mileposts,
    mileposts_by_id: grid.mileposts_by_id,
    cityToMilepost: grid.cityToMilepost,
    ferryConnections: grid.ferryConnections,
    ferryOwnership: {},
    tracks: [],
    activeEvents: [],
    players: []
};

console.log(`Milepost count: ${grid.mileposts.length}`);
console.log(`City count: ${Object.keys(grid.cityToMilepost).length}`);

// Pick some city pairs at varying distances
const pairs = [
    ['London', 'Paris'],
    ['London', 'Berlin'],
    ['London', 'Madrid'],
    ['London', 'Roma'],
    ['Oslo', 'Napoli'],       // long distance
    ['Lisboa', 'Warszawa'],   // very long distance
    ['Amsterdam', 'Essen'],   // short distance
    ['München', 'Wien'],      // short distance
];

// Warm up
for (let i = 0; i < 10; i++) {
    const fromId = ctx.cityToMilepost['London'];
    const toId = ctx.cityToMilepost['Paris'];
    findPath(ctx, fromId, toId, 'red', 'cheapest');
}

// Benchmark individual calls
console.log('\n--- Individual findPath calls ---');
for (const [from, to] of pairs) {
    const fromId = ctx.cityToMilepost[from];
    const toId = ctx.cityToMilepost[to];

    const start = process.hrtime.bigint();
    const REPS = 20;
    for (let i = 0; i < REPS; i++) {
        findPath(ctx, fromId, toId, 'red', 'cheapest');
    }
    const elapsed = Number(process.hrtime.bigint() - start) / 1e6; // ms
    console.log(`${from} → ${to}: ${(elapsed/REPS).toFixed(2)}ms per call`);
}

// Benchmark findCheapestBuildPath equivalent (2 calls)
console.log('\n--- findCheapestBuildPath (2× findPath) ---');
for (const [from, to] of pairs) {
    const fromId = ctx.cityToMilepost[from];
    const toId = ctx.cityToMilepost[to];

    const start = process.hrtime.bigint();
    const REPS = 20;
    for (let i = 0; i < REPS; i++) {
        findPath(ctx, fromId, toId, 'red', 'cheapest');
        findPath(ctx, toId, fromId, 'red', 'cheapest');
    }
    const elapsed = Number(process.hrtime.bigint() - start) / 1e6;
    console.log(`${from} ↔ ${to}: ${(elapsed/REPS).toFixed(2)}ms per pair`);
}

// Simulate batch evaluation workload: 200 findCheapestBuildPath calls
console.log('\n--- Simulated batch workload ---');
const allCityNames = Object.keys(ctx.cityToMilepost);
const testPairs = [];
for (let i = 0; i < 200; i++) {
    const a = allCityNames[Math.floor(Math.random() * allCityNames.length)];
    const b = allCityNames[Math.floor(Math.random() * allCityNames.length)];
    if (a !== b) testPairs.push([a, b]);
}

const start = process.hrtime.bigint();
for (const [from, to] of testPairs) {
    const fromId = ctx.cityToMilepost[from];
    const toId = ctx.cityToMilepost[to];
    findPath(ctx, fromId, toId, 'red', 'cheapest');
    findPath(ctx, toId, fromId, 'red', 'cheapest');
}
const elapsed = Number(process.hrtime.bigint() - start) / 1e6;
console.log(`${testPairs.length} findCheapestBuildPath calls (${testPairs.length * 2} findPath): ${elapsed.toFixed(0)}ms total, ${(elapsed/testPairs.length).toFixed(2)}ms per pair`);

// Simulate full Hard AI target selection: 101 batch pairs × 2 orderings × ~3 pathfinds each
const BATCH_PAIRS = 101;
const PATHFINDS_PER_BATCH = 6; // 2 orderings × ~3 pathfinds (leg1 + leg2 + connector)
const totalCalls = BATCH_PAIRS * PATHFINDS_PER_BATCH;
console.log(`\n--- Estimated Hard AI target selection ---`);
console.log(`Batch pairs to evaluate: ${BATCH_PAIRS}`);
console.log(`Pathfinds per batch: ${PATHFINDS_PER_BATCH}`);
console.log(`Total findPath calls: ${totalCalls}`);

const start2 = process.hrtime.bigint();
for (let i = 0; i < totalCalls; i++) {
    const a = allCityNames[Math.floor(Math.random() * allCityNames.length)];
    const b = allCityNames[Math.floor(Math.random() * allCityNames.length)];
    if (a === b) continue;
    findPath(ctx, ctx.cityToMilepost[a], ctx.cityToMilepost[b], 'red', 'cheapest');
}
const elapsed2 = Number(process.hrtime.bigint() - start2) / 1e6;
console.log(`Total time: ${elapsed2.toFixed(0)}ms (${(elapsed2/1000).toFixed(1)}s)`);
console.log(`Per findPath call: ${(elapsed2/totalCalls).toFixed(2)}ms`);
