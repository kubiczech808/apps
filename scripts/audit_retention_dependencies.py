"""Report BTC-DCA runtime references before changing database retention."""

from __future__ import annotations

import re
from pathlib import Path


ROOT = Path("runtime-source")
REPORT = Path("btcdca-retention-dependency-audit.md")
TERMS = {
    "exchange_rates": re.compile(r"\bexchange_rates\b", re.IGNORECASE),
    "logs": re.compile(r"\blogs\b", re.IGNORECASE),
    "user_events": re.compile(r"\buser_events\b", re.IGNORECASE),
    "calculator": re.compile(r"dca-calculator|calculator", re.IGNORECASE),
    "Binance market data": re.compile(r"api\.binance\.com|ticker/price|klines", re.IGNORECASE),
}


def source_files() -> list[Path]:
    return sorted(
        path
        for path in ROOT.rglob("*")
        if path.is_file() and path.suffix.lower() in {".php", ".js", ".sql"}
    )


def matches(path: Path, pattern: re.Pattern[str]) -> list[int]:
    try:
        contents = path.read_text(encoding="utf-8", errors="replace")
    except OSError as exc:
        raise RuntimeError(f"Could not read {path}: {exc}") from exc
    return [number for number, line in enumerate(contents.splitlines(), 1) if pattern.search(line)]


def main() -> None:
    files = source_files()
    if not files:
        raise SystemExit("No PHP, JavaScript, or SQL application files were downloaded.")

    lines = [
        "# BTC-DCA Retention Dependency Audit",
        "",
        "This report was produced from a read-only FTP download into a disposable GitHub runner.",
        "No production file, database row, or database schema was changed.",
        "",
        f"Files inspected: {len(files)}",
        "",
    ]
    for label, pattern in TERMS.items():
        findings = [(path.relative_to(ROOT), matches(path, pattern)) for path in files]
        findings = [(path, line_numbers) for path, line_numbers in findings if line_numbers]
        lines.extend([f"## {label}", ""])
        if not findings:
            lines.append("No runtime reference was found in the downloaded source.")
        else:
            for path, line_numbers in findings:
                displayed = ", ".join(str(number) for number in line_numbers[:20])
                suffix = " ..." if len(line_numbers) > 20 else ""
                lines.append(f"- `{path}`: lines {displayed}{suffix}")
        lines.append("")

    REPORT.write_text("\n".join(lines), encoding="utf-8")
    print(REPORT.read_text(encoding="utf-8"))


if __name__ == "__main__":
    main()
