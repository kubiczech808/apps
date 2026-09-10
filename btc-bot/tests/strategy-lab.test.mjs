import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import {
  DEFAULT_SWEEP_RECLAIM,
  evaluateEntry as evaluateSweepReclaimEntry,
} from '../src/strategy-jeafx-sweep-reclaim.mjs'
import { DEFAULT_JEAFX_SWING, evaluateEntry } from '../src/strategy-jeafx-swing.mjs'

const read = (relative) => readFileSync(fileURLToPath(new URL(`../${relative}`, import.meta.url)), 'utf8')

test('JeaFx swing strategy declares the intended higher-timeframe filters', () => {
  assert.deepEqual(DEFAULT_JEAFX_SWING.triggerKinds, ['engulfing'])
  assert.equal(DEFAULT_JEAFX_SWING.requireSweep, true)
  assert.equal(DEFAULT_JEAFX_SWING.requireImbalance, true)
  assert.equal(DEFAULT_JEAFX_SWING.stopAtrBuffer, 0.75)
  assert.equal(DEFAULT_JEAFX_SWING.zoneMaxDistanceAtr, 0.75)
})

test('JeaFx swing strategy refuses to trade before its daily/4h context exists', () => {
  const decision = evaluateEntry({ htfCandles: [], ltfCandles: [] })
  assert.equal(decision.action, 'none')
  assert.match(decision.reason, /not enough higher-timeframe candles/)
})

test('JeaFx sweep reclaim strategy declares the intended liquidity filters', () => {
  assert.deepEqual(DEFAULT_SWEEP_RECLAIM.triggerKinds, ['engulfing'])
  assert.equal(DEFAULT_SWEEP_RECLAIM.sweepLookbackBars, 48)
  assert.equal(DEFAULT_SWEEP_RECLAIM.reclaimMaxBars, 6)
  assert.equal(DEFAULT_SWEEP_RECLAIM.triggerMaxBarsAfterReclaim, 4)
  assert.equal(DEFAULT_SWEEP_RECLAIM.stopAtrBuffer, 0.5)
})

test('JeaFx sweep reclaim refuses to trade before its context exists', () => {
  const decision = evaluateSweepReclaimEntry({ htfCandles: [], ltfCandles: [] })
  assert.equal(decision.action, 'none')
  assert.match(decision.reason, /not enough higher-timeframe candles/)
})

test('backtest CLI registers the JeaFx lab strategies', () => {
  const cli = read('tools/backtest.mjs')
  assert.match(cli, /strategy-jeafx-swing\.mjs/)
  assert.match(cli, /strategy-jeafx-sweep-reclaim\.mjs/)
  assert.match(cli, /'jeafx-swing'/)
  assert.match(cli, /'jeafx-sweep-reclaim'/)
  assert.match(cli, /selectedName === 'all'/)
  assert.match(cli, /timeframes:\s*\{\s*htfHours:\s*24,\s*ltfHours:\s*4\s*\}/)
  assert.match(cli, /imbalance off/)
  assert.match(cli, /rejection also allowed/)
})

test('backtest CLI accepts boolean flags without swallowing the next option', () => {
  const cli = read('tools/backtest.mjs')
  assert.match(cli, /const next = process\.argv\[index \+ 1\]/)
  assert.match(cli, /!next\.startsWith\('--'\)/)
  assert.match(cli, /args\.set\(key, true\)/)
})
