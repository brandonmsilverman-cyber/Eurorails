# Eurorails — Feature Backlog

A running list of planned features, improvements, and known issues.

---

## Solo Mode

Solo mode branches from the main lobby as its own game type. The player creates a private room (accessible only to themselves and spectators, if supported). They can add up to 5 AI opponents that take turns just like human players.

- [ ] **AI: Hard difficulty** — Intelligent human-level play: opportunistic route batching, payout/cost build scoring with network awareness, situational upgrades, active hand evaluation, deliberate ferry investment
- [ ] **AI: Brutal difficulty** — Near-optimal play: systematic multi-delivery planning, expected-value build calculations over future hands, optimal upgrade timing, EV-based discard decisions, full landmass access modeling for ferries

## Gameplay

- [ ] **Borrowing** — A player may borrow up to ECU 20 from the bank at any time and immediately spend it on building or hold it in reserve. The player must pay back **double** the borrowed amount from all future delivery payoffs until the doubled debt is fully repaid. Per the official rules (p. 26, "Money" section), borrowing is intended as a safety valve for players who become trapped or unable to make progress. The loan is taken voluntarily; there is no forced borrowing.
- [ ] **Reset** — A player may completely restart their position at the beginning of their turn. Per the official rules (p. 26, "Reset" section): the player discards all Demand cards, removes all loads, returns all money to the bank, and erases all their track. They then receive a fresh Freight Loco card, ECU 50, and 3 new Demand cards. They may build up to ECU 20 on the reset turn and restart their train at any city at the beginning of their turn. Other players' track that was protected (from riding the resetting player's track) is not erased and remains for the rest of the game.
- [ ] **Backtracking** — A player may reverse their train's direction on any milepost (not just at cities) at a cost of losing 1 full turn. Per the official rules (p. 26, "Backtracking" section): a train which backtracks can move in any direction on its next turn. A train may not backtrack when the player has discarded their cards during the same turn. A train may backtrack if it cannot move for any other reason (e.g., Derailment or Rail Strike). A player whose train backtracks while on an opponent's track is assessed the use fee for that turn.
- [ ] **Discard pile reshuffle** — When the demand card deck runs out, reshuffle fulfilled/discarded demand cards back into the deck so the game never runs dry
- [ ] **Economy difficulty setting** — Add a pre-game room option with three economy modes (Standard, Constrained, Generous) that adjust demand card payout amounts and route length mix
- [ ] **Configurable victory conditions** — Allow the game room to customize win conditions before the game starts. Full plan in [`CONFIGURABLE_WIN_CONDITIONS_PLAN.md`](CONFIGURABLE_WIN_CONDITIONS_PLAN.md).
- [ ] **Set train destination** — Player selects a city as their destination; the train automatically moves toward it each operate phase until it arrives, the player undoes movement, or the mode is turned off
- [ ] **Faster train tier** — Add a 20+ speed train option to reduce late-game drag when players have long routes. Full plan in [`EXPRESS_TRAIN_PLAN.md`](EXPRESS_TRAIN_PLAN.md).
- [ ] **Turn countdown clock** — Optional time pressure element with a visible countdown timer per turn

## UI / Visual

- [ ] **Overhaul demand card row hover effect** — When hovering a demand card row, highlight origin and destination cities simultaneously on the map using distinct colors (e.g. one color for origin cities, another for the destination)
- [ ] **Event modal text should list all effects** — The persistent event banner at the top of the screen doesn't always describe every impact of the event (e.g. missing that rail building is disallowed in the affected area). Update event descriptions to fully enumerate all gameplay effects
- [ ] **Improved trackage rights payment animation** — Replace falling coins with a more polished visual for trackage rights transfers
- [ ] **AI hints system** — "What would an expert do?" suggestion feature for learning players
- [ ] **Add ferry building and usage to tutorial** — Explain how ferry routes work (building, costs, shared ownership, crossing) in the in-game tutorial

## Reconnection Improvement

- [ ] **localStorage fallback for tab closure recovery** — Add localStorage as a fallback so reconnection credentials survive tab closure and incognito mode, while preserving multi-tab play. Full plan in [`LOCALSTORAGE_FALLBACK_PLAN.md`](LOCALSTORAGE_FALLBACK_PLAN.md).

---

## Bug Fixes

- [ ] **Demand card text overflow** — Text in the bottom row of the demand card can extend past the bottom edge of the card due to "available here" banners pushing content down
- [ ] **Event banner text not vertically centered** — Text on map event title banners (e.g. "Snow: Torino") is not centered vertically within the banner
- [ ] **Build turn budget overstates available ECU** — Turn budget in actions panel shows 20 ECU even when the player has less money available in total ECU reserve
- [ ] **London-Amsterdam ferry endpoint misplaced** — The London-Amsterdam ferry endpoint appears in the middle of the UK (visual only); move it to a milepost on the east coast of the UK
- [ ] **AI builds into major cities instead of out from them** — AI pathfinding sometimes builds toward a major city (paying the 5M city entry cost) instead of building outward from it (1M for the adjacent milepost). Example: AI 1 spent 5M for 4 mileposts building into Praha, when reversing the build direction would cost only 1M for the same connection

## Balance / Gameplay Feedback

- [ ] **Small trip payouts too generous** — Early-game short deliveries may pay too much, making the opening phase too easy; consider tuning payout curves
- [ ] **Spain access too open** — Access routes into Spain could be more strategically restrictive to create meaningful geographic chokepoints
- [ ] **Faster train speed option** — Add a game room option for faster train speeds (12/16 MP instead of 9/12) for quicker games

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
