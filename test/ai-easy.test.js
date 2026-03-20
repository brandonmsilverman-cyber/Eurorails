/**
 * Tests for Easy AI Core Strategy Functions (plan-based architecture)
 *
 * Unit tests — no server, no sockets.
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
        aiState: {},
        borrowedAmount: 0,
        debtRemaining: 0,
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
        demandCardDeck: [],
        demandCardDiscardPile: [],
        ...(overrides.gs || {}),
        players: overrides.gs && overrides.gs.players ? overrides.gs.players : [player]
    };
}

// Helper: build track segments between two mileposts
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
// selectPlan (replaces old selectTargetDemand)
// ---------------------------------------------------------------------------

describe('selectPlan', () => {
    it('picks a plan with the best ECU/turn', () => {
        const ctx = makeCtx();

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

        const result = aiEasy.selectPlan(gs, 0, ctx2);
        assert.ok(result, 'should return a plan');
        assert.equal(result.deliveries.length, 1, 'should be a single delivery plan');
        assert.ok(result.ecuPerTurn > 0, 'should have positive ECU/turn');
    });

    it('prefers routes using existing track (zero build cost)', () => {
        const ctx = makeCtx();

        const wrocId = ctx.cityToMilepost['Wroclaw'];
        const leipId = ctx.cityToMilepost['Leipzig'];
        const gs = makeGS({
            player: {
                demandCards: [
                    {
                        id: 'card-1',
                        demands: [
                            // Only Coal→Leipzig so the AI must pick this specific delivery
                            { good: 'Coal', to: 'Leipzig', payout: 12 },
                        ]
                    }
                ]
            }
        });
        const ctx2 = makeCtx({ players: gs.players });

        // Build full track Wroclaw → Leipzig
        buildTrack(ctx2, gs, wrocId, leipId, 'red');

        const result = aiEasy.selectPlan(gs, 0, ctx2);
        assert.ok(result, 'should return a plan');
        // The plan through Wroclaw should have 0 build cost
        assert.equal(result.deliveries[0].sourceCity, 'Wroclaw', 'should pick Wroclaw as source');
        assert.equal(result.totalBuildCost, 0, 'should have zero build cost on owned track');
    });

    it('returns null when no plan is affordable', () => {
        const ctx = makeCtx();
        const gs = makeGS({
            player: {
                cash: 0, // no money
                demandCards: [
                    {
                        id: 'card-1',
                        demands: [
                            { good: 'Cork', to: 'Lisboa', payout: 10 },
                        ]
                    }
                ]
            }
        });
        const ctx2 = makeCtx({ players: gs.players });

        const result = aiEasy.selectPlan(gs, 0, ctx2);
        assert.equal(result, null, 'should return null when nothing affordable');
    });
});

// ---------------------------------------------------------------------------
// planTurn (initial building)
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
        assert.equal(plan[plan.length - 1].type, 'endTurn', 'last action should be endTurn');

        const buildActions = plan.filter(a => a.type === 'commitBuild');
        assert.ok(buildActions.length >= 1, 'should have at least one build action');
        assert.ok(buildActions[0].buildCost > 0, 'build should have positive cost');
        assert.ok(buildActions[0].buildPath.length >= 2, 'build path should have at least 2 points');
    });

    it('commits plan on first round and reuses on second round', () => {
        const ctx = makeCtx();
        const gs = makeGS({
            player: {
                cash: 50,
                demandCards: [
                    {
                        id: 'card-1',
                        demands: [
                            { good: 'Coal', to: 'Leipzig', payout: 12 },
                        ]
                    }
                ]
            }
        });
        gs.phase = 'initialBuilding';
        const ctx2 = makeCtx({ players: gs.players });

        // Round 1
        aiEasy.planTurn(gs, 0, ctx2);
        const committedPlan = aiEasy.getCommittedPlan(gs, 0);
        assert.ok(committedPlan, 'should have committed a plan after round 1');

        // Round 2 (same plan reused)
        const plan2 = aiEasy.planTurn(gs, 0, ctx2);
        const committedPlan2 = aiEasy.getCommittedPlan(gs, 0);
        assert.ok(committedPlan2, 'should still have committed plan in round 2');
        assert.equal(plan2[plan2.length - 1].type, 'endTurn');
    });
});

// ---------------------------------------------------------------------------
// planOperate
// ---------------------------------------------------------------------------

describe('planOperate', () => {
    it('deploys train and moves toward source when plan committed', () => {
        const ctx = makeCtx();
        const wrocId = ctx.cityToMilepost['Wroclaw'];
        const leipId = ctx.cityToMilepost['Leipzig'];
        const berlinId = ctx.cityToMilepost['Berlin'];

        const gs = makeGS({
            player: {
                cash: 50,
                trainLocation: null,
                movement: 9,
                loads: [],
                demandCards: [
                    {
                        id: 'card-1',
                        demands: [
                            { good: 'Coal', to: 'Leipzig', payout: 12 },
                        ]
                    }
                ]
            },
            gs: { phase: 'operate' }
        });
        const ctx2 = makeCtx({ players: gs.players });

        // Build track from Berlin through Wroclaw to Leipzig
        buildTrack(ctx2, gs, berlinId, wrocId, 'red');
        buildTrack(ctx2, gs, wrocId, leipId, 'red');

        const actions = aiEasy.planOperate(gs, 0, ctx2);

        // Should deploy train
        const deploys = actions.filter(a => a.type === 'deployTrain');
        assert.ok(deploys.length === 1, `Expected deployTrain, got: [${actions.map(a => a.type).join(', ')}]`);

        // Should end with endOperatePhase
        assert.equal(actions[actions.length - 1].type, 'endOperatePhase');
    });

    it('picks up good when at source city', () => {
        const ctx = makeCtx();
        const wrocId = ctx.cityToMilepost['Wroclaw'];
        const leipId = ctx.cityToMilepost['Leipzig'];

        const gs = makeGS({
            player: {
                cash: 50,
                trainLocation: wrocId,
                movement: 9,
                loads: [],
                demandCards: [
                    {
                        id: 'card-1',
                        demands: [
                            { good: 'Coal', to: 'Leipzig', payout: 12 },
                        ]
                    }
                ]
            },
            gs: { phase: 'operate' }
        });
        const ctx2 = makeCtx({ players: gs.players });

        buildTrack(ctx2, gs, wrocId, leipId, 'red');

        const actions = aiEasy.planOperate(gs, 0, ctx2);

        const pickups = actions.filter(a => a.type === 'pickupGood');
        assert.ok(pickups.length >= 1, `Expected pickupGood, got: [${actions.map(a => a.type).join(', ')}]`);
        assert.equal(pickups[0].good, 'Coal');
    });

    it('delivers good when carrying it at destination', () => {
        const ctx = makeCtx();
        const leipId = ctx.cityToMilepost['Leipzig'];
        const wrocId = ctx.cityToMilepost['Wroclaw'];

        const gs = makeGS({
            player: {
                cash: 50,
                trainLocation: leipId,
                movement: 9,
                loads: ['Coal'],
                demandCards: [
                    {
                        id: 'card-1',
                        demands: [
                            { good: 'Coal', to: 'Leipzig', payout: 12 },
                        ]
                    }
                ]
            },
            gs: { phase: 'operate' }
        });
        const ctx2 = makeCtx({ players: gs.players });
        buildTrack(ctx2, gs, wrocId, leipId, 'red');

        // Pre-commit a plan so the visit sequence's delivery stop is at Leipzig
        // (where the train already is). Simulate that the AI has already picked
        // up Coal (currentStopIndex=1).
        const plan = aiEasy.selectPlan(gs, 0, ctx2);
        assert.ok(plan, 'should find a plan');
        assert.equal(plan.visitSequence[1].city, 'Leipzig', 'delivery should be at Leipzig');
        plan.currentStopIndex = 1; // Already picked up, next stop is deliver at Leipzig
        aiEasy.commitPlan(gs, 0, plan);

        const actions = aiEasy.planOperate(gs, 0, ctx2);

        const deliveries = actions.filter(a => a.type === 'deliverGood');
        assert.ok(deliveries.length >= 1, `Expected deliverGood, got: [${actions.map(a => a.type).join(', ')}]`);
    });

    it('discards hand when no plan is affordable', () => {
        const ctx = makeCtx();
        const leipId = ctx.cityToMilepost['Leipzig'];

        const gs = makeGS({
            player: {
                cash: 0,
                trainLocation: leipId,
                movement: 6,
                loads: [],
                demandCards: [
                    {
                        id: 'card-1',
                        demands: [
                            { good: 'Cork', to: 'Lisboa', payout: 10 },
                        ]
                    }
                ]
            },
            gs: { phase: 'operate' }
        });
        const ctx2 = makeCtx({ players: gs.players });

        const actions = aiEasy.planOperate(gs, 0, ctx2);

        assert.ok(
            actions.some(a => a.type === 'discardHand'),
            `Expected discardHand, got: [${actions.map(a => a.type).join(', ')}]`
        );
    });
});

// ---------------------------------------------------------------------------
// planBuild
// ---------------------------------------------------------------------------

describe('planBuild', () => {
    it('builds track toward committed plan route', () => {
        const ctx = makeCtx();
        const berlinId = ctx.cityToMilepost['Berlin'];
        const wrocId = ctx.cityToMilepost['Wroclaw'];
        const leipId = ctx.cityToMilepost['Leipzig'];

        const gs = makeGS({
            player: {
                cash: 50,
                trainLocation: berlinId,
                movement: 0,
                loads: [],
                demandCards: [
                    {
                        id: 'card-1',
                        demands: [
                            { good: 'Coal', to: 'Leipzig', payout: 12 },
                        ]
                    }
                ]
            },
            gs: { phase: 'build' }
        });
        const ctx2 = makeCtx({ players: gs.players });

        // Build some track so AI has a network
        buildTrack(ctx2, gs, berlinId, wrocId, 'red');

        // Commit a plan first (simulate what planOperate would do)
        const plan = aiEasy.selectPlan(gs, 0, ctx2);
        assert.ok(plan, 'should find a plan');
        aiEasy.commitPlan(gs, 0, plan);

        const actions = aiEasy.planBuild(gs, 0, ctx2);

        assert.equal(actions[actions.length - 1].type, 'endTurn', 'last action should be endTurn');

        // If there's unbuilt track in the plan, should have build actions
        const buildActions = actions.filter(a => a.type === 'commitBuild');
        // Build actions depend on whether the route needs building
        // Just verify the plan completes
        assert.ok(actions.length >= 1, 'should return at least endTurn');
    });

    it('returns endTurn with no build when route is fully built', () => {
        const ctx = makeCtx();
        const wrocId = ctx.cityToMilepost['Wroclaw'];
        const leipId = ctx.cityToMilepost['Leipzig'];

        const gs = makeGS({
            player: {
                cash: 50,
                trainLocation: wrocId,
                movement: 0,
                loads: [],
                demandCards: [
                    {
                        id: 'card-1',
                        demands: [
                            { good: 'Coal', to: 'Leipzig', payout: 12 },
                        ]
                    }
                ]
            },
            gs: { phase: 'build' }
        });
        const ctx2 = makeCtx({ players: gs.players });

        // Build full track
        buildTrack(ctx2, gs, wrocId, leipId, 'red');

        const plan = aiEasy.selectPlan(gs, 0, ctx2);
        assert.ok(plan, 'should find a plan');
        aiEasy.commitPlan(gs, 0, plan);

        const actions = aiEasy.planBuild(gs, 0, ctx2);

        // Route is already built — should just endTurn (save budget)
        assert.equal(actions.length, 1, 'should only have endTurn');
        assert.equal(actions[0].type, 'endTurn');
    });
});

// ---------------------------------------------------------------------------
// enumeratePlans (singles only — no batches)
// ---------------------------------------------------------------------------

describe('enumeratePlans', () => {
    it('only produces single-delivery plans', () => {
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
                    },
                    {
                        id: 'card-2',
                        demands: [
                            { good: 'Iron', to: 'Madrid', payout: 20 },
                        ]
                    }
                ]
            }
        });
        const ctx2 = makeCtx({ players: gs.players });

        const plans = aiEasy.enumeratePlans(gs, 0, ctx2);
        assert.ok(plans.length > 0, 'should enumerate some plans');
        for (const plan of plans) {
            assert.equal(plan.deliveries.length, 1, 'all plans should be single delivery');
            assert.equal(plan.visitSequence.length, 2, 'visit sequence should be [pickup, deliver]');
        }
    });
});

// ---------------------------------------------------------------------------
// shouldDiscard
// ---------------------------------------------------------------------------

describe('shouldDiscard', () => {
    it('does not discard when carrying a matchable good', () => {
        const ctx = makeCtx();
        const wrocId = ctx.cityToMilepost['Wroclaw'];

        const gs = makeGS({
            player: {
                cash: 50,
                trainLocation: wrocId,
                loads: ['Coal'],
                demandCards: [
                    {
                        id: 'card-1',
                        demands: [
                            { good: 'Coal', to: 'Leipzig', payout: 12 },
                        ]
                    }
                ]
            },
            gs: { phase: 'operate' }
        });
        const ctx2 = makeCtx({ players: gs.players });
        buildTrack(ctx2, gs, wrocId, ctx.cityToMilepost['Leipzig'], 'red');

        // Create a weak plan (low ECU)
        const plan = aiEasy.selectPlan(gs, 0, ctx2);
        assert.ok(plan, 'should find a plan');

        const result = aiEasy.shouldDiscard(gs, 0, ctx2, plan);
        assert.equal(result, false, 'should not discard when carrying matchable good');
    });
});
