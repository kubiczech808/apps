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
import * as jeafxSweepReclaim from '../src/strategy-jeafx-sweep-reclaim.mjs'
import * as jeafxSwing from '../src/strategy-jeafx-swing.mjs'
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
    label: 'PA-0 price action',
    module: priceAction,
    timeframes: { htfHours: 4, ltfHours: 1 },
    windowHours: 2400,
    warmupHours: 400,
  },
  // JeaFx-inspired swing variant: daily bias, 4h supply/demand POI and trigger.
  'jeafx-swing': {
    label: 'JF-1 HTF swing S/D',
    module: jeafxSwing,
    timeframes: { htfHours: 24, ltfHours: 4 },
    windowHours: 6000,
    warmupHours: 3600,
  },
  // JeaFx-inspired liquidity model: sweep, reclaim, then momentum confirmation.
  'jeafx-sweep-reclaim': {
    label: 'JF-2 sweep & reclaim',
    module: jeafxSweepReclaim,
    timeframes: { htfHours: 24, ltfHours: 4 },
    windowHours: 6000,
    warmupHours: 3600,
  },
  // Signals off the daily chart, entry priced at the latest hourly close.
  momentum: {
    label: 'TF-1 daily momentum',
    module: momentum,
    timeframes: { htfHours: 24, ltfHours: 1 },
    windowHours: 6000, // 250 daily candles
    warmupHours: 3600, // 150 days before the first decision
  },
}


const args = new Map()
for (let index = 2; index < process.argv.length; index += 1) {
  const token = process.argv[index]
  if (!token.startsWith('--')) continue
  const key = token.replace(/^--/, '')
  const next = process.argv[index + 1]
  if (next && !next.startsWith('--')) {
    args.set(key, next)
    index += 1
  } else {
    args.set(key, true)
  }
}

const selectedName = args.has('all') ? 'all' : args.get('strategy') ?? 'price-action'
const selectedStrategies =
  selectedName === 'all' ? Object.entries(STRATEGIES) : [[selectedName, STRATEGIES[selectedName]]]
if (selectedStrategies.some(([, strategy]) => !strategy)) {
  console.error(`Unknown strategy. Choose one of: ${Object.keys(STRATEGIES).join(', ')}`)
  process.exit(1)
}

const years = args.has('years') ? Number(args.get('years')) : null
if (years !== null && (!(years > 0) || !Number.isFinite(years))) {
  console.error('--years must be a positive number')
  process.exit(1)
}
const horizonHours = years ? Math.ceil(years * 365.25 * 24) : null
const maxWarmupHours = Math.max(...selectedStrategies.map(([, strategy]) => strategy.warmupHours))
const candleLimit = Number(args.get('limit') ?? (horizonHours ? horizonHours + maxWarmupHours : 1000))

const loadCandles = async () => {
  if (args.has('file')) {
    const parsed = JSON.parse(await readFile(args.get('file'), 'utf8'))
    return { source: args.get('file'), candles: Array.isArray(parsed) ? parsed : parsed.candles }
  }
  // `futures/candles` needs no credentials, so a backtest reads the same venue
  // the bot trades without being armed to trade.
  const client = createLnMarketsClient({
    network: resolveNetwork(args.get('network') ?? 'mainnet'),
    key: '',
    secret: '',
    passphrase: '',
  })
  if (args.has('source')) {
    return { source: args.get('source'), candles: await fetchCandles({ source: args.get('source'), limit: candleLimit, client }) }
  }
  return fetchCandlesWithFallback({ limit: candleLimit, client })
}

const { source, candles, failures = [] } = await loadCandles()
const first = new Date(candles[0].time).toISOString()
const last = new Date(candles.at(-1).time).toISOString()

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
      hours: candleLimit + 48,
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

const overridesFor = (strategy) => {
  const overrides = { strategy: {}, risk: {}, timeframes: strategy.timeframes }
  if (args.has('risk')) overrides.risk.riskPct = Number(args.get('risk'))
  if (args.has('min-rr')) overrides.strategy.minRR = Number(args.get('min-rr'))
  if (args.has('max-trades')) overrides.maxTradesPerDay = Number(args.get('max-trades'))
  if (args.has('capital')) overrides.startingCapitalUsd = Number(args.get('capital'))
  return overrides
}

const warmupFor = (strategy) => Number(args.get('warmup') ?? strategy.warmupHours)
const annualised = (returnPct, hours) =>
  Number.isFinite(returnPct) && hours > 0 ? ((1 + returnPct / 100) ** (8766 / hours) - 1) * 100 : null

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
  'jeafx-swing': [
    ['shipped', {}],
    ['imbalance off', { strategy: { requireImbalance: false } }],
    ['rejection also allowed', { strategy: { triggerKinds: null } }],
    ['no candle trigger', { strategy: { requireTrigger: false } }],
    ['stop 0.5 ATR past zone', { strategy: { stopAtrBuffer: 0.5 } }],
    ['stop 1.0 ATR past zone', { strategy: { stopAtrBuffer: 1.0 } }],
    ['zone up to 1.0 ATR', { strategy: { zoneMaxDistanceAtr: 1.0 } }],
    ['fixed 2R target', { strategy: { tpMaxR: 2 } }],
  ],
  'jeafx-sweep-reclaim': [
    ['shipped', {}],
    ['rejection also allowed', { strategy: { triggerKinds: null } }],
    ['no candle trigger', { strategy: { requireTrigger: false } }],
    ['longer reclaim window', { strategy: { reclaimMaxBars: 12 } }],
    ['older sweeps allowed', { strategy: { sweepLookbackBars: 96 } }],
    ['faster confirmation', { strategy: { triggerMaxBarsAfterReclaim: 2 } }],
    ['stop 0.75 ATR past sweep', { strategy: { stopAtrBuffer: 0.75 } }],
    ['fixed 2R target', { strategy: { tpMaxR: 2 } }],
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
const VARIANTS = VARIANTS_BY_STRATEGY[selectedName]

const fmt = (value, digits = 2) => (value === null || value === undefined ? '  n/a' : value.toFixed(digits))
const runStrategy = async (strategy, variant = {}) => {
  const base = overridesFor(strategy)
  return runBacktest({
    hourly: candles,
    settings: {
      ...base,
      ...variant,
      strategy: { ...(base.strategy ?? {}), ...(variant.strategy ?? {}) },
      risk: { ...(base.risk ?? {}), ...(variant.risk ?? {}) },
    },
    warmupHours: warmupFor(strategy),
    windowHours: strategy.windowHours,
    fundingSettlements,
    strategy: strategy.module,
  })
}

const exitCounts = (trades) =>
  trades.reduce((counts, trade) => {
    counts[trade.exitReason] = (counts[trade.exitReason] ?? 0) + 1
    return counts
  }, {})

if (selectedName === 'all') {
  const rows = []
  for (const [name, strategy] of selectedStrategies) {
    const result = await runStrategy(strategy)
    const exits = exitCounts(result.trades)
    rows.push({
      name,
      label: strategy.label,
      days: result.hours / 24,
      trades: result.stats.trades,
      winRate: result.stats.winRate,
      pf: result.stats.profitFactor,
      ret: result.returnPct,
      annual: annualised(result.returnPct, result.hours),
      dd: result.stats.maxDrawdownPct,
      avgWinLoss: result.stats.averageWinSats / (result.stats.averageLossSats || 1),
      tp: exits.take_profit ?? 0,
      sl: exits.stop_loss ?? 0,
      manual: exits.manual ?? 0,
      starved: result.starved,
    })
  }

  console.log(`Candles       ${candles.length} hourly from ${source} (${first} → ${last})`)
  if (years) console.log(`Requested     ${years} years after warmup; ${Math.round(candleLimit / 24)} days of candles requested`)
  console.log('')
  console.log('Strategy comparison, same candles:')
  console.log('')
  console.log('  strategy                    days trades   win%      PF   return%      p.a.   maxDD% avgW/avgL    TP   SL  man')
  for (const row of rows) {
    console.log(
      `  ${row.label.padEnd(26)} ${String(Math.round(row.days)).padStart(5)} ${String(row.trades).padStart(6)}` +
        `  ${fmt(row.winRate, 1).padStart(5)}  ${fmt(row.pf).padStart(6)}  ${fmt(row.ret, 1).padStart(8)}` +
        `  ${fmt(row.annual, 1).padStart(8)}  ${fmt(row.dd, 1).padStart(7)}` +
        ` ${fmt(row.avgWinLoss, 2).padStart(9)}  ${String(row.tp).padStart(4)} ${String(row.sl).padStart(4)} ${String(row.manual).padStart(4)}` +
        `${row.starved ? '  INVALID' : ''}`
    )
  }
  console.log('')
  console.log('Read this as a first pass. The target is stable 20%+ p.a. with tolerable drawdown,')
  console.log('so a candidate needs enough trades, out-of-sample windows and fee-aware robustness before promotion.')
  if (args.has('json')) {
    await writeFile(args.get('json'), JSON.stringify({ source, first, last, rows }, null, 2), 'utf8')
    console.log(`\nFull comparison written to ${args.get('json')}`)
  }
  process.exit(0)
}

const chosen = selectedStrategies[0][1]
const chosenName = selectedStrategies[0][0]
const overrides = overridesFor(chosen)
const warmupHours = warmupFor(chosen)
const windowHours = chosen.windowHours

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
    const exits = exitCounts(result.trades)
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

  console.log(`Candles       ${candles.length} hourly from ${source} (${first} → ${last})`)
  if (years) console.log(`Requested     ${years} years after warmup; ${Math.round(candleLimit / 24)} days of candles requested`)
  console.log('')
  console.log(`One change each from ${STRATEGIES[chosenName].label}, same candles:`)
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

console.log(formatBacktest(report))
// Printed last, with the summary: if paging silently returned one page, the
// window is short and that is the first thing to check.
console.log(`Candles       ${candles.length} hourly from ${source} (${first} → ${last})`)

if (args.has('json')) {
  await writeFile(args.get('json'), JSON.stringify(report, null, 2), 'utf8')
  console.log(`\nFull report written to ${args.get('json')}`)
}
