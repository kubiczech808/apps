import assert from 'node:assert/strict'
import test from 'node:test'

import { DEFAULT_SETTINGS, mergeSettings } from '../src/state.mjs'
import { ACTIVE_STRATEGY_ID, LEGACY_PRICE_ACTION_ID, strategyConfig } from '../src/strategy-registry.mjs'

test('selected production strategy is the leveraged long-only momentum model', () => {
  assert.equal(DEFAULT_SETTINGS.strategyId, ACTIVE_STRATEGY_ID)
  assert.equal(DEFAULT_SETTINGS.portfolioName, 'BTC Leveraged Momentum')
  assert.deepEqual(DEFAULT_SETTINGS.timeframes, { htfHours: 24, ltfHours: 1 })
  assert.equal(DEFAULT_SETTINGS.risk.market, 'futures')
  assert.equal(DEFAULT_SETTINGS.risk.riskPct, 2)
  assert.equal(DEFAULT_SETTINGS.risk.maxLeverage, 10)
  assert.equal(DEFAULT_SETTINGS.risk.liquidationSafety, 2)
  assert.equal(DEFAULT_SETTINGS.strategy.stopAtr, 1)
  assert.equal(DEFAULT_SETTINGS.strategy.allowShorts, false)
})

test('an unversioned price-action settings document migrates without leaking old filters', () => {
  const migrated = mergeSettings({
    enabled: false,
    mode: 'paper',
    portfolioName: 'BTC Price Action Swing',
    timeframes: { htfHours: 4, ltfHours: 1 },
    risk: { market: 'spot', riskPct: 1 },
    strategy: { requireSweep: true, zoneMaxDistanceAtr: 1 },
  })

  assert.equal(migrated.enabled, false)
  assert.equal(migrated.strategyId, ACTIVE_STRATEGY_ID)
  assert.equal(migrated.portfolioName, 'BTC Leveraged Momentum')
  assert.deepEqual(migrated.timeframes, { htfHours: 24, ltfHours: 1 })
  assert.equal(migrated.risk.market, 'futures')
  assert.equal(migrated.risk.riskPct, 2)
  assert.equal(migrated.strategy.stopAtr, 1)
  assert.equal(migrated.strategy.requireSweep, undefined)
})

test('an explicitly versioned legacy strategy remains reproducible', () => {
  const legacy = strategyConfig(LEGACY_PRICE_ACTION_ID)
  const merged = mergeSettings({
    strategyId: LEGACY_PRICE_ACTION_ID,
    portfolioName: legacy.name,
    timeframes: legacy.timeframes,
    risk: { riskPct: 1 },
    strategy: { requireSweep: false },
  })

  assert.equal(merged.strategyId, LEGACY_PRICE_ACTION_ID)
  assert.deepEqual(merged.timeframes, legacy.timeframes)
  assert.equal(merged.strategy.requireSweep, false)
})
