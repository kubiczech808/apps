import assert from 'node:assert/strict'
import test from 'node:test'
import { evaluateEntry, manageOpen } from '../src/strategy.mjs'
import { createPaperExecutor } from '../src/executor-paper.mjs'
import { appendCandle, candle, HOUR, START, zigzag } from './helpers.mjs'

/** An uptrend that has just pulled back into an old demand zone and rejected. */
// The quality filters get their own tests below. The fixtures here are smooth
// synthetic zigzags with no swept liquidity and no imbalance, so leaving the
// filters on would make every test in this file fail for the same new reason
// and stop testing what it was written for.
const NO_QUALITY_FILTERS = { requireSweep: false, requireImbalance: false }

const bullishPullback = () => {
  const candles = zigzag([100, 112, 106, 124, 116, 138, 128, 152, 140, 168, 152, 180, 164, 196, 166], { steps: 8 })
  appendCandle(candles, { open: 166, high: 167.5, low: 163, close: 167 })
  return candles
}

// The same shape mirrored. Finer steps keep ATR inside the strategy's own
// volatility band -- at `steps: 8` this synthetic series moves 4.3% of price per
// candle, which the "too volatile" filter correctly refuses, and a fixture that
// trips a different gate than the one under test proves nothing.
const bearishPullback = () => {
  const candles = zigzag([196, 176, 190, 160, 174, 144, 158, 128, 142, 112, 126, 100, 114, 84, 112], { steps: 14 })
  appendCandle(candles, { open: 112, high: 115, low: 110.5, close: 111 })
  return candles
}

test('a pullback into demand inside an uptrend is a long, bracketed on both sides', () => {
  const candles = bullishPullback()
  const decision = evaluateEntry({ htfCandles: candles, ltfCandles: candles, settings: NO_QUALITY_FILTERS })

  assert.equal(decision.action, 'open')
  assert.equal(decision.side, 'long')
  assert.ok(decision.stop < decision.entry, 'stop must sit below a long')
  assert.ok(decision.takeProfit > decision.entry, 'target must sit above a long')
  assert.ok(decision.rr >= 2, `reward/risk ${decision.rr} should clear the gate`)
  assert.match(decision.reason, /up trend/)
})

test('a rally into supply inside a downtrend is a short', () => {
  const candles = bearishPullback()
  const decision = evaluateEntry({ htfCandles: candles, ltfCandles: candles, settings: NO_QUALITY_FILTERS })

  assert.equal(decision.action, 'open')
  assert.equal(decision.side, 'short')
  assert.ok(decision.stop > decision.entry)
  assert.ok(decision.takeProfit < decision.entry)
})

test('a ranging higher timeframe is refused outright', () => {
  const candles = zigzag([100, 110, 100, 110, 100, 110, 100, 110, 100, 110, 100], { steps: 8 })
  const decision = evaluateEntry({ htfCandles: candles, ltfCandles: candles, settings: NO_QUALITY_FILTERS })
  assert.equal(decision.action, 'none')
  assert.match(decision.reason, /no trend|ranging/)
})

test('price far from the zone is refused even in a clean trend', () => {
  const candles = zigzag([100, 112, 106, 124, 116, 138, 128, 152, 140, 168, 152, 180, 164, 196, 194], { steps: 8 })
  const decision = evaluateEntry({ htfCandles: candles, ltfCandles: candles, settings: NO_QUALITY_FILTERS })
  assert.equal(decision.action, 'none')
  assert.match(decision.reason, /ATR from the demand zone|no bullish trigger/)
})

test('reaching the zone without a trigger candle is refused', () => {
  const candles = zigzag([100, 112, 106, 124, 116, 138, 128, 152, 140, 168, 152, 180, 164, 196, 166], { steps: 8 })
  // A candle that wicks into the zone but shows no rejection: the lower wick is
  // shorter than its body and it closes in the lower half of its range.
  appendCandle(candles, { open: 165.5, high: 165.8, low: 163, close: 164.2 })
  const decision = evaluateEntry({ htfCandles: candles, ltfCandles: candles, settings: NO_QUALITY_FILTERS })
  assert.equal(decision.action, 'none')
  assert.match(decision.reason, /no bullish trigger/)
})

test('a reward/risk gate above what the structure offers refuses the trade', () => {
  const candles = bullishPullback()
  const decision = evaluateEntry({ htfCandles: candles, ltfCandles: candles, settings: { ...NO_QUALITY_FILTERS, minRR: 12 } })
  assert.equal(decision.action, 'none')
  assert.match(decision.reason, /reward\/risk/)
})

test('too little history is refused rather than guessed at', () => {
  const candles = zigzag([100, 110, 105, 120], { steps: 4 })
  const decision = evaluateEntry({ htfCandles: candles, ltfCandles: candles, settings: NO_QUALITY_FILTERS })
  assert.equal(decision.action, 'none')
  assert.match(decision.reason, /not enough/)
})

test('a stop is moved to breakeven once the trade is one R in profit', () => {
  const candles = zigzag([100, 112, 106, 124, 116, 138, 128, 152, 140, 168], { steps: 8 })
  const position = { side: 'long', entry: 150, stopLoss: 145, initialStop: 145 }
  // Latest close is above entry + 1R = 155 but below the trail threshold.
  appendCandle(candles, { open: 155, high: 157, low: 154, close: 156 })
  const decision = manageOpen({ position, ltfCandles: candles, htfCandles: candles })
  assert.equal(decision.action, 'move_stop')
  assert.equal(decision.stop, 150)
  assert.match(decision.reason, /breakeven/)
})

test('a stop is never widened, whatever the trailing anchor says', () => {
  const candles = zigzag([100, 112, 106, 124, 116, 138, 128, 152, 140, 168], { steps: 8 })
  appendCandle(candles, { open: 165, high: 167, low: 164, close: 166 })
  const alreadyTrailed = { side: 'long', entry: 150, stopLoss: 164, initialStop: 145 }
  const decision = manageOpen({ position: alreadyTrailed, ltfCandles: candles, htfCandles: candles })
  assert.notEqual(decision.action, 'move_stop')
})

test('a proposed stop already through price is refused, not sent', () => {
  const candles = zigzag([100, 112, 106, 124, 116, 138, 128, 152, 140, 168], { steps: 8 })
  appendCandle(candles, { open: 152, high: 153, low: 151, close: 151.5 })
  const position = { side: 'long', entry: 145, stopLoss: 140, initialStop: 140 }
  const decision = manageOpen({ position, ltfCandles: candles, htfCandles: candles })
  if (decision.action === 'move_stop') {
    assert.ok(decision.stop < 151.5, 'a stop at or above price would close the trade instantly')
  }
})

test('a long is closed when the higher timeframe turns down', () => {
  const down = zigzag([196, 176, 190, 160, 174, 144, 158, 128, 142, 112], { steps: 8 })
  const position = { side: 'long', entry: 150, stopLoss: 145, initialStop: 145 }
  const decision = manageOpen({ position, ltfCandles: down, htfCandles: down })
  assert.equal(decision.action, 'close')
  assert.match(decision.reason, /turned against/)
})

test('a position built the way the system actually builds one gets its stop moved', async () => {
  // The bug this exists for: manageOpen read `position.stop`, and nothing in
  // the system produces that field — the paper store, LN Markets'
  // normaliseTrade and the published state all say `stopLoss`. Every hand-built
  // fixture in this file used `stop`, so the tests passed while the production
  // path silently never moved a stop. Measured over 233 days of real candles:
  // 35 trades reached 1R, zero were moved to breakeven.
  //
  // So this one does not hand-build a position. It opens one through the real
  // executor and manages what comes back.
  const store = { balanceSats: 1_000_000, trades: [], nextId: 1 }
  const executor = createPaperExecutor({ store, now: () => START })
  const opened = await executor.openPosition({
    side: 'long',
    entry: 150,
    stop: 145,
    takeProfit: 165,
    quantityUsd: 10,
    marginSats: 1000,
    leverage: 5,
  })
  opened.initialStop = 145

  const candles = zigzag([100, 112, 106, 124, 116, 138, 128, 152, 140, 168], { steps: 8 })
  appendCandle(candles, { open: 155, high: 157, low: 154, close: 156 }) // 1.2R in profit

  const decision = manageOpen({ position: opened, ltfCandles: candles, htfCandles: candles })
  assert.equal(decision.action, 'move_stop', `expected the stop to move, got: ${decision.reason}`)
  assert.equal(decision.stop, 150, 'breakeven is the entry price')
})

test('a position with no stop at all is held, not managed against undefined', () => {
  const candles = zigzag([100, 112, 106, 124, 116, 138, 128, 152, 140, 168], { steps: 8 })
  const decision = manageOpen({
    position: { side: 'long', entry: 150, initialStop: 145 },
    ltfCandles: candles,
    htfCandles: candles,
  })
  assert.equal(decision.action, 'hold')
  assert.match(decision.reason, /no stop to manage/)
})
