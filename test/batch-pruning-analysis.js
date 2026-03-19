#!/usr/bin/env node
// Batch pruning analysis: how many good batch pairs does the pruning rule keep?
//
// For each simulated hand of 3 demand cards (9 demands), we:
// 1. Enumerate all single delivery candidates (demand × source city)
// 2. Enumerate all pairs
// 3. Check which pairs pass the pruning rule (shared city OR city within N hexes of other's route)
// 4. Report stats on how many pairs are kept vs discarded
//
// We also check: of the "good" batches (where combining saves significant distance),
// how many does the pruning rule catch?

const gl = require('../shared/game-logic');
const CITIES = gl.CITIES;
const GOODS = gl.GOODS;
const MAJOR_CITIES = gl.MAJOR_CITIES;

// Build city position lookup
const cityPos = {};
for (const [name, data] of Object.entries(CITIES)) {
    cityPos[name] = { x: data.x, y: data.y };
}

function dist(cityA, cityB) {
    const a = cityPos[cityA];
    const b = cityPos[cityB];
    if (!a || !b) return Infinity;
    return Math.hypot(a.x - b.x, a.y - b.y);
}

// Check if a point is within `threshold` hex distance of the line segment from A to B
// Approximate: check if the point is within threshold of any point on the route
// Simplified: use perpendicular distance from point to line segment
function pointToSegmentDist(px, py, ax, ay, bx, by) {
    const dx = bx - ax;
    const dy = by - ay;
    const lenSq = dx * dx + dy * dy;
    if (lenSq === 0) return Math.hypot(px - ax, py - ay);
    let t = ((px - ax) * dx + (py - ay) * dy) / lenSq;
    t = Math.max(0, Math.min(1, t));
    const projX = ax + t * dx;
    const projY = ay + t * dy;
    return Math.hypot(px - projX, py - projY);
}

// Check if a city is "near" the route of a delivery (source → dest)
// Using perpendicular distance to the straight line as a proxy for route proximity
function cityNearRoute(city, routeSrc, routeDest, threshold) {
    const p = cityPos[city];
    const a = cityPos[routeSrc];
    const b = cityPos[routeDest];
    if (!p || !a || !b) return false;
    return pointToSegmentDist(p.x, p.y, a.x, a.y, b.x, b.y) <= threshold;
}

// Generate a random demand (simplified version of the game's demand generation)
function randomDemand() {
    const goodNames = Object.keys(GOODS);
    const good = goodNames[Math.floor(Math.random() * goodNames.length)];
    const sources = GOODS[good].sources;
    const source = sources[Math.floor(Math.random() * sources.length)];

    // Pick a random destination that isn't a source of this good
    const allCities = Object.keys(CITIES);
    const validDests = allCities.filter(c => !sources.includes(c));
    const dest = validDests[Math.floor(Math.random() * validDests.length)];

    const d = dist(source, dest);
    const chips = GOODS[good].chips || 3;
    const rarityBonus = chips === 3 ? 1.12 : 1.0;
    const payout = Math.round((5 + Math.pow(d, 1.3) * 0.25) * rarityBonus);

    return { good, source, dest, payout, distance: d };
}

// Generate a hand of 3 demand cards (9 demands)
function randomHand() {
    const demands = [];
    for (let i = 0; i < 9; i++) {
        demands.push(randomDemand());
    }
    return demands;
}

// Expand demands into single candidates (each demand × each source for that good)
function expandToSingles(demands) {
    const singles = [];
    for (let i = 0; i < demands.length; i++) {
        const d = demands[i];
        const sources = GOODS[d.good].sources;
        for (const src of sources) {
            singles.push({
                demandIndex: i,
                good: d.good,
                source: src,
                dest: d.dest,
                payout: d.payout
            });
        }
    }
    return singles;
}

// Check if a pair passes the pruning rule
function passesPruning(a, b, threshold) {
    // Rule 1: shared city
    if (a.source === b.source || a.source === b.dest ||
        a.dest === b.source || a.dest === b.dest) {
        return 'shared_city';
    }

    // Rule 2: any city of B is near A's route, or vice versa
    if (cityNearRoute(b.source, a.source, a.dest, threshold) ||
        cityNearRoute(b.dest, a.source, a.dest, threshold) ||
        cityNearRoute(a.source, b.source, b.dest, threshold) ||
        cityNearRoute(a.dest, b.source, b.dest, threshold)) {
        return 'near_route';
    }

    return false;
}

// Evaluate if a batch is "genuinely good" — combined trip distance is significantly
// less than doing them separately
function batchQuality(a, b) {
    // Separate: src_a → dest_a + src_b → dest_b
    const separateDist = dist(a.source, a.dest) + dist(b.source, b.dest);

    // Combined best case: try both orderings
    // Order 1: src_a → dest_a → src_b → dest_b
    const combined1 = dist(a.source, a.dest) + dist(a.dest, b.source) + dist(b.source, b.dest);
    // Order 2: src_b → dest_b → src_a → dest_a
    const combined2 = dist(b.source, b.dest) + dist(b.dest, a.source) + dist(a.source, a.dest);
    // Order 3: src_a → src_b → dest_a → dest_b (pick up both, then deliver)
    const combined3 = dist(a.source, b.source) + dist(b.source, a.dest) + dist(a.dest, b.dest);
    // Order 4: src_b → src_a → dest_b → dest_a
    const combined4 = dist(b.source, a.source) + dist(a.source, b.dest) + dist(b.dest, a.dest);

    const bestCombined = Math.min(combined1, combined2, combined3, combined4);
    const savings = separateDist - bestCombined;
    const savingsPercent = savings / separateDist;

    return { separateDist, bestCombined, savings, savingsPercent };
}

// Run simulation
const NUM_SIMULATIONS = 10000;
const THRESHOLDS = [3, 5, 7, 10];
const GOOD_BATCH_THRESHOLD = 0.15; // 15% distance savings = "good" batch

console.log(`Running ${NUM_SIMULATIONS} simulated hands...\n`);

for (const threshold of THRESHOLDS) {
    let totalPairs = 0;
    let keptPairs = 0;
    let keptBySharedCity = 0;
    let keptByNearRoute = 0;

    let goodBatches = 0;
    let goodBatchesKept = 0;
    let goodBatchesMissed = 0;

    let greatBatches = 0; // >25% savings
    let greatBatchesKept = 0;

    for (let sim = 0; sim < NUM_SIMULATIONS; sim++) {
        const hand = randomHand();
        const singles = expandToSingles(hand);

        for (let i = 0; i < singles.length; i++) {
            for (let j = i + 1; j < singles.length; j++) {
                // Skip pairs from the same demand
                if (singles[i].demandIndex === singles[j].demandIndex) continue;

                totalPairs++;

                const quality = batchQuality(singles[i], singles[j]);
                const isGood = quality.savingsPercent >= GOOD_BATCH_THRESHOLD;
                const isGreat = quality.savingsPercent >= 0.25;

                if (isGood) goodBatches++;
                if (isGreat) greatBatches++;

                const pruneResult = passesPruning(singles[i], singles[j], threshold);
                if (pruneResult) {
                    keptPairs++;
                    if (pruneResult === 'shared_city') keptBySharedCity++;
                    else keptByNearRoute++;

                    if (isGood) goodBatchesKept++;
                    if (isGreat) greatBatchesKept++;
                } else {
                    if (isGood) goodBatchesMissed++;
                }
            }
        }
    }

    console.log(`=== Threshold: ${threshold} hexes ===`);
    console.log(`Total pairs evaluated: ${totalPairs}`);
    console.log(`Pairs kept: ${keptPairs} (${(keptPairs/totalPairs*100).toFixed(1)}%)`);
    console.log(`  By shared city: ${keptBySharedCity} (${(keptBySharedCity/totalPairs*100).toFixed(1)}%)`);
    console.log(`  By near route: ${keptByNearRoute} (${(keptByNearRoute/totalPairs*100).toFixed(1)}%)`);
    console.log(`Good batches (>15% savings): ${goodBatches} total`);
    console.log(`  Kept: ${goodBatchesKept} (${(goodBatchesKept/goodBatches*100).toFixed(1)}%)`);
    console.log(`  Missed: ${goodBatchesMissed} (${(goodBatchesMissed/goodBatches*100).toFixed(1)}%)`);
    console.log(`Great batches (>25% savings): ${greatBatches} total`);
    console.log(`  Kept: ${greatBatchesKept} (${(greatBatchesKept/greatBatches*100).toFixed(1)}%)`);
    console.log(`Avg pairs kept per hand: ${(keptPairs/NUM_SIMULATIONS).toFixed(1)}`);
    console.log('');
}
