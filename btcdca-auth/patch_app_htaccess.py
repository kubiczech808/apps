from pathlib import Path


source = Path("server-current/app.htaccess")
target = Path("deploy-root/www/app/.htaccess")

START = "# BEGIN BTC-DCA app extensionless PHP URLs"
END = "# END BTC-DCA app extensionless PHP URLs"

text = source.read_text(encoding="utf-8", errors="replace") if source.exists() else ""
managed = {
    "# BTC-DCA Google OAuth callback",
    "RewriteCond %{REQUEST_FILENAME} !-d",
    "RewriteCond %{REQUEST_FILENAME} !-f",
    "RewriteRule ^auth/google/callback/?$ /btcdca-google-callback.php [L,QSA]",
}
text = "\n".join(line for line in text.splitlines() if line.strip() not in managed).strip()

def remove_managed_block(value: str) -> str:
    start = value.find(START)
    if start == -1:
        return value
    end = value.find(END, start)
    if end == -1:
        return value[:start].rstrip() + "\n"
    return (value[:start] + value[end + len(END):]).strip() + "\n"


text = remove_managed_block(text).strip()

extensionless = f"""{START}
RewriteEngine On

# Canonical app PHP pages without the .php suffix.
RewriteCond %{{REQUEST_METHOD}} ^(?:GET|HEAD)$
RewriteCond %{{THE_REQUEST}} \\s/+app/([^?\\s]+)\\.php[?\\s] [NC]
RewriteRule ^ /app/%1 [R=301,L,NE]

# Serve extensionless app PHP pages internally.
RewriteRule ^([^/.]+)/?$ $1.php [L,QSA]
{END}
"""

rule = """RewriteEngine On
RewriteRule ^auth/google/callback/?$ /btcdca-google-callback.php [L,QSA]
"""

managed_rules = extensionless + "\n# BTC-DCA Google OAuth callback\n" + rule
text = managed_rules + ("\n" + text + "\n" if text else "")

target.parent.mkdir(parents=True, exist_ok=True)
target.write_text(text, encoding="utf-8")
