import { aggregate, HOUR_MS } from './candles.mjs'
import { ceilPrice, floorPrice, normalizeCandlePrices, roundPrice } from './price.mjs'
import { buildExternalTrendReference } from './external-trends.mjs'
import { buildFvgSupplyDemandZones, candleSignal, marketStructure } from './priceaction.mjs'

export const PRICE_ACTION_STRUCTURE_ID = 'price-action-structure-v1'
export const PRICE_ACTION_MATRIX_SCHEMA = 48
export const PRICE_ACTION_CHART_CANDLE_LIMITS = {
  '1h': 8760,
  '4h': 2190,
  '1d': 400,
}

export const DEFAULT_PRICE_ACTION_STRUCTURE = {
  zoneLookback: 2,
  minCandles: 40,
  refreshMinutes: 15,
  zoneMaxAgeCandles: 400,
  pullbackPct: 50,
  minRewardRisk: 2,
  riskPct: 1,
  // PA starts as true spot trading. A user can explicitly opt into a higher
  // leverage from the dashboard without changing the structural stop.
  leverage: 1,
  stopBufferPct: 0.02,
}

// Main structure and execution zones deliberately use different resolutions.
// Structure needs the external swings visible on the chart; zones still need
// the smaller reactions from which an entry can actually be refined.
export const PRICE_ACTION_STRUCTURE_PROFILES = {
  // The 1H chart is an execution lens, not another multi-month macro view.
  // Keep enough context for the currently active 4H leg (about a month), while
  // the small pivot radius still makes the 1H line responsive. A 14-day cut
  // can otherwise remove the active 4H HH/LH before the 1H rebound finishes.
  '1h': { historyDays: 30, zoneHistoryDays: 120, pivotLookback: 18, minCandles: 300, zoneMaxAgeCandles: 2880 },
  '4h': { historyDays: 180, zoneHistoryDays: 365, pivotLookback: 96, minCandles: 250, zoneMaxAgeCandles: 2190 },
  '1d': { historyDays: 400, zoneHistoryDays: 730, pivotLookback: 30, minCandles: 160, zoneMaxAgeCandles: 730 },
}

// The live BTC series is hourly. Reserve two full days above the largest
// structure window so discarding a forming candle or an incomplete UTC bucket
// cannot silently reduce the 1D analysis below its 400 completed candles.
export const MIN_PRICE_ACTION_HOURLY_CANDLES =
  (Math.max(...Object.values(PRICE_ACTION_STRUCTURE_PROFILES).map((profile) => profile.historyDays)) + 2) * 24

export const PRICE_ACTION_ASSETS = [
  { symbol: 'BTCUSD', name: 'Bitcoin / US Dollar', group: 'crypto', binanceSymbol: 'BTCUSDT', yahooSymbol: 'BTC-USD' },
  { symbol: 'EURUSD', name: 'Euro / US Dollar', group: 'fx', stooqSymbol: 'eurusd', yahooSymbol: 'EURUSD=X', twelveSymbol: 'EUR/USD' },
  { symbol: 'GBPUSD', name: 'British Pound / US Dollar', group: 'fx', stooqSymbol: 'gbpusd', yahooSymbol: 'GBPUSD=X', twelveSymbol: 'GBP/USD' },
  { symbol: 'USDJPY', name: 'US Dollar / Japanese Yen', group: 'fx', stooqSymbol: 'usdjpy', yahooSymbol: 'JPY=X', twelveSymbol: 'USD/JPY' },
  { symbol: 'USDCHF', name: 'US Dollar / Swiss Franc', group: 'fx', stooqSymbol: 'usdchf', yahooSymbol: 'CHF=X', twelveSymbol: 'USD/CHF' },
  { symbol: 'USDCAD', name: 'US Dollar / Canadian Dollar', group: 'fx', stooqSymbol: 'usdcad', yahooSymbol: 'CAD=X', twelveSymbol: 'USD/CAD' },
  { symbol: 'AUDUSD', name: 'Australian Dollar / US Dollar', group: 'fx', stooqSymbol: 'audusd', yahooSymbol: 'AUDUSD=X', twelveSymbol: 'AUD/USD' },
  { symbol: 'NZDUSD', name: 'New Zealand Dollar / US Dollar', group: 'fx', stooqSymbol: 'nzdusd', yahooSymbol: 'NZDUSD=X', twelveSymbol: 'NZD/USD' },
]

export const PRICE_ACTION_TIMEFRAMES = [
  { id: '1h', label: '1H', hours: 1 },
  { id: '4h', label: '4H', hours: 4 },
  { id: '1d', label: '1D', hours: 24 },
]

// Yahoo provides two years of FX hourly OHLC.  Every Forex timeframe is
// derived from that single stream, just as BTC is, so the 1D chart cannot
// disagree with the 1H/4H candles because of a different vendor or session.
const FX_HOURLY_HISTORY_DAYS = 760

export const aggregateHourlyTimeframeCandles = ({ candles, timeframeId }) => {
  const timeframe = PRICE_ACTION_TIMEFRAMES.find((item) => item.id === timeframeId)
  if (!timeframe) throw new Error(`Unknown price-action timeframe: ${timeframeId}`)
  return {
    candles: aggregate(candles, timeframe.hours),
    // Strategy logic remains limited to completed buckets, but charts include
    // the current partial candle so the latest price stays at the right edge.
    chartCandles: aggregate(candles, timeframe.hours, { includePartial: true }),
  }
}

// The FX key may be added while an otherwise fresh matrix is already stored.
// Do not preserve a cached "key missing" result for the remainder of that
// hour: it would hide newly available Twelve Data pivots until the next bucket.
export const canReuseExternalTrendReference = ({ previous, hourBucket, apiKey }) => {
  if (previous?.hourBucket !== hourBucket) return false
  if (!apiKey) return true
  return !previous.failures?.some((failure) => {
    const message = String(failure)
    return message.includes('TWELVE_DATA_API_KEY není nastaven') || message.includes('Twelve Data HTTP 429')
  })
}

const LOWER_TIMEFRAME = {
  '1d': '4h',
  '4h': '1h',
  '1h': null,
}

const HIGHER_TIMEFRAME = {
  '1h': '4h',
  '4h': '1d',
  '1d': null,
}

const csvCell = (value) => String(value ?? '').trim()

const numberOrNull = (value) => {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

const formatDate = (date) => {
  const year = date.getUTCFullYear()
  const month = String(date.getUTCMonth() + 1).padStart(2, '0')
  const day = String(date.getUTCDate()).padStart(2, '0')
  return `${year}${month}${day}`
}

const parseStooqCsv = (csv) => {
  const lines = String(csv ?? '').trim().split(/\r?\n/).filter(Boolean)
  if (lines.length < 2) return []
  const headers = lines[0].split(',').map((header) => header.trim().toLowerCase())
  const index = (name) => headers.indexOf(name)
  const dateIndex = index('date')
  const timeIndex = index('time')
  const openIndex = index('open')
  const highIndex = index('high')
  const lowIndex = index('low')
  const closeIndex = index('close')
  const volumeIndex = index('volume')
  if ([dateIndex, openIndex, highIndex, lowIndex, closeIndex].some((item) => item < 0)) return []

  const out = []
  for (const line of lines.slice(1)) {
    const cells = line.split(',').map(csvCell)
    const date = cells[dateIndex]
    const time = timeIndex >= 0 ? cells[timeIndex] : '00:00:00'
    const parsedTime = Date.parse(`${date}T${time || '00:00:00'}Z`)
    const open = numberOrNull(cells[openIndex])
    const high = numberOrNull(cells[highIndex])
    const low = numberOrNull(cells[lowIndex])
    const close = numberOrNull(cells[closeIndex])
    if (!Number.isFinite(parsedTime) || [open, high, low, close].some((value) => value === null || value <= 0)) continue
    out.push({
      time: parsedTime,
      open: roundPrice(open),
      high: roundPrice(high),
      low: roundPrice(low),
      close: roundPrice(close),
      volume: numberOrNull(cells[volumeIndex]) ?? 0,
    })
  }
  return out.sort((a, b) => a.time - b.time)
}

export const fetchStooqCandles = async ({
  symbol,
  interval = '60',
  lookbackDays = 220,
  fetchImpl = globalThis.fetch,
  now = Date.now(),
  timeoutMs = 12000,
}) => {
  const to = new Date(now)
  const from = new Date(now - lookbackDays * 24 * HOUR_MS)
  const url = `https://stooq.com/q/d/l/?s=${encodeURIComponent(symbol)}&d1=${formatDate(from)}&d2=${formatDate(to)}&i=${interval}`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  let response
  try {
    response = await fetchImpl(url, {
      headers: { Accept: 'text/csv,*/*', 'User-Agent': 'btc-dca-bot/1' },
      signal: controller.signal,
    })
  } finally {
    clearTimeout(timer)
  }
  if (!response.ok) throw new Error(`Stooq HTTP ${response.status}`)
  const csv = await response.text()
  if (/exceeded|apikey|required/i.test(csv)) throw new Error('Stooq refused the historical CSV request')
  const candles = parseStooqCsv(csv)
  if (candles.length === 0) throw new Error('Stooq returned no usable candles')
  return candles
}

export const fetchYahooCandles = async ({
  symbol,
  interval = '1h',
  range = '180d',
  fetchImpl = globalThis.fetch,
  timeoutMs = 12000,
}) => {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  let response
  try {
    response = await fetchImpl(url, {
      headers: { Accept: 'application/json', 'User-Agent': 'btc-dca-bot/1' },
      signal: controller.signal,
    })
  } finally {
    clearTimeout(timer)
  }
  if (!response.ok) throw new Error(`Yahoo HTTP ${response.status}`)
  const payload = await response.json()
  const result = payload?.chart?.result?.[0]
  const timestamps = result?.timestamp ?? []
  const quote = result?.indicators?.quote?.[0] ?? {}
  const out = []
  for (let index = 0; index < timestamps.length; index += 1) {
    const open = numberOrNull(quote.open?.[index])
    const high = numberOrNull(quote.high?.[index])
    const low = numberOrNull(quote.low?.[index])
    const close = numberOrNull(quote.close?.[index])
    // Yahoo leaves some FX bars as literal zeroes when a market-data gap is
    // present. They are not candles and would create impossible entries,
    // stops and enormous artificial returns in a backtest.
    if ([open, high, low, close].some((value) => value === null || value <= 0)) continue
    out.push({
      time: Number(timestamps[index]) * 1000,
      open: roundPrice(open),
      high: roundPrice(high),
      low: roundPrice(low),
      close: roundPrice(close),
      volume: numberOrNull(quote.volume?.[index]) ?? 0,
    })
  }
  if (out.length === 0) throw new Error('Yahoo returned no usable candles')
  return out.sort((a, b) => a.time - b.time)
}

const pivotSummary = (swing, label = null) =>
  swing
    ? {
        kind: swing.kind,
        label,
        price: swing.price,
        close: swing.candle?.close ?? null,
        time: swing.time,
        candleIndex: swing.index,
      }
    : null

const structureLeg = ({ previous, current, higherLabel, lowerLabel, breaksByClose }) => {
  if (!previous || !current) return null
  const confirmedBreak = breaksByClose(current, previous)
  const label = confirmedBreak ? higherLabel : lowerLabel
  return {
    previous: pivotSummary(previous),
    current: pivotSummary(current, label),
    label,
    confirmedBreak,
    referencePrice: previous.price,
    confirmationClose: current.candle?.close ?? null,
    changePct: previous.price ? ((current.price / previous.price) - 1) * 100 : null,
  }
}

const closeBreaksHigh = (current, previous) => current.candle?.close > previous.price
const closeBreaksLow = (current, previous) => current.candle?.close < previous.price

// Fractal pivots need candles on their right, which intentionally makes them
// late. A closed break of the latest high/low still needs to reach the chart
// immediately, so expose its live terminal extreme separately from the
// confirmed structure used for trading decisions.
const developingStructureSwing = (candles, structure) => {
  const terminalExtreme = (kind, afterIndex) => candles
    .slice(Math.max(0, afterIndex + 1))
    .reduce((best, candle, offset) => {
      const price = kind === 'low' ? candle.low : candle.high
      if (!best || (kind === 'low' ? price < best.price : price > best.price)) {
        return { kind, price, candle, index: Math.max(0, afterIndex + 1) + offset, time: candle.time }
      }
      return best
    }, null)

  const laterThan = (pivot) => candles.slice(Math.max(0, pivot.index + 1))
  // Keep the live LL/HH after a rebound. Looking at only the newest close
  // made a genuine close break disappear as soon as the next candle retraced.
  if (structure.lastLow && laterThan(structure.lastLow).some((candle) => candle.close < structure.lastLow.price)) {
    const extreme = terminalExtreme('low', structure.lastLow.index)
    return extreme ? {
      ...pivotSummary(extreme, 'LL'),
      confirmed: false,
      replacesCandleIndex: structure.lastLow.index,
      breakTime: laterThan(structure.lastLow).find((candle) => candle.close < structure.lastLow.price)?.time ?? null,
    } : null
  }
  if (structure.lastHigh && laterThan(structure.lastHigh).some((candle) => candle.close > structure.lastHigh.price)) {
    const extreme = terminalExtreme('high', structure.lastHigh.index)
    return extreme ? {
      ...pivotSummary(extreme, 'HH'),
      confirmed: false,
      replacesCandleIndex: structure.lastHigh.index,
      breakTime: laterThan(structure.lastHigh).find((candle) => candle.close > structure.lastHigh.price)?.time ?? null,
    } : null
  }
  return null
}

// After a confirmed LL/HH the last unfinished counter-leg is useful for the
// 1H audit chart. It is deliberately marked LH/HL, never HH/LL: without a
// fresh break it cannot alter the established trend or authorize a trade.
const developingCounterSwing = (candles, { trend, activeRange }) => {
  const anchor = trend === 'down' ? activeRange?.low : trend === 'up' ? activeRange?.high : null
  const protectedCounter = trend === 'down' ? activeRange?.high : trend === 'up' ? activeRange?.low : null
  if (!anchor || !Number.isFinite(anchor.candleIndex)) return null
  const kind = trend === 'down' ? 'high' : 'low'
  const later = candles.slice(anchor.candleIndex + 1)
  const extreme = later.reduce((best, candle, offset) => {
    const price = kind === 'high' ? candle.high : candle.low
    if (!best || (kind === 'high' ? price > best.price : price < best.price)) {
      return { kind, price, candle, index: anchor.candleIndex + offset + 1, time: candle.time }
    }
    return best
  }, null)
  if (!extreme) return null
  const wickOnlyBreak = protectedCounter && (trend === 'down'
    ? extreme.price > protectedCounter.price && extreme.candle.close <= protectedCounter.price
    : extreme.price < protectedCounter.price && extreme.candle.close >= protectedCounter.price)
  if (wickOnlyBreak) return null
  return {
    ...pivotSummary(extreme, trend === 'down' ? 'LH' : 'HL'),
    confirmed: false,
    developing: true,
  }
}

// These labels belong to the structural zigzag itself. The chart must never
// re-derive them from a truncated set of visible pivots: doing so turned a
// continuing downtrend into a flat/up line whenever its first reference high
// scrolled out of the browser's small recent-swing window.
const labelStructureSwings = (swings = []) => {
  const labels = new Map()
  let previousHigh = null
  let previousLow = null
  for (const swing of swings) {
    const previous = swing.kind === 'high' ? previousHigh : previousLow
    const label = !previous
      ? swing.kind === 'high' ? 'H' : 'L'
      : swing.kind === 'high'
        ? closeBreaksHigh(swing, previous) ? 'HH' : 'LH'
        : closeBreaksLow(swing, previous) ? 'LL' : 'HL'
    labels.set(swing.index, label)
    if (swing.kind === 'high') previousHigh = swing
    else previousLow = swing
  }
  return labels
}

// This is the exact pivot sequence consumed by the chart. Keep it in the
// strategy layer, rather than asking the browser to merge legs and ranges.
// The slow structural spine establishes the trend, while activeRange adds its
// responsive terminal HH/LH or HL/LL. Without that bridge an uptrend could be
// correctly classified from the active range but its white audit line stop at
// an older pivot several weeks earlier.
const chartStructurePivots = ({ swings, labels, activeRange, trend, developingSwing, developingCounter }) => {
  const activePivots = [activeRange?.high, activeRange?.low].filter(Boolean)
  const continuation = trend === 'up'
    ? developingSwing?.kind === 'high' ? developingSwing : developingCounter
    : trend === 'down'
      ? developingSwing?.kind === 'low' ? developingSwing : developingCounter
      : developingSwing
  const replaces = continuation?.replacesCandleIndex
  const pivots = [
    ...swings.slice(-8).map((swing) => pivotSummary(swing, labels.get(swing.index))),
    ...activePivots,
    continuation,
  ].filter((pivot) => !(continuation
    && pivot !== continuation
    && pivot.kind === continuation.kind
    && pivot.candleIndex === replaces))

  return pivots
    .filter((pivot) => pivot?.kind && Number.isFinite(pivot.price) && Number.isFinite(pivot.time))
    .sort((left, right) => left.time - right.time)
    .reduce((line, pivot) => {
      const atSamePivot = line.findIndex((previous) => previous.candleIndex === pivot.candleIndex)
      if (atSamePivot >= 0) {
        // activeRange carries the definitive HH/LH/HL/LL label for a pivot
        // that may also exist in the wider spine.
        line[atSamePivot] = { ...line[atSamePivot], ...pivot, label: pivot.label ?? line[atSamePivot].label }
        return line
      }
      const previous = line.at(-1)
      if (!previous || previous.kind !== pivot.kind) {
        line.push(pivot)
        return line
      }
      // A same-kind terminal can only refine the unfinished leg. Preserve the
      // more extreme point, while preferring the explicit live pivot on a tie.
      const moreExtreme = pivot.kind === 'high'
        ? pivot.price >= previous.price
        : pivot.price <= previous.price
      if (moreExtreme) line[line.length - 1] = pivot
      return line
    }, [])
}

// A second, deliberately strict audit path for the dashboard. The API has
// already decided whether the active direction is up or down; this helper
// only answers which of the published pivots still form an alternating wave
// when read from the newest point backwards. Once the next expected label is
// missing, the path stops instead of jumping over an invalidating pivot.
export const alternatingTrendPivots = ({ pivots = [], trend } = {}) => {
  const expectedLabels = trend === 'up' ? new Set(['HH', 'HL']) : trend === 'down' ? new Set(['LL', 'LH']) : new Set()
  const nextLabel = { HH: 'HL', HL: 'HH', LL: 'LH', LH: 'LL' }
  if (expectedLabels.size === 0) return []

  const candidates = pivots.filter((pivot) =>
    pivot && typeof pivot.label === 'string' && Number.isFinite(pivot.price) && Number.isFinite(pivot.time)
  )
  const reversePath = []
  let expected = null
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const pivot = candidates[index]
    if (reversePath.length === 0) {
      // An unlabeled initial H/L or a pivot from the opposite direction is
      // not a usable first point. Once a path has started, however, every
      // labeled pivot is checked and can terminate it.
      if (!expectedLabels.has(pivot.label)) continue
      reversePath.push(pivot)
      expected = nextLabel[pivot.label]
      continue
    }
    if (pivot.label !== expected) break
    reversePath.push(pivot)
    expected = nextLabel[pivot.label]
  }
  return reversePath.reverse()
}

// The wide timeframe profile supplies the multi-month structural spine used
// for every HH, HL, LH, LL and trading decision. Its confirmation delay is
// intentional: it prevents a short internal reaction such as USDJPY 159.8 ->
// 158 from replacing the preceding major high. Read a narrower live edge only
// to draw the still-unconfirmed terminal high/low at the right of the chart.
const activeStructureLookback = (lookback) => lookback > 4
  ? Math.max(2, Math.ceil(lookback / 4))
  : lookback

const persistentStructureTrend = (candles, swings, lookback) => {
  const labels = labelStructureSwings(swings)
  const confirmations = new Map()
  for (const swing of swings) {
    const confirmedAt = swing.index + lookback
    confirmations.set(confirmedAt, [...(confirmations.get(confirmedAt) ?? []), swing])
  }

  const highs = []
  const lows = []
  let trend = 'flat'
  let establishedTrend = 'flat'
  let pendingDirection = null
  let pendingFromBreak = false
  let pendingBreakIndex = null
  let protectedHigh = null
  let protectedLow = null
  let latestEvent = null

  for (let index = 0; index < candles.length; index += 1) {
    const confirmedNow = confirmations.get(index) ?? []
    for (const swing of confirmedNow) {
      if (swing.kind === 'high') highs.push(swing)
      else lows.push(swing)
    }

    const lastHigh = highs.at(-1)
    const previousHigh = highs.at(-2)
    const lastLow = lows.at(-1)
    const previousLow = lows.at(-2)
    const current = candles[index]
    const previous = candles[index - 1]
    const highLabel = lastHigh ? labels.get(lastHigh.index) : null
    const lowLabel = lastLow ? labels.get(lastLow.index) : null

    if (trend === 'flat' && lastHigh && previousHigh && lastLow && previousLow) {
      const upSequence = highLabel === 'HH' && lowLabel === 'HL'
      const downSequence = highLabel === 'LH' && lowLabel === 'LL'
      const advancedSinceBreak = !pendingFromBreak || [lastHigh, lastLow]
        .some((swing) => swing?.index > (pendingBreakIndex ?? Number.POSITIVE_INFINITY))
      // A genuine close through the protected level commits the pending
      // reversal: only its opposite HH+HL/LH+LL sequence can confirm it. A
      // failed counter-pivot without such a break may instead return to the
      // previously established direction when that original sequence resumes.
      const nextTrend = pendingDirection === 'down' && downSequence
        ? 'down'
        : pendingDirection === 'up' && upSequence
          ? 'up'
          : !pendingFromBreak && establishedTrend === 'up' && upSequence
            ? 'up'
          : !pendingFromBreak && establishedTrend === 'down' && downSequence
              ? 'down'
              : pendingFromBreak && advancedSinceBreak && upSequence
                ? 'up'
                : pendingFromBreak && advancedSinceBreak && downSequence
                  ? 'down'
              : !pendingDirection && upSequence
                ? 'up'
                : !pendingDirection && downSequence
                  ? 'down'
                  : null
      if (nextTrend) {
        trend = nextTrend
        establishedTrend = trend
        pendingDirection = null
        pendingFromBreak = false
        pendingBreakIndex = null
        protectedHigh = trend === 'down' ? lastHigh : null
        protectedLow = trend === 'up' ? lastLow : null
      }
    }

    // A completed counter-pivot is a genuine loss of directional flow, but a
    // fresh, still-unconfirmed bounce is not. This makes a downtrend remain
    // down while price merely rebounds from a newly printed LL, then moves to
    // flat only when that rebound has earned enough right-hand candles to be
    // a real HL. The mirrored rule applies to a completed LH in an uptrend.
    const confirmedCounterPivot = trend === 'up'
      ? confirmedNow.some((swing) => swing.kind === 'high' && labels.get(swing.index) === 'LH')
      : trend === 'down'
        ? confirmedNow.some((swing) => swing.kind === 'low' && labels.get(swing.index) === 'HL')
        : false
    if (confirmedCounterPivot) {
      pendingDirection = trend === 'up' ? 'down' : 'up'
      pendingFromBreak = false
      pendingBreakIndex = null
      trend = 'flat'
    }

    // The protected counter-swing is the only level that can invalidate an
    // established direction. Newer internal pivots may be useful for a later
    // entry refinement, but they must not relabel the whole market structure.
    if (trend === 'up' && lowLabel === 'HL') protectedLow = lastLow
    if (trend === 'down' && highLabel === 'LH') protectedHigh = lastHigh

    const crossedAbove = lastHigh && current.close > lastHigh.price && previous?.close <= lastHigh.price
    const crossedBelow = lastLow && current.close < lastLow.price && previous?.close >= lastLow.price
    const invalidatedUp = protectedLow && current.close < protectedLow.price && previous?.close >= protectedLow.price
    const invalidatedDown = protectedHigh && current.close > protectedHigh.price && previous?.close <= protectedHigh.price
    // A market which has not completed HH+HL or LH+LL is still a range, but a
    // close outside both recent structural boundaries is meaningful. Publish
    // its directional bias immediately for the audit chart; do not confirm a
    // trade until a subsequent directional pivot pair exists.
    const flatRangeHigh = lastHigh && lastLow ? Math.max(lastHigh.price, lastLow.price) : null
    const flatRangeLow = lastHigh && lastLow ? Math.min(lastHigh.price, lastLow.price) : null
    // Do not require an earlier confirmed trend here. A mature sideways range
    // can break directly into a new directional leg; two confirmed highs and
    // two confirmed lows prevent the first ordinary pullback of new history
    // from being mistaken for such a breakout.
    const hasCompleteFlatRange = highs.length >= 2 && lows.length >= 2
    const brokeFlatRangeUp = trend === 'flat' && hasCompleteFlatRange
      && (!pendingDirection || pendingDirection === 'up') && flatRangeHigh
      && current.close > flatRangeHigh && previous?.close <= flatRangeHigh
    const brokeFlatRangeDown = trend === 'flat' && hasCompleteFlatRange
      && (!pendingDirection || pendingDirection === 'down') && flatRangeLow
      && current.close < flatRangeLow && previous?.close >= flatRangeLow
    if (brokeFlatRangeDown) {
      latestEvent = {
        type: pendingDirection === 'down' ? 'CHoCH_DOWN' : 'RANGE_BREAK_DOWN', direction: 'down', fromTrend: establishedTrend, index, time: current.time,
        close: current.close, referencePrice: flatRangeLow, referenceTime: lastLow.time,
      }
      trend = 'down'
      pendingDirection = 'down'
      pendingFromBreak = true
      pendingBreakIndex = index
    } else if (brokeFlatRangeUp) {
      latestEvent = {
        type: pendingDirection === 'up' ? 'CHoCH_UP' : 'RANGE_BREAK_UP', direction: 'up', fromTrend: establishedTrend, index, time: current.time,
        close: current.close, referencePrice: flatRangeHigh, referenceTime: lastHigh.time,
      }
      trend = 'up'
      pendingDirection = 'up'
      pendingFromBreak = true
      pendingBreakIndex = index
    } else if (trend === 'up' && invalidatedUp) {
      latestEvent = {
        type: 'CHoCH_DOWN',
        direction: 'down',
        fromTrend: 'up',
        index,
        time: current.time,
        close: current.close,
        referencePrice: protectedLow.price,
        referenceTime: protectedLow.time,
      }
      trend = 'flat'
      pendingDirection = 'down'
      pendingFromBreak = true
      pendingBreakIndex = index
    } else if (trend === 'down' && invalidatedDown) {
      latestEvent = {
        type: 'CHoCH_UP',
        direction: 'up',
        fromTrend: 'down',
        index,
        time: current.time,
        close: current.close,
        referencePrice: protectedHigh.price,
        referenceTime: protectedHigh.time,
      }
      trend = 'flat'
      pendingDirection = 'up'
      pendingFromBreak = true
      pendingBreakIndex = index
    } else if (trend === 'up' && crossedAbove) {
      latestEvent = {
        type: 'BOS_UP', direction: 'up', fromTrend: 'up', index, time: current.time,
        close: current.close, referencePrice: lastHigh.price, referenceTime: lastHigh.time,
      }
    } else if (trend === 'down' && crossedBelow) {
      latestEvent = {
        type: 'BOS_DOWN', direction: 'down', fromTrend: 'down', index, time: current.time,
        close: current.close, referencePrice: lastLow.price, referenceTime: lastLow.time,
      }
    }
  }

  const recentCutoff = candles.length - 1 - lookback
  return {
    trend,
    establishedTrend,
    event: latestEvent?.index >= recentCutoff ? latestEvent : null,
    protectedHigh,
    protectedLow,
    labels,
    pendingDirection,
    pendingFromBreak,
  }
}

const laterCandles = (candles, zone) => candles.slice((zone.lastIndex ?? zone.firstIndex ?? 0) + 1)

const zoneHitByCandle = (zone, candle) =>
  Boolean(zone && candle && candle.low <= zone.high && candle.high >= zone.low)

const zoneTouchCandles = (zone, candles) =>
  laterCandles(candles, zone).filter((candle) => zoneHitByCandle(zone, candle))

const zoneInvalidated = (zone, candles) => {
  const later = laterCandles(candles, zone)
  return zone.type === 'demand'
    ? later.some((candle) => candle.close < zone.low)
    : later.some((candle) => candle.close > zone.high)
}

const zoneFilledByOwnTimeframeClose = (zone, candles) => {
  const later = laterCandles(candles, zone)
  return zone.type === 'demand'
    ? later.some((candle) => candle.close <= zone.low)
    : later.some((candle) => candle.close >= zone.high)
}

const zoneFilledAtOwnTimeframeClose = (zone, candles) => {
  const later = laterCandles(candles, zone)
  return (zone.type === 'demand'
    ? later.find((candle) => candle.close <= zone.low)
    : later.find((candle) => candle.close >= zone.high))?.time ?? null
}

const zoneDistancePct = (zone, price) => {
  if (!Number.isFinite(price) || !(price > 0)) return null
  if (price >= zone.low && price <= zone.high) return 0
  const edge = price < zone.low ? zone.low : zone.high
  return ((price / edge) - 1) * 100
}

const candleSummary = (candle) =>
  candle
    ? {
        time: candle.time,
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
      }
    : null

const definingCandleSummary = (index, candles) => {
  const summary = candleSummary(candles[index])
  return summary ? { index, ...summary } : null
}

const zoneSummary = (zone, candles, price) => {
  const touchCandles = zoneTouchCandles(zone, candles)
  return {
    type: zone.type,
    low: zone.low,
    high: zone.high,
    // A touch means any overlap with the FVG range on this timeframe. It does
    // not require a close through, or a fill of, the entire gap.
    touches: touchCandles.length,
    firstTouchAt: touchCandles[0]?.time ?? null,
    lastTouchAt: touchCandles.at(-1)?.time ?? null,
    swept: zone.swept,
    imbalance: zone.imbalance,
    baseCandles: (zone.baseIndexes ?? [])
      .map((index) => definingCandleSummary(index, candles))
      .filter(Boolean),
    fvg: zone.fvg ? {
      ...zone.fvg,
      definingCandles: (zone.definingIndexes ?? [])
        .map((index) => definingCandleSummary(index, candles))
        .filter(Boolean),
    } : null,
    firstTime: candles[zone.firstIndex]?.time ?? null,
    lastTime: zone.lastTime ?? candles[zone.lastIndex]?.time ?? null,
    firstIndex: zone.firstIndex,
    lastIndex: zone.lastIndex,
    definingCandles: (zone.definingIndexes ?? [])
      .map((index) => definingCandleSummary(index, candles))
      .filter(Boolean),
    filledByOwnTimeframeClose: zoneFilledByOwnTimeframeClose(zone, candles),
    filledAt: zoneFilledAtOwnTimeframeClose(zone, candles),
    invalidatedByOwnTimeframeClose: zoneInvalidated(zone, candles),
    distancePct: zoneDistancePct(zone, price),
  }
}

export const activeSupplyDemandZones = (candles, { lookback = 2, maxAgeCandles = 400 } = {}) => {
  const price = candles.at(-1)?.close ?? null
  const zones = buildFvgSupplyDemandZones(candles, { lookback, maxAgeCandles })
    .map((zone) => zoneSummary(zone, candles, price))
    .filter((zone) => !zone.invalidatedByOwnTimeframeClose)

  const unfilled = zones.filter((zone) => !zone.filledByOwnTimeframeClose)
  const latest = (type, pool = unfilled) =>
    pool.filter((zone) => zone.type === type).sort((a, b) => (b.lastIndex ?? 0) - (a.lastIndex ?? 0))[0] ?? null
  const byType = (type, pool = unfilled) =>
    pool.filter((zone) => zone.type === type).sort((a, b) => (b.lastIndex ?? 0) - (a.lastIndex ?? 0))
  const nearby = (type) =>
    byType(type, zones).sort((a, b) => Math.abs(a.distancePct ?? Infinity) - Math.abs(b.distancePct ?? Infinity))

  return {
    demand: latest('demand'),
    supply: latest('supply'),
    latestValidDemand: latest('demand', zones),
    latestValidSupply: latest('supply', zones),
    unfilledDemand: byType('demand'),
    unfilledSupply: byType('supply'),
    nearbyDemand: nearby('demand'),
    nearbySupply: nearby('supply'),
    unfilledCount: unfilled.length,
    validCount: zones.length,
    rule: 'Zóna vzniká jen jako base impulsního breakoutu s 3svíčkovým FVG. Close průraz ji vyplní na vlastním timeframe; vstupní plán ji spotřebuje už prvním dotekem, pokud tehdy není kompletní setup. Dotek na nižším timeframe ji neruší.',
  }
}

const statusFromGate = (passed, neutral = false) => (neutral ? 'neutral' : passed ? 'met' : 'unmet')

const gate = (id, label, passed, detail = null, neutral = false) => ({
  id,
  label,
  status: statusFromGate(passed, neutral),
  passed: neutral ? null : Boolean(passed),
  detail,
})

const sideFromTrend = (trend) => {
  if (trend === 'up') return 'long'
  if (trend === 'down') return 'short'
  return null
}

// TP2 realizes only beyond TP1. A closer opposing zone may still be useful
// context, but cannot replace the second half of the planned exit.
const nearestOpposingZone = ({ side, zones, entry, tp1 = null }) => {
  if (side !== 'long' && side !== 'short') return null
  const pool = side === 'long' ? zones?.unfilledSupply ?? [] : zones?.unfilledDemand ?? []
  const targetBoundary = Number.isFinite(tp1)
    ? side === 'long' ? Math.max(entry, tp1) : Math.min(entry, tp1)
    : entry
  const candidates =
    side === 'long'
      ? pool.filter((zone) => zone.low > targetBoundary).sort((a, b) => a.low - b.low)
      : pool.filter((zone) => zone.high < targetBoundary).sort((a, b) => b.high - a.high)
  // TP2 has to be an untouched opposing FVG beyond TP1. A zone already hit
  // on this timeframe has been consumed; it must not remain a projected exit.
  return candidates.find((zone) => !Number.isFinite(zone.firstTouchAt)) ?? null
}

// A second target is meaningful only if it realizes beyond the structural
// target. Round before comparing so the value persisted for the dashboard
// cannot collapse back onto TP1 at the instrument's display precision.
const validSecondTarget = ({ side, tp1, tp2 }) => {
  if (!Number.isFinite(tp1) || !Number.isFinite(tp2)) return null
  const target = roundPrice(tp2)
  if (side === 'long' && target > tp1) return target
  if (side === 'short' && target < tp1) return target
  return null
}

const structuralTarget = ({ side, structure }) =>
  side === 'long'
    ? roundPrice(structure?.activeRange?.high?.price ?? structure?.high?.current?.price ?? null)
    : side === 'short'
      ? roundPrice(structure?.activeRange?.low?.price ?? structure?.low?.current?.price ?? null)
      : null

const pullbackLevel = ({ side, structure, pullbackPct }) => {
  if (side !== 'long' && side !== 'short') return null
  const high = structure?.activeRange?.high?.price ?? structure?.high?.current?.price
  const low = structure?.activeRange?.low?.price ?? structure?.low?.current?.price
  if (!Number.isFinite(high) || !Number.isFinite(low) || high <= low) return null
  const ratio = Math.min(Math.max(Number(pullbackPct) || 50, 0), 100) / 100
  return roundPrice(side === 'long'
    ? high - (high - low) * ratio
    : low + (high - low) * ratio)
}

// An uptrend is invalidated below its last HL; a downtrend above its last LH.
// Those are the same confirmed structural pivots used by the trend classifier.
const structureInvalidationLevel = ({ side, structure }) =>
  side === 'long'
    ? roundPrice(structure?.activeRange?.low?.price ?? structure?.low?.current?.price ?? null)
    : side === 'short'
      ? roundPrice(structure?.activeRange?.high?.price ?? structure?.high?.current?.price ?? null)
      : null

const candidateZones = (zones, side) => {
  const type = side === 'long' ? 'demand' : side === 'short' ? 'supply' : null
  if (!type) return []
  const key = type === 'demand' ? 'nearbyDemand' : 'nearbySupply'
  const fallbackKey = type === 'demand' ? 'unfilledDemand' : 'unfilledSupply'
  const latestKey = type === 'demand' ? 'latestValidDemand' : 'latestValidSupply'
  const seen = new Set()
  return [
    ...(zones?.[key] ?? []),
    ...(zones?.[fallbackKey] ?? []),
    ...(zones?.[type] ? [zones[type]] : []),
    ...(zones?.[latestKey] ? [zones[latestKey]] : []),
  ]
    .filter((zone) => zone && !zone.filledByOwnTimeframeClose && !zone.invalidatedByOwnTimeframeClose)
    .filter((zone) => {
      const identity = `${zone.low}:${zone.high}:${zone.firstTime ?? zone.firstIndex ?? ''}`
      if (seen.has(identity)) return false
      seen.add(identity)
      return true
    })
}

const rewardRiskFor = ({ side, entry, stop, target }) => {
  if (!Number.isFinite(entry) || !Number.isFinite(stop) || !Number.isFinite(target)) return null
  const risk = side === 'long' ? entry - stop : stop - entry
  const reward = side === 'long' ? target - entry : entry - target
  return risk > 0 && reward > 0 ? reward / risk : null
}

const lowerTimeframeZoneRefinement = ({ side, zone, lowerItem, entryLow, entryHigh }) => {
  if (!lowerItem?.zones || !Number.isFinite(entryLow) || !Number.isFinite(entryHigh)) return null
  const type = side === 'long' ? 'demand' : side === 'short' ? 'supply' : null
  if (!type) return null

  const refinements = candidateZones(lowerItem.zones, side)
    .filter((lowerZone) => lowerZone.type === type)
    .filter((lowerZone) => lowerZone.low >= zone.low && lowerZone.high <= zone.high)
    .map((lowerZone) => ({
      zone: lowerZone,
      entry: roundPrice(side === 'long' ? lowerZone.high : lowerZone.low),
    }))
    .filter(({ entry }) => entry >= entryLow && entry <= entryHigh)
    .sort((left, right) => (right.zone.lastIndex ?? 0) - (left.zone.lastIndex ?? 0))

  return refinements[0] ?? null
}

const zoneEntryCandidate = ({ item, side, zone, pullback, invalidationLevel, settings, lowerItem, lowerTimeframeId }) => {
  const normalizedZone = {
    ...zone,
    low: roundPrice(zone.low),
    high: roundPrice(zone.high),
  }
  const directionEligible = sideFromTrend(item?.trend) === side
  const rangeLow = Number.isFinite(pullback) && Number.isFinite(invalidationLevel)
    ? Math.min(pullback, invalidationLevel)
    : null
  const rangeHigh = Number.isFinite(pullback) && Number.isFinite(invalidationLevel)
    ? Math.max(pullback, invalidationLevel)
    : null
  const entryLow = Number.isFinite(rangeLow) ? roundPrice(Math.max(normalizedZone.low, rangeLow)) : null
  const entryHigh = Number.isFinite(rangeHigh) ? roundPrice(Math.min(normalizedZone.high, rangeHigh)) : null
  const pullbackEligible = Number.isFinite(entryLow) && Number.isFinite(entryHigh) && entryLow <= entryHigh
  const zoneEdgeEntry = side === 'long' ? normalizedZone.high : normalizedZone.low
  // When the zone overlaps the structural pullback only partially, the first
  // tradable hit is the edge of that overlap, not a price beyond the pullback.
  const entryAtZoneHit = pullbackEligible
    ? side === 'long' ? entryHigh : entryLow
    : zoneEdgeEntry
  const buffer = roundPrice(stopBuffer({ zone: normalizedZone, price: entryAtZoneHit, stopBufferPct: settings.stopBufferPct }))
  // A valid demand/supply idea fails when either its zone or its external
  // structure fails. Place the stop beyond the farther of those two anchors,
  // rather than letting a swing stop sit inside the source zone (or vice versa).
  const stopAnchor = Number.isFinite(invalidationLevel)
    ? side === 'long'
      ? Math.min(normalizedZone.low, invalidationLevel)
      : Math.max(normalizedZone.high, invalidationLevel)
    : side === 'long' ? normalizedZone.low : normalizedZone.high
  const stop = side === 'long'
    ? floorPrice(stopAnchor - buffer)
    : ceilPrice(stopAnchor + buffer)
  const entryAtPullback = pullbackEligible
    ? side === 'long' ? entryHigh : entryLow
    : null
  const lowerRefinement = lowerTimeframeZoneRefinement({
    side,
    zone: normalizedZone,
    lowerItem,
    entryLow,
    entryHigh,
  })
  const refinedEntry = lowerRefinement?.entry ?? entryAtZoneHit
  const tp1 = structuralTarget({ side, structure: item?.structure })
  const candidateTp2Zone = Number.isFinite(refinedEntry)
    ? nearestOpposingZone({ side, zones: item?.zones, entry: refinedEntry, tp1 })
    : null
  const tp2 = validSecondTarget({
    side,
    tp1,
    tp2: side === 'long' ? candidateTp2Zone?.low : candidateTp2Zone?.high,
  })
  const tp2Zone = Number.isFinite(tp2) ? candidateTp2Zone : null
  // A distant opposing FVG is optional. When it does not exist beyond TP1,
  // the setup may still take half at the structural target; the other half is
  // then managed by structure and its protective stop rather than inventing a
  // second target inside the active wave.
  const weightedTarget = Number.isFinite(tp1)
    ? Number.isFinite(tp2) ? roundPrice((tp1 + tp2) / 2) : tp1
    : null
  const minRewardRisk = Number(settings.minRewardRisk) || 2
  const rrAtZoneHit = rewardRiskFor({ side, entry: entryAtZoneHit, stop, target: weightedTarget })
  const rrAtPullback = rewardRiskFor({ side, entry: refinedEntry, stop, target: weightedTarget })
  const threshold = Number.isFinite(stop) && Number.isFinite(weightedTarget)
    ? (side === 'long'
      ? floorPrice((weightedTarget + minRewardRisk * stop) / (minRewardRisk + 1))
      : ceilPrice((weightedTarget + minRewardRisk * stop) / (minRewardRisk + 1)))
    : null
  const entryForMinRR = pullbackEligible && Number.isFinite(refinedEntry) && Number.isFinite(rrAtPullback) && rrAtPullback >= minRewardRisk
    ? refinedEntry
    : Number.isFinite(threshold) && pullbackEligible && threshold >= entryLow && threshold <= entryHigh
      ? threshold
      : null
  const rewardRisk = rewardRiskFor({ side, entry: entryForMinRR, stop, target: weightedTarget })
  const rrEligible = Number.isFinite(rewardRisk) && rewardRisk >= minRewardRisk
  const zoneHit = zoneHitByCandle(normalizedZone, item?.lastCandle)
  const reasons = []
  if (!directionEligible) reasons.push('opačný směr oproti aktuální struktuře')
  if (!pullbackEligible) reasons.push('mimo 50% pullback pásmo nebo za hranicí invalidace')
  if (!rrEligible) {
    reasons.push(
      Number.isFinite(rrAtPullback)
        ? `R/R ${rrAtPullback.toFixed(2)}:1; v zóně nelze dosáhnout ${minRewardRisk}:1`
        : 'R/R nelze spočítat z dostupných TP'
    )
  }
  if (pullbackEligible && rrEligible) reasons.push(zoneHit ? 'cena už zónu hitla' : 'čeká na hit zóny')
  const entrySource = Number.isFinite(entryForMinRR)
    ? lowerRefinement
      ? entryForMinRR === refinedEntry ? 'lower-timeframe-zone' : 'min-rr'
      : entryForMinRR === entryAtZoneHit ? 'zone-edge' : 'min-rr'
    : null
  return {
    type: zone.type,
    side,
    zone: normalizedZone,
    directionEligible,
    pullbackEligible,
    rrEligible,
    eligible: directionEligible && pullbackEligible && rrEligible,
    zoneHit,
    zoneEdgeEntry,
    entryAtZoneHit,
    entryRange: pullbackEligible ? { low: entryLow, high: entryHigh } : null,
    lowerTimeframeId: lowerRefinement ? lowerTimeframeId : null,
    lowerTimeframeZone: lowerRefinement?.zone ?? null,
    refinedEntry: lowerRefinement?.entry ?? null,
    entryForMinRR,
    entrySource,
    invalidationLevel,
    stopAnchor,
    stopBuffer: buffer,
    stop,
    tp1,
    tp2,
    tp2Zone,
    weightedTarget,
    rrAtZoneHit,
    rewardRisk,
    minRewardRisk,
    reason: reasons.join(' · '),
  }
}

// A wick that crossed the 50% line is evidence that the retracement happened,
// but it is not evidence that price is *currently* in the entry band. Keeping
// those separate prevents a recovered price from being painted green in the
// dashboard after it has already left the valid pullback range.
const pullbackSatisfied = ({ side, latest, level, invalidationLevel }) => {
  if (!latest || !Number.isFinite(level) || !Number.isFinite(invalidationLevel)) return false
  const current = latest.close
  if (!Number.isFinite(current)) return false
  const lower = Math.min(level, invalidationLevel)
  const upper = Math.max(level, invalidationLevel)
  return current >= lower && current <= upper
}

const stopBuffer = ({ zone, price, stopBufferPct }) => {
  const zoneHeight = zone ? Math.max(0, zone.high - zone.low) : 0
  const priceBuffer = Number.isFinite(price) ? Math.abs(price) * ((Number(stopBufferPct) || 0.02) / 100) : 0
  return Math.max(priceBuffer, zoneHeight * 0.05)
}

const candleRefinement = ({ side, signal }) => {
  signal ??= { bullish: null, bearish: null, patterns: [] }
  const pattern = side === 'long' ? signal.bullish : signal.bearish
  const counterPattern = side === 'long' ? signal.bearish : signal.bullish
  return {
    status: pattern ? 'met' : counterPattern ? 'unmet' : 'neutral',
    pattern: pattern ?? counterPattern ?? null,
    note: pattern
      ? 'nižší vstup lze zpřesnit podle aktuální potvrzující svíčky'
      : counterPattern
        ? 'poslední svíčka je proti zamýšlenému směru'
        : 'bez jasné svíčkové konfirmace na tomto timeframe',
  }
}

export const evaluateTradeProfile = ({
  item,
  lowerItem = null,
  lowerTimeframeId = null,
  higherItem = null,
  higherTimeframeId = null,
  settings = DEFAULT_PRICE_ACTION_STRUCTURE,
} = {}) => {
  const side = sideFromTrend(item?.trend)
  const latest = item?.lastCandle
  const zones = item?.zones
  const activeRange = item?.structure?.activeRange
  const hasCompletedDirectionalRange = side === 'long'
    ? activeRange?.high?.label === 'HH' && activeRange?.low?.label === 'HL'
    : side === 'short'
      ? activeRange?.high?.label === 'LH' && activeRange?.low?.label === 'LL'
      : false
  // A 1H profile may inherit an already completed directional 4H leg and arm
  // its pullback FVG. A locally fresh CHoCH still waits for its own confirmed
  // structure so that a single break never becomes an executable setup.
  const hasInheritedCompletedDirectionalRange =
    activeRange?.source === '4h-active-spine' && hasCompletedDirectionalRange
  const awaitingConfirmation = item?.structureConfirmed === false && !hasInheritedCompletedDirectionalRange

  // Flat is a structure-building state, never an entry state. In particular,
  // do not fall back to the current close here: that would look like a valid
  // planned entry in the dashboard even though no directional setup exists.
  if (!side) {
    const reason = item?.reason || 'flat struktura; čeká se na potvrzení HH + HL nebo LH + LL'
    const riskPct = Number(settings.riskPct) || 1
    const minRewardRisk = Number(settings.minRewardRisk) || 2
    return {
      status: 'neutral',
      mode: 'formation',
      formationState: 'forming',
      reason,
      side: null,
      riskPct,
      minRewardRisk,
      pullbackPct: settings.pullbackPct ?? 50,
      zone: null,
      zoneHit: false,
      entry: null,
      pullbackLevel: null,
      invalidationLevel: null,
      pullbackRange: null,
      zoneCandidates: [],
      activeCandidate: null,
      stop: null,
      stopBuffer: null,
      entryAtZoneHit: null,
      refinedEntry: null,
      entryForMinRR: null,
      entrySource: null,
      entryRefinement: null,
      tp1: null,
      tp1Rule: null,
      tp2: null,
      tp2Zone: null,
      tp2Rule: null,
      weightedTarget: null,
      risk: null,
      reward: null,
      rewardRisk: null,
      gates: [
        gate('trend', 'struktura má směr', false, reason, true),
      ],
      refinement: null,
    }
  }

  const zone = side === 'long' ? zones?.demand : side === 'short' ? zones?.supply : null
  const pullback = pullbackLevel({ side, structure: item?.structure, pullbackPct: settings.pullbackPct })
  const invalidationLevel = structureInvalidationLevel({ side, structure: item?.structure })
  const pullbackRange = Number.isFinite(pullback) && Number.isFinite(invalidationLevel)
    ? { from: pullback, to: invalidationLevel }
    : null
  const rawZoneCandidates = ['long', 'short'].flatMap((candidateSide) =>
    candidateZones(zones, candidateSide).map((zone) => zoneEntryCandidate({
      item,
      side: candidateSide,
      zone,
      pullback,
      invalidationLevel,
      settings,
      lowerItem,
      lowerTimeframeId,
    }))
  )
  const signalItem = lowerTimeframeId && lowerItem?.candleSignal ? lowerItem : item
  const requireCandleSignal = settings.requireCandleSignal === true
  const requireHigherTimeframeAlignment = settings.requireHigherTimeframeAlignment === true
  const candidateEntryReady = (candidate) => {
    const refinement = candleRefinement({ side: candidate.side, signal: signalItem?.candleSignal })
    const higherTimeframeAligned = !higherItem || higherItem.trend === (candidate.side === 'long' ? 'up' : 'down')
    return candidate.eligible &&
      (!requireCandleSignal || refinement.status === 'met') &&
      (!requireHigherTimeframeAlignment || !higherItem || higherTimeframeAligned)
  }
  const zoneCandidates = rawZoneCandidates.map((candidate) => {
    const touchedEarlier = Number.isFinite(candidate.zone.lastTouchAt) &&
      (!Number.isFinite(latest?.time) || candidate.zone.lastTouchAt < latest.time)
    // A partial overlap consumes the FVG when it arrives before the complete
    // setup. This only reads candles from the zone's own timeframe; a lower-TF
    // touch therefore cannot invalidate a higher-TF zone.
    const invalidatedByPrematureTouch = touchedEarlier ||
      (candidate.zoneHit && !candidateEntryReady(candidate))
    const reason = invalidatedByPrematureTouch
      ? [candidate.reason, 'zóna byla dotčena před kompletním vstupním setupem'].filter(Boolean).join(' · ')
      : candidate.reason
    return {
      ...candidate,
      baseEligible: candidate.eligible,
      invalidatedByPrematureTouch,
      eligible: candidate.eligible && !invalidatedByPrematureTouch,
      reason,
    }
  })
  const usableCandidates = zoneCandidates.filter((candidate) => !candidate.invalidatedByPrematureTouch)
  const consumedCandidate = zoneCandidates.find((candidate) => candidate.directionEligible && candidate.invalidatedByPrematureTouch) ?? null
  const activeCandidate =
    usableCandidates.find((candidate) => candidate.directionEligible && candidate.eligible) ??
    usableCandidates.find((candidate) => candidate.directionEligible && candidate.pullbackEligible) ??
    usableCandidates.find((candidate) => candidate.directionEligible) ??
    null
  const activeZone = activeCandidate?.zone ?? null
  const zoneHit = zoneHitByCandle(activeZone, latest)
  // A planned entry is meaningful only when the candidate passes the complete
  // direction, pullback and minimum-R/R gates. Keep raw zone-edge values on
  // the candidate for diagnostics, but never publish them as a trade entry.
  const plannedEntry = activeCandidate?.eligible ? activeCandidate.entryForMinRR : null
  const entry = Number.isFinite(plannedEntry) ? plannedEntry : null
  const pulledBack = pullbackSatisfied({ side, latest, level: pullback, invalidationLevel })
  const buffer = activeCandidate?.stopBuffer ?? stopBuffer({
    zone: activeZone,
    price: activeCandidate?.entryAtZoneHit ?? entry,
    stopBufferPct: settings.stopBufferPct,
  })
  const stop = activeCandidate?.stop ?? (
    side === 'long' && activeZone
      ? Math.min(activeZone.low, invalidationLevel ?? activeZone.low) - buffer
      : side === 'short' && activeZone
        ? Math.max(activeZone.high, invalidationLevel ?? activeZone.high) + buffer
        : null
  )
  const tp1 = activeCandidate?.tp1 ?? structuralTarget({ side, structure: item?.structure })
  const candidateTp2Zone = activeCandidate?.tp2Zone ?? (
    Number.isFinite(entry) ? nearestOpposingZone({ side, zones, entry, tp1 }) : null
  )
  const tp2 = validSecondTarget({
    side,
    tp1,
    tp2: activeCandidate?.tp2 ?? (
      side === 'long' && candidateTp2Zone
        ? candidateTp2Zone.low
        : side === 'short' && candidateTp2Zone
          ? candidateTp2Zone.high
          : null
    ),
  })
  const tp2Zone = Number.isFinite(tp2) ? candidateTp2Zone : null
  const weightedTarget = Number.isFinite(tp1)
    ? Number.isFinite(tp2) ? (tp1 + tp2) / 2 : tp1
    : null
  const risk =
    side === 'long' && Number.isFinite(entry) && Number.isFinite(stop)
      ? entry - stop
      : side === 'short' && Number.isFinite(entry) && Number.isFinite(stop)
        ? stop - entry
        : null
  const reward =
    side === 'long' && Number.isFinite(entry) && Number.isFinite(weightedTarget)
      ? weightedTarget - entry
      : side === 'short' && Number.isFinite(entry) && Number.isFinite(weightedTarget)
        ? entry - weightedTarget
        : null
  const rewardRisk = Number.isFinite(risk) && risk > 0 && Number.isFinite(reward) ? reward / risk : null
  const minRewardRisk = Number(settings.minRewardRisk) || 2
  const riskPct = Number(settings.riskPct) || 1
  const refinement = side ? candleRefinement({ side, signal: signalItem?.candleSignal }) : null
  const higherTimeframeAligned = !higherItem || higherItem.trend === item?.trend

  const gates = [
    gate('trend', 'struktura má směr', Boolean(side), item?.reason ?? null),
    ...(awaitingConfirmation
      ? [gate('structure-confirmed', 'nová vlna je potvrzena', false, item?.reason || 'nový strukturální směr čeká na potvrzení')]
      : []),
    gate('zone', 'cena je ve správné S/D zóně', Boolean(activeZone && zoneHit), activeZone ? `${activeZone.type} ${activeZone.low}–${activeZone.high}` : null),
    gate('unfilled-zone', 'zóna není vyplněná ani spotřebovaná', Boolean(activeZone), activeZone ? 'nevyplněná' : consumedCandidate ? 'dotčena před kompletním setupem' : zone ? 'není použitelná pro vstup' : null),
    gate('pullback', `${settings.pullbackPct ?? 50}% pullback`, pulledBack, Number.isFinite(pullback) ? String(pullback) : null),
    gate('rr', `R/R alespoň ${minRewardRisk}:1`, Number.isFinite(rewardRisk) && rewardRisk >= minRewardRisk, Number.isFinite(rewardRisk) ? rewardRisk.toFixed(2) : null),
    gate('candle', 'potvrzení svíčkou', refinement?.status === 'met', refinement?.note ?? null, !requireCandleSignal),
    gate(
      'higher-trend',
      `vyšší timeframe ${higherTimeframeId ?? 'kontext'} je ve stejném směru`,
      higherTimeframeAligned,
      higherItem?.trend ?? null,
      !requireHigherTimeframeAlignment || !higherItem
    ),
  ]
  const ready = !awaitingConfirmation && gates.every((itemGate) => itemGate.passed !== false)
  const status = awaitingConfirmation ? 'neutral' : ready ? 'ready' : side ? 'watch' : 'neutral'

  const output = {
    status,
    mode: awaitingConfirmation ? 'formation' : 'screening',
    formationState: awaitingConfirmation ? 'awaiting-confirmation' : null,
    pendingSide: awaitingConfirmation ? side : null,
    // Keep side null during formation so no caller can mistake the plan for
    // an executable signal. directionalSide is solely an audit/UI hint.
    side: awaitingConfirmation ? null : side,
    directionalSide: side,
    riskPct,
    minRewardRisk,
    requireCandleSignal,
    requireHigherTimeframeAlignment,
    pullbackPct: settings.pullbackPct ?? 50,
    zone: activeZone,
    zoneHit,
    entry,
    pullbackLevel: pullback,
    invalidationLevel,
    pullbackRange,
    zoneCandidates,
    activeCandidate,
    stop,
    stopAnchor: activeCandidate?.stopAnchor ?? (
      side === 'long' && activeZone ? Math.min(activeZone.low, invalidationLevel ?? activeZone.low)
        : side === 'short' && activeZone ? Math.max(activeZone.high, invalidationLevel ?? activeZone.high)
          : null
    ),
    stopBuffer: buffer,
    entryAtZoneHit: activeCandidate?.entryAtZoneHit ?? null,
    refinedEntry: activeCandidate?.refinedEntry ?? null,
    entryForMinRR: activeCandidate?.entryForMinRR ?? null,
    entrySource: activeCandidate?.entrySource ?? null,
    entryRefinement: activeCandidate?.lowerTimeframeZone
      ? {
          timeframeId: activeCandidate.lowerTimeframeId,
          zone: activeCandidate.lowerTimeframeZone,
          entry: activeCandidate.refinedEntry,
        }
      : null,
    tp1,
    tp1Rule: side === 'long' ? '1/2 na posledním HH' : side === 'short' ? '1/2 na posledním LL' : null,
    tp2,
    tp2Zone,
    tp2Rule: Number.isFinite(tp2)
      ? side === 'long' ? '1/2 na poslední nevybranou supply zónu' : '1/2 na poslední nevybranou demand zónu'
      : 'druhou polovinu řídí struktura a SL',
    weightedTarget,
    risk,
    reward,
    rewardRisk,
    gates,
    refinement,
  }
  return output
}

// The external EMA regime is a second condition on top of the externally
// sourced pivot structure. A missing or sideways reference fails closed for
// new entries; local swing structure never substitutes for it.
export const applyExternalTrendConfirmation = ({ profile, externalTrend = null } = {}) => {
  if (!profile) return profile
  const expectedTrend = profile.side === 'long' ? 'up' : profile.side === 'short' ? 'down' : null
  const observedTrend = externalTrend?.trend ?? null
  const passed = Boolean(expectedTrend && observedTrend === expectedTrend)
  const detail = !expectedTrend
    ? 'PA-1 zatím nemá potvrzený směr pro vstup'
    : !observedTrend
      ? 'externí reference není dostupná; nový vstup se neautorizuje'
      : observedTrend === 'flat'
        ? 'externí reference je flat; nový vstup se neautorizuje'
        : passed
          ? `externí ${observedTrend} potvrzuje ${profile.side}`
          : `externí ${observedTrend} je proti ${profile.side}; nový vstup se neautorizuje`
  const externalGate = gate('external-trend', 'externí trend potvrzuje směr', passed, detail)
  const gates = [...(profile.gates ?? []).filter((item) => item.id !== externalGate.id), externalGate]
  return {
    ...profile,
    externalTrend,
    gates,
    // A technically ready zone remains visible for audit, but becomes a watch
    // state until the independent feed agrees with its directional side.
    status: profile.status === 'ready' && !passed ? 'watch' : profile.status,
  }
}

const oppositeTrend = (side) => side === 'long' ? 'down' : side === 'short' ? 'up' : null

const profileSnapshot = (profile) => ({
  status: profile?.status ?? null,
  mode: profile?.mode ?? null,
  reason: profile?.reason ?? null,
  side: profile?.side ?? null,
  zone: profile?.zone ? { type: profile.zone.type, low: profile.zone.low, high: profile.zone.high } : null,
  entry: profile?.entry ?? null,
  stop: profile?.stop ?? null,
  tp1: profile?.tp1 ?? null,
  tp2: profile?.tp2 ?? null,
  rewardRisk: profile?.rewardRisk ?? null,
})

/**
 * Open-position review is intentionally separate from entry screening. An
 * entry profile is allowed to change with the market; invalidation only exists
 * when a position with a known side is already open.
 */
export const reviewOpenPosition = ({
  position,
  item,
  lowerItem = null,
  lowerTimeframeId = null,
  settings = DEFAULT_PRICE_ACTION_STRUCTURE,
} = {}) => {
  const currentProfile = evaluateTradeProfile({ item, settings })
  const opposite = oppositeTrend(position?.side)
  const ownTimeframeInvalidated = Boolean(position?.side && (
    item?.trend === opposite ||
    item?.event === (opposite === 'down' ? 'CHoCH_DOWN' : 'CHoCH_UP')
  ))
  const lowerEventInvalidated = Boolean(position?.side && lowerItem?.event === (opposite === 'down' ? 'CHoCH_DOWN' : 'CHoCH_UP'))
  const lowerTimeframeInvalidated = Boolean(position?.side && (lowerItem?.trend === opposite || lowerEventInvalidated))
  const invalidated = ownTimeframeInvalidated || lowerTimeframeInvalidated
  const revisedItem = lowerTimeframeInvalidated && lowerItem?.trend !== 'flat'
    ? lowerEventInvalidated ? { ...lowerItem, trend: opposite } : lowerItem
    : item
  const revisedProfile = evaluateTradeProfile({ item: revisedItem, settings })
  const invalidatingTimeframeId = ownTimeframeInvalidated ? (position.timeframeId ?? position.timeframe ?? null) : lowerTimeframeId
  const closeTrigger = position?.side === 'long'
    ? lowerItem?.structure?.low?.current?.price ?? item?.structure?.low?.current?.price ?? null
    : position?.side === 'short'
      ? lowerItem?.structure?.high?.current?.price ?? item?.structure?.high?.current?.price ?? null
      : null

  return {
    invalidated,
    ownTimeframeInvalidated,
    lowerTimeframeInvalidated,
    invalidatingTimeframeId,
    lowerTimeframeId,
    closeTrigger,
    reason: ownTimeframeInvalidated
      ? `struktura ${item?.trend || 'flat'} na ${invalidatingTimeframeId || 'pracovním TF'} je proti otevřenému ${position.side}`
      : lowerTimeframeInvalidated
        ? `struktura ${lowerItem.trend} na ${lowerTimeframeId || 'nižším TF'} je proti otevřenému ${position.side}`
        : null,
    currentProfile: profileSnapshot(currentProfile),
    revisedProfile: profileSnapshot(revisedProfile),
    currentProfileObject: currentProfile,
    revisedProfileObject: revisedProfile,
  }
}

export const reviewOpenPositionInMatrix = ({
  position,
  matrix,
  settings = DEFAULT_PRICE_ACTION_STRUCTURE,
} = {}) => {
  const symbol = position?.assetSymbol ?? position?.asset ?? 'BTCUSD'
  const timeframeId = position?.timeframeId ?? position?.timeframe ?? '4h'
  const asset = matrix?.assets?.find((candidate) => candidate.symbol === symbol)
  const item = asset?.trends?.[timeframeId] ?? null
  if (!item) return { invalidated: false, symbol, timeframeId, reason: 'pro pozici nebyla nalezena struktura assetu a timeframe' }
  const lowerTimeframeId = LOWER_TIMEFRAME[timeframeId]
  return {
    symbol,
    timeframeId,
    item,
    lowerItem: lowerTimeframeId ? asset.trends?.[lowerTimeframeId] ?? null : null,
    ...reviewOpenPosition({
      position,
      item,
      lowerItem: lowerTimeframeId ? asset.trends?.[lowerTimeframeId] ?? null : null,
      lowerTimeframeId,
      settings,
    }),
  }
}

const attachTradeProfiles = (trends, settings) => {
  for (const timeframe of PRICE_ACTION_TIMEFRAMES) {
    const item = trends[timeframe.id]
    if (!item) continue
    const lowerTimeframeId = LOWER_TIMEFRAME[timeframe.id]
    const higherTimeframeId = HIGHER_TIMEFRAME[timeframe.id]
    const profile = evaluateTradeProfile({
      item,
      lowerItem: lowerTimeframeId ? trends[lowerTimeframeId] : null,
      lowerTimeframeId,
      higherItem: higherTimeframeId ? trends[higherTimeframeId] : null,
      higherTimeframeId,
      settings,
    })
    item.tradeProfile = applyExternalTrendConfirmation({
      profile,
      externalTrend: item.externalTrend,
    })
  }
}

const latestCounterSwingInChart = ({ item, trend, activeRange }) => {
  const anchor = trend === 'down' ? activeRange?.low : activeRange?.high
  const kind = trend === 'down' ? 'high' : 'low'
  if (!anchor || !Number.isFinite(anchor.time)) return null
  const candles = (item?.chartCandles ?? []).filter((candle) => candle.time > anchor.time)
  const extreme = candles.reduce((best, candle, index) => {
    const price = kind === 'high' ? candle.high : candle.low
    if (!best || (kind === 'high' ? price > best.price : price < best.price)) {
      return { kind, price, close: candle.close, time: candle.time, candleIndex: index }
    }
    return best
  }, null)
  if (!extreme) return null
  const reference = trend === 'down' ? activeRange.high?.price : activeRange.low?.price
  if (!Number.isFinite(reference) || (trend === 'down' ? extreme.price >= reference : extreme.price <= reference)) return null
  return {
    ...extreme,
    label: trend === 'down' ? 'LH' : 'HL',
    confirmed: false,
    developing: true,
    inheritedFromTimeframe: '4h',
  }
}

// Legacy internal structure bridge. Kept only for future supplemental
// research; the production matrix no longer calls it.
// The 1H chart is an execution lens inside the active 4H swing, not an
// independent trend engine. A local rebound remains an LH/HL until its close
// breaks the 4H protected end of the wave. Without this anchor, USDJPY's
// 152.9 -> 157.x rebound was falsely shown as a new 1H uptrend even though it
// had not exceeded the 4H LH near 160.4.
export const alignOneHourStructureToFourHour = (trends) => {
  const item = trends?.['1h']
  const higher = trends?.['4h']
  const trend = higher?.trend
  const activeRange = higher?.structure?.activeRange
  const high = activeRange?.high
  const low = activeRange?.low
  const close = item?.lastCandle?.close
  if (
    !item ||
    (trend !== 'up' && trend !== 'down') ||
    !Number.isFinite(high?.price) ||
    !Number.isFinite(low?.price) ||
    !Number.isFinite(close) ||
    high.price <= low.price
  ) return item

  // A close through the parent swing is a genuine 1H break. In that case the
  // 1H classifier may lead; otherwise it inherits the still-active 4H wave.
  const breaksParent = trend === 'down' ? close > high.price : close < low.price
  if (breaksParent) return item

  const inheritedRange = {
    high: { ...high, kind: 'high', label: trend === 'down' ? 'LH' : 'HH' },
    low: { ...low, kind: 'low', label: trend === 'down' ? 'LL' : 'HL' },
    source: '4h-active-spine',
    inheritedFromTimeframe: '4h',
  }
  const developingCounter = latestCounterSwingInChart({ item, trend, activeRange: inheritedRange })
  const highLeg = {
    previous: item.structure?.high?.previous ?? null,
    current: inheritedRange.high,
    label: inheritedRange.high.label,
    confirmedBreak: trend === 'up',
    referencePrice: item.structure?.high?.previous?.price ?? null,
    confirmationClose: inheritedRange.high.close ?? null,
    changePct: null,
  }
  const lowLeg = {
    previous: item.structure?.low?.previous ?? null,
    current: inheritedRange.low,
    label: inheritedRange.low.label,
    confirmedBreak: trend === 'down',
    referencePrice: item.structure?.low?.previous?.price ?? null,
    confirmationClose: inheritedRange.low.close ?? null,
    changePct: null,
  }
  const recentSwings = [inheritedRange.high, inheritedRange.low]
    .sort((left, right) => left.time - right.time)

  item.trend = trend
  item.establishedTrend = trend
  // A just-broken 4H structure still supplies the correct directional spine
  // to the 1H chart, but must remain non-executable until its own wave has
  // completed. The visual direction and the execution permission are thus
  // intentionally separate here.
  item.structureConfirmed = higher.structureConfirmed !== false
  item.status = trend === 'up' ? 'met' : 'unmet'
  item.event = null
  item.eventDetail = null
  item.reason = `${trend} podle aktivní 4H vlny ${inheritedRange.high.label} + ${inheritedRange.low.label}; 1H protipohyb zůstává ${trend === 'down' ? 'LH' : 'HL'} do close přes ${trend === 'down' ? 'LH' : 'HL'} ${trend === 'down' ? high.price : low.price}`
  item.lastHigh = inheritedRange.high.price
  item.lastLow = inheritedRange.low.price
  item.structure = {
    ...item.structure,
    high: highLeg,
    low: lowLeg,
    activeRange: inheritedRange,
    protectedHigh: trend === 'down' ? inheritedRange.high : item.structure?.protectedHigh ?? null,
    protectedLow: trend === 'up' ? inheritedRange.low : item.structure?.protectedLow ?? null,
    developingCounterSwing: developingCounter,
    recentSwings,
    confirmed: item.structureConfirmed,
    inheritedFromTimeframe: '4h',
  }
  return item
}

export const fetchFxCandles = async ({
  asset,
  timeframeId,
  requiredHistoryDays = 0,
  hourlyLookbackDays = 0,
  fetchImpl,
  now,
  logger,
}) => {
  const daily = timeframeId === '1d'
  const requestedHourlyDays = Math.max(380, Math.ceil(Number(hourlyLookbackDays) || 0))
  const yahooHourlyRange = requestedHourlyDays > 380 ? '2y' : '1y'
  const stooqAttempt = async () => ({
    source: 'stooq',
    candles: await fetchStooqCandles({
      symbol: asset.stooqSymbol,
      interval: daily ? 'd' : '60',
      lookbackDays: daily ? 900 : requestedHourlyDays,
      fetchImpl,
      now,
    }),
  })
  const yahooAttempt = async () => ({
    source: 'yahoo',
    candles: await fetchYahooCandles({
      symbol: asset.yahooSymbol,
      interval: daily ? '1d' : '1h',
      range: daily ? '3y' : yahooHourlyRange,
      fetchImpl,
    }),
  })
  // Stooq has repeatedly timed out on long intraday FX requests. The 2-year
  // Yahoo range is confirmed for the hourly aggregation path, so it is the
  // primary source there; short legacy requests retain the original fallback.
  const attempts = !daily && requestedHourlyDays > 380
    ? [yahooAttempt, stooqAttempt]
    : [stooqAttempt, yahooAttempt]

  const failures = []
  for (const attempt of attempts) {
    try {
      const result = await attempt()
      const first = result.candles.at(0)?.time
      const last = result.candles.at(-1)?.time
      // FX markets close on weekends, so a few calendar days may be absent.
      // Anything shorter than the requested zone horizon less that allowance
      // is still an incomplete source, not usable price-action history.
      const minimumSpanMs = Math.max(0, Number(requiredHistoryDays) - 4) * 24 * HOUR_MS
      if (!Number.isFinite(first) || !Number.isFinite(last) || last - first < minimumSpanMs) {
        const spanDays = Number.isFinite(first) && Number.isFinite(last)
          ? Math.floor((last - first) / (24 * HOUR_MS))
          : 0
        throw new Error(`${result.source} returned only ${spanDays} calendar days; need ${requiredHistoryDays}`)
      }
      return { ...result, failures }
    } catch (error) {
      failures.push(error.message)
    }
  }
  logger?.warn?.(`Price action candles failed for ${asset.symbol} ${timeframeId}: ${failures.join('; ')}`)
  return { source: null, candles: [], failures }
}

// Legacy internal swing classifier. It is deliberately kept for later
// research as a supplemental signal, but it is no longer called by the
// production matrix, chart, or entry protocol. Live PA-1 structure comes
// exclusively from the externally sourced, confirmed pivot reference below.
export const classifyStructure = (
  candles,
  {
    lookback = 2,
    zoneLookback = 2,
    minCandles = 40,
    zoneMaxAgeCandles = 400,
    historyDays = null,
    zoneHistoryDays = null,
    zoneCandles = null,
    chartCandles = null,
    includeChartCandles = true,
    includeZones = true,
  } = {}
) => {
  const normalizedCandles = Array.isArray(candles) ? candles.map(normalizeCandlePrices) : candles
  // The structure horizon remains short enough to describe the active wave.
  // Exit targets may legitimately be older untouched FVGs, so they use their
  // own longer history instead of disappearing with the entry/structure view.
  const normalizedZoneCandles = Array.isArray(zoneCandles ?? candles)
    ? (zoneCandles ?? candles).map(normalizeCandlePrices)
    : []
  const chartSource = includeChartCandles && Array.isArray(chartCandles ?? candles)
    ? (chartCandles ?? candles).map(normalizeCandlePrices)
    : []
  if (!Array.isArray(normalizedCandles) || normalizedCandles.length < minCandles) {
    return {
      trend: 'flat',
      status: 'neutral',
      event: null,
      reason: `málo svíček (${candles?.length ?? 0}/${minCandles})`,
      price: normalizedCandles?.at?.(-1)?.close ?? null,
      asOf: normalizedCandles?.at?.(-1)?.time ?? null,
      candles: normalizedCandles?.length ?? 0,
      lastCandle: candleSummary(normalizedCandles?.at?.(-1)),
      candleSignal: null,
      chartCandles: (chartSource ?? []).map(candleSummary),
      zones: null,
    }
  }
  const contextStructure = marketStructure(normalizedCandles, { lookback })
  const activeLookback = activeStructureLookback(lookback)
  const edgeStructure = activeLookback === lookback
    ? contextStructure
    : marketStructure(normalizedCandles, { lookback: activeLookback })
  // Never use the responsive edge to relabel the primary trend. It is only a
  // provisional visual terminal; the wide context remains the decision spine.
  const structure = contextStructure
  const latest = normalizedCandles.at(-1)
  const developingSwing = developingStructureSwing(normalizedCandles, edgeStructure)

  const highLeg = structureLeg({
    previous: structure.previousHigh,
    current: structure.lastHigh,
    higherLabel: 'HH',
    lowerLabel: 'LH',
    breaksByClose: closeBreaksHigh,
  })
  const lowLeg = structureLeg({
    previous: structure.previousLow,
    current: structure.lastLow,
    higherLabel: 'HL',
    lowerLabel: 'LL',
    breaksByClose: (current, previous) => !closeBreaksLow(current, previous),
  })
  const edgeLabels = labelStructureSwings(edgeStructure.swings)
  const highText = highLeg?.label ?? null
  const lowText = lowLeg?.label ?? null
  const localTrend = highText === 'HH' && lowText === 'HL'
    ? 'up'
    : highText === 'LH' && lowText === 'LL' ? 'down' : 'flat'
  const persistent = persistentStructureTrend(normalizedCandles, structure.swings, lookback)
  const structureBreak = persistent.event
  // A confirmed direction is stateful. A fresh pullback does not relabel the
  // market until its counter-pivot is confirmed; a close through the protected
  // LH/HL is the explicit change-of-character event. The old code discarded
  // that state on every incomplete local wave.
  // A close through the protected pivot immediately changes the directional
  // bias shown to the operator (red/green in the matrix), but an entry stays
  // blocked until its LH+LL or HH+HL sequence is confirmed below.
  const breakDirection = ['CHoCH_DOWN', 'RANGE_BREAK_DOWN'].includes(structureBreak?.type)
    ? 'down'
    : ['CHoCH_UP', 'RANGE_BREAK_UP'].includes(structureBreak?.type)
      ? 'up'
      : null
  // A complete current LH+LL / HH+HL sequence is sufficient to resolve an
  // older pending transition. Only an incomplete mixed pair relies solely on
  // the persistent state, which is what keeps internal reactions from
  // overwriting the established direction.
  const trend = breakDirection ?? (persistent.trend !== 'flat' ? persistent.trend : localTrend)
  const establishedTrend = persistent.establishedTrend
  const structureConfirmed = !breakDirection && trend !== 'flat'
  const contextRangeHigh = highLeg?.current ?? null
  const contextRangeLow = lowLeg?.current ?? null
  const edgePivots = [
    ...edgeStructure.swings.map((swing) => pivotSummary(swing, edgeLabels.get(swing.index))),
    developingSwing,
  ].filter(Boolean)
  const pivotClose = (pivot) => pivot?.close ?? pivot?.price
  const latestDownLow = contextRangeLow && contextRangeHigh
    ? edgePivots
      .filter((pivot) => pivot.kind === 'low' && pivot.time > contextRangeLow.time && pivotClose(pivot) < contextRangeLow.price)
      .reduce((best, pivot) => !best || pivot.price < best.price ? pivot : best, null)
    : null
  const latestDownHigh = latestDownLow && contextRangeHigh
    ? edgePivots
      .filter((pivot) => pivot.kind === 'high' && pivot.time > contextRangeLow.time && pivot.time < latestDownLow.time && pivotClose(pivot) < contextRangeHigh.price)
      .reduce((best, pivot) => !best || pivot.price > best.price ? pivot : best, null)
    : null
  const latestUpHigh = contextRangeHigh && contextRangeLow
    ? edgePivots
      .filter((pivot) => pivot.kind === 'high' && pivot.time > contextRangeHigh.time && pivotClose(pivot) > contextRangeHigh.price)
      .reduce((best, pivot) => !best || pivot.price > best.price ? pivot : best, null)
    : null
  const latestUpLow = latestUpHigh && contextRangeLow
    ? edgePivots
      .filter((pivot) => pivot.kind === 'low' && pivot.time > contextRangeHigh.time && pivot.time < latestUpHigh.time && pivotClose(pivot) > contextRangeLow.price)
      .reduce((best, pivot) => !best || pivot.price < best.price ? pivot : best, null)
    : null
  const edgeFormsActiveWave = trend === 'down'
    ? Boolean(latestDownHigh && latestDownLow)
    : trend === 'up'
      ? Boolean(latestUpHigh && latestUpLow)
      : false
  // The broad spine decides the trend. Once its live edge has completed the
  // corresponding LH -> LL / HL -> HH wave, that edge becomes the active
  // swing range for pullback, stop, target and the chart's terminal zigzag.
  // This keeps the chart and the executable price levels on the same wave.
  const activeRange = edgeFormsActiveWave
    ? {
        high: { ...(trend === 'down' ? latestDownHigh : latestUpHigh), label: trend === 'down' ? 'LH' : 'HH' },
        low: { ...(trend === 'down' ? latestDownLow : latestUpLow), label: trend === 'down' ? 'LL' : 'HL' },
        source: 'active-edge',
      }
    : {
        high: highLeg?.current ?? null,
        low: lowLeg?.current ?? null,
        source: 'context',
      }
  const developingCounter = developingCounterSwing(normalizedCandles, { trend, activeRange })
  const status = trend === 'up' ? 'met' : trend === 'down' ? 'unmet' : 'neutral'
  const contextHigh = normalizedCandles.reduce((best, candle) => !best || candle.high > best.high ? candle : best, null)
  const contextLow = normalizedCandles.reduce((best, candle) => !best || candle.low < best.low ? candle : best, null)
  const labels = [highText, lowText].filter(Boolean).join(' + ')
  const chartPivots = chartStructurePivots({
    swings: structure.swings,
    labels: persistent.labels,
    activeRange,
    trend,
    developingSwing,
    developingCounter,
  })
  const protectedPivot = trend === 'up' ? persistent.protectedLow : trend === 'down' ? persistent.protectedHigh : null
  const reason = structureBreak?.type.startsWith('CHoCH')
    ? `${structureBreak.type} close ${structureBreak.close} přes hlavní úroveň ${structureBreak.referencePrice}; bias je ${trend}, čeká se na ${trend === 'down' ? 'LH + LL' : 'HH + HL'} (${labels || 'bez kompletní sekvence'})`
    : structureBreak?.type.startsWith('RANGE_BREAK')
      ? `${structureBreak.type} close ${structureBreak.close} přes hranici range ${structureBreak.referencePrice}; bias je ${trend}, čeká se na ${trend === 'down' ? 'LH + LL' : 'HH + HL'} (${labels || 'bez kompletní sekvence'})`
    : trend !== 'flat' && labels !== (trend === 'up' ? 'HH + HL' : 'LH + LL')
      ? `${trend} pokračuje; změna až po close přes chráněný ${trend === 'up' ? 'HL' : 'LH'} ${protectedPivot?.price ?? '—'} (${labels || 'čeká se na další pivot'})`
      : labels || 'bez potvrzených pivotů'

  return {
    trend,
    establishedTrend,
    structureConfirmed,
    status,
    event: structureBreak?.type ?? null,
    eventDetail: structureBreak,
    reason,
    price: latest?.close ?? null,
    asOf: latest?.time ?? null,
    candles: normalizedCandles.length,
    lastCandle: candleSummary(latest),
    candleSignal: candleSignal(normalizedCandles),
    chartCandles: chartSource.map(candleSummary),
    lastHigh: structure.lastHigh?.price ?? null,
    lastLow: structure.lastLow?.price ?? null,
    structure: {
      lookback,
      activeLookback,
      zoneLookback,
      zoneMaxAgeCandles,
      historyDays,
      zoneHistoryDays,
      zoneCandles: normalizedZoneCandles.length,
      from: normalizedCandles[0]?.time ?? null,
      to: latest?.time ?? null,
      contextHigh: contextHigh ? { price: contextHigh.high, time: contextHigh.time } : null,
      contextLow: contextLow ? { price: contextLow.low, time: contextLow.time } : null,
      swingCount: structure.swings.length,
      edgeSwingCount: edgeStructure.swings.length,
      contextSwingCount: contextStructure.swings.length,
      high: highLeg,
      low: lowLeg,
      activeRange,
      protectedHigh: pivotSummary(persistent.protectedHigh, persistent.protectedHigh ? persistent.labels.get(persistent.protectedHigh.index) : null),
      protectedLow: pivotSummary(persistent.protectedLow, persistent.protectedLow ? persistent.labels.get(persistent.protectedLow.index) : null),
      developingSwing,
      developingCounterSwing: developingCounter,
      confirmed: structureConfirmed,
      recentSwings: structure.swings.slice(-8).map((swing) => pivotSummary(swing, persistent.labels.get(swing.index))),
      chartPivots,
      alternatingTrendPivots: alternatingTrendPivots({ pivots: chartPivots, trend }),
      contextRecentSwings: contextStructure.swings.slice(-8).map((swing) => pivotSummary(swing)),
    },
    zones: includeZones
      ? activeSupplyDemandZones(normalizedZoneCandles, { lookback: zoneLookback, maxAgeCandles: zoneMaxAgeCandles })
      : null,
  }
}

const externalPivotLeg = (pivots, kind) => {
  const typed = pivots.filter((pivot) => pivot.kind === kind)
  const current = typed.at(-1) ?? null
  const previous = typed.at(-2) ?? null
  if (!current) return null
  return {
    previous,
    current,
    label: current.label ?? null,
    confirmedBreak: Boolean(previous && ((kind === 'high' && current.price > previous.price) || (kind === 'low' && current.price < previous.price))),
    referencePrice: previous?.price ?? null,
    confirmationClose: current.close ?? null,
    changePct: previous?.price ? ((current.price / previous.price) - 1) * 100 : null,
  }
}

// This is the only live structure classifier. The OHLC and pivots originate
// from Twelve Data for FX and Binance for BTC; no swing or trend conclusion
// from the local market-data feed is allowed to influence the result.
export const classifyExternalStructure = ({
  candles = [],
  zoneCandles = candles,
  chartCandles = candles,
  zoneLookback = 2,
  zoneMaxAgeCandles = 400,
  historyDays = null,
  zoneHistoryDays = null,
  externalTrend = null,
  externalPivots = null,
} = {}) => {
  const normalizedCandles = Array.isArray(candles) ? candles.map(normalizeCandlePrices) : []
  const normalizedZoneCandles = Array.isArray(zoneCandles) ? zoneCandles.map(normalizeCandlePrices) : []
  const normalizedChartCandles = Array.isArray(chartCandles) ? chartCandles.map(normalizeCandlePrices) : []
  const latest = normalizedCandles.at(-1) ?? null
  const sourcePivots = (externalPivots?.pivots ?? [])
    .filter((pivot) => pivot?.kind && Number.isFinite(pivot.price) && Number.isFinite(pivot.time))
    .sort((left, right) => left.time - right.time)
    .map((pivot) => ({ ...pivot, source: externalPivots?.source ?? externalTrend?.source ?? null }))
  const previousByKind = { high: null, low: null }
  const pivots = sourcePivots.map((pivot) => {
    const previous = previousByKind[pivot.kind]
    const label = pivot.label ?? (!previous
      ? pivot.kind === 'high' ? 'H' : 'L'
      : pivot.kind === 'high'
        ? pivot.price > previous.price ? 'HH' : 'LH'
        : pivot.price > previous.price ? 'HL' : 'LL')
    previousByKind[pivot.kind] = pivot
    return { ...pivot, label }
  })
  const high = externalPivotLeg(pivots, 'high')
  const low = externalPivotLeg(pivots, 'low')
  const requestedTrend = externalPivots?.trend
  const trend = requestedTrend === 'up' || requestedTrend === 'down' ? requestedTrend : 'flat'
  const expectedHigh = trend === 'up' ? 'HH' : trend === 'down' ? 'LH' : null
  const expectedLow = trend === 'up' ? 'HL' : trend === 'down' ? 'LL' : null
  const structureConfirmed = Boolean(
    trend !== 'flat' && high?.label === expectedHigh && low?.label === expectedLow
  )
  const activeRange = structureConfirmed
    ? {
        high: { ...high.current, label: expectedHigh },
        low: { ...low.current, label: expectedLow },
        source: 'external-confirmed-pivots',
      }
    : null
  const source = externalPivots?.source ?? externalTrend?.source ?? 'externí zdroj'
  const method = externalPivots?.method ?? 'potvrzené pivoty externího OHLC'
  const labels = [high?.label, low?.label].filter(Boolean).join(' + ')
  const reason = trend === 'flat'
    ? `${source}: ${method}; bez potvrzené sekvence HH + HL nebo LH + LL${labels ? ` (${labels})` : ''}`
    : `${source}: ${method}; ${labels || `${expectedHigh} + ${expectedLow}`}`

  return {
    trend,
    establishedTrend: trend,
    structureConfirmed,
    status: trend === 'up' ? 'met' : trend === 'down' ? 'unmet' : 'neutral',
    event: null,
    eventDetail: null,
    reason,
    price: latest?.close ?? null,
    asOf: latest?.time ?? externalPivots?.asOf ?? externalTrend?.asOf ?? null,
    candles: normalizedCandles.length,
    lastCandle: candleSummary(latest),
    candleSignal: candleSignal(normalizedCandles),
    chartCandles: normalizedChartCandles.map(candleSummary),
    lastHigh: high?.current?.price ?? null,
    lastLow: low?.current?.price ?? null,
    externalTrend,
    externalPivots,
    structure: {
      source: 'external-confirmed-pivots',
      method,
      lookback: externalPivots?.timePeriod ?? null,
      zoneLookback,
      zoneMaxAgeCandles,
      historyDays,
      zoneHistoryDays,
      zoneCandles: normalizedZoneCandles.length,
      from: normalizedCandles[0]?.time ?? null,
      to: latest?.time ?? null,
      high,
      low,
      activeRange,
      protectedHigh: trend === 'down' ? high?.current ?? null : null,
      protectedLow: trend === 'up' ? low?.current ?? null : null,
      developingSwing: null,
      developingCounterSwing: null,
      confirmed: structureConfirmed,
      // The chart can show only the source pivots used for the live decision.
      // A local zigzag is intentionally never mixed into this path.
      recentSwings: [],
      chartPivots: pivots.map((pivot) => ({
        ...pivot,
        source: pivot.source ?? source,
      })),
      alternatingTrendPivots: [],
      externalPivotCount: pivots.length,
    },
    zones: activeSupplyDemandZones(normalizedZoneCandles, { lookback: zoneLookback, maxAgeCandles: zoneMaxAgeCandles }),
  }
}

const candlesInHistory = (candles, historyDays) => {
  const latestTime = candles.at(-1)?.time
  if (!Number.isFinite(latestTime) || !(historyDays > 0)) return candles
  const cutoff = latestTime - historyDays * 24 * HOUR_MS
  return candles.filter((candle) => candle.time >= cutoff)
}

const assetTimeframeCandles = async ({ asset, btcHourly, fetchImpl, now, logger }) => {
  if (asset.symbol === 'BTCUSD') {
    return PRICE_ACTION_TIMEFRAMES.map((timeframe) => ({
      source: 'bot-market',
      ...aggregateHourlyTimeframeCandles({ candles: btcHourly, timeframeId: timeframe.id }),
    }))
  }

  // Use one FX hourly source for every chart and decision timeframe. Apart
  // from keeping all chart bodies consistent, this avoids mixing a direct
  // daily vendor feed with locally aggregated intraday candles.
  const { source, candles, failures } = await fetchFxCandles({
    asset,
    timeframeId: '1h',
    requiredHistoryDays: PRICE_ACTION_STRUCTURE_PROFILES['1d'].zoneHistoryDays,
    hourlyLookbackDays: FX_HOURLY_HISTORY_DAYS,
    fetchImpl,
    now,
    logger,
  })
  return PRICE_ACTION_TIMEFRAMES.map((timeframe) => ({
    source,
    failures,
    ...aggregateHourlyTimeframeCandles({ candles, timeframeId: timeframe.id }),
  }))
}

const hasStructureDetails = (matrix) =>
  Boolean(matrix?.schemaVersion === PRICE_ACTION_MATRIX_SCHEMA && matrix?.assets?.every((asset) =>
    PRICE_ACTION_TIMEFRAMES.every((timeframe) => {
      const item = asset.trends?.[timeframe.id]
      return item?.structure
        && Array.isArray(item?.structure?.chartPivots)
        && Array.isArray(item?.chartCandles)
        && Array.isArray(item?.tradeProfile?.zoneCandidates)
    })
  ))

const isFresh = (matrix, now, refreshMinutes) => {
  if (!hasStructureDetails(matrix)) return false
  const generated = Date.parse(matrix?.generatedAt ?? '')
  return Number.isFinite(generated) && now - generated < refreshMinutes * 60_000
}

export const canReusePriceActionMatrix = ({
  matrix,
  now,
  refreshMinutes,
  externalTrendEnabled,
  twelveDataApiKey,
}) => {
  if (!isFresh(matrix, now, refreshMinutes)) return false
  if (!externalTrendEnabled) return true
  return canReuseExternalTrendReference({
    previous: matrix.externalTrends,
    hourBucket: Math.floor(now / (60 * 60_000)),
    apiKey: twelveDataApiKey,
  })
}

const effectiveRefreshMinutes = (value) => {
  const parsed = Number(value)
  if (parsed === 0) return 0
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_PRICE_ACTION_STRUCTURE.refreshMinutes
  return Math.min(parsed, DEFAULT_PRICE_ACTION_STRUCTURE.refreshMinutes)
}

export const buildPriceActionMatrix = async ({
  btcHourly = [],
  previous = null,
  fetchImpl = globalThis.fetch,
  now = Date.now(),
  settings = DEFAULT_PRICE_ACTION_STRUCTURE,
  twelveDataApiKey = '',
  externalTrendEnabled = false,
  logger = console,
} = {}) => {
  const merged = { ...DEFAULT_PRICE_ACTION_STRUCTURE, ...(settings ?? {}) }
  const refreshMinutes = effectiveRefreshMinutes(merged.refreshMinutes)
  if (previous && canReusePriceActionMatrix({
    matrix: previous,
    now,
    refreshMinutes,
    externalTrendEnabled,
    twelveDataApiKey,
  })) return previous

  // Each asset fetch starts independently. Forex then derives every
  // timeframe from its one hourly stream, instead of fetching conflicting
  // vendor intervals in parallel.
  const fetchedAssets = await Promise.all(PRICE_ACTION_ASSETS.map(async (asset) => ({
    asset,
    results: await assetTimeframeCandles({ asset, btcHourly, fetchImpl, now, logger }),
  })))

  const externalTrendHour = Math.floor(now / (60 * 60_000))
  const externalTrends = !externalTrendEnabled
    ? null
    : canReuseExternalTrendReference({
          previous: previous?.externalTrends,
          hourBucket: externalTrendHour,
          apiKey: twelveDataApiKey,
        })
      ? previous.externalTrends
      : await buildExternalTrendReference({
          assets: PRICE_ACTION_ASSETS,
          apiKey: twelveDataApiKey,
          fetchImpl,
          now,
          logger,
          previous: previous?.externalTrends ?? null,
        })

  const rows = []
  for (const { asset, results } of fetchedAssets) {
    const trends = {}
    const sources = new Set()
    const failures = []
    for (const [index, timeframe] of PRICE_ACTION_TIMEFRAMES.entries()) {
      const result = results[index]
      const profile = PRICE_ACTION_STRUCTURE_PROFILES[timeframe.id]
      const analysisCandles = candlesInHistory(result.candles, profile.historyDays)
      const zoneCandles = candlesInHistory(result.candles, profile.zoneHistoryDays)
      const chartCandleLimit = PRICE_ACTION_CHART_CANDLE_LIMITS[timeframe.id]
      const chartCandles = (result.chartCandles ?? result.candles).slice(-chartCandleLimit)
      // An untouched FVG can remain a valid TP level long after the active
      // structure/entry horizon moved on. Its target history is therefore
      // independent from the shorter trend horizon for the same timeframe.
      const requestedZoneMaxAgeCandles = Number(merged.zoneMaxAgeCandles)
      const zoneMaxAgeCandles = Number.isFinite(requestedZoneMaxAgeCandles)
        && requestedZoneMaxAgeCandles > 0
        && requestedZoneMaxAgeCandles !== DEFAULT_PRICE_ACTION_STRUCTURE.zoneMaxAgeCandles
        ? requestedZoneMaxAgeCandles
        : profile.zoneMaxAgeCandles
      if (result.source) sources.add(result.source)
      for (const failure of result.failures ?? []) failures.push(`${timeframe.label}: ${failure}`)
      const externalTrend = externalTrends?.assets?.[asset.symbol]?.[timeframe.id] ?? null
      const externalPivots = externalTrends?.pivots?.assets?.[asset.symbol]?.[timeframe.id] ?? null
      trends[timeframe.id] = classifyExternalStructure({
        candles: analysisCandles,
        zoneLookback: merged.zoneLookback,
        zoneMaxAgeCandles,
        historyDays: profile.historyDays,
        zoneHistoryDays: profile.zoneHistoryDays,
        zoneCandles,
        chartCandles,
        externalTrend,
        externalPivots,
      })
    }
    // Intentionally no alignOneHourStructureToFourHour(trends): it was part
    // of the retired local swing classifier and must not alter an external
    // source's timeframe conclusion.
    attachTradeProfiles(trends, merged)
    rows.push({
      symbol: asset.symbol,
      name: asset.name,
      group: asset.group,
      source: [...sources].join(', ') || null,
      failures,
      trends,
    })
  }

  return {
    strategyId: PRICE_ACTION_STRUCTURE_ID,
    schemaVersion: PRICE_ACTION_MATRIX_SCHEMA,
    generatedAt: new Date(now).toISOString(),
    refreshMinutes,
    externalTrends,
    assets: rows,
    timeframes: PRICE_ACTION_TIMEFRAMES.map(({ id, label }) => ({ id, label })),
  }
}

export const evaluateEntry = () => ({
  action: 'none',
  reason: 'Price action matrix entries are executed by the multi-asset paper portfolio after all asset/timeframe profiles are evaluated.',
  context: null,
})

export const manageOpen = () => ({ action: 'hold', reason: 'price-action profile review is recorded separately from entry screening' })
