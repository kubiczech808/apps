// Synthetic candle construction for tests.
//
// Real market fixtures would be better, but this session cannot reach any
// exchange, and a hand-built series has one advantage a fixture does not: the
// structure under test is stated explicitly, so a failing assertion says which
// property of the chart the code misread.

export const HOUR = 3600_000
export const START = Date.UTC(2026, 0, 1)

/**
 * Build candles along a path of turning points. Each leg is linearly
 * interpolated over `steps` candles; wicks are `wick` fraction of the leg step
 * so swings are well defined and pivots are unambiguous.
 */
export const zigzag = (points, { steps = 6, wick = 0.25, start = START, scale = 1 } = {}) => {
  const candles = []
  let time = start
  for (let leg = 0; leg < points.length - 1; leg += 1) {
    const from = points[leg] * scale
    const to = points[leg + 1] * scale
    const delta = (to - from) / steps
    for (let step = 0; step < steps; step += 1) {
      const open = from + delta * step
      const close = from + delta * (step + 1)
      const spread = Math.abs(delta) * wick
      candles.push({
        time,
        open,
        close,
        high: Math.max(open, close) + spread,
        low: Math.min(open, close) - spread,
        volume: 1,
      })
      time += HOUR
    }
  }
  return candles
}

export const candle = (time, open, high, low, close) => ({ time, open, high, low, close, volume: 1 })

/** Append a candle that closes `close` after wicking down to `low`. */
export const appendCandle = (candles, { open, high, low, close }) => {
  const time = (candles.at(-1)?.time ?? START) + HOUR
  candles.push({ time, open, high, low, close, volume: 1 })
  return candles
}

/** A minimal fetch double that answers one URL pattern at a time. */
export const stubFetch = (routes) => async (url, options = {}) => {
  const key = Object.keys(routes).find((pattern) => String(url).includes(pattern))
  if (!key) throw new Error(`stubFetch has no route for ${url}`)
  const route = routes[key]
  const value = typeof route === 'function' ? await route(String(url), options) : route
  return {
    ok: value.ok !== false,
    status: value.status ?? 200,
    statusText: value.statusText ?? 'OK',
    headers: new Map([['content-type', 'application/json']]),
    json: async () => value.body,
    text: async () => (typeof value.body === 'string' ? value.body : JSON.stringify(value.body)),
  }
}
