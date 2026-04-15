# Eurorails — Feature Backlog

A running list of planned features, improvements, and known issues.

---

## Gameplay

- [ ] **AI hints system** — "What would an expert do?" suggestion feature for learning players
- [ ] **Train upgrade announcement modal** — Display a central modal when any player upgrades their train
## Reconnection Improvement
- [ ] **localStorage fallback for tab closure recovery** — Add localStorage as a fallback so reconnection credentials survive tab closure and incognito mode, while preserving multi-tab play. Full plan in [`LOCALSTORAGE_FALLBACK_PLAN.md`](LOCALSTORAGE_FALLBACK_PLAN.md).

---

## Map

- [ ] **Widen København–Göteborg land bridge** — Widen the landmass connecting the København landmass to the Göteborg landmass so that two tracks can be built through the corridor

---

## Bug Fixes

- [ ] **AI triple budget allocation misses best candidates** — The 200-triple evaluation budget (3-second time limit) is allocated top-down by pair ECU/turn: the best-scoring 2-delivery pairs get all the triple extension budget. With region-based pruning passing ~661 candidate triples, only ~30% are actually evaluated. A directionally-aligned triple built from a mediocre-scoring pair (rank 15+) is never generated because the budget is exhausted extending top-ranked pairs. Fix direction: pre-score candidate triples with a cheap heuristic (e.g. total payout / estimated trip distance from region centroids) before spending the budget on full `buildTripleBatchPlan` pathfinding. Alternatively, cap triples-per-pair at ~10 to spread the budget across more pairs, or make `buildTripleBatchPlan` cheaper to evaluate (cache shared path segments).


## Completed

- [x] Server + lobby (Phase 1)
- [x] Room expiry/cleanup (Phase 2)
- [x] Client/server state split (Phase 3)
- [x] Server-authoritative actions (Phase 4)
- [x] Demand card privacy (Phase 5)
- [x] Partial build/move with green/red path preview
- [x] Trackage rights (4M per opponent, paid to track owner)
- [x] Stranding prevention with delivery exception
- [x] Event card system
- [x] Ferry system
- [x] Train upgrades
- [x] Goods supply limits
- [x] Demand card system
- [x] Hosted on Render
- [x] Reconnection handling
- [x] Solo Mode: Lobby entry point
- [x] Solo Mode: AI opponent setup
- [x] Solo Mode: AI turn loop
- [x] Solo Mode: AI Easy difficulty
- [x] Derailment event load drop fix
- [x] Persistent Player UI Overhaul (demand cards, train card, highlight persistence, immediate card animations)
- [x] Ferry crossing doesn't stop movement at entry milepost
- [x] Cheapest/shortest route foreign track consideration
- [x] Basic gameplay instructions dropdown (How to Play tutorial)
- [x] Alps region — mountain pass corridors (Mont Cenis, Gotthard, Brenner)
- [x] Highlight demand-matching goods at pickup
- [x] More prominent goods pickup UI
- [x] Prominent cash display
- [x] Better turn phase and movement limit indicators
- [x] Shrink pickup button to match deliver button
- [x] Toggle to hide city production info (Map Icons toggle in Goods Legend)
- [x] In-game tutorial (guided walkthrough of core mechanics)
- [x] Save & Resume (decouple game from room, server-side save/load, resume lobby flow, localStorage convenience layer)
- [x] Zoom-out hover twitching fix (Chrome scroll-bar related)
- [x] AI Players in Multiplayer (lobby slots, turn routing, client UI, edge cases)
- [x] AI movement costs drastically undercharged (reversed paths / wormhole fix)
- [x] AI builds inefficient looping track (reversed path direction fix)
- [x] Configurable victory conditions (lobby UI, server validation, dynamic in-game display)
- [x] Configurable train speed tiers (Standard/Faster/Fastest lobby setting, dynamic MP lookup)
- [x] Build turn budget overstates available ECU fix
- [x] Demand card text overflow fix (inline pickup badge + deliver button)
- [x] Event banner text vertical centering fix
- [x] London-Amsterdam ferry endpoint repositioned
- [x] Spain access restricted (Pyrenees alpine region, eastern pass, Cantabrian mountains, Madrid area cleared)
- [x] Turn duration clock (count-up timer on train card, minimizable)
- [x] Add ferry building and usage to tutorial
- [x] Event descriptions list all effects (ferry building, gale derailment at ports)
- [x] Discard pile reshuffle
- [x] Overhaul demand card row hover effect (origin/destination distinct colors)
- [x] Borrowing (borrow up to 20M from bank, repay double via 10M-per-delivery deductions)
- [x] AI: Hard difficulty (opportunistic route batching, payout/cost build scoring, situational upgrades, active hand evaluation, deliberate ferry investment)
- [x] AI: Brutal difficulty (systematic multi-delivery planning, EV build calculations, optimal upgrade timing, EV-based discard decisions, full landmass access modeling)
- [x] Demand card city highlights persist across turn change fix
- [x] Persist suggested foreign track selection throughout a single operate phase
- [x] Set train destination (auto-move toward selected city each operate phase)
- [x] Improved trackage rights payment animation (coin arc transfer with fanned 4-coin stagger)
