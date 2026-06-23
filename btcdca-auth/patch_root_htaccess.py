from pathlib import Path


source = Path("server-current/root.htaccess")
target = Path("deploy-root/www/.htaccess")

START = "# BEGIN BTC-DCA extensionless PHP URLs"
END = "# END BTC-DCA extensionless PHP URLs"

block = f"""{START}
<IfModule mod_rewrite.c>
RewriteEngine On

# Canonical public BTC-DCA PHP pages without the .php suffix.
RewriteCond %{{REQUEST_METHOD}} ^(?:GET|HEAD)$
RewriteCond %{{THE_REQUEST}} \\s/+((?:login-user|signup-user|dca-calculator|btcdca-google-login|btcdca-google-callback|btcdca-google-token-login))\\.php[?\\s] [NC]
RewriteRule ^ /%1 [R=301,L,NE]

# Canonical BTC-DCA app PHP pages without the .php suffix.
RewriteCond %{{REQUEST_METHOD}} ^(?:GET|HEAD)$
RewriteCond %{{THE_REQUEST}} \\s/+app/([^?\\s]+)\\.php[?\\s] [NC]
RewriteRule ^ /app/%1 [R=301,L,NE]

# Serve extensionless BTC-DCA app PHP pages internally before WordPress fallback.
RewriteRule ^app/([^/.]+)/?$ app/$1.php [L,QSA]

# Serve extensionless BTC-DCA PHP pages internally.
RewriteCond %{{REQUEST_FILENAME}}.php -f
RewriteRule ^(login-user|signup-user|dca-calculator|btcdca-google-login|btcdca-google-callback|btcdca-google-token-login)/?$ $1.php [L,QSA]
</IfModule>
{END}
"""


def remove_managed_block(text: str) -> str:
    start = text.find(START)
    if start == -1:
        return text
    end = text.find(END, start)
    if end == -1:
        return text[:start].rstrip() + "\n"
    return (text[:start] + text[end + len(END):]).strip() + "\n"


text = source.read_text(encoding="utf-8", errors="replace") if source.exists() else ""
text = remove_managed_block(text).strip()
text = block + ("\n" + text + "\n" if text else "")

target.parent.mkdir(parents=True, exist_ok=True)
target.write_text(text, encoding="utf-8")
