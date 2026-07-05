from pathlib import Path


source = Path("server-current/main.js")
target = Path("deploy-root/www/assets/js/main.js")

START = "/* BEGIN BTC-DCA immediate ticker init */"
END = "/* END BTC-DCA immediate ticker init */"


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
(function () {{
  function updateMainTicker() {{
    var ticker = document.getElementById('mainTicker');
    if (!ticker) {{
      return;
    }}

    var url = '/php/getTicker.php';
    var applyRate = function (result) {{
      if (result && Number(result.status) === 1 && result.rate) {{
        ticker.innerHTML = result.rate;
      }}
    }};

    if (window.jQuery && window.jQuery.ajax) {{
      window.jQuery.ajax({{
        type: 'GET',
        url: url,
        dataType: 'json',
        cache: false,
        success: applyRate
      }});
      return;
    }}

    if (window.fetch) {{
      window.fetch(url, {{ cache: 'no-store' }})
        .then(function (response) {{ return response.json(); }})
        .then(applyRate)
        .catch(function () {{}});
    }}
  }}

  if (document.readyState === 'loading') {{
    document.addEventListener('DOMContentLoaded', updateMainTicker);
  }} else {{
    updateMainTicker();
  }}
}}());
{END}
"""

target.parent.mkdir(parents=True, exist_ok=True)
target.write_text(text + block + "\n", encoding="utf-8")
