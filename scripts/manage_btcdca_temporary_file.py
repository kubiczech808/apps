"""Upload or remove a temporary BTC-DCA deployment file over FTP."""

from __future__ import annotations

import ftplib
import os
from pathlib import Path


HOSTS = tuple(filter(None, os.environ.get("BTCDCA_FTP_HOSTS", "ftp.btc-dca.com,neuron.blueboard.cz").split(",")))
LOGIN = os.environ["BTCDCA_FTP_LOGIN"]
PASSWORD = os.environ["BTCDCA_FTP_PASSWORD"]
MODE = os.environ["BTCDCA_TEMP_FILE_MODE"]
REMOTE = os.environ["BTCDCA_TEMP_FILE_REMOTE"]


def connect() -> ftplib.FTP:
    last_error: Exception | None = None
    for host in HOSTS:
        try:
            ftp = ftplib.FTP(host.strip(), timeout=45)
            ftp.login(LOGIN, PASSWORD)
            return ftp
        except Exception as exc:  # pragma: no cover - production connectivity
            last_error = exc
    raise RuntimeError(f"Could not connect to BTC-DCA FTP: {last_error}")


def main() -> None:
    ftp = connect()
    try:
        if MODE == "upload":
            local = Path(os.environ["BTCDCA_TEMP_FILE_LOCAL"])
            parent, name = REMOTE.rsplit("/", 1)
            ftp.cwd(parent)
            with local.open("rb") as handle:
                ftp.storbinary(f"STOR {name}", handle)
            print(f"Uploaded temporary file {REMOTE}")
        elif MODE == "delete":
            try:
                ftp.delete(REMOTE)
                print(f"Deleted temporary file {REMOTE}")
            except ftplib.error_perm as exc:
                if not str(exc).startswith("550"):
                    raise
                print(f"Temporary file was already absent: {REMOTE}")
        else:
            raise RuntimeError("BTCDCA_TEMP_FILE_MODE must be upload or delete")
    finally:
        ftp.quit()


if __name__ == "__main__":
    main()
