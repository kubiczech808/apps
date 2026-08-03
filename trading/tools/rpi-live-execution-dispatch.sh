#!/usr/bin/env bash
set -euo pipefail

REPO="kubiczech808/apps"
WORKFLOW="polymarket-live-limit-order-test.yml"
REF="claude/energy-consumption-app-Nf7bh"
CONFIG_URL="https://www.osobnizkusenosti.cz/trading/api.php?action=portfolio-config"
LOG="$HOME/.local/state/trading/live-execution-dispatch.log"

mkdir -p "$(dirname "$LOG")"
exec >>"$LOG" 2>&1

echo "[$(date -Is)] scheduler tick"

# The RPi is a fallback for GitHub's delayed schedules. It must not bypass the
# portfolio setting that switches execution to post-scrape dispatches.
execution_trigger="$(curl --fail --silent --show-error --max-time 15 "$CONFIG_URL" | python3 -c 'import json, sys; print((json.load(sys.stdin).get("config") or {}).get("live", {}).get("executionTrigger", "cron"))' 2>/dev/null || true)"
if [ "$execution_trigger" = "after_scrape" ]; then
  echo "[$(date -Is)] skip: live portfolio executes after scraping batches"
  exit 0
fi
if [ -z "$execution_trigger" ]; then
  echo "[$(date -Is)] skip: live portfolio config could not be read"
  exit 0
fi

latest_created="$(gh run list --repo "$REPO" --workflow "$WORKFLOW" --limit 8 --json createdAt,event,status --jq '[.[] | select(.event == "schedule" or .event == "workflow_dispatch")] | sort_by(.createdAt) | reverse | .[0].createdAt // ""' 2>/dev/null || true)"
if [ -n "$latest_created" ]; then
  latest_epoch="$(date -u -d "$latest_created" +%s 2>/dev/null || echo 0)"
  now_epoch="$(date -u +%s)"
  age=$((now_epoch - latest_epoch))
  if [ "$latest_epoch" -gt 0 ] && [ "$age" -lt 600 ]; then
    echo "[$(date -Is)] skip: latest live execution workflow is ${age}s old (${latest_created})"
    exit 0
  fi
fi

gh workflow run "$WORKFLOW" --repo "$REPO" --ref "$REF" -f live_confirm=true -f live_ignore_trade_cadence=false -f live_execution_trigger=cron
echo "[$(date -Is)] dispatched $WORKFLOW on $REF"
