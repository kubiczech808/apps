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
