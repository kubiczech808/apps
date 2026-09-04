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
import { createLnMarketsClient, resolveNetwork } from '../src/lnmarkets.mjs'
import { formatBacktest, runBacktest } from '../src/backtest.mjs'

const args = new Map()
for (let index = 2; index < process.argv.length; index += 2) {
  args.set(process.argv[index].replace(/^--/, ''), process.argv[index + 1])
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

const { source, candles } = await loadCandles()

const overrides = { strategy: {}, risk: {} }
if (args.has('risk')) overrides.risk.riskPct = Number(args.get('risk'))
if (args.has('min-rr')) overrides.strategy.minRR = Number(args.get('min-rr'))
if (args.has('max-trades')) overrides.maxTradesPerDay = Number(args.get('max-trades'))
if (args.has('capital')) overrides.startingCapitalUsd = Number(args.get('capital'))

const warmupHours = Number(args.get('warmup') ?? 400)

// `--compare` is a DIAGNOSIS, not a menu.
//
// Each variant changes exactly one thing from the shipped configuration, so a
// difference can be attributed. Picking whichever row scores best on this
// window is how a 233-day sample becomes an overfitted strategy — the table
// answers "which rule is costing money", and the answer then needs a reason
// before it becomes a change.
const VARIANTS = [
  ['shipped', {}],
  ['no breakeven/trail', { strategy: { breakevenAtR: 999, trailStartAtR: 999 } }],
  ['no trend-flip close', { strategy: { closeOnHtfFlip: false } }],
  ['neither', { strategy: { breakevenAtR: 999, trailStartAtR: 999, closeOnHtfFlip: false } }],
  ['target fixed at 2R', { strategy: { tpMaxR: 2 } }],
  ['require 3R', { strategy: { minRR: 3, tpMinR: 3 } }],
]

if (args.has('compare')) {
  const merge = (variant) => ({
    ...overrides,
    ...variant,
    strategy: { ...(overrides.strategy ?? {}), ...(variant.strategy ?? {}) },
    risk: { ...(overrides.risk ?? {}), ...(variant.risk ?? {}) },
  })

  const rows = []
  for (const [label, variant] of VARIANTS) {
    const result = await runBacktest({ hourly: candles, settings: merge(variant), warmupHours })
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
