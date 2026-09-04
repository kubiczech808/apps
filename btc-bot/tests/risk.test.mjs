import assert from 'node:assert/strict'
import test from 'node:test'
import { liquidationPrice, planPosition, pnlSats, SATS_PER_BTC } from '../src/risk.mjs'

const EQUITY = 100_000 // sats, roughly 100 USD at 100k BTC

test('inverse PnL has the right sign on both sides', () => {
  assert.ok(pnlSats({ side: 'long', entry: 100_000, exit: 110_000, quantityUsd: 100 }) > 0)
  assert.ok(pnlSats({ side: 'long', entry: 100_000, exit: 90_000, quantityUsd: 100 }) < 0)
  assert.ok(pnlSats({ side: 'short', entry: 100_000, exit: 90_000, quantityUsd: 100 }) > 0)
  assert.ok(pnlSats({ side: 'short', entry: 100_000, exit: 110_000, quantityUsd: 100 }) < 0)
})

test('a long of 100 USD from 100k to 110k earns the inverse-contract amount, not the linear one', () => {
  // 100 USD buys 0.001 BTC at 100k. At 110k it is worth 110 USD = 0.001 BTC
  // still, so the gain is 100 * (1/100000 - 1/110000) BTC = 9090.9 sats.
  const gain = pnlSats({ side: 'long', entry: 100_000, exit: 110_000, quantityUsd: 100 })
  assert.ok(Math.abs(gain - 9090.909) < 0.01, `expected ~9090.9 sats, got ${gain}`)
})

test('the loss at the stop is the configured percentage of equity', () => {
  for (const riskPct of [0.5, 1, 2]) {
    for (const [entry, stop] of [
      [100_000, 98_000],
      [100_000, 95_000],
      [60_000, 58_500],
    ]) {
      const plan = planPosition({
        side: 'long',
        entry,
        stop,
        takeProfit: entry + (entry - stop) * 3,
        equitySats: EQUITY,
        settings: { riskPct },
      })
      assert.ok(plan.ok, plan.reason)
      const wanted = EQUITY * (riskPct / 100)
      // Quantity is floored to whole USD, so the realised risk is at or just
      // under the target — never above it.
      assert.ok(plan.riskSats <= wanted + 1e-6, `risk ${plan.riskSats} exceeded ${wanted}`)
      assert.ok(plan.riskSats > wanted * 0.9, `risk ${plan.riskSats} far under ${wanted}`)
    }
  }
})

test('shorts are sized to the same risk as longs', () => {
  const long = planPosition({
    side: 'long',
    entry: 100_000,
    stop: 98_000,
    takeProfit: 106_000,
    equitySats: EQUITY,
  })
  const short = planPosition({
    side: 'short',
    entry: 100_000,
    stop: 102_000,
    takeProfit: 94_000,
    equitySats: EQUITY,
  })
  assert.ok(long.ok && short.ok)
  assert.ok(Math.abs(long.riskSats - short.riskSats) < long.riskSats * 0.02)
})

test('liquidation is kept beyond the stop by the safety factor', () => {
  for (const stop of [99_000, 98_000, 95_000, 90_000]) {
    const plan = planPosition({
      side: 'long',
      entry: 100_000,
      stop,
      takeProfit: 100_000 + (100_000 - stop) * 3,
      equitySats: EQUITY,
    })
    if (!plan.ok) continue
    assert.ok(
      plan.liquidation < stop,
      `liquidation ${plan.liquidation} is not beyond the stop ${stop} at ${plan.leverage}x`
    )
  }
})

test('the liquidation formula matches the leverage it was derived from', () => {
  assert.ok(Math.abs(liquidationPrice({ side: 'long', entry: 100_000, leverage: 9 }) - 90_000) < 1)
  assert.ok(Math.abs(liquidationPrice({ side: 'short', entry: 100_000, leverage: 11 }) - 110_000) < 1)
})

test('a stop so wide that even 1x liquidates first is refused', () => {
  const plan = planPosition({
    side: 'long',
    entry: 100_000,
    stop: 40_000,
    takeProfit: 300_000,
    equitySats: EQUITY,
  })
  assert.equal(plan.ok, false)
  assert.match(plan.reason, /liquidates before it/)
})

test('inverted brackets are refused rather than silently flipped', () => {
  assert.match(
    planPosition({ side: 'long', entry: 100_000, stop: 101_000, takeProfit: 110_000, equitySats: EQUITY }).reason,
    /stop below and take profit above/
  )
  assert.match(
    planPosition({ side: 'short', entry: 100_000, stop: 99_000, takeProfit: 90_000, equitySats: EQUITY }).reason,
    /stop above and take profit below/
  )
})

test('an account too small for the exchange minimum is refused with a readable reason', () => {
  const plan = planPosition({
    side: 'long',
    entry: 100_000,
    stop: 99_000,
    takeProfit: 103_000,
    equitySats: 500,
  })
  assert.equal(plan.ok, false)
  assert.match(plan.reason, /minimum|margin/)
})

test('notional is capped even when the stop is very tight', () => {
  const plan = planPosition({
    side: 'long',
    entry: 100_000,
    stop: 99_950,
    takeProfit: 100_200,
    equitySats: EQUITY,
    settings: { maxNotionalPct: 300 },
  })
  if (plan.ok) {
    assert.equal(plan.notionalCapped, true)
    const notionalUsd = (EQUITY / SATS_PER_BTC) * 100_000 * 3
    assert.ok(plan.quantityUsd <= notionalUsd + 1)
  }
})
