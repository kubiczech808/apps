# Agent M — Bitcoin DCA Auto-Poster

## User preferences
- Always communicate in Czech (česky)
- Project directory: `medium-poster/`

## Architecture
- Gemini 2.5 Flash for text generation
- Pollinations API (model: klein) for header images
- Publishing: GitHub Pages (RSS), Dev.to, Hashnode (Playwright), Medium (Playwright or API)
- Telegram bot for notifications (link + image only, no article body)
- GitHub Actions workflow: daily at 15:00 UTC (17:00 CEST)
- Content plan with pillar rotation for topic diversity

## Key files
- `medium-poster/agent_m/pipeline.py` — main orchestration
- `medium-poster/agent_m/gemini/writer.py` — article generation (delimiter format)
- `medium-poster/agent_m/gemini/imager.py` — Pollinations image generation
- `medium-poster/agent_m/publishers/` — platform publishers
- `medium-poster/agent_m/content_plan.py` — topic plan with pillar rotation
- `.github/workflows/agent-m-publish.yml` — CI pipeline
- `.github/agent-m-trigger.txt` — push trigger for workflow
