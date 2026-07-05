from pathlib import Path


source = Path("server-current/main.js")
target = Path("deploy-root/www/assets/js/main.js")

START = "/* BEGIN BTC-DCA immediate ticker init */"
END = "/* END BTC-DCA immediate ticker init */"
ORDER_START = "/* BEGIN BTC-DCA mobile order dark runtime fix */"
ORDER_END = "/* END BTC-DCA mobile order dark runtime fix */"


def remove_managed_block(value: str, start_marker: str, end_marker: str) -> str:
    start = value.find(start_marker)
    if start == -1:
        return value.rstrip()
    end = value.find(end_marker, start)
    if end == -1:
        return value[:start].rstrip()
    return (value[:start] + value[end + len(end_marker):]).rstrip()


text = source.read_text(encoding="utf-8", errors="replace")
text = remove_managed_block(text, START, END)
text = remove_managed_block(text, ORDER_START, ORDER_END)

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

order_block = f"""

{ORDER_START}
(function () {{
  function isWhiteBackground(value) {{
    return /rgb\\(\\s*255\\s*,\\s*255\\s*,\\s*255\\s*\\)|rgba\\(\\s*255\\s*,\\s*255\\s*,\\s*255\\s*,\\s*(?:1|0?\\.9)/i.test(value || '');
  }}

  function looksLikeOrderText(value) {{
    return /(BTC\\s+Sell\\s+Orders|Withdrawal\\s+orders|Exchange\\s+.*\\s+to\\s+BTC|Created\\s+\\d|Activate|Delete|Create\\s+Sell\\s+Order|Create\\s+withdrawal)/i.test(value || '');
  }}

  function applyDarkCard(element) {{
    element.style.setProperty('background', '#161616', 'important');
    element.style.setProperty('background-color', '#161616', 'important');
    element.style.setProperty('border', '1px solid rgba(255,255,255,0.08)', 'important');
    element.style.setProperty('border-radius', '12px', 'important');
    element.style.setProperty('box-shadow', 'none', 'important');
    element.style.setProperty('color', '#f0f0f0', 'important');

    Array.prototype.forEach.call(element.querySelectorAll('p, div, span, small, strong, label'), function (child) {{
      if (!child.closest('button, .btn, a')) {{
        child.style.setProperty('color', '#888', 'important');
      }}
    }});

    Array.prototype.forEach.call(element.querySelectorAll('button, .btn, input[type="submit"]'), function (button) {{
      button.style.setProperty('box-shadow', 'none', 'important');
    }});
  }}

  function darkenMobileOrderCards() {{
    if (!window.matchMedia || !window.matchMedia('(max-width: 991px)').matches) {{
      return;
    }}

    var roots = document.querySelectorAll('section.services, .col-sm-10.col-xs-12.pX-0.m-a, #mainTableBody, .table-responsive, body');
    Array.prototype.forEach.call(roots, function (root) {{
      Array.prototype.forEach.call(root.querySelectorAll('div, li, td, tr, article, section'), function (element) {{
        var text = (element.innerText || element.textContent || '').replace(/\\s+/g, ' ').trim();
        if (!looksLikeOrderText(text)) {{
          return;
        }}

        var target = element;
        for (var i = 0; i < 4 && target && target !== document.body; i += 1) {{
          var computed = window.getComputedStyle(target);
          if (
            isWhiteBackground(computed.backgroundColor) ||
            target.classList.contains('bg-white') ||
            target.classList.contains('mobile-card') ||
            target.classList.contains('box') ||
            target.classList.contains('card')
          ) {{
            applyDarkCard(target);
            return;
          }}
          target = target.parentElement;
        }}
      }});
    }});
  }}

  if (document.readyState === 'loading') {{
    document.addEventListener('DOMContentLoaded', darkenMobileOrderCards);
  }} else {{
    darkenMobileOrderCards();
  }}
  window.setTimeout(darkenMobileOrderCards, 500);
  window.setTimeout(darkenMobileOrderCards, 1500);
}}());
{ORDER_END}
"""

target.parent.mkdir(parents=True, exist_ok=True)
target.write_text(text + block + order_block + "\n", encoding="utf-8")
