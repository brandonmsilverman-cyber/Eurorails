# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Eurorails is a web-based implementation of the Eurorails board game (Mayfair Games, 1990). It exists in two forms:

1. **Local single-player** — `eurorails.html` (standalone, open directly in a browser)
2. **Online multiplayer** — `server.js` + `public/eurorails.html` (requires Node.js server)

### File Structure

| File | Purpose |
|---|---|
| `eurorails.html` | **Local single-player version.** Standalone HTML file (~5400 lines). Do NOT modify unless working on the local version specifically. |
| `public/eurorails.html` | **Multiplayer client.** Served by the Node.js server. Contains all rendering, UI, and Socket.IO client code. |
| `server.js` | **Multiplayer server.** Express + Socket.IO. Manages rooms and player connections. |
| `package.json` | Node.js dependencies (express, socket.io). |
| `eurorails_backup_pre_events.html` | Historical backup from before the event card system was added. |

## Running

```bash
# Local single-player (no server needed)
open eurorails.html

# Online multiplayer (requires server)
npm start
# Then open http://localhost:3000/eurorails.html
```

## Architecture (shared by both versions)

Both files share the same code structure, organized into clearly delimited sections (search for `// ====`):

| Section | Purpose |
|---|---|
| HTML + CSS | Setup/lobby screen, game UI layout, sidebar, modals, canvas |
| Constants | World bounds, cities, goods/prices, train types, landmass polygons, terrain regions, rivers, ferry routes |
| Sea Areas | Reference points for gale events |
| Event Cards | 20 event cards (strikes, floods, gales, derailments, etc.) |
| Game State | Single `gameState` object holds all mutable state |
| Geometry & Hex Grid | Terrain detection, point-in-polygon, hex grid generation, neighbor computation, city/ferry snapping |
| Dijkstra's Algorithm | Pathfinding for build mode (cheapest/shortest path across terrain) |
| Track-Based Pathfinding | Movement pathfinding along player-built track |
| Game Logic | Turn flow, build/operate phases, demand cards, deliveries, train upgrades, undo |
| Event Card System | Event drawing, resolution, effects |
| Canvas Drawing | Map rendering: terrain, sea, borders, tracks, cities, trains, path previews, zoom/pan |
| UI and Setup | Player setup, game start, sidebar updates |
| Legend & UI Controls | Legend panel, `updateUI()`, end-game |
| Canvas Interaction | Mouse/touch handlers for click, hover, drag-to-pan, zoom, keyboard shortcuts |

The multiplayer client (`public/eurorails.html`) has one additional section at the end:

| Section | Purpose |
|---|---|
| Multiplayer Lobby | Socket.IO client, room create/join, color picker, `gameStart` handler |

## Key Concepts

- **Coordinate system**: World coordinates where cities and mileposts are placed. The hex grid spans roughly x:15–63, y:6–69 with `WORLD_BOUNDS` adding padding.
- **Hex grid**: Generated at startup by `generateHexGrid()`. Each milepost has an id (`"x,y"`), terrain type, neighbors, and optional city reference. Stored in `gameState.mileposts` (array) and `gameState.mileposts_by_id` (lookup).
- **Pathfinding**: Two separate systems — `findPath()` for build mode (Dijkstra across hex grid with terrain costs) and `findTrackPath()` for operate mode (movement along built track only).
- **Game phases**: `"build"` → `"operate"` each turn. Initial rounds are build-only. Players build track, then move trains to deliver goods.
- **Rendering**: All visuals drawn on a single `<canvas>` via `drawMap()`. Supports zoom/pan with world-to-screen coordinate transforms.
- **Event system**: Cards drawn each turn after initial building rounds. Effects include strikes (block cities), floods (destroy river tracks), gales (block sea areas), derailments, and half-speed restrictions.

## Development Notes

- The `gameState` object is the single source of truth. All game logic reads/mutates it directly.
- `updateUI()` is the main function that syncs the sidebar/panel state with `gameState`. It's large and handles phase-dependent UI visibility.
- `drawMap()` re-renders the entire canvas each frame. Called after any state change.
- City/goods data in `CITIES` and `GOODS` constants are hand-positioned to match the physical board map (`Eurorails map.webp`).
- Terrain is determined procedurally using polygon regions defined in `TERRAIN_REGIONS` combined with hash-based randomization in `getTerrainType()`.
- Ferry routes have shared ownership (max 2 players per ferry) tracked in `gameState.ferryOwnership`.

## Multiplayer Migration Plan

The multiplayer version is being built in phases. Each phase should keep the game functional.

### Phase 1: Server + Lobby — COMPLETE
- Express server serves `public/eurorails.html`
- Socket.IO handles room creation/joining, color selection, game start
- Lobby UI replaces the old local setup screen
- Game initializes identically to the original once the host clicks "Start Game"

### Phase 2: Room Management Enhancements — TODO
- Reconnection handling (player refreshes or disconnects temporarily)
- Spectator support
- Room expiry/cleanup for abandoned rooms

### Phase 3: Client/Server State Split — TODO (hardest phase)
- Split `gameState` into **server state** (authoritative, synced) and **client UI state** (local-only)
- **Server state** (must sync): `players`, `tracks`, `ferryOwnership`, `demandCardDeck`, `activeEvents`, `derailedPlayers`, `destroyedRiverTracks`, `turn`, `phase`, `currentPlayerIndex`, `buildingPhaseCount`, `buildingThisTurn`, `majorCitiesThisTurn`, `movement`, `halfSpeedActive`, `eventQueue`, `gameLog`
- **Client UI state** (local-only, do NOT sync): `selectedMilepost`, `pathPreview`, `pathPreviewValid`, `pathPreviewCost`, `pathPreviewCutoff`, `pathPreviewForeignSegments`, `buildPathMode`, `hoveredMilepost`, `hoverValid`, `highlightedCities`, `canvas`, `ctx`, `zoom`
- **Per-player private state**: Each player's `demandCards` should only be sent to that player, not broadcast to all clients
- Hex grid (`mileposts`, `mileposts_by_id`, `cityToMilepost`, `ferryConnections`) is generated deterministically from constants — generate on each client, do NOT sync

### Phase 4: Server-Authoritative Actions — TODO
- All state-mutating actions become server round-trips:
  - Client emits: `socket.emit('action', { type: 'endTurn' })`
  - Server validates (correct player, legal move), applies mutation, broadcasts updated state
- Actions to migrate (in suggested order):
  1. `endTurn()` / `endBuildPhase()`
  2. Track building (commit build path)
  3. `deployTrain()`
  4. Train movement (commit move path)
  5. `pickupGood()`, `deliverGood()`, `dropGood()`
  6. `upgradeTo()`
  7. `discardHand()`
  8. Event card drawing and resolution
- Client computes path previews locally for responsiveness; server validates and commits
- Undo (`buildHistory`, `operateHistory`) works client-side for uncommitted previews; server is final authority

### Phase 5: Demand Card Privacy — TODO
- Server sends each client a filtered `gameState`:
  - Your own `demandCards`: full data
  - Other players' `demandCards`: only the count (e.g., `{ hidden: true, count: 3 }`)
- Card animations remain client-side, triggered by state update diffs

## Solo Mode Plan

The implementation plan for AI solo mode is in `SOLO_MODE_PLAN.md`. Read it before starting any solo mode work.

## Save & Resume Plan

The implementation plan for persistent game saves is in `SAVE_RESUME_PLAN.md`. Read it before starting any save/resume work. This feature is independent of solo mode — no blocking dependencies in either direction.

## Development Rules

- When working on multiplayer, edit `public/eurorails.html` and `server.js`. Do not modify root `eurorails.html`.
- When working on the local version, edit root `eurorails.html`. Do not modify `public/eurorails.html`.
- When migrating actions to the server, always validate on the server that: (1) it's the correct player's turn, (2) the action is legal given current game state, (3) the player has sufficient resources.
- Keep card animations and path preview computations client-side for responsiveness.
- Test multiplayer with multiple browser tabs to simulate multiple players.
