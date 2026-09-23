// External trend and structure reference for the PA-1 dashboard.
//
// Twelve Data and Binance publish OHLC, not a ready-made trend label. This
// module deliberately uses a simple close + EMA(20/50) regime rather than the
// PA swing classifier. It is therefore a genuinely independent source for
// live PA-1 decisions; a missing or non-directional source fails closed.

import { aggregate, dropForming, fetchBinanceCandles, HOUR_MS } from './candles.mjs'
import { normalizeCandlePrices, roundPrice } from './price.mjs'

export const EXTERNAL_TREND_METHOD = 'EMA 20/50 + zavírací cena'
export const EXTERNAL_TREND_HOURLY_LIMIT = 5000
export const EXTERNAL_PIVOT_METHOD = 'Potvrzené 10-svíčkové pivoty z externího OHLC'
export const EXTERNAL_PIVOT_PERIOD = 10
export const EXTERNAL_PIVOT_FALLBACK_PERIOD = 5
export const EXTERNAL_PIVOT_OUTPUTSIZE = 2000

const EXTERNAL_PIVOT_INTERVALS = {
  '1h': { interval: '1h', ms: HOUR_MS },
  '4h': { interval: '4h', ms: 4 * HOUR_MS },
  '1d': { interval: '1day', ms: 24 * HOUR_MS },
}

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

const pivotValue = (value) => Number(value) === 1

const normalizeExternalPivots = (pivots = []) => {
  const alternating = []
  for (const pivot of [...pivots]
    .filter((item) => item?.kind && Number.isFinite(item?.price) && Number.isFinite(item?.time))
    .sort((left, right) => left.time - right.time)) {
    const previous = alternating.at(-1)
    if (!previous || previous.kind !== pivot.kind) {
      alternating.push(pivot)
      continue
    }
    const replaces = pivot.kind === 'high' ? pivot.price > previous.price : pivot.price < previous.price
    if (replaces) alternating[alternating.length - 1] = pivot
  }
  const previousByKind = { high: null, low: null }
  return alternating.map((pivot) => {
    const previous = previousByKind[pivot.kind]
    const label = !previous
      ? pivot.kind === 'high' ? 'H' : 'L'
      : pivot.kind === 'high'
        ? pivot.price > previous.price ? 'HH' : 'LH'
        : pivot.price > previous.price ? 'HL' : 'LL'
    previousByKind[pivot.kind] = pivot
    return { ...pivot, label }
  })
}

export const classifyExternalPivotPath = (pivots = []) => {
  const path = normalizeExternalPivots(pivots)
  const high = path.filter((pivot) => pivot.kind === 'high').slice(-2)
  const low = path.filter((pivot) => pivot.kind === 'low').slice(-2)
  const trend = high.length === 2 && low.length === 2
    ? high[1].price > high[0].price && low[1].price > low[0].price
      ? 'up'
      : high[1].price < high[0].price && low[1].price < low[0].price
        ? 'down'
        : 'flat'
    : 'flat'
  return { trend, pivots: path.slice(-12) }
}

const parseTwelvePivotValues = (values) => (Array.isArray(values) ? values : [])
  .flatMap((value) => {
    const time = twelveTime(value?.datetime)
    const high = numberOrNull(value?.high)
    const low = numberOrNull(value?.low)
    const close = numberOrNull(value?.close)
    if (!Number.isFinite(time)) return []
    const pivots = []
    if (pivotValue(value?.pivot_point_h) && Number.isFinite(high)) pivots.push({ kind: 'high', price: high, close, time })
    if (pivotValue(value?.pivot_point_l) && Number.isFinite(low)) pivots.push({ kind: 'low', price: low, close, time })
    return pivots
  })

export const fetchTwelveDataFxPivots = async ({
  assets = [],
  apiKey,
  timeframeId = '1h',
  outputsize = EXTERNAL_PIVOT_OUTPUTSIZE,
  timePeriod = EXTERNAL_PIVOT_PERIOD,
  fetchImpl = globalThis.fetch,
  timeoutMs = 15000,
} = {}) => {
  const spec = EXTERNAL_PIVOT_INTERVALS[timeframeId]
  if (!spec) throw new Error(`Unsupported external pivot timeframe ${timeframeId}`)
  const fxAssets = assets.filter((asset) => asset.group === 'fx' && asset.twelveSymbol)
  if (!apiKey) throw new Error('TWELVE_DATA_API_KEY není nastaven')
  if (!fxAssets.length) return {}
  const params = new URLSearchParams({
    symbol: fxAssets.map((asset) => asset.twelveSymbol).join(','),
    interval: spec.interval,
    time_period: String(timePeriod),
    outputsize: String(outputsize),
    include_ohlc: 'true',
    apikey: apiKey,
  })
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  let response
  try {
    response = await fetchImpl(`https://api.twelvedata.com/pivot_points_hl?${params}`, {
      headers: { Accept: 'application/json', 'User-Agent': 'btc-dca-bot/1' },
      signal: controller.signal,
    })
  } finally {
    clearTimeout(timer)
  }
  if (!response.ok) throw new Error(`Twelve Data pivot HTTP ${response.status}`)
  const payload = await response.json()
  const error = responseError(payload)
  if (error) throw new Error(`Twelve Data: ${error}`)
  const result = {}
  for (const asset of fxAssets) {
    const series = payload?.[asset.twelveSymbol] ?? (fxAssets.length === 1 ? payload : null)
    const pivots = parseTwelvePivotValues(series?.values)
    if (!pivots.length) throw new Error(`Twelve Data returned no pivot points for ${asset.twelveSymbol}`)
    result[asset.symbol] = classifyExternalPivotPath(pivots)
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

const confirmedPivotCandidates = (candles, period) => {
  const candidates = []
  for (let index = period; index < candles.length - period; index += 1) {
    const window = candles.slice(index - period, index + period + 1)
    const candle = candles[index]
    const maxHigh = Math.max(...window.map((item) => item.high))
    const minLow = Math.min(...window.map((item) => item.low))
    if (candle.high === maxHigh && window.filter((item) => item.high === maxHigh).length === 1) {
      candidates.push({ kind: 'high', price: candle.high, close: candle.close, time: candle.time })
    }
    if (candle.low === minLow && window.filter((item) => item.low === minLow).length === 1) {
      candidates.push({ kind: 'low', price: candle.low, close: candle.close, time: candle.time })
    }
  }
  return candidates
}

export const confirmedExternalPivotPath = ({ candles = [], timeframeId = '1h', now = Date.now() } = {}) => {
  const spec = EXTERNAL_PIVOT_INTERVALS[timeframeId]
  if (!spec) return { trend: 'flat', pivots: [], timePeriod: EXTERNAL_PIVOT_PERIOD }
  const completed = forTimeframe(candles, timeframeId, now)
  let timePeriod = EXTERNAL_PIVOT_PERIOD
  let candidates = confirmedPivotCandidates(completed, timePeriod)
  // The external line is only an audit aid. A broad 10-candle confirmation is
  // preferred, but an empty path is not useful to audit a live source at all.
  if (candidates.length < 2) {
    timePeriod = EXTERNAL_PIVOT_FALLBACK_PERIOD
    candidates = confirmedPivotCandidates(completed, timePeriod)
  }
  return { ...classifyExternalPivotPath(candidates), timePeriod }
}

// Kept as an explicit BTC alias for callers and saved state from the first
// external-reference release. FX now uses this same independent confirmation
// over Twelve Data OHLC, avoiding their Pro-only pivot indicator endpoint.
export const binancePivotPath = confirmedExternalPivotPath

const pivotBucket = (timeframeId, now) => Math.floor(now / EXTERNAL_PIVOT_INTERVALS[timeframeId].ms)

export const canReuseExternalPivotBucket = ({ previous, assets = [], timeframeId, bucket }) =>
  previous?.pivots?.buckets?.[timeframeId] === bucket &&
  assets.every((asset) => previous.pivots.assets?.[asset.symbol]?.[timeframeId] != null)

const pivotReference = ({ trend, pivots, source, timeframeId, asOf = null, timePeriod = EXTERNAL_PIVOT_PERIOD }) => ({
  trend,
  pivots,
  source,
  method: EXTERNAL_PIVOT_METHOD,
  timePeriod,
  timeframeId,
  asOf: asOf ?? pivots.at(-1)?.time ?? null,
})

const buildExternalPivotReferences = async ({ assets, hourly = {}, previous = null, now }) => {
  const result = { assets: {}, failures: [], buckets: {} }
  for (const asset of assets) result.assets[asset.symbol] = {}
  for (const timeframeId of Object.keys(EXTERNAL_PIVOT_INTERVALS)) {
    const bucket = pivotBucket(timeframeId, now)
    const cached = canReuseExternalPivotBucket({ previous, assets, timeframeId, bucket })
      ? previous.pivots
      : null
    result.buckets[timeframeId] = bucket
    if (cached?.assets) {
      for (const asset of assets) result.assets[asset.symbol][timeframeId] = cached.assets?.[asset.symbol]?.[timeframeId] ?? null
      continue
    }
    for (const asset of assets) {
      if (asset.group === 'fx') {
        const candles = hourly[asset.symbol]
        const path = candles?.length
          ? confirmedExternalPivotPath({ candles, timeframeId, now })
          : null
        result.assets[asset.symbol][timeframeId] = path
          ? pivotReference({ ...path, source: 'Twelve Data', timeframeId })
          : null
      } else if (asset.symbol === 'BTCUSD' && hourly.BTCUSD?.length) {
        const path = confirmedExternalPivotPath({ candles: hourly.BTCUSD, timeframeId, now })
        result.assets[asset.symbol][timeframeId] = pivotReference({ ...path, source: 'Binance BTCUSDT', timeframeId })
      }
    }
  }
  return result
}

export const buildExternalTrendReference = async ({
  assets = [],
  apiKey = '',
  fetchImpl = globalThis.fetch,
  now = Date.now(),
  logger = console,
  previous = null,
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

  const pivots = await buildExternalPivotReferences({
    assets,
    hourly,
    previous,
    now,
  })

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
    pivots,
    failures: [...failures, ...pivots.failures],
  }
}
