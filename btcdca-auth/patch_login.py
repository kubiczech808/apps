from pathlib import Path


source = Path("server-current/login-user.php")
target = Path("deploy-root/www/login-user.php")
html = source.read_text(encoding="utf-8", errors="replace")

css = """
    .google-oauth-btn { display:flex; align-items:center; justify-content:center; width:100%; padding:13px 14px; background:#fff; color:#202124; border:1px solid var(--border); border-radius:10px; font-family:'DM Sans',sans-serif; font-size:15px; font-weight:700; cursor:pointer; transition:all .2s; text-align:center; margin-bottom:0; }
    .google-oauth-btn:hover { background:#f8fafc; color:#000; opacity:1; transform:translateY(-1px); }
    .google-oauth-btn::before { content:'G'; display:inline-flex; align-items:center; justify-content:center; width:22px; height:22px; margin-right:10px; border-radius:50%; color:#4285f4; background:#fff; border:1px solid #dfe3ea; font-weight:800; }
"""

block = """    <?php if (!empty($_SESSION['btcdca_google_error'])): ?>
      <div class="alert alert-danger"><?= htmlspecialchars((string)$_SESSION['btcdca_google_error'], ENT_QUOTES, 'UTF-8'); unset($_SESSION['btcdca_google_error']); ?></div>
    <?php endif; ?>
    <a class="google-oauth-btn" href="btcdca-google-login.php">Continue with Google</a>
    <div class="divider">or</div>
"""

if "google-oauth-btn" not in html:
    if "</style>" not in html:
        raise SystemExit("Could not find </style> in login-user.php")
    html = html.replace("</style>", css + "\n  </style>", 1)
    marker = '<form action="login-user.php"'
    if marker not in html:
        raise SystemExit("Could not find login form in login-user.php")
    html = html.replace(marker, block + "    " + marker, 1)

target.write_text(html, encoding="utf-8")
