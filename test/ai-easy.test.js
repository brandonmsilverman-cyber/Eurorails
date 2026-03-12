/**
 * Tests for Phase 3 Step 3: Easy AI Core Strategy Functions
 *
 * 11 unit tests — no server, no sockets, no infinite loop risk.
 * All synchronous. Constructs game state and pathfinding ctx directly.
 *
 * Run: node --test test/ai-easy.test.js
 */

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');

const gl = require('../shared/game-logic');
const aiEasy = require('../server/ai-easy');

// ---------------------------------------------------------------------------
// Shared test fixtures
// ---------------------------------------------------------------------------

let grid; // { mileposts, mileposts_by_id, cityToMilepost, ferryConnections }

before(() => {
    grid = gl.generateHexGrid();
});

// Build a minimal pathfinding context from grid + optional overrides
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

// Build a minimal game state with one player
function makeGS(overrides = {}) {
    const player = {
        id: 'test-player',
        name: 'Test AI',
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
        difficulty: 'easy',
        aiState: {
            targetCardIndex: null,
            targetDemandIndex: null,
            targetSourceCity: null
        },
        ...(overrides.player || {})
    };
    return {
        players: [player],
        tracks: [],
        ferryOwnership: {},
        activeEvents: [],
        phase: 'initialBuilding',
        currentPlayerIndex: 0,
        buildingThisTurn: 0,
        majorCitiesThisTurn: 0,
        buildHistory: [],
        operateHistory: [],
        turn: 1,
        buildingPhaseCount: 0,
        gameLog: [],
        trackageRightsPaidThisTurn: {},
        trackageRightsLog: [],
        ...(overrides.gs || {}),
        players: overrides.gs && overrides.gs.players ? overrides.gs.players : [player]
    };
}

// Helper: build track segments between two mileposts (and all segments in the path)
function buildTrack(ctx, gs, fromId, toId, color) {
    const result = gl.findPath(ctx, fromId, toId, color, "cheapest");
    if (!result) return;
    for (let i = 0; i < result.path.length - 1; i++) {
        const seg = { from: result.path[i], to: result.path[i + 1], color };
        gs.tracks.push(seg);
        ctx.tracks.push(seg);
    }
    return result;
}

// ---------------------------------------------------------------------------
// 3a: selectTargetDemand
// ---------------------------------------------------------------------------

describe('selectTargetDemand', () => {
    it('picks the lowest-cost demand', () => {
        const ctx = makeCtx();

        // Coal: sources Wroclaw, Krakow, Cardiff
        // Leipzig is close to Wroclaw (~4 hexes through clear terrain)
        // Madrid is far from all Coal sources
        const gs = makeGS({
            player: {
                demandCards: [
                    {
                        id: 'card-1',
                        demands: [
                            { good: 'Coal', to: 'Madrid', payout: 30 },
                            { good: 'Coal', to: 'Leipzig', payout: 12 },
                            { good: 'Wine', to: 'Berlin', payout: 20 }
                        ]
                    }
                ]
            }
        });
        const ctx2 = makeCtx({ players: gs.players });

        const result = aiEasy.selectTargetDemand(gs, 0, ctx2);
        assert.ok(result, 'should return a target');
        // Leipzig should be cheaper than Madrid (shorter route from Wroclaw)
        assert.equal(result.demandIndex, 1, 'should pick Leipzig (cheapest coal destination)');
    });

    it('prefers routes using existing track', () => {
        const ctx = makeCtx();

        // Build track from Wroclaw toward Leipzig
        const wrocId = ctx.cityToMilepost['Wroclaw'];
        const leipId = ctx.cityToMilepost['Leipzig'];
        const gs = makeGS({
            player: {
                demandCards: [
                    {
                        id: 'card-1',
                        demands: [
                            { good: 'Coal', to: 'Leipzig', payout: 12 },
                            { good: 'Coal', to: 'Praha', payout: 15 },
                            { good: 'Wine', to: 'Berlin', payout: 20 }
                        ]
                    }
                ]
            }
        });
        const ctx2 = makeCtx({ players: gs.players });

        // Build full track Wroclaw → Leipzig
        buildTrack(ctx2, gs, wrocId, leipId, 'red');

        const result = aiEasy.selectTargetDemand(gs, 0, ctx2);
        assert.ok(result, 'should return a target');
        // With full track built, Coal to Leipzig costs 0
        assert.equal(result.demandIndex, 0, 'should prefer demand with existing track');
        assert.equal(result.cost, 0, 'should have zero build cost on owned track');
    });
});

// ---------------------------------------------------------------------------
// 3b: computeReserveFloor
// ---------------------------------------------------------------------------

describe('computeReserveFloor', () => {
    it('returns minimum completion cost', () => {
        const ctx = makeCtx();
        const gs = makeGS({
            player: {
                demandCards: [
                    {
                        id: 'card-1',
                        demands: [
                            { good: 'Coal', to: 'Madrid', payout: 30 },
                            { good: 'Coal', to: 'Leipzig', payout: 12 },
                            { good: 'Beer', to: 'Berlin', payout: 15 }
                        ]
                    }
                ]
            }
        });
        const ctx2 = makeCtx({ players: gs.players });

        const floor = aiEasy.computeReserveFloor(gs, 0, ctx2);
        assert.ok(typeof floor === 'number', 'should return a number');
        assert.ok(floor > 0, 'should be positive for a hand with unbuilt routes');
        // The floor should be less than or equal to the cost of the cheapest demand
        // (Coal Wroclaw → Leipzig is short)
        assert.ok(floor <= 20, 'Wroclaw-Leipzig is short, floor should be reasonable');
    });

    it('shrinks as track is built', () => {
        const ctx = makeCtx();
        const gs = makeGS({
            player: {
                demandCards: [
                    {
                        id: 'card-1',
                        demands: [
                            { good: 'Coal', to: 'Leipzig', payout: 12 },
                            { good: 'Beer', to: 'Berlin', payout: 15 },
                            { good: 'Wine', to: 'Paris', payout: 25 }
                        ]
                    }
                ]
            }
        });
        const ctx2 = makeCtx({ players: gs.players });

        const floorBefore = aiEasy.computeReserveFloor(gs, 0, ctx2);

        // Build track from Wroclaw toward Leipzig
        const wrocId = ctx2.cityToMilepost['Wroclaw'];
        const leipId = ctx2.cityToMilepost['Leipzig'];
        buildTrack(ctx2, gs, wrocId, leipId, 'red');

        const floorAfter = aiEasy.computeReserveFloor(gs, 0, ctx2);
        assert.ok(floorAfter < floorBefore, `floor should shrink: ${floorAfter} < ${floorBefore}`);
    });

    it('returns 0 when delivery is fully built', () => {
        const ctx = makeCtx();
        const gs = makeGS({
            player: {
                demandCards: [
                    {
                        id: 'card-1',
                        demands: [
                            { good: 'Coal', to: 'Leipzig', payout: 12 },
                            { good: 'Beer', to: 'Berlin', payout: 15 },
                            { good: 'Wine', to: 'Paris', payout: 25 }
                        ]
                    }
                ]
            }
        });
        const ctx2 = makeCtx({ players: gs.players });

        // Build full track Wroclaw → Leipzig
        const wrocId = ctx2.cityToMilepost['Wroclaw'];
        const leipId = ctx2.cityToMilepost['Leipzig'];
        buildTrack(ctx2, gs, wrocId, leipId, 'red');

        const floor = aiEasy.computeReserveFloor(gs, 0, ctx2);
        assert.equal(floor, 0, 'floor should be 0 when a route is fully built');
    });
});

// ---------------------------------------------------------------------------
// 3c: isStuck
// ---------------------------------------------------------------------------

describe('isStuck', () => {
    it('returns false when delivery is completable', () => {
        const ctx = makeCtx();
        const gs = makeGS({
            player: {
                cash: 50,
                demandCards: [
                    {
                        id: 'card-1',
                        demands: [
                            { good: 'Coal', to: 'Leipzig', payout: 12 },
                            { good: 'Beer', to: 'Berlin', payout: 15 },
                            { good: 'Wine', to: 'Paris', payout: 25 }
                        ]
                    }
                ]
            }
        });
        const ctx2 = makeCtx({ players: gs.players });

        const stuck = aiEasy.isStuck(gs, 0, ctx2);
        assert.equal(stuck, false, 'should not be stuck with 50 cash and short routes available');
    });

    it('returns true when no delivery is affordable', () => {
        const ctx = makeCtx();
        // Give AI only 1 cash — can't build anything meaningful
        // Use demands that require crossing water (expensive ferry)
        const gs = makeGS({
            player: {
                cash: 1,
                trainLocation: null,
                demandCards: [
                    {
                        id: 'card-1',
                        demands: [
                            { good: 'Coal', to: 'London', payout: 30 },
                            { good: 'Coal', to: 'Aberdeen', payout: 25 },
                            { good: 'Wine', to: 'Glasgow', payout: 35 }
                        ]
                    }
                ]
            }
        });
        const ctx2 = makeCtx({ players: gs.players });

        const stuck = aiEasy.isStuck(gs, 0, ctx2);
        assert.equal(stuck, true, 'should be stuck with only 1 cash and expensive routes');
    });

    it('returns false when carrying a deliverable good', () => {
        const ctx = makeCtx();

        // Build track from Wroclaw to Leipzig, deploy train at Leipzig with Coal loaded
        const wrocId = ctx.cityToMilepost['Wroclaw'];
        const leipId = ctx.cityToMilepost['Leipzig'];

        const gs = makeGS({
            player: {
                cash: 0,
                trainLocation: wrocId,
                loads: ['Coal'],
                demandCards: [
                    {
                        id: 'card-1',
                        demands: [
                            { good: 'Coal', to: 'Leipzig', payout: 12 },
                            { good: 'Beer', to: 'London', payout: 25 },
                            { good: 'Wine', to: 'Glasgow', payout: 35 }
                        ]
                    }
                ]
            }
        });
        const ctx2 = makeCtx({ players: gs.players });
        buildTrack(ctx2, gs, wrocId, leipId, 'red');

        const stuck = aiEasy.isStuck(gs, 0, ctx2);
        assert.equal(stuck, false, 'should not be stuck when carrying a deliverable good on owned track');
    });
});

// ---------------------------------------------------------------------------
// 3c: getRecoveryPlan
// ---------------------------------------------------------------------------

describe('getRecoveryPlan', () => {
    it('Priority 1: carrying deliverable good returns move + deliver', () => {
        const ctx = makeCtx();

        const wrocId = ctx.cityToMilepost['Wroclaw'];
        const leipId = ctx.cityToMilepost['Leipzig'];

        const gs = makeGS({
            player: {
                cash: 0,
                trainLocation: wrocId,
                loads: ['Coal'],
                demandCards: [
                    {
                        id: 'card-1',
                        demands: [
                            { good: 'Coal', to: 'Leipzig', payout: 12 },
                            { good: 'Beer', to: 'London', payout: 25 },
                            { good: 'Wine', to: 'Glasgow', payout: 35 }
                        ]
                    }
                ]
            }
        });
        const ctx2 = makeCtx({ players: gs.players });
        buildTrack(ctx2, gs, wrocId, leipId, 'red');

        const plan = aiEasy.getRecoveryPlan(gs, 0, ctx2);
        assert.ok(plan.length >= 2, 'should have at least 2 actions');
        assert.equal(plan[0].type, 'commitMove', 'first action should be move');
        assert.equal(plan[1].type, 'deliverGood', 'second action should be deliver');
        assert.equal(plan[1].cardIndex, 0);
        assert.equal(plan[1].demandIndex, 0);
    });

    it('Priority 2: track-only delivery returns move + pickup + move + deliver', () => {
        const ctx = makeCtx();

        // Build track Wroclaw → Leipzig, train at some point on the track
        const wrocId = ctx.cityToMilepost['Wroclaw'];
        const leipId = ctx.cityToMilepost['Leipzig'];

        const gs = makeGS({
            player: {
                cash: 0,
                trainLocation: leipId, // at Leipzig, need to go to Wroclaw for Coal, then back
                loads: [],
                demandCards: [
                    {
                        id: 'card-1',
                        demands: [
                            { good: 'Coal', to: 'Leipzig', payout: 12 },
                            { good: 'Beer', to: 'London', payout: 25 },
                            { good: 'Wine', to: 'Glasgow', payout: 35 }
                        ]
                    }
                ]
            }
        });
        const ctx2 = makeCtx({ players: gs.players });
        buildTrack(ctx2, gs, wrocId, leipId, 'red');

        const plan = aiEasy.getRecoveryPlan(gs, 0, ctx2);
        assert.ok(plan.length >= 4, 'should have at least 4 actions');
        assert.equal(plan[0].type, 'commitMove', 'move to source');
        assert.equal(plan[1].type, 'pickupGood', 'pickup good');
        assert.equal(plan[1].good, 'Coal');
        assert.equal(plan[2].type, 'commitMove', 'move to destination');
        assert.equal(plan[3].type, 'deliverGood', 'deliver good');
    });

    it('Priority 4: discard as last resort', () => {
        const ctx = makeCtx();

        // No track, no cash, demands for unreachable cities
        const gs = makeGS({
            player: {
                cash: 0,
                trainLocation: null,
                loads: [],
                demandCards: [
                    {
                        id: 'card-1',
                        demands: [
                            { good: 'Coal', to: 'London', payout: 30 },
                            { good: 'Beer', to: 'Aberdeen', payout: 25 },
                            { good: 'Wine', to: 'Glasgow', payout: 35 }
                        ]
                    }
                ]
            }
        });
        const ctx2 = makeCtx({ players: gs.players });

        const plan = aiEasy.getRecoveryPlan(gs, 0, ctx2);
        assert.equal(plan.length, 1, 'should have exactly 1 action');
        assert.equal(plan[0].type, 'discardHand', 'should discard hand as last resort');
    });
});

// ---------------------------------------------------------------------------
// 3d: planTurn (initial building)
// ---------------------------------------------------------------------------

describe('planTurn', () => {
    it('returns build + endTurn during initialBuilding', () => {
        const ctx = makeCtx();
        const gs = makeGS({
            player: {
                cash: 50,
                demandCards: [
                    {
                        id: 'card-1',
                        demands: [
                            { good: 'Coal', to: 'Leipzig', payout: 12 },
                            { good: 'Beer', to: 'Berlin', payout: 15 },
                            { good: 'Wine', to: 'Paris', payout: 25 }
                        ]
                    }
                ]
            }
        });
        gs.phase = 'initialBuilding';
        const ctx2 = makeCtx({ players: gs.players });

        const plan = aiEasy.planTurn(gs, 0, ctx2);
        assert.ok(plan.length >= 2, 'should have at least 2 actions');

        // Last action should be endTurn
        assert.equal(plan[plan.length - 1].type, 'endTurn', 'last action should be endTurn');

        // First action should be commitBuild (if AI can afford to build)
        const buildActions = plan.filter(a => a.type === 'commitBuild');
        assert.ok(buildActions.length >= 1, 'should have at least one build action');
        assert.ok(buildActions[0].buildCost > 0, 'build should have positive cost');
        assert.ok(buildActions[0].buildPath.length >= 2, 'build path should have at least 2 points');
    });
});
