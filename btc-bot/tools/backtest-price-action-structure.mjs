#!/usr/bin/env node
// Build the published PA-1 research summary for the dashboard.
// Intraday FX history is limited by the public Yahoo endpoint; the output
// keeps the actual period per row instead of presenting it as four years.

import { writeFile } from 'node:fs/promises'
import { aggregate, fetchBinanceCandles } from '../src/candles.mjs'
import {
  DEFAULT_PRICE_ACTION_STRUCTURE,
  fetchYahooCandles,
  PRICE_ACTION_ASSETS,
} from '../src/strategy-price-action-structure.mjs'
import { runPriceActionStructureBacktest } from '../src/backtest-price-action-structure.mjs'
import { createStateStore } from '../src/store.mjs'

const args = new Map()
for (let index = 2; index < process.argv.length; index += 1) {
  const token = process.argv[index]
  if (!token.startsWith('--')) continue
  const key = token.slice(2)
  const value = process.argv[index + 1]
  args.set(key, value && !value.startsWith('--') ? value : true)
  if (value && !value.startsWith('--')) index += 1
}

const years = Number(args.get('years') ?? 4)
const output = String(args.get('output') ?? 'data/backtests.json')
const now = Date.now()
const publish = args.get('publish') === true

const configuredSettings = (() => {
  try {
    return JSON.parse(process.env.BOT_BACKTEST_SETTINGS ?? '{}')
  } catch {
    return {}
  }
})()
const priceActionSettings = {
  ...DEFAULT_PRICE_ACTION_STRUCTURE,
  ...(configuredSettings.priceActionStructure ?? configuredSettings.strategy ?? {}),
}
const riskSettings = configuredSettings.risk ?? {}
const riskPct = Number(priceActionSettings.riskPct ?? riskSettings.riskPct ?? 1)
const feeRate = Number(riskSettings.feeRate ?? 0.0006)
const maxNotionalPct = Number(riskSettings.maxNotionalPct ?? 300)

const fetchFx = async (asset) => {
  const hourly = await fetchYahooCandles({ symbol: asset.yahooSymbol, interval: '1h', range: '2y' })
  const daily = await fetchYahooCandles({ symbol: asset.yahooSymbol, interval: '1d', range: '5y' })
  return { hourly, fourHourly: aggregate(hourly, 4), daily }
}

const fetchBtc = async () => {
  const hourly = await fetchBinanceCandles({ limit: Math.ceil(years * 365.25 * 24) + 240, pauseMs: 80 })
  return { hourly, fourHourly: aggregate(hourly, 4), daily: aggregate(hourly, 24) }
}

const sources = PRICE_ACTION_ASSETS.map((asset) => ({
  asset,
  fetch: asset.symbol === 'BTCUSD' ? fetchBtc : () => fetchFx(asset),
  source: asset.symbol === 'BTCUSD'
    ? 'Binance BTCUSDT 1H; higher timeframes aggregated UTC'
    : `Yahoo Finance ${asset.yahooSymbol}; 1H/4H up to 2Y, 1D up to 5Y`,
}))

const result = {
  strategyId: 'price-action-structure-v1',
  strategyLabel: 'PA-1 Price Action Structure',
  generatedAt: new Date(now).toISOString(),
  requestedYears: years,
  assumptions: {
    startingCapital: 100,
    riskPct,
    feeRate,
    maxNotionalPct,
    exits: 'SL first; TP1 and TP2 each 50%; structure invalidation at candle close; residual closed at period end',
    note: 'Výsledky jsou výzkumný model strategie PA-1, nikoli garance budoucího výnosu.',
  },
  settings: priceActionSettings,
  assets: {},
}

const store = publish
  ? createStateStore({ baseUrl: process.env.BOT_API_URL || '', key: process.env.BOT_API_KEY || '' })
  : null

try {
  if (store) {
    const loaded = await store.load()
    const previous = loaded.state?.backtests ?? {}
    await store.saveBacktests({
      ...previous,
      strategyId: result.strategyId,
      strategyLabel: result.strategyLabel,
      generatedAt: result.generatedAt,
      run: { status: 'running', requestedAt: new Date(now).toISOString(), startedAt: new Date(now).toISOString() },
    })
  }

  for (const source of sources) {
    const { asset } = source
    const candles = await source.fetch()
  const series = {
    '1h': { candles: candles.hourly, lowerCandles: [], label: '1H' },
    '4h': { candles: candles.fourHourly, lowerCandles: candles.hourly, label: '4H' },
    '1d': { candles: candles.daily, lowerCandles: candles.fourHourly, label: '1D' },
  }
    result.assets[asset.symbol] = {}
  for (const [timeframeId, entry] of Object.entries(series)) {
    const report = runPriceActionStructureBacktest({
      asset: asset.symbol,
      timeframeId,
      candles: entry.candles,
      lowerCandles: entry.lowerCandles,
      dataSource: source.source,
      startingCapital: result.assumptions.startingCapital,
      riskPct,
      feeRate,
      settings: { ...priceActionSettings, maxNotionalPct },
    })
      result.assets[asset.symbol][timeframeId] = { ...report, label: entry.label }
      console.log(`${asset.symbol} ${entry.label}: ${report.cagrPct?.toFixed(2) ?? 'n/a'}% p.a., ${report.trades} trades, DD ${report.maxDrawdownPct?.toFixed(2) ?? 'n/a'}%, ready ${report.readyProfiles ?? 0}, zones hit ${report.zoneHits ?? 0}, ${report.from ?? 'n/a'} -> ${report.to ?? 'n/a'}`)
    }
  }

  result.run = { status: 'complete', requestedAt: result.generatedAt, completedAt: new Date().toISOString() }
  await writeFile(output, `${JSON.stringify(result, null, 2)}\n`, 'utf8')
  if (store) await store.saveBacktests(result)
  console.log(`Wrote ${output}${store ? ' and published it' : ''}`)
} catch (error) {
  if (store) {
    await store.saveBacktests({
      strategyId: result.strategyId,
      strategyLabel: result.strategyLabel,
      generatedAt: result.generatedAt,
      run: { status: 'failed', requestedAt: result.generatedAt, completedAt: new Date().toISOString(), error: error.message },
    }).catch(() => {})
  }
  throw error
}
