"""Regression test for absolute post-auth application redirects."""

import os
import subprocess
import sys
import tempfile
from pathlib import Path


FIXTURE = """<?php
header('Location: app/overview.php');
header('Location: /login-user/app/overview.php');
header('Location: https://www.btc-dca.com/signup-user/app/overview.php');
"""


with tempfile.TemporaryDirectory() as directory:
    root = Path(directory)
    server = root / 'server-current'
    deploy = root / 'deploy-root' / 'www'
    server.mkdir(parents=True)
    deploy.mkdir(parents=True)
    for directory_path in (server, deploy):
        for name in ('login-user.php', 'signup-user.php'):
            (directory_path / name).write_text(FIXTURE, encoding='utf-8')

    subprocess.run(
        [sys.executable, str(Path.cwd() / 'btcdca-auth' / 'patch_auth_redirects.py')],
        check=True,
        cwd=root,
        env=os.environ.copy(),
    )

    for directory_path in (server, deploy):
        for name in ('login-user.php', 'signup-user.php'):
            output = (directory_path / name).read_text(encoding='utf-8')
            assert 'Location: /app/overview.php' in output
            assert '/login-user/app/overview.php' not in output
            assert '/signup-user/app/overview.php' not in output
