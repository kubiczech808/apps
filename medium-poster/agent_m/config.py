from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


_PROJECT_ROOT = Path(__file__).resolve().parent.parent


class Config(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=_PROJECT_ROOT / ".env",
        env_file_encoding="utf-8",
    )

    gemini_api_key: str = ""
    telegram_bot_token: str = ""
    telegram_admin_chat_id: int = 0

    # GitHub Pages (for RSS feed hosting)
    github_pat: str = ""
    github_pages_repo: str = "kubiczech808/apps"
    github_pages_branch: str = "gh-pages"

    # Publishers (all optional — leave empty to skip)
    devto_api_key: str = ""
    medium_token: str = ""
    medium_playwright: bool = True
    imgur_client_id: str = ""

    publish_hour: int = 5
    publish_minute: int = 25
    medium_draft_scheduler: bool = True
    medium_draft_schedule_hour: int = 7
    medium_draft_schedule_minute: int = 25
    medium_draft_schedule_check_hour: int = 7
    medium_draft_schedule_check_minute: int = 35

    site_url: str = "https://btc-dca.com"
    site_name: str = "btc-dca.com"

    log_level: str = "INFO"

    @property
    def data_dir(self) -> Path:
        d = _PROJECT_ROOT / "data"
        d.mkdir(exist_ok=True)
        return d


config = Config()  # type: ignore[call-arg]
