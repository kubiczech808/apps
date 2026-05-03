from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


_PROJECT_ROOT = Path(__file__).resolve().parent.parent


class Config(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=_PROJECT_ROOT / ".env",
        env_file_encoding="utf-8",
    )

    gemini_api_key: str
    telegram_bot_token: str
    telegram_admin_chat_id: int
    imgur_client_id: str

    # GitHub Pages (for RSS feed hosting)
    github_pat: str
    github_pages_repo: str = "kubiczech808/apps"
    github_pages_branch: str = "gh-pages"

    # Medium (optional — leave empty if using IFTTT)
    medium_token: str = ""

    publish_hour: int = 9
    publish_minute: int = 0

    site_url: str = "https://btc-dca.com"
    site_name: str = "btc-dca.com"

    log_level: str = "INFO"

    @property
    def data_dir(self) -> Path:
        d = _PROJECT_ROOT / "data"
        d.mkdir(exist_ok=True)
        return d


config = Config()  # type: ignore[call-arg]
