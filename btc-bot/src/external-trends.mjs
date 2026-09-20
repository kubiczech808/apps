// Independent trend reference for the PA-1 dashboard.
//
// Twelve Data and Binance publish OHLC, not a ready-made trend label. This
// module deliberately uses a simple close + EMA(20/50) regime rather than the
// PA swing classifier. It is therefore useful as a genuinely independent
// cross-check, while it remains display-only and cannot authorize a trade.

import { aggregate, dropForming, fetchBinanceCandles, HOUR_MS } from './candles.mjs'
import { normalizeCandlePrices, roundPrice } from './price.mjs'

export const EXTERNAL_TREND_METHOD = 'EMA 20/50 + zavírací cena'
export const EXTERNAL_TREND_HOURLY_LIMIT = 5000

const numberOrNull = (value) => {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

const twelveTime = (value) => {
  const raw = String(value ?? '').trim()
  if (!raw) return null
  const iso = /(?:Z|[+-]\d\d:?\d\d)$/.test(raw) ? raw : `${raw.replace(' ', 'T')}Z`
  const parsed = Date.parse(iso)
  return Number.isFinite(parsed) ? parsed : null
}

const parseTwelveCandles = (values) => (Array.isArray(values) ? values : [])
  .map((value) => {
    const time = twelveTime(value?.datetime)
    const open = numberOrNull(value?.open)
    const high = numberOrNull(value?.high)
    const low = numberOrNull(value?.low)
    const close = numberOrNull(value?.close)
    if (!Number.isFinite(time) || [open, high, low, close].some((item) => !(item > 0))) return null
    return normalizeCandlePrices({ time, open, high, low, close, volume: numberOrNull(value?.volume) ?? 0 })
  })
  .filter(Boolean)
  .sort((left, right) => left.time - right.time)

const responseError = (payload) => {
  if (!payload || typeof payload !== 'object') return null
  if (payload.status === 'error' || payload.code || payload.message) {
    return payload.message ?? payload.status ?? `Twelve Data error ${payload.code ?? ''}`.trim()
  }
  return null
}

export const fetchTwelveDataFxHourly = async ({
  assets = [],
  apiKey,
  outputsize = EXTERNAL_TREND_HOURLY_LIMIT,
  fetchImpl = globalThis.fetch,
  timeoutMs = 15000,
} = {}) => {
  const fxAssets = assets.filter((asset) => asset.group === 'fx' && asset.twelveSymbol)
  if (!apiKey) throw new Error('TWELVE_DATA_API_KEY není nastaven')
  if (!fxAssets.length) return {}
  const params = new URLSearchParams({
    symbol: fxAssets.map((asset) => asset.twelveSymbol).join(','),
    interval: '1h',
    outputsize: String(outputsize),
    apikey: apiKey,
  })
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  let response
  try {
    response = await fetchImpl(`https://api.twelvedata.com/time_series?${params}`, {
      headers: { Accept: 'application/json', 'User-Agent': 'btc-dca-bot/1' },
      signal: controller.signal,
    })
  } finally {
    clearTimeout(timer)
  }
  if (!response.ok) throw new Error(`Twelve Data HTTP ${response.status}`)
  const payload = await response.json()
  const error = responseError(payload)
  if (error) throw new Error(`Twelve Data: ${error}`)
  const result = {}
  for (const asset of fxAssets) {
    const series = payload?.[asset.twelveSymbol]
    const candles = parseTwelveCandles(series?.values)
    if (!candles.length) throw new Error(`Twelve Data returned no usable candles for ${asset.twelveSymbol}`)
    result[asset.symbol] = candles
  }
  return result
}

const ema = (values, period) => {
  if (values.length < period) return null
  const multiplier = 2 / (period + 1)
  let result = values[0]
  for (const value of values.slice(1)) result = (value - result) * multiplier + result
  return result
}

export const classifyExternalTrend = (candles = []) => {
  const closes = candles.map((candle) => candle.close).filter(Number.isFinite)
  const close = closes.at(-1)
  const fast = ema(closes, 20)
  const slow = ema(closes, 50)
  if (![close, fast, slow].every(Number.isFinite)) {
    return {
      trend: null,
      method: EXTERNAL_TREND_METHOD,
      reason: `málo svíček pro EMA 50 (${closes.length}/50)`,
      candles: closes.length,
      asOf: candles.at(-1)?.time ?? null,
    }
  }
  const trend = close > fast && fast > slow
    ? 'up'
    : close < fast && fast < slow
      ? 'down'
      : 'flat'
  return {
    trend,
    method: EXTERNAL_TREND_METHOD,
    reason: `close ${roundPrice(close)}; EMA20 ${roundPrice(fast)}; EMA50 ${roundPrice(slow)}`,
    candles: closes.length,
    asOf: candles.at(-1)?.time ?? null,
  }
}

const forTimeframe = (hourly, timeframeId, now) => {
  const closedHourly = dropForming(hourly, HOUR_MS, now)
  if (timeframeId === '1h') return closedHourly
  return aggregate(closedHourly, timeframeId === '4h' ? 4 : 24)
}

export const buildExternalTrendReference = async ({
  assets = [],
  apiKey = '',
  fetchImpl = globalThis.fetch,
  now = Date.now(),
  logger = console,
} = {}) => {
  const hourly = {}
  const failures = []
  const fxAssets = assets.filter((asset) => asset.group === 'fx')
  if (apiKey) {
    try {
      Object.assign(hourly, await fetchTwelveDataFxHourly({ assets: fxAssets, apiKey, fetchImpl }))
    } catch (error) {
      failures.push(`Twelve Data: ${error.message}`)
      logger?.warn?.(`External FX trend reference failed: ${error.message}`)
    }
  } else {
    failures.push('Twelve Data: TWELVE_DATA_API_KEY není nastaven')
  }

  const btc = assets.find((asset) => asset.symbol === 'BTCUSD')
  if (btc) {
    try {
      hourly[btc.symbol] = await fetchBinanceCandles({
        limit: EXTERNAL_TREND_HOURLY_LIMIT,
        fetchImpl,
        pauseMs: 0,
      })
    } catch (error) {
      failures.push(`Binance: ${error.message}`)
      logger?.warn?.(`External BTC trend reference failed: ${error.message}`)
    }
  }

  const rows = {}
  for (const asset of assets) {
    const source = asset.group === 'fx' ? 'Twelve Data' : 'Binance BTCUSDT'
    const sourceFailure = asset.group === 'fx'
      ? failures.find((failure) => failure.startsWith('Twelve Data:'))
      : failures.find((failure) => failure.startsWith('Binance:'))
    rows[asset.symbol] = {}
    for (const timeframeId of ['1h', '4h', '1d']) {
      const result = hourly[asset.symbol]
        ? classifyExternalTrend(forTimeframe(hourly[asset.symbol], timeframeId, now))
        : { trend: null, method: EXTERNAL_TREND_METHOD, reason: sourceFailure ?? 'zdroj není dostupný', candles: 0, asOf: null }
      rows[asset.symbol][timeframeId] = { ...result, source }
    }
  }

  return {
    generatedAt: new Date(now).toISOString(),
    hourBucket: Math.floor(now / HOUR_MS),
    method: EXTERNAL_TREND_METHOD,
    assets: rows,
    failures,
  }
}
