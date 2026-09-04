// Walk-forward backtest.
//
// The point of this file is to be able to say something true about the strategy
// before it is given money. It therefore refuses the shortcuts that make a
// backtest look good:
//
//  - Decisions are taken on the candles available AT THAT HOUR, rebuilt from a
//    trailing window, never from the full series. No future candle is visible.
//  - Higher-timeframe buckets are only offered once complete, exactly as the
//    live path does, so a 4h signal cannot be acted on three hours early.
//  - Exits are settled BEFORE the next entry decision, on the same candle data
//    the live bot would have seen, and a candle touching both stop and target
//    settles at the stop.
//  - Fees are charged on both sides.
//
// What it still cannot model: slippage beyond the fee, funding/carry over long
// holds, and the fact that LN Markets' own index can differ from the spot venue
// the candles came from. Results should be read as an upper bound.

import { aggregate } from './candles.mjs'
import { createPaperExecutor } from './executor-paper.mjs'
import { planPosition, SATS_PER_BTC } from './risk.mjs'
import { evaluateEntry, manageOpen } from './strategy.mjs'
import { computeStats, DEFAULT_SETTINGS, mergeSettings } from './state.mjs'
import { roundStop, roundTarget } from './bot.mjs'

export const runBacktest = async ({
  hourly,
  settings: overrides = {},
  warmupHours = 400,
  windowHours = 2400,
  startingCapitalUsd,
} = {}) => {
  const settings = mergeSettings({ ...DEFAULT_SETTINGS, ...overrides })
  const capitalUsd = startingCapitalUsd ?? settings.startingCapitalUsd
  if (!Array.isArray(hourly) || hourly.length <= warmupHours) {
    throw new Error(`need more than ${warmupHours} hourly candles, got ${hourly?.length ?? 0}`)
  }

  const startBalance = Math.round((capitalUsd / hourly[warmupHours].close) * SATS_PER_BTC)
  const store = { balanceSats: startBalance, trades: [], nextId: 1 }
  const executor = createPaperExecutor({ store, feeRate: settings.risk.feeRate })

  const equityCurve = []
  const rejections = new Map()
  let lastLossAt = null
  let tradesTodayKey = null
  let tradesTodayCount = 0

  for (let index = warmupHours; index < hourly.length; index += 1) {
    const candle = hourly[index]

    // Settle first: an exit on this candle frees capital the same hour.
    executor.mark([candle])

    const from = Math.max(0, index - windowHours)
    const slice = hourly.slice(from, index + 1)
    const ltf = aggregate(slice, settings.timeframes.ltfHours)
    const htf = aggregate(slice, settings.timeframes.htfHours)
    if (ltf.length < settings.strategy.minLtfCandles || htf.length < settings.strategy.minHtfCandles) continue

    const running = store.trades.filter((trade) => trade.status === 'running')

    for (const position of running) {
      const decision = manageOpen({ position, ltfCandles: ltf, htfCandles: htf, settings: settings.strategy })
      if (decision.action === 'move_stop') {
        const stop = roundStop(position.side, decision.stop)
        const improves = position.side === 'long' ? stop > position.stopLoss : stop < position.stopLoss
        if (improves) position.stopLoss = stop
      } else if (decision.action === 'close') {
        await executor.closePosition(position.id, candle.close)
      }
    }

    const stillRunning = store.trades.filter((trade) => trade.status === 'running')
    const dayKey = new Date(candle.time).toISOString().slice(0, 10)
    if (dayKey !== tradesTodayKey) {
      tradesTodayKey = dayKey
      tradesTodayCount = 0
    }

    const balance = store.balanceSats
    const marginUsed = stillRunning.reduce((sum, trade) => sum + trade.marginSats, 0)
    const equitySats = balance + marginUsed
    equityCurve.push({ at: candle.time, equitySats, price: candle.close })

    if (stillRunning.length >= settings.maxOpenPositions) continue
    if (tradesTodayCount >= settings.maxTradesPerDay) continue
    if (lastLossAt && candle.time - lastLossAt < settings.cooldownMinutesAfterLoss * 60_000) continue

    const decision = evaluateEntry({ htfCandles: htf, ltfCandles: ltf, settings: settings.strategy })
    if (decision.action !== 'open') {
      rejections.set(decision.reason, (rejections.get(decision.reason) ?? 0) + 1)
      continue
    }

    const entry = Math.round(decision.entry)
    const stop = roundStop(decision.side, decision.stop)
    const takeProfit = roundTarget(decision.side, decision.takeProfit)
    const plan = planPosition({
      side: decision.side,
      entry,
      stop,
      takeProfit,
      equitySats,
      settings: settings.risk,
    })
    if (!plan.ok) {
      rejections.set(plan.reason, (rejections.get(plan.reason) ?? 0) + 1)
      continue
    }

    try {
      const opened = await executor.openPosition({ ...plan, side: decision.side })
      opened.thesis = decision.reason
      tradesTodayCount += 1
    } catch (error) {
      rejections.set(error.message, (rejections.get(error.message) ?? 0) + 1)
    }

    const justClosed = store.trades.filter((trade) => trade.status === 'closed' && trade.plSats < 0)
    lastLossAt = justClosed.reduce((latest, trade) => Math.max(latest, trade.closedAt ?? 0), lastLossAt ?? 0) || null
  }

  const closed = store.trades.filter((trade) => trade.status === 'closed')
  const stats = computeStats(closed)
  const finalEquity = equityCurve.at(-1)?.equitySats ?? startBalance
  const buyHoldSats = startBalance

  return {
    settings,
    from: new Date(hourly[warmupHours].time).toISOString(),
    to: new Date(hourly.at(-1).time).toISOString(),
    hours: hourly.length - warmupHours,
    startBalanceSats: startBalance,
    finalEquitySats: finalEquity,
    returnPct: ((finalEquity - startBalance) / startBalance) * 100,
    // Holding sats is the honest benchmark for a sats-denominated account: the
    // bot has to beat doing nothing, not beat the dollar price of bitcoin.
    holdSatsReturnPct: ((buyHoldSats - startBalance) / startBalance) * 100,
    stats,
    trades: closed,
    openAtEnd: store.trades.filter((trade) => trade.status === 'running').length,
    equityCurve,
    rejections: [...rejections.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20),
  }
}

export const formatBacktest = (report) => {
  const lines = []
  const sats = (value) => (value === null || value === undefined ? 'n/a' : `${Math.round(value)} sats`)
  const pct = (value) => (value === null || value === undefined ? 'n/a' : `${value.toFixed(2)}%`)

  lines.push(`Window        ${report.from} → ${report.to} (${report.hours} hours)`)
  lines.push(`Start / end   ${sats(report.startBalanceSats)} → ${sats(report.finalEquitySats)}  (${pct(report.returnPct)})`)
  lines.push(`Trades        ${report.stats.trades} (${report.stats.wins}W / ${report.stats.losses}L), win rate ${pct(report.stats.winRate)}`)
  lines.push(`Profit factor ${report.stats.profitFactor === null ? 'n/a (no losing trade)' : report.stats.profitFactor.toFixed(2)}`)
  lines.push(`Net P/L       ${sats(report.stats.netPnlSats)}   max drawdown ${pct(report.stats.maxDrawdownPct)}`)
  lines.push(`Avg win/loss  ${sats(report.stats.averageWinSats)} / ${sats(report.stats.averageLossSats)}`)
  lines.push('')
  lines.push('Most common reasons no trade was taken:')
  for (const [reason, count] of report.rejections.slice(0, 8)) {
    lines.push(`  ${String(count).padStart(6)}  ${reason}`)
  }
  return lines.join('\n')
}
