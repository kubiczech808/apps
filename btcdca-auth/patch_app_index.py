from pathlib import Path
import re


source = Path("server-current/app-index.php")
target = Path("deploy-root/www/app/index.php")

card_open = (
    '<span class="list-group-item btcdca-order-card" '
    'style="background:#141414 !important;'
    'border:1px solid rgba(255,255,255,0.08) !important;'
    'border-radius:12px !important;'
    'box-shadow:none !important;'
    'color:#f0f0f0 !important;">'
)

html = source.read_text(encoding="utf-8", errors="replace")

pattern = re.compile(
    r'<span\s+class="list-group-item(?:\s+btcdca-order-card)?\s*"\s*(?:style="[^"]*")?\s*>',
    re.IGNORECASE,
)

html, replacements = pattern.subn(card_open, html)
if replacements == 0:
    raise SystemExit("Could not find mobile order list-group-item cards in app index.php.")

target.parent.mkdir(parents=True, exist_ok=True)
target.write_text(html, encoding="utf-8")
