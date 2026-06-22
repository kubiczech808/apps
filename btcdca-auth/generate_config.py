import os
from pathlib import Path


def php_string(value):
    return "'" + (value or "").replace("\\", "\\\\").replace("'", "\\'") + "'"


auth_secret = os.environ.get("BTCDCA_AUTH_SECRET") or "/X9BpAxcKC7bHTvy5u16nJUhG4nUEjTQMkbOR0ikyACR/ubE6cbZnmZhEKw2bnUA"

content = f"""<?php

return [
    'db_host' => 'LOCALHOST',
    'db_port' => 3306,
    'db_name' => {php_string(os.environ.get("BTCDCA_DB"))},
    'db_user' => {php_string(os.environ.get("BTCDCA_DB_USER"))},
    'db_password' => {php_string(os.environ.get("BTCDCA_DB_PASSWORD"))},
    'google_client_id' => {php_string(os.environ.get("BTCDCA_GOOGLE_CLIENT_ID"))},
    'google_client_secret' => {php_string(os.environ.get("BTCDCA_GOOGLE_SECRET"))},
    'google_redirect_uri' => 'https://www.btc-dca.com/btcdca-google-callback.php',
    'auth_secret' => {php_string(auth_secret)},
];
"""

Path("deploy-root/btcdca-google-config.php").write_text(content, encoding="utf-8")
