import assert from 'node:assert/strict'
import test from 'node:test'
import {
  alternatingSwings,
  atr,
  buildFvgSupplyDemandZones,
  fairValueGaps,
  sweptPreviousSwing,
  candleSignal,
  closeConfirmedStructuralSwings,
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

test('structure swings alternate and keep only the extreme of an unfinished leg', () => {
  const sequence = alternatingSwings([
    { kind: 'low', price: 100, index: 1 },
    { kind: 'low', price: 95, index: 2 },
    { kind: 'high', price: 120, index: 3 },
    { kind: 'high', price: 125, index: 4 },
    { kind: 'low', price: 110, index: 5 },
  ])
  assert.deepEqual(sequence.map(({ kind, price }) => ({ kind, price })), [
    { kind: 'low', price: 95 },
    { kind: 'high', price: 125 },
    { kind: 'low', price: 110 },
  ])
})

test('a wick-only extension cannot replace the previous structural swing', () => {
  const candles = [
    candle(START, 95, 100, 92, 96),
    candle(START + HOUR, 96, 110, 94, 108),
    candle(START + 2 * HOUR, 108, 105, 96, 100),
    candle(START + 3 * HOUR, 100, 102, 90, 94),
    candle(START + 4 * HOUR, 94, 108, 95, 106),
    candle(START + 5 * HOUR, 106, 112, 101, 109),
    candle(START + 6 * HOUR, 109, 107, 98, 101),
  ]
  const wickSweep = closeConfirmedStructuralSwings(candles, 1)
  assert.ok(!wickSweep.some((swing) => swing.kind === 'high' && swing.price === 112))

  const closedBreak = candles.map((item, index) => index === 5 ? { ...item, close: 111 } : item)
  const confirmed = closeConfirmedStructuralSwings(closedBreak, 1)
  assert.ok(confirmed.some((swing) => swing.kind === 'high' && swing.price === 112))
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

test('ordinary turns without an impulsive three-candle FVG are not supply/demand zones', () => {
  const candles = [
    candle(START, 105, 106, 99, 100),
    candle(START + HOUR, 100, 106, 99, 105),
    candle(START + 2 * HOUR, 105, 106, 100, 101),
    candle(START + 3 * HOUR, 101, 106, 100, 105),
    candle(START + 4 * HOUR, 105, 106, 99, 100),
  ]
  assert.deepEqual(buildFvgSupplyDemandZones(candles), [])
})

test('a zone is the three-candle FVG from a qualified displacement base', () => {
  const candles = [
    candle(START, 100, 101, 98, 99),
    candle(START + HOUR, 99, 111, 99, 110),
    candle(START + 2 * HOUR, 109, 113, 105, 112),
  ]
  const [zone] = buildFvgSupplyDemandZones(candles)
  assert.equal(zone.type, 'demand')
  assert.deepEqual({ low: zone.low, high: zone.high }, { low: 101, high: 105 })
  assert.deepEqual(zone.baseIndexes, [0])
  assert.deepEqual(zone.definingIndexes, [0, 1, 2])
  assert.deepEqual(
    { direction: zone.fvg.direction, low: zone.fvg.low, high: zone.fvg.high },
    { direction: 'bullish', low: 101, high: 105 }
  )
})

test('an FVG keeps its zone when a timeframe boundary puts the displacement in the confirming candle', () => {
  const candles = [
    candle(START, 100, 102, 99, 101),
    candle(START + HOUR, 101, 103, 100, 101.5),
    candle(START + 2 * HOUR, 104, 116, 104, 115),
  ]

  const [zone] = buildFvgSupplyDemandZones(candles)
  assert.ok(zone, 'the multi-candle breakout should publish its lower imbalance')
  assert.equal(zone.type, 'demand')
  assert.deepEqual({ low: zone.low, high: zone.high }, { low: 102, high: 104 })
  assert.equal(zone.fvg.index, 1, 'the three-candle FVG keeps its original middle index')
  assert.equal(zone.fvg.displacementIndex, 2, 'the actual displacement candle remains auditable')
  assert.deepEqual(zone.baseIndexes, [1])
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

  const chartFourHour = aggregate(hourly, 4, { includePartial: true })
  assert.deepEqual(
    chartFourHour.map((bucket) => new Date(bucket.time).getUTCHours()),
    [0, 4, 8]
  )
  assert.equal(chartFourHour.at(-1).close, hourly.at(-1).close)
})

test('a candle that has not closed yet is dropped', () => {
  const hourly = [candle(START, 1, 2, 0.5, 1.5), candle(START + HOUR, 1, 2, 0.5, 1.5)]
  assert.equal(dropForming(hourly, HOUR_MS, START + HOUR + 60_000).length, 1)
  assert.equal(dropForming(hourly, HOUR_MS, START + 2 * HOUR).length, 2)
})

test('a sweep is a pivot reaching past the previous pivot, not past its neighbours', () => {
  const lower = { kind: 'low', price: 95 }
  const higher = { kind: 'low', price: 105 }
  assert.equal(sweptPreviousSwing(lower, higher), true, 'it reached under the prior low')
  assert.equal(sweptPreviousSwing(higher, lower), false, 'a higher low left that liquidity in place')
  assert.equal(sweptPreviousSwing(lower, null), false, 'nothing to have swept')

  const high = { kind: 'high', price: 120 }
  assert.equal(sweptPreviousSwing(high, { kind: 'high', price: 110 }), true)
  assert.equal(sweptPreviousSwing({ kind: 'high', price: 110 }, high), false)
})

test('a fair value gap is three candles whose outer wicks do not overlap', () => {
  // Candle 1 high 102, candle 3 low 108: price skipped 102-108 entirely.
  const bullish = [
    candle(START, 100, 102, 99, 101),
    candle(START + HOUR, 101, 112, 101, 111),
    candle(START + 2 * HOUR, 111, 113, 108, 112),
  ]
  const gaps = fairValueGaps(bullish)
  assert.equal(gaps.length, 1)
  assert.equal(gaps[0].direction, 'bullish')
  assert.equal(gaps[0].low, 102)
  assert.equal(gaps[0].high, 108)

  // Overlapping wicks are an ordinary two-sided auction, not an imbalance.
  const overlapping = [
    candle(START, 100, 105, 99, 101),
    candle(START + HOUR, 101, 112, 101, 111),
    candle(START + 2 * HOUR, 111, 113, 104, 112),
  ]
  assert.equal(fairValueGaps(overlapping).length, 0)
})

test('a gap price has traded back through is marked filled', () => {
  const candles = [
    candle(START, 100, 102, 99, 101),
    candle(START + HOUR, 101, 112, 101, 111),
    candle(START + 2 * HOUR, 111, 113, 108, 112),
    candle(START + 3 * HOUR, 112, 113, 101, 103), // trades back through 102-108
  ]
  const [gap] = fairValueGaps(candles)
  assert.equal(gap.filled, true)
})

test('every published zone carries its originating FVG instead of a nearby-gap flag', () => {
  const candles = [
    candle(START, 100, 101, 98, 99),
    candle(START + HOUR, 99, 111, 99, 110),
    candle(START + 2 * HOUR, 109, 113, 105, 112),
  ]
  const zones = buildFvgSupplyDemandZones(candles)
  assert.ok(zones.length > 0)
  for (const zone of zones) {
    assert.equal(zone.imbalance, true)
    assert.ok(zone.fvg)
    assert.equal(zone.fvg.direction, zone.type === 'demand' ? 'bullish' : 'bearish')
    assert.equal(zone.definingIndexes.length, 3)
  }
})

test('consecutive FVGs from one displacement base keep their own price gaps', () => {
  const candles = [
    candle(START, 100, 101, 98, 99),
    candle(START + HOUR, 99, 110, 99, 109),
    candle(START + 2 * HOUR, 109, 120, 108, 119),
    candle(START + 3 * HOUR, 118, 122, 117, 121),
  ]

  assert.equal(fairValueGaps(candles).length, 2)
  const zones = buildFvgSupplyDemandZones(candles)
  assert.equal(zones.length, 2)
  assert.deepEqual(
    zones.map((zone) => ({ type: zone.type, firstIndex: zone.firstIndex, low: zone.low, high: zone.high, fvgIndex: zone.fvg.index })),
    [
      { type: 'demand', firstIndex: 0, low: 101, high: 108, fvgIndex: 1 },
      { type: 'demand', firstIndex: 1, low: 110, high: 117, fvgIndex: 2 },
    ]
  )
})
