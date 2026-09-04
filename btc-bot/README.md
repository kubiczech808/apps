# BTC price-action bot

Swing trading on [LN Markets](https://lnmarkets.com) futures, decided by reading
the chart rather than by an indicator crossover, with a dashboard at
**https://www.btc-dca.com/bot/**.

Two things are true of this bot and are worth stating before anything else:

1. **Every position carries a stop loss and a take profit held by LN Markets.**
   Not by this process. That is what makes it safe to run on a timer, to miss a
   run, or to lose the Raspberry Pi to a network outage — the account is
   protected by the exchange, not by the bot being awake.
2. **The strategy has not been proven to have an edge.** The previous
   price-action engine in the `openclaw` repository was measured across three
   exchanges and four windows and lost money in every one of them; its own
   source says so. This one is a different, narrower design, but it starts on
   **testnet** and stays there until a backtest and a run of paper results say
   otherwise. `.github/workflows/btcbot-backtest.yml` is how that gets answered.

## What it trades

One idea, applied in one direction at a time:

- **Trend** comes from the 4h chart: higher highs with higher lows, or lower
  highs with lower lows. A range is not traded at all.
- **Location** comes from a zone the market has already turned at — a cluster of
  swing lows for a long, swing highs for a short. Price must be at or inside it.
- **Trigger** is a closed 1h candle that rejects the zone: an engulfing bar or a
  long-wicked rejection, big enough relative to ATR to mean something.
- **Stop** goes half an ATR beyond the zone. **Target** is the next place the
  market has already reacted, clamped between 2R and 5R.
- **Size** is whatever risks exactly 1% of account equity if the stop is hit.
  Leverage is derived from the stop distance so that liquidation sits well
  beyond it — it is never a setting that multiplies risk.

Reward/risk is measured **in sats, not in price distance**. On an inverse
contract those differ by several percent: a "2R" target read off the chart is
worth about 1.91R in the account for a long. Gating on the chart ratio silently
takes trades that do not meet the rule.

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

## Setting it up

### GitHub secrets (repository `kubiczech808/apps`)

| Secret | What it is |
|---|---|
| `LNM_API_KEY` | LN Markets API key |
| `LNM_API_SECRET` | LN Markets API secret |
| `LNM_API_PASSPHRASE` | LN Markets API passphrase |
| `BTC_BOT_KEY` | A long random string you invent. Both runners and the dashboard authenticate with it. |
| `BTCDCA_FTP_LOGIN` | already present — btc-dca.com FTP |
| `BTCDCA_FTP_PASSWORD` | already present |

Create the LN Markets key at **testnet.lnmarkets.com → Settings → API**, with
permission to read the account and to create and close positions. Generate the
bot key with something like `openssl rand -base64 32`.

Optional repository *variables*: `LNM_API_NETWORK` (`testnet` by default),
`BTC_BOT_URL`, `BTCDCA_FTP_HOSTS`.

### Deploy

Pushing anything under `btc-bot/` runs `btcbot-deploy.yml`, which will not upload
until the unit tests pass, `api.php` lints, and LN Markets accepts the
credentials. After uploading it checks the live endpoint refuses an
unauthenticated read, then runs one pass so the dashboard has something to show.

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

`https://www.btc-dca.com/bot/` asks for `BTC_BOT_KEY` once and keeps it in that
browser. Nothing is readable without it — the state names the balance and the
open positions.

It shows equity, open risk, realised and unrealised P/L, the four tables (open
positions, resting orders, closed trades, run log) and the settings. The buttons
queue a command that the next pass carries out; the page never talks to LN
Markets itself.

Switching **Režim** to `mainnet` is the only step that spends real money, and it
asks twice.

## Working on it

```bash
cd btc-bot
npm test                      # 62 tests, no network needed
node tools/backtest.mjs --limit 1000
node tools/run-bot.mjs        # honours BOT_* and LNM_* from the environment
BOT_DRY_RUN=true node tools/run-bot.mjs   # decides, reports, sends nothing
```

The layers are separate on purpose and depend in one direction:

| File | Answers |
|---|---|
| `src/candles.mjs` | what the chart looks like (three venues, 4h built from 1h) |
| `src/priceaction.mjs` | swings, structure, zones, candle patterns, ATR |
| `src/strategy.mjs` | is this a trade, and where do the stop and target go |
| `src/risk.mjs` | how big, at what leverage, for exactly 1% risk |
| `src/executor-lnm.mjs` | send it to LN Markets — and never unbracketed |
| `src/executor-paper.mjs` | the same interface, simulated |
| `src/bot.mjs` | one pass, in order, with the portfolio gates |
| `src/backtest.mjs` | walk it forward over history without peeking |
| `api.php` | state, lease, settings, command queue |

`src/strategy.mjs` and `src/risk.mjs` are pure functions. If you change what the
bot trades, that is where it lives, and a test should fail.
