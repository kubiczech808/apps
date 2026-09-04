// Minimal LN Markets v2 REST client.
//
// Deliberately dependency-free: the same file has to run on a Raspberry Pi, in a
// GitHub Actions runner and inside `node --test`, and a bot that moves money is
// easier to trust when its transport is forty lines you can read than when it is
// a package tree you cannot.
//
// The signing scheme is the one LN Markets' own SDK implements
// (@ln-markets/api): base64 HMAC-SHA256 over
//   `${timestamp}${METHOD}/v2${path}${payload}`
// where payload is the URL-encoded query string for GET/DELETE and the JSON body
// for POST/PUT. Query parameters must be serialised in the SAME order they are
// signed in, or the server recomputes a different digest and answers 401 — so
// both the signature and the URL are built from one pass over `data`.

import { createHmac } from 'node:crypto'

export const HOSTNAMES = {
  mainnet: 'api.lnmarkets.com',
  testnet: 'api.testnet.lnmarkets.com',
}

export class LnMarketsError extends Error {
  constructor(status, statusText, body, path) {
    super(`LN Markets ${status} ${statusText} on ${path}: ${String(body).slice(0, 400)}`)
    this.name = 'LnMarketsError'
    this.status = status
    this.statusText = statusText
    this.body = body
    this.path = path
  }
}

const isQueryMethod = (method) => method === 'GET' || method === 'DELETE'

/**
 * Serialise request data once, so the signed payload and the sent bytes cannot
 * drift apart.
 */
export const buildPayload = (method, data) => {
  if (!data || Object.keys(data).length === 0) return ''
  if (isQueryMethod(method)) {
    const params = new URLSearchParams()
    for (const [key, value] of Object.entries(data)) {
      if (value === undefined || value === null) continue
      params.append(key, String(value))
    }
    return params.toString()
  }
  return JSON.stringify(data)
}

export const signRequest = ({ secret, timestamp, method, path, payload }) =>
  createHmac('sha256', secret)
    .update(`${timestamp}${method}/v2${path}${payload}`)
    .digest('base64')

export const createLnMarketsClient = (options = {}) => {
  const {
    key = process.env.LNM_API_KEY,
    secret = process.env.LNM_API_SECRET,
    passphrase = process.env.LNM_API_PASSPHRASE,
    network = process.env.LNM_API_NETWORK || 'testnet',
    hostname = process.env.LNM_API_HOSTNAME || HOSTNAMES[network] || HOSTNAMES.testnet,
    fetchImpl = globalThis.fetch,
    timeoutMs = 20000,
    now = () => Date.now(),
  } = options

  const hasCredentials = Boolean(key && secret && passphrase)

  const request = async ({ method, path, data, auth = false }) => {
    if (auth && !hasCredentials) {
      throw new Error(
        `LN Markets credentials are missing (need LNM_API_KEY, LNM_API_SECRET, LNM_API_PASSPHRASE) for ${method} ${path}`
      )
    }

    const payload = buildPayload(method, data)
    const headers = { Accept: 'application/json' }

    if (auth) {
      const timestamp = now()
      headers['LNM-ACCESS-KEY'] = key
      headers['LNM-ACCESS-PASSPHRASE'] = passphrase
      headers['LNM-ACCESS-TIMESTAMP'] = String(timestamp)
      headers['LNM-ACCESS-SIGNATURE'] = signRequest({ secret, timestamp, method, path, payload })
    }

    let url = `https://${hostname}/v2${path}`
    let body
    if (isQueryMethod(method)) {
      if (payload) url += `?${payload}`
    } else if (payload) {
      body = payload
      headers['Content-Type'] = 'application/json'
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    let response
    try {
      response = await fetchImpl(url, { method, body, headers, signal: controller.signal })
    } finally {
      clearTimeout(timer)
    }

    const text = await response.text()
    if (!response.ok) {
      throw new LnMarketsError(response.status, response.statusText, text, path)
    }
    if (!text) return null
    try {
      return JSON.parse(text)
    } catch {
      return text
    }
  }

  return {
    network,
    hostname,
    hasCredentials,
    request,

    // ── public market data ────────────────────────────────────────────────
    getTicker: () => request({ method: 'GET', path: '/futures/ticker' }),
    getPriceHistory: (data) => request({ method: 'GET', path: '/futures/history/price', data }),
    getIndexHistory: (data) => request({ method: 'GET', path: '/futures/history/index', data }),

    // ── account ──────────────────────────────────────────────────────────
    getUser: () => request({ method: 'GET', path: '/user', auth: true }),

    // ── futures ──────────────────────────────────────────────────────────
    // `type` is 'm' (market) or 'l' (limit); `side` is 'b' (buy/long) or 's'
    // (sell/short). Stop loss and take profit are held by LN Markets, which is
    // what lets this bot run on a timer instead of a socket.
    newTrade: (data) => request({ method: 'POST', path: '/futures', data, auth: true }),
    updateTrade: (data) => request({ method: 'PUT', path: '/futures', data, auth: true }),
    closeTrade: (id) => request({ method: 'DELETE', path: '/futures', data: { id }, auth: true }),
    cancelTrade: (id) => request({ method: 'POST', path: '/futures/cancel', data: { id }, auth: true }),
    addMargin: (data) => request({ method: 'POST', path: '/futures/add-margin', data, auth: true }),
    // type: 'running' (filled, open), 'open' (resting limit orders), 'closed'.
    getTrades: (data) => request({ method: 'GET', path: '/futures', data, auth: true }),
  }
}
