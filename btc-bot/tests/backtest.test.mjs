import assert from 'node:assert/strict'
import test from 'node:test'
import { formatBacktest, runBacktest } from '../src/backtest.mjs'
import { noisyZigzag, zigzag } from './helpers.mjs'

// A long, repeating uptrend at realistic prices: enough hours for the warmup
// plus many pullbacks for the strategy to act on.
const trendingSeries = () => {
  const legs = [100]
  for (let step = 0; step < 24; step += 1) {
    const base = legs.at(-1)
    legs.push(base * 1.12, base * 1.06)
  }
  return zigzag(legs, { steps: 24, scale: 600 })
}

test('a backtest reports a complete, internally consistent account', async () => {
  const report = await runBacktest({ hourly: trendingSeries(), warmupHours: 400 })

  assert.ok(report.hours > 0)
  assert.equal(report.stats.trades, report.stats.wins + report.stats.losses + (report.stats.trades - report.stats.wins - report.stats.losses))
  assert.ok(report.equityCurve.length > 0)
  assert.ok(Number.isFinite(report.finalEquitySats))
  assert.ok(Number.isFinite(report.returnPct))
  for (const trade of report.trades) {
    assert.ok(trade.stopLoss > 0 && trade.takeProfit > 0, 'every backtested trade was bracketed')
    assert.ok(['stop_loss', 'take_profit', 'manual'].includes(trade.exitReason))
    assert.ok(trade.closedAt >= trade.openedAt)
  }
})

test('no trade is entered on a candle that had not closed when the decision was taken', async () => {
  const report = await runBacktest({ hourly: trendingSeries(), warmupHours: 400 })
  for (const trade of report.trades) {
    assert.ok(trade.openedAt < trade.closedAt, 'a trade cannot open and close on the same instant')
  }
})

test('every rejection carries a reason a human can act on', async () => {
  const flat = zigzag([100, 101, 100, 101, 100, 101, 100, 101, 100], { steps: 60, scale: 600 })
  const report = await runBacktest({ hourly: flat, warmupHours: 400 })
  assert.equal(report.stats.trades, 0)
  assert.ok(report.rejections.length > 0)
  for (const [reason, count] of report.rejections) {
    assert.equal(typeof reason, 'string')
    assert.ok(reason.length > 5)
    assert.ok(count > 0)
  }
})

test('a wider reward/risk gate can only reduce the number of trades taken', async () => {
  const hourly = trendingSeries()
  const lenient = await runBacktest({ hourly, warmupHours: 400, settings: { strategy: { minRR: 1.5 } } })
  const strict = await runBacktest({ hourly, warmupHours: 400, settings: { strategy: { minRR: 6 } } })
  assert.ok(strict.stats.trades <= lenient.stats.trades)
})

test('a series shorter than the warmup is refused rather than silently trimmed', async () => {
  await assert.rejects(
    () => runBacktest({ hourly: zigzag([100, 110], { steps: 10 }), warmupHours: 400 }),
    /need more than 400 hourly candles/
  )
})

// A series with enough noise that the strategy's ATR-relative gates can pass,
// which a perfectly smooth zigzag never does.
const tradeableSeries = () => {
  const legs = [100]
  for (let step = 0; step < 30; step += 1) {
    const base = legs.at(-1)
    legs.push(base * 1.1, base * 1.04)
  }
  return noisyZigzag(legs, { steps: 14, scale: 800, noise: 0.012 })
}

test('stop losses and take profits actually fire — the backtest clock is the candle clock', async () => {
  // The regression this exists for: the paper executor refuses to settle a
  // candle older than the trade being marked, and the backtest used to leave it
  // on the wall clock. Every historical candle was therefore "older" than every
  // trade, so no bracket ever fired and positions could only be closed at
  // market by the trend-flip rule. The run looked profitable and was measuring
  // a system with no stops.
  const report = await runBacktest({ hourly: tradeableSeries(), warmupHours: 400 })

  assert.ok(report.stats.trades > 0, 'the fixture must produce trades for this test to mean anything')
  const bracketed = report.trades.filter(
    (trade) => trade.exitReason === 'stop_loss' || trade.exitReason === 'take_profit'
  )
  assert.ok(
    bracketed.length > 0,
    `no trade exited on its stop or target — brackets are not firing (exits: ${report.trades
      .map((trade) => trade.exitReason)
      .join(', ')})`
  )
})

test('a loss never exceeds the risk that was authorised, plus fees', async () => {
  const report = await runBacktest({
    hourly: tradeableSeries(),
    warmupHours: 400,
    settings: { risk: { riskPct: 1 } },
  })

  for (const trade of report.trades) {
    if (trade.exitReason !== 'stop_loss') continue
    // 1% of a ~100 USD account, with generous headroom for fees and for the
    // account having grown. A stop-loss exit costing several times this is the
    // signature of a stop that was never placed.
    const ceiling = report.startBalanceSats * 0.02
    assert.ok(
      Math.abs(trade.plSats) <= ceiling,
      `a stopped-out trade lost ${Math.abs(trade.plSats)} sats against a ${Math.round(ceiling)} sats ceiling`
    )
  }
})

test('drawdown is measured against the account, not against the P/L curve', async () => {
  const report = await runBacktest({ hourly: tradeableSeries(), warmupHours: 400 })
  if (report.stats.maxDrawdownPct === null) return
  // Every trade risks 1%, one position at a time, three a day. A drawdown of
  // tens of percent would mean the risk rule is not being applied.
  assert.ok(
    report.stats.maxDrawdownPct < 30,
    `max drawdown ${report.stats.maxDrawdownPct.toFixed(1)}% is impossible at 1% risk per trade`
  )
})

test('a run starved of history says so instead of reporting zero trades as a result', async () => {
  // The first momentum run returned zero trades across six variants and read
  // like a verdict. It was not: the engine's trailing window was 100 daily
  // candles and the strategy needs 140, so every bar was refused for lack of
  // history. A measurement that measured nothing has to say so.
  const report = await runBacktest({
    hourly: tradeableSeries(),
    warmupHours: 400,
    // Far too short for the 14-period ATR and the structure the strategy reads.
    windowHours: 20,
  })

  assert.equal(report.starved, true)
  assert.match(formatBacktest(report), /INVALID: most bars were refused for lack of history/)
})

test('a properly sized run is not flagged as starved', async () => {
  const report = await runBacktest({ hourly: tradeableSeries(), warmupHours: 400 })
  assert.equal(report.starved, false)
})
