# AI Players in Multiplayer Games

Allow the host of a multiplayer room to fill empty player slots with AI opponents, so games can start without a full lobby of human players.

## Motivation

Currently, multiplayer games require all player slots to be filled by humans. This makes it hard to start games when you have 2 friends but want a 4-player experience. AI players solve this by filling the gaps.

## What Already Exists

The AI infrastructure is already built for solo mode:

- **AI strategy engine** (`server/ai-easy.js`) — Full decision-making for build, operate, pickup/delivery, and recovery
- **Pure action appliers** (`server/ai-actions.js`) — Validates and applies all actions without socket dependencies
- **AI turn execution** (`server.js` `executeAITurn()`) — Orchestrates AI turns with delays between actions and state broadcasting
- **AI state persistence** — Players already have an `aiState` field for tracking targets across turns

## Implementation

### 1. Player Model: `isAI` Flag

Add an `isAI: true` property to AI player slots in room state. This flag drives all downstream behavior (skip timer, auto-execute turns, skip disconnect handling).

### 2. Lobby Changes (Server)

- New socket action: `addAIPlayer` — Host adds an AI player to an open slot, picking a color and difficulty
- New socket action: `removeAIPlayer` — Host removes an AI player before game starts
- Allow `startGame` when total players (human + AI) meets minimum (2+), not just human count
- AI players don't have a socket connection — use a sentinel value (e.g., `socketId: null`)

### 3. Lobby Changes (Client)

- Add an "Add AI" button next to empty player slots in the lobby
- Show AI players with a distinct label (e.g., "AI - Easy") and their chosen color
- Host can remove AI players before the game starts via a remove button
- AI slots are not joinable by humans (or auto-replaced if a human joins and all human slots are full)

### 4. Turn Routing

In `serverEndTurn()`, after advancing `currentPlayerIndex`:

```
if (nextPlayer.isAI) {
  // Skip turn timer, call executeAITurn() directly
} else {
  // Normal human turn: start timer, wait for socket actions
}
```

This is a small change — `executeAITurn()` already handles the full action loop with delays and state broadcasting.

### 5. Skip Inapplicable Logic for AI Players

- **Turn timer**: Don't start the 90-second countdown for AI turns
- **Disconnect/reconnect**: AI players never disconnect — skip grace period and abandon logic
- **State filtering**: AI players don't need filtered state broadcasts (no socket to send to)
- **Kick/ban**: AI players can't be kicked mid-game (remove only in lobby)

### 6. Edge Cases

- **All humans leave**: If all human players disconnect/abandon, clean up the room (don't let AI play alone forever)
- **AI player takes over abandoned human**: Nice-to-have — offer the host the option to replace an abandoned human with AI
- **Event cards affecting AI**: Already handled — AI turn loop processes events during card draws

## Effort Estimate

| Area | Lines | Notes |
|------|-------|-------|
| Server: AI slot management in rooms | ~100-150 | `addAIPlayer`, `removeAIPlayer`, start validation |
| Server: Turn routing to AI | ~30-50 | Check `isAI` in `serverEndTurn()`, skip timer |
| Server: Skip disconnect/timer for AI | ~20-30 | Guard clauses in existing handlers |
| Client: Lobby UI for adding/removing AI | ~100-200 | Button, display, remove control |
| Client: In-game AI player display | ~50-100 | Label, skip disconnect status |
| Tests | ~100-200 | AI in multiplayer room lifecycle, turn handoff |
| **Total** | **~400-700** | Mostly wiring — core AI already exists |

## Relationship to Solo Mode

Solo mode creates a private room with only AI opponents. This feature adds AI to rooms that also have human players. The underlying AI engine (`ai-easy.js`, `ai-actions.js`, `executeAITurn()`) is shared. The main difference is lobby UX: solo mode has a dedicated entry point, while this feature adds AI slots to the standard multiplayer lobby.

Both features can share the same `isAI` player flag and turn-routing logic. Building one makes the other easier.
