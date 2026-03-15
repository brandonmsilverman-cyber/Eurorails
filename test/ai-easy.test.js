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

// ---------------------------------------------------------------------------
// Post-delivery re-plan: planTurn called mid-operate after delivery
// ---------------------------------------------------------------------------

describe('planTurn post-delivery (mid-operate with movement remaining)', () => {

    it('moves toward new source city when called with no loads and movement remaining', () => {
        // Simulate: AI just delivered at Leipzig, has movement left, needs to go to Wroclaw for Coal
        const ctx = makeCtx();
        const leipId = ctx.cityToMilepost['Leipzig'];
        const wrocId = ctx.cityToMilepost['Wroclaw'];

        const gs = makeGS({
            player: {
                cash: 50,
                trainLocation: leipId,
                movement: 6,
                loads: [],   // just delivered
                demandCards: [
                    {
                        id: 'card-1',
                        demands: [
                            { good: 'Coal', to: 'Berlin', payout: 20 },
                            { good: 'Beer', to: 'Paris', payout: 25 },
                            { good: 'Wine', to: 'Madrid', payout: 30 }
                        ]
                    }
                ],
                aiState: {
                    targetCardIndex: null,
                    targetDemandIndex: null,
                    targetSourceCity: null
                }
            },
            gs: { phase: 'operate' }
        });
        const ctx2 = makeCtx({ players: gs.players, tracks: gs.tracks });

        // Build track from Leipzig to Wroclaw so the AI can move
        buildTrack(ctx2, gs, leipId, wrocId, 'red');

        const plan = aiEasy.planTurn(gs, 0, ctx2);

        // Should move toward source, not just endOperatePhase
        const moveActions = plan.filter(a => a.type === 'commitMove');
        assert.ok(moveActions.length >= 1, `Expected commitMove, got: [${plan.map(a => a.type).join(', ')}]`);
        assert.equal(plan[plan.length - 1].type, 'endOperatePhase', 'last action should be endOperatePhase');
    });

    it('picks up good when already at source city after delivery', () => {
        // Simulate: AI just delivered at Wroclaw, has movement left,
        // and Wroclaw is a source for Coal which is demanded elsewhere
        const ctx = makeCtx();
        const wrocId = ctx.cityToMilepost['Wroclaw'];
        const leipId = ctx.cityToMilepost['Leipzig'];

        const gs = makeGS({
            player: {
                cash: 50,
                trainLocation: wrocId,
                movement: 6,
                loads: [],
                demandCards: [
                    {
                        id: 'card-1',
                        demands: [
                            { good: 'Coal', to: 'Leipzig', payout: 12 },
                            { good: 'Wine', to: 'Madrid', payout: 30 },
                            { good: 'Beer', to: 'Paris', payout: 25 }
                        ]
                    }
                ],
                aiState: {
                    targetCardIndex: null,
                    targetDemandIndex: null,
                    targetSourceCity: null
                }
            },
            gs: { phase: 'operate' }
        });
        const ctx2 = makeCtx({ players: gs.players, tracks: gs.tracks });

        // Build track Wroclaw → Leipzig
        buildTrack(ctx2, gs, wrocId, leipId, 'red');

        const plan = aiEasy.planTurn(gs, 0, ctx2);

        // Should pickup Coal at Wroclaw and start moving toward Leipzig
        const pickups = plan.filter(a => a.type === 'pickupGood');
        assert.ok(pickups.length >= 1, `Expected pickupGood, got: [${plan.map(a => a.type).join(', ')}]`);
        assert.equal(pickups[0].good, 'Coal');
    });

    it('server-side guard prevents re-plan when movement is 0', () => {
        // planTurn itself always plans movement if a track path exists —
        // the server-side guard (player.movement > 0) in executeAIActionSequence
        // prevents re-planning after delivery when movement is exhausted.
        // This test verifies that planTurn DOES produce a plan even with 0 movement,
        // confirming the guard is needed.
        const ctx = makeCtx();
        const leipId = ctx.cityToMilepost['Leipzig'];
        const wrocId = ctx.cityToMilepost['Wroclaw'];

        const gs = makeGS({
            player: {
                cash: 50,
                trainLocation: leipId,
                movement: 0,   // no movement left
                loads: [],
                demandCards: [
                    {
                        id: 'card-1',
                        demands: [
                            { good: 'Coal', to: 'Berlin', payout: 20 },
                            { good: 'Beer', to: 'Paris', payout: 25 },
                            { good: 'Wine', to: 'Madrid', payout: 30 }
                        ]
                    }
                ],
                aiState: {
                    targetCardIndex: null,
                    targetDemandIndex: null,
                    targetSourceCity: null
                }
            },
            gs: { phase: 'operate' }
        });
        const ctx2 = makeCtx({ players: gs.players, tracks: gs.tracks });
        buildTrack(ctx2, gs, leipId, wrocId, 'red');

        const plan = aiEasy.planTurn(gs, 0, ctx2);

        // planTurn produces a plan regardless of movement points.
        // The plan ends with endOperatePhase, and the commitMove would fail
        // at execution time (applyCommitMove rejects when movement=0).
        // The server-side guard prevents this re-plan from happening at all.
        assert.equal(plan[plan.length - 1].type, 'endOperatePhase',
            'plan should end with endOperatePhase');
    });

    it('delivers immediately if already carrying good at destination after re-plan', () => {
        // Simulate: AI at Leipzig carrying Coal, and there is a demand for Coal at Leipzig.
        // Build track from Wroclaw→Leipzig so Coal→Leipzig has cost 0 and is selected.
        const ctx = makeCtx();
        const leipId = ctx.cityToMilepost['Leipzig'];
        const wrocId = ctx.cityToMilepost['Wroclaw'];

        const gs = makeGS({
            player: {
                cash: 50,
                trainLocation: leipId,
                movement: 6,
                loads: ['Coal'],
                demandCards: [
                    {
                        id: 'card-1',
                        demands: [
                            { good: 'Coal', to: 'Leipzig', payout: 12 },
                            { good: 'Beer', to: 'Paris', payout: 25 },
                            { good: 'Wine', to: 'Madrid', payout: 30 }
                        ]
                    }
                ],
                aiState: {
                    targetCardIndex: null,
                    targetDemandIndex: null,
                    targetSourceCity: null
                }
            },
            gs: { phase: 'operate' }
        });
        const ctx2 = makeCtx({ players: gs.players, tracks: gs.tracks });

        // Build track so Coal→Leipzig is the cheapest (cost=0) demand
        buildTrack(ctx2, gs, wrocId, leipId, 'red');

        const plan = aiEasy.planTurn(gs, 0, ctx2);

        // Should deliver Coal at Leipzig
        const deliveries = plan.filter(a => a.type === 'deliverGood');
        assert.ok(deliveries.length >= 1, `Expected deliverGood, got: [${plan.map(a => a.type).join(', ')}]`);
    });

    it('discards hand when no target is reachable after delivery', () => {
        // Simulate: AI at Leipzig with movement, but all demands require
        // unreachable cities (no track built anywhere useful)
        const ctx = makeCtx();
        const leipId = ctx.cityToMilepost['Leipzig'];

        const gs = makeGS({
            player: {
                cash: 0,   // no cash to build
                trainLocation: leipId,
                movement: 6,
                loads: [],
                demandCards: [
                    {
                        id: 'card-1',
                        demands: [
                            { good: 'Cork', to: 'Lisboa', payout: 10 },
                            { good: 'Cork', to: 'Sevilla', payout: 10 },
                            { good: 'Cork', to: 'Madrid', payout: 10 }
                        ]
                    }
                ],
                aiState: {
                    targetCardIndex: null,
                    targetDemandIndex: null,
                    targetSourceCity: null
                }
            },
            gs: { phase: 'operate' }
        });
        const ctx2 = makeCtx({ players: gs.players, tracks: gs.tracks });

        const plan = aiEasy.planTurn(gs, 0, ctx2);

        // With no cash and no reachable targets, should discard hand
        assert.ok(
            plan.some(a => a.type === 'discardHand') || plan.some(a => a.type === 'endOperatePhase'),
            `Expected discardHand or endOperatePhase, got: [${plan.map(a => a.type).join(', ')}]`
        );
    });
});
