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
  if (args.has('source')) {
    return { source: args.get('source'), candles: await fetchCandles({ source: args.get('source'), limit }) }
  }
  return fetchCandlesWithFallback({ limit })
}

const { source, candles } = await loadCandles()

const overrides = { strategy: {}, risk: {} }
if (args.has('risk')) overrides.risk.riskPct = Number(args.get('risk'))
if (args.has('min-rr')) overrides.strategy.minRR = Number(args.get('min-rr'))
if (args.has('max-trades')) overrides.maxTradesPerDay = Number(args.get('max-trades'))
if (args.has('capital')) overrides.startingCapitalUsd = Number(args.get('capital'))

const report = await runBacktest({
  hourly: candles,
  settings: overrides,
  warmupHours: Number(args.get('warmup') ?? 400),
})

console.log(`Source        ${source} (${candles.length} hourly candles)`)
console.log(formatBacktest(report))

if (args.has('json')) {
  await writeFile(args.get('json'), JSON.stringify(report, null, 2), 'utf8')
  console.log(`\nFull report written to ${args.get('json')}`)
}
