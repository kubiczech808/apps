import assert from 'node:assert/strict'
import test from 'node:test'

import { ACTIVE_STRATEGY_ID, strategyConfig } from '../src/strategy-registry.mjs'

const DAY = 86_400_000

const dailyTrend = ({ side = 'long', count = 150 } = {}) => {
  const candles = []
  for (let index = 0; index < count; index += 1) {
    const close = side === 'long' ? 60_000 + index * 80 : 90_000 - index * 80
    candles.push({
      time: index * DAY,
      open: close - (side === 'long' ? 20 : -20),
      high: close + 120,
      low: close - 120,
      close,
      volume: 1,
    })
  }
  const previous = candles.at(-1)
  const close = side === 'long' ? previous.high + 500 : previous.low - 500
  candles.push({
    time: count * DAY,
    open: previous.close,
    high: Math.max(previous.close, close) + 100,
    low: Math.min(previous.close, close) - 100,
    close,
    volume: 1,
  })
  return candles
}

test('the selected strategy opens only on a fresh long breakout above its regime', () => {
  const selected = strategyConfig(ACTIVE_STRATEGY_ID)
  const daily = dailyTrend()
  const decision = selected.module.evaluateEntry({
    htfCandles: daily,
    ltfCandles: [daily.at(-1)],
    settings: selected.settings,
  })

  assert.equal(decision.action, 'open')
  assert.equal(decision.side, 'long')
  assert.ok(decision.stop < decision.entry)
  assert.ok(decision.takeProfit > decision.entry)
  assert.equal(decision.entry - decision.stop, decision.context.dailyAtr)
  assert.match(decision.reason, /fresh 20-day breakout/)
})

test('the selected strategy refuses short breakouts', () => {
  const selected = strategyConfig(ACTIVE_STRATEGY_ID)
  const daily = dailyTrend({ side: 'short' })
  const decision = selected.module.evaluateEntry({
    htfCandles: daily,
    ltfCandles: [daily.at(-1)],
    settings: selected.settings,
  })

  assert.equal(decision.action, 'none')
  assert.match(decision.reason, /short breakouts are disabled/)
})

test('momentum management only raises a long stop to the 10-day channel', () => {
  const selected = strategyConfig(ACTIVE_STRATEGY_ID)
  const daily = dailyTrend()
  const decision = selected.module.manageOpen({
    position: { side: 'long', stopLoss: 50_000 },
    htfCandles: daily,
    ltfCandles: [daily.at(-1)],
    settings: selected.settings,
  })

  assert.equal(decision.action, 'move_stop')
  assert.ok(decision.stop > 50_000)
  assert.match(decision.reason, /10-day channel/)
})
