import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import test from 'node:test'
import { buildPayload, createLnMarketsClient, signRequest } from '../src/lnmarkets.mjs'
import { stubFetch } from './helpers.mjs'

test('the signed payload is the query string for GET and the JSON body for POST', () => {
  assert.equal(buildPayload('GET', { type: 'running' }), 'type=running')
  assert.equal(buildPayload('DELETE', { id: 'abc' }), 'id=abc')
  assert.equal(buildPayload('POST', { side: 'b', quantity: 5 }), '{"side":"b","quantity":5}')
  assert.equal(buildPayload('GET', {}), '')
  assert.equal(buildPayload('POST', undefined), '')
})

test('the signature is base64 HMAC-SHA256 over timestamp + method + /v2path + payload', () => {
  const secret = 'test-secret'
  const signature = signRequest({
    secret,
    timestamp: 1700000000000,
    method: 'GET',
    path: '/user',
    payload: '',
  })
  const expected = createHmac('sha256', secret).update('1700000000000GET/v2/user').digest('base64')
  assert.equal(signature, expected)
})

test('an authenticated GET sends the same parameters it signed, in the same order', async () => {
  let seen = null
  const client = createLnMarketsClient({
    key: 'k',
    secret: 's',
    passphrase: 'p',
    network: 'testnet',
    now: () => 1700000000000,
    fetchImpl: stubFetch({
      'api.testnet.lnmarkets.com': (url, options) => {
        seen = { url, headers: options.headers }
        return { body: [] }
      },
    }),
  })

  await client.getTrades({ type: 'running', limit: 10 })

  assert.match(seen.url, /\/v2\/futures\?type=running&limit=10$/)
  assert.equal(seen.headers['LNM-ACCESS-KEY'], 'k')
  assert.equal(seen.headers['LNM-ACCESS-PASSPHRASE'], 'p')
  assert.equal(seen.headers['LNM-ACCESS-TIMESTAMP'], '1700000000000')
  assert.equal(
    seen.headers['LNM-ACCESS-SIGNATURE'],
    createHmac('sha256', 's').update('1700000000000GET/v2/futurestype=running&limit=10').digest('base64')
  )
})

test('public routes carry no credentials and reach the network the client was built for', async () => {
  let seen = null
  const client = createLnMarketsClient({
    network: 'mainnet',
    key: 'k',
    secret: 's',
    passphrase: 'p',
    fetchImpl: stubFetch({
      'api.lnmarkets.com': (url, options) => {
        seen = { url, headers: options.headers }
        return { body: { lastPrice: 100000 } }
      },
    }),
  })

  await client.getTicker()

  assert.equal(seen.url, 'https://api.lnmarkets.com/v2/futures/ticker')
  assert.equal(seen.headers['LNM-ACCESS-KEY'], undefined)
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
  await assert.rejects(() => client.getUser(), /credentials are missing/)
})

test('an error response is raised with its status and body', async () => {
  const client = createLnMarketsClient({
    fetchImpl: stubFetch({
      'futures/ticker': { ok: false, status: 429, statusText: 'Too Many Requests', body: 'slow down' },
    }),
  })
  await assert.rejects(() => client.getTicker(), /LN Markets 429 Too Many Requests.*slow down/)
})
