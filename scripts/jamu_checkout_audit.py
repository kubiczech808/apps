from __future__ import annotations

import ftplib
import hashlib
import json
import os
import secrets
from pathlib import Path, PurePosixPath

import requests


TEMPLATE = Path('scripts/templates/jamu_checkout_audit_bridge.php')
REMOTE_DIR = PurePosixPath('/www/wp-content/mu-plugins')


def connect() -> ftplib.FTP:
    for host in ('ftp.tajemstvijamu.cz', 'neuron.blueboard.cz'):
        try:
            ftp = ftplib.FTP(host, timeout=45)
            ftp.login(os.environ['JAMU_FTP_LOGIN'], os.environ['JAMU_FTP_PWD'])
            ftp.set_pasv(True)
            return ftp
        except ftplib.all_errors:
            continue
    raise RuntimeError('FTP connection failed')


def main() -> int:
    token = secrets.token_urlsafe(48)
    token_hash = hashlib.sha256(token.encode()).hexdigest()
    run_id = ''.join(ch for ch in os.environ.get('GITHUB_RUN_ID', 'local') if ch.isdigit()) or 'local'
    remote = REMOTE_DIR / f'jamu-checkout-audit-{run_id}.php'
    local = Path('/tmp') / remote.name
    local.write_text(TEMPLATE.read_text(encoding='utf-8').replace('__JAMU_TOKEN_HASH__', token_hash), encoding='utf-8')
    ftp = connect()
    try:
        with local.open('rb') as stream:
            ftp.storbinary(f'STOR {remote}', stream)
        response = requests.get('https://tajemstvijamu.cz/', params={'jamu_bridge': 'checkout-audit'}, headers={'X-JAMU-Checkout-Audit': token, 'Cache-Control': 'no-cache'}, timeout=120)
        response.raise_for_status()
        report = response.json()
        output = Path('jamu-content/checkout-hook-audit.json')
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
        print(json.dumps(report, ensure_ascii=False))
    finally:
        try:
            ftp.delete(str(remote))
        except ftplib.all_errors:
            pass
        try:
            ftp.quit()
        except ftplib.all_errors:
            ftp.close()
        local.unlink(missing_ok=True)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
