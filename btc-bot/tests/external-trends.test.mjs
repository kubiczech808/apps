import assert from 'node:assert/strict'
import test from 'node:test'

import { classifyExternalTrend, fetchTwelveDataFxHourly } from '../src/external-trends.mjs'
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
})
