"""Add Google registration to the calculator's account-creation form."""

import os
from pathlib import Path


source = Path(os.environ.get("BTCDCA_CALCULATOR_SOURCE", "server-current/dca-calculator.php"))
target = Path(os.environ.get("BTCDCA_CALCULATOR_TARGET", "deploy-root/www/dca-calculator.php"))
html = source.read_text(encoding="utf-8", errors="replace")

if "btcdca-calculator-google-signup" in html:
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(html, encoding="utf-8")
    raise SystemExit(0)

if 'type="email"' not in html and "type='email'" not in html and 'name="email"' not in html and "name='email'" not in html:
    raise SystemExit("Could not find the calculator account email field.")

style = """
<style id="btcdca-calculator-google-signup-style">
  .btcdca-calculator-google-divider {
    display:flex; align-items:center; gap:12px; margin:16px 0;
    color:#9ca3af; font-size:13px; text-align:center;
  }
  .btcdca-calculator-google-divider::before,
  .btcdca-calculator-google-divider::after {
    content:''; flex:1; height:1px; background:rgba(255,255,255,.14);
  }
  .btcdca-calculator-google-wrap { display:flex; justify-content:center; min-height:44px; }
  .btcdca-calculator-google-wrap iframe { margin:0 auto !important; }
  .btcdca-calculator-google-fallback {
    display:flex; align-items:center; justify-content:center; width:100%; min-height:48px;
    box-sizing:border-box; border:1px solid rgba(255,255,255,.2); border-radius:8px;
    background:#fff; color:#202124 !important; font:600 15px/1.2 inherit; text-decoration:none;
  }
</style>
"""

block = """<?php
  $btcdcaCalculatorGoogleConfig = @include __DIR__ . '/../btcdca-google-config.php';
  $btcdcaCalculatorGoogleClientId = is_array($btcdcaCalculatorGoogleConfig) ? (string)($btcdcaCalculatorGoogleConfig['google_client_id'] ?? '') : '';
?>
<form id="btcdca-calculator-google-signup-form" action="/btcdca-google-token-login/" method="post" style="display:none;">
  <input type="hidden" name="flow" value="signup">
  <input type="hidden" name="credential" id="btcdca-calculator-google-credential">
</form>
<script id="btcdca-calculator-google-signup">
(function () {
  var clientId = <?= json_encode($btcdcaCalculatorGoogleClientId, JSON_UNESCAPED_SLASHES); ?>;
  if (!clientId) return;

  function addGoogleRegistration() {
    var email = document.querySelector('input[type="email"], input[name="email"]');
    if (!email) return;
    var form = email.closest('form');
    if (!form || form.querySelector('.btcdca-calculator-google-wrap')) return;
    var submit = form.querySelector('button[type="submit"], input[type="submit"]');
    if (!submit) return;

    var divider = document.createElement('div');
    divider.className = 'btcdca-calculator-google-divider';
    divider.textContent = 'or';
    var holder = document.createElement('div');
    holder.className = 'btcdca-calculator-google-wrap';
    holder.id = 'btcdca-calculator-google-button';
    submit.insertAdjacentElement('afterend', divider);
    divider.insertAdjacentElement('afterend', holder);

    function submitCredential(response) {
      if (!response || !response.credential) return;
      document.getElementById('btcdca-calculator-google-credential').value = response.credential;
      document.getElementById('btcdca-calculator-google-signup-form').submit();
    }
    function render() {
      if (!window.google || !google.accounts || !google.accounts.id) {
        window.setTimeout(render, 50);
        return;
      }
      google.accounts.id.initialize({ client_id: clientId, callback: submitCredential });
      google.accounts.id.renderButton(holder, {
        theme: 'outline', size: 'large', type: 'standard', text: 'signup_with',
        shape: 'rectangular', width: Math.min(360, Math.max(240, Math.floor(holder.getBoundingClientRect().width || 360)))
      });
    }
    var script = document.createElement('script');
    script.src = 'https://accounts.google.com/gsi/client';
    script.async = true;
    script.defer = true;
    script.onload = render;
    script.onerror = function () {
      holder.innerHTML = '<a class="btcdca-calculator-google-fallback" href="/btcdca-google-login/?flow=signup">Sign up with Google</a>';
    };
    document.head.appendChild(script);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', addGoogleRegistration);
  } else {
    addGoogleRegistration();
  }
}());
</script>
"""

if "</head>" in html:
    html = html.replace("</head>", style + "\n</head>", 1)
elif "</style>" in html:
    html = html.replace("</style>", "</style>\n" + style, 1)
else:
    raise SystemExit("Could not find a calculator HTML head for Google button styles.")

if "</body>" not in html:
    raise SystemExit("Could not find </body> in dca-calculator.php.")
html = html.replace("</body>", block + "\n</body>", 1)
target.parent.mkdir(parents=True, exist_ok=True)
target.write_text(html, encoding="utf-8")
