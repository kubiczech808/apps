import assert from 'node:assert/strict'
import test from 'node:test'

import { aggregatePriceActionBacktests } from '../src/backtest-price-action-structure.mjs'

const result = (tradeLog) => ({
  from: '2022-01-01T00:00:00.000Z',
  to: '2025-01-01T00:00:00.000Z',
  tradeLog,
})

test('portfolio aggregation compounds 1% risk and removes same-asset overlaps', () => {
  const report = aggregatePriceActionBacktests({
    assets: {
      BTCUSD: {
        '1h': result([
          { openedAt: '2023-01-01T00:00:00.000Z', closedAt: '2023-01-10T00:00:00.000Z', rMultiple: 1, holdDays: 9 },
          { openedAt: '2023-01-05T00:00:00.000Z', closedAt: '2023-01-12T00:00:00.000Z', rMultiple: 3, holdDays: 7 },
        ]),
      },
      EURUSD: {
        '4h': result([
          { openedAt: '2023-01-06T00:00:00.000Z', closedAt: '2023-01-07T00:00:00.000Z', rMultiple: -1, holdDays: 1 },
        ]),
      },
    },
    startingCapital: 100,
    riskPct: 1,
  })

  assert.equal(report.trades, 2)
  assert.equal(report.overlapSkipped, 1)
  assert.equal(report.wins, 1)
  assert.equal(report.losses, 1)
  assert.equal(report.finalCapital, 99.99)
  assert.equal(report.selectedRows, 2)
})

test('portfolio aggregation recalculates after a timeframe is excluded', () => {
  const report = aggregatePriceActionBacktests({
    assets: {
      BTCUSD: {
        '1h': result([{ openedAt: 1, closedAt: 2, rMultiple: 1, holdDays: 1 }]),
        '4h': result([{ openedAt: 3, closedAt: 4, rMultiple: 1, holdDays: 1 }]),
      },
    },
    selected: { BTCUSD: { '4h': false } },
    startingCapital: 100,
    riskPct: 1,
  })

  assert.equal(report.selectedRows, 1)
  assert.equal(report.trades, 1)
  assert.equal(report.overlapSkipped, 0)
  assert.equal(report.finalCapital, 101)
})
