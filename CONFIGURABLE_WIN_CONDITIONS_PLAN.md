# Plan: Configurable Victory Conditions

## Context

Currently the win condition is hardcoded: cash >= 250 ECU and >= 7 connected major cities. This feature lets the host customize both thresholds in the lobby before starting, giving groups control over game length and difficulty.

---

## Room Settings Object

Add `gameSettings` to the room object at creation time (server.js ~line 1460):
```js
gameSettings: { winCashThreshold: 250, winMajorCitiesRequired: 7 }
```

## Server Changes (server.js)

1. **`createRoom`** (~line 1456) — Initialize `room.gameSettings` with defaults
2. **New `updateGameSettings` event** — Host-only, pre-game. Validates:
   - `winCashThreshold`: integer, 100–500, step 50
   - `winMajorCitiesRequired`: integer, 1–8
   - Broadcasts `roomUpdate` on success
3. **`getRoomInfo`** — Include `gameSettings` in returned object
4. **`startGame`** (~line 1703) — Pass `room.gameSettings` to `createGameState()`
5. **`createGameState`** — Accept and store `gameSettings` on `gameState`
6. **`getStateForPlayer`** — Include `gameSettings` in returned state
7. **`checkWinCondition`** (line 257) — Read from `gs.gameSettings` with fallback defaults:
   ```js
   const settings = gs.gameSettings || { winCashThreshold: 250, winMajorCitiesRequired: 7 };
   ```

## Client Changes (public/eurorails.html)

1. **Lobby UI** — Add a "Game Settings" section in `#lobbyRoom` (after color picker, before buttons):
   - Host sees dropdowns for cash threshold and cities required
   - Non-host sees read-only display of current settings
   - `onchange` emits `updateGameSettings`
2. **`renderLobbyRoom`** (~line 6410) — Render settings from `info.gameSettings`
3. **`checkWinCondition`** (line 1499) — Read from `gameState.gameSettings` with fallback
4. **Win condition display** — Three hardcoded locations must be replaced with dynamic reads from `gameState.gameSettings`:
   - **Sidebar "Win Condition" box** (line 1208) — Static HTML: `Connect 7 of 8 major cities + 250M ECU cash`. Replace with a dynamic element (e.g., `<span id="winConditionText">`) populated from `gameState.gameSettings` on game start and whenever settings change.
   - **Active player stats** (line 4636) — `${connectedCount}/7` hardcodes the `7`. Replace with `${connectedCount}/${gameState.gameSettings.winMajorCitiesRequired}`. Also update the green/orange color threshold comparison (`connectedCount >= 7`) to use the variable.
   - **Inactive player stats** (line 4644) — Same `${inactiveConnected}/7` and `inactiveConnected >= 7` hardcoding. Apply the same fix as above.

   - **Win screen coin animation** (line 5080) — `const coinCount = 250;` hardcodes the coin count to match the default cash threshold. Replace with `const coinCount = gameState.gameSettings?.winCashThreshold || 250;` so the falling coins match the configured win amount.

   After implementation, all four locations will read from `gameState.gameSettings` — no hardcoded win condition values will remain in the UI.

## AI / Save Compatibility

- AI (easy) doesn't reference win thresholds directly — no changes needed
- Saved games without `gameSettings` handled by fallback defaults

## Implementation Order

1. `server.js` — gameSettings on room, updateGameSettings event, createGameState, checkWinCondition, getRoomInfo, getStateForPlayer
2. `public/eurorails.html` — Lobby settings UI, renderLobbyRoom, checkWinCondition, win display text

## Verification

1. Start server (`npm start`), create a room
2. Change cash/cities in lobby as host — verify non-host sees updates in real time
3. Start game and confirm win condition display in sidebar matches configured settings
4. Play to win threshold — confirm game ends at the custom values, not the defaults
5. Load a saved game from before this feature — should use default win conditions with no errors
