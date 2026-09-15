import { aggregate, HOUR_MS } from './candles.mjs'
import { buildZones, candleSignal, marketStructure } from './priceaction.mjs'

export const PRICE_ACTION_STRUCTURE_ID = 'price-action-structure-v1'
export const PRICE_ACTION_MATRIX_SCHEMA = 5

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
  '1h': { historyDays: 60, pivotLookback: 48, minCandles: 500 },
  '4h': { historyDays: 180, pivotLookback: 42, minCandles: 250 },
  '1d': { historyDays: 400, pivotLookback: 30, minCandles: 160 },
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
    if (!Number.isFinite(parsedTime) || open === null || high === null || low === null || close === null) continue
    out.push({
      time: parsedTime,
      open,
      high,
      low,
      close,
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
    if (open === null || high === null || low === null || close === null) continue
    out.push({
      time: Number(timestamps[index]) * 1000,
      open,
      high,
      low,
      close,
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
  filledByOwnTimeframeClose: zoneFilledByOwnTimeframeClose(zone, candles),
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

  return {
    demand: latest('demand'),
    supply: latest('supply'),
    latestValidDemand: latest('demand', zones),
    latestValidSupply: latest('supply', zones),
    unfilledDemand: byType('demand'),
    unfilledSupply: byType('supply'),
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

const nearestOpposingZone = ({ side, zones, entry }) => {
  if (side !== 'long' && side !== 'short') return null
  const pool = side === 'long' ? zones?.unfilledSupply ?? [] : zones?.unfilledDemand ?? []
  const candidates =
    side === 'long'
      ? pool.filter((zone) => zone.low > entry).sort((a, b) => a.low - b.low)
      : pool.filter((zone) => zone.high < entry).sort((a, b) => b.high - a.high)
  return candidates[0] ?? null
}

const structuralTarget = ({ side, structure }) =>
  side === 'long'
    ? structure?.high?.current?.price ?? null
    : side === 'short'
      ? structure?.low?.current?.price ?? null
      : null

const pullbackLevel = ({ side, structure, pullbackPct }) => {
  if (side !== 'long' && side !== 'short') return null
  const high = structure?.high?.current?.price
  const low = structure?.low?.current?.price
  if (!Number.isFinite(high) || !Number.isFinite(low) || high <= low) return null
  const ratio = Math.min(Math.max(Number(pullbackPct) || 50, 0), 100) / 100
  return side === 'long'
    ? high - (high - low) * ratio
    : low + (high - low) * ratio
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
  settings = DEFAULT_PRICE_ACTION_STRUCTURE,
} = {}) => {
  const side = sideFromTrend(item?.trend)
  const latest = item?.lastCandle
  const price = item?.price
  const zones = item?.zones
  const zone = side === 'long' ? zones?.demand : side === 'short' ? zones?.supply : null
  const fallbackZone = side === 'long' ? zones?.latestValidDemand : side === 'short' ? zones?.latestValidSupply : null
  const activeZone = zone ?? fallbackZone
  const zoneHit = zoneHitByCandle(activeZone, latest)
  const entry = Number.isFinite(price)
    ? price
    : activeZone
      ? side === 'long'
        ? activeZone.high
        : activeZone.low
      : null
  const pullback = pullbackLevel({ side, structure: item?.structure, pullbackPct: settings.pullbackPct })
  const pulledBack = pullbackSatisfied({ side, latest, level: pullback })
  const buffer = stopBuffer({ zone: activeZone, price: entry, stopBufferPct: settings.stopBufferPct })
  const stop =
    side === 'long' && activeZone
      ? activeZone.low - buffer
      : side === 'short' && activeZone
        ? activeZone.high + buffer
        : null
  const tp1 = structuralTarget({ side, structure: item?.structure })
  const tp2Zone = Number.isFinite(entry) ? nearestOpposingZone({ side, zones, entry }) : null
  const tp2 =
    side === 'long' && tp2Zone
      ? tp2Zone.low
      : side === 'short' && tp2Zone
        ? tp2Zone.high
        : null
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
  const refinement = side ? candleRefinement({ side, signal: item?.candleSignal }) : null

  const invalidatingTrend =
    side === 'long'
      ? lowerItem?.trend === 'down' || lowerItem?.event === 'CHoCH_DOWN'
      : side === 'short'
        ? lowerItem?.trend === 'up' || lowerItem?.event === 'CHoCH_UP'
        : false
  const closeTrigger =
    side === 'long'
      ? lowerItem?.structure?.low?.current?.price ?? null
      : side === 'short'
        ? lowerItem?.structure?.high?.current?.price ?? null
        : null

  const gates = [
    gate('trend', 'struktura má směr', Boolean(side), item?.reason ?? null),
    gate('zone', 'cena je ve správné S/D zóně', Boolean(activeZone && zoneHit), activeZone ? `${activeZone.type} ${activeZone.low}–${activeZone.high}` : null),
    gate('unfilled-zone', 'zóna není vyplněná close na vlastním TF', Boolean(zone), zone ? 'nevyplněná' : fallbackZone ? 'jen poslední platná vyplněná zóna' : null),
    gate('pullback', `${settings.pullbackPct ?? 50}% pullback`, pulledBack, Number.isFinite(pullback) ? String(pullback) : null),
    gate('rr', `R/R alespoň ${minRewardRisk}:1`, Number.isFinite(rewardRisk) && rewardRisk >= minRewardRisk, Number.isFinite(rewardRisk) ? rewardRisk.toFixed(2) : null),
  ]
  const ready = gates.every((itemGate) => itemGate.passed !== false)
  const status = ready ? 'ready' : side ? 'watch' : 'neutral'

  const output = {
    status,
    side,
    riskPct,
    minRewardRisk,
    pullbackPct: settings.pullbackPct ?? 50,
    zone: activeZone,
    zoneHit,
    entry,
    pullbackLevel: pullback,
    stop,
    stopBuffer: buffer,
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
    invalidation: {
      lowerTimeframeId,
      status: lowerItem ? (invalidatingTrend ? 'unmet' : 'met') : 'neutral',
      invalidatingTrend,
      lowerTrend: lowerItem?.trend ?? null,
      lowerEvent: lowerItem?.event ?? null,
      closeTrigger,
      rule: lowerItem
        ? side === 'long'
          ? 'Při změně struktury na menším TF zavírat při návratu na poslední HL.'
          : side === 'short'
            ? 'Při změně struktury na menším TF zavírat při návratu na poslední LH.'
            : 'Bez směru trendu není co invalidovat.'
        : '1H nemá nižší timeframe ve scanneru; invalidace se řeší na stejném TF.',
    },
  }
  return output
}

const attachTradeProfiles = (trends, settings) => {
  for (const timeframe of PRICE_ACTION_TIMEFRAMES) {
    const item = trends[timeframe.id]
    if (!item) continue
    const lowerTimeframeId = LOWER_TIMEFRAME[timeframe.id]
    item.tradeProfile = evaluateTradeProfile({
      item,
      lowerItem: lowerTimeframeId ? trends[lowerTimeframeId] : null,
      lowerTimeframeId,
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
        lookbackDays: daily ? 900 : 220,
        fetchImpl,
        now,
      }),
    }),
    async () => ({
      source: 'yahoo',
      candles: await fetchYahooCandles({
        symbol: asset.yahooSymbol,
        interval: daily ? '1d' : '1h',
        range: daily ? '3y' : '180d',
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
  { lookback = 2, zoneLookback = 2, minCandles = 40, zoneMaxAgeCandles = 400, historyDays = null } = {}
) => {
  if (!Array.isArray(candles) || candles.length < minCandles) {
    return {
      trend: 'flat',
      status: 'neutral',
      event: null,
      reason: `málo svíček (${candles?.length ?? 0}/${minCandles})`,
      price: candles?.at?.(-1)?.close ?? null,
      asOf: candles?.at?.(-1)?.time ?? null,
      candles: candles?.length ?? 0,
      lastCandle: candleSummary(candles?.at?.(-1)),
      candleSignal: null,
      zones: null,
    }
  }
  const structure = marketStructure(candles, { lookback })
  const latest = candles.at(-1)

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
  const persistent = persistentStructureTrend(candles, structure.swings, lookback)
  const trend = persistent.trend
  const structureBreak = persistent.event
  const establishedTrend = structureBreak?.type.startsWith('CHoCH') ? structureBreak.fromTrend : trend
  const status = trend === 'up' ? 'met' : trend === 'down' ? 'unmet' : 'neutral'
  const contextHigh = candles.reduce((best, candle) => !best || candle.high > best.high ? candle : best, null)
  const contextLow = candles.reduce((best, candle) => !best || candle.low < best.low ? candle : best, null)
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
    candles: candles.length,
    lastCandle: candleSummary(latest),
    candleSignal: candleSignal(candles),
    lastHigh: structure.lastHigh?.price ?? null,
    lastLow: structure.lastLow?.price ?? null,
    structure: {
      lookback,
      zoneLookback,
      historyDays,
      from: candles[0]?.time ?? null,
      to: latest?.time ?? null,
      contextHigh: contextHigh ? { price: contextHigh.high, time: contextHigh.time } : null,
      contextLow: contextLow ? { price: contextLow.low, time: contextLow.time } : null,
      swingCount: structure.swings.length,
      high: highLeg,
      low: lowLeg,
      recentSwings: structure.swings.slice(-8).map((swing) => pivotSummary(swing)),
    },
    zones: activeSupplyDemandZones(candles, { lookback: zoneLookback, maxAgeCandles: zoneMaxAgeCandles }),
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
    PRICE_ACTION_TIMEFRAMES.every((timeframe) => asset.trends?.[timeframe.id]?.structure)
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

  const rows = []
  for (const asset of PRICE_ACTION_ASSETS) {
    const trends = {}
    const sources = new Set()
    const failures = []
    for (const timeframe of PRICE_ACTION_TIMEFRAMES) {
      const result = await timeframeCandles({ asset, timeframe, btcHourly, fetchImpl, now, logger })
      const profile = PRICE_ACTION_STRUCTURE_PROFILES[timeframe.id]
      const analysisCandles = candlesInHistory(result.candles, profile.historyDays)
      if (result.source) sources.add(result.source)
      for (const failure of result.failures ?? []) failures.push(`${timeframe.label}: ${failure}`)
      trends[timeframe.id] = classifyStructure(analysisCandles, {
        lookback: profile.pivotLookback,
        zoneLookback: merged.zoneLookback,
        minCandles: Number(merged.minCandles) !== DEFAULT_PRICE_ACTION_STRUCTURE.minCandles
          ? Number(merged.minCandles)
          : profile.minCandles,
        zoneMaxAgeCandles: merged.zoneMaxAgeCandles,
        historyDays: profile.historyDays,
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

export const manageOpen = () => ({ action: 'hold', reason: 'price-action profile does not manage live positions until execution is enabled' })
