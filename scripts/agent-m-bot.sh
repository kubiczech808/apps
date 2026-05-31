#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="/home/jakub/apps/medium-poster"
VENV_DIR="$REPO_DIR/.venv"
SERVICE_NAME="agent-m-bot"
LOG="/tmp/agent-m-bot.log"

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

# Install Chromium for Medium Playwright
playwright install chromium 2>/dev/null || true

# Install systemd service if not present or outdated
SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"
SOURCE_FILE="/home/jakub/scripts/agent-m-bot.service"
if [ -f "$SOURCE_FILE" ]; then
    if ! cmp -s "$SOURCE_FILE" "$SERVICE_FILE" 2>/dev/null; then
        sudo cp "$SOURCE_FILE" "$SERVICE_FILE"
        sudo systemctl daemon-reload
        sudo systemctl enable "$SERVICE_NAME"
        echo "Systemd service installed/updated"
    fi
fi

# Restart via systemd
sudo systemctl restart "$SERVICE_NAME"
sleep 2

# Verify
if systemctl is-active --quiet "$SERVICE_NAME"; then
    PID=$(systemctl show -p MainPID --value "$SERVICE_NAME")
    echo "Agent M bot started (PID: $PID) via systemd"
else
    echo "ERROR: systemd service failed to start, falling back to nohup"
    # Kill any remaining processes
    pkill -9 -f "python.*agent_m" 2>/dev/null || true
    sleep 2
    nohup python -u -m agent_m >> "$LOG" 2>&1 &
    echo $! > /tmp/agent-m-bot.pid
    echo "Agent M bot started (PID: $!) via nohup fallback"
fi
