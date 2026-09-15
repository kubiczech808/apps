// Research backtest for PA-1. This deliberately reuses the same structure,
// zone and trade-profile functions as the live scanner, but walks them through
// a historical candle stream so the dashboard never reports a different rule
// set under the same strategy name.

import { HOUR_MS } from './candles.mjs'
import {
  classifyStructure,
  evaluateTradeProfile,
  PRICE_ACTION_STRUCTURE_PROFILES,
} from './strategy-price-action-structure.mjs'

const LOWER_TIMEFRAME = { '1h': null, '4h': '1h', '1d': '4h' }
const TIMEFRAME_HOURS = { '1h': 1, '4h': 4, '1d': 24 }

const finite = (value) => Number.isFinite(Number(value))

const lowerBound = (candles, time) => {
  let low = 0
  let high = candles.length
  while (low < high) {
    const middle = Math.floor((low + high) / 2)
    if (candles[middle].time < time) low = middle + 1
    else high = middle
  }
  return low
}

const upperBound = (candles, time) => {
  let low = 0
  let high = candles.length
  while (low < high) {
    const middle = Math.floor((low + high) / 2)
    if (candles[middle].time <= time) low = middle + 1
    else high = middle
  }
  return low
}

const sliceHistory = (candles, historyDays) => {
  const latest = candles.at(-1)?.time
  if (!finite(latest) || !(historyDays > 0)) return candles
  const cutoff = latest - historyDays * 24 * HOUR_MS
  return candles.slice(lowerBound(candles, cutoff))
}

const candleWindowAt = (candles, throughTime, durationHours) =>
  candles.slice(0, upperBound(candles, throughTime - durationHours * HOUR_MS))

const structureAt = ({ candles, timeframeId, throughTime }) => {
  const profile = PRICE_ACTION_STRUCTURE_PROFILES[timeframeId]
  const available = candleWindowAt(candles, throughTime, TIMEFRAME_HOURS[timeframeId])
  const history = sliceHistory(available, profile.historyDays)
  return classifyStructure(history, {
    lookback: profile.pivotLookback,
    zoneLookback: 2,
    minCandles: profile.minCandles,
    zoneMaxAgeCandles: profile.zoneMaxAgeCandles,
    historyDays: profile.historyDays,
  })
}

const closeValue = (position, price) =>
  position.side === 'long' ? (price - position.entry) / position.entry : (position.entry - price) / position.entry

const annualised = (start, end, from, to) => {
  const days = Math.max(1 / 365.25, (to - from) / (24 * HOUR_MS))
  return ((end / start) ** (365.25 / days) - 1) * 100
}

const timestamp = (value) => {
  if (Number.isFinite(Number(value))) return Number(value)
  const parsed = Date.parse(String(value ?? ''))
  return Number.isFinite(parsed) ? parsed : null
}

const emptyReport = ({ asset, timeframeId, candles, reason, dataSource }) => ({
  asset,
  timeframeId,
  status: 'insufficient-data',
  statusKind: 'neutral',
  reason,
  dataSource,
  from: candles[0]?.time ? new Date(candles[0].time).toISOString() : null,
  to: candles.at(-1)?.time ? new Date(candles.at(-1).time).toISOString() : null,
  candles: candles.length,
  trades: 0,
  wins: 0,
  losses: 0,
  winRate: null,
  profitFactor: null,
  returnPct: null,
  cagrPct: null,
  maxDrawdownPct: null,
  averageHoldDays: null,
})

export const runPriceActionStructureBacktest = ({
  asset,
  timeframeId,
  candles = [],
  lowerCandles = [],
  dataSource = null,
  startingCapital = 100,
  riskPct = 1,
  feeRate = 0.0006,
  settings = {},
} = {}) => {
  const profile = PRICE_ACTION_STRUCTURE_PROFILES[timeframeId]
  const timeframeHours = TIMEFRAME_HOURS[timeframeId]
  if (!profile || !timeframeHours || !Array.isArray(candles)) {
    return emptyReport({ asset, timeframeId, candles: [], dataSource, reason: 'neznámý timeframe nebo chybějící data' })
  }

  const ordered = candles.filter((candle) =>
    Number.isFinite(Number(candle.time)) &&
    [candle.open, candle.high, candle.low, candle.close].every((value) => finite(value) && Number(value) > 0)
  )
    .sort((a, b) => a.time - b.time)
  const minimum = Math.max(profile.minCandles, profile.pivotLookback * 2 + 5)
  if (ordered.length <= minimum) {
    return emptyReport({ asset, timeframeId, candles: ordered, dataSource, reason: `málo svíček (${ordered.length}/${minimum})` })
  }

  let cash = Number(startingCapital) > 0 ? Number(startingCapital) : 100
  const startCash = cash
  const trades = []
  const equityCurve = []
  let position = null
  let lastAcceptedCandle = null
  let directionalProfiles = 0
  let readyProfiles = 0
  let zoneHits = 0

  const recordExit = (reason, exitPrice, at) => {
    if (!position) return
    const remaining = position.remaining
    if (remaining > 0) {
      const gross = position.notional * remaining * closeValue(position, exitPrice)
      const fee = position.notional * remaining * feeRate
      cash += gross - fee
      position.realized += gross - fee
      position.remaining = 0
    }
    trades.push({
      side: position.side,
      openedAt: position.openedAt,
      closedAt: at,
      entry: position.entry,
      exitPrice,
      pl: position.realized,
      riskAmount: position.riskAmount,
      rMultiple: position.riskAmount > 0 ? position.realized / position.riskAmount : null,
      exitReason: reason,
      holdDays: (at - position.openedAt) / (24 * HOUR_MS),
    })
    position = null
  }

  const takePartial = (fraction, exitPrice, at) => {
    if (!position || position.remaining <= 0) return
    const size = Math.min(position.remaining, fraction)
    const gross = position.notional * size * closeValue(position, exitPrice)
    const fee = position.notional * size * feeRate
    cash += gross - fee
    position.realized += gross - fee
    position.remaining -= size
  }

  const markEquity = (close) => cash + (position ? position.notional * position.remaining * closeValue(position, close) : 0)

  for (let index = 0; index < ordered.length; index += 1) {
    const candle = ordered[index]
    const candleEnd = candle.time + timeframeHours * HOUR_MS
    // A limit order can be waiting before this candle opens. Build its profile
    // from data available before the candle, then let the candle's high/low
    // decide whether the already-defined entry was filled. Using candleEnd for
    // the entry profile would read this candle's close before entering inside
    // its range, which is look-ahead bias.
    const item = structureAt({ candles: ordered, timeframeId, throughTime: candle.time })
    const lowerTimeframeId = LOWER_TIMEFRAME[timeframeId]
    const lowerItem = lowerTimeframeId && lowerCandles.length
      ? structureAt({ candles: lowerCandles, timeframeId: lowerTimeframeId, throughTime: candle.time })
      : null
    const lowerClosedItem = lowerTimeframeId && lowerCandles.length
      ? structureAt({ candles: lowerCandles, timeframeId: lowerTimeframeId, throughTime: candleEnd })
      : null
    const closedItem = structureAt({ candles: ordered, timeframeId, throughTime: candleEnd })
    const tradeProfile = evaluateTradeProfile({
      // Zone hit and pullback are range conditions. Applying the current
      // candle only to lastCandle preserves the prepared structure/zones and
      // permits a valid intrabar fill without using its closing direction.
      item: { ...item, lastCandle: { ...item.lastCandle, ...candle } },
      lowerItem,
      lowerTimeframeId,
      settings,
    })
    const profiledItem = { ...item, tradeProfile }
    if (tradeProfile?.side) directionalProfiles += 1
    if (tradeProfile?.zoneHit) zoneHits += 1
    if (tradeProfile?.status === 'ready') readyProfiles += 1

    if (position) {
      // A candle touching the stop and a target is conservatively settled at
      // the stop first, exactly as the paper executor does.
      const stopHit = position.side === 'long' ? candle.low <= position.stop : candle.high >= position.stop
      if (stopHit) {
        recordExit('stop_loss', position.stop, candleEnd)
      } else {
        if (!position.tp1Taken) {
          const tp1Hit = position.side === 'long' ? candle.high >= position.tp1 : candle.low <= position.tp1
          if (tp1Hit) {
            takePartial(0.5, position.tp1, candleEnd)
            position.tp1Taken = true
          }
        }
        if (position && position.remaining > 0) {
          const tp2Hit = position.side === 'long' ? candle.high >= position.tp2 : candle.low <= position.tp2
          if (tp2Hit) recordExit('take_profit', position.tp2, candleEnd)
        }
        if (position) {
          const invalidationTrend = position.side === 'long' ? 'down' : 'up'
          const ownStructureInvalidated = closedItem.trend === invalidationTrend || closedItem.event === `CHoCH_${invalidationTrend.toUpperCase()}`
          const lowerStructureInvalidated = lowerClosedItem?.trend === invalidationTrend || lowerClosedItem?.event === `CHoCH_${invalidationTrend.toUpperCase()}`
          if (ownStructureInvalidated || lowerStructureInvalidated) {
            recordExit('structure_invalidation', candle.close, candleEnd)
          }
        }
      }
    }

    equityCurve.push({ at: candleEnd, equity: markEquity(candle.close) })
    if (position || tradeProfile.status !== 'ready' || lastAcceptedCandle === profiledItem.asOf) continue

    const trade = tradeProfile
    const entry = Number(trade.entry)
    const stop = Number(trade.stop)
    const tp1 = Number(trade.tp1)
    const tp2 = Number(trade.tp2)
    if (![entry, stop, tp1, tp2].every(Number.isFinite)) continue
    const entryHit = trade.side === 'long'
      ? candle.low <= entry && candle.high >= entry
      : candle.high >= entry && candle.low <= entry
    if (!entryHit) continue

    const riskDistance = Math.abs(entry - stop) / entry
    if (!(riskDistance > 0)) continue
    const equity = markEquity(candle.close)
    const riskCapital = equity * (Number(riskPct) || 1) / 100
    const maxNotionalPct = Number(settings.maxNotionalPct) || 300
    // Both sides of a completed trade pay a fee. Include them in the risk
    // budget so a tight stop cannot turn fees into several nominal R units.
    const roundTripRiskDistance = riskDistance + 2 * feeRate
    const notional = Math.min(riskCapital / roundTripRiskDistance, equity * maxNotionalPct / 100)
    if (!(notional > 0)) continue
    const openingFee = notional * feeRate
    cash -= openingFee
    position = {
      side: trade.side,
      trend: profiledItem.trend,
      entry,
      stop,
      tp1,
      tp2,
      notional,
      riskAmount: notional * roundTripRiskDistance,
      remaining: 1,
      tp1Taken: false,
      realized: -openingFee,
      openedAt: candleEnd,
    }
    lastAcceptedCandle = profiledItem.asOf
  }

  const last = ordered.at(-1)
  if (position) recordExit('end_of_test', last.close, last.time + timeframeHours * HOUR_MS)
  const finalEquity = cash
  const wins = trades.filter((trade) => trade.pl > 0)
  const losses = trades.filter((trade) => trade.pl < 0)
  const grossWins = wins.reduce((sum, trade) => sum + trade.pl, 0)
  const grossLosses = Math.abs(losses.reduce((sum, trade) => sum + trade.pl, 0))
  let peak = startCash
  let maxDrawdown = 0
  for (const point of equityCurve) {
    peak = Math.max(peak, point.equity)
    if (peak > 0) maxDrawdown = Math.max(maxDrawdown, (peak - point.equity) / peak)
  }
  const from = ordered[minimum]?.time ?? ordered[0]?.time
  const to = last?.time
  const returnPct = ((finalEquity / startCash) - 1) * 100
  const cagrPct = Number.isFinite(from) && Number.isFinite(to) ? annualised(startCash, finalEquity, from, to) : null
  const statusKind = Number.isFinite(cagrPct) && Number.isFinite(maxDrawdown) && cagrPct >= 20 && maxDrawdown * 100 <= 20 ? 'met' : 'neutral'

  return {
    asset,
    timeframeId,
    status: 'complete',
    statusKind,
    dataSource,
    from: Number.isFinite(from) ? new Date(from).toISOString() : null,
    to: Number.isFinite(to) ? new Date(to).toISOString() : null,
    candles: ordered.length - minimum,
    directionalProfiles,
    readyProfiles,
    zoneHits,
    trades: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRate: trades.length ? (wins.length / trades.length) * 100 : null,
    profitFactor: grossLosses > 0 ? grossWins / grossLosses : null,
    returnPct,
    cagrPct,
    maxDrawdownPct: maxDrawdown * 100,
    averageHoldDays: trades.length ? trades.reduce((sum, trade) => sum + trade.holdDays, 0) / trades.length : null,
    // Kept separate from `trades`, which is the existing numeric dashboard
    // metric. These compact records are enough to build a cross-asset,
    // cross-timeframe portfolio without publishing candle data again.
    tradeLog: trades.map(({ side, openedAt, closedAt, rMultiple, exitReason, holdDays }) => ({
      side,
      openedAt,
      closedAt,
      rMultiple,
      exitReason,
      holdDays,
    })),
    model: `PA-1 · risk ${Number(riskPct) || 1}% · fee ${((Number(feeRate) || 0) * 100).toFixed(2)}%/strana · TP1/TP2 50/50`,
  }
}

/**
 * Combine independently backtested PA-1 rows into one account curve.
 *
 * A row's R-multiple is independent of its original $100 simulation. The
 * portfolio therefore sizes every accepted trade at `riskPct` of the current
 * combined equity. Trades on different assets may overlap; trades on the same
 * asset may not, because that would silently stack the same directional risk.
 */
export const aggregatePriceActionBacktests = ({
  assets = {},
  selected = {},
  startingCapital = 100,
  riskPct = 1,
} = {}) => {
  const rows = Object.entries(assets ?? {}).flatMap(([asset, timeframes]) =>
    Object.entries(timeframes ?? {}).map(([timeframeId, result]) => ({ asset, timeframeId, result }))
  )
  const isSelected = ({ asset, timeframeId }) => selected?.[asset]?.[timeframeId] !== false
  const selectedRows = rows.filter(isSelected)
  const allTrades = selectedRows.flatMap(({ asset, timeframeId, result }) =>
    (Array.isArray(result?.tradeLog) ? result.tradeLog : [])
      .map((trade, order) => ({ ...trade, asset, timeframeId, order }))
      .filter((trade) => timestamp(trade.openedAt) !== null && timestamp(trade.closedAt) !== null)
  ).sort((left, right) =>
    timestamp(left.openedAt) - timestamp(right.openedAt)
      || timestamp(left.closedAt) - timestamp(right.closedAt)
      || left.asset.localeCompare(right.asset)
      || left.timeframeId.localeCompare(right.timeframeId)
      || left.order - right.order
  )

  const lastClosedByAsset = new Map()
  const acceptedTrades = []
  let overlapSkipped = 0
  for (const trade of allTrades) {
    const openedAt = timestamp(trade.openedAt)
    const closedAt = timestamp(trade.closedAt)
    const lastClosed = lastClosedByAsset.get(trade.asset)
    if (lastClosed !== undefined && openedAt < lastClosed) {
      overlapSkipped += 1
      continue
    }
    lastClosedByAsset.set(trade.asset, closedAt)
    acceptedTrades.push(trade)
  }

  const initial = Number(startingCapital) > 0 ? Number(startingCapital) : 100
  const risk = Number(riskPct) > 0 ? Number(riskPct) : 1
  let equity = initial
  let peak = equity
  let maxDrawdown = 0
  let wins = 0
  let losses = 0
  let grossWins = 0
  let grossLosses = 0
  let holdTotal = 0
  for (const trade of acceptedTrades) {
    const multiple = Number(trade.rMultiple)
    if (!Number.isFinite(multiple)) continue
    const pl = equity * risk / 100 * multiple
    equity += pl
    if (pl > 0) { wins += 1; grossWins += pl }
    if (pl < 0) { losses += 1; grossLosses += Math.abs(pl) }
    holdTotal += Number(trade.holdDays) || 0
    peak = Math.max(peak, equity)
    if (peak > 0) maxDrawdown = Math.max(maxDrawdown, (peak - equity) / peak)
  }

  const periods = selectedRows
    .flatMap(({ result }) => [timestamp(result?.from), timestamp(result?.to)])
    .filter((value) => value !== null)
  const from = periods.length ? Math.min(...periods) : null
  const to = periods.length ? Math.max(...periods) : null
  const returnPct = ((equity / initial) - 1) * 100
  const cagrPct = from !== null && to !== null ? annualised(initial, equity, from, to) : null
  const trades = acceptedTrades.filter((trade) => Number.isFinite(Number(trade.rMultiple))).length
  const statusKind = Number.isFinite(cagrPct) && cagrPct >= 20 && maxDrawdown * 100 <= 20 ? 'met' : 'neutral'

  return {
    status: selectedRows.length ? 'complete' : 'empty-selection',
    statusKind,
    from: from === null ? null : new Date(from).toISOString(),
    to: to === null ? null : new Date(to).toISOString(),
    startingCapital: initial,
    finalCapital: equity,
    riskPct: risk,
    selectedRows: selectedRows.length,
    totalRows: rows.length,
    trades,
    wins,
    losses,
    winRate: trades ? (wins / trades) * 100 : null,
    profitFactor: grossLosses > 0 ? grossWins / grossLosses : null,
    returnPct,
    cagrPct,
    maxDrawdownPct: maxDrawdown * 100,
    averageHoldDays: trades ? holdTotal / trades : null,
    overlapSkipped,
  }
}
