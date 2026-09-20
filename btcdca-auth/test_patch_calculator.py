"""Regression test for the calculator Google-signup injection."""

import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path


FIXTURE = """<!doctype html>
<html><head><title>Calculator</title></head><body>
<form action=\"/signup-user/\">
  <input type=\"email\" name=\"email\">
  <input type=\"password\" name=\"password\">
  <button type=\"submit\">Create Free Account &amp; Save Plan</button>
</form>
</body></html>
"""


with tempfile.TemporaryDirectory() as directory:
    root = Path(directory)
    source = root / "dca-calculator.php"
    target = root / "patched.php"
    source.write_text(FIXTURE, encoding="utf-8")
    environment = os.environ | {
        "BTCDCA_CALCULATOR_SOURCE": str(source),
        "BTCDCA_CALCULATOR_TARGET": str(target),
    }
    subprocess.run([sys.executable, "btcdca-auth/patch_calculator.py"], check=True, env=environment)
    output = target.read_text(encoding="utf-8")
    assert 'id="btcdca-calculator-google-signup"' in output
    assert '/btcdca-google-token-login/' in output
    assert "Sign up with Google" in output
    assert output.count('btcdca-calculator-google-signup-style') == 1
    php = shutil.which("php")
    if php:
        subprocess.run([php, "-l", str(target)], check=True)
