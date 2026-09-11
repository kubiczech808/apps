# BTC leveraged momentum bot

Selective BTC trend following on [LN Markets](https://lnmarkets.com) futures,
with a dashboard at **https://www.btc-dca.com/bot/**. The selected portfolio is
`momentum-breakout-v1`; rejected price-action strategies remain available only
as reproducible research modules.

Two invariants come before return:

1. **Every position carries an exchange-side stop loss and take profit.** A
   missed timer or offline runner therefore cannot leave an unprotected trade.
2. **The stop determines size and leverage.** The bot first places the
   volatility-based stop, sizes the position to a fixed account risk, and only
   then chooses leverage. Leverage reduces locked margin; it does not authorize
   extra loss.

The selected configuration remains in **paper** mode. Moving it to mainnet is a
separate operator decision and is additionally refused while the dashboard key
is public.

## Selected strategy

- **Direction:** long-only. BTC must close above its 100-day moving average.
- **Entry:** a fresh daily close above the highest high of the previous 20 days.
- **Initial stop:** one 20-day daily ATR below the actual entry price.
- **Size:** the exact inverse-contract quantity whose stop loss risks at most
  2% of current equity in sats, capped at 300% notional.
- **Leverage:** derived after the stop, capped at 10x. Liquidation must remain at
  least twice the stop distance away from entry.
- **Exit:** the stop can only move upward, following the 10-day low. A distant
  take profit is retained as a mandatory emergency bracket, not as the normal
  profit-taking rule.
- **Concurrency:** one position and at most one new trade per day.

Positions opened before the `2026-09-11` strategy cutover retain the manager
that was active when they entered. New positions are tagged with the selected
strategy id.

## Backtest evidence

Five years of Binance hourly candles were replayed through the production
backtester with 5,410 real LN Markets funding settlements. Results are measured
in sats and include the configured 0.06% fee on entry and exit:

```
risk   trades   total return   return p.a.   hourly max DD   PF
 2%      30        40.9%          7.1%          15.6%      2.00   selected
 3%      30        62.5%         10.2%          22.5%      1.93   rejected: DD
```

The selected 2% variant returned 11.5% p.a. over the most recent three years,
with 15.6% drawdown. Median hold was 12.7 days and the 90th percentile 40.3
days. With the current LN Markets tier-1 fee of 0.1% per side used as a stress
case, it returned 6.8% p.a. with 16.0% drawdown. The 3% variant was rejected:
its full hourly mark-to-market drawdown was 22.5%, despite looking like 15.2%
when drawdown was measured only between closed trades.

Funding is not optional bookkeeping. Across the measured history its mean was
0.0130% per eight-hour settlement, positive 94% of the time. The paper executor
therefore loads real settlements, persists the last charged timestamp and
refuses a futures pass when funding history is unavailable.

## How it runs

```
Raspberry Pi   systemd timer, every 60s   ─┐
                                           ├─→ api.php on btc-dca.com ─→ dashboard
GitHub Actions  cron, every 15 min ────────┘        (state, lease, settings)
```

Both runners execute the same `tools/run-bot.mjs`. The hosting hands out a
**lease**, so only one of them acts at a time; the fallback finds the Pi holding
it and does nothing. If the Pi stops, the lease expires and Actions takes over
within a quarter of an hour.

A pass does, in this order: take the lease → read the market → read the account
→ carry out any operator command from the dashboard → restore missing brackets →
manage the open position → consider one new entry. It is idempotent, so running
it more often is safe and skipping one costs nothing.

## A note on the API version

This targets LN Markets **v3**, and that is not a preference. v2 was deprecated
in January 2026, and the package most search results point at
(`@ln-markets/api`, last published for v2) still names
`api.testnet.lnmarkets.com` — a host that no longer resolves. The first deploy
of this bot failed on exactly that, `ENOTFOUND`, which is why the deploy
workflow checks reachability before it uploads anything.

The current contract is taken from `@ln-markets/sdk`. Three things differ from
v2 and will bite anyone porting older code:

- the test network is **testnet4** (`api.testnet4.lnmarkets.com`);
- the signature payload lowercases the HTTP method, and the query string is
  signed **with** its leading `?`;
- sides are `buy`/`sell` and order types `market`/`limit`, not `b`/`s`
  and `m`/`l`.

In exchange, v3 serves `futures/candles` — so the chart is read from the same
venue the position is opened on, rather than from a spot exchange whose price
can drift from the LN Markets index.

## Setting it up

### GitHub secrets (repository `kubiczech808/apps`)

> **This repository is public.** The LN Markets credentials must never be
> committed to it. The dashboard key currently *is* committed — deliberately,
> for convenience, and the bot refuses to trade live because of it. See **The
> dashboard key** below.

| Secret | What it is |
|---|---|
| `BTCDCA_FTP_LOGIN` | already present — btc-dca.com FTP |
| `BTCDCA_FTP_PASSWORD` | already present |
| `LNM_API_KEY` | LN Markets API key. Not needed in paper mode. |
| `LNM_API_SECRET` | " |
| `LNM_API_PASSPHRASE` | " |
| `BTC_BOT_KEY` | Overrides the committed dashboard key — **required before mainnet**. |

Create the LN Markets key at **lnmarkets.com → Settings → API** with permission
to read the account and to create and close positions. There is no test network
to practise on — see the note on the API version above.

Optional repository *variables*: `LNM_API_NETWORK` (`mainnet`; the bot's own
mode setting decides whether it trades), `BTC_BOT_URL`, `BTCDCA_FTP_HOSTS`.

### The dashboard key

The key is **`ahoj1234567890`**, committed in `btcbot-deploy.yml`. You do not
have to add anything to use the dashboard.

It is in a public repository, so treat it as known to everyone — because it is.
That is a reasonable guard for a paper portfolio, where the worst an outsider
can do is pause a simulation. It is not a guard for an account, so the lock is
enforced rather than written down:

- `src/keys.mjs` makes the runner refuse `mainnet` while this key is in use; it
  falls back to paper and records the reason on the published state.
- `api.php` refuses to save `mode: mainnet` for the same reason, so the
  dashboard says why instead of appearing to accept the change.
- The dashboard greys the mainnet option out and explains the lock.

**To trade real money, set a `BTC_BOT_KEY` secret** on the repository and deploy
again. It overrides the committed default, and the lock lifts on its own once
the key is no longer a published one — nothing else to remember.

If you would rather not manage a secret at all, deleting the `committed = ...`
line from both workflows falls back to deriving the key from
`BTCDCA_FTP_PASSWORD`:

```bash
printf 'btc-dca-bot dashboard key v1' \
  | openssl dgst -sha256 -hmac "YOUR_BTCDCA_FTP_PASSWORD" -binary \
  | base64 | tr '+/' '-_' | tr -d '='
```

The deploy log prints a 12-character fingerprint of whichever key it used.

### Deploy

Pushing anything under `btc-bot/` runs `btcbot-deploy.yml`, which will not upload
until the unit tests pass, `api.php` lints, and LN Markets accepts the
credentials. After uploading it checks the live endpoint refuses an
unauthenticated read, then runs one pass so the dashboard has something to show.

Runtime changes also trigger `btcbot-rpi-deploy.yml` on the Pi's self-hosted
runner. It preserves the env file and paper state, replaces only the versioned
runtime and systemd units, then requires a successful pass with the selected
strategy before the workflow can pass.

> Scheduled workflows only run from the repository's **default branch**. Until
> this branch is merged there, `btcbot-run.yml` and the weekly backtest can be
> started by hand from the Actions tab but will not fire on their own.

### Raspberry Pi

```bash
sudo install -d -o openclaw2 -g openclaw2 /home/openclaw2/.local/lib/btc-bot
rsync -a --delete btc-bot/src btc-bot/tools btc-bot/package.json \
  openclaw2@pi5:/home/openclaw2/.local/lib/btc-bot/
install -m 600 systemd/btc-bot.env.example /home/openclaw2/.config/btc-bot.env
# fill in BOT_API_KEY and the three LNM_* values, then:
systemctl --user enable --now btc-bot.timer
```

## Using the dashboard

`https://www.btc-dca.com/bot/` asks for the dashboard key once and keeps it in
that browser. Nothing is readable without it — the state names the balance and
the open positions. See **The dashboard key** above for how to work out what
yours is.

It shows equity, open risk, realised and unrealised P/L, the four tables (open
positions, resting orders, closed trades, run log) and the settings. The buttons
queue a command that the next pass carries out; the page never talks to LN
Markets itself.

Switching **Režim** to `mainnet` is the only step that spends real money, and it
asks twice.

## Working on it

```bash
cd btc-bot
npm test                      # no network needed
node tools/backtest.mjs --limit 1000
node tools/run-bot.mjs        # honours BOT_* and LNM_* from the environment
BOT_DRY_RUN=true node tools/run-bot.mjs   # decides, reports, sends nothing
```

The layers are separate on purpose and depend in one direction:

| File | Answers |
|---|---|
| `src/candles.mjs` | normalized hourly market history and higher-timeframe aggregation |
| `src/strategy-registry.mjs` | selected strategy and the legacy manager used across cutover |
| `src/strategy-momentum.mjs` | fresh breakout entry, ATR stop and trailing exit |
| `src/strategy.mjs` | archived price-action strategy and legacy position management |
| `src/risk.mjs` | exact inverse-contract sizing and stop-derived leverage |
| `src/executor-lnm.mjs` | send it to LN Markets — and never unbracketed |
| `src/executor-paper.mjs` | the same interface, simulated |
| `src/bot.mjs` | one pass, in order, with the portfolio gates |
| `src/backtest.mjs` | walk it forward over history without peeking |
| `api.php` | state, lease, settings, command queue |

Strategy modules and `src/risk.mjs` are pure functions. Selection and migration
live in `src/strategy-registry.mjs` and `src/state.mjs`; changing any of those
contracts should make a test fail.
