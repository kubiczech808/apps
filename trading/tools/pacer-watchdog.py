#!/usr/bin/env python3
"""Decides whether the pacer chain is dead, and restarts it if it is.

What happened, and why the existing resurrection path did not help. The pipeline is driven by
a self-dispatching chain: each pacer run waits, wakes the scan, and dispatches the next link.
On 18.9. at 09:23 that hand-off answered

    422 Cannot trigger a 'workflow_dispatch' on a disabled workflow

five times, and the chain stopped. Automatic execution was dead for four hours until it was
restarted by hand, and the only thing that noticed was the owner, looking at a live portfolio
that had not traded.

The pacer already carries an hourly cron for exactly this -- "the resurrection path: if the
chain ever dies ... a schedule delivered at 2% still restarts it within a few hours". It could
not work here, because a disabled workflow does not run its own schedule either. A loop cannot
resurrect itself from inside itself.

So this lives somewhere else, and it distinguishes the two cases rather than retrying blindly:

  the chain is merely dead  -> dispatch it, and it runs again
  the workflow is disabled  -> no dispatch can fix that. Say so, loudly, because clearing it
                               needs a person in the Actions UI and nothing else will.

It is deliberately conservative about what counts as dead. The pacer runs under
`cancel-in-progress: true`, so dispatching it while it is alive KILLS the running link and
starts a new one -- a watchdog that fires on a healthy chain does not protect the pipeline, it
interrupts it.
"""

from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone

# A tick is three minutes and a scan every ten, so runs are created every few minutes. Silence
# beyond this is not a slow link, it is a broken chain.
DEFAULT_MAX_SILENCE_MINUTES = 25.0
# The pacer job's own timeout. A run still "in progress" past this is not running, it is stuck,
# and GitHub will kill it -- so it stops counting as proof the chain is alive.
DEFAULT_STUCK_MINUTES = 65.0
# A scan normally wakes paper execution immediately afterwards. This is deliberately wider
# than that normal cycle: it is only a recovery floor for a broken hand-off.
DEFAULT_PIPELINE_SILENCE_MINUTES = 20.0
DEFAULT_PIPELINE_STUCK_MINUTES = 15.0


def _moment(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None


def decide(
    runs: list,
    now: datetime,
    max_silence_minutes: float = DEFAULT_MAX_SILENCE_MINUTES,
    stuck_minutes: float = DEFAULT_STUCK_MINUTES,
) -> dict:
    """Whether to restart the pacer, and the arithmetic behind the answer."""
    dated = []
    for run in runs or []:
        started = _moment(run.get("created_at"))
        if started is not None:
            dated.append((started, run))
    dated.sort(key=lambda pair: pair[0], reverse=True)

    if not dated:
        return {
            "restart": True,
            "reason": "no pacer run on record at all; starting the chain",
            "ageMinutes": None,
            "alive": False,
        }

    newest_at, newest = dated[0]
    age = (now - newest_at).total_seconds() / 60.0

    # A run that is genuinely still going is the chain working. Dispatching over it would
    # cancel it, because the pacer collapses duplicates with cancel-in-progress.
    for started, run in dated:
        if str(run.get("status")) in {"in_progress", "queued", "requested", "waiting"}:
            running_for = (now - started).total_seconds() / 60.0
            if running_for <= stuck_minutes:
                return {
                    "restart": False,
                    "reason": f"a pacer run has been {run.get('status')} for"
                              f" {running_for:,.0f} minute(s); the chain is alive",
                    "ageMinutes": round(age, 1),
                    "alive": True,
                }
            return {
                "restart": True,
                "reason": f"a pacer run has been {run.get('status')} for {running_for:,.0f}"
                          f" minute(s), past the {stuck_minutes:,.0f}-minute job timeout;"
                          " it is stuck, not working",
                "ageMinutes": round(age, 1),
                "alive": False,
            }

    if age <= max_silence_minutes:
        return {
            "restart": False,
            "reason": f"the last pacer run started {age:,.1f} minute(s) ago,"
                      f" inside the {max_silence_minutes:,.0f}-minute window",
            "ageMinutes": round(age, 1),
            "alive": True,
        }

    return {
        "restart": True,
        "reason": f"the last pacer run started {age:,.1f} minute(s) ago, past the"
                  f" {max_silence_minutes:,.0f}-minute window"
                  f" (conclusion: {newest.get('conclusion') or newest.get('status')});"
                  " the chain is dead",
        "ageMinutes": round(age, 1),
        "alive": False,
    }


def decide_workflow_recovery(
    runs: list,
    now: datetime,
    silence_minutes: float = DEFAULT_PIPELINE_SILENCE_MINUTES,
    stuck_minutes: float = DEFAULT_PIPELINE_STUCK_MINUTES,
) -> dict:
    """Whether one downstream workflow needs a bounded recovery dispatch."""
    dated = []
    for run in runs or []:
        created = _moment(run.get("created_at"))
        if created is not None:
            dated.append((created, run))
    dated.sort(key=lambda pair: pair[0], reverse=True)

    if not dated:
        return {"dispatch": True, "reason": "no run on record"}

    newest_at, newest = dated[0]
    age = (now - newest_at).total_seconds() / 60.0
    status = str(newest.get("status") or "")
    conclusion = str(newest.get("conclusion") or "")

    if status in {"queued", "in_progress", "requested", "waiting", "pending"}:
        if age <= stuck_minutes:
            return {
                "dispatch": False,
                "reason": f"a run is {status} and only {age:.1f} minute(s) old",
            }
        return {
            "dispatch": True,
            "reason": f"a run has been {status} for {age:.1f} minute(s), past its safe window",
        }

    if conclusion == "success" and age <= silence_minutes:
        return {
            "dispatch": False,
            "reason": f"last successful run was {age:.1f} minute(s) ago",
        }

    return {
        "dispatch": True,
        "reason": f"last run was {age:.1f} minute(s) ago ({conclusion or status or 'unknown'})",
    }


def _api(url: str, token: str, method: str = "GET", body: dict | None = None):
    request = urllib.request.Request(
        url,
        data=json.dumps(body).encode("utf-8") if body is not None else None,
        method=method,
        headers={
            "Authorization": f"Bearer {token}",
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "Content-Type": "application/json",
        },
    )
    with urllib.request.urlopen(request, timeout=60) as response:
        raw = response.read().decode("utf-8")
    return json.loads(raw) if raw else {}


def main() -> int:
    token = os.environ["GH_TOKEN"]
    repository = os.environ["REPOSITORY"]
    ref = os.environ.get("REF") or "main"
    workflow = os.environ.get("PACER_WORKFLOW") or "trading-pacer.yml"
    base = f"https://api.github.com/repos/{repository}/actions/workflows/{workflow}"

    listing = _api(f"{base}/runs?per_page=10", token)
    verdict = decide(listing.get("workflow_runs") or [], datetime.now(timezone.utc))
    print(verdict["reason"])
    if verdict["restart"]:
        try:
            _api(f"{base}/dispatches", token, method="POST",
                 body={"ref": ref, "inputs": {"interval_minutes": "3", "tick": "0"}})
        except urllib.error.HTTPError as error:
            detail = error.read().decode("utf-8", "replace")
            if "disabled workflow" in detail:
                # The one failure a retry cannot fix. A disabled workflow runs neither its own
                # schedule nor anyone's dispatch, so the chain stays dead until a person enables
                # it in the Actions UI -- which is why this is loud rather than another retry.
                print("::error title=Pacer workflow is DISABLED::Automatic execution is stopped and"
                      " cannot be restarted by dispatch. Enable Trading Pacer in the repository's"
                      " Actions tab.")
                return 1
            print(f"::error title=Pacer restart failed::HTTP {error.code}: {detail[:300]}")
            return 1
        print("::notice title=Pacer restarted::the chain was dead and has been dispatched again")

    # A live pacer proves only that its loop is alive. It does not prove that each downstream
    # dispatch was accepted, so independently recover stale scan and paper heartbeats. These
    # recovery calls do not touch live execution; that stays exclusively in the normal planner.
    downstream = (
        (
            "trading-market-scan.yml",
            {"market_scan_tag": "", "market_scan_liquidity_min": "0",
             "market_scan_max_days": "-1", "run_source": "AUTO"},
            "market scan",
        ),
        ("trading-paper-bot.yml", {"mode": "after_scan"}, "paper execution"),
    )
    now = datetime.now(timezone.utc)
    for workflow_name, inputs, label in downstream:
        workflow_base = f"https://api.github.com/repos/{repository}/actions/workflows/{workflow_name}"
        try:
            runs = _api(f"{workflow_base}/runs?per_page=10", token).get("workflow_runs") or []
            recovery = decide_workflow_recovery(runs, now)
        except (urllib.error.HTTPError, urllib.error.URLError) as error:
            print(f"::warning::could not inspect {label} freshness: {error}")
            continue
        print(f"{label}: {recovery['reason']}")
        if not recovery["dispatch"]:
            continue
        try:
            _api(workflow_base + "/dispatches", token, method="POST", body={"ref": ref, "inputs": inputs})
            print(f"::notice title={label.title()} recovered::dispatched after stale heartbeat")
        except urllib.error.HTTPError as error:
            detail = error.read().decode("utf-8", "replace")
            print(f"::warning::could not recover {label}: HTTP {error.code}: {detail[:300]}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
