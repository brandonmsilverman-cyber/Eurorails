# Plan: Express Train Tier

## Context

The current max train speed is 12mp (Superfreight / Fast Freight). Late-game turns with long routes feel slow. This feature adds an "Express" tier beyond Superfreight with 20mp speed, giving players a meaningful late-game upgrade that reduces drag.

---

## Stats

| Train | Movement | Capacity | Upgrade Cost |
|-------|----------|----------|-------------|
| Freight | 9 | 2 | — |
| Fast Freight | 12 | 2 | 20 |
| Heavy Freight | 9 | 3 | 20 |
| Superfreight | 12 | 3 | 20 |
| **Express** | **20** | **3** | **40** |

Upgrade path: Superfreight → Express (only). Requires 3 total upgrades (60+ ECU) from Freight.

**Design rationale:**
- 20mp is a 67% jump from 12mp — meaningful but not game-breaking
- Capacity stays at 3 (same as Superfreight) — the value is pure speed
- 40 ECU cost (double normal) makes it a genuine late-game investment
- Ferry crossing yields 10mp (Math.floor(20/2)), still less than Superfreight's normal 12mp

## shared/game-logic.js

1. **Add Express to `TRAIN_TYPES`** (line 108):
   ```js
   "Express": { movement: 20, capacity: 3 }
   ```
2. **Add new constants**:
   ```js
   var UPGRADE_COSTS = {
       "Fast Freight": 20, "Heavy Freight": 20,
       "Superfreight": 20, "Express": 40
   };
   var UPGRADE_PATHS = {
       "Freight": ["Fast Freight", "Heavy Freight"],
       "Fast Freight": ["Superfreight"],
       "Heavy Freight": ["Superfreight"],
       "Superfreight": ["Express"],
       "Express": []
   };
   ```
3. **Export** both new constants in the exports block (~line 1537)

## server/ai-actions.js

1. **`applyUpgradeTo`** (~line 45) — Use `gl.UPGRADE_COSTS[trainType]` instead of hardcoded 20. Add upgrade path validation:
   ```js
   const validUpgrades = gl.UPGRADE_PATHS[player.trainType] || [];
   if (!validUpgrades.includes(trainType)) return { success: false, error: 'Invalid upgrade path' };
   ```

## server/ai-easy.js

1. **Upgrade logic** (~line 720) — Add Express to upgrade order. Use higher cash threshold (120) for Express due to 40 ECU cost:
   ```js
   if (current === 'Superfreight' && player.cash > 120) { nextType = 'Express'; }
   ```

## public/eurorails.html

1. **`getUpgradeOptions`** (line 4089) — Add Superfreight → Express option with cost 40
2. **Upgrade button rendering** (~line 5008) — Use per-upgrade cost from options instead of hardcoded 20
3. **`upgradeTo`** (line 4056) — Local fallback: look up cost from `UPGRADE_COSTS`

## Implementation Order

1. `shared/game-logic.js` — Express + UPGRADE_COSTS + UPGRADE_PATHS + exports
2. `server/ai-actions.js` — Variable costs + path validation in applyUpgradeTo
3. `server/ai-easy.js` — AI upgrade logic for Express
4. `public/eurorails.html` — getUpgradeOptions, upgradeTo costs, upgrade button rendering

## Verification

1. Start server (`npm start`), create a game, play to Superfreight
2. Verify Express upgrade button appears with "40 ECU" cost
3. Upgrade to Express — confirm 20mp movement in operate phase
4. Test ferry crossing with Express — should get 10mp (Math.floor(20/2))
5. Test event zone movement — 2mp per step still applies, so 10 steps max in snow/fog
6. Add AI opponent — observe AI eventually upgrades to Express when cash > 120
7. Load a saved game from before this feature — no errors, no Express references
