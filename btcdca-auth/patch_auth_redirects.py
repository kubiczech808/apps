"""Make post-auth application redirects absolute and independent of the form URL."""

from __future__ import annotations

import re
from pathlib import Path


TARGETS = (
    Path("server-current/login-user.php"),
    Path("server-current/signup-user.php"),
)

# A relative redirect is resolved against /login-user/ or /signup-user/, which
# produces /login-user/app/overview.php instead of the application route.
RELATIVE_APP_ROUTE = re.compile(r"(?<![/A-Za-z0-9_.-])app/overview(?:\.php)?")


for source in TARGETS:
    html = source.read_text(encoding="utf-8", errors="replace")
    patched = RELATIVE_APP_ROUTE.sub("/app/overview.php", html)
    if patched != html:
        source.write_text(patched, encoding="utf-8")
        print(f"Normalized post-auth application redirect in {source}")
