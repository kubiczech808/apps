#!/usr/bin/env python3
"""Publish the paper state and its heavy segments over FTP.

The bot writes the state as a small core file plus sibling segment files named by
the core's ``stateSegments`` manifest. Publishing only the core would leave the
hosting with a manifest pointing at the previous run's segments, and the next
merge would then persist that stale catalogue as current. Every workflow that
writes paper state therefore publishes through this one script.

Reads from the environment:
  HOSTING_FTP_SERVER, HOSTING_FTP_USERNAME, HOSTING_FTP_PASSWORD  credentials
  TRADING_FTP_DIR      remote directory (default /www/trading/data)
  PAPER_STATE_FILE     local core state file
  PAPER_UPLOAD_SUFFIX  temp-name suffix, so concurrent workflows cannot collide

No value read here is printed: only file names and byte counts are logged.
"""

import ftplib
import json
import os
import sys
from pathlib import Path


def declared_segments(state_file: Path) -> list[Path]:
    """Local segment files named by the core's manifest, in upload order."""
    try:
        manifest = json.loads(state_file.read_text()).get("stateSegments") or {}
    except (OSError, ValueError) as error:
        raise SystemExit(f"{state_file.name} could not be parsed: {error}") from error

    if not isinstance(manifest, dict):
        raise SystemExit(f"{state_file.name} has a malformed stateSegments manifest")

    segments = []
    for name, entry in sorted(manifest.items()):
        file_name = (entry or {}).get("file") if isinstance(entry, dict) else None
        if not file_name:
            raise SystemExit(f"state segment '{name}' has no file name in the manifest")
        path = state_file.parent / str(file_name)
        # A manifest that names a missing file means the writer was interrupted.
        # Publishing the core alone would orphan the catalogue, so stop here.
        if not path.is_file():
            raise SystemExit(f"state segment '{name}' ({file_name}) was not generated")
        segments.append(path)
    return segments


def enter_dir(ftp: ftplib.FTP, parts: list[str]) -> None:
    try:
        ftp.cwd("/")
    except ftplib.all_errors:
        pass
    for part in parts:
        if not part:
            continue
        try:
            ftp.cwd(part)
        except ftplib.error_perm:
            ftp.mkd(part)
            ftp.cwd(part)


def remove_temporary(ftp: ftplib.FTP, name: str) -> None:
    """Best-effort delete of a half-written upload, so it cannot eat the next one's room."""
    try:
        ftp.delete(name)
    except ftplib.all_errors:
        pass


def publish(ftp: ftplib.FTP, source: Path, suffix: str) -> None:
    """Upload under a temporary name, then swap it in.

    Hosts that cannot overwrite atomically need a fallback, but deleting the live
    file first means a failure at the next step leaves nothing at all. The existing
    file is moved aside to a backup instead, restored if the swap fails, and the
    backup removed only once the new file is in place.
    """
    temporary = f"{source.name}.{suffix}"
    expected = source.stat().st_size
    with source.open("rb") as handle:
        ftp.storbinary(f"STOR {temporary}", handle)

    # A STOR the host could not complete does not reliably answer with an error: the
    # observed failure was a clean-looking upload followed by "550 <temp>: No such file
    # or directory" from the rename. Verifying the size the host actually kept turns that
    # into a legible message instead of a traceback from the next command along.
    #
    # The cause is not necessarily disk space. The account this publishes to was at
    # 3.8 of 10 GB but 96,471 of 100,000 allowed files, and publishing briefly needs one
    # extra file per segment -- a dozen or so at once -- so it can hit a file-count
    # ceiling with gigabytes still free. Both limits are named because the two look
    # identical from here.
    try:
        stored = ftp.size(temporary)
    except ftplib.all_errors:
        stored = None
    if stored is not None and stored != expected:
        remove_temporary(ftp, temporary)
        raise SystemExit(
            f"{source.name}: uploaded {stored} of {expected} bytes. The hosting kept a "
            "short file. Publishing writes a second copy of each segment before swapping "
            "it in, so it needs both roughly twice the state's size free AND one spare "
            "file slot per segment -- check the account's file count as well as its disk "
            "quota, since a file-count ceiling fails exactly like a full disk here."
        )

    try:
        ftp.rename(temporary, source.name)
    except ftplib.all_errors:
        backup = f"{source.name}.previous"
        try:
            ftp.delete(backup)
        except ftplib.all_errors:
            pass
        moved_aside = False
        try:
            ftp.rename(source.name, backup)
            moved_aside = True
        except ftplib.all_errors:
            pass
        try:
            ftp.rename(temporary, source.name)
        except ftplib.all_errors:
            if moved_aside:
                try:
                    ftp.rename(backup, source.name)
                except ftplib.all_errors:
                    pass
            # Leaving the temporary behind is what turns one failed publish into every
            # later one failing too: these files are the size of the state itself, they
            # are not named *.json so the site deploy's keep-rule does not protect them
            # from deletion but nothing else removes them either, and each one left
            # around takes space the next upload needs.
            remove_temporary(ftp, temporary)
            raise
        if moved_aside:
            try:
                ftp.delete(backup)
            except ftplib.all_errors:
                pass
    print(f"published {source.name} ({source.stat().st_size} bytes)")


def main() -> int:
    state_file = Path(os.environ.get("PAPER_STATE_FILE", "trading/data/paper-state.json"))
    if not state_file.is_file():
        raise SystemExit(f"{state_file} was not generated")

    # Segments go first: the core carries the manifest that points at them, so
    # publishing it earlier would advertise data the hosting does not have yet.
    uploads = declared_segments(state_file) + [state_file]
    remote_dir = os.environ.get("TRADING_FTP_DIR", "/www/trading/data").strip("/")
    # This script writes over FTP, so it stays inside the trading tree no matter
    # what a caller passes in.
    if not remote_dir.startswith("www/trading/") or ".." in remote_dir:
        raise SystemExit(f"Refusing to publish outside /www/trading/ (got '/{remote_dir}')")
    suffix = os.environ.get("PAPER_UPLOAD_SUFFIX", "uploading").strip() or "uploading"

    with ftplib.FTP(os.environ["HOSTING_FTP_SERVER"], timeout=60) as ftp:
        ftp.login(os.environ["HOSTING_FTP_USERNAME"], os.environ["HOSTING_FTP_PASSWORD"])
        enter_dir(ftp, remote_dir.split("/"))
        for source in uploads:
            publish(ftp, source, suffix)

    return 0


if __name__ == "__main__":
    sys.exit(main())
