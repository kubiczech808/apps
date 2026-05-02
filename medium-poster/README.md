# Agent M — Medium Auto-Poster for btc-dca.com

Telegram bot that generates Bitcoin DCA articles via Google Gemini, creates header images via Imagen 3, and publishes to Medium daily.

## Setup

### 1. Gemini API Key

1. Go to [Google AI Studio](https://aistudio.google.com/apikey)
2. Click **Create API Key**
3. Copy the key → paste as `GEMINI_API_KEY` in `.env`

### 2. Telegram Bot

1. Open Telegram, find **@BotFather**
2. Send `/newbot`, follow the prompts (pick a name and username)
3. Copy the bot token → paste as `TELEGRAM_BOT_TOKEN` in `.env`
4. To get your admin chat ID:
   - Send any message to your new bot
   - Open `https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates` in a browser
   - Find `"chat":{"id":123456789}` — that number is your `TELEGRAM_ADMIN_CHAT_ID`

### 3. Medium Integration Token

1. Go to [Medium Settings → Security](https://medium.com/me/settings/security)
2. Scroll to **Integration tokens**
3. Enter a description, click **Get token**
4. Copy → paste as `MEDIUM_TOKEN` in `.env`

> Note: Medium's API is deprecated but still functional with existing tokens.

### 4. Imgur Client ID

1. Go to [Imgur — Register an Application](https://api.imgur.com/oauth2/addclient)
2. Application name: anything (e.g., "agent-m")
3. Authorization type: **OAuth 2 authorization without a callback URL**
4. Copy the **Client ID** → paste as `IMGUR_CLIENT_ID` in `.env`

### 5. Install & Run

```bash
cd medium-poster
cp .env.example .env
# Edit .env with all keys from steps above

pip install .
python -m agent_m
```

## .env Reference

```
GEMINI_API_KEY=           # from Google AI Studio
MEDIUM_TOKEN=             # from Medium settings
TELEGRAM_BOT_TOKEN=       # from @BotFather
TELEGRAM_ADMIN_CHAT_ID=   # your Telegram user/chat ID
IMGUR_CLIENT_ID=           # from Imgur app registration

PUBLISH_HOUR=9            # daily publish time (UTC)
PUBLISH_MINUTE=0
SITE_URL=https://btc-dca.com
SITE_NAME=btc-dca.com
LOG_LEVEL=INFO
```

## Telegram Commands

| Command    | Description                          |
|------------|--------------------------------------|
| `/post`    | Generate & publish article (public)  |
| `/draft`   | Generate & save as draft on Medium   |
| `/preview` | Generate article without publishing  |
| `/history` | Show last 10 publications            |
| `/topics`  | Show cached topic queue              |
| `/status`  | Token usage & next scheduled publish |
| `/help`    | Show available commands              |

## How It Works

1. **Topic research** — Gemini generates 7 topics at once, caches them. Each run picks the next unused topic.
2. **Article writing** — Gemini writes a ~1500-word SEO article with natural btc-dca.com references.
3. **Image generation** — Imagen 3 creates a 16:9 blog header image.
4. **Image hosting** — Uploaded to Imgur (anonymous). Medium auto-pulls images from URLs in markdown.
5. **Publishing** — Posted to Medium via their API. Medium renders the markdown + image.
6. **Scheduling** — `python-telegram-bot`'s built-in JobQueue runs the pipeline daily at `PUBLISH_HOUR:PUBLISH_MINUTE` UTC.
