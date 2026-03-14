# Plan: Persistent Player UI & Demand Card Highlight Fix

## Context

Three related issues hurt the player's ability to plan during a multiplayer game:

1. **Demand cards disappear during other players' turns** — card rendering in `updateUI()` is tied to `currentPlayer` (whoever's turn it is), not the local player
2. **Train card shows opponent's train** — same `currentPlayer` issue in `drawMap()`
3. **Demand card highlights randomly disappear between turns** — `selectedDemands` is written to / read from `currentPlayer` instead of `myPlayer`, and the snapshot-based preservation in `applyServerState()` is fragile
4. **New cards after discard not shown until next turn** — animation deferred behind `pendingCardDrawAnimation` flag that gates on `isMyTurn`, which is never true because discard ends the turn

**Goal**: Always render the local player's own demand cards, train card, and selection highlights, regardless of whose turn it is. Show replacement cards immediately after discard without impacting event card functionality.

## Scope

These changes apply to **both solo mode and multiplayer mode** — they share the same client code (`public/eurorails.html`) and both set `myPlayerId` via Socket.IO session tokens. The local single-player version (`eurorails.html` at root) is a separate file and is not modified.

No server changes needed — `getStateForPlayer()` already sends full card data to each player.

## Root Causes

### Cards/train disappearing (Commits 1-2)
In `updateUI()` and `drawMap()`, all player-specific rendering uses `currentPlayer = gameState.players[gameState.currentPlayerIndex]`. When the turn advances, `currentPlayerIndex` changes, so the UI switches to showing the opponent's data (or nothing, since opponent cards are `{ hidden: true }`).

### Highlight bug (Commit 3)
Two causes:
1. **`toggleDemandSelection()`** ([eurorails.html:3914-3925](public/eurorails.html#L3914-L3925)) writes to `currentPlayer.selectedDemands`. If you click a demand while it's another player's turn, it writes to the wrong player object.
2. **`applyServerState()`** ([eurorails.html:6524-6541](public/eurorails.html#L6524-L6541)) preserves `selectedDemands` by snapshotting card data as JSON and comparing before/after. This comparison uses `JSON.stringify(demandCards.map(c => c.demands))` which can fail if any property on the demand objects changes (e.g., `fulfilled` flags), causing selections to silently drop.

### Discard animation deferred (Commit 4)
`applyDiscardHand()` in [ai-actions.js:339](server/ai-actions.js#L339) draws 3 new cards then calls `serverEndTurn()`, advancing the turn. The client at [eurorails.html:6691-6696](public/eurorails.html#L6691-L6696) sets `pendingCardDrawAnimation = true` but the animation at line 6704 only fires when `currentPlayer.id === myPlayerId` — never true since the turn already advanced.

## Files to Modify

| File | Change |
|---|---|
| `public/eurorails.html` | Card/train rendering, selection logic, animations, game start |
| `test/ai-turn-loop.test.js` | Tests for each commit |

---

## Commit Sequence

### Commit 1: Persistent demand card rendering — ✅ COMPLETE (`5bc2093`)

**The core change.** Makes demand cards always visible for the local player regardless of whose turn it is.

#### Changes in `updateUI()` ([eurorails.html:4525-4595](public/eurorails.html#L4525-L4595)):
- Introduce `const myPlayer = (myPlayerId && gameState.players.find(p => p.id === myPlayerId)) || currentPlayer;`
- Replace `currentPlayer` → `myPlayer` for:
  - `hasVisibleCards` check (line 4527)
  - `demandCards` iteration (line 4530)
  - `selectedDemands` access (line 4547)
  - Player color `pColor` (line 4529)
  - `trainLocation` and `loads` for delivery eligibility (lines 4545, 4558-4560)
- Add `const isMyTurn = !myPlayerId || (currentPlayer && currentPlayer.id === myPlayerId);`
- Gate `canDeliver` and `hasDeliverable` on `isMyTurn` so delivery buttons and gold borders don't appear during other players' turns

#### Sidebar delivery section (~[eurorails.html:4720-4738](public/eurorails.html#L4720-L4738)):
- Keep tied to `currentPlayer` — the sidebar operate panel only renders during your turn anyway

#### Tests for this commit:
- **Player's cards in state during other player's turn**: After game start, advance turn, verify `getStateForPlayer()` for the non-active player returns full (non-hidden) card data
- **Cards persist across turn transitions**: Advance through several turns, verify each player's card data remains in their own state view
- Verify existing tests pass: "AI demand cards remain hidden", "human demand cards remain visible"

---

### Commit 2: Persistent train card rendering — ✅ COMPLETE (`a603e2d`)

**Same pattern as Commit 1, applied to the train card overlay.**

#### Changes in `drawMap()` train card section ([eurorails.html:3144-3522](public/eurorails.html#L3144-L3522)):
- Introduce `const myPlayer = (myPlayerId && gameState.players.find(p => p.id === myPlayerId)) || currentPlayer;`
- Replace `currentPlayer` → `myPlayer` for:
  - `trainType` and `TRAIN_TYPES` lookup (line 3147)
  - Player color `pColor` (line 3148)
  - `getPlayerLocationName()` call (line 3149)
  - `loads` iteration for cargo display (lines 3151-3161)
  - Train SVG selection (line 3498)
  - Header text (line 3504)
  - Train type, speed, location stats (lines 3508-3510)
  - Cargo count display (line 3513)

#### Train card functionality preserved:
- Reflects local player's current state (type, speed, location, cargo)
- Updates in real-time as state changes
- Upgrade UI is already gated on `isMyTurn` in `updateUI()` (line 4824)

#### Tests for this commit:
- Verify existing tests still pass (train card is not directly tested server-side, but state integrity tests cover the data)

---

### Commit 3: Fix demand card highlight persistence — ✅ COMPLETE (`e483e8b`)

**Fixes the bug where highlights randomly disappear between turns or select the wrong card.**

#### Fix 1 — `toggleDemandSelection()` — ✅ DONE (pulled into Commit 1)
- Replaced `const currentPlayer = gameState.players[gameState.currentPlayerIndex]` with `const myPlayer = (myPlayerId && gameState.players.find(p => p.id === myPlayerId)) || gameState.players[gameState.currentPlayerIndex]`
- Uses `myPlayer` for all `selectedDemands` reads/writes
- This ensures selections always target the local player, even during another player's turn

#### Fix 2 — `applyServerState()` snapshot comparison ([eurorails.html:6524-6541](public/eurorails.html#L6524-L6541)):
- The current approach snapshots `demandCards.map(c => c.demands)` as JSON and compares. This is fragile — any change to demand objects (even unrelated fields) breaks the comparison.
- **New approach**: Compare only the stable identity of each card — the 3 demand tuples `{good, from, to, payout}`. Build a lightweight fingerprint: `JSON.stringify(demandCards.map(c => c.demands.map(d => [d.good, d.to, d.payout])))`
- This is resilient to changes in `fulfilled` flags or any other properties that might be added to demand objects.

#### Fix 3 — `updateUI()` selectedDemands read — ✅ DONE (Commit 1)
- Line 4547 reads `currentPlayer.selectedDemands` → already changed to `myPlayer.selectedDemands` in Commit 1

#### Tests for this commit:
- **Selections survive state updates**: Set `selectedDemands` on local player, trigger a state update (e.g., other player's action), verify selections are preserved
- **Selections survive turn transitions**: Select a demand, advance turn, verify selection persists
- **Delivery rejected when not your turn**: ✅ DONE (tested in Commit 1) — Emit a deliver action from non-current player, verify server returns `{ success: false }`

---

### Commit 4: Immediate card animation at game start + after discard — ✅ COMPLETE (`e4b4cf7`)

**Removes the deferred-until-your-turn animation pattern.**

#### Game start — `initializeGameView()` ([eurorails.html:6499-6516](public/eurorails.html#L6499-L6516)):
- Remove the `isFirstPlayer` conditional
- Always animate card deal for the local player if they have cards
- Remove `pendingInitialCardAnimation = true` in the else branch
- Remove the `pendingInitialCardAnimation` flag declaration (line 5947) and its check at lines 6701-6713

#### Discard — `stateUpdate` handler ([eurorails.html:6691-6713](public/eurorails.html#L6691-L6713)):
- When `uiEvent.type === 'turnChanged'` and `uiEvent.drawnBy` matches local player: trigger card animation **immediately** instead of setting `pendingCardDrawAnimation`
- Mark `myPlayer.demandCards` with `_animating = true`, queue them, and flush
- Remove `pendingCardDrawAnimation` flag entirely
- The `isMyTurn` gate at line 6704 is no longer needed (was only for the deferred pattern)

#### `showDemandCardFlyAnimation()` ([eurorails.html:1917-1919](public/eurorails.html#L1917-L1919)):
- Replace `currentPlayer` with local player lookup via `myPlayerId` (for player color)

#### Event card handling during discard:
- Events drawn during redraw already returned in `uiEvent.drawnEvents` ([ai-actions.js:387](server/ai-actions.js#L387))
- Already handled at [eurorails.html:6636-6642](public/eurorails.html#L6636-L6642) — no change needed

#### Animation flush timing:
- Since it's no longer the local player's turn after discard, the turn overlay auto-dismisses (2s, line 4058)
- Card fly-in animations flush immediately (not deferred behind "Ready" button) because `deferCardAnimationsUntilReady` is only set when `isMyTurn && turnChanged`

#### Tests for this commit:
- **Discard replacement cards available immediately**: Player discards, verify the state update contains 3 new demand cards for that player (not hidden, not empty)
- **No double-animation**: After discard, advance back to that player's turn, verify no redundant animation fires
- Verify existing test passes: "discardHand followed by AI turn works correctly"

---

## Risks & Dependencies

### High Risk
- **Delivery button interaction during wrong turn**: `deliverGood()`, `pickupGood()`, and `discardHand()` all use `currentPlayer`. Delivery buttons must not render when `!isMyTurn`. Server validates this too (line 1458: `playerIndex !== gs.currentPlayerIndex`), so this is UI-only risk — no data corruption possible.
- **Animation queue firing for remote players**: `showDemandCardFlyAnimation()` and `animateCardDiscard()` query `demandCardsOverlay` DOM. Since cards are now always rendered, we must verify animations from another player's delivery don't modify the local player's card display. Existing `currentPlayer.id === myPlayerId` guards at lines 6652 and 6704 already prevent this.

### Medium Risk
- **Game-start animation race with turn overlay**: Non-first players animate cards during game start, potentially overlapping with turn overlay. Since overlay auto-dismisses in 2s and card fly-in is 600ms, overlap is visual only — acceptable UX.
- **Sidebar operate panel**: Uses `currentPlayer.demandCards` for delivery info. Stays tied to `currentPlayer` — needs review to ensure it doesn't break when `currentPlayer` is AI with hidden cards.
- **Train card `getPlayerLocationName()`**: Reads `trainLocation` — verify field stays accurate for non-current players across state updates (it should, since server sends full player state).
- **Snapshot fingerprint change**: New fingerprint for `selectedDemands` preservation uses `[good, to, payout]` tuples. If two cards have identical demands (unlikely but possible with deck construction), selections could be incorrectly preserved after a card swap. Acceptable edge case.

### Low Risk
- **Single-player fallback**: `myPlayerId` is `null` in the local single-player version. The `|| currentPlayer` fallback handles this. Solo mode (server-based) sets `myPlayerId` properly.

## Verification

1. `npm test` — all existing + new tests pass
2. Manual test with 2+ browser tabs:
   - Both players see dealt cards immediately at game start
   - Cards persist when it's the other player's turn
   - Train card always shows your own train (type, speed, location, cargo)
   - Train card updates correctly after pickups, drops, upgrades
   - Demand card highlight persists across turns — select a demand, wait for turn change, verify still highlighted
   - Clicking a demand during opponent's turn highlights correctly
   - Delivery buttons only appear on your own turn
   - Discard hand → immediately see 3 new replacement cards animate in
   - Event cards drawn during discard show their modal
   - AI turns don't disrupt card display or selections
