#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="/home/jakub/apps/medium-poster"
VENV_DIR="$REPO_DIR/.venv"
PIDFILE="/tmp/agent-m-bot.pid"
LOG="/tmp/agent-m-bot.log"

# Kill ALL previous agent_m instances (not just pidfile — orphans cause 409 Conflict)
if [ -f "$PIDFILE" ]; then
    OLD_PID=$(cat "$PIDFILE" 2>/dev/null || true)
    if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null; then
        kill -9 "$OLD_PID" 2>/dev/null || true
    fi
    rm -f "$PIDFILE"
fi
# Kill any remaining agent_m processes with SIGKILL (SIGTERM ignored by zombie processes)
pkill -9 -f "python.*agent_m" 2>/dev/null || true
sleep 3
# Verify all killed
if pgrep -f "python.*agent_m" >/dev/null 2>&1; then
    echo "WARNING: agent_m processes still running after kill:"
    ps aux | grep "agent_m" | grep -v grep
    pkill -9 -f "python.*agent_m" 2>/dev/null || true
    sleep 2
fi

# Preserve previous log for diagnostics
if [ -f "$LOG" ]; then
    cp "$LOG" "${LOG}.prev"
    > "$LOG"
fi

cd "$REPO_DIR"

# Ensure Xvfb is available (needed for Medium Playwright headed mode)
if ! command -v Xvfb &>/dev/null; then
    echo "Installing Xvfb..."
    sudo apt-get install -y -qq xvfb 2>/dev/null || true
fi

# Create/update venv if needed
if [ ! -d "$VENV_DIR" ]; then
    python3 -m venv "$VENV_DIR"
fi
source "$VENV_DIR/bin/activate"
pip install -q .

# Install Chromium for Medium Playwright (auto-starts Xvfb for headed mode)
playwright install chromium 2>/dev/null || true

# Start bot in background (unbuffered output)
nohup python -u -m agent_m >> "$LOG" 2>&1 &
echo $! > "$PIDFILE"
echo "Agent M bot started (PID: $(cat "$PIDFILE"))"
