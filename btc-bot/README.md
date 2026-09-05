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

625 days of LN Markets' own hourly candles, **spot** (no leverage, no
liquidation, no funding — fees on the buy and the sell only), 1% risk per trade,
one position at a time. Each row changes exactly one rule:

```
variant                 trades   win%      PF   return%   avgW/avgL    TP   SL  man
as it lost (no filters)    373   29.0    0.88     -31.9        2.16    94  249   30
sweep only                 272   31.6    0.96     -16.9        2.08    71  170   31   <- shipped
imbalance only             214   30.4    0.86     -20.3        1.98    55  137   22
both                       166   31.9    0.90     -14.0        1.92    43  101   22
both, no trend-flip close  144   29.2    0.86     -15.5        2.08    38  106    0
both, require 3R           162   27.8    0.87     -16.0        2.25    26  114   22
```

**It still loses.** Profit factor 0.96 against the 1.0 that breaks even, about
-9.9% a year. What changed is the size of the hole, and one rule is responsible.

- **The liquidity sweep earns its place.** Profit factor 0.88 → 0.96 and win
  rate 29.0% → 31.6%: each trade got better, not merely rarer. Requiring the
  zone to have reached under the previous swing low — collecting the stops
  resting there — is the single change that moved per-trade quality.
- **The imbalance filter does not.** Alone it lowers profit factor to 0.86, and
  added to the sweep it drags 0.96 down to 0.90. Its smaller headline loss comes
  from taking 40% fewer trades. Less bad is not better, and the column that says
  so is PF, not return%.

Read the return column with that in mind throughout: any filter that removes
trades shrinks the loss of a losing system. Only profit factor says whether the
trades that remain are better ones.

### Two ways this measurement lied before it was fixed

Both were caught by the table, not by reasoning, and both looked like results:

- The stop management never moved a stop (it read `position.stop`; every
  position carries `stopLoss`), so 35 trades reached 1R and none were protected.
- The first two sweep implementations were tautologies. A fractal pivot IS the
  extreme of its neighbourhood, so "did it take out the previous candle's low"
  is true for every swing low. The filter on and the filter off returned
  identical numbers to the sat — twice — before the comparison was moved to the
  previous *pivot*.

A filter whose presence and absence agree exactly is not a strict filter. It is
a filter that does nothing.

### On the source

These rules follow the supply-and-demand method Jakub pointed at (JeaFx: market
structure, supply and demand, liquidity, imbalance). **The videos were not
watched** — YouTube and jeafx.com are both unreachable from the machine this was
built on — so this is built from the publicly documented rules, not from the
course. Where the implementation is a crude reading of an idea, as the imbalance
test probably is, that is a limitation of this code and not a verdict on the
method.

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
