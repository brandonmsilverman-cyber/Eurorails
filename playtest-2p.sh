#!/usr/bin/env bash
#
# playtest-2p.sh — Start the server and open two browser tabs for 2-player local testing.
#
# Usage:  ./playtest-2p.sh
#
# What it does:
#   1. Kills any existing process on port 3000
#   2. Starts the Eurorails server in the background
#   3. Waits for the server to be ready
#   4. Opens two browser tabs (Player 1 and Player 2)
#
# Once open, in each tab:
#   - Tab 1: Enter a name, set max players to 2, click "Create Room"
#   - Tab 2: Enter a name, click "Join" on the room
#   - Both tabs: Pick a color
#   - Tab 1: Click "Start Game"
#
# Press Ctrl+C to stop the server.

set -e
cd "$(dirname "$0")"

PORT="${PORT:-3000}"
URL="http://localhost:$PORT/eurorails.html"

# Kill anything already on the port
if lsof -ti :"$PORT" >/dev/null 2>&1; then
    echo "Killing existing process on port $PORT..."
    lsof -ti :"$PORT" | xargs kill -9 2>/dev/null || true
    sleep 1
fi

# Start server in background
echo "Starting Eurorails server on port $PORT..."
node server.js &
SERVER_PID=$!

# Cleanup on exit
cleanup() {
    echo ""
    echo "Stopping server (PID $SERVER_PID)..."
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
    echo "Done."
}
trap cleanup EXIT INT TERM

# Wait for server to be ready
echo "Waiting for server..."
for i in $(seq 1 30); do
    if curl -s -o /dev/null "http://localhost:$PORT/" 2>/dev/null; then
        break
    fi
    sleep 0.5
done

echo "Server is ready."
echo ""
echo "Opening two browser tabs..."
echo "  Tab 1 (Host):   Create a room with max players = 2"
echo "  Tab 2 (Guest):  Join the room"
echo "  Both:           Pick colors, then Host clicks Start Game"
echo ""
echo "Press Ctrl+C to stop the server."
echo ""

# Open two tabs
open "$URL" 2>/dev/null || xdg-open "$URL" 2>/dev/null || echo "Open $URL in your browser"
sleep 1
open "$URL" 2>/dev/null || xdg-open "$URL" 2>/dev/null || echo "Open $URL in a second tab"

# Keep running until Ctrl+C
wait "$SERVER_PID"
