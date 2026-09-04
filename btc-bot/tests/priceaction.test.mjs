import assert from 'node:assert/strict'
import test from 'node:test'
import {
  atr,
  buildZones,
  candleSignal,
  findSwings,
  lastDefined,
  marketStructure,
  nextSwingAbove,
  nextSwingBelow,
} from '../src/priceaction.mjs'
import { aggregate, dropForming, HOUR_MS } from '../src/candles.mjs'
import { candle, HOUR, START, zigzag } from './helpers.mjs'

test('ATR is null during warmup and positive afterwards', () => {
  const candles = zigzag([100, 110, 105, 120], { steps: 10 })
  const series = atr(candles, 14)
  assert.equal(series[0], null)
  assert.equal(series[13], null)
  assert.ok(series[14] > 0)
  assert.ok(lastDefined(series) > 0)
})

test('a swing needs confirmation on both sides, so the last candles can never be pivots', () => {
  const candles = zigzag([100, 120, 100, 130], { steps: 6 })
  const swings = findSwings(candles, 2)
  assert.ok(swings.length > 0)
  assert.ok(swings.every((swing) => swing.index <= candles.length - 3))
})

test('higher highs with higher lows read as an uptrend, the mirror as a downtrend', () => {
  const up = marketStructure(zigzag([100, 120, 112, 140, 130, 160], { steps: 6 }))
  assert.equal(up.bias, 'up')
  const down = marketStructure(zigzag([160, 130, 140, 112, 120, 100], { steps: 6 }))
  assert.equal(down.bias, 'down')
})

test('a sideways market is a range, not a weak trend', () => {
  const flat = marketStructure(zigzag([100, 110, 100, 110, 100, 110, 100], { steps: 6 }))
  assert.equal(flat.bias, 'range')
})

test('a close through the last swing low of an uptrend is a change of character', () => {
  const candles = zigzag([100, 120, 112, 140, 130, 160], { steps: 6 })
  const before = marketStructure(candles)
  const swingLow = before.lastLow.price
  candles.push(candle(candles.at(-1).time + HOUR, 150, 151, swingLow - 6, swingLow - 5))
  assert.equal(marketStructure(candles).event, 'CHoCH_DOWN')
})

test('repeated turns at one price merge into a single zone with a touch count', () => {
  const candles = zigzag([120, 100, 118, 100.5, 119, 100.2, 130], { steps: 6 })
  const demand = buildZones(candles).filter((zone) => zone.type === 'demand')
  const nearHundred = demand.filter((zone) => zone.low < 103)
  assert.equal(nearHundred.length, 1, 'three turns at ~100 should be one zone')
  assert.ok(nearHundred[0].touches >= 2, `expected repeat touches, got ${nearHundred[0].touches}`)
})

test('a bullish engulfing needs the body to cover the previous one', () => {
  const candles = [candle(START, 110, 111, 104, 105), candle(START + HOUR, 104, 112, 103, 111)]
  assert.equal(candleSignal(candles).bullish, 'bullish_engulfing')

  const notEngulfing = [candle(START, 110, 111, 104, 105), candle(START + HOUR, 106, 109, 105, 108)]
  assert.equal(candleSignal(notEngulfing).bullish, null)
})

test('a rejection candle needs a long wick against a small body and a close away from it', () => {
  const bullish = [candle(START, 110, 111, 109, 110), candle(START + HOUR, 108, 109.2, 100, 109)]
  assert.equal(candleSignal(bullish).bullish, 'bullish_rejection')

  const bearish = [candle(START, 100, 101, 99, 100), candle(START + HOUR, 101, 110, 100.8, 101.2)]
  assert.equal(candleSignal(bearish).bearish, 'bearish_rejection')
})

test('a candle smaller than a fraction of ATR is not a signal, however it is shaped', () => {
  const candles = [candle(START, 110, 111, 104, 105), candle(START + HOUR, 104, 112, 103, 111)]
  assert.equal(candleSignal(candles, 1, { atrValue: 100 }).bullish, null)
})

test('structural targets are the nearest swing beyond the price, not the furthest', () => {
  const structure = marketStructure(zigzag([100, 120, 110, 140, 128, 160, 150], { steps: 6 }))
  const above = nextSwingAbove(structure, 125)
  assert.ok(above.price > 125)
  assert.ok(structure.highs.every((swing) => swing.price <= 125 || swing.price >= above.price))
  const below = nextSwingBelow(structure, 125)
  assert.ok(below.price < 125)
  assert.ok(structure.lows.every((swing) => swing.price >= 125 || swing.price <= below.price))
})

test('4h buckets align to the UTC clock and drop the incomplete tail', () => {
  const hourly = Array.from({ length: 10 }, (_, index) =>
    candle(Date.UTC(2026, 0, 1, index), 100 + index, 101 + index, 99 + index, 100.5 + index)
  )
  const fourHour = aggregate(hourly, 4)
  assert.deepEqual(
    fourHour.map((bucket) => new Date(bucket.time).getUTCHours()),
    [0, 4]
  )
  assert.equal(fourHour[0].open, hourly[0].open)
  assert.equal(fourHour[0].close, hourly[3].close)
  assert.equal(fourHour[0].high, Math.max(...hourly.slice(0, 4).map((c) => c.high)))
  assert.equal(fourHour[0].low, Math.min(...hourly.slice(0, 4).map((c) => c.low)))
})

test('a candle that has not closed yet is dropped', () => {
  const hourly = [candle(START, 1, 2, 0.5, 1.5), candle(START + HOUR, 1, 2, 0.5, 1.5)]
  assert.equal(dropForming(hourly, HOUR_MS, START + HOUR + 60_000).length, 1)
  assert.equal(dropForming(hourly, HOUR_MS, START + 2 * HOUR).length, 2)
})
