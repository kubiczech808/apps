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

const report = await runBacktest({
  hourly: candles,
  settings: overrides,
  warmupHours: Number(args.get('warmup') ?? 400),
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
