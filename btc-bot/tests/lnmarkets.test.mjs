import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import test from 'node:test'
import { buildQuery, createLnMarketsClient, NETWORKS, resolveNetwork, signRequest } from '../src/lnmarkets.mjs'
import { stubFetch } from './helpers.mjs'

test('a query string carries its leading question mark, because that is what is signed', () => {
  assert.equal(buildQuery({ limit: 10 }), '?limit=10')
  assert.equal(buildQuery({}), '')
  assert.equal(buildQuery(undefined), '')
  // Undefined values must not reach the URL, or the signature and the request
  // would describe different queries.
  assert.equal(buildQuery({ from: undefined, limit: 5 }), '?limit=5')
})

test('the v3 signature lowercases the method and includes the /v3 path prefix', () => {
  const secret = 'test-secret'
  const signature = signRequest({
    secret,
    timestamp: 1700000000000,
    method: 'GET',
    pathname: '/v3/account',
    data: '',
  })
  assert.equal(signature, createHmac('sha256', secret).update('1700000000000get/v3/account').digest('base64'))
})

test('"testnet" resolves to testnet4 — the host the old name pointed at no longer exists', () => {
  assert.equal(resolveNetwork('testnet'), 'testnet4')
  assert.equal(resolveNetwork('testnet4'), 'testnet4')
  assert.equal(resolveNetwork('mainnet'), 'mainnet')
  assert.equal(resolveNetwork(undefined), 'mainnet')
  assert.match(NETWORKS.testnet4, /api\.testnet4\.lnmarkets\.com\/v3$/)
})

test('an authenticated GET signs exactly the query it sends', async () => {
  let seen = null
  const client = createLnMarketsClient({
    key: 'k',
    secret: 's',
    passphrase: 'p',
    network: 'testnet',
    now: () => 1700000000000,
    fetchImpl: stubFetch({
      'api.testnet4.lnmarkets.com': (url, options) => {
        seen = { url, headers: options.headers }
        return { body: { data: [] } }
      },
    }),
  })

  await client.getClosedTrades({ limit: 25 })

  assert.equal(seen.url, 'https://api.testnet4.lnmarkets.com/v3/futures/isolated/trades/closed?limit=25')
  assert.equal(seen.headers['lnm-access-key'], 'k')
  assert.equal(seen.headers['lnm-access-passphrase'], 'p')
  assert.equal(seen.headers['lnm-access-timestamp'], '1700000000000')
  assert.equal(
    seen.headers['lnm-access-signature'],
    createHmac('sha256', 's')
      .update('1700000000000get/v3/futures/isolated/trades/closed?limit=25')
      .digest('base64')
  )
})

test('a POST signs the JSON body rather than the query', async () => {
  let seen = null
  const client = createLnMarketsClient({
    key: 'k',
    secret: 's',
    passphrase: 'p',
    network: 'mainnet',
    now: () => 1700000000000,
    fetchImpl: stubFetch({
      'api.lnmarkets.com': (url, options) => {
        seen = { url, headers: options.headers, body: options.body }
        return { body: {} }
      },
    }),
  })

  await client.newTrade({ type: 'market', side: 'buy', quantity: 50, leverage: 5, stoploss: 1, takeprofit: 2 })

  assert.equal(seen.url, 'https://api.lnmarkets.com/v3/futures/isolated/trade')
  assert.equal(seen.headers['Content-Type'], 'application/json')
  assert.equal(
    seen.headers['lnm-access-signature'],
    createHmac('sha256', 's').update(`1700000000000post/v3/futures/isolated/trade${seen.body}`).digest('base64')
  )
})

test('public routes carry no credentials even when the client holds them', async () => {
  let seen = null
  const client = createLnMarketsClient({
    key: 'k',
    secret: 's',
    passphrase: 'p',
    network: 'mainnet',
    fetchImpl: stubFetch({
      'api.lnmarkets.com': (url, options) => {
        seen = { url, headers: options.headers }
        return { body: { lastPrice: 100000, index: 100001 } }
      },
    }),
  })

  await client.getTicker()

  assert.equal(seen.url, 'https://api.lnmarkets.com/v3/futures/ticker')
  assert.equal(seen.headers['lnm-access-key'], undefined)
})

test('an authenticated call without credentials fails before it reaches the network', async () => {
  const client = createLnMarketsClient({
    key: '',
    secret: '',
    passphrase: '',
    fetchImpl: () => {
      throw new Error('must not be called')
    },
  })
  await assert.rejects(() => client.getAccount(), /credentials are missing/)
})

test('an error response is raised with its status and body', async () => {
  const client = createLnMarketsClient({
    fetchImpl: stubFetch({
      'futures/ticker': { ok: false, status: 429, statusText: 'Too Many Requests', body: 'slow down' },
    }),
  })
  await assert.rejects(() => client.getTicker(), /LN Markets 429 Too Many Requests.*slow down/)
})
