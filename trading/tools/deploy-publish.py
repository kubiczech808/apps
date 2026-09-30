#!/usr/bin/env python3
"""Put a verified staged upload in place of the live file, and never delete the live file
unless the staged copy is still there to take its place.

The deploy uploads each file as .deploy-<name>, checks its length, and renames it over the
live one. Some servers refuse RNTO onto an existing path, so the fallback deletes the live
file and renames again. That leaves a sub-second 404, which is recoverable and far better than
a half-parsed PHP file.

On 2026-09-30 one push started two Deploy Trading runs at once. Both staged api.php under
the same name. The first renamed it over api.php. The second's rename then found no source.
Its fallback deleted api.php, the file the first run had just published. Its own second
rename then failed with "550 .deploy-api.php: No such file or directory". The site answered
404 until the next deploy.

The workflow now queues its runs (concurrency group trading-deploy), which removes the race.
This removes the other half: the fallback deletes only when the staged copy is still there.
The worst a vanished staged file can now do is fail the deploy and leave the live file as it
was.
"""

from __future__ import annotations

import ftplib


def staged_present(ftp, staged, list_names) -> bool:
    """True unless both the server's SIZE and its listing say the staged file is missing.

    SIZE of a missing file fails with 550. Some servers do not implement SIZE, and some
    listings hide dotfiles, so either answer counts as "present". A file is taken as gone
    only when both agree. If neither can tell, the deploy fails and the live file stays.
    """
    try:
        ftp.size(staged)
        return True
    except ftplib.all_errors:
        pass
    return staged in list_names(ftp)


def publish_staged(ftp, staged, name, list_names) -> str:
    """Rename `staged` over `name` in the current directory.

    Returns "renamed" or "replaced" (the delete-then-rename fallback). If the staged copy is
    gone, this raises SystemExit and does not touch the live file.
    """
    try:
        ftp.rename(staged, name)
        return "renamed"
    except ftplib.all_errors as refused:
        first = refused
    if not staged_present(ftp, staged, list_names):
        raise SystemExit(
            f"{name}: the staged copy {staged} is gone ({first}), most likely taken by another "
            "deploy running at the same time. The live file was left untouched."
        )
    try:
        ftp.delete(name)
    except ftplib.all_errors:
        pass
    ftp.rename(staged, name)
    return "replaced"
