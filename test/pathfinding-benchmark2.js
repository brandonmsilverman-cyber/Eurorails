#!/usr/bin/env node
const gl = require('../shared/game-logic');
const { generateHexGrid, findPath, computeCoastDistances } = gl;

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

const allCityNames = Object.keys(ctx.cityToMilepost);
console.log(`Mileposts: ${grid.mileposts.length}, Cities: ${allCityNames.length}`);

// Simulate the actual Hard AI workload:
// 101 batch pairs × 2 orderings × ~3 pathfinds each = 606 findPath calls
// Plus ~25 single candidate evaluations = ~50 more findPath calls
// Total: ~656 findPath calls

const TOTAL_CALLS = 656;
const callPairs = [];
for (let i = 0; i < TOTAL_CALLS; i++) {
    const a = allCityNames[Math.floor(Math.random() * allCityNames.length)];
    let b = allCityNames[Math.floor(Math.random() * allCityNames.length)];
    while (b === a) b = allCityNames[Math.floor(Math.random() * allCityNames.length)];
    callPairs.push([ctx.cityToMilepost[a], ctx.cityToMilepost[b]]);
}

const start = process.hrtime.bigint();
for (const [fromId, toId] of callPairs) {
    findPath(ctx, fromId, toId, 'red', 'cheapest');
}
const elapsed = Number(process.hrtime.bigint() - start) / 1e6;

console.log(`${TOTAL_CALLS} findPath calls: ${elapsed.toFixed(0)}ms total`);
console.log(`Per call: ${(elapsed/TOTAL_CALLS).toFixed(2)}ms`);
console.log(`That's ${(elapsed/1000).toFixed(1)} seconds for a full Hard AI target selection`);
