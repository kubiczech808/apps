from __future__ import annotations

import ftplib
import hashlib
import html
import json
import os
import re
import secrets
import time
from pathlib import Path, PurePosixPath

import requests


TEMPLATE = Path('scripts/templates/jamu_performance_apply_bridge.php')
REMOTE_DIR = PurePosixPath('/www/wp-content/mu-plugins')
PRODUCT_URL = 'https://tajemstvijamu.cz/en/product/herbal-therapeutic-oil-sanga-sanga-classic/'
CART_URL = 'https://tajemstvijamu.cz/en/cart/'


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


def fetch(session: requests.Session, url: str, **kwargs: object) -> tuple[requests.Response, float]:
    started = time.perf_counter()
    response = session.get(
        url,
        timeout=120,
        headers={'User-Agent': 'JAMU performance verification/1.0'},
        **kwargs,
    )
    return response, round(time.perf_counter() - started, 3)


def price_symbols(document: str) -> list[str]:
    matches = re.findall(r'woocommerce-Price-currencySymbol[^>]*>(.*?)</span>', document, re.IGNORECASE | re.DOTALL)
    return sorted(set(html.unescape(re.sub(r'<[^>]+>', '', item)).strip() for item in matches if item.strip()))


def main() -> int:
    token = secrets.token_urlsafe(48)
    token_hash = hashlib.sha256(token.encode()).hexdigest()
    run_id = ''.join(char for char in os.environ.get('GITHUB_RUN_ID', 'local') if char.isdigit()) or 'local'
    remote = REMOTE_DIR / f'jamu-performance-apply-{run_id}.php'
    local = Path('/tmp') / remote.name
    report: dict[str, object] = {'schema': 1, 'apply': {}, 'verification': {}}
    local.write_text(TEMPLATE.read_text(encoding='utf-8').replace('__JAMU_TOKEN_HASH__', token_hash), encoding='utf-8')

    ftp = connect()
    try:
        ensure_dir(ftp, REMOTE_DIR)
        with local.open('rb') as handle:
            ftp.storbinary(f'STOR {remote}', handle)

        apply_response = requests.get(
            'https://tajemstvijamu.cz/',
            params={'jamu_bridge': 'performance-apply'},
            headers={
                'X-JAMU-Bridge': token,
                'Cache-Control': 'no-cache',
                'User-Agent': 'JAMU performance apply/1.0',
            },
            timeout=120,
        )
        try:
            report['apply'] = apply_response.json()
        except ValueError:
            report['apply'] = {
                'ok': False,
                'http_status': apply_response.status_code,
                'content_type': apply_response.headers.get('content-type', ''),
                'body_bytes': len(apply_response.content),
            }

        session = requests.Session()
        session.cookies.set('yay_currency_widget', '3348', domain='tajemstvijamu.cz', path='/')
        session.cookies.set('yay_currency_do_change_switcher', '1', domain='tajemstvijamu.cz', path='/')
        first, first_seconds = fetch(session, PRODUCT_URL)
        second, second_seconds = fetch(session, PRODUCT_URL)

        variants: dict[str, object] = {}
        for label, currency_id in {'eur': '3348', 'pln': '4519'}.items():
            currency_session = requests.Session()
            currency_session.cookies.set('yay_currency_widget', currency_id, domain='tajemstvijamu.cz', path='/')
            currency_session.cookies.set('yay_currency_do_change_switcher', '1', domain='tajemstvijamu.cz', path='/')
            response, seconds = fetch(currency_session, PRODUCT_URL)
            variants[label] = {
                'status': response.status_code,
                'seconds': seconds,
                'currency_symbols': price_symbols(response.text),
            }

        cart_response, cart_seconds = fetch(session, CART_URL)
        stylesheet_match = re.search(r'<link[^>]+href=["\']([^"\']*wp-content/[^"\']+\.css[^"\']*)["\']', second.text, re.IGNORECASE)
        stylesheet_headers: dict[str, str] = {}
        if stylesheet_match:
            stylesheet_url = requests.compat.urljoin(PRODUCT_URL, html.unescape(stylesheet_match.group(1)))
            stylesheet, _ = fetch(session, stylesheet_url)
            stylesheet_headers = {
                'status': str(stylesheet.status_code),
                'cache_control': stylesheet.headers.get('cache-control', ''),
                'expires': stylesheet.headers.get('expires', ''),
            }

        cached_speedup = first_seconds > 0 and second_seconds < first_seconds * 0.6
        cart_not_cached = 'WP Optimize page cache' in cart_response.text and 'page NOT cached' in cart_response.text
        eur_symbols = variants.get('eur', {}).get('currency_symbols', []) if isinstance(variants.get('eur'), dict) else []
        pln_symbols = variants.get('pln', {}).get('currency_symbols', []) if isinstance(variants.get('pln'), dict) else []
        currency_isolated = '€' in eur_symbols and any(symbol in {'zł', 'zł.'} for symbol in pln_symbols)
        apply_ok = isinstance(report['apply'], dict) and bool(report['apply'].get('ok'))
        verification_ok = apply_ok and first.status_code == 200 and second.status_code == 200 and cached_speedup and cart_not_cached and currency_isolated

        report['verification'] = {
            'ok': verification_ok,
            'public_product': {
                'first_status': first.status_code,
                'first_seconds': first_seconds,
                'second_status': second.status_code,
                'second_seconds': second_seconds,
                'cache_speedup_observed': cached_speedup,
            },
            'currency_variants': variants,
            'currency_isolated': currency_isolated,
            'cart': {
                'status': cart_response.status_code,
                'seconds': cart_seconds,
                'explicitly_not_cached': cart_not_cached,
            },
            'stylesheet_cache_headers': stylesheet_headers,
        }
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
        Path('jamu-content/performance-apply.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')

    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
