from __future__ import annotations

import ftplib
import hashlib
import json
import os
import secrets
from pathlib import Path, PurePosixPath

import requests


TEMPLATE = Path('scripts/templates/jamu_inventory_bridge.php')
REMOTE_DIR = PurePosixPath('/www/wp-content/mu-plugins')


def connect() -> ftplib.FTP:
    errors = []
    for host in ('ftp.tajemstvijamu.cz', 'neuron.blueboard.cz'):
        try:
            ftp = ftplib.FTP(host, timeout=45)
            ftp.login(os.environ['JAMU_FTP_LOGIN'], os.environ['JAMU_FTP_PWD'])
            ftp.set_pasv(True)
            return ftp
        except ftplib.all_errors as exc:
            errors.append(f'{host}: {type(exc).__name__}')
    raise RuntimeError('FTP connection failed: ' + ', '.join(errors))


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
    remote = REMOTE_DIR / f'jamu-inventory-bridge-{run_id}.php'
    source = TEMPLATE.read_text(encoding='utf-8').replace('__JAMU_TOKEN_HASH__', token_hash)
    local_bridge = Path('/tmp') / remote.name
    local_bridge.write_text(source, encoding='utf-8')

    ftp = connect()
    try:
        ensure_dir(ftp, REMOTE_DIR)
        with local_bridge.open('rb') as handle:
            ftp.storbinary(f'STOR {remote}', handle)
        response = requests.get(
            'https://tajemstvijamu.cz/',
            params={'jamu_bridge': 'inventory', 'jamu_nonce': run_id},
            headers={
                'X-JAMU-Bridge': token,
                'User-Agent': 'JAMU inventory bridge/1.0',
                'Cache-Control': 'no-cache',
            },
            timeout=120,
        )
        response.raise_for_status()
        inventory = response.json()
        if inventory.get('site') != 'https://tajemstvijamu.cz/':
            raise RuntimeError('Unexpected inventory response.')
        output = Path('jamu-content/source-inventory.json')
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(json.dumps(inventory, ensure_ascii=False, indent=2), encoding='utf-8')
        summary = {
            'posts': len(inventory.get('posts', [])),
            'terms': len(inventory.get('terms', [])),
            'attributes': len(inventory.get('attributes', [])),
            'menus': len(inventory.get('menus', [])),
            'media': len(inventory.get('media', [])),
            'active_plugins': len(inventory.get('active_plugins', [])),
            'theme': inventory.get('active_theme', {}).get('name', ''),
        }
        print(json.dumps(summary, ensure_ascii=False, indent=2))
    finally:
        try:
            ftp.delete(str(remote))
        except ftplib.all_errors:
            pass
        try:
            ftp.quit()
        except ftplib.all_errors:
            ftp.close()
        local_bridge.unlink(missing_ok=True)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
