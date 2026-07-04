from pathlib import Path


source = Path("server-current/custom.css")
target = Path("deploy-root/www/assets/css/custom.css")

START = "/* BEGIN BTC-DCA mobile order cards dark fix */"
END = "/* END BTC-DCA mobile order cards dark fix */"


def remove_managed_block(value: str) -> str:
    start = value.find(START)
    if start == -1:
        return value.rstrip()
    end = value.find(END, start)
    if end == -1:
        return value[:start].rstrip()
    return (value[:start] + value[end + len(END):]).rstrip()


text = source.read_text(encoding="utf-8", errors="replace")
text = remove_managed_block(text)

block = f"""

{START}
@media only screen and (max-width: 600px) {{
  .mobile-card,
  .box.mobile-card {{
    background: var(--card) !important;
    border: 1px solid var(--border) !important;
    border-radius: var(--radius) !important;
    box-shadow: none !important;
    color: var(--text) !important;
  }}

  .mobile-card p,
  .mobile-card div,
  .mobile-card span,
  .mobile-card small,
  .mobile-card strong,
  .mobile-card label {{
    color: var(--text-muted) !important;
  }}

  .mobile-card h1,
  .mobile-card h2,
  .mobile-card h3,
  .mobile-card h4,
  .mobile-card h5,
  .mobile-card h6,
  .mobile-card .h1,
  .mobile-card .h2,
  .mobile-card .h3,
  .mobile-card .h4,
  .mobile-card .h5,
  .mobile-card .h6 {{
    color: #fff !important;
  }}

  .mobile-card .jel-orange,
  .mobile-card .btc-color,
  .mobile-card .col-btc,
  .mobile-card a {{
    color: var(--btc) !important;
  }}

  .mobile-card i,
  .mobile-card svg {{
    color: var(--text) !important;
  }}

  .mobile-card .btn,
  .mobile-card button,
  .mobile-card input[type="submit"] {{
    box-shadow: none !important;
  }}

  .mobile-card .btn-btc,
  .mobile-card button.btn-btc,
  .mobile-card input.btn-btc {{
    background: var(--btc) !important;
    color: #000 !important;
    border-color: var(--btc) !important;
  }}

  .mobile-card .btn-outline-btc {{
    background: transparent !important;
    color: var(--btc) !important;
    border-color: rgba(247,147,26,0.45) !important;
  }}

  .mobile-card .btn-outline-danger {{
    background: transparent !important;
    color: var(--red) !important;
    border-color: rgba(239,68,68,0.45) !important;
  }}
}}
{END}
"""

target.parent.mkdir(parents=True, exist_ok=True)
target.write_text(text + block + "\n", encoding="utf-8")
