import assert from 'node:assert/strict'
import test from 'node:test'

import { EXTERNAL_PIVOT_SCHEMA, buildExternalTrendReference, canReuseExternalPivotBucket, classifyExternalPivotPath, classifyExternalTrend, confirmedExternalPivotCandidates, confirmedExternalPivotPath, fetchTwelveDataFxHourly, fetchTwelveDataFxPivots, reanchorCachedExternalPivotReference } from '../src/external-trends.mjs'
import { PRICE_ACTION_ASSETS, PRICE_ACTION_TIMEFRAMES } from '../src/strategy-price-action-structure.mjs'
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

test('a rate-limited FX refresh preserves the last confirmed source matrix as stale', async () => {
  const priorTrend = { trend: 'down', source: 'Twelve Data', candles: 240, asOf: START + 200 * HOUR }
  const priorPivot = {
    trend: 'down', source: 'Twelve Data', timeframeId: '1h', asOf: START + 200 * HOUR,
    pivots: [
      { kind: 'low', label: 'LL', price: 1.1200, time: START + 180 * HOUR },
      { kind: 'high', label: 'HH', price: 1.1400, time: START + 184 * HOUR },
      { kind: 'low', label: 'LL', price: 1.1250, time: START + 190 * HOUR },
      { kind: 'high', label: 'LH', price: 1.1320, time: START + 194 * HOUR },
    ],
    activeRange: {
      high: { kind: 'high', label: 'HH', price: 1.1400, close: 1.1390, time: START + 184 * HOUR },
      low: { kind: 'low', label: 'LL', price: 1.1180, close: 1.1200, time: START + 200 * HOUR },
      source: 'external-break-of-structure',
    },
  }
  const previous = {
    assets: { EURUSD: { '1h': priorTrend, '4h': priorTrend, '1d': priorTrend } },
    pivots: {
      schemaVersion: EXTERNAL_PIVOT_SCHEMA,
      buckets: { '1h': 1, '4h': 1, '1d': 1 },
      assets: { EURUSD: { '1h': priorPivot, '4h': priorPivot, '1d': priorPivot } },
    },
  }
  const reference = await buildExternalTrendReference({
    assets: [{ symbol: 'EURUSD', group: 'fx', twelveSymbol: 'EUR/USD' }],
    apiKey: 'test-key',
    previous,
    now: START + 201 * HOUR,
    logger: { warn() {} },
    fetchImpl: async () => ({ ok: false, status: 429 }),
  })

  assert.equal(reference.assets.EURUSD['1h'].trend, 'down')
  assert.equal(reference.assets.EURUSD['1h'].stale, true)
  assert.equal(reference.pivots.assets.EURUSD['1h'].trend, 'down')
  assert.equal(reference.pivots.assets.EURUSD['1h'].stale, true)
  assert.deepEqual(
    reference.pivots.assets.EURUSD['1h'].activeRange,
    {
      high: { kind: 'high', label: 'LH', price: 1.1320, time: START + 194 * HOUR, extreme: 1.1320 },
      low: { kind: 'low', label: 'LL', price: 1.1180, close: 1.1200, time: START + 200 * HOUR },
      source: 'external-cached-active-wave',
    }
  )
  assert.match(reference.failures[0], /429/)
})

test('cached external active-wave reanchoring is type-correct for every asset and timeframe', () => {
  const intervalByTimeframe = { '1h': HOUR, '4h': 4 * HOUR, '1d': 24 * HOUR }
  const baseBySymbol = {
    BTCUSD: 80000, EURUSD: 1.14, GBPUSD: 1.33, USDJPY: 157,
    USDCHF: 0.82, USDCAD: 1.42, AUDUSD: 0.70, NZDUSD: 0.57,
  }
  for (const asset of PRICE_ACTION_ASSETS) {
    for (const timeframe of PRICE_ACTION_TIMEFRAMES) {
      const base = baseBySymbol[asset.symbol]
      const span = base * 0.01
      const interval = intervalByTimeframe[timeframe.id]
      for (const trend of ['down', 'up']) {
        const isDown = trend === 'down'
        const protectedPrice = isDown ? base + span : base - span
        const oppositePrice = isDown ? base - span * 0.2 : base + span * 0.2
        const originPrice = isDown ? base + span * 0.4 : base - span * 0.4
        const terminalPrice = isDown ? base - span : base + span
        const terminalClose = isDown ? base - span * 0.5 : base + span * 0.5
        const terminalKind = isDown ? 'low' : 'high'
        const originKind = isDown ? 'high' : 'low'
        const reference = {
          trend,
          pivots: [
            { kind: terminalKind, price: oppositePrice, time: START },
            { kind: originKind, price: protectedPrice, time: START + interval },
            { kind: terminalKind, price: oppositePrice, time: START + 2 * interval },
            { kind: originKind, price: originPrice, time: START + 3 * interval },
          ],
          activeRange: isDown
            ? {
                high: { kind: 'high', label: 'HH', price: protectedPrice, close: protectedPrice, time: START + interval },
                low: { kind: 'low', label: 'LL', price: terminalPrice, close: terminalClose, time: START + 4 * interval },
                source: 'external-break-of-structure',
              }
            : {
                high: { kind: 'high', label: 'HH', price: terminalPrice, close: terminalClose, time: START + 4 * interval },
                low: { kind: 'low', label: 'LL', price: protectedPrice, close: protectedPrice, time: START + interval },
                source: 'external-break-of-structure',
              },
        }
        const rebuilt = reanchorCachedExternalPivotReference(reference)
        const expectedLabel = isDown ? 'LH' : 'HL'
        const expected = isDown ? rebuilt.activeRange.high : rebuilt.activeRange.low
        assert.equal(expected.label, expectedLabel, `${asset.symbol} ${timeframe.id} ${trend}`)
        assert.equal(expected.time, START + 3 * interval, `${asset.symbol} ${timeframe.id} ${trend}`)
        assert.equal(rebuilt.activeRange.source, 'external-cached-active-wave', `${asset.symbol} ${timeframe.id} ${trend}`)
      }
    }
  }
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

test('external pivot path plots wicks after close confirmation and rejects a wick-only sweep', () => {
  const path = classifyExternalPivotPath([
    { kind: 'high', price: 120, close: 118, time: START },
    { kind: 'low', price: 100, close: 101, time: START + HOUR },
    { kind: 'high', price: 130, close: 119, time: START + 2 * HOUR },
    { kind: 'low', price: 98, close: 97, time: START + 3 * HOUR },
    { kind: 'high', price: 125, close: 122, time: START + 4 * HOUR },
  ])

  assert.equal(path.trend, 'flat')
  assert.deepEqual(path.pivots.map((pivot) => pivot.price), [120, 98, 125])
  assert.equal(path.pivots.some((pivot) => pivot.price === 130), false)
  assert.equal(path.pivots.at(-1).label, 'HH')
})

test('a pre-normalized historical candle window preserves the external pivot path', () => {
  const pivots = [
    { kind: 'high', price: 120, close: 118, time: START },
    { kind: 'low', price: 100, close: 101, time: START + HOUR },
    { kind: 'high', price: 130, close: 132, time: START + 2 * HOUR },
    { kind: 'low', price: 95, close: 94, time: START + 3 * HOUR },
  ]
  const candles = pivots.map((pivot) => ({
    time: pivot.time,
    open: pivot.close,
    high: pivot.kind === 'high' ? pivot.price : pivot.close + 2,
    low: pivot.kind === 'low' ? pivot.price : pivot.close - 2,
    close: pivot.close,
  }))

  const direct = classifyExternalPivotPath(pivots, { candles })
  const reused = classifyExternalPivotPath(pivots, { candles, candlesAreComplete: true })

  assert.deepEqual(reused, direct)
})

test('external pivot references preserve wick geometry when old records also carry a close', () => {
  const path = classifyExternalPivotPath([
    { kind: 'low', price: 151, extreme: 150, close: 151, time: START },
    { kind: 'high', price: 159, extreme: 160, close: 159, time: START + HOUR },
  ])

  assert.equal(path.pivots[0].price, 150)
  assert.equal(path.pivots[0].extreme, 150)
  assert.equal(path.pivots[1].price, 160)
  assert.equal(path.pivots[1].extreme, 160)
})

test('a close through a protected HL confirms BoS and keeps the prior HH as the Fibonacci anchor', () => {
  const pivots = [
    { kind: 'low', price: 150, time: START },
    { kind: 'high', price: 160, time: START + HOUR },
    { kind: 'low', price: 155, time: START + 2 * HOUR },
    { kind: 'high', price: 164, time: START + 3 * HOUR },
  ]
  const candles = [
    { time: START, open: 151, high: 152, low: 150, close: 151 },
    { time: START + HOUR, open: 158, high: 160, low: 157, close: 159 },
    { time: START + 2 * HOUR, open: 157, high: 158, low: 155, close: 156 },
    { time: START + 3 * HOUR, open: 162, high: 164, low: 161, close: 159 },
    // The later close above the old high validates the wick at 164 as HH.
    { time: START + 4 * HOUR, open: 159, high: 162, low: 158, close: 161 },
    // A wick through HL is not a break while the candle closes back above it.
    { time: START + 5 * HOUR, open: 158, high: 159, low: 153, close: 156 },
  ]

  const wickOnly = classifyExternalPivotPath(pivots, { candles })
  assert.equal(wickOnly.trend, 'up')
  assert.equal(wickOnly.event, null)

  const broken = classifyExternalPivotPath(pivots, {
    candles: [...candles, { time: START + 6 * HOUR, open: 156, high: 157, low: 152, close: 154 }],
  })
  assert.equal(broken.trend, 'down')
  assert.equal(broken.event.type, 'BOS_DOWN')
  assert.equal(broken.event.protectedPivot.price, 155)
  assert.equal(broken.activeRange.high.label, 'HH')
  assert.equal(broken.activeRange.high.price, 164)
  assert.equal(broken.activeRange.low.label, 'LL')
  assert.equal(broken.activeRange.low.price, 152)
  assert.deepEqual(broken.chartPivots.map((pivot) => pivot.label), ['HL', 'HH', 'LL'])
})

test('a completed continuation replaces the old BoS anchor with the current directional wave', () => {
  const downPivots = [
    { kind: 'low', price: 140, time: START },
    { kind: 'high', price: 155, time: START + HOUR },
    { kind: 'low', price: 145, time: START + 2 * HOUR },
    { kind: 'high', price: 170, time: START + 3 * HOUR },
    { kind: 'low', price: 140, time: START + 4 * HOUR },
    { kind: 'high', price: 164, time: START + 5 * HOUR },
    { kind: 'low', price: 136, time: START + 6 * HOUR },
  ]
  const downCandles = [
    { time: START, open: 141, high: 142, low: 140, close: 141 },
    { time: START + HOUR, open: 154, high: 155, low: 153, close: 154 },
    { time: START + 2 * HOUR, open: 146, high: 147, low: 145, close: 146 },
    { time: START + 3 * HOUR, open: 168, high: 170, low: 166, close: 171 },
    { time: START + 4 * HOUR, open: 146, high: 147, low: 140, close: 139 },
    { time: START + 5 * HOUR, open: 162, high: 164, low: 160, close: 161 },
    { time: START + 6 * HOUR, open: 138, high: 139, low: 136, close: 135 },
  ]
  const down = classifyExternalPivotPath(downPivots, { candles: downCandles })

  assert.equal(down.trend, 'down')
  assert.equal(down.event.type, 'BOS_DOWN')
  assert.deepEqual(
    [down.activeRange.high.label, down.activeRange.high.price, down.activeRange.low.label, down.activeRange.low.price],
    ['LH', 164, 'LL', 136]
  )
  assert.equal(down.activeRange.source, 'external-confirmed-directional-wave')
  assert.deepEqual(down.chartPivots.map((pivot) => pivot.label), ['LL', 'LH', 'LL'])

  const upPivots = [
    { kind: 'high', price: 170, time: START },
    { kind: 'low', price: 150, time: START + HOUR },
    { kind: 'high', price: 160, time: START + 2 * HOUR },
    { kind: 'low', price: 140, time: START + 3 * HOUR },
    { kind: 'high', price: 165, time: START + 4 * HOUR },
    { kind: 'low', price: 150, time: START + 5 * HOUR },
    { kind: 'high', price: 175, time: START + 6 * HOUR },
  ]
  const upCandles = [
    { time: START, open: 169, high: 170, low: 168, close: 169 },
    { time: START + HOUR, open: 151, high: 152, low: 150, close: 151 },
    { time: START + 2 * HOUR, open: 158, high: 160, low: 157, close: 159 },
    { time: START + 3 * HOUR, open: 142, high: 143, low: 140, close: 139 },
    { time: START + 4 * HOUR, open: 161, high: 165, low: 160, close: 161 },
    { time: START + 5 * HOUR, open: 152, high: 153, low: 150, close: 151 },
    { time: START + 6 * HOUR, open: 173, high: 175, low: 172, close: 176 },
  ]
  const up = classifyExternalPivotPath(upPivots, { candles: upCandles })

  assert.equal(up.trend, 'up')
  assert.equal(up.event.type, 'BOS_UP')
  assert.deepEqual(
    [up.activeRange.low.label, up.activeRange.low.price, up.activeRange.high.label, up.activeRange.high.price],
    ['HL', 150, 'HH', 175]
  )
  assert.equal(up.activeRange.source, 'external-confirmed-directional-wave')
  assert.deepEqual(up.chartPivots.map((pivot) => pivot.label), ['HH', 'HL', 'HH'])
})

test('a closed break of an active terminal extends the down wave before its next pivot is confirmed', () => {
  const pivots = [
    { kind: 'high', price: 120, close: 119, time: START },
    { kind: 'low', price: 100, close: 101, time: START + HOUR },
    { kind: 'high', price: 115, close: 114, time: START + 2 * HOUR },
    { kind: 'low', price: 90, close: 89, time: START + 3 * HOUR },
  ]
  const candles = [
    { time: START, open: 119, high: 120, low: 118, close: 119 },
    { time: START + HOUR, open: 101, high: 102, low: 100, close: 101 },
    { time: START + 2 * HOUR, open: 114, high: 115, low: 112, close: 114 },
    { time: START + 3 * HOUR, open: 91, high: 92, low: 90, close: 89 },
    // The wick at 84 closes back above the active LL, so it is not structural.
    { time: START + 4 * HOUR, open: 90, high: 92, low: 84, close: 91 },
    // This close breaks the old LL and the new wave ends at the wick low 82.
    { time: START + 5 * HOUR, open: 89, high: 90, low: 82, close: 85 },
  ]

  const path = classifyExternalPivotPath(pivots, { candles })

  assert.equal(path.trend, 'down')
  assert.equal(path.activeRange.source, 'external-closed-terminal-extension')
  assert.deepEqual(
    [path.activeRange.high.label, path.activeRange.high.price, path.activeRange.low.label, path.activeRange.low.price],
    ['LH', 115, 'LL', 82]
  )
  assert.deepEqual(path.chartPivots.map((pivot) => [pivot.label, pivot.time, pivot.price]), [
    ['LH', START + 2 * HOUR, 115], ['LL', START + 5 * HOUR, 82],
  ])
})

test('EURUSD-like down continuation reanchors the active wave at its latest confirmed LH', () => {
  const pivots = [
    { kind: 'low', price: 1.1200, close: 1.1210, time: START },
    { kind: 'high', price: 1.1300, close: 1.1290, time: START + HOUR },
    { kind: 'low', price: 1.1250, close: 1.1260, time: START + 2 * HOUR },
    { kind: 'high', price: 1.1390, close: 1.1400, time: START + 3 * HOUR },
    { kind: 'low', price: 1.1200, close: 1.1190, time: START + 4 * HOUR },
    // A lower high forms after the first bearish break. Its later close below
    // the terminal low confirms the next active LH -> LL wave.
    { kind: 'high', price: 1.1310, close: 1.1280, time: START + 5 * HOUR },
  ]
  const candles = [
    { time: START, open: 1.1210, high: 1.1220, low: 1.1200, close: 1.1210 },
    { time: START + HOUR, open: 1.1290, high: 1.1300, low: 1.1270, close: 1.1290 },
    { time: START + 2 * HOUR, open: 1.1260, high: 1.1280, low: 1.1250, close: 1.1260 },
    { time: START + 3 * HOUR, open: 1.1380, high: 1.1390, low: 1.1360, close: 1.1400 },
    { time: START + 4 * HOUR, open: 1.1220, high: 1.1230, low: 1.1200, close: 1.1190 },
    { time: START + 5 * HOUR, open: 1.1280, high: 1.1310, low: 1.1260, close: 1.1280 },
    { time: START + 6 * HOUR, open: 1.1180, high: 1.1200, low: 1.1150, close: 1.1140 },
  ]

  const path = classifyExternalPivotPath(pivots, { candles })

  assert.equal(path.trend, 'down')
  assert.deepEqual(
    [path.activeRange.high.label, path.activeRange.high.price, path.activeRange.high.time],
    ['LH', 1.1310, START + 5 * HOUR]
  )
  assert.deepEqual(
    [path.activeRange.low.label, path.activeRange.low.price, path.activeRange.low.time],
    ['LL', 1.1150, START + 6 * HOUR]
  )
  assert.deepEqual(path.chartPivots.map((pivot) => pivot.label), ['LH', 'LL'])
})

test('backward reconstruction takes the last candle-confirmed LH before the terminal LL', () => {
  const candles = Array.from({ length: 25 }, (_, index) => ({
    time: START + index * HOUR,
    open: 1.1280,
    high: 1.1290,
    low: 1.1260,
    close: 1.1280,
  }))
  candles[0] = { time: START, open: 1.1480, high: 1.1500, low: 1.1450, close: 1.1460 }
  candles[1] = { time: START + HOUR, open: 1.1420, high: 1.1450, low: 1.1400, close: 1.1420 }
  candles[3] = { time: START + 3 * HOUR, open: 1.1360, high: 1.1390, low: 1.1340, close: 1.1360 }
  // This taller candle keeps the later 1.131 high out of the five-candle
  // window, but it is far enough away not to invalidate the local two-candle
  // turn. This mirrors the EURUSD 1H regression: a valid LH was hidden by an
  // older, broader HH.
  candles[5] = { time: START + 5 * HOUR, open: 1.1300, high: 1.1320, low: 1.1260, close: 1.1280 }
  candles[8] = { time: START + 8 * HOUR, open: 1.1270, high: 1.1290, low: 1.1250, close: 1.1270 }
  // This high is absent from the broad source path but is a confirmed local
  // candle pivot. A later close below the preceding low makes it the latest
  // LH before the terminal LL.
  candles[10] = { time: START + 10 * HOUR, open: 1.1280, high: 1.1310, low: 1.1260, close: 1.1280 }
  candles[18] = { time: START + 18 * HOUR, open: 1.1240, high: 1.1250, low: 1.1220, close: 1.1215 }
  const path = classifyExternalPivotPath([
    { kind: 'high', price: 1.1500, close: 1.1460, time: START },
    { kind: 'low', price: 1.1400, close: 1.1420, time: START + HOUR },
    { kind: 'high', price: 1.1390, close: 1.1360, time: START + 3 * HOUR },
    { kind: 'low', price: 1.1220, close: 1.1215, time: START + 18 * HOUR },
  ], { candles })

  assert.equal(path.trend, 'down')
  assert.deepEqual(
    [path.activeRange.high.label, path.activeRange.high.price, path.activeRange.high.time],
    ['LH', 1.1310, START + 10 * HOUR]
  )
  assert.deepEqual(
    [path.activeRange.low.label, path.activeRange.low.price, path.activeRange.low.time],
    ['LL', 1.1220, START + 18 * HOUR]
  )
  assert.equal(path.activeRange.source, 'external-backward-active-wave')
  assert.deepEqual(path.chartPivots.slice(-2).map((pivot) => [pivot.label, pivot.time]), [
    ['LH', START + 10 * HOUR], ['LL', START + 18 * HOUR],
  ])
  assert.ok(path.chartPivots.every((pivot, index, sequence) => (
    index === 0 || pivot.kind !== sequence[index - 1].kind
  )))
})

test('EURUSD 1H-style continuation replaces an obsolete HH with the last confirmed local LH', () => {
  const candles = Array.from({ length: 25 }, (_, index) => ({
    time: START + index * HOUR,
    open: 1.1350,
    high: 1.1360,
    low: 1.1340,
    close: 1.1350,
  }))
  const set = (index, open, high, low, close) => {
    candles[index] = { time: START + index * HOUR, open, high, low, close }
  }
  set(0, 1.1500, 1.1500, 1.1450, 1.1460)
  set(1, 1.1320, 1.1350, 1.1300, 1.1320)
  set(2, 1.1350, 1.1360, 1.1320, 1.1350)
  set(3, 1.1380, 1.1390, 1.1360, 1.1380)
  set(4, 1.1360, 1.1380, 1.1350, 1.1360)
  set(5, 1.1410, 1.14163, 1.1390, 1.1410)
  set(6, 1.1370, 1.1390, 1.1360, 1.1370)
  // The first close below the protected HL establishes a down structure.
  set(7, 1.1360, 1.1370, 1.1320, 1.1360)
  set(8, 1.1320, 1.1340, 1.13097, 1.1320)
  // This wick is a local low, but its close remains above the external LL.
  // It must not become the level used to reject the later local high.
  set(9, 1.1312, 1.1315, 1.1290, 1.1312)
  set(10, 1.1311, 1.1312, 1.1285, 1.1311)
  set(11, 1.1315, 1.1320, 1.1290, 1.1315)
  set(12, 1.1313, 1.1316, 1.1290, 1.1313)
  set(13, 1.1310, 1.1315, 1.1287, 1.1310)
  // The later close is below the structural LL at 1.13097, but remains above
  // the incidental 1.1285 wick. The 1.1320 high is therefore the active LH.
  set(20, 1.1300, 1.1310, 1.1220, 1.12917)

  const path = classifyExternalPivotPath([
    { kind: 'high', price: 1.1500, close: 1.1460, time: START },
    { kind: 'low', price: 1.1300, close: 1.1320, time: START + HOUR },
    { kind: 'high', price: 1.1390, close: 1.1380, time: START + 3 * HOUR },
    { kind: 'low', price: 1.1350, close: 1.1360, time: START + 4 * HOUR },
    { kind: 'high', price: 1.14163, close: 1.1410, time: START + 5 * HOUR },
    { kind: 'low', price: 1.13097, close: 1.1320, time: START + 8 * HOUR },
  ], { candles })

  assert.equal(path.trend, 'down')
  assert.deepEqual(
    [path.activeRange.high.kind, path.activeRange.high.label, path.activeRange.high.price, path.activeRange.high.time],
    ['high', 'LH', 1.1320, START + 11 * HOUR]
  )
  assert.deepEqual(
    [path.activeRange.low.kind, path.activeRange.low.label, path.activeRange.low.price, path.activeRange.low.time],
    ['low', 'LL', 1.1220, START + 20 * HOUR]
  )
  assert.equal(path.activeRange.source, 'external-backward-active-wave')
})

test('a structural close retains a type-correct active LH to LL wave for every asset and timeframe', () => {
  const timeframeMs = { '1h': HOUR, '4h': 4 * HOUR, '1d': 24 * HOUR }
  const baseBySymbol = {
    BTCUSD: 80000,
    EURUSD: 1.14,
    GBPUSD: 1.33,
    USDJPY: 157,
    USDCHF: 0.82,
    USDCAD: 1.42,
    AUDUSD: 0.70,
    NZDUSD: 0.56,
  }
  for (const asset of PRICE_ACTION_ASSETS) {
    for (const timeframe of PRICE_ACTION_TIMEFRAMES) {
      const scale = baseBySymbol[asset.symbol]
      const interval = timeframeMs[timeframe.id]
      const candles = Array.from({ length: 28 }, (_, index) => ({
        time: START + index * interval,
        open: scale * 0.986,
        high: scale * 0.994,
        low: scale * 0.982,
        close: scale * 0.986,
      }))
      const set = (index, open, high, low, close) => {
        candles[index] = {
          time: START + index * interval,
          open: scale * open,
          high: scale * high,
          low: scale * low,
          close: scale * close,
        }
      }
      set(0, 1.050, 1.050, 1.045, 1.046)
      set(1, 0.982, 0.985, 0.980, 0.982)
      set(2, 1.000, 1.002, 0.985, 0.998)
      set(3, 1.038, 1.040, 1.035, 1.038)
      set(4, 0.995, 1.000, 0.990, 0.995)
      set(5, 1.043, 1.045, 1.039, 1.043)
      set(6, 0.988, 0.989, 0.986, 0.987)
      set(7, 0.991, 0.992, 0.986, 0.991)
      set(8, 0.987, 0.990, 0.985, 0.987)
      set(9, 0.987, 0.992, 0.983, 0.987)
      set(10, 0.987, 0.993, 0.980, 0.987)
      set(11, 0.990, 0.995, 0.985, 0.990)
      set(12, 0.988, 0.994, 0.985, 0.988)
      set(13, 0.986, 0.993, 0.982, 0.986)
      set(20, 0.986, 0.990, 0.970, 0.984)

      const path = classifyExternalPivotPath([
        { kind: 'high', price: scale * 1.050, close: scale * 1.046, time: START },
        { kind: 'low', price: scale * 0.980, close: scale * 0.982, time: START + interval },
        { kind: 'high', price: scale * 1.040, close: scale * 1.038, time: START + 3 * interval },
        { kind: 'low', price: scale * 0.990, close: scale * 0.995, time: START + 4 * interval },
        { kind: 'high', price: scale * 1.045, close: scale * 1.043, time: START + 5 * interval },
        { kind: 'low', price: scale * 0.985, close: scale * 0.987, time: START + 8 * interval },
      ], { candles })

      assert.equal(path.trend, 'down', `${asset.symbol} ${timeframe.id}`)
      assert.deepEqual(
        [path.activeRange.high.kind, path.activeRange.high.label, path.activeRange.high.time],
        ['high', 'LH', START + 11 * interval],
        `${asset.symbol} ${timeframe.id}`
      )
      assert.deepEqual(
        [path.activeRange.low.kind, path.activeRange.low.label, path.activeRange.low.time],
        ['low', 'LL', START + 20 * interval],
        `${asset.symbol} ${timeframe.id}`
      )
    }
  }
})

test('a local two-candle high cannot replace the active origin without a later closing break', () => {
  const candles = Array.from({ length: 25 }, (_, index) => ({
    time: START + index * HOUR,
    open: 1.1280,
    high: 1.1290,
    low: 1.1260,
    close: 1.1280,
  }))
  candles[0] = { time: START, open: 1.1480, high: 1.1500, low: 1.1450, close: 1.1460 }
  candles[1] = { time: START + HOUR, open: 1.1420, high: 1.1450, low: 1.1400, close: 1.1420 }
  candles[3] = { time: START + 3 * HOUR, open: 1.1360, high: 1.1390, low: 1.1340, close: 1.1360 }
  candles[5] = { time: START + 5 * HOUR, open: 1.1300, high: 1.1320, low: 1.1260, close: 1.1280 }
  candles[8] = { time: START + 8 * HOUR, open: 1.1270, high: 1.1290, low: 1.1250, close: 1.1270 }
  candles[10] = { time: START + 10 * HOUR, open: 1.1280, high: 1.1310, low: 1.1260, close: 1.1280 }
  // The terminal wick is lower, but its close remains above the preceding
  // structural LL. That high must stay an unconfirmed reaction.
  candles[18] = { time: START + 18 * HOUR, open: 1.1265, high: 1.1270, low: 1.1220, close: 1.1260 }

  const path = classifyExternalPivotPath([
    { kind: 'high', price: 1.1500, close: 1.1460, time: START },
    { kind: 'low', price: 1.1400, close: 1.1420, time: START + HOUR },
    { kind: 'high', price: 1.1390, close: 1.1360, time: START + 3 * HOUR },
    { kind: 'low', price: 1.1250, close: 1.1270, time: START + 8 * HOUR },
  ], { candles })

  assert.equal(path.trend, 'down')
  assert.equal(path.activeRange.high.price, 1.1390)
  assert.notEqual(path.activeRange.high.price, 1.1310)
})

test('backward active-wave reconstruction uses the local 1H pivot and preserves broad 4H/1D waves for every asset', () => {
  const timeframeMs = { '1h': HOUR, '4h': 4 * HOUR, '1d': 24 * HOUR }
  const baseBySymbol = {
    BTCUSD: 80000,
    EURUSD: 1.14,
    GBPUSD: 1.33,
    USDJPY: 157,
    USDCHF: 0.82,
    USDCAD: 1.42,
    AUDUSD: 0.70,
    NZDUSD: 0.56,
  }
  for (const asset of PRICE_ACTION_ASSETS) {
    for (const timeframe of PRICE_ACTION_TIMEFRAMES) {
      const interval = timeframeMs[timeframe.id]
      const base = baseBySymbol[asset.symbol]
      const step = base * 0.01
      const candles = Array.from({ length: 25 }, (_, index) => ({
        time: START + index * interval,
        open: base,
        high: base + step * 0.2,
        low: base - step * 0.2,
        close: base,
      }))
      candles[0] = { time: START, open: base + step, high: base + step * 2, low: base + step * 1.5, close: base + step * 1.6 }
      candles[1] = { time: START + interval, open: base + step, high: base + step * 1.4, low: base + step, close: base + step * 1.2 }
      candles[3] = { time: START + 3 * interval, open: base + step * 0.9, high: base + step * 1.5, low: base + step * 0.7, close: base + step * 0.9 }
      // A wider five-candle high hides the later local turn from the old
      // detector. The active-wave detector must still find the two-candle LH
      // once price subsequently closes through its preceding local low.
      candles[5] = { time: START + 5 * interval, open: base, high: base + step * 0.9, low: base - step * 0.2, close: base }
      candles[8] = { time: START + 8 * interval, open: base, high: base + step * 0.2, low: base - step * 0.4, close: base }
      candles[10] = { time: START + 10 * interval, open: base, high: base + step * 0.8, low: base - step * 0.2, close: base }
      candles[18] = { time: START + 18 * interval, open: base - step * 0.9, high: base - step * 0.7, low: base - step, close: base - step * 1.1 }
      const path = classifyExternalPivotPath([
        { kind: 'high', price: base + step * 2, close: base + step * 1.6, time: START },
        { kind: 'low', price: base + step, close: base + step * 1.2, time: START + interval },
        { kind: 'high', price: base + step * 1.5, close: base + step * 0.9, time: START + 3 * interval },
        { kind: 'low', price: base - step, close: base - step * 1.1, time: START + 18 * interval },
      ], { candles })

      assert.equal(path.trend, 'down', `${asset.symbol} ${timeframe.id}`)
      const usesNarrowHourWave = timeframe.id === '1h'
      assert.equal(
        path.activeRange.high.time,
        usesNarrowHourWave ? START + 10 * interval : START + 3 * interval,
        `${asset.symbol} ${timeframe.id}`
      )
      assert.equal(path.activeRange.low.time, START + 18 * interval, `${asset.symbol} ${timeframe.id}`)
      assert.equal(
        path.activeRange.source,
        usesNarrowHourWave ? 'external-backward-active-wave' : 'external-confirmed-directional-wave',
        `${asset.symbol} ${timeframe.id}`
      )
    }
  }
})

test('backward active-wave reconstruction mirrors 1H sensitivity while preserving 4H/1D waves for every asset', () => {
  const timeframeMs = { '1h': HOUR, '4h': 4 * HOUR, '1d': 24 * HOUR }
  const baseBySymbol = {
    BTCUSD: 80000,
    EURUSD: 1.14,
    GBPUSD: 1.33,
    USDJPY: 157,
    USDCHF: 0.82,
    USDCAD: 1.42,
    AUDUSD: 0.70,
    NZDUSD: 0.56,
  }
  for (const asset of PRICE_ACTION_ASSETS) {
    for (const timeframe of PRICE_ACTION_TIMEFRAMES) {
      const interval = timeframeMs[timeframe.id]
      const base = baseBySymbol[asset.symbol]
      const step = base * 0.01
      const candles = Array.from({ length: 25 }, (_, index) => ({
        time: START + index * interval,
        open: base,
        high: base + step * 0.2,
        low: base - step * 0.2,
        close: base,
      }))
      candles[0] = { time: START, open: base - step, high: base - step * 1.5, low: base - step * 2, close: base - step * 1.6 }
      candles[1] = { time: START + interval, open: base - step, high: base - step, low: base - step * 1.4, close: base - step * 1.2 }
      candles[3] = { time: START + 3 * interval, open: base - step * 0.9, high: base - step * 0.7, low: base - step * 1.5, close: base - step * 1.3 }
      // Symmetric case for an HL -> HH leg: the local low is valid after a
      // later closing break, even though a wider low sits five candles back.
      candles[5] = { time: START + 5 * interval, open: base, high: base + step * 0.2, low: base - step * 0.9, close: base }
      candles[8] = { time: START + 8 * interval, open: base, high: base + step * 0.4, low: base - step * 0.2, close: base }
      candles[10] = { time: START + 10 * interval, open: base, high: base + step * 0.2, low: base - step * 0.8, close: base }
      candles[18] = { time: START + 18 * interval, open: base + step * 0.9, high: base + step, low: base + step * 0.7, close: base + step * 1.1 }
      const path = classifyExternalPivotPath([
        { kind: 'low', price: base - step * 2, close: base - step * 1.6, time: START },
        { kind: 'high', price: base - step, close: base - step * 1.2, time: START + interval },
        { kind: 'low', price: base - step * 1.5, close: base - step * 1.3, time: START + 3 * interval },
        { kind: 'high', price: base + step, close: base + step * 1.1, time: START + 18 * interval },
      ], { candles })

      assert.equal(path.trend, 'up', `${asset.symbol} ${timeframe.id}`)
      const usesNarrowHourWave = timeframe.id === '1h'
      assert.equal(
        path.activeRange.low.time,
        usesNarrowHourWave ? START + 10 * interval : START + 3 * interval,
        `${asset.symbol} ${timeframe.id}`
      )
      assert.equal(path.activeRange.high.time, START + 18 * interval, `${asset.symbol} ${timeframe.id}`)
      assert.equal(
        path.activeRange.source,
        usesNarrowHourWave ? 'external-backward-active-wave' : 'external-confirmed-directional-wave',
        `${asset.symbol} ${timeframe.id}`
      )
    }
  }
})

test('up continuation reanchors the active wave at its latest confirmed HL', () => {
  const pivots = [
    { kind: 'high', price: 120, close: 119, time: START },
    { kind: 'low', price: 100, close: 101, time: START + HOUR },
    { kind: 'high', price: 115, close: 114, time: START + 2 * HOUR },
    { kind: 'low', price: 90, close: 89, time: START + 3 * HOUR },
    { kind: 'high', price: 116, close: 117, time: START + 4 * HOUR },
    { kind: 'low', price: 105, close: 106, time: START + 5 * HOUR },
  ]
  const candles = [
    { time: START, open: 119, high: 120, low: 118, close: 119 },
    { time: START + HOUR, open: 101, high: 102, low: 100, close: 101 },
    { time: START + 2 * HOUR, open: 114, high: 115, low: 112, close: 114 },
    { time: START + 3 * HOUR, open: 91, high: 92, low: 90, close: 89 },
    { time: START + 4 * HOUR, open: 115, high: 116, low: 112, close: 117 },
    { time: START + 5 * HOUR, open: 106, high: 108, low: 105, close: 106 },
    { time: START + 6 * HOUR, open: 117, high: 125, low: 116, close: 126 },
  ]

  const path = classifyExternalPivotPath(pivots, { candles })

  assert.equal(path.trend, 'up')
  assert.deepEqual(
    [path.activeRange.low.label, path.activeRange.low.price, path.activeRange.low.time],
    ['HL', 105, START + 5 * HOUR]
  )
  assert.deepEqual(
    [path.activeRange.high.label, path.activeRange.high.price, path.activeRange.high.time],
    ['HH', 125, START + 6 * HOUR]
  )
  assert.deepEqual(path.chartPivots.map((pivot) => pivot.label), ['HL', 'HH'])
})

test('continuation anchors use the latest confirmed counter swing for every supported asset and timeframe', () => {
  const timeframeMs = { '1h': HOUR, '4h': 4 * HOUR, '1d': 24 * HOUR }
  const baseBySymbol = {
    BTCUSD: 80000,
    EURUSD: 1.14,
    GBPUSD: 1.34,
    USDJPY: 157,
    USDCHF: 0.83,
    USDCAD: 1.4,
    AUDUSD: 0.71,
    NZDUSD: 0.57,
  }

  for (const asset of PRICE_ACTION_ASSETS) {
    for (const timeframe of PRICE_ACTION_TIMEFRAMES) {
      const period = timeframeMs[timeframe.id]
      const base = baseBySymbol[asset.symbol]
      const scale = base * 0.01
      const pivots = [
        { kind: 'low', price: base - scale * 2, close: base - scale * 1.9, time: START },
        { kind: 'high', price: base - scale, close: base - scale * 1.1, time: START + period },
        { kind: 'low', price: base - scale * 1.5, close: base - scale * 1.4, time: START + 2 * period },
        { kind: 'high', price: base, close: base + scale * 0.1, time: START + 3 * period },
        { kind: 'low', price: base - scale * 2, close: base - scale * 2.1, time: START + 4 * period },
        { kind: 'high', price: base - scale * 0.8, close: base - scale, time: START + 5 * period },
      ]
      const candles = [
        { time: START, open: base - scale * 1.9, high: base - scale * 1.8, low: base - scale * 2, close: base - scale * 1.9 },
        { time: START + period, open: base - scale * 1.1, high: base - scale, low: base - scale * 1.3, close: base - scale * 1.1 },
        { time: START + 2 * period, open: base - scale * 1.4, high: base - scale * 1.2, low: base - scale * 1.5, close: base - scale * 1.4 },
        { time: START + 3 * period, open: base - scale * 0.1, high: base, low: base - scale * 0.3, close: base + scale * 0.1 },
        { time: START + 4 * period, open: base - scale * 1.9, high: base - scale * 1.8, low: base - scale * 2, close: base - scale * 2.1 },
        { time: START + 5 * period, open: base - scale, high: base - scale * 0.8, low: base - scale * 1.3, close: base - scale },
        { time: START + 6 * period, open: base - scale * 2.1, high: base - scale * 1.9, low: base - scale * 2.5, close: base - scale * 2.6 },
      ]

      const path = classifyExternalPivotPath(pivots, { candles })

      assert.equal(path.trend, 'down', `${asset.symbol} ${timeframe.id}`)
      assert.equal(path.activeRange.high.label, 'LH', `${asset.symbol} ${timeframe.id}`)
      assert.equal(path.activeRange.high.time, START + 5 * period, `${asset.symbol} ${timeframe.id}`)
      assert.equal(path.activeRange.low.label, 'LL', `${asset.symbol} ${timeframe.id}`)
      assert.equal(path.activeRange.low.time, START + 6 * period, `${asset.symbol} ${timeframe.id}`)
    }
  }
})

test('a closed break of an active terminal extends the up wave before its next pivot is confirmed', () => {
  const pivots = [
    { kind: 'low', price: 80, close: 81, time: START },
    { kind: 'high', price: 100, close: 99, time: START + HOUR },
    { kind: 'low', price: 85, close: 86, time: START + 2 * HOUR },
    { kind: 'high', price: 110, close: 111, time: START + 3 * HOUR },
  ]
  const candles = [
    { time: START, open: 81, high: 82, low: 80, close: 81 },
    { time: START + HOUR, open: 99, high: 100, low: 98, close: 99 },
    { time: START + 2 * HOUR, open: 86, high: 87, low: 85, close: 86 },
    { time: START + 3 * HOUR, open: 109, high: 110, low: 108, close: 111 },
    // A wick alone over HH is ignored.
    { time: START + 4 * HOUR, open: 109, high: 118, low: 107, close: 109 },
    // The close confirms the new terminal, which retains its wick high.
    { time: START + 5 * HOUR, open: 111, high: 121, low: 110, close: 116 },
  ]

  const path = classifyExternalPivotPath(pivots, { candles })

  assert.equal(path.trend, 'up')
  assert.equal(path.activeRange.source, 'external-closed-terminal-extension')
  assert.deepEqual(
    [path.activeRange.low.label, path.activeRange.low.price, path.activeRange.high.label, path.activeRange.high.price],
    ['HL', 85, 'HH', 121]
  )
  assert.deepEqual(path.chartPivots.map((pivot) => [pivot.label, pivot.time, pivot.price]), [
    ['HL', START + 2 * HOUR, 85], ['HH', START + 5 * HOUR, 121],
  ])
})

test('closed-terminal extension behaves symmetrically for every supported asset and timeframe', () => {
  const timeframeMs = { '1h': HOUR, '4h': 4 * HOUR, '1d': 24 * HOUR }
  const baseBySymbol = {
    BTCUSD: 80000,
    EURUSD: 1.14,
    GBPUSD: 1.34,
    USDJPY: 157,
    USDCHF: 0.83,
    USDCAD: 1.4,
    AUDUSD: 0.71,
    NZDUSD: 0.57,
  }

  for (const [assetIndex, asset] of PRICE_ACTION_ASSETS.entries()) {
    for (const timeframe of PRICE_ACTION_TIMEFRAMES) {
      const step = baseBySymbol[asset.symbol] * 0.01
      const period = timeframeMs[timeframe.id]
      const up = (assetIndex + timeframe.hours) % 2 === 0
      const pivots = up
        ? [
            { kind: 'low', price: step * 96, close: step * 96.2, time: START },
            { kind: 'high', price: step * 104, close: step * 103.8, time: START + period },
            { kind: 'low', price: step * 98, close: step * 98.2, time: START + 2 * period },
            { kind: 'high', price: step * 106, close: step * 106.2, time: START + 3 * period },
          ]
        : [
            { kind: 'high', price: step * 104, close: step * 103.8, time: START },
            { kind: 'low', price: step * 96, close: step * 96.2, time: START + period },
            { kind: 'high', price: step * 102, close: step * 101.8, time: START + 2 * period },
            { kind: 'low', price: step * 94, close: step * 93.8, time: START + 3 * period },
          ]
      const terminal = up ? step * 109 : step * 91
      const candles = pivots.map((pivot) => ({
        time: pivot.time,
        open: pivot.close,
        high: pivot.kind === 'high' ? pivot.price : pivot.close + step,
        low: pivot.kind === 'low' ? pivot.price : pivot.close - step,
        close: pivot.close,
      }))
      candles.push(up
        ? { time: START + 4 * period, open: step * 106, high: terminal, low: step * 105, close: step * 107 }
        : { time: START + 4 * period, open: step * 94, high: step * 95, low: terminal, close: step * 93 })

      const path = classifyExternalPivotPath(pivots, { candles })
      const terminalPivot = up ? path.activeRange.high : path.activeRange.low

      assert.equal(path.trend, up ? 'up' : 'down', `${asset.symbol} ${timeframe.id}`)
      assert.equal(path.activeRange.source, 'external-closed-terminal-extension', `${asset.symbol} ${timeframe.id}`)
      assert.equal(terminalPivot.time, START + 4 * period, `${asset.symbol} ${timeframe.id}`)
      assert.equal(terminalPivot.price, terminal, `${asset.symbol} ${timeframe.id}`)
      assert.ok(path.activeRange.high.price > path.activeRange.low.price, `${asset.symbol} ${timeframe.id}`)
      assert.ok(path.activeRange.low.time < path.activeRange.high.time || !up, `${asset.symbol} ${timeframe.id}`)
      assert.ok(path.activeRange.high.time < path.activeRange.low.time || up, `${asset.symbol} ${timeframe.id}`)
    }
  }
})

test('a close through the protected LL after BoS up restores the down structure', () => {
  const pivots = [
    { kind: 'high', price: 120, close: 119, time: START },
    { kind: 'low', price: 100, close: 101, time: START + HOUR },
    { kind: 'high', price: 115, close: 114, time: START + 2 * HOUR },
    { kind: 'low', price: 95, close: 94, time: START + 3 * HOUR },
    { kind: 'high', price: 125, close: 126, time: START + 4 * HOUR },
    { kind: 'low', price: 90, close: 89, time: START + 5 * HOUR },
    { kind: 'high', price: 110, close: 109, time: START + 6 * HOUR },
    { kind: 'low', price: 85, close: 84, time: START + 7 * HOUR },
  ]
  const candles = pivots.map((pivot) => ({
    time: pivot.time,
    open: pivot.close,
    high: pivot.kind === 'high' ? pivot.price : pivot.close + 1,
    low: pivot.kind === 'low' ? pivot.price : pivot.close - 1,
    close: pivot.close,
  }))

  const path = classifyExternalPivotPath(pivots, { candles })

  assert.equal(path.trend, 'down')
  assert.equal(path.event.type, 'BOS_DOWN')
  assert.equal(path.event.time, START + 5 * HOUR)
  assert.equal(path.event.protectedPivot.price, 95)
  assert.deepEqual(
    [path.activeRange.high.label, path.activeRange.high.price, path.activeRange.low.label, path.activeRange.low.price],
    ['LH', 110, 'LL', 85]
  )
})

test('a delayed close cannot revive an obsolete protected HL after a newer up wave', () => {
  const pivots = [
    { kind: 'high', price: 100, close: 99, time: START },
    { kind: 'low', price: 80, close: 81, time: START + HOUR },
    { kind: 'high', price: 110, close: 111, time: START + 2 * HOUR },
    { kind: 'low', price: 95, close: 96, time: START + 3 * HOUR },
    { kind: 'high', price: 120, close: 121, time: START + 4 * HOUR },
    { kind: 'low', price: 105, close: 106, time: START + 5 * HOUR },
    { kind: 'high', price: 125, close: 126, time: START + 6 * HOUR },
    { kind: 'low', price: 100, close: 99, time: START + 7 * HOUR },
    { kind: 'high', price: 115, close: 114, time: START + 8 * HOUR },
    { kind: 'low', price: 90, close: 89, time: START + 9 * HOUR },
  ]
  const candles = pivots.map((pivot) => ({
    time: pivot.time,
    open: pivot.close,
    high: pivot.kind === 'high' ? pivot.price : pivot.close + 1,
    low: pivot.kind === 'low' ? pivot.price : pivot.close - 1,
    close: pivot.close,
  }))
  const path = classifyExternalPivotPath(pivots, { candles })

  assert.equal(path.trend, 'down')
  assert.equal(path.event.type, 'BOS_DOWN')
  assert.equal(path.event.time, START + 7 * HOUR)
  assert.equal(path.event.protectedPivot.price, 105)
  assert.deepEqual(
    [path.activeRange.high.label, path.activeRange.high.price, path.activeRange.low.label, path.activeRange.low.price],
    ['LH', 115, 'LL', 90]
  )
  assert.deepEqual(path.chartPivots.map((pivot) => [pivot.label, pivot.price]), [
    ['LL', 100], ['LH', 115], ['LL', 90],
  ])
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

test('precomputed historical candidates do not reveal an unconfirmed future pivot', () => {
  const candles = Array.from({ length: 48 }, (_, index) => ({
    time: START + index * HOUR,
    open: 1,
    close: 1,
    high: index === 12 ? 1.2 : 1.05,
    low: index === 29 ? 0.8 : 0.95,
    volume: 0,
  }))
  const precomputedCandidates = confirmedExternalPivotCandidates({
    candles,
    timeframeId: '1h',
    now: Infinity,
    candlesAreTimeframe: true,
  })
  const at = START + 25 * HOUR
  const direct = confirmedExternalPivotPath({ candles, timeframeId: '1h', now: at, candlesAreTimeframe: true })
  const cached = confirmedExternalPivotPath({
    candles,
    timeframeId: '1h',
    now: at,
    candlesAreTimeframe: true,
    precomputedCandidates,
  })

  assert.deepEqual(cached, direct)
  assert.equal(cached.pivots.some((pivot) => pivot.time === START + 29 * HOUR), false)
})

test('a missing external pivot result is not kept as a valid cache entry', () => {
  const assets = [{ symbol: 'EURUSD' }]
  const previous = {
    pivots: {
      schemaVersion: EXTERNAL_PIVOT_SCHEMA,
      buckets: { '4h': 5 },
      assets: { EURUSD: { '4h': null } },
    },
  }
  assert.equal(canReuseExternalPivotBucket({ previous, assets, timeframeId: '4h', bucket: 5 }), false)
  previous.pivots.assets.EURUSD['4h'] = { trend: 'flat', pivots: [] }
  assert.equal(canReuseExternalPivotBucket({ previous, assets, timeframeId: '4h', bucket: 5 }), true)
})
