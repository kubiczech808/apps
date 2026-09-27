from __future__ import annotations

import ftplib
import hashlib
import json
import os
import secrets
import urllib.parse
import urllib.request
from pathlib import Path, PurePosixPath


TEMPLATE = Path('scripts/templates/jamu_currency_audit_bridge.php')
REMOTE_MU_DIR = PurePosixPath('/www/wp-content/mu-plugins')
REPORT = Path('jamu-content/currency-meta-audit.json')


def connect() -> ftplib.FTP:
    failures = []
    for host in ('ftp.tajemstvijamu.cz', 'neuron.blueboard.cz'):
        try:
            ftp = ftplib.FTP(host, timeout=45)
            ftp.login(os.environ['JAMU_FTP_LOGIN'], os.environ['JAMU_FTP_PWD'])
            ftp.set_pasv(True)
            return ftp
        except ftplib.all_errors as exc:
            failures.append(f'{host}: {type(exc).__name__}')
    raise RuntimeError('FTP connection failed: ' + ', '.join(failures))


def ensure_dir(ftp: ftplib.FTP, directory: PurePosixPath) -> None:
    current = PurePosixPath('/')
    for part in directory.parts[1:]:
        current /= part
        try:
            ftp.mkd(str(current))
        except ftplib.error_perm as exc:
            if not str(exc).startswith('550'):
                raise


def main() -> int:
    token = secrets.token_urlsafe(48)
    token_hash = hashlib.sha256(token.encode()).hexdigest()
    run_id = ''.join(ch for ch in os.environ.get('GITHUB_RUN_ID', 'local') if ch.isdigit()) or 'local'
    remote = REMOTE_MU_DIR / f'jamu-currency-audit-{run_id}.php'
    local = Path('/tmp') / remote.name
    local.write_text(TEMPLATE.read_text(encoding='utf-8').replace('__JAMU_TOKEN_HASH__', token_hash), encoding='utf-8')

    ftp = connect()
    try:
        ensure_dir(ftp, remote.parent)
        with local.open('rb') as handle:
            ftp.storbinary(f'STOR {remote}', handle)
        request = urllib.request.Request(
            'https://tajemstvijamu.cz/?' + urllib.parse.urlencode({'jamu_bridge': 'currency_audit'}),
            headers={'X-JAMU-Bridge': token, 'Cache-Control': 'no-cache', 'User-Agent': 'JAMU currency audit/1.0'},
        )
        with urllib.request.urlopen(request, timeout=120) as response:
            report = json.loads(response.read().decode('utf-8'))
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

    if not report.get('ok'):
        raise RuntimeError('Currency metadata audit failed.')
    REPORT.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({'keys': len(report.get('product_meta_keys', [])), 'sample_product_id': report.get('sample_product_id')}, ensure_ascii=False))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
