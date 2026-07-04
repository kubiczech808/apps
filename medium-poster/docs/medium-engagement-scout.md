# Medium Engagement Scout

Goal: find related Medium articles and prepare useful comment drafts that can
increase visibility without behaving like spam.

The scout is intentionally human-in-the-loop. It searches and drafts comments,
but it does not publish them automatically.

## Algorithm

1. Build search queries from recent Agent M publications, their tags, and the
   next unused content-plan keywords.
2. Search Medium with the existing authenticated Playwright session.
3. Normalize and de-duplicate article URLs.
4. Exclude our own Medium account, edit pages, sign-in pages, tag pages, and
   articles already seen in `data/medium_engagement.json`.
5. Score candidates by relevance:
   - strong positive signals: `bitcoin`, `dca`, `dollar cost averaging`,
     `recurring`, `automation`, `self custody`, `wallet`, `exchange`, `fees`,
     `halving`
   - extra points for overlap with the search query
   - negative signals: broad crypto without Bitcoin, airdrops, meme coins,
     casino framing, or obvious 100x bait
6. Keep only candidates above the relevance threshold.
7. Draft a short comment with Gemini:
   - 55-95 words
   - concrete point, nuance, or question
   - no generic praise
   - no hashtags or sales CTA
   - no link by default; at most one btc-dca.com link only when context makes it
     genuinely useful
8. Send the opportunities to Telegram for manual review.

## Commands

```bash
python -m agent_m.cli medium-engagement-scout
python -m agent_m.cli medium-engagement-scout --query "bitcoin dca fees"
```

Telegram:

```text
/engage
/engage bitcoin dca fees
```

## Publishing Policy

Do not add automatic comment posting until the account has a review workflow
with explicit approval per comment. Medium comments should be sparse, specific,
and useful enough to stand alone without any link.
