/**
 * Tests for Brutal AI Scoring Improvements
 *
 * Unit tests for network reusability scoring, network efficiency,
 * and the scorePlan override.
 * No server, no sockets. All synchronous.
 *
 * Run: node --test test/ai-brutal.test.js
 */

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');

const gl = require('../shared/game-logic');
const aiBrutal = require('../server/ai-brutal');
const aiHard = require('../server/ai-hard');

// ---------------------------------------------------------------------------
// Shared test fixtures
// ---------------------------------------------------------------------------

let grid;

before(() => {
    grid = gl.generateHexGrid();
});

function makeCtx(overrides = {}) {
    return {
        mileposts: grid.mileposts,
        mileposts_by_id: grid.mileposts_by_id,
        cityToMilepost: grid.cityToMilepost,
        ferryConnections: grid.ferryConnections,
        ferryOwnership: {},
        tracks: [],
        activeEvents: [],
        players: [],
        ...overrides
    };
}

function makePlayer(overrides = {}) {
    return {
        id: 'test-player',
        name: 'Brutal AI',
        color: 'red',
        cash: 50,
        trainType: 'Freight',
        trainLocation: null,
        demandCards: [],
        loads: [],
        movement: 9,
        ferryState: null,
        selectedDemands: [null, null, null],
        isAI: true,
        difficulty: 'brutal',
        aiState: {},
        borrowedAmount: 0,
        debtRemaining: 0,
        ...overrides
    };
}

function makeGS(playerOverrides = {}) {
    const player = makePlayer(playerOverrides);
    return {
        players: [player],
        tracks: playerOverrides.tracks || [],
        ferryOwnership: {},
        activeEvents: [],
        buildingPhaseCount: 0,
        buildingThisTurn: 0,
        majorCitiesThisTurn: 0,
        turn: 5,
        phase: 'build',
        currentPlayerIndex: 0,
        gameLog: [],
        buildHistory: [],
        gameSettings: { winCashThreshold: 250, winMajorCitiesRequired: 7, speedTier: 'Standard' }
    };
}

// ---------------------------------------------------------------------------
// computeNetworkEfficiency
// ---------------------------------------------------------------------------

describe('computeNetworkEfficiency', () => {
    it('returns 1.0 when build cost is zero', () => {
        const plan = { totalPayout: 20, totalBuildCost: 0 };
        assert.equal(aiBrutal.computeNetworkEfficiency(plan), 1.0);
    });

    it('returns 0.5 when build cost equals payout', () => {
        const plan = { totalPayout: 15, totalBuildCost: 15 };
        assert.equal(aiBrutal.computeNetworkEfficiency(plan), 0.5);
    });

    it('approaches 0 when build cost far exceeds payout', () => {
        const plan = { totalPayout: 5, totalBuildCost: 95 };
        const eff = aiBrutal.computeNetworkEfficiency(plan);
        assert.ok(eff < 0.1, `expected < 0.1, got ${eff}`);
    });
});

// ---------------------------------------------------------------------------
// computeNetworkValue
// ---------------------------------------------------------------------------

describe('computeNetworkValue', () => {
    it('returns 0 when all edges are already owned', () => {
        const ctx = makeCtx();
        const player = makePlayer();

        // Build a short path and add those edges as owned track
        const essenId = ctx.cityToMilepost['Essen'];
        const mp = ctx.mileposts_by_id[essenId];
        const neighborId = mp.neighbors[0];

        ctx.tracks = [
            { from: essenId, to: neighborId, color: player.color }
        ];

        const plan = { buildPath: [essenId, neighborId] };
        const proximityMap = aiBrutal.buildCityProximityMap(ctx, player);
        const value = aiBrutal.computeNetworkValue(plan, player, ctx, proximityMap);
        assert.equal(value, 0, 'no new edges means zero network value');
    });

    it('returns positive value for new edges near cities', () => {
        const ctx = makeCtx();
        const player = makePlayer();

        // Build a path near Essen (major city) — new edges, not owned
        const essenId = ctx.cityToMilepost['Essen'];
        const mp = ctx.mileposts_by_id[essenId];
        const neighborId = mp.neighbors[0];
        const neighbor2Mp = ctx.mileposts_by_id[neighborId];
        const neighbor2Id = neighbor2Mp.neighbors.find(n => n !== essenId);

        const plan = { buildPath: [essenId, neighborId, neighbor2Id] };
        const proximityMap = aiBrutal.buildCityProximityMap(ctx, player);
        const value = aiBrutal.computeNetworkValue(plan, player, ctx, proximityMap);
        assert.ok(value > 0, `expected positive value near Essen, got ${value}`);
    });
});

// ---------------------------------------------------------------------------
// scorePlan (override)
// ---------------------------------------------------------------------------

describe('scorePlan', () => {
    it('scores low-build-cost plan higher than high-build-cost plan with same payout', () => {
        const ctx = makeCtx();
        const player = makePlayer();
        const gs = makeGS();
        const proximityMap = aiBrutal.buildCityProximityMap(ctx, player);
        const options = { cityProximityMap: proximityMap };

        // Both plans have same payout but different build costs
        const cheapPlan = {
            deliveries: [{ cardIndex: 0, demandIndex: 0, sourceCity: 'Cardiff', destCity: 'London', good: 'Coal', payout: 20 }],
            visitSequence: [
                { city: 'Cardiff', action: 'pickup', deliveryIndex: 0, good: 'Coal' },
                { city: 'London', action: 'deliver', deliveryIndex: 0, cardIndex: 0, demandIndex: 0 }
            ],
            segments: [
                { from: 'Cardiff', to: 'London', buildCost: 0 }
            ],
            totalBuildCost: 0,
            totalPayout: 20,
            buildPath: [],
            tripDistance: 5,
            currentStopIndex: 0,
            totalBuildTurns: 0,
            operateTurns: 0,
            estimatedTurns: 0,
            ecuPerTurn: 0
        };

        const expensivePlan = {
            deliveries: [{ cardIndex: 0, demandIndex: 0, sourceCity: 'Cardiff', destCity: 'London', good: 'Coal', payout: 20 }],
            visitSequence: [
                { city: 'Cardiff', action: 'pickup', deliveryIndex: 0, good: 'Coal' },
                { city: 'London', action: 'deliver', deliveryIndex: 0, cardIndex: 0, demandIndex: 0 }
            ],
            segments: [
                { from: 'Cardiff', to: 'London', buildCost: 15 }
            ],
            totalBuildCost: 15,
            totalPayout: 20,
            buildPath: [],
            tripDistance: 5,
            currentStopIndex: 0,
            totalBuildTurns: 0,
            operateTurns: 0,
            estimatedTurns: 0,
            ecuPerTurn: 0
        };

        const cheapScore = aiBrutal.scorePlan(cheapPlan, player, gs, ctx, options);
        const expensiveScore = aiBrutal.scorePlan(expensivePlan, player, gs, ctx, options);

        assert.ok(cheapScore > expensiveScore,
            `cheap plan (${cheapScore}) should score higher than expensive plan (${expensiveScore})`);
    });

    it('passes endgame winning plans through unchanged', () => {
        const ctx = makeCtx();
        const player = makePlayer({ cash: 240 });
        const gs = makeGS({ cash: 240 });
        gs.players[0].cash = 240;

        // Set endgame mode
        const aiState = aiHard.getAIState(gs.players[0]);
        aiState.endgameMode = true;

        const proximityMap = aiBrutal.buildCityProximityMap(ctx, player);
        const options = { cityProximityMap: proximityMap };

        // A plan that would win (cash + payout >= 250)
        const winningPlan = {
            deliveries: [{ cardIndex: 0, demandIndex: 0, sourceCity: 'Cardiff', destCity: 'London', good: 'Coal', payout: 20 }],
            visitSequence: [
                { city: 'Cardiff', action: 'pickup', deliveryIndex: 0, good: 'Coal' },
                { city: 'London', action: 'deliver', deliveryIndex: 0, cardIndex: 0, demandIndex: 0 }
            ],
            segments: [
                { from: 'Cardiff', to: 'London', buildCost: 0 }
            ],
            totalBuildCost: 0,
            totalPayout: 20,
            buildPath: [],
            tripDistance: 3,
            currentStopIndex: 0,
            totalBuildTurns: 0,
            operateTurns: 0,
            estimatedTurns: 0,
            ecuPerTurn: 0
        };

        const hardScore = aiHard.scorePlan(winningPlan, gs.players[0], gs, ctx, options);
        // Reset ecuPerTurn so brutal can recompute
        winningPlan.ecuPerTurn = 0;
        winningPlan.totalBuildTurns = 0;
        winningPlan.operateTurns = 0;
        winningPlan.estimatedTurns = 0;
        const brutalScore = aiBrutal.scorePlan(winningPlan, gs.players[0], gs, ctx, options);

        // Endgame winning scores are >= 900 — brutal should not modify them
        if (hardScore >= 900) {
            assert.equal(brutalScore, hardScore,
                `endgame score should pass through unchanged: hard=${hardScore}, brutal=${brutalScore}`);
        }
    });

    it('scores plan through city-rich area higher than isolated area with same base ECU/turn', () => {
        const ctx = makeCtx();
        const player = makePlayer();
        const gs = makeGS();
        const proximityMap = aiBrutal.buildCityProximityMap(ctx, player);
        const options = { cityProximityMap: proximityMap };

        // Plan through central Europe (near Essen, a major city hub)
        const essenId = ctx.cityToMilepost['Essen'];
        const essenMp = ctx.mileposts_by_id[essenId];
        const centralNeighbor = essenMp.neighbors[0];
        const centralNeighbor2Mp = ctx.mileposts_by_id[centralNeighbor];
        const centralNeighbor2 = centralNeighbor2Mp.neighbors.find(n => n !== essenId);

        // Plan through isolated area (far from cities — use a remote milepost)
        // Find a milepost with low proximity value
        let isolatedStart = null;
        let isolatedMid = null;
        let isolatedEnd = null;
        for (const mp of ctx.mileposts) {
            if (mp.neighbors.length >= 2 && !mp.city && !(proximityMap.get(mp.id) > 0)) {
                const mid = ctx.mileposts_by_id[mp.neighbors[0]];
                if (mid && !mid.city && !(proximityMap.get(mid.id) > 0)) {
                    const end = mid.neighbors.find(n => n !== mp.id);
                    if (end && !(proximityMap.get(end) > 0)) {
                        isolatedStart = mp.id;
                        isolatedMid = mid.id;
                        isolatedEnd = end;
                        break;
                    }
                }
            }
        }

        // Skip test if we can't find isolated mileposts (unlikely but defensive)
        if (!isolatedStart) return;

        const centralPlan = {
            deliveries: [{ payout: 15 }],
            totalBuildCost: 5,
            totalPayout: 15,
            buildPath: [essenId, centralNeighbor, centralNeighbor2],
            tripDistance: 5,
            segments: [{ buildCost: 5 }],
            visitSequence: [
                { action: 'pickup', deliveryIndex: 0 },
                { action: 'deliver', deliveryIndex: 0 }
            ],
            currentStopIndex: 0,
            totalBuildTurns: 0, operateTurns: 0, estimatedTurns: 0, ecuPerTurn: 0
        };

        const isolatedPlan = {
            deliveries: [{ payout: 15 }],
            totalBuildCost: 5,
            totalPayout: 15,
            buildPath: [isolatedStart, isolatedMid, isolatedEnd],
            tripDistance: 5,
            segments: [{ buildCost: 5 }],
            visitSequence: [
                { action: 'pickup', deliveryIndex: 0 },
                { action: 'deliver', deliveryIndex: 0 }
            ],
            currentStopIndex: 0,
            totalBuildTurns: 0, operateTurns: 0, estimatedTurns: 0, ecuPerTurn: 0
        };

        const centralScore = aiBrutal.scorePlan(centralPlan, player, gs, ctx, options);
        const isolatedScore = aiBrutal.scorePlan(isolatedPlan, player, gs, ctx, options);

        assert.ok(centralScore > isolatedScore,
            `central plan (${centralScore}) should score higher than isolated plan (${isolatedScore})`);
    });
});
