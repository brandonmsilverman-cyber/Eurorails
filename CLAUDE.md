# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Eurorails is a single-file web-based implementation of the Eurorails board game (Mayfair Games, 1990). The entire game — HTML, CSS, and JavaScript — lives in `eurorails.html` (~5400 lines). There is no build system, bundler, or package manager. To run, simply open the file in a browser.

A backup file `eurorails_backup_pre_events.html` preserves the state before the event card system was added.

## Running

```bash
open eurorails.html
```

No build, lint, or test commands exist. All development is done by editing `eurorails.html` directly.

## Architecture

The file is organized into clearly delimited sections (search for `// ====`):

| Lines (approx) | Section | Purpose |
|---|---|---|
| 1–818 | HTML + CSS | Setup screen, game UI layout, sidebar, modals, canvas |
| 819–1145 | **Constants** | World bounds, city definitions (with coordinates, goods, country), goods/prices, train types, player colors, landmass polygons, terrain regions, rivers, ferry routes |
| 1146–1157 | **Sea Areas** | Reference points for gale events |
| 1159–1345 | **Event Cards** | 20 event cards (strikes, floods, gales, derailments, etc.) |
| 1347–1394 | **Game State** | Single `gameState` object holds all mutable state |
| 1396–1683 | **Geometry & Hex Grid** | Terrain detection, point-in-polygon, hex grid generation, neighbor computation, city/ferry snapping |
| 1684–1935 | **Dijkstra's Algorithm** | MinHeap, pathfinding for build mode (cheapest/shortest path across terrain) |
| 1937–2019 | **Track-Based Pathfinding** | Movement pathfinding along player-built track |
| 2021–2129 | **Game Logic** | Turn flow, build/operate phases, demand cards, deliveries, train upgrades, undo |
| 2130–2601 | **Event Card System** | Event drawing, resolution, effects (strikes, floods, gales, derailments, half-speed) |
| 2602–3605 | **Canvas Drawing** | Map rendering: terrain, sea, borders, tracks, cities, trains, path previews, zoom/pan |
| 3606–3683 | **UI and Setup** | Player setup, game start, sidebar updates |
| 3684–4649 | **Legend & UI Controls** | Legend panel toggles, `updateUI()` (large function that syncs all sidebar state), end-game |
| 4650–5410 | **Canvas Interaction** | Mouse/touch handlers for click, hover, drag-to-pan, zoom, keyboard shortcuts |

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
