// server/ai-easy.js
// Easy AI decision-making strategy module (singles only, no batching).
// Inherits all logic from ai-hard.js and overrides enumeratePlans to
// exclude 2-delivery batches. Everything else — plan commitment, movement
// loop, build ordering, endgame, event response — is identical.

const hard = require('./ai-hard');
const gl = require('../shared/game-logic');
const GOODS = gl.GOODS;
const MAJOR_CITIES = gl.MAJOR_CITIES;

// Override: enumerate only single-delivery plans (no batch pairing).
function enumeratePlans(gs, playerIndex, ctx, options) {
    const player = gs.players[playerIndex];
    const effectiveCash = (options && options.effectiveCash) || player.cash;
    const isInitialBuilding = !gs.tracks.some(t => t.color === player.color);

    const candidates = [];
    const excludeCards = (options && options.excludeCardIndices) || null;

    for (let ci = 0; ci < player.demandCards.length; ci++) {
        if (excludeCards && excludeCards.has(ci)) continue;
        const card = player.demandCards[ci];
        if (!card || !card.demands) continue;

        for (let di = 0; di < card.demands.length; di++) {
            const demand = card.demands[di];
            const destCity = demand.to;
            const destId = ctx.cityToMilepost[destCity];
            if (destId === undefined) continue;

            const sources = GOODS[demand.good] ? GOODS[demand.good].sources : [];

            for (const sourceCity of sources) {
                const srcId = ctx.cityToMilepost[sourceCity];
                if (srcId === undefined) continue;

                if (isInitialBuilding) {
                    for (const majorCity of MAJOR_CITIES) {
                        const majorId = ctx.cityToMilepost[majorCity];
                        if (majorId === undefined) continue;

                        const plan = hard.buildSinglePlan(
                            ctx, player, ci, di, demand, sourceCity, srcId,
                            destCity, destId, majorId, majorCity, effectiveCash
                        );
                        if (plan) candidates.push(plan);
                    }
                } else {
                    const plan = hard.buildSinglePlan(
                        ctx, player, ci, di, demand, sourceCity, srcId,
                        destCity, destId, null, null, effectiveCash
                    );
                    if (plan) candidates.push(plan);
                }
            }
        }
    }

    return candidates;
}

// Override: selectPlan must call our enumeratePlans (the hard AI's selectPlan
// calls its own enumeratePlans via lexical binding, not the strategy object).
function selectPlan(gs, playerIndex, ctx, options) {
    const player = gs.players[playerIndex];
    const candidates = enumeratePlans(gs, playerIndex, ctx, options);

    let bestPlan = null;
    let bestScore = -Infinity;

    for (const plan of candidates) {
        if (!hard.checkAffordability(plan, player, ctx, options)) continue;

        // Initial building reachability filter: cost to pickup 1 must be ≤ 40M
        if (plan.majorCity && plan.segments.length > 0) {
            const costToPickup1 = plan.segments[0].buildCost;
            if (costToPickup1 > 40) continue;
        }

        const score = hard.scorePlan(plan, player, gs, ctx, options);
        if (score > bestScore) {
            bestScore = score;
            bestPlan = plan;
        }
    }

    const affordable = candidates.filter(p => hard.checkAffordability(p, player, ctx, options));
    hard.logDecision(playerIndex, 'target selection',
        `Candidates: ${candidates.length} singles. ` +
        `Affordable: ${affordable.length}. Cash: ${(options && options.effectiveCash) || player.cash}M. ` +
        `Selected: ${hard.formatPlanSummary(bestPlan)}`
    );

    return bestPlan;
}

module.exports = {
    // Inherit everything from Hard AI
    ...hard,

    // Override: singles only, no batches
    enumeratePlans,
    selectPlan,
};
