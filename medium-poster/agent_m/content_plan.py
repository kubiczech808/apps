"""
Curated 90-day content plan for btc-dca.com Medium blog.

30 articles organized by content pillars, each with:
- SEO keyword target
- Funnel stage (awareness → consideration → conversion)
- Specific CTA pointing to a btc-dca.com feature
- Article angle and key points to cover

Content pillars:
1. Bitcoin DCA Basics (beginners — awareness)
2. Strategy & Optimization (intermediate — consideration)
3. Historical Data & Proof (data-driven — consideration)
4. Practical How-To (action-oriented — conversion)
5. Psychology & Mindset (emotional — awareness/consideration)
6. Advanced & Market Context (expert — retention)
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class ContentPlan:
    slug: str
    title_hint: str
    pillar: str
    funnel_stage: str
    seo_keyword: str
    tags: list[str]
    angle: str
    key_points: list[str]
    cta_target: str


CONTENT_PLAN: list[ContentPlan] = [
    # === PILLAR 1: Bitcoin DCA Basics (Beginners) ===
    ContentPlan(
        slug="what-is-bitcoin-dca",
        title_hint="What Is Bitcoin DCA? The Simplest Strategy to Build Wealth with BTC",
        pillar="basics",
        funnel_stage="awareness",
        seo_keyword="what is bitcoin dca",
        tags=["Bitcoin", "DCA", "Investing"],
        angle="Introductory explainer for complete beginners — no jargon, real examples",
        key_points=[
            "Define DCA in plain English with a grocery shopping analogy",
            "Show how buying $50/week works across price swings",
            "Explain why DCA removes the impossible task of timing the market",
            "Contrast with lump-sum: DCA is for people who earn monthly, not lottery winners",
            "Mention btc-dca.com calculator to see projected returns",
        ],
        cta_target="DCA calculator — let readers plug in their own numbers",
    ),
    ContentPlan(
        slug="start-dca-with-10-dollars",
        title_hint="How to Start Bitcoin DCA With Just $10 a Week",
        pillar="basics",
        funnel_stage="awareness",
        seo_keyword="start bitcoin dca small amount",
        tags=["Bitcoin", "Beginner", "DCA"],
        angle="Remove the barrier of 'I can't afford Bitcoin' — show that tiny amounts compound",
        key_points=[
            "$10/week = $520/year — show what that became historically over 3, 5, 7 years",
            "Fractional Bitcoin (satoshis) explained — you don't need to buy a whole coin",
            "Step-by-step: choose exchange, set recurring buy, withdraw to wallet",
            "Compare $10/week in Bitcoin vs savings account vs S&P 500 over 5 years",
            "btc-dca.com automates the entire process — set it once and forget",
        ],
        cta_target="Registration — sign up free and automate your first $10/week DCA",
    ),
    ContentPlan(
        slug="dca-vs-lump-sum",
        title_hint="Bitcoin DCA vs Lump Sum: Which Strategy Actually Wins?",
        pillar="basics",
        funnel_stage="awareness",
        seo_keyword="bitcoin dca vs lump sum",
        tags=["Bitcoin", "DCA", "Investment Strategy"],
        angle="Data-driven comparison with honest nuance — neither is always better",
        key_points=[
            "Historical data: lump sum wins ~60% of the time in traditional markets",
            "But crypto volatility changes the math — DCA reduces max drawdown significantly",
            "Psychological factor: lump-sum investors 37% more likely to panic-sell",
            "Most people don't HAVE a lump sum — DCA matches real paychecks",
            "Hybrid approach: 70:30 DCA + tactical reserve (btc-dca.com supports this)",
        ],
        cta_target="DCA calculator — compare scenarios side by side",
    ),
    ContentPlan(
        slug="5-dca-mistakes-beginners",
        title_hint="5 Bitcoin DCA Mistakes That Cost Beginners Money",
        pillar="basics",
        funnel_stage="awareness",
        seo_keyword="bitcoin dca mistakes",
        tags=["Bitcoin", "DCA", "Mistakes"],
        angle="Learn from others' errors — each mistake has a concrete fix",
        key_points=[
            "Stopping DCA during bear markets (the worst time to stop)",
            "Leaving coins on the exchange instead of withdrawing to own wallet",
            "Checking the price obsessively — defeats the purpose of DCA",
            "Not choosing the right frequency for their income cycle",
            "Paying high fees by using the wrong exchange or wrong order type",
            "btc-dca.com handles most of these automatically",
        ],
        cta_target="Registration — automated DCA eliminates human error",
    ),
    ContentPlan(
        slug="bitcoin-dca-explained-parents",
        title_hint="How I Explain Bitcoin DCA to My Parents (And You Can Too)",
        pillar="basics",
        funnel_stage="awareness",
        seo_keyword="explain bitcoin dca simple",
        tags=["Bitcoin", "DCA", "Education"],
        angle="Relatable story format — demystify Bitcoin for skeptical older generation",
        key_points=[
            "The savings account analogy: 'like automatic transfers, but into Bitcoin'",
            "Address common fears: 'isn't it a scam?', 'isn't it too volatile?', 'isn't it too late?'",
            "Show real 10-year chart with DCA entry points — every year was a good year to start",
            "Security: hardware wallets, 2FA, exchange whitelisting — safer than they think",
            "Point to btc-dca.com as the 'set it and forget it' tool that does everything",
        ],
        cta_target="Homepage — show the simplicity of the platform",
    ),

    # === PILLAR 2: Strategy & Optimization ===
    ContentPlan(
        slug="dca-frequency-daily-weekly-monthly",
        title_hint="Daily vs Weekly vs Monthly Bitcoin DCA: What the Data Says",
        pillar="strategy",
        funnel_stage="consideration",
        seo_keyword="bitcoin dca frequency",
        tags=["Bitcoin", "DCA", "Strategy"],
        angle="Hard data comparison of DCA frequencies — practical recommendation",
        key_points=[
            "Backtest results: daily, weekly, biweekly, monthly over 5-year periods",
            "Spoiler: the difference is smaller than most think (<3% over 5 years)",
            "Fee impact: daily on high-fee exchange destroys returns",
            "Psychological benefit: weekly feels more engaged, monthly is more hands-off",
            "btc-dca.com supports all frequencies — even hourly or every few minutes",
        ],
        cta_target="Registration — try different frequencies and see which feels right",
    ),
    ContentPlan(
        slug="dca-bear-market-strategy",
        title_hint="Why Bear Markets Are the Best Time for Bitcoin DCA",
        pillar="strategy",
        funnel_stage="consideration",
        seo_keyword="bitcoin dca bear market",
        tags=["Bitcoin", "Bear Market", "DCA"],
        angle="Counter-intuitive truth backed by data — bear markets = DCA gold mines",
        key_points=[
            "Math: buying at low prices means more satoshis per dollar",
            "Historical: DCA started in 2018 bear market outperformed 2021 bull market start",
            "Everyone knows 'buy low' but DCA is the only strategy that actually does it systematically",
            "Emotional reality: it feels terrible but the data is unambiguous",
            "70:30 hybrid: keep tactical reserve for extra buys during deep dips",
            "btc-dca.com keeps buying for you even when you're too scared to look at the price",
        ],
        cta_target="Registration — let the bot buy the dips for you",
    ),
    ContentPlan(
        slug="dca-halving-cycle-strategy",
        title_hint="How Bitcoin's 4-Year Halving Cycle Should Shape Your DCA Strategy",
        pillar="strategy",
        funnel_stage="consideration",
        seo_keyword="bitcoin halving dca strategy",
        tags=["Bitcoin", "Halving", "DCA"],
        angle="Cycle-aware DCA — increase/decrease amounts based on where we are in the cycle",
        key_points=[
            "Explain the halving: supply cut → historical price impact",
            "Show 3 completed cycles with DCA returns during each phase",
            "Strategy: increase DCA during accumulation phase (12-18 months post-bear)",
            "Strategy: maintain baseline DCA during euphoria, resist urge to go all-in",
            "btc-dca.com calculator uses halving-adjusted return model — not flat CAGR",
            "Each cycle's peak multiple decreases but still outperforms traditional assets",
        ],
        cta_target="DCA calculator — uses cycle-aware projections unique to btc-dca.com",
    ),
    ContentPlan(
        slug="dca-exit-strategy",
        title_hint="Bitcoin DCA Exit Strategy: When and How to Take Profits",
        pillar="strategy",
        funnel_stage="consideration",
        seo_keyword="bitcoin dca exit strategy",
        tags=["Bitcoin", "DCA", "Profit Taking"],
        angle="The part nobody talks about — DCA entry is easy, exit is where money is made or lost",
        key_points=[
            "The eternal HODL myth: some profit-taking is rational, not betrayal",
            "Systematic exit: reverse DCA — sell fixed amounts on the way up",
            "Percentage-based: sell 10% at each 2x from cost basis",
            "Lifecycle-based: adjust strategy as you approach financial goals",
            "Never sell it all — keep a core position, DCA out the profits only",
            "btc-dca.com goal tracking helps you know when you've hit your target",
        ],
        cta_target="Registration — set up goal-based tracking for your DCA plan",
    ),
    ContentPlan(
        slug="70-30-hybrid-dca",
        title_hint="The 70:30 Bitcoin DCA Hybrid: Consistent Buying + Tactical Dip Reserve",
        pillar="strategy",
        funnel_stage="consideration",
        seo_keyword="bitcoin dca hybrid strategy",
        tags=["Bitcoin", "DCA", "Advanced Strategy"],
        angle="A popular advanced twist on pure DCA — for people who want a bit more control",
        key_points=[
            "70% goes to regular automated DCA (set and forget)",
            "30% held as tactical reserve for buying heavy dips (>20% drops)",
            "Backtest: hybrid outperforms pure DCA by 15-25% over a full cycle",
            "Rules: define 'dip' precisely — avoid subjective calls (use % thresholds)",
            "Psychology: having a reserve reduces anxiety during crashes",
            "btc-dca.com makes the 70% fully automatic — you only handle the 30% manually",
        ],
        cta_target="Registration — automate the 70% and manage the 30% yourself",
    ),

    # === PILLAR 3: Historical Data & Proof ===
    ContentPlan(
        slug="10-years-bitcoin-dca-results",
        title_hint="$100/Month Into Bitcoin for 10 Years: The Actual Results",
        pillar="data",
        funnel_stage="consideration",
        seo_keyword="bitcoin dca 10 year results",
        tags=["Bitcoin", "DCA", "Returns"],
        angle="Concrete, verifiable numbers — this is the article that converts skeptics",
        key_points=[
            "Total invested: $12,000 over 10 years",
            "Portfolio value at different end dates — show range, not just cherry-picked peak",
            "Compare with: savings account, S&P 500, gold, real estate over same period",
            "Maximum drawdown during the journey — how bad did it get?",
            "Key insight: even starting at the 2017 peak, DCA recovered and profited",
            "btc-dca.com calculator lets you run your own what-if scenarios",
        ],
        cta_target="DCA calculator — plug in your own amount and timeframe",
    ),
    ContentPlan(
        slug="worst-time-start-dca-still-profit",
        title_hint="I Started Bitcoin DCA at the Worst Possible Time. Here's What Happened.",
        pillar="data",
        funnel_stage="consideration",
        seo_keyword="bitcoin dca worst time to start",
        tags=["Bitcoin", "DCA", "Case Study"],
        angle="Narrative-driven case study — start at each historical ATH and show DCA outcome",
        key_points=[
            "Case 1: Started DCA at $20K peak (Dec 2017) — profited by 2020",
            "Case 2: Started DCA at $69K peak (Nov 2021) — current status",
            "Case 3: Started DCA at $109K peak (Jan 2025) — current status",
            "The power: 'worst timing' still works because DCA buys the crash too",
            "Contrast with lump-sum at each ATH — DCA recovers faster every time",
            "Use btc-dca.com calculator to simulate any starting point",
        ],
        cta_target="DCA calculator — try your own 'worst case' scenario",
    ),
    ContentPlan(
        slug="bitcoin-dca-vs-gold-sp500",
        title_hint="Bitcoin DCA vs Gold vs S&P 500: A 5-Year Head-to-Head Comparison",
        pillar="data",
        funnel_stage="consideration",
        seo_keyword="bitcoin dca vs gold vs sp500",
        tags=["Bitcoin", "Gold", "Investment"],
        angle="Fair apples-to-apples DCA comparison across asset classes",
        key_points=[
            "Same monthly amount, same timeframe, all three assets — DCA into each",
            "Bitcoin volatility is a feature for DCA, not a bug (buys more when cheap)",
            "Gold: stable but low returns, minimal DCA benefit",
            "S&P 500: solid but not spectacular — the 'safe' benchmark",
            "Risk-adjusted returns: Sharpe ratio comparison",
            "btc-dca.com learn center has a detailed Bitcoin vs Gold analysis",
        ],
        cta_target="DCA calculator — compare your potential returns",
    ),
    ContentPlan(
        slug="what-6712-percent-return-looks-like",
        title_hint="What a 6,712% Return Looks Like: 12 Years of Bitcoin DCA Broken Down",
        pillar="data",
        funnel_stage="awareness",
        seo_keyword="bitcoin dca historical returns",
        tags=["Bitcoin", "Returns", "DCA"],
        angle="Attention-grabbing headline backed by real data — $100/month from 2014 to 2026",
        key_points=[
            "$14,600 invested → ~$995K portfolio — but show the year-by-year journey",
            "Year 1-2: underwater, frustrating, boring — most people quit here",
            "Year 3-4: first cycle pays off — see real gains for the first time",
            "Year 5-8: compounding kicks in — the curve goes exponential",
            "Each halving cycle multiplier and how it compounds DCA returns",
            "Past returns don't guarantee future — but the structural thesis remains",
        ],
        cta_target="DCA calculator — model your own 5-year projection with cycle-aware estimates",
    ),

    # === PILLAR 4: Practical How-To ===
    ContentPlan(
        slug="setup-automated-bitcoin-dca",
        title_hint="How to Set Up Fully Automated Bitcoin DCA in 15 Minutes",
        pillar="howto",
        funnel_stage="conversion",
        seo_keyword="automate bitcoin dca",
        tags=["Bitcoin", "Automation", "DCA"],
        angle="Step-by-step tutorial that ends with a working automated DCA setup",
        key_points=[
            "Step 1: Choose exchange (Binance, Coinmate, OKX — pros/cons of each)",
            "Step 2: Register on btc-dca.com (free account)",
            "Step 3: Generate API key on exchange with IP whitelisting",
            "Step 4: Connect exchange to btc-dca.com",
            "Step 5: Set DCA amount, frequency, and withdrawal rules",
            "Step 6: Set up automatic withdrawal to your hardware wallet",
            "Total time: ~15 minutes, then it runs forever",
        ],
        cta_target="Registration — direct link to sign up and connect exchange",
    ),
    ContentPlan(
        slug="choose-exchange-for-dca",
        title_hint="Best Exchanges for Bitcoin DCA in 2026: Fees, Features, and Security Compared",
        pillar="howto",
        funnel_stage="conversion",
        seo_keyword="best exchange bitcoin dca",
        tags=["Bitcoin", "Exchange", "DCA"],
        angle="Honest comparison focused on DCA-specific needs (low fees, API, auto-buy)",
        key_points=[
            "What matters for DCA: recurring buy fees, withdrawal fees, API support, fiat on-ramp",
            "Binance: lowest fees, best liquidity, full API — but regulatory concerns in some regions",
            "Coinmate: EU-friendly, CZK/EUR support, solid for European DCA investors",
            "OKX: good API, competitive fees, newer integration",
            "What btc-dca.com adds: auto-invest even on exchanges that don't natively support it",
            "Security checklist: IP whitelisting, withdrawal address whitelist, 2FA",
        ],
        cta_target="Registration — btc-dca.com works with all three exchanges",
    ),
    ContentPlan(
        slug="secure-your-bitcoin-dca",
        title_hint="How to Secure Your Bitcoin DCA: Wallets, 2FA, and Cold Storage Explained",
        pillar="howto",
        funnel_stage="conversion",
        seo_keyword="secure bitcoin dca wallet",
        tags=["Bitcoin", "Security", "Wallet"],
        angle="Security is the #1 concern for new investors — address it head-on",
        key_points=[
            "Rule #1: Don't leave Bitcoin on the exchange long-term",
            "Hardware wallets (Trezor, Ledger) — what they are and why they matter",
            "btc-dca.com automated withdrawals: auto-sends to your wallet when balance hits threshold",
            "API key security: IP whitelisting, read-only vs trade permissions",
            "2FA on everything: exchange, btc-dca.com, email",
            "Withdrawal address whitelisting on exchange — prevents theft even if API is compromised",
        ],
        cta_target="Registration — automated withdrawals to cold storage",
    ),
    ContentPlan(
        slug="bitcoin-dca-tax-guide",
        title_hint="Bitcoin DCA and Taxes: What You Need to Know Before Tax Season",
        pillar="howto",
        funnel_stage="consideration",
        seo_keyword="bitcoin dca taxes",
        tags=["Bitcoin", "Taxes", "DCA"],
        angle="Practical tax overview — not legal advice, but essential knowledge",
        key_points=[
            "Each DCA purchase has its own cost basis — FIFO vs LIFO vs specific identification",
            "Why DCA creates complexity: many small purchases = many tax lots",
            "Long-term vs short-term capital gains threshold",
            "Tools for tracking: portfolio trackers, exchange export, manual spreadsheet",
            "Country-specific notes: US, EU (Czech Republic), UK basics",
            "btc-dca.com tracks each purchase — useful for building your cost basis records",
        ],
        cta_target="Registration — built-in tracking helps with tax reporting",
    ),

    # === PILLAR 5: Psychology & Mindset ===
    ContentPlan(
        slug="dca-removes-emotion",
        title_hint="How Bitcoin DCA Eliminates the Emotional Rollercoaster of Crypto Investing",
        pillar="psychology",
        funnel_stage="awareness",
        seo_keyword="bitcoin dca emotion investing",
        tags=["Bitcoin", "Psychology", "DCA"],
        angle="The emotional case for DCA — speak to feelings, not just numbers",
        key_points=[
            "The buy high, sell low cycle: FOMO → buy at peak → panic → sell at bottom",
            "DCA breaks the cycle: you buy regardless, so there's no decision to agonize over",
            "Study: DCA investors hold 3x longer than lump-sum investors",
            "The 'boring is good' philosophy — wealth is built in silence",
            "Automate completely: btc-dca.com means you don't even need to press a button",
            "Delete the price app — DCA gives you permission to stop watching",
        ],
        cta_target="Registration — fully automated = zero emotional decisions",
    ),
    ContentPlan(
        slug="staying-consistent-through-crash",
        title_hint="How to Stay Consistent With Bitcoin DCA When the Market Crashes 50%",
        pillar="psychology",
        funnel_stage="consideration",
        seo_keyword="bitcoin dca market crash",
        tags=["Bitcoin", "DCA", "Discipline"],
        angle="The hardest part of DCA is not the math — it's the emotions during a crash",
        key_points=[
            "Every Bitcoin investor has lived through a 50%+ crash — it's a feature, not a bug",
            "What it feels like vs what the data says: zoom out to 4-year chart",
            "Practical tips: automate so you can't 'forget' to buy; stop checking portfolio",
            "Historical: every single 50% crash was followed by new ATH within 2-3 years",
            "Reframe: a crash means your DCA is buying Bitcoin at a massive discount",
            "btc-dca.com keeps buying automatically — it doesn't have emotions",
        ],
        cta_target="Registration — the bot doesn't panic, even if you do",
    ),
    ContentPlan(
        slug="fomo-cure-systematic-buying",
        title_hint="The FOMO Cure: Why Systematic Buying Beats Impulsive Trading",
        pillar="psychology",
        funnel_stage="awareness",
        seo_keyword="bitcoin fomo dca",
        tags=["Bitcoin", "FOMO", "DCA"],
        angle="Address the #1 emotional trigger in crypto — FOMO — and show DCA as the antidote",
        key_points=[
            "FOMO is the most expensive emotion in crypto — it makes you buy tops",
            "The psychological trap: 'it's going up, I need to buy NOW before it's too late'",
            "DCA response: you're already buying, every week, no matter what — FOMO neutralized",
            "Data: traders who act on FOMO underperform DCA investors by 40-60%",
            "Practical: unsubscribe from 'price alert' notifications, delete trading apps",
            "btc-dca.com is the anti-FOMO machine — your plan executes regardless of headlines",
        ],
        cta_target="Registration — set up your anti-FOMO system",
    ),
    ContentPlan(
        slug="why-traders-lose-dca-wins",
        title_hint="Why 90% of Crypto Traders Lose Money (And Why DCA Investors Don't)",
        pillar="psychology",
        funnel_stage="awareness",
        seo_keyword="crypto traders lose money dca",
        tags=["Bitcoin", "Trading", "DCA"],
        angle="Controversial but honest — trading vs DCA with data to back it up",
        key_points=[
            "Statistic: 80-90% of retail traders lose money in crypto",
            "Why: fees, slippage, emotional decisions, overtrading, leverage",
            "DCA investor profile: buys consistently, ignores noise, holds long-term",
            "Trading requires skill, time, tools, and luck — DCA requires only patience",
            "The opportunity cost: time spent trading could be spent earning income for DCA",
            "btc-dca.com automates the winning strategy so you can focus on your life",
        ],
        cta_target="Registration — stop trading, start automating",
    ),

    # === PILLAR 6: Advanced & Market Context ===
    ContentPlan(
        slug="dca-plus-value-averaging",
        title_hint="Bitcoin DCA + Value Averaging: A Smarter Way to Accumulate BTC",
        pillar="advanced",
        funnel_stage="consideration",
        seo_keyword="bitcoin value averaging dca",
        tags=["Bitcoin", "Value Averaging", "DCA"],
        angle="Advanced strategy for experienced DCA investors who want to optimize further",
        key_points=[
            "Define value averaging: adjust purchase amount based on portfolio value vs target path",
            "Buy more when below target, buy less (or sell) when above target",
            "Backtest: VA outperforms pure DCA by 8-12% but requires more active management",
            "Complexity trade-off: more decisions = more chances for emotional error",
            "Practical implementation with btc-dca.com: adjust DCA amount periodically",
            "Recommendation: start with pure DCA, graduate to VA after 1+ year of consistency",
        ],
        cta_target="Registration — start with automated DCA, optimize later",
    ),
    ContentPlan(
        slug="bitcoin-dca-retirement",
        title_hint="Can Bitcoin DCA Fund Your Retirement? A Realistic Analysis",
        pillar="advanced",
        funnel_stage="consideration",
        seo_keyword="bitcoin dca retirement",
        tags=["Bitcoin", "Retirement", "DCA"],
        angle="Long-term financial planning with Bitcoin — conservative and realistic",
        key_points=[
            "Model: $200/month DCA for 20 years with decreasing cycle returns",
            "Conservative case: 15% CAGR (less than half historical)",
            "Base case: 25% CAGR — still significant vs traditional retirement accounts",
            "Portfolio allocation: Bitcoin DCA as 10-30% of total retirement strategy",
            "btc-dca.com goal tracking: set your retirement target and track progress",
            "The key: start early, be consistent, don't try to get rich quick",
        ],
        cta_target="DCA calculator — model your own retirement scenario",
    ),
    ContentPlan(
        slug="bitcoin-supply-demand-dca",
        title_hint="Why Bitcoin's Fixed Supply Makes DCA the Optimal Accumulation Strategy",
        pillar="advanced",
        funnel_stage="awareness",
        seo_keyword="bitcoin fixed supply dca",
        tags=["Bitcoin", "Supply", "DCA"],
        angle="Tie Bitcoin's unique monetary properties to why DCA is structurally superior",
        key_points=[
            "21 million cap — no other asset has a mathematically guaranteed supply limit",
            "Halvings reduce new supply every 4 years — increasing scarcity over time",
            "DCA + decreasing supply = you're accumulating a shrinking resource systematically",
            "Stock-to-flow model explained simply — what it means for long-term DCA",
            "Contrast with fiat: your cash loses 3-5% per year, Bitcoin's supply shrinks",
            "btc-dca.com's cycle-aware calculator factors in diminishing supply dynamics",
        ],
        cta_target="DCA calculator — see how supply dynamics affect projected returns",
    ),
    ContentPlan(
        slug="dca-multiple-goals",
        title_hint="One Bitcoin DCA Plan Is Not Enough: How to Set Up Multiple Investment Goals",
        pillar="advanced",
        funnel_stage="conversion",
        seo_keyword="bitcoin dca multiple goals",
        tags=["Bitcoin", "Goals", "DCA"],
        angle="Showcase btc-dca.com's unique multi-goal feature — differentiate from competitors",
        key_points=[
            "Why one DCA plan isn't optimal: different goals have different timelines",
            "Example: emergency fund (2-year horizon) vs retirement (20-year horizon)",
            "Example: house down payment (5 years) vs children's education (15 years)",
            "Different strategies per goal: conservative vs aggressive DCA amounts",
            "btc-dca.com unique feature: separate tracking and strategies per life goal",
            "How to set it up: step-by-step guide with screenshots/examples",
        ],
        cta_target="Registration — the only DCA tool with per-goal tracking",
    ),
    ContentPlan(
        slug="bitcoin-dca-2026-still-worth-it",
        title_hint="Is Bitcoin DCA Still Worth It in 2026? Here's What the Data Says",
        pillar="advanced",
        funnel_stage="awareness",
        seo_keyword="bitcoin dca 2026 worth it",
        tags=["Bitcoin", "DCA", "2026"],
        angle="Address the 'isn't it too late?' objection — the #1 reason people don't start",
        key_points=[
            "Every year someone says 'it's too late' — every year they're wrong",
            "Current cycle position: post-halving, historically the best phase for DCA",
            "Diminishing returns are real but 'diminished' crypto returns still beat traditional assets",
            "Institutional adoption (ETFs, corporate treasuries) is still early innings",
            "The question isn't 'is it too late for 100x' but 'will it outperform my savings account?'",
            "btc-dca.com calculator models realistic, cycle-adjusted projections (not moonboy predictions)",
        ],
        cta_target="DCA calculator — get a realistic (not hype-driven) projection",
    ),
    ContentPlan(
        slug="bitcoin-dca-vs-etf",
        title_hint="Bitcoin DCA: Direct Buying vs Bitcoin ETF — Which Is Better for You?",
        pillar="advanced",
        funnel_stage="consideration",
        seo_keyword="bitcoin dca vs etf",
        tags=["Bitcoin", "ETF", "DCA"],
        angle="Timely comparison — many new investors wonder about ETFs vs direct ownership",
        key_points=[
            "ETF pros: simplicity, tax-advantaged accounts, no custody headaches",
            "ETF cons: you don't own actual Bitcoin, management fees eat returns, market hours only",
            "Direct DCA pros: true ownership, 24/7 markets, withdraw to own wallet, no custodial risk",
            "Direct DCA cons: requires exchange account, security responsibility, self-custody learning curve",
            "Philosophy: 'not your keys, not your coins' — why real ownership matters",
            "btc-dca.com gives you the convenience of ETF-like automation with true Bitcoin ownership",
        ],
        cta_target="Registration — ETF simplicity with real Bitcoin ownership",
    ),
]


def get_plan() -> list[ContentPlan]:
    return CONTENT_PLAN


def get_available(used_slugs: set[str]) -> list[ContentPlan]:
    return [p for p in CONTENT_PLAN if p.slug not in used_slugs]


def get_by_slug(slug: str) -> ContentPlan | None:
    for p in CONTENT_PLAN:
        if p.slug == slug:
            return p
    return None
