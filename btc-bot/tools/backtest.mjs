#!/usr/bin/env node
// Backtest the strategy over real candles.
//
//   node tools/backtest.mjs --source bybit --limit 1000
//   node tools/backtest.mjs --file candles.json --risk 1 --min-rr 2
//
// Prints the honest summary; `--json out.json` writes the full report including
// every trade, so a claim about the strategy can be checked rather than trusted.

import { readFile, writeFile } from 'node:fs/promises'
import { fetchCandles, fetchCandlesWithFallback } from '../src/candles.mjs'
import { describeFunding, fetchFundingSettlements } from '../src/funding.mjs'
import { createLnMarketsClient, resolveNetwork } from '../src/lnmarkets.mjs'
import { formatBacktest, runBacktest } from '../src/backtest.mjs'
import * as priceAction from '../src/strategy.mjs'
import * as momentum from '../src/strategy-momentum.mjs'

// A strategy declares how much history it needs to see, because the engine
// slices a trailing window at every step and a window too short for the
// strategy silently produces no signals at all. Momentum reads a 100-day
// average off DAILY candles; the default 2400-hour window is 100 daily candles
// in total, which is fewer than it requires, so it rejected every single bar
// with "not enough daily candles" and reported zero trades as if that were a
// result.
const STRATEGIES = {
  'price-action': {
    module: priceAction,
    timeframes: { htfHours: 4, ltfHours: 1 },
    windowHours: 2400,
    warmupHours: 400,
  },
  // Signals off the daily chart, entry priced at the latest hourly close.
  momentum: {
    module: momentum,
    timeframes: { htfHours: 24, ltfHours: 1 },
    windowHours: 6000, // 250 daily candles
    warmupHours: 3600, // 150 days before the first decision
  },
}


const args = new Map()
for (let index = 2; index < process.argv.length; index += 2) {
  args.set(process.argv[index].replace(/^--/, ''), process.argv[index + 1])
}

const chosen = STRATEGIES[args.get('strategy') ?? 'price-action']
if (!chosen) {
  console.error(`Unknown strategy. Choose one of: ${Object.keys(STRATEGIES).join(', ')}`)
  process.exit(1)
}

const loadCandles = async () => {
  if (args.has('file')) {
    const parsed = JSON.parse(await readFile(args.get('file'), 'utf8'))
    return { source: args.get('file'), candles: Array.isArray(parsed) ? parsed : parsed.candles }
  }
  const limit = Number(args.get('limit') ?? 1000)
  // `futures/candles` needs no credentials, so a backtest reads the same venue
  // the bot trades without being armed to trade.
  const client = createLnMarketsClient({
    network: resolveNetwork(args.get('network') ?? 'mainnet'),
    key: '',
    secret: '',
    passphrase: '',
  })
  if (args.has('source')) {
    return { source: args.get('source'), candles: await fetchCandles({ source: args.get('source'), limit, client }) }
  }
  return fetchCandlesWithFallback({ limit, client })
}

const { source, candles, failures = [] } = await loadCandles()

// Real carry, not an assumed constant. `--no-funding` measures the same
// strategy held for free, which is only useful for showing how much the carry
// was costing.
let fundingSettlements = []
if (!args.has('no-funding')) {
  try {
    const fundingClient = createLnMarketsClient({
      network: resolveNetwork(args.get('network') ?? 'mainnet'),
      key: '',
      secret: '',
      passphrase: '',
    })
    fundingSettlements = await fetchFundingSettlements({
      client: fundingClient,
      hours: Number(args.get('limit') ?? 1000) + 48,
    })
    console.log(`Funding       ${describeFunding(fundingSettlements)}`)
    console.log('')
  } catch (error) {
    console.log(`Funding       could not be fetched (${error.message}); carry will NOT be charged`)
    console.log('')
  }
}

// A silent fallback is worse than a failure. A run that quietly dropped from
// eight months of LN Markets candles to thirty days of Kraken reports a
// different strategy on different data and looks like the same run.
if (failures.length) {
  console.log('Sources that did not answer:')
  for (const failure of failures) console.log(`  ${failure}`)
  console.log('')
}

const overrides = { strategy: {}, risk: {}, timeframes: chosen.timeframes }
if (args.has('risk')) overrides.risk.riskPct = Number(args.get('risk'))
if (args.has('min-rr')) overrides.strategy.minRR = Number(args.get('min-rr'))
if (args.has('max-trades')) overrides.maxTradesPerDay = Number(args.get('max-trades'))
if (args.has('capital')) overrides.startingCapitalUsd = Number(args.get('capital'))

const warmupHours = Number(args.get('warmup') ?? chosen.warmupHours)
const windowHours = chosen.windowHours

// `--compare` is a DIAGNOSIS, not a menu.
//
// Each variant changes exactly one thing from the shipped configuration, so a
// difference can be attributed. Picking whichever row scores best on this
// window is how a 233-day sample becomes an overfitted strategy — the table
// answers "which rule is costing money", and the answer then needs a reason
// before it becomes a change.
// Per strategy, because the rules differ. Each entry changes exactly ONE thing
// from what ships, so a difference can be attributed to it.
const VARIANTS_BY_STRATEGY = {
  // The question now is whether the two quality filters earn their place. The
  // baseline row is the strategy as it lost 37%, so every other row is measured
  // against the thing being fixed rather than against nothing.
  // The filter question is answered and recorded in the README (the sweep earns
  // its place, the imbalance test does not). The open question is WHICH of the
  // remaining price-action components is unreliable enough to leave the system
  // at PF 0.96 — so each row here removes or loosens exactly one of them:
  // the closed-candle trigger, the kind of trigger, the stop's distance from
  // the zone, the target, and how close to the zone price must be.
  'price-action': [
    ['shipped', {}],
    ['no candle trigger', { strategy: { requireTrigger: false } }],
    ['engulfing trigger only', { strategy: { triggerKinds: ['engulfing'] } }],
    ['rejection trigger only', { strategy: { triggerKinds: ['rejection'] } }],
    ['stop 1.0 ATR past zone', { strategy: { stopAtrBuffer: 1.0 } }],
    ['stop 1.5 ATR past zone', { strategy: { stopAtrBuffer: 1.5 } }],
    ['fixed 2R target', { strategy: { tpMaxR: 2 } }],
    ['must close inside zone', { strategy: { zoneMaxDistanceAtr: 0 } }],
    ['no trend-flip close', { strategy: { closeOnHtfFlip: false } }],
  ],
  // Structural questions, not a parameter sweep: does each RULE earn its place?
  // The lookback numbers are left at their long-standing defaults on purpose —
  // tuning them against this window is how a backtest stops meaning anything.
  momentum: [
    ['shipped', {}],
    ['long only', { strategy: { allowShorts: false } }],
    ['no regime filter', { strategy: { regimeMaDays: 1 } }],
    ['stop only, no trail', { strategy: { exitLookbackDays: 9999 } }],
    ['tighter stop, 1 ATR', { strategy: { stopAtr: 1 } }],
    ['wider stop, 3 ATR', { strategy: { stopAtr: 3 } }],
  ],
}
const VARIANTS = VARIANTS_BY_STRATEGY[args.get('strategy') ?? 'price-action']

if (args.has('compare')) {
  const merge = (variant) => ({
    ...overrides,
    ...variant,
    strategy: { ...(overrides.strategy ?? {}), ...(variant.strategy ?? {}) },
    risk: { ...(overrides.risk ?? {}), ...(variant.risk ?? {}) },
  })

  const rows = []
  for (const [label, variant] of VARIANTS) {
    const result = await runBacktest({
      hourly: candles,
      settings: merge(variant),
      warmupHours,
      windowHours,
      fundingSettlements,
      strategy: chosen.module,
    })
    const exits = result.trades.reduce((counts, trade) => {
      counts[trade.exitReason] = (counts[trade.exitReason] ?? 0) + 1
      return counts
    }, {})
    rows.push({
      label,
      trades: result.stats.trades,
      winRate: result.stats.winRate,
      pf: result.stats.profitFactor,
      ret: result.returnPct,
      avgWin: result.stats.averageWinSats,
      avgLoss: result.stats.averageLossSats,
      tp: exits.take_profit ?? 0,
      sl: exits.stop_loss ?? 0,
      manual: exits.manual ?? 0,
    })
  }

  const fmt = (value, digits = 2) => (value === null || value === undefined ? '  n/a' : value.toFixed(digits))
  console.log(`Candles       ${candles.length} hourly from ${source}`)
  console.log('')
  console.log('One change each from the shipped configuration, same candles:')
  console.log('')
  console.log('  variant                 trades   win%      PF   return%   avgW/avgL    TP   SL  man')
  for (const row of rows) {
    console.log(
      `  ${row.label.padEnd(22)} ${String(row.trades).padStart(6)}  ${fmt(row.winRate, 1).padStart(5)}  ${fmt(row.pf).padStart(6)}  ${fmt(row.ret, 1).padStart(8)}` +
        `   ${fmt(row.avgWin / (row.avgLoss || 1), 2).padStart(9)}  ${String(row.tp).padStart(4)} ${String(row.sl).padStart(4)} ${String(row.manual).padStart(4)}`
    )
  }
  console.log('')
  console.log('Read this as diagnosis. A row that scores better here has not been shown to')
  console.log('be better — it has been shown to fit this window. It needs a reason, and then')
  console.log('a second window, before it becomes the configuration.')
  process.exit(0)
}

const report = await runBacktest({
  hourly: candles,
  settings: overrides,
  warmupHours,
  windowHours,
  fundingSettlements,
  strategy: chosen.module,
})

const first = new Date(candles[0].time).toISOString()
const last = new Date(candles.at(-1).time).toISOString()
console.log(formatBacktest(report))
// Printed last, with the summary: if paging silently returned one page, the
// window is short and that is the first thing to check.
console.log(`Candles       ${candles.length} hourly from ${source} (${first} → ${last})`)

if (args.has('json')) {
  await writeFile(args.get('json'), JSON.stringify(report, null, 2), 'utf8')
  console.log(`\nFull report written to ${args.get('json')}`)
}
