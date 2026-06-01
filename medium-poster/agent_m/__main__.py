import logging

from agent_m.config import config
from agent_m.telegram.bot import build_app


def main() -> None:
    logging.basicConfig(
        level=config.log_level,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    app = build_app()
    app.run_polling()


if __name__ == "__main__":
    main()
