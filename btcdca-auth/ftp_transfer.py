import ftplib
import os
from pathlib import Path


HOSTS = [host.strip() for host in os.environ.get("BTCDCA_FTP_HOSTS", "ftp.btc-dca.com,neuron.blueboard.cz").split(",") if host.strip()]
LOGIN = os.environ["BTCDCA_FTP_LOGIN"]
PASSWORD = os.environ["BTCDCA_FTP_PASSWORD"]
BACKUP_ID = os.environ.get("BACKUP_ID", "manual")


def connect():
    last_error = None
    for host in HOSTS:
        try:
            ftp = ftplib.FTP(host, timeout=30)
            ftp.login(LOGIN, PASSWORD)
            print(f"Connected to FTP host: {host}")
            return ftp
        except Exception as exc:
            last_error = exc
            print(f"FTP connection failed for {host}: {exc}")
    raise SystemExit(f"Could not connect to any FTP host. Last error: {last_error}")


def ensure_dir(ftp, path):
    original = ftp.pwd()
    for part in [part for part in path.split("/") if part]:
        try:
            ftp.cwd(part)
        except ftplib.error_perm:
            ftp.mkd(part)
            ftp.cwd(part)
    ftp.cwd(original)


def download(ftp, remote, local):
    local_path = Path(local)
    local_path.parent.mkdir(parents=True, exist_ok=True)
    with local_path.open("wb") as handle:
        ftp.retrbinary(f"RETR {remote}", handle.write)


def download_optional(ftp, remote, local):
    try:
        download(ftp, remote, local)
    except ftplib.error_perm as exc:
        print(f"Optional FTP download skipped for {remote}: {exc}")


def upload(ftp, local, remote):
    local_path = Path(local)
    parent, name = remote.rsplit("/", 1) if "/" in remote else ("", remote)
    original = ftp.pwd()
    if parent:
        ensure_dir(ftp, parent)
        ftp.cwd(parent)
    with local_path.open("rb") as handle:
        ftp.storbinary(f"STOR {name}", handle)
    ftp.cwd(original)


def delete_optional(ftp, remote):
    try:
        ftp.delete(remote)
        print(f"Deleted old FTP file: {remote}")
    except ftplib.error_perm as exc:
        print(f"Optional FTP delete skipped for {remote}: {exc}")


def rmdir_optional(ftp, remote):
    try:
        ftp.rmd(remote)
        print(f"Removed old FTP directory: {remote}")
    except ftplib.error_perm as exc:
        print(f"Optional FTP rmdir skipped for {remote}: {exc}")


def prepare():
    ftp = connect()
    try:
        download(ftp, "www/login-user.php", "server-current/login-user.php")
        download(ftp, "www/signup-user.php", "server-current/signup-user.php")
        download_optional(ftp, "www/.htaccess", "server-current/root.htaccess")
        download_optional(ftp, "www/app/.htaccess", "server-current/app.htaccess")
        download(ftp, "www/assets/css/custom.css", "server-current/custom.css")
        download(ftp, "www/assets/js/main.js", "server-current/main.js")
        upload(ftp, "server-current/login-user.php", f".codex-backups/btcdca-auth/{BACKUP_ID}/login-user.php")
        upload(ftp, "server-current/signup-user.php", f".codex-backups/btcdca-auth/{BACKUP_ID}/signup-user.php")
        upload(ftp, "server-current/custom.css", f".codex-backups/btcdca-auth/{BACKUP_ID}/custom.css")
        upload(ftp, "server-current/main.js", f".codex-backups/btcdca-auth/{BACKUP_ID}/main.js")
        if Path("server-current/root.htaccess").exists():
            upload(ftp, "server-current/root.htaccess", f".codex-backups/btcdca-auth/{BACKUP_ID}/root.htaccess")
        if Path("server-current/app.htaccess").exists():
            upload(ftp, "server-current/app.htaccess", f".codex-backups/btcdca-auth/{BACKUP_ID}/app.htaccess")
    finally:
        ftp.quit()


def upload_deploy():
    ftp = connect()
    try:
        upload(ftp, "deploy-root/btcdca-google-config.php", "btcdca-google-config.php")
        upload(ftp, "deploy-root/www/login-user.php", "www/login-user.php")
        upload(ftp, "deploy-root/www/signup-user.php", "www/signup-user.php")
        upload(ftp, "deploy-root/www/btcdca-google-login.php", "www/btcdca-google-login.php")
        upload(ftp, "deploy-root/www/btcdca-google-callback.php", "www/btcdca-google-callback.php")
        upload(ftp, "deploy-root/www/btcdca-google-token-login.php", "www/btcdca-google-token-login.php")
        upload(ftp, "deploy-root/www/.htaccess", "www/.htaccess")
        upload(ftp, "deploy-root/www/app/.htaccess", "www/app/.htaccess")
        upload(ftp, "deploy-root/www/assets/css/custom.css", "www/assets/css/custom.css")
        upload(ftp, "deploy-root/www/assets/js/main.js", "www/assets/js/main.js")
        upload(ftp, "deploy-root/www/app/auth/google/index.php", "www/app/auth/google/index.php")
        delete_optional(ftp, "www/app/auth/google/callback/index.php")
        rmdir_optional(ftp, "www/app/auth/google/callback")
    finally:
        ftp.quit()


if __name__ == "__main__":
    mode = os.environ.get("BTCDCA_FTP_MODE")
    if mode == "prepare":
        prepare()
    elif mode == "upload":
        upload_deploy()
    else:
        raise SystemExit("BTCDCA_FTP_MODE must be prepare or upload")
