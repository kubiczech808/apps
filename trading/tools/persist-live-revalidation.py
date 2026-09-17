#!/usr/bin/env python3
"""Write a live execution run's revalidation verdicts back into the scraped catalogue.

Shared by both live portfolios. It used to be a heredoc inside the main live workflow,
and 5050 simply had no equivalent -- so a market that portfolio found gone stayed READY
in its candidate list and was re-fetched and re-rejected on every pass. Duplicating the
heredoc would have meant fixing bugs in it twice, which had already happened once: the
catalogue moved into sibling segment files and the merge kept writing to the core.

It used to do the merge here, which meant pulling both catalogue segments down over FTP,
patching a handful of rows, and pushing the whole thing back. Measured on live execution
run 35262648170 -- 101 seconds end to end -- that was 39 seconds, more than a third of the
run and more than seven times the 5 seconds the decision and the order submission took
together. The observations segment is the 8,091-row catalogue and is measured in megabytes;
the verdicts that change it are a few hundred bytes.

So the verdicts travel and the catalogue stays put: they are POSTed to
action=live-revalidation-merge, which holds the merge rules now. Sending the same verdicts
twice is harmless -- a stored verdict newer than the one arriving wins -- so a failed
attempt is simply retried.

Environment:
  LIVE_EXECUTION_STATE_FILE      the run's execution state, read for revalidationUpdates
  TRADING_TRIGGER_KEY            the server-side key the merge endpoint requires
  LIVE_REVALIDATION_MERGE_URL    optional override of the endpoint
"""
import json
import os
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

execution_path = Path(os.environ["LIVE_EXECUTION_STATE_FILE"])
if not execution_path.exists():
    print("No live execution state was generated; no evaluation update to persist.")
    raise SystemExit(0)

execution = json.loads(execution_path.read_text(encoding="utf-8"))
updates = [item for item in execution.get("revalidationUpdates", []) if item.get("tokenId")]
if not updates:
    print("No candidates were revalidated; paper evaluation state is unchanged.")
    raise SystemExit(0)

url = os.environ.get("LIVE_REVALIDATION_MERGE_URL") or (
    "https://osobnizkusenosti.cz/trading/api.php?action=live-revalidation-merge"
)
key = os.environ.get("TRADING_TRIGGER_KEY", "")
if not key:
    # Failing here rather than sending an unauthenticated request: the endpoint would
    # refuse it anyway, and the difference between "not configured" and "rejected" is the
    # whole diagnosis.
    raise SystemExit("TRADING_TRIGGER_KEY is not configured; the revalidation merge cannot be authenticated.")

body = json.dumps({"updates": updates}, ensure_ascii=False).encode("utf-8")
print(f"Sending {len(updates)} live revalidation verdicts to the merge endpoint ({len(body)} bytes).")


def merge_once():
    request = urllib.request.Request(
        url,
        data=body,
        method="POST",
        headers={"Content-Type": "application/json", "X-Trading-Trigger-Key": key},
    )
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            return json.loads(response.read().decode("utf-8")), None
    except urllib.error.HTTPError as error:
        try:
            payload = json.loads(error.read().decode("utf-8"))
        except Exception:
            payload = {}
        return payload, f"HTTP {error.code}: {payload.get('error') or 'no detail'}"
    except Exception as error:  # noqa: BLE001 -- transport, DNS, timeout
        return {}, str(error)


payload = {}
failure = None
# Re-sending is safe, so a hiccup on a constrained shared host is retried rather than
# losing a run's verdicts -- every unpersisted verdict is a candidate the next pass pays a
# live fetch to reject again.
for attempt in range(3):
    if attempt:
        time.sleep(2 ** attempt)
    payload, failure = merge_once()
    if failure is None and payload.get("ok"):
        break
    print(f"Revalidation merge attempt {attempt + 1} failed: {failure or payload.get('error') or 'no detail'}")

if failure is not None or not payload.get("ok"):
    raise SystemExit(f"Revalidation merge failed: {failure or payload.get('error') or 'no detail'}")

merged = int(payload.get("merged") or 0)
segments = payload.get("segments") or []
closed_out = payload.get("closedOut") or []
if closed_out:
    print(f"Closed out {len(closed_out)} rows whose market no longer exists: {sorted(closed_out)}")
if not merged:
    print("Revalidated tokens were no longer present in remote evaluation or scraped market state.")
    raise SystemExit(0)
print(f"Persisted {merged} live revalidation updates into {', '.join(segments) or 'the catalogue'}"
      f" at {datetime.now(timezone.utc).isoformat()}")
