# Reconnection: Survive Tab Closure via localStorage Fallback

Currently, reconnection credentials are stored in `sessionStorage`, which is scoped to a single tab. If a player closes their tab (or is in incognito mode), the credentials are lost and they cannot rejoin the game. This change adds a `localStorage` fallback so credentials survive tab closure, while preserving multi-tab play (e.g., testing with multiple players in one browser).

## Implementation

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

## Testing Plan

- [ ] **Multi-tab play still works (regression)** — Open two tabs. Create a room in Tab A, join from Tab B. Start the game. Verify both tabs play independently as separate players — Tab B does NOT auto-rejoin as Player 1.

- [ ] **Tab refresh reconnects (existing behavior)** — Start a 2-player game in two tabs. Refresh Tab A. Verify Tab A auto-rejoins as the same player.

- [ ] **Tab closure and reopen reconnects (new behavior)** — Start a 2-player game in two tabs. Close Tab A entirely. Open a new tab to `localhost:3000/eurorails.html`. Verify the new tab auto-rejoins as Player 1 and enters the game view.

- [ ] **Recovery credentials are one-time use** — After completing the tab closure test above, open yet another new tab. Verify the third tab lands on the lobby and does NOT rejoin as Player 1 (localStorage was cleared after recovery).

- [ ] **Leave room clears recovery credentials** — Create a room, then leave it. Close the tab, open a new one. Verify the new tab shows the lobby with no rejoin attempt.

- [ ] **Failed rejoin clears recovery credentials** — Start a game, then kill and restart the server (room is gone). Close the tab, open a new one. Verify rejoin fails gracefully, the player sees the lobby, and no stale credentials remain.

- [ ] **Incognito mode recovery** — Open two incognito tabs and start a game. Close one incognito tab. Open a new incognito tab to the same URL. Verify the new tab rejoins as the disconnected player.

## Relationship to Save & Resume (SAVE_RESUME_PLAN.md)

This feature and the Save & Resume feature both use localStorage but serve different purposes and do not conflict:

- **This feature** handles short-lived disconnects (tab closed during an active game, reconnect within the 5-minute grace period). It stores `sessionToken` and `roomCode` in localStorage as one-time-use recovery credentials. The room still exists in server memory.
- **Save & Resume** handles long-lived persistence (game saved to disk, resume hours or days later). It stores seat codes under a separate `savedGames` localStorage key. The room is gone; the game is reconstructed from a file on disk.

The two features use different localStorage keys (`sessionToken`/`roomCode` vs `savedGames`) and different server paths (Socket.IO `rejoinGame` vs `resumeGame`). Either can be built first. If this feature lands first, players get seamless recovery for short disconnects immediately, and Save & Resume adds persistent cross-session recovery on top of that.
