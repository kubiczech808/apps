import logging
import re

from agent_m.config import config
from agent_m.telegram.bot import build_app


class _KeyFilter(logging.Filter):
    _pattern = re.compile(r"(key=)[A-Za-z0-9_-]{20,}")

    def filter(self, record: logging.LogRecord) -> bool:
        if hasattr(record, "msg") and isinstance(record.msg, str):
            record.msg = self._pattern.sub(r"\1***", record.msg)
        if record.args:
            if isinstance(record.args, dict):
                record.args = {
                    k: self._pattern.sub(r"\1***", str(v)) if isinstance(v, str) else v
                    for k, v in record.args.items()
                }
            elif isinstance(record.args, tuple):
                record.args = tuple(
                    self._pattern.sub(r"\1***", str(a)) if isinstance(a, str) else a
                    for a in record.args
                )
        return True


def main() -> None:
    logging.basicConfig(
        level=config.log_level,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    logging.getLogger("httpx").addFilter(_KeyFilter())
    logging.getLogger("httpcore").addFilter(_KeyFilter())
    app = build_app()
    app.run_polling()


if __name__ == "__main__":
    main()
