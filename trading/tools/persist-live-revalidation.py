#!/usr/bin/env python3
"""Write a live execution run's revalidation verdicts back into the scraped catalogue.

Shared by both live portfolios. It used to be a heredoc inside the main live workflow,
and 5050 simply had no equivalent -- so a market that portfolio found gone stayed READY
in its candidate list and was re-fetched and re-rejected on every pass. Duplicating the
heredoc would have meant fixing bugs in it twice, which had already happened once: the
catalogue moved into sibling segment files and the merge kept writing to the core.

Environment:
  LIVE_EXECUTION_STATE_FILE  the run's execution state, read for revalidationUpdates
  HOSTING_FTP_SERVER / _USERNAME / _PASSWORD, TRADING_FTP_DIR
"""
import ftplib
import io
import json
import os
import re
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

target = os.environ["TRADING_FTP_DIR"].strip("/")
def enter_dir(ftp, parts):
    try:
        ftp.cwd("/")
    except ftplib.all_errors:
        pass
    for part in parts:
        if not part:
            continue
        ftp.cwd(part)

with ftplib.FTP(os.environ["HOSTING_FTP_SERVER"], timeout=30) as ftp:
    ftp.login(os.environ["HOSTING_FTP_USERNAME"], os.environ["HOSTING_FTP_PASSWORD"])
    enter_dir(ftp, target.split("/"))

    def read_json(name):
        buffer = io.BytesIO()
        ftp.retrbinary(f"RETR {name}", buffer.write)
        return json.loads(buffer.getvalue().decode("utf-8"))

    def write_json(name, payload):
        body = (json.dumps(payload, ensure_ascii=False) + "\n").encode("utf-8")
        temporary = name + ".live-revalidation-uploading"
        ftp.storbinary(f"STOR {temporary}", io.BytesIO(body))
        try:
            ftp.rename(temporary, name)
        except ftplib.all_errors:
            ftp.delete(name)
            ftp.rename(temporary, name)

    # The catalogue moved out of paper-state.json into sibling segment files,
    # and the core keeps those fields as empty arrays. Merging into the core
    # was therefore merging into nothing on every run: no verdict was ever
    # persisted, so a market Gamma had already dropped kept being shortlisted,
    # re-fetched and re-rejected, and never left the candidate list. Follow the
    # manifest to the files that actually hold the rows.
    core = read_json("paper-state.json")
    manifest = core.get("stateSegments") if isinstance(core.get("stateSegments"), dict) else {}
    documents = {"paper-state.json": core}
    plan = []
    for segment, field in (("evaluations", "evaluations"), ("observations", "marketObservations")):
        entry = manifest.get(segment) if isinstance(manifest.get(segment), dict) else None
        name = str(entry.get("file") or "") if entry else ""
        # The manifest is generated data that still arrives as file content, so
        # the name is constrained to a plain sibling file. A state written
        # before segmentation carries the rows in the core itself.
        if not re.fullmatch(r"[A-Za-z0-9._-]+\.json", name):
            name = "paper-state.json"
        if name not in documents:
            documents[name] = read_json(name)
        plan.append((name, field))

    closed_out = []
    def merge_revalidation(rows, label):
        if not isinstance(rows, list):
            return 0
        by_token = {str(item.get("tokenId")): item for item in rows if isinstance(item, dict) and item.get("tokenId")}
        merged = 0
        for update in updates:
            item = by_token.get(str(update["tokenId"]))
            if not item:
                continue
            existing = item.get("executionRevalidation") if isinstance(item.get("executionRevalidation"), dict) else {}
            if existing.get("checkedAt", "") > update.get("checkedAt", ""):
                continue
            item["executionRevalidation"] = update
            # The source record stays scraped/evaluated; this is the current
            # execution verdict for the portfolio shortlist.
            for field in ("marketPrice", "marketProbability", "annualizedReturn", "expectedValueUsdc", "daysToResolution", "liquidity", "netGainIfWinUsdc", "totalCostUsdc", "orderPrice", "orderSize", "orderNotionalUsdc", "minOrderSize", "spread", "feeRate"):
                if field in update:
                    item[field] = update[field]
            # A market Gamma no longer lists, or one that stopped accepting
            # orders, cannot come back. Closing the stored row out is what
            # removes it from the candidate list for good; otherwise the
            # prefilter keeps shortlisting it and every run pays for a live
            # fetch just to reject it again.
            if update.get("marketGone"):
                item["status"] = "CLOSED"
                item["selectionStatus"] = "CLOSED"
                item["marketClosed"] = True
                item["acceptingOrders"] = False
                # Two different ends look identical once the row reads CLOSED: a
                # market Gamma dropped, and an event that has finished but has not
                # been settled yet. The second is still expecting a result, so it
                # says so -- otherwise a row that left the candidate list on the day
                # of its own match cannot be told apart from one that was delisted,
                # and the reason is lost along with it.
                if update.get("awaitingResolution"):
                    item["awaitingResolution"] = True
                    item["closedReason"] = "finished, awaiting Polymarket resolution"
                closed_out.append(str(update["tokenId"]))
            item["updatedAt"] = update["checkedAt"]
            merged += 1
        print(f"Merged {merged} live revalidation updates into {label}.")
        return merged

    merged = 0
    changed = set()
    for name, field in plan:
        count = merge_revalidation(documents[name].get(field), f"{name} -> {field}")
        merged += count
        if count:
            changed.add(name)
    if closed_out:
        print(f"Closed out {len(set(closed_out))} rows whose market no longer exists: {sorted(set(closed_out))}")
    if not merged:
        print("Revalidated tokens were no longer present in remote evaluation or scraped market state.")
        raise SystemExit(0)

    # Written compactly, the way the bot writes them: the observations segment
    # is measured in megabytes and indenting it would inflate it for nothing.
    for name in sorted(changed):
        write_json(name, documents[name])
    print(f"Persisted {merged} live revalidation updates into {', '.join(sorted(changed))} at {datetime.now(timezone.utc).isoformat()}")
