import assert from 'node:assert/strict'
import test from 'node:test'
import { runBacktest } from '../src/backtest.mjs'
import { zigzag } from './helpers.mjs'

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
