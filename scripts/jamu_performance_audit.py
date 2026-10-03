from __future__ import annotations

import ftplib
import hashlib
import json
import os
import secrets
from pathlib import Path, PurePosixPath

import requests


TEMPLATE = Path('scripts/templates/jamu_performance_audit_bridge.php')
REMOTE_DIR = PurePosixPath('/www/wp-content/mu-plugins')
PAGES = {
    'home': 'https://tajemstvijamu.cz/',
    'product_en': 'https://tajemstvijamu.cz/en/product/herbal-therapeutic-oil-sanga-sanga-classic/',
    'cart_en': 'https://tajemstvijamu.cz/en/cart/',
    'checkout_en': 'https://tajemstvijamu.cz/en/checkout/',
}
PRODUCT_ID = '4558'


def connect() -> ftplib.FTP:
    failures: list[str] = []
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
    run_id = ''.join(char for char in os.environ.get('GITHUB_RUN_ID', 'local') if char.isdigit()) or 'local'
    remote = REMOTE_DIR / f'jamu-performance-audit-{run_id}.php'
    local = Path('/tmp') / remote.name
    local.write_text(TEMPLATE.read_text(encoding='utf-8').replace('__JAMU_TOKEN_HASH__', token_hash), encoding='utf-8')

    ftp = connect()
    try:
        ensure_dir(ftp, REMOTE_DIR)
        with local.open('rb') as handle:
            ftp.storbinary(f'STOR {remote}', handle)
        session = requests.Session()
        result: dict[str, object] = {'schema': 1, 'pages': {}}
        for label, url in PAGES.items():
            response = session.get(
                url,
                params={'jamu_bridge': 'performance-audit'},
                headers={
                    # Blueboard is known to preserve this generic bridge header.
                    'X-JAMU-Bridge': token,
                    'X-JAMU-Performance-Audit': token,
                    'Cache-Control': 'no-cache',
                    'User-Agent': 'JAMU performance audit/1.0',
                },
                timeout=120,
            )
            try:
                response.raise_for_status()
                result['pages'][label] = response.json()
            except (requests.RequestException, ValueError) as exc:
                # Preserve a compact, sanitized diagnostic report. A read-only
                # audit should make a bridge issue observable without failing
                # before its report can be committed.
                sample = response.text[:500] if response.content else ''
                result['pages'][label] = {
                    'audit_error': type(exc).__name__,
                    'http_status': response.status_code,
                    'content_type': response.headers.get('content-type', ''),
                    'body_bytes': len(response.content),
                    'starts_with_html': sample.lstrip().lower().startswith(('<!doctype', '<html')),
                    'contains_php_error': any(
                        marker in sample.lower()
                        for marker in ('fatal error', 'parse error', 'warning:', 'uncaught')
                    ),
                    'body_prefix': sample.replace('\r', ' ').replace('\n', ' ')[:240],
                    'body_suffix': response.text[-240:].replace('\r', ' ').replace('\n', ' ') if response.content else '',
                }

        # This is a temporary anonymous WooCommerce session only. It creates
        # no order, no payment and no email, but allows the audit to profile
        # the exact cart state visitors use after adding a product.
        cart_session = requests.Session()
        added = cart_session.post(
            'https://tajemstvijamu.cz/',
            params={'wc-ajax': 'add_to_cart'},
            data={'product_id': PRODUCT_ID, 'quantity': '1'},
            headers={'User-Agent': 'JAMU performance audit/1.0'},
            timeout=120,
        )
        cart_response = cart_session.get(
            PAGES['cart_en'],
            params={'jamu_bridge': 'performance-audit'},
            headers={
                'X-JAMU-Bridge': token,
                'X-JAMU-Performance-Audit': token,
                'Cache-Control': 'no-cache',
                'User-Agent': 'JAMU performance audit/1.0',
            },
            timeout=120,
        )
        try:
            cart_response.raise_for_status()
            result['pages']['cart_with_item_en'] = cart_response.json()
            result['pages']['cart_with_item_en']['add_to_cart_status'] = added.status_code
        except (requests.RequestException, ValueError) as exc:
            sample = cart_response.text[:500] if cart_response.content else ''
            result['pages']['cart_with_item_en'] = {
                'audit_error': type(exc).__name__,
                'add_to_cart_status': added.status_code,
                'http_status': cart_response.status_code,
                'body_bytes': len(cart_response.content),
                'body_prefix': sample.replace('\r', ' ').replace('\n', ' ')[:240],
                'body_suffix': cart_response.text[-240:].replace('\r', ' ').replace('\n', ' ') if cart_response.content else '',
            }
        output = Path('jamu-content/performance-audit.json')
        output.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
        print(json.dumps(result, ensure_ascii=False, indent=2))
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
