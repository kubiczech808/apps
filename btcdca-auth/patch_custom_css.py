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
@media only screen and (max-width: 991px) {{
  .mobile-card,
  .box.mobile-card,
  section.services .mobile-card,
  section.services .bg-white,
  section.services .box,
  section.services .card,
  section.services .list-group-item,
  section.services [style*="background:#fff"],
  section.services [style*="background: #fff"],
  section.services [style*="background-color:#fff"],
  section.services [style*="background-color: #fff"],
  section.services [style*="background:white"],
  section.services [style*="background: white"],
  section.services [style*="background-color:white"],
  section.services [style*="background-color: white"],
  .col-sm-10.col-xs-12.pX-0.m-a .mobile-card,
  .col-sm-10.col-xs-12.pX-0.m-a .bg-white,
  .col-sm-10.col-xs-12.pX-0.m-a .box,
  .col-sm-10.col-xs-12.pX-0.m-a .card,
  .col-sm-10.col-xs-12.pX-0.m-a .list-group-item,
  .col-sm-10.col-xs-12.pX-0.m-a [style*="background:#fff"],
  .col-sm-10.col-xs-12.pX-0.m-a [style*="background: #fff"],
  .col-sm-10.col-xs-12.pX-0.m-a [style*="background-color:#fff"],
  .col-sm-10.col-xs-12.pX-0.m-a [style*="background-color: #fff"],
  .col-sm-10.col-xs-12.pX-0.m-a [style*="background:white"],
  .col-sm-10.col-xs-12.pX-0.m-a [style*="background: white"],
  .col-sm-10.col-xs-12.pX-0.m-a [style*="background-color:white"],
  .col-sm-10.col-xs-12.pX-0.m-a [style*="background-color: white"],
  #mainTableBody,
  #mainTableBody > *,
  #mainTableBody .bg-white,
  #mainTableBody .box,
  #mainTableBody .card,
  #mainTableBody .list-group-item,
  #mainTableBody tr,
  #mainTableBody td,
  .table-responsive .bg-white,
  .table-responsive .box,
  .table-responsive .card,
  .table-responsive .list-group-item,
  .table-responsive [style*="background:#fff"],
  .table-responsive [style*="background: #fff"],
  .table-responsive [style*="background-color:#fff"],
  .table-responsive [style*="background-color: #fff"],
  .table-responsive [style*="background:white"],
  .table-responsive [style*="background: white"],
  .table-responsive [style*="background-color:white"],
  .table-responsive [style*="background-color: white"] {{
    background: var(--card) !important;
    border: 1px solid var(--border) !important;
    border-radius: var(--radius) !important;
    box-shadow: none !important;
    color: var(--text) !important;
  }}

  #mainTableBody td {{
    border-radius: 0 !important;
  }}

  .mobile-card p,
  .mobile-card div,
  .mobile-card span,
  .mobile-card small,
  .mobile-card strong,
  .mobile-card label,
  #mainTableBody p,
  #mainTableBody div,
  #mainTableBody span,
  #mainTableBody small,
  #mainTableBody strong,
  #mainTableBody label,
  .table-responsive .bg-white p,
  .table-responsive .bg-white div,
  .table-responsive .bg-white span,
  .table-responsive .bg-white small,
  .table-responsive .bg-white strong,
  .table-responsive .bg-white label,
  section.services .bg-white p,
  section.services .bg-white div,
  section.services .bg-white span,
  section.services .bg-white small,
  section.services .bg-white strong,
  section.services .bg-white label,
  section.services .box p,
  section.services .box div,
  section.services .box span,
  section.services .box small,
  section.services .box strong,
  section.services .box label,
  .col-sm-10.col-xs-12.pX-0.m-a .bg-white p,
  .col-sm-10.col-xs-12.pX-0.m-a .bg-white div,
  .col-sm-10.col-xs-12.pX-0.m-a .bg-white span,
  .col-sm-10.col-xs-12.pX-0.m-a .bg-white small,
  .col-sm-10.col-xs-12.pX-0.m-a .bg-white strong,
  .col-sm-10.col-xs-12.pX-0.m-a .bg-white label,
  .col-sm-10.col-xs-12.pX-0.m-a .box p,
  .col-sm-10.col-xs-12.pX-0.m-a .box div,
  .col-sm-10.col-xs-12.pX-0.m-a .box span,
  .col-sm-10.col-xs-12.pX-0.m-a .box small,
  .col-sm-10.col-xs-12.pX-0.m-a .box strong,
  .col-sm-10.col-xs-12.pX-0.m-a .box label {{
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
  .mobile-card .h6,
  #mainTableBody h1,
  #mainTableBody h2,
  #mainTableBody h3,
  #mainTableBody h4,
  #mainTableBody h5,
  #mainTableBody h6,
  #mainTableBody .h1,
  #mainTableBody .h2,
  #mainTableBody .h3,
  #mainTableBody .h4,
  #mainTableBody .h5,
  #mainTableBody .h6 {{
    color: #fff !important;
  }}

  .mobile-card .jel-orange,
  .mobile-card .btc-color,
  .mobile-card .col-btc,
  .mobile-card a,
  #mainTableBody .jel-orange,
  #mainTableBody .btc-color,
  #mainTableBody .col-btc,
  #mainTableBody a {{
    color: var(--btc) !important;
  }}

  .mobile-card i,
  .mobile-card svg,
  #mainTableBody i,
  #mainTableBody svg {{
    color: var(--text) !important;
  }}

  .mobile-card .btn,
  .mobile-card button,
  .mobile-card input[type="submit"],
  #mainTableBody .btn,
  #mainTableBody button,
  #mainTableBody input[type="submit"] {{
    box-shadow: none !important;
  }}

  .mobile-card .btn-btc,
  .mobile-card button.btn-btc,
  .mobile-card input.btn-btc,
  #mainTableBody .btn-btc,
  #mainTableBody button.btn-btc,
  #mainTableBody input.btn-btc {{
    background: var(--btc) !important;
    color: #000 !important;
    border-color: var(--btc) !important;
  }}

  .mobile-card .btn-outline-btc,
  #mainTableBody .btn-outline-btc {{
    background: transparent !important;
    color: var(--btc) !important;
    border-color: rgba(247,147,26,0.45) !important;
  }}

  .mobile-card .btn-outline-danger,
  #mainTableBody .btn-outline-danger,
  section.services .btn-outline-danger,
  .col-sm-10.col-xs-12.pX-0.m-a .btn-outline-danger {{
    background: transparent !important;
    color: var(--red) !important;
    border-color: rgba(239,68,68,0.45) !important;
  }}
}}
{END}
"""

target.parent.mkdir(parents=True, exist_ok=True)
target.write_text(text + block + "\n", encoding="utf-8")
