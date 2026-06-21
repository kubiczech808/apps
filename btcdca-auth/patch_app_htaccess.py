from pathlib import Path


source = Path("server-current/app.htaccess")
target = Path("deploy-root/www/app/.htaccess")

text = source.read_text(encoding="utf-8", errors="replace") if source.exists() else ""
rule = """RewriteEngine On
RewriteRule ^auth/google/callback/?$ /btcdca-google-callback.php [L,QSA]
"""

if "btcdca-google-callback.php" not in text:
    if text and not text.endswith("\n"):
        text += "\n"
    text += "\n# BTC-DCA Google OAuth callback\n" + rule

target.parent.mkdir(parents=True, exist_ok=True)
target.write_text(text, encoding="utf-8")
