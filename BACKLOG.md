# Eurorails — Feature Backlog

A running list of planned features, improvements, and known issues.

---

## Solo Mode

Solo mode branches from the main lobby as its own game type. The player creates a private room (accessible only to themselves and spectators, if supported). They can add up to 5 AI opponents that take turns just like human players.

- [ ] **Lobby entry point** — Add a "Solo Mode" option in the lobby that creates a private, single-player room
- [ ] **AI opponent setup** — Let the player choose 1–5 AI opponents and assign each a difficulty (Easy, Hard, Brutal)
- [ ] **AI turn loop** — AI players take turns in sequence: build track, operate trains, pick up/deliver goods, draw event cards
- [ ] **AI: Easy difficulty** — Myopic, serial play: one demand at a time, greedy routing, no batching, no strategic discards, avoids ferries
- [ ] **AI: Hard difficulty** — Intelligent human-level play: opportunistic route batching, payout/cost build scoring with network awareness, situational upgrades, active hand evaluation, deliberate ferry investment
- [ ] **AI: Brutal difficulty** — Near-optimal play: systematic multi-delivery planning, expected-value build calculations over future hands, optimal upgrade timing, EV-based discard decisions, full landmass access modeling for ferries

### Recommended Build Sequence

The AI strategy engine is the bulk of the work (~70%+ of effort). Build incrementally by difficulty tier so the full loop is functional at each step:

1. **Lobby + AI player infrastructure** — Solo Mode button, AI setup screen (count/difficulty/color), private room creation, AI player slots in game state
2. **AI turn loop** — Server detects AI turns, executes actions with small delays so the human can watch, skips turn timer for AI, handles event cards
3. **Easy difficulty first** — Get a complete but simple AI: one demand at a time, no optimization. This proves the turn loop works end-to-end.
4. **Hard difficulty** — Plays like a competent human: route batching, build ROI scoring, situational upgrades, active hand evaluation, deliberate ferry decisions
5. **Brutal difficulty last** — Near-optimal play: EV-based decisions across all five strategic dimensions. This tier alone could be as complex as all others combined.

## Gameplay

- [ ] **Borrowing** — A player may borrow up to ECU 20 from the bank at any time and immediately spend it on building or hold it in reserve. The player must pay back **double** the borrowed amount from all future delivery payoffs until the doubled debt is fully repaid. Per the official rules (p. 26, "Money" section), borrowing is intended as a safety valve for players who become trapped or unable to make progress. The loan is taken voluntarily; there is no forced borrowing.
- [ ] **Reset** — A player may completely restart their position at the beginning of their turn. Per the official rules (p. 26, "Reset" section): the player discards all Demand cards, removes all loads, returns all money to the bank, and erases all their track. They then receive a fresh Freight Loco card, ECU 50, and 3 new Demand cards. They may build up to ECU 20 on the reset turn and restart their train at any city at the beginning of their turn. Other players' track that was protected (from riding the resetting player's track) is not erased and remains for the rest of the game.
- [ ] **Backtracking** — A player may reverse their train's direction on any milepost (not just at cities) at a cost of losing 1 full turn. Per the official rules (p. 26, "Backtracking" section): a train which backtracks can move in any direction on its next turn. A train may not backtrack when the player has discarded their cards during the same turn. A train may backtrack if it cannot move for any other reason (e.g., Derailment or Rail Strike). A player whose train backtracks while on an opponent's track is assessed the use fee for that turn.
- [ ] **Discard pile reshuffle** — When the demand card deck runs out, reshuffle fulfilled/discarded demand cards back into the deck so the game never runs dry
- [ ] **Economy difficulty setting** — Add a pre-game room option with three economy modes (Standard, Constrained, Generous) that adjust demand card payout amounts and route length mix
- [ ] **Configurable victory conditions** — Allow the game room to customize win conditions before the game starts
- [ ] **Set train destination** — Player selects a city as their destination; the train automatically moves toward it each operate phase until it arrives, the player undoes movement, or the mode is turned off

## UI / Visual

- [ ] **Highlight demand-matching goods at pickup** — When at a city picking up goods, visually highlight any "available at city" options in the actions panel that match a good on the currently selected (highlighted) row of an active demand card
- [ ] **More prominent goods pickup UI** — Make the option to pick up goods more visible and easier to interact with when stopped at a city
- [ ] **In-game tutorial** — Guided walkthrough teaching players the basic functions: building track, operating trains, picking up and dropping off goods, using ferries, renting opponent railroads (trackage rights), etc. Uses highlight overlays on existing UI elements to direct attention. Includes a tutorial toggle option in the game room prior to game start.
- [ ] **Overhaul demand card row hover effect** — When hovering a demand card row, highlight origin and destination cities simultaneously on the map using distinct colors (e.g. one color for origin cities, another for the destination)
- [ ] **Event modal text should list all effects** — The persistent event banner at the top of the screen doesn't always describe every impact of the event (e.g. missing that rail building is disallowed in the affected area). Update event descriptions to fully enumerate all gameplay effects

## Save & Resume

Persistent game saves that survive server restarts and browser closure. Players can save a game, close everything, and return hours or days later to resume where they left off. Full plan is in `SAVE_RESUME_PLAN.md`.

- [ ] **Decouple game from room** — Introduce a `gameId` that identifies a game independently of the ephemeral room code
- [ ] **Server-side save/load** — Serialize game state to JSON files on disk (`saves/{gameId}.json`), generate per-player seat codes for resuming
- [ ] **Resume lobby flow** — "Your Saved Games" section in the lobby with seat picker UI (supports multi-tab testing where one browser controls multiple players)
- [ ] **localStorage convenience layer** — Auto-save/retrieve seat codes so players don't have to re-enter them on the same browser

Independent of solo mode — no blocking dependencies in either direction.

---

## Reconnection: Survive Tab Closure via localStorage Fallback

Currently, reconnection credentials are stored in `sessionStorage`, which is scoped to a single tab. If a player closes their tab (or is in incognito mode), the credentials are lost and they cannot rejoin the game. This change adds a `localStorage` fallback so credentials survive tab closure, while preserving multi-tab play (e.g., testing with multiple players in one browser).

### Implementation

All changes are client-side only, in `public/eurorails.html` (Multiplayer Lobby section):

1. **Save to both storages on room create (~line 7114)** — After the existing `sessionStorage.setItem` calls for `sessionToken` and `roomCode`, add matching `localStorage.setItem` calls.

2. **Save to both storages on room join (~line 7140)** — Same as above, in the `joinRoom` callback.

3. **Clear both storages on leave room (~line 7196)** — Add `localStorage.removeItem` for both keys alongside the existing `sessionStorage.removeItem` calls.

4. **Fallback read in the connect handler (~line 7325)** — Read credentials from `sessionStorage` first, falling back to `localStorage`:
   ```js
   const savedToken = sessionStorage.getItem('sessionToken')
                   || localStorage.getItem('sessionToken');
   const savedRoom  = sessionStorage.getItem('roomCode')
                   || localStorage.getItem('roomCode');
   ```
   On successful rejoin, copy credentials into the new tab's `sessionStorage` and clear `localStorage` so a second new tab won't also reclaim the player:
   ```js
   sessionStorage.setItem('sessionToken', savedToken);
   sessionStorage.setItem('roomCode', savedRoom);
   localStorage.removeItem('sessionToken');
   localStorage.removeItem('roomCode');
   ```

5. **Clear both storages on rejoin failure (~line 7339)** — Add `localStorage.removeItem` for both keys alongside the existing `sessionStorage.removeItem` calls.

### Testing Plan

- [ ] **Multi-tab play still works (regression)** — Open two tabs. Create a room in Tab A, join from Tab B. Start the game. Verify both tabs play independently as separate players — Tab B does NOT auto-rejoin as Player 1.

- [ ] **Tab refresh reconnects (existing behavior)** — Start a 2-player game in two tabs. Refresh Tab A. Verify Tab A auto-rejoins as the same player.

- [ ] **Tab closure and reopen reconnects (new behavior)** — Start a 2-player game in two tabs. Close Tab A entirely. Open a new tab to `localhost:3000/eurorails.html`. Verify the new tab auto-rejoins as Player 1 and enters the game view.

- [ ] **Recovery credentials are one-time use** — After completing the tab closure test above, open yet another new tab. Verify the third tab lands on the lobby and does NOT rejoin as Player 1 (localStorage was cleared after recovery).

- [ ] **Leave room clears recovery credentials** — Create a room, then leave it. Close the tab, open a new one. Verify the new tab shows the lobby with no rejoin attempt.

- [ ] **Failed rejoin clears recovery credentials** — Start a game, then kill and restart the server (room is gone). Close the tab, open a new one. Verify rejoin fails gracefully, the player sees the lobby, and no stale credentials remain.

- [ ] **Incognito mode recovery** — Open two incognito tabs and start a game. Close one incognito tab. Open a new incognito tab to the same URL. Verify the new tab rejoins as the disconnected player.

### Relationship to Save & Resume (SAVE_RESUME_PLAN.md)

This feature and the Save & Resume feature both use localStorage but serve different purposes and do not conflict:

- **This feature** handles short-lived disconnects (tab closed during an active game, reconnect within the 5-minute grace period). It stores `sessionToken` and `roomCode` in localStorage as one-time-use recovery credentials. The room still exists in server memory.
- **Save & Resume** handles long-lived persistence (game saved to disk, resume hours or days later). It stores seat codes under a separate `savedGames` localStorage key. The room is gone; the game is reconstructed from a file on disk.

The two features use different localStorage keys (`sessionToken`/`roomCode` vs `savedGames`) and different server paths (Socket.IO `rejoinGame` vs `resumeGame`). Either can be built first. If this feature lands first, players get seamless recovery for short disconnects immediately, and Save & Resume adds persistent cross-session recovery on top of that.

---

## Bug Fixes

- [ ] *(Add known bugs here)*

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
