#!/usr/bin/env python3
"""What the trading database is actually made of, and whether anything reads it yet.

Read-only. Every call is a status or a preview; nothing is written, compacted or dropped.

Two questions, asked together because the answer to one bounds the other:

  "jedeme uz plne z MySQL? predpokladam, ze to ze budeme schopni opatrne zahodit json
   soubory zrychli cteni i zapis."

  "nase mysql databaze nema tolik dat, ale jeji velikost je neumerne vysoka a hrozi
   problemy s uctovanim na hostingu ... nemame tam miliony zaznamu, takze myslim, ze je
   spis chyba v datech nez v mnozstvi."

So this reports, per table: how many rows, how many bytes of data, how many of index, and
how many are FREE -- space inside the tablespace that no row uses. That last column is the
one that decides the diagnosis. A table whose size is mostly data has a data problem; one
whose size is mostly free space has a fragmentation problem, and those need opposite fixes.

Environment:
  TRADING_TRIGGER_KEY   the key the storage-admin endpoint requires
  TRADING_HOST          optional override
"""
import json
import os
import urllib.error
import urllib.request

HOST = (os.environ.get("TRADING_HOST") or "https://osobnizkusenosti.cz/trading").rstrip("/")
KEY = os.environ.get("TRADING_TRIGGER_KEY", "")


def get(path):
    request = urllib.request.Request(f"{HOST}/{path}", headers={"Accept": "application/json"})
    with urllib.request.urlopen(request, timeout=90) as response:
        return json.loads(response.read().decode("utf-8"))


def admin(operation, extra=None):
    body = json.dumps({"operation": operation, **(extra or {})}).encode("utf-8")
    request = urllib.request.Request(
        f"{HOST}/api.php?action=storage-admin", data=body, method="POST",
        headers={"Content-Type": "application/json", "X-Trading-Trigger-Key": KEY},
    )
    try:
        with urllib.request.urlopen(request, timeout=180) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        try:
            return json.loads(error.read().decode("utf-8"))
        except Exception:
            return {"ok": False, "error": f"HTTP {error.code}"}


def mb(value):
    return f"{(int(value or 0) / 1048576):.1f} MB"


print("Trading storage footprint")
print("Read-only: status and preview only, nothing is written.\n")

# 1. Is anything READING the database yet?
status = get("api.php?action=storage-status")
storage = status.get("storage") or {}
print("== is the database the source of truth yet")
print(f"   reads served from MySQL : {status.get('active')}")
print(f"   writes mirrored to MySQL: {storage.get('configured', storage.get('available', '?'))}")
for key in ("driver", "database", "host", "schemaVersion", "migratedAt", "activatedAt"):
    if key in storage:
        print(f"   {key:24}: {storage[key]}")
counts = storage.get("counts") or status.get("counts") or {}
if counts:
    print(f"   stored counts           : {json.dumps(counts)}")

# 2. Where the bytes are -- across the WHOLE schema, because that is what the quota counts.
print("\n== where the bytes are (every table in the schema, largest first)")
report = admin("schema-footprint")
footprint = report.get("footprint") or {}
tables = footprint.get("tables") or []
if not tables:
    print(f"   could not read the schema footprint: {json.dumps(report)[:400]}")
else:
    print("   table                            rows        data       index        free       total")
    for row in tables:
        mark = "*" if row.get("trading") else " "
        print(f" {mark} {row.get('table', ''):<28}{int(row.get('rows') or 0):>8}"
              f"{mb(row.get('dataBytes')):>12}{mb(row.get('indexBytes')):>12}"
              f"{mb(row.get('freeBytes')):>12}{mb(row.get('totalBytes')):>12}")
    totals = footprint.get("totals") or {}
    trading = footprint.get("tradingTotals") or {}
    print(f"   {'SCHEMA TOTAL':<28}{int(totals.get('rows') or 0):>8}"
          f"{mb(totals.get('dataBytes')):>12}{mb(totals.get('indexBytes')):>12}"
          f"{mb(totals.get('freeBytes')):>12}{mb(totals.get('totalBytes')):>12}")
    print(f" * {'of which Trading':<28}{int(trading.get('rows') or 0):>8}"
          f"{mb(trading.get('dataBytes')):>12}{mb(trading.get('indexBytes')):>12}"
          f"{mb(trading.get('freeBytes')):>12}{mb(trading.get('totalBytes')):>12}")

    # The diagnosis, stated rather than left to be read off the columns.
    whole = int(totals.get("totalBytes") or 0)
    free = int(totals.get("freeBytes") or 0)
    ours = int(trading.get("totalBytes") or 0)
    if whole > 0:
        print(f"\n   Trading is {ours / whole * 100:.0f}% of the schema ({mb(ours)} of {mb(whole)}).")
        print(f"   {free / whole * 100:.0f}% of the schema is FREE space -- inside a tablespace, charged for")
        print("   by the hosting, used by no row. Free space comes back from rebuilding a table,")
        print("   not from deleting anything: those rows are already gone.")
    rows = int(trading.get("rows") or 0)
    if rows > 0:
        print(f"   Trading average bytes per row, data only: "
              f"{int(trading.get('dataBytes') or 0) / rows:,.0f}")
    # The single most expensive table, named, because that is where any fix starts.
    worst = tables[0]
    print(f"   Largest single table: {worst.get('table')} at {mb(worst.get('totalBytes'))} "
          f"({mb(worst.get('freeBytes'))} of it free)")

# 3. What compacting the stored payloads would save, without doing it.
print("\n== what compaction would save (preview only)")
preview = admin("compact-preview")
body = preview.get("preview") or {}
if not body:
    print(f"   no preview available: {json.dumps(preview)[:300]}")
else:
    print(f"   {json.dumps(body, indent=2)[:2000]}")

# 4. What a row is made OF. The size question is not "how many rows" -- 224 000 is not
#    millions -- it is 2.8 kB each, and that has never been opened.
print("\n== what an observation row is made of")
report = admin("payload-anatomy", {"sample": 200})
anatomy = report.get("anatomy") or {}
if not anatomy:
    print(f"   could not read: {json.dumps(report)[:400]}")
else:
    sampled = int(anatomy.get("sampledRows") or 0)
    print(f"   sampled {sampled} row(s) from both ends of the archive")
    print(f"   stored (packed) per row   : {int(anatomy.get('storedBytesPerRow') or 0):,} bytes")
    print(f"   decoded per row           : "
          f"{int((anatomy.get('decodedBytes') or 0) / max(1, sampled)):,} bytes")
    print(f"   if it held only what is read: {int(anatomy.get('keptBytesPerRow') or 0):,} bytes"
          f"  ({(anatomy.get('keptShare') or 0) * 100:.0f}% of the decoded row)")
    print("\n   field                          rows    bytes/row   read?")
    for row in (anatomy.get("fields") or [])[:18]:
        print(f"   {str(row.get('field'))[:28]:<30}{int(row.get('rows') or 0):>5}"
              f"{int(row.get('bytesPerRow') or 0):>12}   {'yes' if row.get('read') else 'NO'}")

    # The projection, stated in the units the hosting bills in.
    share = anatomy.get("keptShare")
    if share:
        observations_mb = None
        for row in (footprint.get("tables") or []):
            if row.get("table") == "trading_observations":
                observations_mb = int(row.get("totalBytes") or 0) / 1048576
        if observations_mb:
            print(f"\n   trading_observations is {observations_mb:.0f} MB. Holding only the read")
            print(f"   fields would put it near {observations_mb * share:.0f} MB -- a saving of about")
            print(f"   {observations_mb * (1 - share):.0f} MB, without deleting a single row.")
