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
import * as priceActionStrategy from './strategy.mjs'
import { computeStats, DEFAULT_SETTINGS, mergeSettings } from './state.mjs'
import { roundStop, roundTarget } from './bot.mjs'

export const runBacktest = async ({
  hourly,
  settings: overrides = {},
  warmupHours = 400,
  windowHours = 2400,
  startingCapitalUsd,
  // Real LN Markets settlement history. Passing none means positions are held
  // for free, which is a different and more flattering question than the one
  // this is supposed to answer — so the report says which was measured.
  fundingSettlements = [],
  // Any module exporting evaluateEntry and manageOpen. The engine below knows
  // nothing about what a signal is, so a new idea is a new file rather than a
  // branch inside an old one.
  strategy = priceActionStrategy,
} = {}) => {
  const settings = mergeSettings({ ...DEFAULT_SETTINGS, ...overrides })
  const capitalUsd = startingCapitalUsd ?? settings.startingCapitalUsd
  if (!Array.isArray(hourly) || hourly.length <= warmupHours) {
    throw new Error(`need more than ${warmupHours} hourly candles, got ${hourly?.length ?? 0}`)
  }

  const startBalance = Math.round((capitalUsd / hourly[warmupHours].close) * SATS_PER_BTC)
  const store = { balanceSats: startBalance, trades: [], nextId: 1 }

  // The executor's clock must be the CANDLE's clock, not the wall clock.
  //
  // This is not a nicety. `mark()` refuses to settle a candle older than the
  // trade that is being marked — correct in production, where it stops a
  // position being closed by a candle that predates it. With the default
  // wall-clock, every historical candle is older than every backtest trade, so
  // no stop loss and no take profit ever fired: positions could only be closed
  // by the higher-timeframe flip rule, at market, wherever price happened to
  // be. The first run to reach real data reported +10.5% with a 46.8%
  // drawdown and average losses five times the 1% that was risked — the
  // signature of a system with no stops, and entirely an artefact of this.
  let clock = hourly[warmupHours].time
  const executor = createPaperExecutor({
    store,
    feeRate: settings.risk.feeRate,
    fundingSettlements,
    now: () => clock,
  })

  const equityCurve = []
  const rejections = new Map()
  // Disabling the stop management produced a byte-identical result on 233 days
  // of real candles, which does not mean it is harmless — it means it never
  // fired. Counting the actions makes that checkable instead of inferred.
  const management = { breakeven: 0, trail: 0, close: 0, reachedOneR: 0 }
  let lastLossAt = null
  let tradesTodayKey = null
  let tradesTodayCount = 0

  for (let index = warmupHours; index < hourly.length; index += 1) {
    const candle = hourly[index]
    clock = candle.time

    // Settle first: an exit on this candle frees capital the same hour.
    executor.mark([candle])

    const from = Math.max(0, index - windowHours)
    const slice = hourly.slice(from, index + 1)
    const ltf = aggregate(slice, settings.timeframes.ltfHours)
    const htf = aggregate(slice, settings.timeframes.htfHours)
    // The strategy states its own requirements by refusing; the engine only
    // needs enough to be worth asking.
    if (ltf.length < 2 || htf.length < 2) continue

    const running = store.trades.filter((trade) => trade.status === 'running')

    for (const position of running) {
      const risk = Math.abs(position.entry - position.initialStop)
      const progressR =
        risk > 0
          ? (position.side === 'long' ? candle.close - position.entry : position.entry - candle.close) / risk
          : 0
      if (progressR >= 1 && !position.everReachedOneR) {
        position.everReachedOneR = true
        management.reachedOneR += 1
      }

      const decision = strategy.manageOpen({ position, ltfCandles: ltf, htfCandles: htf, settings: settings.strategy })
      if (decision.action === 'move_stop') {
        const stop = roundStop(position.side, decision.stop)
        const improves = position.side === 'long' ? stop > position.stopLoss : stop < position.stopLoss
        if (improves) {
          position.stopLoss = stop
          if (/trailing/.test(decision.reason)) management.trail += 1
          else management.breakeven += 1
        }
      } else if (decision.action === 'close') {
        management.close += 1
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

    const decision = strategy.evaluateEntry({ htfCandles: htf, ltfCandles: ltf, settings: settings.strategy })
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
  const stats = computeStats(closed, { startEquitySats: startBalance })
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
    management,
    fees: {
      tradingSats: closed.reduce(
        (sum, trade) => sum + (trade.openingFeeSats ?? 0) + (trade.closingFeeSats ?? 0),
        0
      ),
      carrySats: closed.reduce((sum, trade) => sum + (trade.carryFeesSats ?? 0), 0),
      settlementsUsed: fundingSettlements.length,
    },
    equityCurve,
    rejections: [...rejections.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20),
  }
}

export const formatBacktest = (report) => {
  const lines = []
  const sats = (value) => (value === null || value === undefined ? 'n/a' : `${Math.round(value)} sats`)
  const pct = (value) => (value === null || value === undefined ? 'n/a' : `${value.toFixed(2)}%`)

  // Trades first, summary last. A CI log is read from the bottom, and a report
  // that puts its headline above a hundred trade lines is a report nobody sees.
  if (report.trades.length) {
    lines.push('Trades:')
    for (const trade of report.trades) {
      lines.push(
        `  ${new Date(trade.openedAt).toISOString().slice(0, 16)}  ${trade.side.padEnd(5)}` +
          ` ${String(trade.quantityUsd).padStart(5)} USD  entry ${Math.round(trade.entry)}` +
          `  stop ${Math.round(trade.initialStop)}  tp ${Math.round(trade.takeProfit)}` +
          `  exit ${Math.round(trade.exitPrice)} (${trade.exitReason})` +
          `  ${trade.plSats > 0 ? '+' : ''}${trade.plSats} sats`
      )
    }
    lines.push('')
  }

  lines.push('Most common reasons no trade was taken:')
  for (const [reason, count] of report.rejections.slice(0, 8)) {
    lines.push(`  ${String(count).padStart(6)}  ${reason}`)
  }
  lines.push('')

  // How positions ended is the first thing to check when a result looks odd: a
  // run with no stop-loss exits is not a good strategy, it is broken stops.
  const exits = report.trades.reduce((counts, trade) => {
    counts[trade.exitReason] = (counts[trade.exitReason] ?? 0) + 1
    return counts
  }, {})

  lines.push('════ RESULT ════')
  lines.push(`Window        ${report.from} → ${report.to} (${report.hours} hours, ${(report.hours / 24).toFixed(0)} days)`)
  lines.push(`Start / end   ${sats(report.startBalanceSats)} → ${sats(report.finalEquitySats)}  (${pct(report.returnPct)})`)
  lines.push(`Trades        ${report.stats.trades} (${report.stats.wins}W / ${report.stats.losses}L), win rate ${pct(report.stats.winRate)}`)
  lines.push(`Exits         ${Object.entries(exits).map(([reason, count]) => `${reason} ×${count}`).join(', ') || 'none'}`)
  lines.push(`Profit factor ${report.stats.profitFactor === null ? 'n/a (no losing trade)' : report.stats.profitFactor.toFixed(2)}`)
  lines.push(`Net P/L       ${sats(report.stats.netPnlSats)}   max drawdown ${pct(report.stats.maxDrawdownPct)}`)
  lines.push(`Avg win/loss  ${sats(report.stats.averageWinSats)} / ${sats(report.stats.averageLossSats)}`)
  const m = report.management ?? {}
  lines.push(
    `Management    ${m.reachedOneR ?? 0} trades reached 1R; ` +
      `${m.breakeven ?? 0} moved to breakeven, ${m.trail ?? 0} trailed, ${m.close ?? 0} closed on trend flip`
  )
  const fees = report.fees ?? {}
  lines.push(
    `Fees          trading ${sats(fees.tradingSats)}, carry ${sats(fees.carrySats)}` +
      (fees.settlementsUsed ? ` (${fees.settlementsUsed} real settlements)` : ' — CARRY NOT MODELLED')
  )
  // Thirteen trades and a profit factor of 1.12 is noise wearing the clothes of
  // a result. Say so in the output rather than leaving the reader to remember.
  if (report.stats.trades < 30) {
    lines.push(`\nSample of ${report.stats.trades} trades is too small to say anything about edge.`)
  }
  return lines.join('\n')
}
