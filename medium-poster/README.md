# Agent M — Bitcoin DCA Blog Auto-Poster for btc-dca.com

Telegram bot that generates Bitcoin DCA articles via Google Gemini, creates header images via Imagen 3, and publishes to Medium via IFTTT + RSS feed hosted on GitHub Pages.

## Architecture

```
Gemini → Article + Image → GitHub Pages (RSS feed) → IFTTT → Medium
```

## Setup

### 1. Gemini API Key

1. Go to [Google AI Studio](https://aistudio.google.com/apikey)
2. Click **Create API Key**
3. Copy the key → `GEMINI_API_KEY` in `.env`

### 2. Telegram Bot

1. Open Telegram, find **@BotFather**
2. Send `/newbot`, follow the prompts (pick a name and username)
3. Copy the bot token → `TELEGRAM_BOT_TOKEN` in `.env`
4. To get your admin chat ID:
   - Send any message to your new bot
   - Open `https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates` in a browser
   - Find `"chat":{"id":123456789}` → `TELEGRAM_ADMIN_CHAT_ID` in `.env`

### 3. Imgur Client ID

1. Go to [Imgur — Register an Application](https://api.imgur.com/oauth2/addclient)
2. Application name: anything (e.g., "agent-m")
3. Authorization type: **OAuth 2 authorization without a callback URL**
4. Copy the **Client ID** → `IMGUR_CLIENT_ID` in `.env`

### 4. GitHub Personal Access Token (for RSS feed hosting)

1. Go to [GitHub → Settings → Developer settings → Personal access tokens → Fine-grained tokens](https://github.com/settings/personal-access-tokens/new)
2. Token name: `agent-m-rss`
3. Repository access: **Only select repositories** → pick the repo (e.g., `kubiczech808/apps`)
4. Permissions: **Contents** → Read and write
5. Generate token → `GITHUB_PAT` in `.env`

Then enable GitHub Pages on the repo:
1. Go to repo **Settings → Pages**
2. Source: **Deploy from a branch**
3. Branch: `gh-pages` / `/ (root)`
4. Save

Your RSS feed will be available at:
`https://kubiczech808.github.io/apps/feed.xml`

### 5. IFTTT → Medium (auto-publish from RSS)

1. Go to [IFTTT](https://ifttt.com) and sign in
2. Create new Applet:
   - **If This**: choose **RSS Feed** → **New feed item**
   - Feed URL: `https://kubiczech808.github.io/apps/feed.xml`
   - **Then That**: choose **Medium** → **Create a story**
   - Title: `{{EntryTitle}}`
   - Content: `{{EntryContent}}`
   - Tags: `Bitcoin, DCA, Investing`
   - Publish status: **Draft** (recommended) or **Public**
3. Save and enable the Applet

> When Agent M pushes a new article to the RSS feed, IFTTT picks it up and creates a Medium post automatically.

### 6. Medium (optional direct API — only if you have an existing token)

If you already have a Medium integration token from before they stopped issuing them:
- Paste it as `MEDIUM_TOKEN` in `.env`
- Agent M will publish directly to Medium API AND via RSS

If you don't have one (most accounts), leave `MEDIUM_TOKEN` empty — IFTTT handles publishing.

### 7. Install & Run

```bash
cd medium-poster
cp .env.example .env
# Edit .env with all keys from steps above

pip install .
python -m agent_m
```

## .env Reference

```
GEMINI_API_KEY=              # Google AI Studio
TELEGRAM_BOT_TOKEN=          # @BotFather
TELEGRAM_ADMIN_CHAT_ID=      # your Telegram chat ID
IMGUR_CLIENT_ID=             # Imgur app registration
GITHUB_PAT=                  # GitHub fine-grained PAT (contents: read+write)
GITHUB_PAGES_REPO=kubiczech808/apps
GITHUB_PAGES_BRANCH=gh-pages
MEDIUM_TOKEN=                # optional, leave empty if using IFTTT

PUBLISH_HOUR=9               # daily publish time (UTC)
PUBLISH_MINUTE=0
SITE_URL=https://btc-dca.com
SITE_NAME=btc-dca.com
LOG_LEVEL=INFO
```

## GitHub Secrets Mapping

| .env variable            | GitHub Secret Name   |
|--------------------------|----------------------|
| `GEMINI_API_KEY`         | `GEMINI_API_KEY_M`   |
| `TELEGRAM_BOT_TOKEN`     | `M_TELEGRAM_TOKEN`   |
| `TELEGRAM_ADMIN_CHAT_ID` | `M_TELEGRAM_CHAT_ID` |

## Telegram Commands

| Command          | Description                              |
|------------------|------------------------------------------|
| `/post`          | Generate & publish article               |
| `/post slug`     | Publish specific article from plan       |
| `/draft`         | Generate & save as draft                 |
| `/preview`       | Generate without publishing (preview)    |
| `/preview slug`  | Preview specific article from plan       |
| `/history`       | Show last 10 publications                |
| `/topics`        | Show content plan status by pillar       |
| `/status`        | Token usage, schedule & remaining topics |
| `/help`          | Show available commands                  |

## Content Plan

30 curated articles across 6 pillars, each with SEO keywords, funnel stages, and specific CTAs:

| Pillar       | Articles | Focus                                      |
|--------------|----------|--------------------------------------------|
| Basics       | 5        | Beginners — what is DCA, how to start      |
| Strategy     | 5        | Frequency, bear markets, halvings, exits   |
| Data & Proof | 4        | Historical returns, comparisons, evidence  |
| How-To       | 4        | Setup automation, exchanges, security, tax |
| Psychology   | 4        | Emotions, FOMO, consistency, discipline    |
| Advanced     | 6        | Value averaging, retirement, ETFs, goals   |

Use `/topics` in Telegram to see the full plan with done/available status.

## How It Works

1. **Topic selection** — picks next article from curated 30-article content plan
2. **Article writing** — Gemini writes ~1500-word SEO article with btc-dca.com product knowledge baked into the prompt
3. **Image generation** — Imagen 3 creates a 16:9 blog header
4. **Image hosting** — uploaded to Imgur (anonymous, free)
5. **RSS publishing** — article HTML + updated feed.xml pushed to GitHub Pages
6. **Medium cross-post** — IFTTT monitors RSS feed → creates Medium story
7. **Scheduling** — built-in JobQueue publishes daily at configured UTC time
