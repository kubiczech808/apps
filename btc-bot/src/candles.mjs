// OHLC candle sourcing.
//
// LN Markets' own `futures/candles` is the primary source, and it is the right
// one: the bot trades against the LN Markets index, so reading the chart from
// the same place removes a whole class of disagreement between what the
// strategy saw and what the stop was measured against. Public spot venues stay
// behind it as a fallback, because a single venue being unreachable (an
// outage, a geo-block on a CI runner, a rate limit) must not leave the bot
// blind — and a spot chart of BTC is close enough to keep managing a position
// that already exists.
//
// Everything downstream consumes ONE normalised shape, ascending by time:
//   { time, open, high, low, close, volume }   time = candle OPEN, epoch ms
//
// Only 1h candles are fetched. Higher timeframes are aggregated locally by
// `aggregate()` so that a source without a native 4h interval is still usable
// and so the bucket boundaries are identical whichever source answered.

export const HOUR_MS = 3600_000

const num = (value) => {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) throw new Error(`Non-numeric candle field: ${value}`)
  return parsed
}

const byTimeAscending = (a, b) => a.time - b.time

export const SOURCES = {
  bybit: {
    label: 'Bybit',
    url: ({ limit }) =>
      `https://api.bybit.com/v5/market/kline?category=linear&symbol=BTCUSDT&interval=60&limit=${Math.min(limit, 1000)}`,
    parse: (payload) =>
      (payload?.result?.list ?? []).map((row) => ({
        time: num(row[0]),
        open: num(row[1]),
        high: num(row[2]),
        low: num(row[3]),
        close: num(row[4]),
        volume: num(row[5]),
      })),
  },
  kraken: {
    label: 'Kraken',
    url: () => 'https://api.kraken.com/0/public/OHLC?pair=XBTUSD&interval=60',
    parse: (payload) => {
      const result = payload?.result ?? {}
      const key = Object.keys(result).find((name) => name !== 'last')
      return (result[key] ?? []).map((row) => ({
        time: num(row[0]) * 1000,
        open: num(row[1]),
        high: num(row[2]),
        low: num(row[3]),
        close: num(row[4]),
        volume: num(row[6]),
      }))
    },
  },
  coinbase: {
    label: 'Coinbase',
    url: () => 'https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=3600',
    parse: (payload) =>
      (Array.isArray(payload) ? payload : []).map((row) => ({
        time: num(row[0]) * 1000,
        low: num(row[1]),
        high: num(row[2]),
        open: num(row[3]),
        close: num(row[4]),
        volume: num(row[5]),
      })),
  },
}

export const DEFAULT_SOURCE_ORDER = ['lnmarkets', 'bybit', 'kraken', 'coinbase']

/**
 * Hourly candles from LN Markets itself.
 *
 * `from` is documented as a string and the candles come back with string
 * times, so ISO 8601 is sent first. A rejection is retried once with epoch
 * milliseconds rather than assumed to be fatal — the parameter's encoding is
 * the one detail of this route not pinned down by the SDK's types, and being
 * wrong about it should cost one extra request, not the bot's eyesight.
 */
export const fetchLnMarketsCandles = async ({ client, limit = 500 }) => {
  const to = Date.now()
  const from = to - (limit + 2) * HOUR_MS

  const attempt = async (encode) => {
    const payload = await client.getCandles({
      from: encode(from),
      to: encode(to),
      range: '1h',
      limit: Math.min(limit, 1000),
    })
    const rows = Array.isArray(payload) ? payload : (payload?.data ?? [])
    return rows.map((row) => ({
      time: typeof row.time === 'number' ? row.time : Date.parse(row.time),
      open: num(row.open),
      high: num(row.high),
      low: num(row.low),
      close: num(row.close),
      volume: num(row.volume ?? 0),
    }))
  }

  let candles
  try {
    candles = await attempt((ms) => new Date(ms).toISOString())
  } catch (error) {
    if (error?.status !== 400 && error?.status !== 422) throw error
    candles = await attempt((ms) => String(ms))
  }

  const usable = candles.filter((candle) => Number.isFinite(candle.time)).sort(byTimeAscending)
  if (usable.length === 0) throw new Error('LN Markets returned no candles')
  return usable.slice(-limit)
}

/**
 * Drop the candle that is still forming.
 *
 * A price-action signal read off a candle that has not closed repaints: the
 * wick that looks like a rejection at minute 10 can be the body of a
 * continuation at minute 55. Every decision in this bot is taken on closed
 * candles only, and this is the single place that guarantees it.
 */
export const dropForming = (candles, intervalMs, nowMs = Date.now()) =>
  candles.filter((candle) => candle.time + intervalMs <= nowMs)

export const fetchCandles = async ({
  source,
  limit = 500,
  fetchImpl = globalThis.fetch,
  timeoutMs = 15000,
  client,
} = {}) => {
  if (source === 'lnmarkets') {
    if (!client) throw new Error('LN Markets candles need a client')
    return fetchLnMarketsCandles({ client, limit })
  }

  const spec = SOURCES[source]
  if (!spec) throw new Error(`Unknown candle source: ${source}`)

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  let response
  try {
    response = await fetchImpl(spec.url({ limit }), {
      headers: { Accept: 'application/json', 'User-Agent': 'btc-dca-bot/1' },
      signal: controller.signal,
    })
  } finally {
    clearTimeout(timer)
  }

  if (!response.ok) {
    throw new Error(`${spec.label} candles HTTP ${response.status}`)
  }
  const payload = await response.json()
  const candles = spec.parse(payload).sort(byTimeAscending)
  if (candles.length === 0) throw new Error(`${spec.label} returned no candles`)
  return candles.slice(-limit)
}

export const fetchCandlesWithFallback = async ({
  order = DEFAULT_SOURCE_ORDER,
  ...options
} = {}) => {
  const failures = []
  for (const source of order) {
    try {
      const candles = await fetchCandles({ source, ...options })
      return { source, candles, failures }
    } catch (error) {
      failures.push(`${source}: ${error.message}`)
    }
  }
  throw new Error(`No candle source answered (${failures.join('; ')})`)
}

/**
 * Aggregate 1h candles into a higher timeframe, aligned to the UTC epoch so a
 * 4h bucket always starts at 00:00, 04:00, 08:00 … whichever venue served the
 * hours. Incomplete trailing buckets are dropped unless asked for.
 */
export const aggregate = (candles, factor, { includePartial = false } = {}) => {
  if (factor <= 1) return [...candles]
  const bucketMs = HOUR_MS * factor
  const buckets = new Map()

  for (const candle of candles) {
    const start = Math.floor(candle.time / bucketMs) * bucketMs
    const bucket = buckets.get(start)
    if (!bucket) {
      buckets.set(start, {
        time: start,
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
        volume: candle.volume,
        parts: 1,
      })
      continue
    }
    bucket.high = Math.max(bucket.high, candle.high)
    bucket.low = Math.min(bucket.low, candle.low)
    bucket.close = candle.close
    bucket.volume += candle.volume
    bucket.parts += 1
  }

  return [...buckets.values()]
    .sort(byTimeAscending)
    .filter((bucket) => includePartial || bucket.parts === factor)
    .map(({ parts, ...bucket }) => bucket)
}
