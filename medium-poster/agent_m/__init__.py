import logging
import re

__version__ = "0.1.0"


class _SecretFilter(logging.Filter):
    _patterns = [
        (re.compile(r"(key=)[A-Za-z0-9_-]{20,}"), r"\1***"),
        (re.compile(r"(bot)\d{8,}:[A-Za-z0-9_-]{30,}"), r"\1***:***"),
        (re.compile(r"(token=)[A-Za-z0-9_-]{20,}"), r"\1***"),
        (re.compile(r"AIzaSy[A-Za-z0-9_-]{30,}"), "***"),
    ]

    def filter(self, record: logging.LogRecord) -> bool:
        record.msg = self._mask(record.msg)
        if record.args:
            if isinstance(record.args, dict):
                record.args = {
                    k: self._mask(v) if isinstance(v, str) else v
                    for k, v in record.args.items()
                }
            elif isinstance(record.args, tuple):
                record.args = tuple(
                    self._mask(a) if isinstance(a, str) else a
                    for a in record.args
                )
        return True

    def _mask(self, v):
        if not isinstance(v, str):
            return v
        for pattern, repl in self._patterns:
            v = pattern.sub(repl, v)
        return v


_secret_filter = _SecretFilter()
for _logger_name in ("httpx", "httpcore", "google_genai"):
    logging.getLogger(_logger_name).addFilter(_secret_filter)
