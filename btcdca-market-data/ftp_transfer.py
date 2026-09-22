import ftplib
import os
from pathlib import Path


HOSTS = [item.strip() for item in os.environ.get("BTCDCA_FTP_HOSTS", "ftp.btc-dca.com,neuron.blueboard.cz").split(",") if item.strip()]
LOGIN = os.environ["BTCDCA_FTP_LOGIN"]
PASSWORD = os.environ["BTCDCA_FTP_PASSWORD"]
BACKUP_ID = os.environ.get("BACKUP_ID", "manual")
FILES = (
    "www/app/overview.php",
    "www/app/php/get_live_price.php",
    "www/app/php/get_ticker.php",
    "www/php/getTicker.php",
)


def connect():
    error = None
    for host in HOSTS:
        try:
            ftp = ftplib.FTP(host, timeout=30)
            ftp.login(LOGIN, PASSWORD)
            print("Connected to", host)
            return ftp
        except Exception as exc:
            error = exc
    raise SystemExit("FTP connection failed: %s" % error)


def ensure_dir(ftp, directory):
    original = ftp.pwd()
    for part in filter(None, directory.split("/")):
        try:
            ftp.cwd(part)
        except ftplib.error_perm:
            ftp.mkd(part)
            ftp.cwd(part)
    ftp.cwd(original)


def download(ftp, remote, local):
    local.parent.mkdir(parents=True, exist_ok=True)
    with local.open("wb") as handle:
        ftp.retrbinary("RETR " + remote, handle.write)


def upload(ftp, local, remote):
    parent, name = remote.rsplit("/", 1)
    ensure_dir(ftp, parent)
    original = ftp.pwd()
    ftp.cwd(parent)
    with Path(local).open("rb") as handle:
        ftp.storbinary("STOR " + name, handle)
    ftp.cwd(original)


def prepare(ftp):
    for remote in FILES:
        local = Path("server-current") / remote.removeprefix("www/")
        download(ftp, remote, local)
        upload(ftp, local, ".codex-backups/btcdca-market-data/%s/%s" % (BACKUP_ID, remote))


def deploy(ftp):
    mapping = {
        "deploy-root/www/php/market-data-lib.php": "www/php/market-data-lib.php",
        "deploy-root/www/php/market-data.php": "www/php/market-data.php",
        "deploy-root/www/php/getTicker.php": "www/php/getTicker.php",
        "deploy-root/www/app/overview.php": "www/app/overview.php",
        "deploy-root/www/app/php/get_live_price.php": "www/app/php/get_live_price.php",
        "deploy-root/www/app/php/get_ticker.php": "www/app/php/get_ticker.php",
    }
    for local, remote in mapping.items():
        upload(ftp, local, remote)


ftp = connect()
try:
    if os.environ.get("BTCDCA_FTP_MODE") == "prepare":
        prepare(ftp)
    elif os.environ.get("BTCDCA_FTP_MODE") == "deploy":
        deploy(ftp)
    else:
        raise SystemExit("BTCDCA_FTP_MODE must be prepare or deploy")
finally:
    ftp.quit()
