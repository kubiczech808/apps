"""Publish state files over FTP without ever leaving nothing behind.

An execution state file is a portfolio's entire run-log history. The upload replaces the
hosted file outright, so a publish that half-fails does not lose one run -- it loses every
run ever recorded. That is why this retries, times out rather than hanging, moves the
existing file aside instead of deleting it, puts it back if the swap fails, and raises
loudly when it cannot finish: a silent failure here reads downstream as "this portfolio
has one run", which is exactly how it was reported.

This began as a heredoc inside the main live workflow. 5050 was created later with a
simpler copy -- single attempt, no timeout, no retry, no restore -- and its history never
survived, so the two are one implementation now.

Environment:
  HOSTING_FTP_SERVER / HOSTING_FTP_USERNAME / HOSTING_FTP_PASSWORD
  TRADING_FTP_DIR                  remote directory, e.g. /www/trading/data
  PUBLISH_FILES                    comma separated local_path>remote_name pairs
  PUBLISH_REQUIRED                 comma separated remote names that must exist locally
"""
import ftplib
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

TIMEOUT_SECONDS = 30
ATTEMPTS = 3


def verify_published(base_url, remote_name):
    """Read back what was just uploaded, and fail if it is not there.

    An FTP STOR and rename can both report success while the file ends up somewhere the
    web server does not serve -- a chrooted login, a redirected home, a path that exists
    twice. The 5050 run log went missing exactly that way: every upload step passed, the
    local file was present and well-formed, and the hosted path answered 404 for days,
    so nothing anywhere said the history was not being kept. Reading the file back is the
    only check that covers the whole path from the runner to the browser.
    """
    url = f"{base_url.rstrip('/')}/{remote_name}"
    request = urllib.request.Request(url, headers={"User-Agent": "publish-execution-state/1.0"})
    try:
        with urllib.request.urlopen(request, timeout=TIMEOUT_SECONDS) as response:
            if response.status != 200:
                raise RuntimeError(f"{url} answered HTTP {response.status} after upload")
            if not response.read(1):
                raise RuntimeError(f"{url} is empty after upload")
    except urllib.error.HTTPError as error:
        raise RuntimeError(f"{remote_name} uploaded, but {url} answers HTTP {error.code}") from error
    except urllib.error.URLError as error:
        # A network problem reaching the hosting is not evidence the upload failed, and
        # failing the run on it would turn a blip into a red trading job. But a runner
        # that can never reach the hosting over HTTP turns this whole check into a no-op
        # that reports nothing forever, so say so in words that can be searched for.
        print(f"VERIFICATION SKIPPED: could not reach {url}: {error.reason}")
        return
    print(f"Verified {url}")


def enter_dir(ftp, parts):
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


def swap_into_place(ftp, tmp_name, remote_name):
    """Replace remote_name with tmp_name without ever leaving the path empty."""
    try:
        ftp.rename(tmp_name, remote_name)
        return
    except ftplib.all_errors:
        pass
    backup_name = f"{remote_name}.previous"
    try:
        ftp.delete(backup_name)
    except ftplib.all_errors:
        pass
    moved_aside = False
    try:
        ftp.rename(remote_name, backup_name)
        moved_aside = True
    except ftplib.all_errors:
        pass
    try:
        ftp.rename(tmp_name, remote_name)
    except ftplib.all_errors:
        if moved_aside:
            # Put the original back rather than leaving the path empty.
            try:
                ftp.rename(backup_name, remote_name)
            except ftplib.all_errors:
                pass
        raise
    if moved_aside:
        try:
            ftp.delete(backup_name)
        except ftplib.all_errors:
            pass


def upload_atomic(config, local_path, remote_name):
    failures = []
    for attempt in range(1, ATTEMPTS + 1):
        tmp_name = f"{remote_name}.uploading-{attempt}"
        try:
            with ftplib.FTP(config["server"], timeout=TIMEOUT_SECONDS) as ftp:
                ftp.login(config["username"], config["password"])
                enter_dir(ftp, config["target"].split("/"))
                with local_path.open("rb") as handle:
                    ftp.storbinary(f"STOR {tmp_name}", handle)
                swap_into_place(ftp, tmp_name, remote_name)
            print(f"Uploaded {remote_name} on attempt {attempt}")
            return
        except ftplib.all_errors as error:
            failures.append(str(error))
            time.sleep(attempt)
    raise RuntimeError(f"Could not upload {remote_name} after {ATTEMPTS} attempts: {' | '.join(failures)}")


def parse_files(raw):
    pairs = []
    for entry in str(raw or "").split(","):
        entry = entry.strip()
        if not entry:
            continue
        local, _, remote = entry.partition(">")
        local = local.strip()
        remote = remote.strip() or Path(local).name
        if local:
            pairs.append((Path(local), remote))
    return pairs


def main():
    config = {
        "server": os.environ["HOSTING_FTP_SERVER"],
        "username": os.environ["HOSTING_FTP_USERNAME"],
        "password": os.environ["HOSTING_FTP_PASSWORD"],
        "target": os.environ["TRADING_FTP_DIR"].strip("/"),
    }
    files = parse_files(os.environ.get("PUBLISH_FILES"))
    if not files:
        raise SystemExit("PUBLISH_FILES named nothing to publish")
    required = {name.strip() for name in str(os.environ.get("PUBLISH_REQUIRED") or "").split(",") if name.strip()}

    verify_base = str(os.environ.get("PUBLISH_VERIFY_BASE_URL") or "").strip()

    missing = []
    for local_path, remote_name in files:
        if not local_path.exists():
            # A run that produced nothing has nothing to publish, and that is not a
            # failure -- unless this file is the one the run exists to produce.
            missing.append(remote_name)
            print(f"{local_path} was not produced; skipping {remote_name}")
            continue
        upload_atomic(config, local_path, remote_name)
        if verify_base:
            verify_published(verify_base, remote_name)
    unmet = required.intersection(missing)
    if unmet:
        raise SystemExit(f"required file(s) not generated: {', '.join(sorted(unmet))}")


if __name__ == "__main__":
    sys.exit(main())
