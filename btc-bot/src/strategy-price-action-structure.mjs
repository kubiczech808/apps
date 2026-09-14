import { aggregate, HOUR_MS } from './candles.mjs'
import { marketStructure } from './priceaction.mjs'

export const PRICE_ACTION_STRUCTURE_ID = 'price-action-structure-v1'

export const DEFAULT_PRICE_ACTION_STRUCTURE = {
  trendLookback: 2,
  minCandles: 40,
  refreshMinutes: 60,
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
        time: swing.time,
        candleIndex: swing.index,
      }
    : null

const structureLeg = ({ previous, current, higherLabel, lowerLabel }) => {
  if (!previous || !current) return null
  return {
    previous: pivotSummary(previous),
    current: pivotSummary(current, current.price > previous.price ? higherLabel : lowerLabel),
    label: current.price > previous.price ? higherLabel : lowerLabel,
    changePct: previous.price ? ((current.price / previous.price) - 1) * 100 : null,
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

export const classifyStructure = (candles, { lookback = 2, minCandles = 40 } = {}) => {
  if (!Array.isArray(candles) || candles.length < minCandles) {
    return {
      trend: 'flat',
      status: 'neutral',
      event: null,
      reason: `málo svíček (${candles?.length ?? 0}/${minCandles})`,
      price: candles?.at?.(-1)?.close ?? null,
      asOf: candles?.at?.(-1)?.time ?? null,
      candles: candles?.length ?? 0,
    }
  }
  const structure = marketStructure(candles, { lookback })
  const latest = candles.at(-1)
  const trend = structure.bias === 'range' ? 'flat' : structure.bias
  const status = trend === 'up' ? 'met' : trend === 'down' ? 'unmet' : 'neutral'
  const highText =
    structure.previousHigh && structure.lastHigh
      ? structure.lastHigh.price > structure.previousHigh.price
        ? 'HH'
        : 'LH'
      : null
  const lowText =
    structure.previousLow && structure.lastLow
      ? structure.lastLow.price > structure.previousLow.price
        ? 'HL'
        : 'LL'
      : null

  const highLeg = structureLeg({
    previous: structure.previousHigh,
    current: structure.lastHigh,
    higherLabel: 'HH',
    lowerLabel: 'LH',
  })
  const lowLeg = structureLeg({
    previous: structure.previousLow,
    current: structure.lastLow,
    higherLabel: 'HL',
    lowerLabel: 'LL',
  })

  return {
    trend,
    status,
    event: structure.event,
    reason: [highText, lowText].filter(Boolean).join(' + ') || 'bez potvrzených pivotů',
    price: latest?.close ?? null,
    asOf: latest?.time ?? null,
    candles: candles.length,
    lastHigh: structure.lastHigh?.price ?? null,
    lastLow: structure.lastLow?.price ?? null,
    structure: {
      lookback,
      swingCount: structure.swings.length,
      high: highLeg,
      low: lowLeg,
      recentSwings: structure.swings.slice(-8).map((swing) => pivotSummary(swing)),
    },
  }
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
  Boolean(matrix?.assets?.every((asset) =>
    PRICE_ACTION_TIMEFRAMES.every((timeframe) => asset.trends?.[timeframe.id]?.structure)
  ))

const isFresh = (matrix, now, refreshMinutes) => {
  if (!hasStructureDetails(matrix)) return false
  const generated = Date.parse(matrix?.generatedAt ?? '')
  return Number.isFinite(generated) && now - generated < refreshMinutes * 60_000
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
  if (previous && isFresh(previous, now, merged.refreshMinutes)) return previous

  const rows = []
  for (const asset of PRICE_ACTION_ASSETS) {
    const trends = {}
    const sources = new Set()
    const failures = []
    for (const timeframe of PRICE_ACTION_TIMEFRAMES) {
      const result = await timeframeCandles({ asset, timeframe, btcHourly, fetchImpl, now, logger })
      if (result.source) sources.add(result.source)
      for (const failure of result.failures ?? []) failures.push(`${timeframe.label}: ${failure}`)
      trends[timeframe.id] = classifyStructure(result.candles, {
        lookback: merged.trendLookback,
        minCandles: merged.minCandles,
      })
    }
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
    generatedAt: new Date(now).toISOString(),
    refreshMinutes: merged.refreshMinutes,
    assets: rows,
    timeframes: PRICE_ACTION_TIMEFRAMES.map(({ id, label }) => ({ id, label })),
  }
}

export const evaluateEntry = () => ({
  action: 'none',
  reason: 'Price action structure is scan-only until its entry and exit rules are selected by backtest.',
  context: null,
})

export const manageOpen = () => ({ action: 'hold', reason: 'scan-only strategy does not manage live positions' })
