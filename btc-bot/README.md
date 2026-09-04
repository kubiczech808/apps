# BTC price-action bot

Swing trading on [LN Markets](https://lnmarkets.com) futures, decided by reading
the chart rather than by an indicator crossover, with a dashboard at
**https://www.btc-dca.com/bot/**.

Two things are true of this bot and are worth stating before anything else:

1. **Every position carries a stop loss and a take profit held by LN Markets.**
   Not by this process. That is what makes it safe to run on a timer, to miss a
   run, or to lose the Raspberry Pi to a network outage — the account is
   protected by the exchange, not by the bot being awake.
2. **The strategy has been measured, and it loses money.** Not "unproven" —
   measured. See *What the backtest says* below. It runs in **paper** mode and
   must not be pointed at a funded account on this evidence.

## What the backtest says

Eight months of LN Markets' own hourly candles (2025-12-28 → 2026-09-04),
1% risk per trade, one position at a time. Each row changes exactly one rule
from the shipped configuration:

```
variant                 trades   win%      PF   return%   avgW/avgL    TP   SL  man
shipped                   133   22.6    0.61     -37.6        2.08    26   95   12
no breakeven/trail        125   26.4    0.62     -37.3        1.72    29   83   13
no trend-flip close       127   23.6    0.67     -34.1        2.16    29   98    0
neither                   110   29.1    0.74     -27.4        1.80    32   78    0
target fixed at 2R        133   23.3    0.61     -37.1        2.01    27   94   12
require 3R                122   18.9    0.65     -32.9        2.81    16   95   11
```

**Every configuration loses.** The best profit factor is 0.74; break-even is
1.0. This is not a tuning problem — turning individual rules off moves the
result by ten points and never near zero, which is the shape of a system whose
*entries* have no edge rather than one whose exits are misconfigured.

Two things the table does say clearly:

- **Risk control works.** Losses land on the intended 1% of equity, on stops
  between 0.3% and 2.3% away, with position sizes adapting from 52 to 374 USD.
  The machinery is sound; what it is pointed at is not.
- **Stop management works and does not help.** Fixing it (it was reading a
  field name nothing produces, so no stop had ever moved) raised the average
  win-to-loss ratio from 1.72 to 2.08 and left the return unchanged at -37%.
  Better R, fewer winners, same place.

This is the same answer the previous price-action engine in the `openclaw`
repository reached: 26-45% win rate, losing across every exchange and window.
Two independent attempts at "trade the pullback into a zone in the direction of
the higher-timeframe trend" have now measured the same thing.

Before this goes anywhere near a funded account, the entry logic needs a reason
to be expected to work that this one did not have — not a parameter sweep over
these 233 days, which is how the number 0.74 becomes 1.05 on paper and 0.6
again in the market.

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

> **This repository is public.** Nothing secret may be committed to it — not the
> dashboard key, not a config file, not "just for testing". The dashboard key is
> the only thing between the internet and reading the account, changing the risk
> settings, and flipping the bot to mainnet.

| Secret | What it is |
|---|---|
| `BTCDCA_FTP_LOGIN` | already present — btc-dca.com FTP |
| `BTCDCA_FTP_PASSWORD` | already present — also the seed for the dashboard key |
| `LNM_API_KEY` | LN Markets API key. Not needed in paper mode. |
| `LNM_API_SECRET` | " |
| `LNM_API_PASSPHRASE` | " |
| `BTC_BOT_KEY` | **Optional.** Set it to override the derived dashboard key. |

Create the LN Markets key at **lnmarkets.com → Settings → API** with permission
to read the account and to create and close positions. There is no test network
to practise on — see the note on the API version above.

Optional repository *variables*: `LNM_API_NETWORK` (`mainnet`; the bot's own
mode setting decides whether it trades), `BTC_BOT_URL`, `BTCDCA_FTP_HOSTS`.

### The dashboard key

You do not have to create one. If `BTC_BOT_KEY` is not set, the deploy and both
runners derive the same key from `BTCDCA_FTP_PASSWORD`, which the repository
already holds. Nothing new to add, and nothing secret in git.

To find out what it is — you need it to open the dashboard — run this with your
btc-dca.com FTP password:

```bash
printf 'btc-dca-bot dashboard key v1' \
  | openssl dgst -sha256 -hmac "YOUR_BTCDCA_FTP_PASSWORD" -binary \
  | base64 | tr '+/' '-_' | tr -d '='
```

The deploy log prints a 12-character fingerprint of the key it used, so you can
confirm you computed the same one without either of you publishing it.

The catch, stated plainly: **rotating the FTP password changes the dashboard
key.** If you ever do that, recompute it, or set an explicit `BTC_BOT_KEY`
secret — which wins over the derived one — and be done with the coupling.

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
