// Price-action primitives.
//
// Everything here is a pure function over an array of closed candles, so the
// whole chart reading can be tested against fixtures without a network. The
// strategy layer composes these; it never re-implements them.
//
// Vocabulary used throughout:
//   swing      a pivot high/low confirmed by `lookback` candles on BOTH sides.
//              The right-hand confirmation is why a swing is only ever known
//              `lookback` candles late — that lag is real and is not cheated.
//   structure  the sequence of swings: higher highs + higher lows is an
//              uptrend, lower highs + lower lows a downtrend, anything else a
//              range.
//   BOS        break of structure: a close beyond the last swing in the
//              direction of the trend — continuation.
//   CHoCH      change of character: a close beyond the last counter-swing —
//              the first evidence the trend is failing.
//   zone       a price band where swings clustered, i.e. where the market has
//              repeatedly turned. Demand below, supply above.

export const body = (candle) => Math.abs(candle.close - candle.open)
export const range = (candle) => candle.high - candle.low
export const upperWick = (candle) => candle.high - Math.max(candle.open, candle.close)
export const lowerWick = (candle) => Math.min(candle.open, candle.close) - candle.low
export const isBullish = (candle) => candle.close > candle.open
export const isBearish = (candle) => candle.close < candle.open

/**
 * Wilder's ATR. Returns an array the same length as `candles`; entries before
 * the average is defined are null, so callers cannot silently read a warmup
 * value as if it were a measurement.
 */
export const atr = (candles, period = 14) => {
  const out = new Array(candles.length).fill(null)
  if (candles.length <= period) return out

  const trueRanges = candles.map((candle, index) => {
    if (index === 0) return range(candle)
    const previousClose = candles[index - 1].close
    return Math.max(
      candle.high - candle.low,
      Math.abs(candle.high - previousClose),
      Math.abs(candle.low - previousClose)
    )
  })

  let average = trueRanges.slice(1, period + 1).reduce((sum, value) => sum + value, 0) / period
  out[period] = average
  for (let index = period + 1; index < candles.length; index += 1) {
    average = (average * (period - 1) + trueRanges[index]) / period
    out[index] = average
  }
  return out
}

export const lastDefined = (series) => {
  for (let index = series.length - 1; index >= 0; index -= 1) {
    if (series[index] !== null && series[index] !== undefined) return series[index]
  }
  return null
}

/**
 * Fractal pivots. A candle is a swing high when its high is the strict maximum
 * of the window `lookback` candles either side (ties are rejected: a flat top
 * is not a pivot, and admitting it produced duplicate levels one tick apart).
 */
export const findSwings = (candles, lookback = 2) => {
  const swings = []
  for (let index = lookback; index < candles.length - lookback; index += 1) {
    const candle = candles[index]
    let isHigh = true
    let isLow = true
    for (let offset = 1; offset <= lookback; offset += 1) {
      const left = candles[index - offset]
      const right = candles[index + offset]
      if (left.high >= candle.high || right.high >= candle.high) isHigh = false
      if (left.low <= candle.low || right.low <= candle.low) isLow = false
      if (!isHigh && !isLow) break
    }
    if (isHigh) swings.push({ index, time: candle.time, price: candle.high, kind: 'high', candle })
    if (isLow) swings.push({ index, time: candle.time, price: candle.low, kind: 'low', candle })
  }
  return swings
}

/**
 * Read trend and the most recent structural break.
 *
 * Bias needs two highs AND two lows, because one alone cannot distinguish a
 * trend from a range that happens to have a taller top.
 */
export const marketStructure = (candles, { lookback = 2 } = {}) => {
  const swings = findSwings(candles, lookback)
  const highs = swings.filter((swing) => swing.kind === 'high')
  const lows = swings.filter((swing) => swing.kind === 'low')

  const lastHigh = highs.at(-1) ?? null
  const previousHigh = highs.at(-2) ?? null
  const lastLow = lows.at(-1) ?? null
  const previousLow = lows.at(-2) ?? null

  let bias = 'range'
  if (lastHigh && previousHigh && lastLow && previousLow) {
    const higherHighs = lastHigh.price > previousHigh.price
    const higherLows = lastLow.price > previousLow.price
    const lowerHighs = lastHigh.price < previousHigh.price
    const lowerLows = lastLow.price < previousLow.price
    if (higherHighs && higherLows) bias = 'up'
    else if (lowerHighs && lowerLows) bias = 'down'
  }

  // A break is read from the latest CLOSED candle against the last confirmed
  // swing. The swing itself is `lookback` candles old by construction, so the
  // comparison is never a candle against its own pivot.
  const latestIndex = candles.length - 1
  const latest = candles[latestIndex] ?? null
  let event = null
  if (latest && lastHigh && latestIndex > lastHigh.index && latest.close > lastHigh.price) {
    event = bias === 'down' ? 'CHoCH_UP' : 'BOS_UP'
  }
  if (event === null && latest && lastLow && latestIndex > lastLow.index && latest.close < lastLow.price) {
    event = bias === 'up' ? 'CHoCH_DOWN' : 'BOS_DOWN'
  }

  return { bias, event, swings, highs, lows, lastHigh, previousHigh, lastLow, previousLow }
}

const overlaps = (a, b) => a.low <= b.high && b.low <= a.high

/**
 * Cluster swing pivots into supply/demand bands.
 *
 * A single pivot is a level; a level the market has turned at more than once is
 * a zone, and the touch count is what separates the two. The band is taken from
 * the pivot candle's body-to-wick extreme rather than from the pivot price
 * alone: an order sitting exactly on the tick of an old low fills on noise,
 * whereas the band is where the reaction actually happened.
 */
export const buildZones = (candles, { lookback = 2, tolerance, maxAgeCandles = 400 } = {}) => {
  const swings = findSwings(candles, lookback)
  const atrSeries = atr(candles, 14)
  const reference = lastDefined(atrSeries) ?? (candles.at(-1)?.close ?? 0) * 0.005
  const band = tolerance ?? reference * 0.75
  const oldestIndex = Math.max(0, candles.length - maxAgeCandles)

  const raw = swings
    .filter((swing) => swing.index >= oldestIndex)
    .map((swing) => {
      const { candle } = swing
      const bodyLow = Math.min(candle.open, candle.close)
      const bodyHigh = Math.max(candle.open, candle.close)
      return swing.kind === 'low'
        ? { type: 'demand', low: candle.low, high: Math.max(bodyLow, candle.low + band * 0.5), swing }
        : { type: 'supply', low: Math.min(bodyHigh, candle.high - band * 0.5), high: candle.high, swing }
    })

  const zones = []
  for (const item of raw) {
    const match = zones.find((zone) => zone.type === item.type && overlaps(zone, item))
    if (match) {
      match.low = Math.min(match.low, item.low)
      match.high = Math.max(match.high, item.high)
      match.touches += 1
      match.lastIndex = Math.max(match.lastIndex, item.swing.index)
      match.lastTime = Math.max(match.lastTime, item.swing.time)
      continue
    }
    zones.push({
      type: item.type,
      low: item.low,
      high: item.high,
      touches: 1,
      firstIndex: item.swing.index,
      lastIndex: item.swing.index,
      lastTime: item.swing.time,
    })
  }

  return zones.sort((a, b) => a.low - b.low)
}

export const zoneContains = (zone, price) => price >= zone.low && price <= zone.high

/**
 * Candlestick triggers.
 *
 * Only three are recognised, and deliberately so: engulfing, rejection (pin
 * bar) and inside-bar break are the ones that survive being defined precisely.
 * A pattern nobody can define without arguing is a pattern nobody can backtest.
 */
export const candleSignal = (candles, index = candles.length - 1, { atrValue } = {}) => {
  const candle = candles[index]
  const previous = candles[index - 1]
  if (!candle || !previous) return { bullish: null, bearish: null, patterns: [] }

  const candleRange = range(candle)
  const candleBody = body(candle)
  const patterns = []
  let bullish = null
  let bearish = null

  const meaningful = !atrValue || candleRange >= atrValue * 0.4

  if (
    meaningful &&
    isBearish(previous) &&
    isBullish(candle) &&
    candle.close >= previous.open &&
    candle.open <= previous.close
  ) {
    patterns.push('bullish_engulfing')
    bullish = 'bullish_engulfing'
  }
  if (
    meaningful &&
    isBullish(previous) &&
    isBearish(candle) &&
    candle.close <= previous.open &&
    candle.open >= previous.close
  ) {
    patterns.push('bearish_engulfing')
    bearish = 'bearish_engulfing'
  }

  if (candleRange > 0) {
    const closePosition = (candle.close - candle.low) / candleRange
    if (meaningful && lowerWick(candle) >= candleBody * 2 && upperWick(candle) <= candleBody && closePosition >= 0.6) {
      patterns.push('bullish_rejection')
      bullish = bullish ?? 'bullish_rejection'
    }
    if (meaningful && upperWick(candle) >= candleBody * 2 && lowerWick(candle) <= candleBody && closePosition <= 0.4) {
      patterns.push('bearish_rejection')
      bearish = bearish ?? 'bearish_rejection'
    }
  }

  const insideBar = previous.high >= candle.high && previous.low <= candle.low
  if (insideBar) patterns.push('inside_bar')

  return { bullish, bearish, patterns }
}

/** Nearest confirmed swing high strictly above `price` — a long's structural target. */
export const nextSwingAbove = (structure, price) =>
  structure.highs.filter((swing) => swing.price > price).sort((a, b) => a.price - b.price)[0] ?? null

/** Nearest confirmed swing low strictly below `price` — a short's structural target. */
export const nextSwingBelow = (structure, price) =>
  structure.lows.filter((swing) => swing.price < price).sort((a, b) => b.price - a.price)[0] ?? null
