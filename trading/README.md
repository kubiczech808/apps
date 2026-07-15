# Polymarket Trading PoC

This PoC keeps public market discovery separate from private order execution.

## Public UI

`index.html` and `api.php` only read public Polymarket market data. They never receive a private key and never submit live orders.

## Paper trading workflow

The public UI has an autonomous paper-trading desk with a default 100 USDC portfolio and a hard 5% max allocation per idea.

The browser only reads the published `data/paper-state.json`. Analysis, optional AI calls, post-mortems, and optimization all run server-side in GitHub Actions so model keys stay out of browser code.

## Autonomous paper bot

`.github/workflows/trading-paper-bot.yml` writes `trading/data/paper-state.json` to the public `/trading/data/` directory.

It runs in two modes:

- full analysis every hour at minute 7,
- refresh-only checks at minutes 22, 37, and 52 to update open positions, resolved markets, post-mortems, and portfolio P/L without opening a new trade or rescanning candidates.

The bot:

- evaluates public Polymarket markets and CLOB orderbooks in the background,
- records every evaluated candidate with price, spread, liquidity, estimated probability, expected value, annualized expected return, rejection reasons, a YES/NO/OUTCOME thesis, and an analysis summary,
- simulates market BUY execution through available ask levels for the full 5 USDC stake; expected value uses the average executable price including slippage, not the midpoint,
- subtracts Polymarket taker fees when the market has `feesEnabled` and a `feeSchedule.rate`; the simulated fee is calculated per fill as `shares * feeRate * price * (1 - price)` and rounded to 5 decimals,
- treats 95%+ probability candidates as high-confidence entries,
- can also mark lower-probability `EDGE_OPPORTUNITY` candidates as eligible when probability, edge, and annualized EV clear stricter opportunity thresholds,
- rejects candidates with annualized expected return below 5%,
- places a 5 USDC simulated stake per idea from a 100 USDC paper portfolio; max paper loss includes any taker fee,
- opens at most one paper trade per Prague calendar day,
- skips new entries when available paper capital is exhausted, the same token already has an open paper position, or an open position shares the same event/team risk group,
- refreshes existing paper positions on every run; open positions are marked to current best bid, while closed/resolved markets are moved to `WON`/`LOST` with realized P/L and P/L percent.

## Optimization loop

The bot now writes a `learningProfile` into `paper-state.json`.

1. Initial analysis creates a thesis for each candidate, stores raw probability, calibrated probability, confidence tier, applied learning adjustments, expected value, and whether the candidate is `HIGH_CONFIDENCE` or `EDGE_OPPORTUNITY`.
2. After a paper trade resolves, the bot creates a post-mortem that compares the initial thesis and probability against the actual `WON`/`LOST` result.
3. Resolved trades update calibration buckets, Brier score, global bias, and factor-level adjustments for tags, price buckets, liquidity, spread, horizon, and outcome type.
4. The next initial analysis applies those calibration adjustments before computing edge and eligibility.
5. If `OPENAI_API_KEY` is available in GitHub Secrets, the bot asks the configured model for initial candidate review and post-mortem JSON. Without the key, it uses deterministic fallback analysis and keeps running.

This is not live trading. It does not use the Polymarket private key and cannot submit orders.

## Local executor

Install dependencies inside `trading/`:

```powershell
npm install
```

Create a local `.env.local` or provide environment variables matching `.env.example`.

Dry-run signed order:

```powershell
npm run order:poc -- --token-id TOKEN_ID --side BUY --price 0.50 --size 10 --tick-size 0.01
```

Live submit requires both:

```powershell
$env:POLYMARKET_DRY_RUN = "false"
npm run order:poc -- --token-id TOKEN_ID --side BUY --price 0.50 --size 10 --tick-size 0.01 --confirm-live
```

Do not paste private keys into chat, GitHub issues, or committed files.

## Required GitHub Secrets for API trading smoke test

Create these repository secrets before running `Polymarket Order Smoke`:

- `POLYMARKET_PRIVATE_KEY`: private key for a dedicated trading/session wallet, never a main wallet.

The current Google/Magic proxy account uses these non-secret workflow defaults:

- Funder address: `0x3252de913d9323667f21f4d88fa1f996fc282293`
- Signature type: `1` (`POLY_PROXY`)
- Dry-run bankroll: `100`
- Max order fraction: `0.05`

Optional only if we later choose not to derive L2 credentials from the private key:

- `POLYMARKET_API_KEY`
- `POLYMARKET_API_SECRET`
- `POLYMARKET_API_PASSPHRASE`

The private key is still required for order creation because Polymarket orders are signed EIP-712 messages.

## First live API proof

Use a dedicated wallet with a small balance, for example 5-20 USDC.

1. Run `Polymarket Order Smoke` with `live_confirm=false`.
2. Confirm it returns `signed-dry-run`.
3. Run a tiny order with `live_confirm=true`, conservative price, and size small enough to stay below `MAX_ORDER_FRACTION`.
4. Verify the order appears in Polymarket and can be cancelled.
