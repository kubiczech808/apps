import assert from 'node:assert/strict'
import test from 'node:test'
import { createStateStore } from '../src/store.mjs'

test('lease requests identify the price-action schema before reserving work', async () => {
  let request = null
  const store = createStateStore({
    baseUrl: 'https://example.test/api.php',
    key: 'test-key',
    fetchImpl: async (url, options) => {
      request = { url, options }
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ granted: true, owner: 'actions' }),
      }
    },
  })

  await store.claimLease({ owner: 'actions', ttlMs: 90_000, priceActionSchema: 20 })

  assert.equal(request.url, 'https://example.test/api.php?action=lease')
  assert.deepEqual(JSON.parse(request.options.body), {
    owner: 'actions',
    ttlMs: 90_000,
    priceActionSchema: 20,
  })
})

test('backtest workers publish equal-weight progress through the narrow endpoint', async () => {
  let request = null
  const store = createStateStore({
    baseUrl: 'https://example.test/api.php',
    key: 'test-key',
    fetchImpl: async (url, options) => {
      request = { url, options }
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ ok: true }),
      }
    },
  })

  const progress = {
    strategyId: 'price-action-structure-v1',
    runId: 'run-123',
    totalProfiles: 96,
    completedProfiles: 24,
    status: 'running',
    lastCompleted: { periodYears: 1, asset: 'BTCUSD', timeframeId: '1d' },
  }
  await store.updateBacktestProgress(progress)

  assert.equal(request.url, 'https://example.test/api.php?action=backtest-progress')
  assert.equal(request.options.method, 'POST')
  assert.deepEqual(JSON.parse(request.options.body), progress)
})
