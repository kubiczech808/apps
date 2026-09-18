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

# 4. What a row is made OF, and which of it anything reads.
#
#    The first version of this asked the server which fields were read, and the server
#    answered from a list I had written from memory. It was wrong -- riskGroupLabels is
#    rendered in the risk column, marketDataUpdatedAt is the "Scraped" column,
#    scheduledEventDate is where the horizon comes from, binaryYesTokenId decides whether a
#    market is binary, marketId blocks a second position in the same live market -- and it
#    produced a confident "69% is never consulted, 426 MB recoverable" that would have broken
#    the dashboard and the bot if anyone had acted on it.
#
#    So the question is answered where the evidence is. This runs inside the repository
#    checkout, so for every field the sample contains it greps the files that actually run --
#    api.php, storage.php, the browser app, and each bot -- and a field counts as read when
#    something other than the line that WRITES it mentions it.
print("\n== what an observation row is made of")

RUNTIME = [
    "api.php", "storage.php", "assets/app.js",
    "tools/paper-trading-bot.mjs", "tools/live-order-executor.mjs",
    "tools/rpi-live-exit-worker.mjs", "tools/live-account-sync.mjs",
]


# Resolved against THIS FILE, never against the working directory. The workflow runs
# `python3 trading/tools/storage-footprint-probe.py` from the repository root, so opening
# "api.php" found nothing -- and the probe then reported that 97% of every row is named
# nowhere, listing tokenId, question and slug among the unused. A path assumption produced a
# confident falsehood, which is the same failure as the hand-written list it replaced.
TRADING_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def runtime_sources():
    sources = {}
    for name in RUNTIME:
        try:
            with open(os.path.join(TRADING_DIR, name), "r", encoding="utf-8", errors="replace") as handle:
                sources[name] = handle.read()
        except OSError:
            continue
    return sources


SOURCES = runtime_sources()
print(f"   runtime files read from {TRADING_DIR}: {len(SOURCES)} of {len(RUNTIME)}")
if SOURCES:
    print(f"   {', '.join(SOURCES)}")


def mentions(field):
    """Files that name this field, and how many times."""
    hits = {}
    for name, text in SOURCES.items():
        count = text.count(field)
        if count:
            hits[name] = count
    return hits


report = admin("payload-anatomy", {"sample": 200})
anatomy = report.get("anatomy") or {}
if not anatomy:
    print(f"   could not read: {json.dumps(report)[:400]}")
else:
    sampled = int(anatomy.get("sampledRows") or 0)
    fields = anatomy.get("fields") or []
    print(f"   sampled {sampled} row(s) from both ends of the archive")
    print(f"   stored (packed) per row : {int(anatomy.get('storedBytesPerRow') or 0):,} bytes")
    print(f"   decoded per row         : "
          f"{int((anatomy.get('decodedBytes') or 0) / max(1, sampled)):,} bytes")
    print(f"   distinct fields seen    : {len(fields)}")

    if not SOURCES:
        # Nothing to grep means nothing is known. Reporting "unused" here is how the last
        # run announced that tokenId is read by nobody.
        print("\n   CANNOT DECIDE what is read: no runtime file could be opened.")
        print("   Field sizes below are still valid; the used/unused split is not computed.")
        for row in fields[:20]:
            print(f"   {str(row.get('field'))[:28]:<30}{int(row.get('bytesPerRow') or 0):>10} bytes/row")
        raise SystemExit(0)

    unread = [row for row in fields if not mentions(str(row.get("field")))]
    read = [row for row in fields if mentions(str(row.get("field")))]
    unread_bytes = sum(int(row.get("bytesPerRow") or 0) for row in unread)
    read_bytes = sum(int(row.get("bytesPerRow") or 0) for row in read)

    print("\n   the twenty largest fields, and where they are used")
    print("   field                          bytes/row   used by")
    for row in fields[:20]:
        field = str(row.get("field"))
        where = mentions(field)
        used = ", ".join(f"{name.split('/')[-1]}x{count}" for name, count in list(where.items())[:3])
        print(f"   {field[:28]:<30}{int(row.get('bytesPerRow') or 0):>10}   {used or 'NOTHING'}")

    print(f"\n   bytes/row named somewhere in the runtime : {read_bytes:,}")
    print(f"   bytes/row named NOWHERE                 : {unread_bytes:,}")
    if unread:
        print("   fields nothing mentions:")
        for row in sorted(unread, key=lambda entry: -int(entry.get("bytesPerRow") or 0))[:15]:
            print(f"      {str(row.get('field'))[:34]:<36}{int(row.get('bytesPerRow') or 0):>8} bytes/row")

    # Stated carefully. A grep proves a field is NAMED, not that dropping it is safe -- a
    # field may be written and never read back, and only reading the call site tells them
    # apart. What this bounds is the opposite direction: a field nothing names at all cannot
    # be being read, so that total is a floor on what is removable, not a target.
    observations_mb = None
    for row in (footprint.get("tables") or []):
        if row.get("table") == "trading_observations":
            observations_mb = int(row.get("totalBytes") or 0) / 1048576
    decoded_per_row = (anatomy.get("decodedBytes") or 0) / max(1, sampled)
    if observations_mb and decoded_per_row:
        share = unread_bytes / decoded_per_row
        stored_per_row = int(anatomy.get("storedBytesPerRow") or 0)
        observation_rows = 0
        for row in (footprint.get("tables") or []):
            if row.get("table") == "trading_observations":
                observation_rows = int(row.get("rows") or 0)
        payload_mb = stored_per_row * observation_rows / 1048576 if observation_rows else None
        print(f"\n   trading_observations is {observations_mb:.0f} MB in total.")
        if payload_mb:
            print(f"   The packed payload accounts for about {payload_mb:.0f} MB of that"
                  f" ({payload_mb / observations_mb * 100:.0f}%);")
            print("   the rest is the structured columns, tags_json and the indexes -- which payload")
            print("   slimming does not touch, so the table can never shrink below that remainder.")
        print(f"   Fields nothing in the runtime even NAMES are {share * 100:.0f}% of a decoded row.")
        print("   That is a FLOOR on what could be dropped, not a target: a field being named is")
        print("   not proof it is read, so each candidate still has to be checked at its call site.")

# 5. The indexes. Unlike the payload -- where every field turned out to be read somewhere --
#    index redundancy is provable from the column lists: an index whose columns are a
#    leftmost prefix of another's can serve no query the wider one cannot.
print("\n== indexes on the Trading tables")
report = admin("index-inventory")
indexes = report.get("indexes") or []
if not indexes:
    print(f"   could not read: {json.dumps(report)[:400]}")
else:
    print("   table                    index                                    cols  cardinality  covered by")
    for row in indexes:
        covered = row.get("coveredBy")
        print(f"   {str(row.get('table'))[:22]:<25}{str(row.get('index'))[:38]:<40}"
              f"{len(row.get('columns') or []):>5}{int(row.get('cardinality') or 0):>13}"
              f"   {covered or ('UNIQUE' if row.get('unique') else '-')}")
    for row in indexes:
        if row.get("coveredBy"):
            print(f"\n   {row['table']}.{row['index']} ({', '.join(row.get('columns') or [])})")
            print(f"   is a leftmost prefix of {row['coveredBy']}. Every query it can serve, the wider")
            print("   index serves too, so dropping it changes no plan -- that is a property of B-tree")
            print("   indexing, not a judgement about this application.")
    redundant = [row for row in indexes if row.get("coveredBy")]
    if not redundant:
        print("\n   No index is a prefix of another. Index size is not recoverable this way.")
