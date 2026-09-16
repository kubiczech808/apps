import { aggregate, HOUR_MS } from './candles.mjs'
import { ceilPrice, floorPrice, normalizeCandlePrices, roundPrice } from './price.mjs'
import { buildZones, candleSignal, marketStructure } from './priceaction.mjs'

export const PRICE_ACTION_STRUCTURE_ID = 'price-action-structure-v1'
export const PRICE_ACTION_MATRIX_SCHEMA = 15
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
  stopBufferPct: 0.02,
}

// Main structure and execution zones deliberately use different resolutions.
// Structure needs the external swings visible on the chart; zones still need
// the smaller reactions from which an entry can actually be refined.
export const PRICE_ACTION_STRUCTURE_PROFILES = {
  '1h': { historyDays: 60, pivotLookback: 48, minCandles: 500, zoneMaxAgeCandles: 1440 },
  '4h': { historyDays: 180, pivotLookback: 42, minCandles: 250, zoneMaxAgeCandles: 1080 },
  '1d': { historyDays: 400, pivotLookback: 30, minCandles: 160, zoneMaxAgeCandles: 400 },
}

export const PRICE_ACTION_ASSETS = [
  { symbol: 'BTCUSD', name: 'Bitcoin / US Dollar', group: 'crypto', binanceSymbol: 'BTCUSDT', yahooSymbol: 'BTC-USD' },
  { symbol: 'EURUSD', name: 'Euro / US Dollar', group: 'fx', stooqSymbol: 'eurusd', yahooSymbol: 'EURUSD=X' },
  { symbol: 'GBPUSD', name: 'British Pound / US Dollar', group: 'fx', stooqSymbol: 'gbpusd', yahooSymbol: 'GBPUSD=X' },
  { symbol: 'USDJPY', name: 'US Dollar / Japanese Yen', group: 'fx', stooqSymbol: 'usdjpy', yahooSymbol: 'JPY=X' },
  { symbol: 'USDCHF', name: 'US Dollar / Swiss Franc', group: 'fx', stooqSymbol: 'usdchf', yahooSymbol: 'CHF=X' },
  { symbol: 'USDCAD', name: 'US Dollar / Canadian Dollar', group: 'fx', stooqSymbol: 'usdcad', yahooSymbol: 'CAD=X' },
  { symbol: 'AUDUSD', name: 'Australian Dollar / US Dollar', group: 'fx', stooqSymbol: 'audusd', yahooSymbol: 'AUDUSD=X' },
  { symbol: 'NZDUSD', name: 'New Zealand Dollar / US Dollar', group: 'fx', stooqSymbol: 'nzdusd', yahooSymbol: 'NZDUSD=X' },
]

export const PRICE_ACTION_TIMEFRAMES = [
  { id: '1h', label: '1H', hours: 1 },
  { id: '4h', label: '4H', hours: 4 },
  { id: '1d', label: '1D', hours: 24 },
]

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

const persistentStructureTrend = (candles, swings, lookback) => {
  const confirmations = new Map()
  for (const swing of swings) {
    const confirmedAt = swing.index + lookback
    confirmations.set(confirmedAt, [...(confirmations.get(confirmedAt) ?? []), swing])
  }

  const highs = []
  const lows = []
  let trend = 'flat'
  let latestEvent = null

  for (let index = 0; index < candles.length; index += 1) {
    for (const swing of confirmations.get(index) ?? []) {
      if (swing.kind === 'high') highs.push(swing)
      else lows.push(swing)
    }

    const lastHigh = highs.at(-1)
    const previousHigh = highs.at(-2)
    const lastLow = lows.at(-1)
    const previousLow = lows.at(-2)
    const current = candles[index]
    const previous = candles[index - 1]

    if (trend === 'flat' && lastHigh && previousHigh && lastLow && previousLow) {
      const highLabel = closeBreaksHigh(lastHigh, previousHigh) ? 'HH' : 'LH'
      const lowLabel = closeBreaksLow(lastLow, previousLow) ? 'LL' : 'HL'
      if (highLabel === 'HH' && lowLabel === 'HL') trend = 'up'
      else if (highLabel === 'LH' && lowLabel === 'LL') trend = 'down'
    }

    const crossedAbove = lastHigh && current.close > lastHigh.price && previous?.close <= lastHigh.price
    const crossedBelow = lastLow && current.close < lastLow.price && previous?.close >= lastLow.price
    if (trend === 'up' && crossedBelow) {
      latestEvent = {
        type: 'CHoCH_DOWN',
        direction: 'down',
        fromTrend: 'up',
        index,
        time: current.time,
        close: current.close,
        referencePrice: lastLow.price,
        referenceTime: lastLow.time,
      }
      trend = 'down'
    } else if (trend === 'down' && crossedAbove) {
      latestEvent = {
        type: 'CHoCH_UP',
        direction: 'up',
        fromTrend: 'down',
        index,
        time: current.time,
        close: current.close,
        referencePrice: lastHigh.price,
        referenceTime: lastHigh.time,
      }
      trend = 'up'
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
    event: latestEvent?.index >= recentCutoff ? latestEvent : null,
  }
}

const laterCandles = (candles, zone) => candles.slice((zone.lastIndex ?? zone.firstIndex ?? 0) + 1)

const zoneInvalidated = (zone, candles) => {
  const later = laterCandles(candles, zone)
  return zone.type === 'demand'
    ? later.some((candle) => candle.close < zone.low)
    : later.some((candle) => candle.close > zone.high)
}

const zoneFilledByOwnTimeframeClose = (zone, candles) => {
  const later = laterCandles(candles, zone)
  return zone.type === 'demand'
    ? later.some((candle) => candle.close <= zone.high)
    : later.some((candle) => candle.close >= zone.low)
}

const zoneFilledAtOwnTimeframeClose = (zone, candles) => {
  const later = laterCandles(candles, zone)
  return (zone.type === 'demand'
    ? later.find((candle) => candle.close <= zone.high)
    : later.find((candle) => candle.close >= zone.low))?.time ?? null
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

const zoneSummary = (zone, candles, price) => ({
  type: zone.type,
  low: zone.low,
  high: zone.high,
  touches: zone.touches,
  swept: zone.swept,
  imbalance: zone.imbalance,
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
})

export const activeSupplyDemandZones = (candles, { lookback = 2, maxAgeCandles = 400 } = {}) => {
  const price = candles.at(-1)?.close ?? null
  const zones = buildZones(candles, { lookback, maxAgeCandles })
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
    rule: 'Zóna je invalidovaná jen close průrazem na vlastním timeframe; dotek/filled na nižším timeframe ji neruší.',
  }
}

const zoneHitByCandle = (zone, candle) =>
  Boolean(zone && candle && candle.low <= zone.high && candle.high >= zone.low)

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
  return candidates[0] ?? null
}

const structuralTarget = ({ side, structure }) =>
  side === 'long'
    ? roundPrice(structure?.high?.current?.price ?? null)
    : side === 'short'
      ? roundPrice(structure?.low?.current?.price ?? null)
      : null

const pullbackLevel = ({ side, structure, pullbackPct }) => {
  if (side !== 'long' && side !== 'short') return null
  const high = structure?.high?.current?.price
  const low = structure?.low?.current?.price
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
    ? roundPrice(structure?.low?.current?.price ?? null)
    : side === 'short'
      ? roundPrice(structure?.high?.current?.price ?? null)
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
  const tp2Zone = Number.isFinite(refinedEntry)
    ? nearestOpposingZone({ side, zones: item?.zones, entry: refinedEntry, tp1 })
    : null
  const tp2 = side === 'long' ? roundPrice(tp2Zone?.low ?? null) : roundPrice(tp2Zone?.high ?? null)
  const weightedTarget = Number.isFinite(tp1) && Number.isFinite(tp2) ? roundPrice((tp1 + tp2) / 2) : null
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

const pullbackSatisfied = ({ side, latest, level }) => {
  if (!latest || !Number.isFinite(level)) return false
  return side === 'long' ? latest.low <= level : latest.high >= level
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
  const zoneCandidates = ['long', 'short'].flatMap((candidateSide) =>
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
  const fallbackZone = side === 'long' ? zones?.latestValidDemand : side === 'short' ? zones?.latestValidSupply : null
  const activeCandidate =
    zoneCandidates.find((candidate) => candidate.directionEligible && candidate.eligible) ??
    zoneCandidates.find((candidate) => candidate.directionEligible && candidate.pullbackEligible) ??
    zoneCandidates.find((candidate) => candidate.directionEligible) ??
    null
  const activeZone =
    activeCandidate?.zone ??
    (side === 'long' ? zones?.demand : side === 'short' ? zones?.supply : null) ??
    fallbackZone
  const zoneHit = zoneHitByCandle(activeZone, latest)
  // A planned entry is meaningful only when the candidate passes the complete
  // direction, pullback and minimum-R/R gates. Keep raw zone-edge values on
  // the candidate for diagnostics, but never publish them as a trade entry.
  const plannedEntry = activeCandidate?.eligible ? activeCandidate.entryForMinRR : null
  const entry = Number.isFinite(plannedEntry) ? plannedEntry : null
  const pulledBack = pullbackSatisfied({ side, latest, level: pullback })
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
  const tp2Zone = activeCandidate?.tp2Zone ?? (
    Number.isFinite(entry) ? nearestOpposingZone({ side, zones, entry, tp1 }) : null
  )
  const tp2 = activeCandidate?.tp2 ?? (
    side === 'long' && tp2Zone
      ? tp2Zone.low
      : side === 'short' && tp2Zone
        ? tp2Zone.high
        : null
  )
  const weightedTarget = Number.isFinite(tp1) && Number.isFinite(tp2) ? (tp1 + tp2) / 2 : null
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
  const signalItem = lowerTimeframeId && lowerItem?.candleSignal ? lowerItem : item
  const refinement = side ? candleRefinement({ side, signal: signalItem?.candleSignal }) : null
  const requireCandleSignal = settings.requireCandleSignal === true
  const requireHigherTimeframeAlignment = settings.requireHigherTimeframeAlignment === true
  const higherTimeframeAligned = !higherItem || higherItem.trend === item?.trend

  const gates = [
    gate('trend', 'struktura má směr', Boolean(side), item?.reason ?? null),
    gate('zone', 'cena je ve správné S/D zóně', Boolean(activeZone && zoneHit), activeZone ? `${activeZone.type} ${activeZone.low}–${activeZone.high}` : null),
    gate('unfilled-zone', 'zóna není vyplněná close na vlastním TF', Boolean(zone), zone ? 'nevyplněná' : fallbackZone ? 'jen poslední platná vyplněná zóna' : null),
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
  const ready = gates.every((itemGate) => itemGate.passed !== false)
  const status = ready ? 'ready' : side ? 'watch' : 'neutral'

  const output = {
    status,
    side,
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
    tp2Rule: side === 'long' ? '1/2 na poslední nevybranou supply zónu' : side === 'short' ? '1/2 na poslední nevybranou demand zónu' : null,
    weightedTarget,
    risk,
    reward,
    rewardRisk,
    gates,
    refinement,
  }
  return output
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
    item.tradeProfile = evaluateTradeProfile({
      item,
      lowerItem: lowerTimeframeId ? trends[lowerTimeframeId] : null,
      lowerTimeframeId,
      higherItem: higherTimeframeId ? trends[higherTimeframeId] : null,
      higherTimeframeId,
      settings,
    })
  }
}

const fetchFxCandles = async ({ asset, timeframeId, fetchImpl, now, logger }) => {
  const daily = timeframeId === '1d'
  const attempts = [
    async () => ({
      source: 'stooq',
      candles: await fetchStooqCandles({
        symbol: asset.stooqSymbol,
        interval: daily ? 'd' : '60',
        lookbackDays: daily ? 900 : 380,
        fetchImpl,
        now,
      }),
    }),
    async () => ({
      source: 'yahoo',
      candles: await fetchYahooCandles({
        symbol: asset.yahooSymbol,
        interval: daily ? '1d' : '1h',
        range: daily ? '3y' : '1y',
        fetchImpl,
      }),
    }),
  ]

  const failures = []
  for (const attempt of attempts) {
    try {
      const result = await attempt()
      return { ...result, failures }
    } catch (error) {
      failures.push(error.message)
    }
  }
  logger?.warn?.(`Price action candles failed for ${asset.symbol} ${timeframeId}: ${failures.join('; ')}`)
  return { source: null, candles: [], failures }
}

export const classifyStructure = (
  candles,
  {
    lookback = 2,
    zoneLookback = 2,
    minCandles = 40,
    zoneMaxAgeCandles = 400,
    historyDays = null,
    chartCandles = null,
    includeChartCandles = true,
  } = {}
) => {
  const normalizedCandles = Array.isArray(candles) ? candles.map(normalizeCandlePrices) : candles
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
  const structure = marketStructure(normalizedCandles, { lookback })
  const latest = normalizedCandles.at(-1)

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
  const highText = highLeg?.label ?? null
  const lowText = lowLeg?.label ?? null
  const localTrend = highText === 'HH' && lowText === 'HL'
    ? 'up'
    : highText === 'LH' && lowText === 'LL' ? 'down' : 'flat'
  const persistent = persistentStructureTrend(normalizedCandles, structure.swings, lookback)
  const trend = persistent.trend
  const structureBreak = persistent.event
  const establishedTrend = structureBreak?.type.startsWith('CHoCH') ? structureBreak.fromTrend : trend
  const status = trend === 'up' ? 'met' : trend === 'down' ? 'unmet' : 'neutral'
  const contextHigh = normalizedCandles.reduce((best, candle) => !best || candle.high > best.high ? candle : best, null)
  const contextLow = normalizedCandles.reduce((best, candle) => !best || candle.low < best.low ? candle : best, null)
  const reason = structureBreak?.type.startsWith('CHoCH')
    ? `${structureBreak.type} close ${structureBreak.close} přes hlavní úroveň ${structureBreak.referencePrice}; předchozí ${[highText, lowText].filter(Boolean).join(' + ')}`
    : trend !== 'flat' && localTrend !== trend
      ? `hlavní struktura drží ${trend}; poslední pivoty ${[highText, lowText].filter(Boolean).join(' + ')} obrat nepotvrdily`
      : [highText, lowText].filter(Boolean).join(' + ') || 'bez potvrzených pivotů'

  return {
    trend,
    establishedTrend,
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
      zoneLookback,
      zoneMaxAgeCandles,
      historyDays,
      from: normalizedCandles[0]?.time ?? null,
      to: latest?.time ?? null,
      contextHigh: contextHigh ? { price: contextHigh.high, time: contextHigh.time } : null,
      contextLow: contextLow ? { price: contextLow.low, time: contextLow.time } : null,
      swingCount: structure.swings.length,
      high: highLeg,
      low: lowLeg,
      recentSwings: structure.swings.slice(-8).map((swing) => pivotSummary(swing)),
    },
    zones: activeSupplyDemandZones(normalizedCandles, { lookback: zoneLookback, maxAgeCandles: zoneMaxAgeCandles }),
  }
}

const candlesInHistory = (candles, historyDays) => {
  const latestTime = candles.at(-1)?.time
  if (!Number.isFinite(latestTime) || !(historyDays > 0)) return candles
  const cutoff = latestTime - historyDays * 24 * HOUR_MS
  return candles.filter((candle) => candle.time >= cutoff)
}

const timeframeCandles = async ({ asset, timeframe, btcHourly, fetchImpl, now, logger }) => {
  if (asset.symbol === 'BTCUSD') {
    const candles = timeframe.id === '1d' ? aggregate(btcHourly, 24) : aggregate(btcHourly, timeframe.hours)
    return { source: 'bot-market', candles }
  }
  if (timeframe.id === '4h') {
    const { source, candles, failures } = await fetchFxCandles({ asset, timeframeId: '1h', fetchImpl, now, logger })
    return { source, candles: aggregate(candles, 4), failures }
  }
  return fetchFxCandles({ asset, timeframeId: timeframe.id, fetchImpl, now, logger })
}

const hasStructureDetails = (matrix) =>
  Boolean(matrix?.schemaVersion === PRICE_ACTION_MATRIX_SCHEMA && matrix?.assets?.every((asset) =>
    PRICE_ACTION_TIMEFRAMES.every((timeframe) => {
      const item = asset.trends?.[timeframe.id]
      return item?.structure && Array.isArray(item?.chartCandles) && Array.isArray(item?.tradeProfile?.zoneCandidates)
    })
  ))

const isFresh = (matrix, now, refreshMinutes) => {
  if (!hasStructureDetails(matrix)) return false
  const generated = Date.parse(matrix?.generatedAt ?? '')
  return Number.isFinite(generated) && now - generated < refreshMinutes * 60_000
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
  logger = console,
} = {}) => {
  const merged = { ...DEFAULT_PRICE_ACTION_STRUCTURE, ...(settings ?? {}) }
  const refreshMinutes = effectiveRefreshMinutes(merged.refreshMinutes)
  if (previous && isFresh(previous, now, refreshMinutes)) return previous

  // Fetch the independent asset/timeframe inputs together. The old nested
  // loop waited for every FX source before starting the next one, so a cold
  // schema refresh could hold the runner lease until systemd killed it.
  const fetchedAssets = await Promise.all(PRICE_ACTION_ASSETS.map(async (asset) => ({
    asset,
    results: await Promise.all(PRICE_ACTION_TIMEFRAMES.map((timeframe) =>
      timeframeCandles({ asset, timeframe, btcHourly, fetchImpl, now, logger })
    )),
  })))

  const rows = []
  for (const { asset, results } of fetchedAssets) {
    const trends = {}
    const sources = new Set()
    const failures = []
    for (const [index, timeframe] of PRICE_ACTION_TIMEFRAMES.entries()) {
      const result = results[index]
      const profile = PRICE_ACTION_STRUCTURE_PROFILES[timeframe.id]
      const analysisCandles = candlesInHistory(result.candles, profile.historyDays)
      const chartCandleLimit = PRICE_ACTION_CHART_CANDLE_LIMITS[timeframe.id]
      const chartCandles = result.candles.slice(-chartCandleLimit)
      // A zone must remain visible for the full structural context of its own
      // timeframe. The former universal 400-candle window dropped valid 4H
      // levels after roughly 67 days while the trend still used 180 days.
      const requestedZoneMaxAgeCandles = Number(merged.zoneMaxAgeCandles)
      const zoneMaxAgeCandles = Number.isFinite(requestedZoneMaxAgeCandles)
        && requestedZoneMaxAgeCandles > 0
        && requestedZoneMaxAgeCandles !== DEFAULT_PRICE_ACTION_STRUCTURE.zoneMaxAgeCandles
        ? requestedZoneMaxAgeCandles
        : profile.zoneMaxAgeCandles
      if (result.source) sources.add(result.source)
      for (const failure of result.failures ?? []) failures.push(`${timeframe.label}: ${failure}`)
      trends[timeframe.id] = classifyStructure(analysisCandles, {
        lookback: profile.pivotLookback,
        zoneLookback: merged.zoneLookback,
        minCandles: Number(merged.minCandles) !== DEFAULT_PRICE_ACTION_STRUCTURE.minCandles
          ? Number(merged.minCandles)
          : profile.minCandles,
        zoneMaxAgeCandles,
        historyDays: profile.historyDays,
        chartCandles,
      })
    }
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
    assets: rows,
    timeframes: PRICE_ACTION_TIMEFRAMES.map(({ id, label }) => ({ id, label })),
  }
}

export const evaluateEntry = () => ({
  action: 'none',
  reason: 'Price action structure publishes periodic trade profiles; automatic order execution is still disabled until the profile is backtested and explicitly selected.',
  context: null,
})

export const manageOpen = () => ({ action: 'hold', reason: 'price-action profile review is recorded separately from entry screening' })
