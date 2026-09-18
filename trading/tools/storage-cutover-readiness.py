#!/usr/bin/env python3
"""What would break, and what it would cost, if reads were switched to MySQL today.

Read-only. Every request is a GET. Nothing is written, no switch is flipped: the database
path is reached through storage_preview=1, which serves ONE request from MySQL and leaves
the stored switch exactly where it was.

Asked for: "dokonci prechod na mysql databazi."

The switch itself is one meta row. What makes the cutover risky is not flipping it, it is
that every read the dashboard and the bots make has to keep answering the same thing
afterwards -- and the last attempt ran the host out of its 512 MB decoding the catalogue.
One incident is already on record: served from the database, the paper bot's rebuild read
answered with thirty-six portfolios and no trades, and the bot published that back over the
files. api.php refuses that read from the database now, which is a blocker rather than a
fix: the cutover is not done while a read the bot depends on cannot be served.

So each read the application actually makes is fetched BOTH ways and compared:

  status     -- a path that 500s from the database is a hard blocker
  ms         -- the cost, per path, so a slow one can be found before a user finds it
  bytes      -- a big difference means different content, not different formatting
  shape      -- the counts that decide whether the answer is usable, per path

A path is GREEN only if the database answered, answered in a comparable shape, and did not
cost dramatically more. Anything else is named.

Environment:
  TRADING_TRIGGER_KEY   required; the preview parameter is refused without it
  TRADING_HOST          optional override
"""
import json
import os
import time
import urllib.error
import urllib.request

HOST = (os.environ.get("TRADING_HOST") or "https://osobnizkusenosti.cz/trading").rstrip("/")
KEY = os.environ.get("TRADING_TRIGGER_KEY", "")

# The reads the dashboard and the bots actually make, taken from assets/app.js and from the
# workflows. Inventing plausible-looking ones would measure paths nothing uses.
READS = [
    ("dashboard state", "api.php?action=state&target=paper&summary=dashboard"),
    ("portfolio overview", "api.php?action=state&target=paper&summary=portfolio-overview"),
    ("bot rebuild", "api.php?action=state&target=paper&summary=refresh"),
    ("live state", "api.php?action=state&target=live"),
    ("catalogue (active)", "api.php?action=state&target=paper&segments=observations"),
    ("catalogue (resolved)", "api.php?action=state&target=paper&segments=resolvedRecent"),
    ("portfolio config", "api.php?action=portfolio-config"),
    ("scan preferences", "api.php?action=scan-preferences"),
    ("scan history", "api.php?action=scan-history&page=1"),
    ("setup finder", "api.php?action=resolved-combinations&min_trades=25"),
    ("taxonomy", "api.php?action=taxonomy-observations&target=paper"),
]


def fetch(path, preview):
    url = f"{HOST}/{path}"
    if preview:
        url += ("&" if "?" in url else "?") + "storage_preview=1"
    request = urllib.request.Request(url, headers={"Accept": "application/json"})
    if preview:
        request.add_header("X-Trading-Trigger-Key", KEY)
    started = time.monotonic()
    try:
        with urllib.request.urlopen(request, timeout=180) as response:
            body = response.read()
            status = response.status
    except urllib.error.HTTPError as error:
        body = error.read()
        status = error.code
    except Exception as error:  # a timeout or a reset is itself the finding
        return {"status": 0, "ms": int((time.monotonic() - started) * 1000),
                "bytes": 0, "body": None, "error": str(error)[:120]}
    elapsed = int((time.monotonic() - started) * 1000)
    try:
        parsed = json.loads(body.decode("utf-8"))
    except Exception:
        parsed = None
    return {"status": status, "ms": elapsed, "bytes": len(body), "body": parsed,
            "error": None if parsed is not None else "not JSON"}


def shape(result):
    """The few counts that decide whether an answer is usable, whatever the path."""
    body = result.get("body")
    if not isinstance(body, dict):
        return {}
    out = {}
    portfolios = body.get("paperPortfolios")
    if isinstance(portfolios, dict):
        out["portfolios"] = len(portfolios)
        out["trades"] = sum(
            len(entry.get("trades") or []) for entry in portfolios.values() if isinstance(entry, dict))
    for field in ("marketObservations", "resolvedMarketObservations", "trades", "rows", "history"):
        value = body.get(field)
        if isinstance(value, list):
            out[field] = len(value)
    for field in ("best", "worst"):
        value = body.get(field)
        if isinstance(value, list):
            out[field] = len(value)
    if isinstance(body.get("stateSegments"), dict):
        out["segments"] = len(body["stateSegments"])
    if isinstance(body.get("config"), dict):
        config = body["config"]
        out["paperCfg"] = len(config.get("paper") or {})
        out["liveCfg"] = len(config.get("livePortfolios") or {})
    if body.get("ok") is False:
        out["refused"] = str(body.get("reason") or body.get("error") or "")[:40]
    return out


print("MySQL cutover readiness")
print("Read-only: every request is a GET, no switch is flipped.\n")
print(f"{'read':<22}{'files':>22}{'database':>22}   verdict")
print(f"{'':22}{'status  ms   bytes':>22}{'status  ms   bytes':>22}")

blockers = []
warnings = []
for name, path in READS:
    files = fetch(path, preview=False)
    database = fetch(path, preview=True)

    def cell(result):
        return f"{result['status']:>6}{result['ms']:>5}{result['bytes']:>9}"

    fileShape, dbShape = shape(files), shape(database)
    verdict = "ok"
    if database["status"] >= 500 or database["status"] == 0:
        verdict = "BLOCKER: database path fails"
        blockers.append((name, database.get("error") or f"HTTP {database['status']}"))
    elif dbShape.get("refused"):
        verdict = f"BLOCKER: refused ({dbShape['refused']})"
        blockers.append((name, f"refused: {dbShape['refused']}"))
    elif files["status"] < 400 and database["status"] >= 400:
        verdict = f"BLOCKER: HTTP {database['status']} where files answer"
        blockers.append((name, f"HTTP {database['status']}"))
    else:
        # Same request, materially different answer: not a formatting difference.
        differences = [
            f"{field} {fileShape.get(field)}->{dbShape.get(field)}"
            for field in sorted(set(fileShape) | set(dbShape))
            if field != "refused" and fileShape.get(field) != dbShape.get(field)
        ]
        if differences:
            verdict = "DIFFERS: " + ", ".join(differences[:4])
            warnings.append((name, ", ".join(differences)))
        elif files["ms"] > 0 and database["ms"] > max(1500, files["ms"] * 3):
            verdict = f"SLOW: {database['ms']}ms vs {files['ms']}ms"
            warnings.append((name, f"{database['ms']}ms vs {files['ms']}ms"))

    print(f"{name:<22}{cell(files):>22}{cell(database):>22}   {verdict}")

print()
if blockers:
    print("BLOCKERS -- the cutover cannot be completed while these stand:")
    for name, why in blockers:
        print(f"   {name}: {why}")
else:
    print("No blocker: every read the application makes was answered from the database.")
if warnings:
    print("\nDifferences and costs worth deciding on before flipping:")
    for name, why in warnings:
        print(f"   {name}: {why}")
