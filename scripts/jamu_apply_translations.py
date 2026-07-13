from __future__ import annotations

import ftplib
import hashlib
import json
import os
import secrets
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path, PurePosixPath


TEMPLATE = Path('scripts/templates/jamu_apply_bridge.php')
PAYLOAD = Path(os.environ.get('JAMU_TRANSLATIONS_FILE', 'jamu-content/translations-draft.json'))
REMOTE_MU_DIR = PurePosixPath('/www/wp-content/mu-plugins')
REMOTE_CONTENT_DIR = PurePosixPath('/www/wp-content')


def connect() -> tuple[ftplib.FTP, str]:
    errors = []
    for host in ('ftp.tajemstvijamu.cz', 'neuron.blueboard.cz'):
        try:
            ftp = ftplib.FTP(host, timeout=45)
            ftp.login(os.environ['JAMU_FTP_LOGIN'], os.environ['JAMU_FTP_PWD'])
            ftp.set_pasv(True)
            return ftp, host
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


def upload(ftp: ftplib.FTP, local: Path, remote: PurePosixPath) -> None:
    ensure_dir(ftp, remote.parent)
    with local.open('rb') as handle:
        ftp.storbinary(f'STOR {remote}', handle)
    size = ftp.size(str(remote))
    if size is not None and size != local.stat().st_size:
        raise RuntimeError(f'FTP size mismatch after upload: {remote}')


def delete_quietly(ftp: ftplib.FTP, remote: PurePosixPath) -> None:
    try:
        ftp.delete(str(remote))
    except ftplib.all_errors:
        pass


def call_bridge(token: str, run_id: str) -> dict:
    query = urllib.parse.urlencode({'jamu_bridge': 'apply_translations', 'jamu_nonce': run_id})
    request = urllib.request.Request(
        f'https://tajemstvijamu.cz/?{query}',
        headers={
            'X-JAMU-Bridge': token,
            'User-Agent': 'JAMU apply bridge/1.0',
            'Cache-Control': 'no-cache',
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=300) as response:
            body = response.read().decode('utf-8')
    except urllib.error.HTTPError as exc:
        body = exc.read().decode('utf-8', errors='replace')
        raise RuntimeError(f'Bridge returned HTTP {exc.code}: {body}') from exc

    result = json.loads(body)
    if not result.get('ok'):
        raise RuntimeError('Bridge reported failure: ' + json.dumps(result, ensure_ascii=False))
    return result


def main() -> int:
    if not PAYLOAD.is_file():
        raise RuntimeError(f'Translation payload is missing: {PAYLOAD}')
    payload = json.loads(PAYLOAD.read_text(encoding='utf-8'))
    rows = payload.get('translations')
    if not isinstance(rows, list) or not rows:
        raise RuntimeError('Translation payload has no translations.')

    token = secrets.token_urlsafe(48)
    token_hash = hashlib.sha256(token.encode()).hexdigest()
    run_id = ''.join(ch for ch in os.environ.get('GITHUB_RUN_ID', 'local') if ch.isdigit()) or 'local'

    payload_relative = f'uploads/jamu-ml-import-{run_id}.json'
    remote_payload = REMOTE_CONTENT_DIR / payload_relative
    remote_bridge = REMOTE_MU_DIR / f'jamu-apply-bridge-{run_id}.php'

    source = (
        TEMPLATE.read_text(encoding='utf-8')
        .replace('__JAMU_TOKEN_HASH__', token_hash)
        .replace('__JAMU_PAYLOAD_RELATIVE__', payload_relative)
    )
    local_bridge = Path('/tmp') / remote_bridge.name
    local_bridge.write_text(source, encoding='utf-8')

    ftp, host = connect()
    try:
        upload(ftp, PAYLOAD, remote_payload)
        upload(ftp, local_bridge, remote_bridge)
        result = call_bridge(token, run_id)
    finally:
        delete_quietly(ftp, remote_bridge)
        delete_quietly(ftp, remote_payload)
        try:
            ftp.quit()
        except ftplib.all_errors:
            ftp.close()
        local_bridge.unlink(missing_ok=True)

    summary = {
        'ftp_host': host,
        'payload_rows': len(rows),
        'bridge_result': result,
    }
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    Path('jamu-apply-manifest.json').write_text(
        json.dumps(summary, ensure_ascii=False, indent=2),
        encoding='utf-8',
    )
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
