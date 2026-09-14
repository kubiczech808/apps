import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildPriceActionMatrix,
  classifyStructure,
  fetchStooqCandles,
  PRICE_ACTION_ASSETS,
} from '../src/strategy-price-action-structure.mjs'
import { candle, HOUR, START, zigzag } from './helpers.mjs'

test('price-action structure classifies trend from confirmed swings', () => {
  const up = classifyStructure(zigzag([100, 120, 112, 140, 130, 160], { steps: 8 }), { minCandles: 20 })
  assert.equal(up.trend, 'up')
  assert.equal(up.status, 'met')
  assert.match(up.reason, /HH/)
  assert.match(up.reason, /HL/)

  const down = classifyStructure(zigzag([160, 130, 140, 112, 120, 100], { steps: 8 }), { minCandles: 20 })
  assert.equal(down.trend, 'down')
  assert.equal(down.status, 'unmet')
  assert.match(down.reason, /LH/)
  assert.match(down.reason, /LL/)

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
})

test('fresh price-action matrix is reused instead of refetching every bot pass', async () => {
  const previous = { generatedAt: new Date(START).toISOString(), assets: [{ symbol: 'BTCUSD' }] }
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
