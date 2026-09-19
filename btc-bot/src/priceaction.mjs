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
//   zone       the base immediately before an impulsive departure that leaves
//              a three-candle fair value gap. Demand below, supply above.

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

// Market structure is a zigzag, not two independent lists of highs and lows.
// If the fractal detector emits two pivots of the same kind before an opposite
// turn is confirmed, retain only the more extreme pivot of that unfinished leg.
export const alternatingSwings = (swings = []) => {
  const out = []
  for (const swing of swings) {
    const previous = out.at(-1)
    if (!previous || previous.kind !== swing.kind) {
      out.push(swing)
      continue
    }
    const moreExtreme = swing.kind === 'high'
      ? swing.price > previous.price
      : swing.price < previous.price
    if (moreExtreme) out[out.length - 1] = swing
  }
  return out
}

// A wick beyond an established swing is a liquidity sweep, not a new
// structural vertex. The reference level remains the earlier swing wick, but
// the candidate candle must close beyond it before it can replace that swing.
// Keeping this filter after the fractal detector preserves wick prices for
// chart geometry without allowing a wick-only extension into HH/LL/LH/HL.
export const closeConfirmedStructuralSwings = (candles, lookback = 2) => {
  const candidates = alternatingSwings(findSwings(candles, lookback))
  const accepted = []
  let previousHigh = null
  let previousLow = null

  for (const swing of candidates) {
    const previous = swing.kind === 'high' ? previousHigh : previousLow
    const extendsPrevious = previous && (swing.kind === 'high'
      ? swing.price > previous.price
      : swing.price < previous.price)
    const closesBeyondPrevious = !previous || (swing.kind === 'high'
      ? swing.candle.close > previous.price
      : swing.candle.close < previous.price)

    if (extendsPrevious && !closesBeyondPrevious) continue
    accepted.push(swing)
    if (swing.kind === 'high') previousHigh = swing
    else previousLow = swing
  }

  // Removing a wick-only sweep can join two same-kind legs. They are one
  // unfinished leg, so retain only its true extreme before trend evaluation.
  return alternatingSwings(accepted)
}

/**
 * Read trend and the most recent structural break.
 *
 * Bias needs two highs AND two lows, because one alone cannot distinguish a
 * trend from a range that happens to have a taller top.
 */
export const marketStructure = (candles, { lookback = 2 } = {}) => {
  const swings = closeConfirmedStructuralSwings(candles, lookback)
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

/**
 * Supply/demand is the FVG created by a qualifying displacement, not every
 * swing pivot. The base validates the origin of that displacement; it is not
 * itself the price range offered for an entry.
 *
 * The sequence required here is:
 *   base -> directional displacement -> three-candle FVG confirmation.
 * The FVG's middle candle is the displacement candle. Its first candle, or the
 * nearest opposite/indecision candle immediately behind it, is the base. This
 * keeps an unrelated gap elsewhere in the chart from blessing an ordinary
 * swing as a zone.
 */
export const buildFvgSupplyDemandZones = (candles, {
  maxAgeCandles = 400,
  minGapAtr = 0.1,
  minDisplacementAtr = 0.8,
  maxBaseCandles = 3,
} = {}) => {
  const atrSeries = atr(candles, 14)
  const reference = lastDefined(atrSeries) ?? (candles.at(-1)?.close ?? 0) * 0.005
  const oldestIndex = Math.max(0, candles.length - maxAgeCandles)
  const gaps = fairValueGaps(candles, { atrValue: reference, minSizeAtr: minGapAtr })
  const zones = []

  for (const gap of gaps) {
    const displacementIndex = gap.index
    const displacement = candles[displacementIndex]
    const localAtr = atrSeries[displacementIndex] ?? reference
    const directional = gap.direction === 'bullish' ? isBullish(displacement) : isBearish(displacement)
    const bodyShare = range(displacement) > 0 ? body(displacement) / range(displacement) : 0
    if (!directional || body(displacement) < localAtr * minDisplacementAtr || bodyShare < 0.5) continue

    const firstFvgIndex = displacementIndex - 1
    const searchStart = Math.max(oldestIndex, firstFvgIndex - Math.max(1, maxBaseCandles) + 1)
    let baseIndex = null
    for (let index = firstFvgIndex; index >= searchStart; index -= 1) {
      const candidate = candles[index]
      const opposite = gap.direction === 'bullish' ? !isBullish(candidate) : !isBearish(candidate)
      const candidateBodyShare = range(candidate) > 0 ? body(candidate) / range(candidate) : 0
      const indecision = candidateBodyShare <= 0.45
      const compact = range(candidate) <= localAtr * 0.75 || range(candidate) <= range(displacement) * 0.5
      if (opposite || indecision || compact) {
        baseIndex = index
        break
      }
    }
    if (baseIndex === null) continue
    const base = candles[baseIndex]
    const brokeBase = gap.direction === 'bullish'
      ? displacement.close > base.high
      : displacement.close < base.low
    if (!brokeBase || baseIndex < oldestIndex) continue

    const type = gap.direction === 'bullish' ? 'demand' : 'supply'
    // The zone is the untraded three-candle imbalance. Keeping the base only
    // as provenance prevents an ordinary gap from becoming a trade zone.
    const low = gap.low
    const high = gap.high
    if (!(high > low)) continue

    const confirmationIndex = gap.confirmationIndex ?? displacementIndex + 1
    const continuation = zones.find((zone) => (
      zone.type === type
      && zone.low <= high
      && low <= zone.high
      && baseIndex <= zone.lastIndex + 1
      && confirmationIndex >= zone.firstIndex - 1
    ))
    if (continuation) {
      // A multi-candle base can produce consecutive overlapping FVG triples.
      // That is one origin with continuing displacement, not a stack of
      // duplicate zones. A later revisit at the same price remains separate
      // because its candle windows no longer touch.
      continuation.low = Math.min(continuation.low, low)
      continuation.high = Math.max(continuation.high, high)
      continuation.firstIndex = Math.min(continuation.firstIndex, baseIndex)
      continuation.lastIndex = Math.max(continuation.lastIndex, confirmationIndex)
      continuation.lastTime = candles[continuation.lastIndex]?.time ?? continuation.lastTime
      continuation.baseIndexes = [...new Set([...continuation.baseIndexes, baseIndex])].sort((a, b) => a - b)
      continuation.touches = candles
        .slice(continuation.lastIndex + 1)
        .filter((candle) => candle.low <= continuation.high && candle.high >= continuation.low)
        .length
      continue
    }

    const later = candles.slice(confirmationIndex + 1)
    zones.push({
      type,
      low,
      high,
      touches: later.filter((candle) => candle.low <= high && candle.high >= low).length,
      swept: false,
      imbalance: true,
      firstIndex: gap.firstIndex,
      lastIndex: confirmationIndex,
      lastTime: candles[confirmationIndex]?.time ?? displacement.time,
      baseIndexes: [baseIndex],
      definingIndexes: gap.definingIndexes,
      fvg: {
        direction: gap.direction,
        low: gap.low,
        high: gap.high,
        index: displacementIndex,
        firstIndex: gap.firstIndex,
        confirmationIndex,
        filled: gap.filled,
      },
    })
  }

  return zones.sort((a, b) => a.low - b.low || a.lastIndex - b.lastIndex)
}

const overlaps = (a, b) => a.low <= b.high && b.low <= a.high

/**
 * Legacy clustered swing zones used only by the reproducible BTC v0 strategy.
 * PA-1 deliberately uses `buildFvgSupplyDemandZones` instead.
 */
export const buildZones = (candles, { lookback = 2, tolerance, maxAgeCandles = 400 } = {}) => {
  const swings = findSwings(candles, lookback)
  const atrSeries = atr(candles, 14)
  const reference = lastDefined(atrSeries) ?? (candles.at(-1)?.close ?? 0) * 0.005
  const band = tolerance ?? reference * 0.75
  const oldestIndex = Math.max(0, candles.length - maxAgeCandles)
  const gaps = fairValueGaps(candles, { atrValue: reference, minSizeAtr: 0.1 })

  const previousSameKind = new Map()
  let lastLow = null
  let lastHigh = null
  for (const swing of swings) {
    previousSameKind.set(swing, swing.kind === 'low' ? lastLow : lastHigh)
    if (swing.kind === 'low') lastLow = swing
    else lastHigh = swing
  }

  const raw = swings
    .filter((swing) => swing.index >= oldestIndex)
    .map((swing) => {
      const { candle } = swing
      const bodyLow = Math.min(candle.open, candle.close)
      const bodyHigh = Math.max(candle.open, candle.close)
      const swept = sweptPreviousSwing(swing, previousSameKind.get(swing))
      const zone = swing.kind === 'low'
        ? { type: 'demand', low: candle.low, high: Math.max(bodyLow, candle.low + band * 0.5), swing }
        : { type: 'supply', low: Math.min(bodyHigh, candle.high - band * 0.5), high: candle.high, swing }
      return {
        ...zone,
        swept,
        imbalance: hasImbalanceNear(gaps, {
          low: zone.low,
          high: zone.high,
          direction: swing.kind === 'low' ? 'bullish' : 'bearish',
        }),
        definingIndexes: [swing.index - 1, swing.index, swing.index + 1].filter(
          (index) => index >= 0 && index < candles.length
        ),
      }
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
      match.swept = match.swept || item.swept
      match.imbalance = match.imbalance || item.imbalance
      continue
    }
    zones.push({
      type: item.type,
      low: item.low,
      high: item.high,
      touches: 1,
      swept: item.swept,
      imbalance: item.imbalance,
      firstIndex: item.swing.index,
      lastIndex: item.swing.index,
      lastTime: item.swing.time,
      definingIndexes: item.definingIndexes,
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

// ── quality filters ─────────────────────────────────────────────────────────
//
// The two below come from the supply-and-demand school this strategy is being
// tuned towards (JeaFx's "market flow": structure, supply/demand, liquidity,
// imbalance). Both answer the same question the original engine never asked —
// not "is there a level here" but "is this level worth trading" — and the
// original's 26% win rate is what not asking it looks like.

/**
 * Did this pivot take the liquidity resting at the PREVIOUS pivot?
 *
 * The rule is "if the previous wick isn't taken out, the market will likely
 * come back to sweep it before moving in your direction". The liquidity in
 * question sits under an earlier swing low (or above an earlier swing high),
 * because that is where stops accumulate — not under the candle that happens to
 * precede this one.
 *
 * Two earlier attempts at this were vacuous, and both failed the same way. A
 * fractal pivot is by construction the strict extreme of its neighbourhood, so
 * "did it exceed the previous candle" is automatically true for every pivot;
 * and on a descending leg it is also automatically below the last several
 * candles. Both versions rejected nothing at all — measured, twice, as a
 * variant table where the filter on and the filter off were identical to the
 * sat.
 *
 * Comparing pivot to PREVIOUS PIVOT is selective: in an uptrend most higher
 * lows do not reach under the prior low, and the ones that do are the stop
 * hunts the doctrine is actually about.
 */
export const sweptPreviousSwing = (swing, previousSameKind) => {
  if (!previousSameKind) return false
  return swing.kind === 'low'
    ? swing.price < previousSameKind.price
    : swing.price > previousSameKind.price
}

/**
 * Three-candle imbalance: the first and third candles' wicks do not overlap, so
 * price moved through the middle without trading both sides. It marks a move
 * driven by one side rather than by two-way auction, and unfilled gaps act as
 * magnets — which is why they serve as targets as well as a quality filter.
 */
export const fairValueGaps = (candles, { minSizeAtr = 0, atrValue } = {}) => {
  const gaps = []
  const floor = atrValue && minSizeAtr ? atrValue * minSizeAtr : 0

  for (let index = 1; index < candles.length - 1; index += 1) {
    const before = candles[index - 1]
    const after = candles[index + 1]

    if (after.low > before.high && after.low - before.high > floor) {
      gaps.push({
        index,
        firstIndex: index - 1,
        confirmationIndex: index + 1,
        definingIndexes: [index - 1, index, index + 1],
        direction: 'bullish',
        low: before.high,
        high: after.low,
      })
    } else if (before.low > after.high && before.low - after.high > floor) {
      gaps.push({
        index,
        firstIndex: index - 1,
        confirmationIndex: index + 1,
        definingIndexes: [index - 1, index, index + 1],
        direction: 'bearish',
        low: after.high,
        high: before.low,
      })
    }
  }

  // A gap price has already traded back through is spent — it is neither a
  // quality signal nor a target any more.
  return gaps.filter((gap) => {
    const later = candles.slice(gap.index + 2)
    const filled = later.some((candle) => candle.low <= gap.low && candle.high >= gap.high)
    gap.filled = filled
    return true
  })
}

/** Is there an unfilled imbalance overlapping this price band? */
export const hasImbalanceNear = (gaps, { low, high, direction }) =>
  gaps.some(
    (gap) => !gap.filled && gap.direction === direction && gap.low <= high && gap.high >= low
  )
