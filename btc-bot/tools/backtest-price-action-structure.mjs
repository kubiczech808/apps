#!/usr/bin/env node
// Build the published PA-1 research summary for the dashboard.
// Intraday FX history is limited by the public Yahoo endpoint; every published
// row keeps its actual period instead of presenting a longer requested window.

import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { aggregate, fetchBinanceCandles } from '../src/candles.mjs'
import {
  DEFAULT_PRICE_ACTION_STRUCTURE,
  fetchYahooCandles,
  PRICE_ACTION_ASSETS,
} from '../src/strategy-price-action-structure.mjs'
import {
  aggregatePriceActionBacktests,
  runPriceActionStructureBacktest,
} from '../src/backtest-price-action-structure.mjs'
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

const years = Number(args.get('years') ?? 10)
const periodYears = [1, 3, 5, 10].filter((value) => value <= years)
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
  const daily = await fetchYahooCandles({ symbol: asset.yahooSymbol, interval: '1d', range: `${Math.max(5, Math.min(years, 10))}y` })
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
    : `Yahoo Finance ${asset.yahooSymbol}; 1H/4H up to 2Y, 1D up to ${Math.max(5, Math.min(years, 10))}Y`,
}))

const sliceYears = (candles, yearsBack) => {
  const latest = candles.at(-1)?.time
  if (!Number.isFinite(Number(latest))) return candles
  const cutoff = latest - yearsBack * 365.25 * 24 * 60 * 60 * 1000
  let low = 0
  let high = candles.length
  while (low < high) {
    const middle = Math.floor((low + high) / 2)
    if (candles[middle].time < cutoff) low = middle + 1
    else high = middle
  }
  return candles.slice(low)
}

const result = {
  strategyId: 'price-action-structure-v1',
  strategyLabel: 'PA-1 Price Action Structure',
  generatedAt: new Date(now).toISOString(),
  requestedYears: years,
  periodsRequested: periodYears,
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
  periods: {},
}

const store = publish
  ? createStateStore({ baseUrl: process.env.BOT_API_URL || '', key: process.env.BOT_API_KEY || '' })
  : null

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))

const saveReport = async (report, { optional = false } = {}) => {
  if (!store) return null
  let lastError = null
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await store.saveBacktests(report)
    } catch (error) {
      lastError = error
      if (attempt < 3) await wait(attempt * 1500)
    }
  }
  if (optional) {
    console.warn(`Could not publish progress after 3 attempts: ${lastError?.message ?? 'unknown error'}`)
    return null
  }
  throw lastError
}

try {
  if (store) {
    const loaded = await store.load()
    const previous = loaded.state?.backtests ?? {}
    await saveReport({
      ...previous,
      strategyId: result.strategyId,
      strategyLabel: result.strategyLabel,
      generatedAt: result.generatedAt,
      run: { status: 'running', requestedAt: new Date(now).toISOString(), startedAt: new Date(now).toISOString() },
    })
  }

  const fetched = []
  for (const source of sources) {
    fetched.push({ source, candles: await source.fetch() })
  }

  for (const yearsBack of periodYears) {
    const period = { requestedYears: yearsBack, assets: {} }
    for (const { source, candles } of fetched) {
      const { asset } = source
      const hourly = sliceYears(candles.hourly, yearsBack)
      const fourHourly = sliceYears(candles.fourHourly, yearsBack)
      const daily = sliceYears(candles.daily, yearsBack)
      const series = {
        '1h': { candles: hourly, lowerCandles: [], higherCandles: fourHourly, label: '1H' },
        '4h': { candles: fourHourly, lowerCandles: hourly, higherCandles: daily, label: '4H' },
        '1d': { candles: daily, lowerCandles: fourHourly, higherCandles: [], label: '1D' },
      }
      period.assets[asset.symbol] = {}
      for (const [timeframeId, entry] of Object.entries(series)) {
        const report = runPriceActionStructureBacktest({
          asset: asset.symbol,
          timeframeId,
          candles: entry.candles,
          lowerCandles: entry.lowerCandles,
          higherCandles: entry.higherCandles,
          dataSource: source.source,
          startingCapital: result.assumptions.startingCapital,
          riskPct,
          feeRate,
          settings: { ...priceActionSettings, maxNotionalPct },
        })
        period.assets[asset.symbol][timeframeId] = { ...report, label: entry.label }
        console.log(`${yearsBack}Y ${asset.symbol} ${entry.label}: ${report.cagrPct?.toFixed(2) ?? 'n/a'}% p.a., ${report.trades} trades, DD ${report.maxDrawdownPct?.toFixed(2) ?? 'n/a'}%, ready ${report.readyProfiles ?? 0}, zones hit ${report.zoneHits ?? 0}, ${report.from ?? 'n/a'} -> ${report.to ?? 'n/a'}`)
      }
    }
    period.portfolio = aggregatePriceActionBacktests({
      assets: period.assets,
      startingCapital: result.assumptions.startingCapital,
      riskPct: result.assumptions.riskPct,
    })
    result.periods[String(yearsBack)] = period
    console.log(`Portfolio ${yearsBack}Y: ${period.portfolio.cagrPct?.toFixed(2) ?? 'n/a'}% p.a., ${period.portfolio.trades} trades, DD ${period.portfolio.maxDrawdownPct?.toFixed(2) ?? 'n/a'}%, overlap skipped ${period.portfolio.overlapSkipped}`)
    if (store) {
      await saveReport({
        ...result,
        run: {
          status: 'running',
          requestedAt: result.generatedAt,
          startedAt: result.generatedAt,
          completedPeriods: periodYears.slice(0, periodYears.indexOf(yearsBack) + 1),
        },
      }, { optional: true })
    }
  }

  const defaultPeriod = result.periods[String(Math.max(...periodYears))]
  result.assets = defaultPeriod?.assets ?? {}
  result.portfolio = defaultPeriod?.portfolio ?? null

  result.run = { status: 'complete', requestedAt: result.generatedAt, completedAt: new Date().toISOString() }
  await mkdir(dirname(output), { recursive: true })
  await writeFile(output, `${JSON.stringify(result, null, 2)}\n`, 'utf8')
  await saveReport(result)
  console.log(`Wrote ${output}${store ? ' and published it' : ''}`)
} catch (error) {
  if (store) {
    await saveReport({
      ...result,
      strategyId: result.strategyId,
      strategyLabel: result.strategyLabel,
      generatedAt: result.generatedAt,
      run: { status: 'failed', requestedAt: result.generatedAt, completedAt: new Date().toISOString(), error: error.message },
    }, { optional: true })
  }
  throw error
}
