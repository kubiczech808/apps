from __future__ import annotations

import ftplib
import hashlib
import json
import os
from pathlib import Path, PurePosixPath


PLUGIN_SLUG = "jamu-multilingual"
REMOTE_PARENT = PurePosixPath("/www/wp-content/plugins")
LOCAL_ROOT = Path("wordpress") / PLUGIN_SLUG
IGNORED_PARTS = {"tests", "__pycache__", ".git"}


def connect() -> tuple[ftplib.FTP, str]:
    login = os.environ["JAMU_FTP_LOGIN"]
    password = os.environ["JAMU_FTP_PWD"]
    failures = []
    for host in ("ftp.tajemstvijamu.cz", "neuron.blueboard.cz"):
        try:
            ftp = ftplib.FTP(host, timeout=45)
            ftp.login(login, password)
            ftp.set_pasv(True)
            return ftp, host
        except ftplib.all_errors as exc:
            failures.append(f"{host}: {type(exc).__name__}")
    raise RuntimeError("FTP connection failed: " + ", ".join(failures))


def ensure_dir(ftp: ftplib.FTP, directory: PurePosixPath) -> None:
    current = PurePosixPath("/")
    for part in directory.parts[1:]:
        current /= part
        try:
            ftp.mkd(str(current))
        except ftplib.error_perm as exc:
            if not str(exc).startswith("550"):
                raise


def remote_entries(ftp: ftplib.FTP, directory: PurePosixPath) -> list[tuple[str, str]]:
    try:
        return [(name, facts.get("type", "")) for name, facts in ftp.mlsd(str(directory))]
    except ftplib.all_errors:
        return []


def remove_tree(ftp: ftplib.FTP, directory: PurePosixPath) -> None:
    safe_prefix = str(REMOTE_PARENT) + "/.jamu-multilingual-"
    if not str(directory).startswith(safe_prefix):
        raise RuntimeError(f"Refusing to remove unsafe FTP path: {directory}")
    for name, kind in remote_entries(ftp, directory):
        if name in {".", ".."}:
            continue
        child = directory / name
        if kind == "dir":
            remove_tree(ftp, child)
        else:
            ftp.delete(str(child))
    ftp.rmd(str(directory))


def local_files() -> list[Path]:
    if not (LOCAL_ROOT / "jamu-multilingual.php").is_file():
        raise RuntimeError("Plugin entry file is missing.")
    return sorted(
        path for path in LOCAL_ROOT.rglob("*")
        if path.is_file() and not any(part in IGNORED_PARTS for part in path.relative_to(LOCAL_ROOT).parts)
    )


def upload(ftp: ftplib.FTP, destination: PurePosixPath, files: list[Path]) -> list[dict]:
    ensure_dir(ftp, destination)
    manifest = []
    created = set()
    for path in files:
        relative = path.relative_to(LOCAL_ROOT)
        remote = destination.joinpath(*relative.parts)
        if remote.parent not in created:
            ensure_dir(ftp, remote.parent)
            created.add(remote.parent)
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        with path.open("rb") as handle:
            ftp.storbinary(f"STOR {remote}", handle)
        size = ftp.size(str(remote))
        if size is not None and size != path.stat().st_size:
            raise RuntimeError(f"Size mismatch after upload: {relative}")
        manifest.append({"path": relative.as_posix(), "bytes": path.stat().st_size, "sha256": digest})
    return manifest


def main() -> int:
    files = local_files()
    run_id = "".join(ch for ch in os.environ.get("GITHUB_RUN_ID", "local") if ch.isdigit()) or "local"
    incoming = REMOTE_PARENT / f".{PLUGIN_SLUG}-incoming-{run_id}"
    previous = REMOTE_PARENT / f".{PLUGIN_SLUG}-previous-{run_id}"
    target = REMOTE_PARENT / PLUGIN_SLUG

    ftp, host = connect()
    try:
        if remote_entries(ftp, incoming):
            remove_tree(ftp, incoming)
        manifest = upload(ftp, incoming, files)

        target_exists = any(name == PLUGIN_SLUG for name, _ in remote_entries(ftp, REMOTE_PARENT))
        if target_exists:
            ftp.rename(str(target), str(previous))
        try:
            ftp.rename(str(incoming), str(target))
        except Exception:
            if target_exists:
                ftp.rename(str(previous), str(target))
            raise
        if target_exists:
            remove_tree(ftp, previous)
    finally:
        try:
            ftp.quit()
        except ftplib.all_errors:
            ftp.close()

    summary = {
        "host": host,
        "target": str(target),
        "file_count": len(manifest),
        "total_bytes": sum(item["bytes"] for item in manifest),
        "commit": os.environ.get("GITHUB_SHA", ""),
    }
    print(json.dumps(summary, indent=2))
    with open("jamu-deploy-manifest.json", "w", encoding="utf-8") as handle:
        json.dump({"summary": summary, "files": manifest}, handle, indent=2)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

