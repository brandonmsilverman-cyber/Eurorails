# Eurorails

A web-based implementation of the Eurorails board game (Mayfair Games, 1990). Build railroad networks across Europe, pick up goods, and deliver them to cities for profit. The first player to connect 7 major cities and accumulate enough cash wins.

![Eurorails](Eurorails%20map.webp)

## How to Play

### Local Single-Player

Open `eurorails.html` directly in a browser — no server or installation needed.

### Online Multiplayer

Requires [Node.js](https://nodejs.org/).

```bash
npm install
npm start
```

Then open `http://localhost:3000/eurorails.html` in each player's browser. One player creates a room, others join with the room code.

## Game Overview

Players take turns in two phases:

- **Build Phase** — Spend up to 20M ECU per turn laying track across the hex grid. Terrain costs vary: clear land is cheap, mountains and alpine regions are expensive. You can toggle between cheapest and shortest route optimization.
- **Operate Phase** — Move your train along your built track to pick up goods at source cities and deliver them to destination cities for payouts shown on your demand cards.

Other mechanics include ferry crossings, event cards (strikes, floods, gales, derailments), train upgrades, trackage rights (pay 4M to use an opponent's track for a turn), and goods supply limits.

## Files

| File | Description |
|---|---|
| `eurorails.html` | Standalone single-player game. Open directly in a browser. |
| `server.js` | Multiplayer server (Express + Socket.IO). |
| `public/eurorails.html` | Multiplayer client, served by the server. |
| `package.json` | Node.js dependencies. |
| `Eurorails map.webp` | Reference image of the original board map. |
| `Eurorails Rules, Mayfair Games Inc., 1990.pdf` | Original game rulebook. |
| `CLAUDE.md` | Development notes and architecture guide for AI-assisted coding. |

## Credits

Based on the Eurorails board game by Mayfair Games, Inc. (1990). This is a fan-made digital adaptation for personal use.
