// LN Markets v3 REST client.
//
// Dependency-free on purpose: the same file runs on a Raspberry Pi, in a
// GitHub Actions runner and inside `node --test`, and a bot that moves money is
// easier to trust when its transport is a hundred lines you can read.
//
// Targets **v3**. The older v2 API was deprecated in January 2026, and the
// widely-linked `@ln-markets/api` package still points at
// `api.testnet.lnmarkets.com`, a host that no longer resolves — the first
// deploy of this bot failed on exactly that, with ENOTFOUND. The contract below
// is taken from LN Markets' current SDK (`@ln-markets/sdk`), not from memory.
//
// Signing, and the three details that are easy to get wrong:
//   payload   = `${timestamp}${method.toLowerCase()}${pathname}${data}`
//   method    is LOWERCASE in v3 (it was uppercase in v2)
//   pathname  includes the `/v3` prefix
//   data      is the JSON body for POST/PUT, otherwise the query string
//             INCLUDING its leading `?` (empty when there are no parameters)
// The signature is base64 HMAC-SHA256 of that with the API secret.

import { createHmac } from 'node:crypto'

export const NETWORKS = {
  mainnet: 'https://api.lnmarkets.com/v3',
  testnet4: 'https://api.testnet4.lnmarkets.com/v3',
}

// 'testnet' is what people type and what earlier configs hold; Bitcoin's
// testnet3 is gone and LN Markets moved to testnet4, so accept the short name
// rather than failing on a value that is merely out of date.
export const resolveNetwork = (network) => (network === 'testnet' ? 'testnet4' : network || 'mainnet')

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

const hasBody = (method) => method === 'POST' || method === 'PUT'

/** Drop undefined so they neither reach the URL nor change the signature. */
export const buildQuery = (data) => {
  if (!data) return ''
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined || value === null || value === '') continue
    params.append(key, String(value))
  }
  const query = params.toString()
  return query ? `?${query}` : ''
}

export const signRequest = ({ secret, timestamp, method, pathname, data }) =>
  createHmac('sha256', secret)
    .update(`${timestamp}${method.toLowerCase()}${pathname}${data}`)
    .digest('base64')

export const createLnMarketsClient = (options = {}) => {
  const {
    key = process.env.LNM_API_KEY,
    secret = process.env.LNM_API_SECRET,
    passphrase = process.env.LNM_API_PASSPHRASE,
    network = resolveNetwork(process.env.LNM_API_NETWORK),
    baseUrl = process.env.LNM_API_URL || NETWORKS[resolveNetwork(network)] || NETWORKS.mainnet,
    fetchImpl = globalThis.fetch,
    timeoutMs = 20000,
    now = () => Date.now(),
  } = options

  const resolved = resolveNetwork(network)
  const hasCredentials = Boolean(key && secret && passphrase)
  const { pathname: basePath, origin } = new URL(baseUrl)
  const prefix = basePath.replace(/\/$/, '')

  const request = async ({ method, path, data, auth = false }) => {
    if (auth && !hasCredentials) {
      throw new Error(
        `LN Markets credentials are missing (need LNM_API_KEY, LNM_API_SECRET, LNM_API_PASSPHRASE) for ${method} ${path}`
      )
    }

    const pathname = `${prefix}/${path}`
    const body = hasBody(method) && data ? JSON.stringify(data) : undefined
    const query = hasBody(method) ? '' : buildQuery(data)
    const signed = body ?? query

    const headers = { Accept: 'application/json' }
    if (body) headers['Content-Type'] = 'application/json'
    if (auth) {
      const timestamp = now()
      headers['lnm-access-key'] = key
      headers['lnm-access-passphrase'] = passphrase
      headers['lnm-access-timestamp'] = String(timestamp)
      headers['lnm-access-signature'] = signRequest({ secret, timestamp, method, pathname, data: signed })
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    let response
    try {
      response = await fetchImpl(`${origin}${pathname}${query}`, { method, body, headers, signal: controller.signal })
    } finally {
      clearTimeout(timer)
    }

    const text = await response.text()
    if (!response.ok) throw new LnMarketsError(response.status, response.statusText, text, pathname)
    if (!text) return null
    try {
      return JSON.parse(text)
    } catch {
      return text
    }
  }

  return {
    network: resolved,
    baseUrl: `${origin}${prefix}`,
    hasCredentials,
    request,

    // ── public ───────────────────────────────────────────────────────────
    ping: () => request({ method: 'GET', path: 'ping' }),
    getTicker: () => request({ method: 'GET', path: 'futures/ticker' }),
    // `range` is a resolution such as '1m', '15m', '1h', '4h', '1d'. `from` is
    // required. The response is paginated: { data: [...], nextCursor }.
    getCandles: (data) => request({ method: 'GET', path: 'futures/candles', data }),

    // ── account ──────────────────────────────────────────────────────────
    getAccount: () => request({ method: 'GET', path: 'account', auth: true }),

    // ── isolated futures ─────────────────────────────────────────────────
    // Isolated rather than cross: each position carries its own margin, so one
    // trade going wrong cannot reach into another's, and liquidation is a
    // property of the trade the stop was sized against.
    newTrade: (data) => request({ method: 'POST', path: 'futures/isolated/trade', data, auth: true }),
    getRunningTrades: () => request({ method: 'GET', path: 'futures/isolated/trades/running', auth: true }),
    getOpenTrades: () => request({ method: 'GET', path: 'futures/isolated/trades/open', auth: true }),
    getClosedTrades: (data) =>
      request({ method: 'GET', path: 'futures/isolated/trades/closed', data, auth: true }),
    updateStopLoss: (id, value) =>
      request({ method: 'PUT', path: 'futures/isolated/trade/stoploss', data: { id, value }, auth: true }),
    updateTakeProfit: (id, value) =>
      request({ method: 'PUT', path: 'futures/isolated/trade/takeprofit', data: { id, value }, auth: true }),
    closeTrade: (id) =>
      request({ method: 'POST', path: 'futures/isolated/trade/close', data: { id }, auth: true }),
    cancelTrade: (id) =>
      request({ method: 'POST', path: 'futures/isolated/trade/cancel', data: { id }, auth: true }),
  }
}
