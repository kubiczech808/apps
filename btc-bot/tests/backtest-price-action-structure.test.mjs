import assert from 'node:assert/strict'
import test from 'node:test'

import { aggregatePriceActionBacktests, historicalExternalStructureAt } from '../src/backtest-price-action-structure.mjs'
import { HOUR, START } from './helpers.mjs'

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

test('historical backtest structure follows only closed external pivot data', () => {
  const candles = Array.from({ length: 92 }, (_, index) => ({
    time: START + index * HOUR,
    open: 104.5,
    high: 105,
    low: 104,
    close: 104.5,
    volume: 0,
  }))
  const pivot = (index, kind, price, close) => {
    candles[index] = {
      ...candles[index],
      high: kind === 'high' ? price : 105,
      low: kind === 'low' ? price : 104,
      close,
    }
  }
  pivot(10, 'high', 120, 119)
  pivot(20, 'low', 100, 101)
  pivot(30, 'high', 115, 114)
  pivot(40, 'low', 95, 94)
  pivot(50, 'high', 125, 126)
  pivot(60, 'low', 90, 89)
  pivot(68, 'high', 110, 109)
  pivot(74, 'low', 85, 84)

  const snapshot = historicalExternalStructureAt({
    candles,
    timeframeId: '1h',
    throughTime: START + 92 * HOUR,
    includeZones: false,
  })

  assert.equal(snapshot.trend, 'down')
  assert.equal(snapshot.event, 'BOS_DOWN')
  assert.equal(snapshot.structure.activeRange.high.price, 110)
  assert.equal(snapshot.structure.activeRange.low.price, 85)
  assert.equal(snapshot.structure.method, 'potvrzené pivoty externího OHLC')
  assert.equal(snapshot.zones, null)
})
