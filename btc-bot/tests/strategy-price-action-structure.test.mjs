import assert from 'node:assert/strict'
import test from 'node:test'

import {
  activeSupplyDemandZones,
  buildPriceActionMatrix,
  classifyStructure,
  evaluateTradeProfile,
  fetchStooqCandles,
  PRICE_ACTION_ASSETS,
  PRICE_ACTION_MATRIX_SCHEMA,
  PRICE_ACTION_STRUCTURE_PROFILES,
} from '../src/strategy-price-action-structure.mjs'
import { candle, HOUR, START, zigzag } from './helpers.mjs'

test('price-action structure classifies trend from confirmed swings', () => {
  const up = classifyStructure(zigzag([100, 120, 112, 140, 130, 160], { steps: 8 }), { minCandles: 20 })
  assert.equal(up.trend, 'up')
  assert.equal(up.status, 'met')
  assert.match(up.reason, /HH/)
  assert.match(up.reason, /HL/)
  assert.equal(up.structure.high.label, 'HH')
  assert.equal(up.structure.low.label, 'HL')
  assert.ok(up.structure.high.previous.price < up.structure.high.current.price)
  assert.ok(up.structure.low.previous.price < up.structure.low.current.price)
  assert.ok(up.structure.recentSwings.length > 0)

  const down = classifyStructure(zigzag([160, 130, 140, 112, 120, 100], { steps: 8 }), { minCandles: 20 })
  assert.equal(down.trend, 'down')
  assert.equal(down.status, 'unmet')
  assert.match(down.reason, /LH/)
  assert.match(down.reason, /LL/)
  assert.equal(down.structure.high.label, 'LH')
  assert.equal(down.structure.low.label, 'LL')
  assert.ok(down.structure.high.previous.price > down.structure.high.current.price)
  assert.ok(down.structure.low.previous.price > down.structure.low.current.price)

  const flat = classifyStructure(zigzag([100, 110, 100, 110, 100, 110], { steps: 8 }), { minCandles: 20 })
  assert.equal(flat.trend, 'flat')
  assert.equal(flat.status, 'neutral')
})

test('Stooq CSV parser accepts daily and intraday historical rows through the fetch wrapper', async () => {
  const csv = [
    'Date,Time,Open,High,Low,Close,Volume',
    '2026-09-10,10:00:00,1.10,1.12,1.09,1.11,0',
    '2026-09-10,11:00:00,1.11,1.13,1.10,1.12,0',
  ].join('\n')
  const fetchImpl = async () => ({
    ok: true,
    text: async () => csv,
  })

  const candles = await fetchStooqCandles({ symbol: 'eurusd', fetchImpl, now: START })
  assert.equal(candles.length, 2)
  assert.equal(candles[0].open, 1.1)
  assert.equal(candles[1].close, 1.12)
})

test('structure labels require candle closes beyond previous swing wicks', () => {
  const wickOnlyHighBreak = [
    candle(START, 95, 100, 92, 96),
    candle(START + 1 * HOUR, 96, 110, 94, 108),
    candle(START + 2 * HOUR, 108, 105, 96, 100),
    candle(START + 3 * HOUR, 100, 102, 90, 94),
    candle(START + 4 * HOUR, 94, 108, 95, 106),
    candle(START + 5 * HOUR, 106, 112, 101, 109),
    candle(START + 6 * HOUR, 109, 107, 98, 101),
    candle(START + 7 * HOUR, 101, 103, 93, 96),
    candle(START + 8 * HOUR, 96, 104, 95, 102),
  ]
  const highSweep = classifyStructure(wickOnlyHighBreak, { lookback: 1, minCandles: 8 })
  assert.equal(highSweep.structure.high.previous.price, 110)
  assert.equal(highSweep.structure.high.current.price, 112)
  assert.equal(highSweep.structure.high.current.close, 109)
  assert.equal(highSweep.structure.high.label, 'LH')
  assert.equal(highSweep.structure.low.label, 'HL')
  assert.equal(highSweep.trend, 'flat')

  const closeConfirmedHighBreak = wickOnlyHighBreak.map((item, index) =>
    index === 5 ? { ...item, close: 111 } : item
  )
  const highBreak = classifyStructure(closeConfirmedHighBreak, { lookback: 1, minCandles: 8 })
  assert.equal(highBreak.structure.high.label, 'HH')

  const wickOnlyLowBreak = wickOnlyHighBreak.map((item, index) =>
    index === 7 ? { ...item, low: 88, close: 91 } : item
  )
  const lowSweep = classifyStructure(wickOnlyLowBreak, { lookback: 1, minCandles: 8 })
  assert.equal(lowSweep.structure.low.previous.price, 90)
  assert.equal(lowSweep.structure.low.current.price, 88)
  assert.equal(lowSweep.structure.low.current.close, 91)
  assert.equal(lowSweep.structure.low.label, 'HL')

  const closeConfirmedLowBreak = wickOnlyHighBreak.map((item, index) =>
    index === 7 ? { ...item, low: 88, close: 89 } : item
  )
  const lowBreak = classifyStructure(closeConfirmedLowBreak, { lookback: 1, minCandles: 8 })
  assert.equal(lowBreak.structure.low.label, 'LL')
})

test('a recent close through a major counter-swing changes the established trend', () => {
  const established = zigzag([100, 120, 112, 140, 130, 160], { steps: 8 })
  const before = classifyStructure(established, { lookback: 2, minCandles: 20 })
  assert.equal(before.trend, 'up')

  const wickSweep = [
    ...established,
    candle(established.at(-1).time + HOUR, 155, 156, before.structure.low.current.price - 2, before.structure.low.current.price + 1),
  ]
  const afterWick = classifyStructure(wickSweep, { lookback: 2, minCandles: 20 })
  assert.equal(afterWick.trend, 'up')
  assert.notEqual(afterWick.event, 'CHoCH_DOWN')

  const broken = [
    ...wickSweep,
    candle(wickSweep.at(-1).time + HOUR, 131, 133, 120, before.structure.low.current.price - 1),
  ]
  const after = classifyStructure(broken, { lookback: 2, minCandles: 20 })
  assert.equal(after.establishedTrend, 'up')
  assert.equal(after.trend, 'down')
  assert.equal(after.event, 'CHoCH_DOWN')
  assert.equal(after.eventDetail.referencePrice, before.structure.low.current.price)
})

test('mixed local pivots do not erase the established external trend', () => {
  const upWithPullback = classifyStructure(
    zigzag([100, 120, 110, 140, 125, 135, 130, 134], { steps: 8 }),
    { lookback: 2, minCandles: 20 }
  )
  assert.equal(upWithPullback.structure.high.label, 'LH')
  assert.equal(upWithPullback.structure.low.label, 'HL')
  assert.equal(upWithPullback.trend, 'up')
  assert.match(upWithPullback.reason, /obrat nepotvrdily/)

  const downWithBounce = classifyStructure(
    zigzag([160, 130, 150, 110, 140, 120, 135, 122], { steps: 8 }),
    { lookback: 2, minCandles: 20 }
  )
  assert.equal(downWithBounce.structure.high.label, 'LH')
  assert.equal(downWithBounce.structure.low.label, 'HL')
  assert.equal(downWithBounce.trend, 'down')
  assert.match(downWithBounce.reason, /obrat nepotvrdily/)
})

test('structure horizons and pivot widths scale with timeframe', () => {
  assert.deepEqual(PRICE_ACTION_STRUCTURE_PROFILES, {
    '1h': { historyDays: 60, pivotLookback: 48, minCandles: 500 },
    '4h': { historyDays: 180, pivotLookback: 42, minCandles: 250 },
    '1d': { historyDays: 400, pivotLookback: 30, minCandles: 160 },
  })
  assert.ok(PRICE_ACTION_STRUCTURE_PROFILES['1d'].historyDays > 365)
  assert.ok(PRICE_ACTION_STRUCTURE_PROFILES['4h'].historyDays >= 180)
  assert.ok(PRICE_ACTION_STRUCTURE_PROFILES['1h'].historyDays >= 30)
})

test('supply and demand zones stay valid unless their own timeframe closes through them', () => {
  const candles = [
    candle(START, 110, 112, 108, 111),
    candle(START + 1 * HOUR, 111, 121, 110, 120),
    candle(START + 2 * HOUR, 120, 119, 104, 106),
    candle(START + 3 * HOUR, 106, 107, 99, 101),
    candle(START + 4 * HOUR, 101, 115, 100, 114),
    candle(START + 5 * HOUR, 114, 113, 105, 107),
    candle(START + 6 * HOUR, 107, 118, 106, 117),
    candle(START + 7 * HOUR, 117, 116, 109, 112),
    // Trades back into the demand wick range but closes above the zone.
    // This is the higher-timeframe equivalent of a lower-timeframe fill:
    // informative, but not an invalidation and not a same-TF close fill.
    candle(START + 8 * HOUR, 112, 114, 100, 111),
    candle(START + 9 * HOUR, 111, 115, 110, 114),
  ]

  const zones = activeSupplyDemandZones(candles, { lookback: 1, maxAgeCandles: 100 })
  assert.ok(zones.demand, 'expected a demand zone')
  assert.ok(zones.supply, 'expected a supply zone')
  assert.equal(zones.demand.invalidatedByOwnTimeframeClose, false)
  assert.equal(zones.demand.filledByOwnTimeframeClose, false)
  assert.equal(zones.demand.low, 99)
  assert.equal(zones.supply.invalidatedByOwnTimeframeClose, false)
  assert.match(zones.rule, /vlastním timeframe/)

  const invalidated = activeSupplyDemandZones([
    ...candles,
    candle(START + 10 * HOUR, 114, 116, 97, 98),
    candle(START + 11 * HOUR, 98, 108, 96, 106),
  ], { lookback: 1, maxAgeCandles: 100 })
  assert.equal(invalidated.demand, null)
  assert.equal(invalidated.latestValidDemand, null)
})

test('trade profile requires S/D zone hit, 50 percent pullback and at least 2R', () => {
  const item = {
    trend: 'up',
    reason: 'HH + HL',
    event: null,
    price: 103,
    lastCandle: candle(START, 106, 107, 102, 103),
    candleSignal: { bullish: 'bullish_rejection', bearish: null, patterns: ['bullish_rejection'] },
    structure: {
      high: { current: { price: 120 } },
      low: { current: { price: 100 } },
    },
    zones: {
      demand: { type: 'demand', low: 100, high: 105 },
      supply: null,
      latestValidDemand: { type: 'demand', low: 100, high: 105 },
      latestValidSupply: null,
      unfilledDemand: [{ type: 'demand', low: 100, high: 105 }],
      unfilledSupply: [{ type: 'supply', low: 140, high: 145 }],
    },
  }

  const profile = evaluateTradeProfile({
    item,
    lowerItem: { trend: 'up', event: null, structure: { low: { current: { price: 101 } } } },
    lowerTimeframeId: '1h',
    settings: { pullbackPct: 50, minRewardRisk: 2, riskPct: 1, stopBufferPct: 0.02 },
  })

  assert.equal(profile.status, 'ready')
  assert.equal(profile.side, 'long')
  assert.equal(profile.riskPct, 1)
  assert.equal(profile.zoneHit, true)
  assert.ok(profile.rewardRisk >= 2)
  assert.equal(profile.tp1, 120)
  assert.equal(profile.tp2, 140)
  assert.equal(profile.invalidation.invalidatingTrend, false)
  assert.equal(profile.refinement.status, 'met')

  const withoutHit = evaluateTradeProfile({
    item: {
      ...item,
      lastCandle: candle(START + HOUR, 115, 116, 114, 115),
      price: 115,
    },
    settings: { pullbackPct: 50, minRewardRisk: 2, riskPct: 1, stopBufferPct: 0.02 },
  })
  assert.equal(withoutHit.status, 'watch')
  assert.equal(withoutHit.gates.find((entry) => entry.id === 'zone').status, 'unmet')
})

test('trade profile marks lower-timeframe structure change as invalidation context', () => {
  const item = {
    trend: 'up',
    reason: 'HH + HL',
    price: 103,
    lastCandle: candle(START, 106, 107, 102, 103),
    candleSignal: null,
    structure: {
      high: { current: { price: 120 } },
      low: { current: { price: 100 } },
    },
    zones: {
      demand: { type: 'demand', low: 100, high: 105 },
      unfilledSupply: [{ type: 'supply', low: 140, high: 145 }],
    },
  }
  const profile = evaluateTradeProfile({
    item,
    lowerItem: {
      trend: 'down',
      event: 'CHoCH_DOWN',
      structure: { low: { current: { price: 101.5 } } },
    },
    lowerTimeframeId: '1h',
    settings: { pullbackPct: 50, minRewardRisk: 2, riskPct: 1, stopBufferPct: 0.02 },
  })
  assert.equal(profile.invalidation.status, 'unmet')
  assert.equal(profile.invalidation.invalidatingTrend, true)
  assert.equal(profile.invalidation.closeTrigger, 101.5)
})

test('price-action matrix covers BTCUSD and major FX pairs on 1H, 4H and 1D', async () => {
  const btcHourly = Array.from({ length: 240 }, (_, index) =>
    candle(START + index * HOUR, 100 + index * 0.2, 101 + index * 0.2, 99 + index * 0.2, 100.5 + index * 0.2)
  )
  const fetchImpl = async () => ({
    ok: true,
    json: async () => ({
      chart: {
        result: [
          {
            timestamp: Array.from({ length: 240 }, (_, index) => Math.round((START + index * HOUR) / 1000)),
            indicators: {
              quote: [
                {
                  open: Array.from({ length: 240 }, (_, index) => 1 + index * 0.001),
                  high: Array.from({ length: 240 }, (_, index) => 1.01 + index * 0.001),
                  low: Array.from({ length: 240 }, (_, index) => 0.99 + index * 0.001),
                  close: Array.from({ length: 240 }, (_, index) => 1.005 + index * 0.001),
                  volume: Array.from({ length: 240 }, () => 0),
                },
              ],
            },
          },
        ],
      },
    }),
    text: async () => 'Exceeded',
  })

  const matrix = await buildPriceActionMatrix({
    btcHourly,
    fetchImpl,
    now: START + 240 * HOUR,
    settings: { refreshMinutes: 0, minCandles: 20 },
    logger: { warn() {} },
  })

  assert.equal(matrix.assets.length, PRICE_ACTION_ASSETS.length)
  assert.ok(matrix.assets.some((asset) => asset.symbol === 'BTCUSD'))
  assert.ok(matrix.assets.some((asset) => asset.symbol === 'EURUSD'))
  for (const asset of matrix.assets) {
    assert.deepEqual(Object.keys(asset.trends), ['1h', '4h', '1d'])
  }
  assert.equal(matrix.assets[0].trends['1h'].structure.lookback, 48)
  assert.equal(matrix.assets[0].trends['1h'].structure.historyDays, 60)
  assert.equal(matrix.assets[0].trends['4h'].structure.lookback, 42)
  assert.equal(matrix.assets[0].trends['4h'].structure.historyDays, 180)
  assert.ok(matrix.assets[0].trends['4h'].zones)
  assert.ok(matrix.assets[0].trends['4h'].tradeProfile)
})

test('fresh price-action matrix is reused instead of refetching every bot pass', async () => {
  const previous = {
    schemaVersion: PRICE_ACTION_MATRIX_SCHEMA,
    generatedAt: new Date(START).toISOString(),
    assets: PRICE_ACTION_ASSETS.map((asset) => ({
      symbol: asset.symbol,
      trends: {
        '1h': { structure: {} },
        '4h': { structure: {} },
        '1d': { structure: {} },
      },
    })),
  }
  const matrix = await buildPriceActionMatrix({
    previous,
    now: START + 10 * 60_000,
    settings: { refreshMinutes: 60 },
    fetchImpl: async () => {
      throw new Error('should not fetch')
    },
  })
  assert.equal(matrix, previous)
})

test('stored hourly price-action refresh is capped so entry profiles are checked every 15 minutes', async () => {
  const previous = {
    schemaVersion: PRICE_ACTION_MATRIX_SCHEMA,
    generatedAt: new Date(START).toISOString(),
    assets: PRICE_ACTION_ASSETS.map((asset) => ({
      symbol: asset.symbol,
      trends: {
        '1h': { structure: {} },
        '4h': { structure: {} },
        '1d': { structure: {} },
      },
    })),
  }
  const btcHourly = Array.from({ length: 240 }, (_, index) =>
    candle(START + index * HOUR, 100 + index * 0.2, 101 + index * 0.2, 99 + index * 0.2, 100.5 + index * 0.2)
  )
  const fetchImpl = async () => ({
    ok: true,
    json: async () => ({
      chart: {
        result: [
          {
            timestamp: Array.from({ length: 240 }, (_, index) => Math.round((START + index * HOUR) / 1000)),
            indicators: {
              quote: [
                {
                  open: Array.from({ length: 240 }, (_, index) => 1 + index * 0.001),
                  high: Array.from({ length: 240 }, (_, index) => 1.01 + index * 0.001),
                  low: Array.from({ length: 240 }, (_, index) => 0.99 + index * 0.001),
                  close: Array.from({ length: 240 }, (_, index) => 1.005 + index * 0.001),
                  volume: Array.from({ length: 240 }, () => 0),
                },
              ],
            },
          },
        ],
      },
    }),
    text: async () => 'Exceeded',
  })

  const matrix = await buildPriceActionMatrix({
    btcHourly,
    previous,
    now: START + 20 * 60_000,
    settings: { refreshMinutes: 60, minCandles: 20 },
    fetchImpl,
    logger: { warn() {} },
  })
  assert.notEqual(matrix, previous)
  assert.equal(matrix.refreshMinutes, 15)
})

test('a fresh but schema-old matrix is rebuilt so the UI can show pivot details', async () => {
  const previous = { generatedAt: new Date(START).toISOString(), assets: [{ symbol: 'BTCUSD', trends: { '4h': { trend: 'up' } } }] }
  const btcHourly = Array.from({ length: 240 }, (_, index) =>
    candle(START + index * HOUR, 100 + index * 0.2, 101 + index * 0.2, 99 + index * 0.2, 100.5 + index * 0.2)
  )
  const fetchImpl = async () => ({
    ok: true,
    json: async () => ({
      chart: {
        result: [
          {
            timestamp: Array.from({ length: 240 }, (_, index) => Math.round((START + index * HOUR) / 1000)),
            indicators: {
              quote: [
                {
                  open: Array.from({ length: 240 }, (_, index) => 1 + index * 0.001),
                  high: Array.from({ length: 240 }, (_, index) => 1.01 + index * 0.001),
                  low: Array.from({ length: 240 }, (_, index) => 0.99 + index * 0.001),
                  close: Array.from({ length: 240 }, (_, index) => 1.005 + index * 0.001),
                  volume: Array.from({ length: 240 }, () => 0),
                },
              ],
            },
          },
        ],
      },
    }),
    text: async () => 'Exceeded',
  })

  const matrix = await buildPriceActionMatrix({
    btcHourly,
    previous,
    fetchImpl,
    now: START + 10 * 60_000,
    settings: { refreshMinutes: 60, minCandles: 20 },
    logger: { warn() {} },
  })
  assert.notEqual(matrix, previous)
  assert.ok(matrix.assets[0].trends['4h'].structure)
})
