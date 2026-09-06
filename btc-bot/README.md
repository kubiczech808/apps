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

608 days of LN Markets' own hourly candles, **spot** (no leverage, no
liquidation, no funding — fees on the buy and the sell only), 1% risk per trade,
one position at a time.

```
Start / end   100496 sats → 84152 sats  (-16.26%)
Trades        271 (85W / 186L), win rate 31.37%
Exits         stop_loss ×169, take_profit ×71, manual ×31
Profit factor 0.86        max drawdown 20.97%
Avg win/loss  1170 sats / 623 sats
Fees          trading 25804 sats
Before fees   +9460 sats (+9.41%) — the edge the fees are charged against
Friction      fees are 14.56% of the risk on the median trade, 37.14% on the
              worst tenth; 64 trades paid more than a quarter of what they risked
```

**The chart reading is not what loses the money. The fee schedule is.**

Before fees this makes +9.4% over 608 days. It pays 25804 sats to earn 9460 —
so it hands back the whole edge and 16% of the account on top. Per trade that
is a gross expectancy of about +0.06R against a fee of 0.15R.

The friction line says why, and no other number in the report showed it: a stop
placed half an ATR beyond a 1h zone is often 0.3–0.8% from entry, while the
round trip costs 0.12% of notional. On such a trade the fee is a fifth to a half
of everything at risk. It has to be right far more often than the same idea
taken on a wider stop, for reasons that have nothing to do with the chart.

Break-even needs a 34.7% win rate at this 1.88 payoff. It gets 31.4%.

### Which component is unreliable

Each row changes exactly one rule from the shipped configuration, same candles:

```
variant                 trades   win%      PF   return%   avgW/avgL    TP   SL  man
shipped                   271   31.4    0.86     -16.3        1.88    71  169   31
no candle trigger         551   28.3    0.75     -47.8        1.89   130  345   76
engulfing trigger only    228   31.6    0.88     -12.4        1.90    62  140   26
rejection trigger only    116   28.4    0.76     -12.4        1.91    28   72   16
stop 1.0 ATR past zone    230   29.6    0.77     -23.1        1.81    50  136   44
stop 1.5 ATR past zone    215   30.7    0.76     -22.6        1.71    43  119   53
fixed 2R target           271   31.4    0.84     -18.0        1.84    71  169   31
must close inside zone    242   29.3    0.74     -24.5        1.79    61  155   26
no trend-flip close       236   29.2    0.83     -18.4        2.01    65  171    0
```

- **The closed-candle trigger is the one rule that clearly earns its place.**
  Removing it doubles the trade count and takes profit factor 0.86 → 0.75.
- **The pin bar is the weak half of it.** Engulfing alone scores 0.88, rejection
  alone 0.76. A wick twice the body is a common accident in a quiet hour; a bar
  that closes through the whole of the previous one is not.
- **A wider stop makes it worse, not better** — 0.77 and 0.76. So the stop is not
  simply "inside the noise". Widening it without widening the target in the same
  proportion just moves the same trades further from a target they already only
  reach 26% of the time.
- **No row reaches 1.0.** The best single change is worth +0.02 profit factor,
  which is noise on 271 trades. There is no one broken rule to fix here.

Read the return column with care throughout: any filter that removes trades
shrinks the loss of a losing system. Only profit factor says whether the trades
that remain are better ones.

### Three ways this measurement lied before it was fixed

All three were caught by comparing two numbers that had to agree, none by
reading the code, and all three looked like results:

- The stop management never moved a stop (it read `position.stop`; every
  position carries `stopLoss`), so 35 trades reached 1R and none were protected.
- The first two sweep implementations were tautologies. A fractal pivot IS the
  extreme of its neighbourhood, so "did it take out the previous candle's low"
  is true for every swing low. The filter on and the filter off returned
  identical numbers to the sat — twice — before the comparison was moved to the
  previous *pivot*.
- The opening fee was charged to the balance but left out of the trade's P/L.
  The equity curve was right and every statistic computed from trades was not:
  the trades summed to -7285 sats while the account fell 20846. Profit factor
  read 0.93 and was really 0.86.

A filter whose presence and absence agree exactly is not a strict filter. A
trade list that does not add up to the equity curve is not a trade list. Both
identities are asserted by tests now.

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
  In spot that is capped by the capital itself, so a tight stop buys a smaller
  position and risks less than 1% rather than borrowing to reach it. On futures
  the leverage is derived from the stop distance so liquidation sits well beyond
  it — it is never a setting that multiplies risk.

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
npm test                      # 96 tests, no network needed
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
