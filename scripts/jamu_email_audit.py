from __future__ import annotations

import ftplib
import hashlib
import json
import os
import secrets
from pathlib import Path, PurePosixPath

import requests


TEMPLATE = Path('scripts/templates/jamu_email_audit_bridge.php')
REMOTE_DIR = PurePosixPath('/www/wp-content/mu-plugins')


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
    order_id = ''.join(ch for ch in os.environ.get('JAMU_AUDIT_ORDER_ID', '4710') if ch.isdigit())
    remote = REMOTE_DIR / f'jamu-email-audit-{run_id}.php'
    local_bridge = Path('/tmp') / remote.name
    local_bridge.write_text(TEMPLATE.read_text(encoding='utf-8').replace('__JAMU_TOKEN_HASH__', token_hash), encoding='utf-8')

    ftp = connect()
    try:
        ensure_dir(ftp, REMOTE_DIR)
        with local_bridge.open('rb') as handle:
            ftp.storbinary(f'STOR {remote}', handle)
        response = requests.get(
            'https://tajemstvijamu.cz/',
            params={
                'jamu_bridge': 'email-audit',
                'jamu_nonce': run_id,
                **({'jamu_order': order_id} if order_id else {}),
            },
            headers={'X-JAMU-Email-Audit': token, 'Cache-Control': 'no-cache', 'User-Agent': 'JAMU email audit/1.0'},
            timeout=120,
        )
        # The ephemeral bridge returns a deliberately sanitized JSON error
        # record on a fatal. Persist it so an audit workflow remains useful
        # even when a new non-sending probe cannot render a template.
        try:
            audit = response.json()
        except ValueError:
            audit = {
                'audit_error': {
                    'http_status': response.status_code,
                    'non_json_response': True,
                    'content_type': response.headers.get('content-type', ''),
                    'bridge_header': response.headers.get('x-jamu-email-audit', ''),
                    'body_bytes': len(response.content),
                    'starts_with_html': response.text.lstrip().lower().startswith('<!doctype')
                    or response.text.lstrip().lower().startswith('<html'),
                    'contains_php_warning': 'warning' in response.text.lower()
                    or 'fatal error' in response.text.lower()
                    or 'notice' in response.text.lower(),
                },
            }
        if not response.ok:
            audit.setdefault('audit_error', {})['http_status'] = response.status_code
        output = Path('jamu-content/email-delivery-audit.json')
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(json.dumps(audit, ensure_ascii=False, indent=2), encoding='utf-8')
        print(json.dumps({'plugins': len(audit.get('plugins', [])), 'hooks': audit.get('hooks', {}), 'snippet_signals': audit.get('snippet_signals', [])}, ensure_ascii=False, indent=2))
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
