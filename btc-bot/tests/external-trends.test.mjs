import assert from 'node:assert/strict'
import test from 'node:test'

import { canReuseExternalPivotBucket, classifyExternalPivotPath, classifyExternalTrend, confirmedExternalPivotPath, fetchTwelveDataFxHourly, fetchTwelveDataFxPivots } from '../src/external-trends.mjs'
import { HOUR, START } from './helpers.mjs'

const values = (start, count, step = 0.001) => Array.from({ length: count }, (_, index) => {
  const value = 1 + index * step
  return {
    datetime: new Date(start + index * HOUR).toISOString().replace('T', ' ').replace('.000Z', ''),
    open: String(value), high: String(value + 0.0004), low: String(value - 0.0004), close: String(value + 0.0002),
  }
}).reverse()

test('Twelve Data FX batch is parsed as UTC-normalized hourly candles', async () => {
  let requested
  const candles = await fetchTwelveDataFxHourly({
    assets: [
      { symbol: 'EURUSD', group: 'fx', twelveSymbol: 'EUR/USD' },
      { symbol: 'USDJPY', group: 'fx', twelveSymbol: 'USD/JPY' },
    ],
    apiKey: 'test-key',
    fetchImpl: async (url) => {
      requested = new URL(url)
      return {
        ok: true,
        json: async () => ({
          'EUR/USD': { values: values(START, 55) },
          'USD/JPY': { values: values(START, 55, 0.01) },
        }),
      }
    },
  })

  assert.equal(requested.searchParams.get('symbol'), 'EUR/USD,USD/JPY')
  assert.equal(requested.searchParams.get('interval'), '1h')
  assert.equal(requested.searchParams.get('apikey'), 'test-key')
  assert.equal(candles.EURUSD.length, 55)
  assert.equal(candles.EURUSD[0].time, START)
  assert.ok(candles.EURUSD[0].time < candles.EURUSD.at(-1).time)
})

test('external trend is a separate EMA regime rather than the PA swing label', () => {
  const up = values(START, 70).reverse().map((value) => ({
    time: Date.parse(`${value.datetime.replace(' ', 'T')}Z`),
    open: Number(value.open), high: Number(value.high), low: Number(value.low), close: Number(value.close), volume: 0,
  }))
  const down = [...up].map((candle, index) => ({ ...candle, close: 2 - index * 0.001 }))

  assert.equal(classifyExternalTrend(up).trend, 'up')
  assert.equal(classifyExternalTrend(down).trend, 'down')
  assert.match(classifyExternalTrend(up).method, /EMA 20\/50/)
  assert.equal(classifyExternalTrend(up).ema.ema20.at(-1)?.time, up.at(-1)?.time)
  assert.equal(classifyExternalTrend(up).ema.ema50.at(-1)?.time, up.at(-1)?.time)
  assert.ok(classifyExternalTrend(up).ema.ema20.length > classifyExternalTrend(up).ema.ema50.length)
})

test('Twelve Data pivot points form an independent, labelled external path', async () => {
  let requested
  const series = [
    { datetime: '2026-01-01 00:00:00', high: '1.1010', low: '1.1000', close: '1.1005', pivot_point_l: '1' },
    { datetime: '2026-01-01 04:00:00', high: '1.1100', low: '1.1030', close: '1.1080', pivot_point_h: '1' },
    { datetime: '2026-01-01 08:00:00', high: '1.1080', low: '1.1050', close: '1.1060', pivot_point_l: '1' },
    { datetime: '2026-01-01 12:00:00', high: '1.1150', low: '1.1080', close: '1.1130', pivot_point_h: '1' },
  ].reverse()
  const paths = await fetchTwelveDataFxPivots({
    assets: [{ symbol: 'EURUSD', group: 'fx', twelveSymbol: 'EUR/USD' }],
    apiKey: 'test-key',
    timeframeId: '4h',
    fetchImpl: async (url) => {
      requested = new URL(url)
      return { ok: true, json: async () => ({ values: series }) }
    },
  })

  assert.equal(requested.pathname, '/pivot_points_hl')
  assert.equal(requested.searchParams.get('interval'), '4h')
  assert.equal(requested.searchParams.get('include_ohlc'), 'true')
  assert.equal(paths.EURUSD.trend, 'up')
  assert.deepEqual(paths.EURUSD.pivots.map((pivot) => pivot.label), ['L', 'H', 'HL', 'HH'])
})

test('external pivot path distinguishes a down sequence from an internal rebound', () => {
  const down = classifyExternalPivotPath([
    { kind: 'high', price: 120, time: START },
    { kind: 'low', price: 100, time: START + HOUR },
    { kind: 'high', price: 115, time: START + 2 * HOUR },
    { kind: 'low', price: 95, time: START + 3 * HOUR },
  ])
  assert.equal(down.trend, 'down')
  assert.deepEqual(down.pivots.map((pivot) => pivot.label), ['H', 'L', 'LH', 'LL'])
})

test('external pivot path uses the confirmed close rather than a wick sweep', () => {
  const path = classifyExternalPivotPath([
    { kind: 'high', price: 120, close: 110, time: START },
    { kind: 'low', price: 100, close: 100, time: START + HOUR },
    { kind: 'high', price: 130, close: 105, time: START + 2 * HOUR },
    { kind: 'low', price: 95, close: 102, time: START + 3 * HOUR },
  ])

  assert.equal(path.trend, 'flat')
  assert.deepEqual(path.pivots.map((pivot) => pivot.price), [110, 100, 105, 102])
  assert.deepEqual(path.pivots.map((pivot) => pivot.label), ['H', 'L', 'LH', 'HL'])
})

test('Twelve Data OHLC produces a confirmed independent pivot path without the premium indicator', () => {
  const candles = Array.from({ length: 60 }, (_, index) => ({
    time: START + index * HOUR,
    open: 1,
    close: index === 10 ? 1.2 : index === 20 ? 0.8 : index === 30 ? 1.3 : index === 40 ? 0.85 : 1,
    high: index === 10 ? 1.2 : index === 30 ? 1.3 : 1.05,
    low: index === 20 ? 0.8 : index === 40 ? 0.85 : 0.95,
    volume: 0,
  }))
  const path = confirmedExternalPivotPath({ candles, timeframeId: '1h', now: START + 70 * HOUR })

  assert.equal(path.trend, 'up')
  assert.deepEqual(path.pivots.map((pivot) => pivot.label), ['H', 'L', 'HH', 'HL'])
  assert.equal(path.timePeriod, 10)
})

test('external pivot audit falls back to a narrower confirmed window when the broad path is empty', () => {
  const candles = Array.from({ length: 30 }, (_, index) => ({
    time: START + index * HOUR,
    open: 1,
    close: 1,
    high: index === 6 ? 1.2 : 1.05,
    low: index === 13 ? 0.8 : 0.95,
    volume: 0,
  }))
  const path = confirmedExternalPivotPath({ candles, timeframeId: '1h', now: START + 40 * HOUR })

  assert.equal(path.timePeriod, 5)
  assert.deepEqual(path.pivots.map((pivot) => pivot.kind), ['high', 'low'])
})

test('a missing external pivot result is not kept as a valid cache entry', () => {
  const assets = [{ symbol: 'EURUSD' }]
  const previous = {
    pivots: {
      buckets: { '4h': 5 },
      assets: { EURUSD: { '4h': null } },
    },
  }
  assert.equal(canReuseExternalPivotBucket({ previous, assets, timeframeId: '4h', bucket: 5 }), false)
  previous.pivots.assets.EURUSD['4h'] = { trend: 'flat', pivots: [] }
  assert.equal(canReuseExternalPivotBucket({ previous, assets, timeframeId: '4h', bucket: 5 }), true)
})
