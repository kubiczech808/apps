#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="/home/jakub/apps/medium-poster"
VENV_DIR="$REPO_DIR/.venv"
PIDFILE="/tmp/agent-m-bot.pid"
LOG="/tmp/agent-m-bot.log"

# Kill previous instance if running
if [ -f "$PIDFILE" ]; then
    OLD_PID=$(cat "$PIDFILE" 2>/dev/null || true)
    if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null; then
        kill "$OLD_PID" 2>/dev/null || true
        sleep 2
    fi
    rm -f "$PIDFILE"
fi

cd "$REPO_DIR"

# Create/update venv if needed
if [ ! -d "$VENV_DIR" ]; then
    python3 -m venv "$VENV_DIR"
fi
source "$VENV_DIR/bin/activate"
pip install -q .

# Start bot in background
nohup python -m agent_m >> "$LOG" 2>&1 &
echo $! > "$PIDFILE"
echo "Agent M bot started (PID: $(cat "$PIDFILE"))"
