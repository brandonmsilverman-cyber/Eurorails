#!/usr/bin/env node
const gl = require('../shared/game-logic');
const { generateHexGrid, findPath, computeCoastDistances } = gl;

// Measure baseline
const baselineMemory = process.memoryUsage();

const grid = generateHexGrid();
computeCoastDistances(grid);

const afterGrid = process.memoryUsage();

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

// Simulate multiple AI players each having their own target selection
const allCityNames = Object.keys(ctx.cityToMilepost);

// Simulate 5 AI players doing target selection in sequence (worst case for a solo game)
console.log('=== Memory Usage ===');
console.log(`Baseline heap: ${(baselineMemory.heapUsed / 1024 / 1024).toFixed(1)}MB`);
console.log(`After grid generation: ${(afterGrid.heapUsed / 1024 / 1024).toFixed(1)}MB`);
console.log(`Grid overhead: ${((afterGrid.heapUsed - baselineMemory.heapUsed) / 1024 / 1024).toFixed(1)}MB`);

// Run 5 sequential target selections (simulate 5 AI players)
console.log('\n=== CPU: 5 AI players doing target selection ===');
const start = process.hrtime.bigint();
for (let player = 0; player < 5; player++) {
    // Each player: ~656 findPath calls
    for (let i = 0; i < 656; i++) {
        const a = allCityNames[Math.floor(Math.random() * allCityNames.length)];
        let b = allCityNames[Math.floor(Math.random() * allCityNames.length)];
        while (b === a) b = allCityNames[Math.floor(Math.random() * allCityNames.length)];
        findPath(ctx, ctx.cityToMilepost[a], ctx.cityToMilepost[b], 'red', 'cheapest');
    }
}
const elapsed = Number(process.hrtime.bigint() - start) / 1e6;

const afterComputation = process.memoryUsage();
console.log(`Total time for 5 AI turns: ${(elapsed/1000).toFixed(1)}s`);
console.log(`Per AI turn: ${(elapsed/5/1000).toFixed(1)}s`);
console.log(`Peak heap after computation: ${(afterComputation.heapUsed / 1024 / 1024).toFixed(1)}MB`);
console.log(`RSS (total process memory): ${(afterComputation.rss / 1024 / 1024).toFixed(1)}MB`);
