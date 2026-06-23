from pathlib import Path


source = Path("server-current/signup-user.php")
target = Path("deploy-root/www/signup-user.php")
html = source.read_text(encoding="utf-8", errors="replace")

css = """
    .google-oauth-btn { display:flex; align-items:center; justify-content:center; width:100%; padding:13px 14px; background:#fff; color:#202124; border:1px solid var(--border); border-radius:10px; font-family:'DM Sans',sans-serif; font-size:15px; font-weight:700; cursor:pointer; transition:all .2s; text-align:center; margin-bottom:0; }
    .google-oauth-btn:hover { background:#f8fafc; color:#000; opacity:1; transform:translateY(-1px); }
    .google-oauth-btn::before { content:'G'; display:inline-flex; align-items:center; justify-content:center; width:22px; height:22px; margin-right:10px; border-radius:50%; color:#4285f4; background:#fff; border:1px solid #dfe3ea; font-weight:800; }
    .google-oauth-wrap { display:flex; justify-content:center; width:100%; min-height:44px; margin-bottom:0; }
    .google-oauth-wrap iframe { margin:0 auto !important; }
"""

google_block = """    <?php
      $btcdcaGoogleConfig = @include __DIR__ . '/../btcdca-google-config.php';
      $btcdcaGoogleClientId = is_array($btcdcaGoogleConfig) ? (string)($btcdcaGoogleConfig['google_client_id'] ?? '') : '';
    ?>
    <?php if ($btcdcaGoogleClientId !== ''): ?>
      <form id="btcdca-google-signup-form" action="btcdca-google-token-login" method="post" style="display:none;">
        <input type="hidden" name="flow" value="signup">
        <input type="hidden" name="credential" id="btcdca-google-signup-credential">
      </form>
      <div id="btcdca-google-signup-button" class="google-oauth-wrap"></div>
      <script src="https://accounts.google.com/gsi/client" async defer></script>
      <script>
        (function () {
          function renderGoogleButton() {
            if (!window.google || !google.accounts || !google.accounts.id) {
              window.setTimeout(renderGoogleButton, 50);
              return;
            }
            google.accounts.id.initialize({
              client_id: <?= json_encode($btcdcaGoogleClientId, JSON_UNESCAPED_SLASHES); ?>,
              callback: function (response) {
                if (!response || !response.credential) {
                  return;
                }
                document.getElementById('btcdca-google-signup-credential').value = response.credential;
                document.getElementById('btcdca-google-signup-form').submit();
              }
            });
            google.accounts.id.renderButton(document.getElementById('btcdca-google-signup-button'), {
              theme: 'outline',
              size: 'large',
              type: 'standard',
              text: 'signup_with',
              shape: 'rectangular',
              width: 360
            });
          }
          window.addEventListener('load', renderGoogleButton);
        }());
      </script>
    <?php else: ?>
      <a class="google-oauth-btn" href="btcdca-google-login?flow=signup">Sign up with Google</a>
    <?php endif; ?>
"""

block = """    <?php if (!empty($_SESSION['btcdca_google_error'])): ?>
      <div class="alert alert-danger"><?= htmlspecialchars((string)$_SESSION['btcdca_google_error'], ENT_QUOTES, 'UTF-8'); unset($_SESSION['btcdca_google_error']); ?></div>
    <?php endif; ?>
""" + google_block + """
    <div class="divider">or</div>
"""

if ".google-oauth-wrap" not in html:
    if "</style>" not in html:
        raise SystemExit("Could not find </style> in signup-user.php")
    html = html.replace("</style>", css + "\n  </style>", 1)

if "btcdca-google-token-login" not in html:
    replaced = False
    for old in [
        '<a class="google-oauth-btn" href="btcdca-google-login.php?flow=signup">Sign up with Google</a>',
        '<a class="google-oauth-btn" href="btcdca-google-login.php">Sign up with Google</a>',
        '<a class="google-oauth-btn" href="btcdca-google-login?flow=signup">Sign up with Google</a>',
    ]:
        if old in html:
            html = html.replace(old, google_block.rstrip(), 1)
            replaced = True
            break
    if not replaced:
        marker = '<form action="signup-user.php"'
        if marker not in html:
            raise SystemExit("Could not find signup form in signup-user.php")
        html = html.replace(marker, block + "    " + marker, 1)

if "btcdca-google-token-login" not in html:
    marker = '<form action="signup-user.php"'
    if marker not in html:
        raise SystemExit("Could not find signup form in signup-user.php")
    html = html.replace(marker, block + "    " + marker, 1)

html = html.replace(
    '<div class="step done"><span class="step-num">✓</span><span>Calculate</span></div>',
    '<div class="step active"><span class="step-num">1</span><span>Create Account</span></div>',
)
html = html.replace(
    '<div class="step active"><span class="step-num">2</span><span>Create Account</span></div>',
    '<div class="step"><span class="step-num">2</span><span>Portfolio</span></div>',
)
html = html.replace(
    '<h1 class="auth-title">You\'re almost there</h1>',
    '<h1 class="auth-title">Create your account</h1>',
)
html = html.replace(
    'Create your free account to save your DCA plan and start automating your Bitcoin purchases.',
    'Create your free account now. You can add your first portfolio after sign up.',
)
html = html.replace(
    'Create Account &amp; Activate Plan →',
    'Create Account →',
)

html = html.replace('action="signup-user.php"', 'action="signup-user"')
html = html.replace('action="btcdca-google-token-login.php"', 'action="btcdca-google-token-login"')
html = html.replace('href="login-user.php"', 'href="login-user"')
html = html.replace('href="btcdca-google-login.php?flow=signup"', 'href="btcdca-google-login?flow=signup"')
html = html.replace('href="btcdca-google-login.php"', 'href="btcdca-google-login"')

target.write_text(html, encoding="utf-8")
