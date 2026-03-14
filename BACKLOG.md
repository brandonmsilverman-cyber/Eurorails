# Eurorails — Feature Backlog

A running list of planned features, improvements, and known issues.

---

## Solo Mode

Solo mode branches from the main lobby as its own game type. The player creates a private room (accessible only to themselves and spectators, if supported). They can add up to 5 AI opponents that take turns just like human players.

- [ ] **AI: Hard difficulty** — Intelligent human-level play: opportunistic route batching, payout/cost build scoring with network awareness, situational upgrades, active hand evaluation, deliberate ferry investment
- [ ] **AI: Brutal difficulty** — Near-optimal play: systematic multi-delivery planning, expected-value build calculations over future hands, optimal upgrade timing, EV-based discard decisions, full landmass access modeling for ferries

## AI Players in Multiplayer

Allow the host to fill empty multiplayer slots with AI opponents so games can start without a full human lobby. The AI engine already exists — this is mostly lobby wiring and turn routing. Full plan in [`AI_MULTIPLAYER_PLAN.md`](AI_MULTIPLAYER_PLAN.md).

- [ ] **AI player slots in lobby** — Host can add/remove AI players to open slots, choosing color and difficulty
- [ ] **Turn routing** — Server detects AI turns and calls `executeAITurn()` instead of waiting for socket input; skip turn timer for AI
- [ ] **Client UI** — Show AI players distinctly in lobby and in-game, with add/remove controls for the host
- [ ] **Edge cases** — Room cleanup when all humans leave, skip disconnect/reconnect logic for AI

## Gameplay

- [ ] **Borrowing** — A player may borrow up to ECU 20 from the bank at any time and immediately spend it on building or hold it in reserve. The player must pay back **double** the borrowed amount from all future delivery payoffs until the doubled debt is fully repaid. Per the official rules (p. 26, "Money" section), borrowing is intended as a safety valve for players who become trapped or unable to make progress. The loan is taken voluntarily; there is no forced borrowing.
- [ ] **Reset** — A player may completely restart their position at the beginning of their turn. Per the official rules (p. 26, "Reset" section): the player discards all Demand cards, removes all loads, returns all money to the bank, and erases all their track. They then receive a fresh Freight Loco card, ECU 50, and 3 new Demand cards. They may build up to ECU 20 on the reset turn and restart their train at any city at the beginning of their turn. Other players' track that was protected (from riding the resetting player's track) is not erased and remains for the rest of the game.
- [ ] **Backtracking** — A player may reverse their train's direction on any milepost (not just at cities) at a cost of losing 1 full turn. Per the official rules (p. 26, "Backtracking" section): a train which backtracks can move in any direction on its next turn. A train may not backtrack when the player has discarded their cards during the same turn. A train may backtrack if it cannot move for any other reason (e.g., Derailment or Rail Strike). A player whose train backtracks while on an opponent's track is assessed the use fee for that turn.
- [ ] **Discard pile reshuffle** — When the demand card deck runs out, reshuffle fulfilled/discarded demand cards back into the deck so the game never runs dry
- [ ] **Economy difficulty setting** — Add a pre-game room option with three economy modes (Standard, Constrained, Generous) that adjust demand card payout amounts and route length mix
- [ ] **Configurable victory conditions** — Allow the game room to customize win conditions before the game starts
- [ ] **Set train destination** — Player selects a city as their destination; the train automatically moves toward it each operate phase until it arrives, the player undoes movement, or the mode is turned off
- [ ] **Faster train tier** — Add a 20+ speed train option to reduce late-game drag when players have long routes
- [ ] **Turn countdown clock** — Optional time pressure element with a visible countdown timer per turn

## UI / Visual

- [x] **Highlight demand-matching goods at pickup** — When at a city picking up goods, visually highlight any "available at city" options in the actions panel that match a good on the currently selected (highlighted) row of an active demand card
- [x] **More prominent goods pickup UI** — Make the option to pick up goods more visible and easier to interact with when stopped at a city
- [ ] **In-game tutorial** — Guided walkthrough teaching players the basic functions: building track, operating trains, picking up and dropping off goods, using ferries, renting opponent railroads (trackage rights), etc. 
- [ ] **Overhaul demand card row hover effect** — When hovering a demand card row, highlight origin and destination cities simultaneously on the map using distinct colors (e.g. one color for origin cities, another for the destination)
- [ ] **Event modal text should list all effects** — The persistent event banner at the top of the screen doesn't always describe every impact of the event (e.g. missing that rail building is disallowed in the affected area). Update event descriptions to fully enumerate all gameplay effects
- [x] **Prominent cash display** — Show current ECU balance next to player name or on train card so it's always visible without digging into the sidebar
- [x] **Better turn phase and movement limit indicators** — Clearer visual feedback for what phase you're in and how much movement remains
- [x] **Shrink pickup button to match deliver button** — Resize the goods pickup button so it uses the same compact format as the deliver button for visual consistency
- [ ] **Improved trackage rights payment animation** — Replace falling coins with a more polished visual for trackage rights transfers
- [ ] **Toggle to hide city production info** — Option to declutter the board by hiding goods-produced-at-city labels
- [ ] **Basic gameplay instructions dropdown** — Quick-reference panel (like the existing map legend) explaining core mechanics
- [ ] **AI hints system** — "What would an expert do?" suggestion feature for learning players

## Save & Resume

Persistent game saves that survive server restarts and browser closure. Players can save a game, close everything, and return hours or days later to resume where they left off. Full plan is in `SAVE_RESUME_PLAN.md`.

- [ ] **Decouple game from room** — Introduce a `gameId` that identifies a game independently of the ephemeral room code
- [ ] **Server-side save/load** — Serialize game state to JSON files on disk (`saves/{gameId}.json`), generate per-player seat codes for resuming
- [ ] **Resume lobby flow** — "Your Saved Games" section in the lobby with seat picker UI (supports multi-tab testing where one browser controls multiple players)
- [ ] **localStorage convenience layer** — Auto-save/retrieve seat codes so players don't have to re-enter them on the same browser

Independent of solo mode — no blocking dependencies in either direction.

---

## Reconnection Improvement

- [ ] **localStorage fallback for tab closure recovery** — Add localStorage as a fallback so reconnection credentials survive tab closure and incognito mode, while preserving multi-tab play. Full plan in [`LOCALSTORAGE_FALLBACK_PLAN.md`](LOCALSTORAGE_FALLBACK_PLAN.md).

---

## Bug Fixes

- [ ] **Alps region lacks clear milepost paths** — No clear traversal route through the Alps (unlike the physical board), making Italy builds disproportionately expensive and unattractive

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
