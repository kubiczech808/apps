# Medium Engagement Scout

Goal: find related Medium articles and prepare useful comment drafts that can
increase visibility without behaving like spam.

The scout is intentionally human-in-the-loop. It searches and drafts comments
throughout the day, but it publishes only after explicit Telegram approval.

## Algorithm

1. Build search queries from two sources, roughly half and half:
   - a fixed pool of evergreen Bitcoin/DCA phrases, reshuffled each day
   - recent Agent M publications, their tags, and the next unused content-plan
     keywords

   The rotating half is load-bearing: history-derived queries only change when a
   new article goes out, so with `/medium_publish off` the whole query list
   freezes and every slot re-searches the same phrases and re-inspects the same
   already-rejected articles.
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
6. Inspect the article/profile before drafting a comment. Keep only candidates
   that satisfy all hard filters:
   - article is confidently English
   - article has at least 3 responses/comments — read from the response control
     (`button[aria-label="responses"]`), whose count is a bare number that never
     appears in the page text; if the count cannot be read at all the candidate
     is handed to the follower-based fallback instead of being reported as
     having zero responses
   - author/profile has at least 100 followers
7. Keep only candidates above the relevance threshold and hard filters. When
   more than one eligible candidate turns up in a slot, reach ranking (trial,
   default ON, `/engage_reach on|off|status`) picks the one our comment is
   most likely to actually be seen under, instead of just the first one
   found:
   - a bonus for articles published in the last 3 days (still getting
     traffic and triggering author notifications) versus ones that have
     already settled
   - a bonus for a response count in the 3-40 range, and a penalty past 150 -
     our comment is more likely to be read as reply #10 than as reply #200
   - article age comes from a best-effort read of Medium's byline text
     (`"4d ago"`, `"Apr 15, 2026"`); when it can't be parsed, age just doesn't
     contribute to the score - it never blocks a candidate
   - this only changes which eligible article is chosen, never loosens who
     is eligible
8. Draft a short comment with Gemini:
   - 55-95 words
   - concrete point, nuance, or question
   - no generic praise
   - no hashtags or sales CTA
   - no link by default; at most one btc-dca.com link only when context makes it
     genuinely useful
9. Send the opportunities to Telegram for manual review with buttons:
   - `vložit + like`: post the comment and clap the article
   - `zahodit`: skip the opportunity
10. On approval, enforce the hard safety limits again before posting:
   - max 10 posted comments per Prague day
   - never comment under the same article twice
   - never comment under the same Medium profile twice in the same ISO week
11. Every Sunday at 21:01 Europe/Prague, send one weekly Telegram summary
    instead of a daily one: comments posted this week (by day), reach stats
    (how many landed on articles <= 3 days old, average article age), slots
    run and candidates found/inspected, the week's top rejection reasons, and
    an "Agent status" line with when the bot process last reported in and
    when it last (re)started - the proof the agent is alive even in a week
    with nothing posted. A heartbeat is recorded on every engagement slot,
    every session refresh, and every startup, so a week of silence shows up
    as a stale heartbeat rather than just a quiet report.
12. At 06:40 Europe/Prague, refresh the Medium session: open an authenticated
    page and write the cookies back. Every Medium browser session persists its
    cookies, including the read-only search and inspection runs — publishing an
    article must never be the only thing that keeps the session alive.

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

Do not add fully automatic comment posting. Medium comments must remain sparse,
specific, and useful enough to stand alone without any link. Approval is required
per comment.
