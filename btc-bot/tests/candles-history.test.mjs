import assert from 'node:assert/strict'
import test from 'node:test'

import { fetchBinanceCandles, fetchCandles } from '../src/candles.mjs'

const row = (time, close = 100) => [
  time,
  String(close),
  String(close + 2),
  String(close - 2),
  String(close + 1),
  '1',
]

test('Binance candles page backwards for long history requests', async () => {
  let calls = 0
  const fetchImpl = async (url) => {
    calls += 1
    const parsed = new URL(url)
    const limit = Number(parsed.searchParams.get('limit'))
    assert.ok(parsed.searchParams.has('endTime'))
    const start = calls === 1 ? 1_000_000 : 1_000_000 - limit * 3600_000
    return {
      ok: true,
      status: 200,
      json: async () => Array.from({ length: limit }, (_, index) => row(start + index * 3600_000, 100 + index)),
    }
  }

  const candles = await fetchBinanceCandles({ limit: 1001, fetchImpl, pauseMs: 0 })

  assert.equal(calls, 2)
  assert.equal(candles.length, 1001)
  assert.ok(candles[0].time < candles.at(-1).time)
})

test('fetchCandles uses Binance pagination above one exchange page', async () => {
  let calls = 0
  const fetchImpl = async (url) => {
    calls += 1
    const parsed = new URL(url)
    const limit = Number(parsed.searchParams.get('limit'))
    return {
      ok: true,
      status: 200,
      json: async () => Array.from({ length: limit }, (_, index) => row(2_000_000 - calls * 10_000_000 + index * 3600_000)),
    }
  }

  const candles = await fetchCandles({ source: 'binance', limit: 1001, fetchImpl })

  assert.equal(calls, 2)
  assert.equal(candles.length, 1001)
})
