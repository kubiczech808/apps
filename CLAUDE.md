# Agent M — Bitcoin DCA Auto-Poster

## User preferences
- Always communicate in Czech (česky)
- Project directory: `medium-poster/`
- User prefers autonomous execution ("zprovesujes sam")

## Architecture
- Gemini 2.5 Flash for text generation
- Pollinations API (model: klein) for header images (random seed + style rotation)
- Publishing: GitHub Pages (RSS), Dev.to, Hashnode (Playwright), Medium (Playwright)
- Telegram bot for notifications (link + image only, no article body)
- Telegram bot commands: /post, /draft, /preview, /feedback, /feedback_clear, /history, /topics, /status, /medium_login, /hashnode_login
- GitHub Actions workflow: daily at 15:00 UTC (17:00 CEST)
- Content plan with pillar rotation for topic diversity
- Feedback system: persistent standing instructions in `data/feedback.json`
- Site context: affiliate links + internal btc-dca.com links auto-inserted in articles

## Deployment (RPi)
1. Commit + push do větve na GitHubu
2. GitHub Actions self-hosted runner na RPi naslouchá na GitHubu
3. Workflow `agent-m-deploy.yml` se spustí automaticky (push trigger na `medium-poster/` soubory) nebo ručně přes `.github/agent-m-deploy-trigger.txt`
4. Runner na RPi spustí kroky jako lokální shell příkazy — žádné SSH
5. `sudo cp scripts/... /home/openclaw2/scripts/` — zkopíruje skripty
6. `rsync` synchronizuje kód do `/home/openclaw2/apps/medium-poster/`
7. Restartuje bota přes `agent-m-bot.sh` (kill old PID, venv, pip install, nohup start)

## Key files
- `medium-poster/agent_m/pipeline.py` — main orchestration
- `medium-poster/agent_m/gemini/writer.py` — article generation (delimiter format)
- `medium-poster/agent_m/gemini/imager.py` — Pollinations image generation
- `medium-poster/agent_m/publishers/` — platform publishers
- `medium-poster/agent_m/content_plan.py` — topic plan with pillar rotation
- `medium-poster/agent_m/feedback.py` — persistent feedback storage
- `medium-poster/agent_m/site_context.py` — affiliate links + site pages
- `medium-poster/agent_m/update_links.py` — backfill links to existing Dev.to articles
- `scripts/agent-m-bot.sh` — RPi bot runner script
- `.github/workflows/agent-m-publish.yml` — CI publish pipeline (ubuntu-latest)
- `.github/workflows/agent-m-update-links.yml` — CI update-links pipeline
- `.github/workflows/agent-m-deploy.yml` — deploy bot to RPi (self-hosted runner)
- `.github/agent-m-trigger.txt` — push trigger for publish workflow
- `.github/agent-m-update-trigger.txt` — push trigger for update-links workflow
- `.github/agent-m-deploy-trigger.txt` — push trigger for deploy workflow
