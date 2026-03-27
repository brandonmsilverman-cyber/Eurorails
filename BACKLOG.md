# Eurorails — Feature Backlog

A running list of planned features, improvements, and known issues.

---

## Gameplay

- [ ] **Set train destination** — Player selects a city as their destination; the train automatically moves toward it each operate phase until it arrives, the player undoes movement, an event card disrupts it (i.e. derail or broken track), or the mode is turned off
- [ ] **Improved trackage rights payment animation** — Replace falling coins with a more polished visual for trackage rights transfers
- [ ] **AI hints system** — "What would an expert do?" suggestion feature for learning players
- [ ] **Persist suggested foreign track selection throughout a single operate phase**
## Reconnection Improvement
- [ ] **localStorage fallback for tab closure recovery** — Add localStorage as a fallback so reconnection credentials survive tab closure and incognito mode, while preserving multi-tab play. Full plan in [`LOCALSTORAGE_FALLBACK_PLAN.md`](LOCALSTORAGE_FALLBACK_PLAN.md).

---

## Bug Fixes

- [ ] **Demand card city highlights persist across turn change** — When hovering over a demand card row, source (blue) and destination (yellow) city highlights become persistent if they are visible when the player-to-player transition modal appears. Highlights should be cleared on turn change.
- [ ] **AI builds into major cities instead of out from them** — AI pathfinding sometimes builds toward a major city (paying the 5M city entry cost) instead of building outward from it (1M for the adjacent milepost). Example: AI 1 spent 5M for 4 mileposts building into Praha, when reversing the build direction would cost only 1M for the same connection

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
