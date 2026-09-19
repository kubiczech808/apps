// Paper execution against the same interface as the live one.
//
// This exists so the bot can run — and be judged — without an exchange account,
// and so a missing or broken credential degrades to "not trading" rather than to
// "trading blind". It is also what `backtest.mjs` drives.
//
// Fill model, stated so its optimism is visible:
//  - entry fills at the trigger candle's close, plus a fee;
//  - within one candle that touched BOTH the stop and the target, the STOP is
//    taken. Real intrabar order is unknown, and assuming the good one is how a
//    backtest flatters itself into a strategy nobody should trade.

import { carryForSettlement } from './funding.mjs'
import { pnlSats, SATS_PER_BTC } from './risk.mjs'

const HOUR_MS = 60 * 60_000
const TIMEFRAME_HOURS = { '1h': 1, '4h': 4, '1d': 24 }

export const createPaperExecutor = ({
  store,
  feeRate = 0.0006,
  // Real settlement history, ascending by time. Without it a position is held
  // for free, which flatters every slow strategy and flatters the slowest most.
  fundingSettlements = [],
  now = () => Date.now(),
}) => {
  store.trades ??= []
  store.balanceSats ??= 0
  store.nextId ??= 1
  store.lastFundingAt ??= null

  const running = () => store.trades.filter((trade) => trade.status === 'running')

  const validLinearTp2 = (plan) => {
    if (!Number.isFinite(plan?.tp1) || !Number.isFinite(plan?.tp2)) return null
    if (plan.side === 'long' && plan.tp2 > plan.tp1) return plan.tp2
    if (plan.side === 'short' && plan.tp2 < plan.tp1) return plan.tp2
    return null
  }

  const feeFor = (quantityUsd, price) => Math.ceil(((quantityUsd * SATS_PER_BTC) / price) * feeRate)

  const markTrade = (trade, price) => {
    const gross = pnlSats({ side: trade.side, entry: trade.entry, exit: price, quantityUsd: trade.quantityUsd })
    const closingFee = feeFor(trade.quantityUsd, price)
    const carry = Math.round(trade.carryFeesSats ?? 0)
    trade.markPrice = price
    // Same all-in definition as a closed trade, including the cost that would
    // be paid to exit at this mark. Open and closed P/L stay comparable.
    trade.plSats = Math.round(gross - trade.openingFeeSats - closingFee - carry)
  }

  const linearGrossSats = (trade, price, quantityUsd = trade.remainingQuantityUsd ?? trade.quantityUsd) => {
    const direction = trade.side === 'long' ? 1 : -1
    return quantityUsd * ((price - trade.entry) / trade.entry) * direction * trade.quoteSatsPerUsd
  }

  const linearFeeSats = (trade, quantityUsd) => Math.ceil(quantityUsd * feeRate * trade.quoteSatsPerUsd)

  const markLinearTrade = (trade, price) => {
    const quantity = trade.remainingQuantityUsd ?? trade.quantityUsd
    const closingFee = linearFeeSats(trade, quantity)
    trade.markPrice = price
    trade.unrealizedPlSats = Math.round(linearGrossSats(trade, price, quantity) - closingFee)
    trade.plSats = Math.round(
      -(trade.openingFeeSats ?? 0) + (trade.realizedPlSats ?? 0) + trade.unrealizedPlSats
    )
  }

  const settleLinear = (trade, exitPrice, exitReason, at) => {
    const quantity = trade.remainingQuantityUsd ?? trade.quantityUsd
    const closingFee = linearFeeSats(trade, quantity)
    const gross = linearGrossSats(trade, exitPrice, quantity)
    trade.realizedPlSats = Math.round((trade.realizedPlSats ?? 0) + gross - closingFee)
    trade.closingFeeSats = (trade.closingFeeSats ?? 0) + closingFee
    store.balanceSats += trade.marginSats + Math.round(gross - closingFee)
    trade.marginSats = 0
    trade.remainingQuantityUsd = 0
    trade.unrealizedPlSats = 0
    trade.status = 'closed'
    trade.exitPrice = exitPrice
    trade.markPrice = exitPrice
    trade.plSats = Math.round(-(trade.openingFeeSats ?? 0) + trade.realizedPlSats)
    trade.closedAt = at
    trade.exitReason = exitReason
  }

  const takeLinearTp1 = (trade, at) => {
    if (trade.tp1Taken || !(trade.tp1 > 0)) return
    const quantity = Math.min(trade.remainingQuantityUsd, trade.quantityUsd / 2)
    const fraction = quantity / trade.quantityUsd
    const releasedMargin = Math.min(trade.marginSats, Math.round(trade.initialMarginSats * fraction))
    const closingFee = linearFeeSats(trade, quantity)
    const gross = linearGrossSats(trade, trade.tp1, quantity)
    store.balanceSats += releasedMargin + Math.round(gross - closingFee)
    trade.marginSats -= releasedMargin
    trade.remainingQuantityUsd -= quantity
    trade.realizedPlSats = Math.round((trade.realizedPlSats ?? 0) + gross - closingFee)
    trade.closingFeeSats = (trade.closingFeeSats ?? 0) + closingFee
    trade.tp1Taken = true
    trade.tp1TakenAt = at
  }

  const activateLinearLimitOrder = (order, at) => {
    const openingFee = linearFeeSats(order, order.quantityUsd)
    if (order.marginSats + openingFee > store.balanceSats) {
      order.status = 'cancelled'
      order.cancelledAt = at
      order.cancelReason = `margin and fee ${order.marginSats + openingFee} sats exceed paper balance ${store.balanceSats} sats at entry`
      return { activated: false, reason: order.cancelReason }
    }
    order.status = 'running'
    order.openedAt = at
    order.openingFeeSats = openingFee
    order.initialStop = order.stopLoss
    order.initialMarginSats = order.marginSats
    order.remainingQuantityUsd = order.quantityUsd
    order.realizedPlSats = 0
    order.unrealizedPlSats = 0
    order.tp1Taken = false
    store.balanceSats -= order.marginSats + openingFee
    return { activated: true }
  }

  /**
   * Charge every funding settlement up to `timeMs` against the positions that
   * were open when it happened.
   */
  const chargeCarryUpTo = (timeMs) => {
    for (const settlement of fundingSettlements) {
      if (settlement.time <= (store.lastFundingAt ?? Number.NEGATIVE_INFINITY)) continue
      if (settlement.time > timeMs) break
      for (const trade of running()) {
        if (trade.pricingModel === 'linear-usd') continue
        if ((trade.openedAt ?? 0) > settlement.time) continue
        trade.carryFeesSats =
          (trade.carryFeesSats ?? 0) +
          carryForSettlement({
            side: trade.side,
            quantityUsd: trade.quantityUsd,
            settlement,
            fallbackPrice: trade.entry,
          })
      }
      // Advance even with no open position. Otherwise a later position would
      // be charged for settlements that happened before it existed when the
      // paper executor is recreated on the next bot pass.
      store.lastFundingAt = settlement.time
    }
  }

  const settle = (trade, exitPrice, exitReason, at) => {
    const gross = pnlSats({ side: trade.side, entry: trade.entry, exit: exitPrice, quantityUsd: trade.quantityUsd })
    const closingFee = feeFor(trade.quantityUsd, exitPrice)
    const carry = Math.round(trade.carryFeesSats ?? 0)
    trade.status = 'closed'
    trade.exitPrice = exitPrice
    trade.closingFeeSats = closingFee
    trade.carryFeesSats = carry
    // Carry is a cost when positive, which is why it is subtracted: a long in a
    // positive-funding market pays to hold, and that is the whole point of
    // charging it.
    //
    // The OPENING fee belongs here too, and leaving it out flattered every
    // number built on `plSats`. It was charged to the balance at open, so the
    // equity curve was right — but the trade said it lost 658 sats when it had
    // really cost 715, and win rate, profit factor and average win were all
    // computed from the trade. Measured on 525 days: profit factor read 0.93
    // and the sum of trade P/L came to -7285 sats against an equity curve that
    // fell 20846. That 13561-sat gap WAS the opening fees.
    //
    // A trade's P/L is what the account felt, both sides of the spread
    // included. The balance adds the opening fee back because it was already
    // taken at open; without that the fee would be charged twice.
    trade.plSats = Math.round(gross - trade.openingFeeSats - closingFee - carry)
    trade.closedAt = at
    trade.exitReason = exitReason
    store.balanceSats += trade.marginSats + trade.openingFeeSats + trade.plSats
  }

  return {
    name: 'paper',
    live: false,
    store,

    getAccount: async () => {
      const marginUsedSats = running().reduce((sum, trade) => sum + trade.marginSats, 0)
      // Opening fees have already left balanceSats. Open P/L includes them for
      // display, so add each one back before applying the adjustment here or
      // the fee would be counted twice in equity.
      const unrealizedSats = running().reduce(
        (sum, trade) => sum + (trade.pricingModel === 'linear-usd'
          ? (trade.unrealizedPlSats ?? 0)
          : (Number.isFinite(trade.plSats) ? trade.plSats + (trade.openingFeeSats ?? 0) : 0)),
        0
      )
      return {
        balanceSats: store.balanceSats,
        marginUsedSats,
        equitySats: store.balanceSats + marginUsedSats + unrealizedSats,
        source: 'paper',
      }
    },

    listTrades: async () => {
      const takeProfitOrders = running()
        .filter((trade) => trade.pricingModel === 'linear-usd' && !trade.tp1Taken && Number.isFinite(trade.tp1))
        .map((trade) => ({
          id: `${trade.id}:tp1`,
          parentTradeId: trade.id,
          orderRole: 'take-profit',
          type: 'limit',
          status: 'open',
          side: trade.side === 'long' ? 'short' : 'long',
          quantityUsd: Math.min(trade.remainingQuantityUsd ?? trade.quantityUsd, trade.quantityUsd / 2),
          quotePrice: trade.tp1,
          entry: trade.tp1,
          takeProfit: trade.tp1,
          tp1: trade.tp1,
          tp2: trade.tp2 ?? null,
          createdAt: trade.openedAt ?? trade.createdAt,
          assetSymbol: trade.assetSymbol,
          timeframeId: trade.timeframeId,
          strategyId: trade.strategyId,
          source: 'paper',
        }))
      return {
        running: running(),
        // TP1 is represented as a separate protective paper limit so the
        // dashboard exposes the same 50% exit the marker will execute.
        open: [...store.trades.filter((trade) => trade.status === 'open'), ...takeProfitOrders],
        closed: store.trades.filter((trade) => trade.status === 'closed'),
      }
    },

    openPosition: async (plan) => {
      if (!(plan.stop > 0) || !(plan.takeProfit > 0)) {
        throw new Error('refusing to open a position without both a stop loss and a take profit')
      }
      if (plan.marginSats > store.balanceSats) {
        throw new Error(`margin ${plan.marginSats} sats exceeds paper balance ${store.balanceSats} sats`)
      }
      const linear = plan.pricingModel === 'linear-usd'
      const linearTp2 = linear ? validLinearTp2(plan) : null
      const openingFee = linear
        ? Math.ceil(plan.quantityUsd * feeRate * plan.quoteSatsPerUsd)
        : feeFor(plan.quantityUsd, plan.entry)
      if (plan.marginSats + openingFee > store.balanceSats) {
        throw new Error(`margin and fee ${plan.marginSats + openingFee} sats exceed paper balance ${store.balanceSats} sats`)
      }
      const trade = {
        id: `paper-${store.nextId++}`,
        side: plan.side,
        type: 'market',
        status: 'running',
        quantityUsd: plan.quantityUsd,
        marginSats: plan.marginSats,
        leverage: plan.leverage,
        entry: plan.entry,
        liquidation: plan.liquidation,
        stopLoss: plan.stop,
        initialStop: plan.stop,
        takeProfit: plan.takeProfit,
        exitPrice: null,
        plSats: null,
        openingFeeSats: openingFee,
        closingFeeSats: null,
        carryFeesSats: 0,
        openedAt: now(),
        createdAt: now(),
        closedAt: null,
        source: 'paper',
        ...(linear ? {
          pricingModel: 'linear-usd',
          assetSymbol: plan.assetSymbol,
          timeframeId: plan.timeframeId,
          strategyId: plan.strategyId,
          priceActionProtocol: plan.priceActionProtocol,
          signalKey: plan.signalKey,
          signalCandleTime: plan.signalCandleTime ?? null,
          quoteSatsPerUsd: plan.quoteSatsPerUsd,
          initialMarginSats: plan.marginSats,
          remainingQuantityUsd: plan.quantityUsd,
          realizedPlSats: 0,
          unrealizedPlSats: 0,
          tp1: plan.tp1,
          tp2: linearTp2,
          entryZone: plan.entryZone ?? null,
          tp1Taken: false,
          lastMarkedCandleTime: plan.signalCandleTime ?? null,
        } : {}),
      }
      store.balanceSats -= trade.marginSats + openingFee
      store.trades.push(trade)
      return trade
    },

    // PA-1 knows its entry, structural stop and both targets before price
    // returns to the FVG. Keep that instruction as a paper limit order instead
    // of pretending it is already an open market position.
    placeOrder: async (plan) => {
      if (plan.type !== 'limit') throw new Error('paper pending order must be a limit order')
      if (!(plan.entry > 0) || !(plan.stop > 0) || !(plan.takeProfit > 0)) {
        throw new Error('refusing to place a limit order without entry, stop loss and first take profit')
      }
      if (plan.pricingModel !== 'linear-usd') {
        throw new Error('paper pending orders currently support price-action linear contracts only')
      }
      const linearTp2 = validLinearTp2(plan)
      const order = {
        id: `paper-${store.nextId++}`,
        side: plan.side,
        type: 'limit',
        status: 'open',
        quantityUsd: plan.quantityUsd,
        marginSats: plan.marginSats,
        leverage: plan.leverage,
        entry: plan.entry,
        liquidation: plan.liquidation,
        stopLoss: plan.stop,
        initialStop: plan.stop,
        takeProfit: plan.takeProfit,
        tp1: plan.tp1,
        tp2: linearTp2,
        entryZone: plan.entryZone ?? null,
        exitPrice: null,
        plSats: null,
        openingFeeSats: null,
        closingFeeSats: null,
        carryFeesSats: 0,
        createdAt: now(),
        openedAt: null,
        closedAt: null,
        source: 'paper',
        pricingModel: 'linear-usd',
        assetSymbol: plan.assetSymbol,
        timeframeId: plan.timeframeId,
        strategyId: plan.strategyId,
        priceActionProtocol: plan.priceActionProtocol,
        signalKey: plan.signalKey,
        signalCandleTime: plan.signalCandleTime ?? null,
        quoteSatsPerUsd: plan.quoteSatsPerUsd,
        initialMarginSats: plan.marginSats,
        remainingQuantityUsd: plan.quantityUsd,
        realizedPlSats: 0,
        unrealizedPlSats: 0,
        tp1Taken: false,
        lastOrderCheckedCandleTime: plan.signalCandleTime ?? null,
        lastMarkedCandleTime: null,
        plan: plan.plan ?? null,
      }
      store.trades.push(order)
      return order
    },

    updateStops: async (id, { stopLoss, takeProfit } = {}) => {
      const trade = store.trades.find((candidate) => candidate.id === id)
      if (!trade) throw new Error(`unknown paper trade ${id}`)
      if (stopLoss > 0) trade.stopLoss = stopLoss
      if (takeProfit > 0) trade.takeProfit = takeProfit
      return [trade]
    },

    closePosition: async (id, price) => {
      const trade = store.trades.find((candidate) => candidate.id === id)
      if (!trade) throw new Error(`unknown paper trade ${id}`)
      if (trade.pricingModel === 'linear-usd') {
        settleLinear(trade, price ?? trade.markPrice ?? trade.entry, 'manual', now())
      } else {
        settle(trade, price ?? trade.stopLoss, 'manual', now())
      }
      return trade
    },

    cancelOrder: async (id) => {
      const trade = store.trades.find((candidate) => candidate.id === id)
      if (trade) trade.status = 'cancelled'
      return trade ?? null
    },

    /**
     * Walk candles forward and settle anything the market reached. Called with
     * the candles that closed since the previous pass.
     */
    mark: (candles) => {
      const settled = []
      for (const candle of candles) {
        // Carry first: a position pays for the hours it held before the candle
        // that closes it, not after.
        chargeCarryUpTo(candle.time)
        for (const trade of running()) {
          if (trade.pricingModel === 'linear-usd') continue
          if (trade.openedAt && candle.time < trade.openedAt) continue
          const hitStop =
            trade.side === 'long' ? candle.low <= trade.stopLoss : candle.high >= trade.stopLoss
          const hitTarget =
            trade.side === 'long' ? candle.high >= trade.takeProfit : candle.low <= trade.takeProfit
          if (hitStop) {
            settle(trade, trade.stopLoss, 'stop_loss', candle.time)
            settled.push(trade)
          } else if (hitTarget) {
            settle(trade, trade.takeProfit, 'take_profit', candle.time)
            settled.push(trade)
          } else {
            markTrade(trade, candle.close)
          }
        }
      }
      return settled
    },

    markPriceActionPositions: (matrix) => {
      const settled = []
      for (const trade of running().filter((candidate) => candidate.pricingModel === 'linear-usd')) {
        const asset = matrix?.assets?.find((candidate) => candidate.symbol === trade.assetSymbol)
        const item = asset?.trends?.[trade.timeframeId]
        const candles = item?.chartCandles ?? []
        const candleDuration = (TIMEFRAME_HOURS[trade.timeframeId] ?? 1) * HOUR_MS
        for (const candle of candles) {
          if (Number.isFinite(trade.lastMarkedCandleTime) && candle.time <= trade.lastMarkedCandleTime) continue
          trade.lastMarkedCandleTime = candle.time
          const closedAt = candle.time + candleDuration
          const hitStop = trade.side === 'long' ? candle.low <= trade.stopLoss : candle.high >= trade.stopLoss
          if (hitStop) {
            settleLinear(trade, trade.stopLoss, 'stop_loss', closedAt)
            settled.push(trade)
            break
          }
          const hitTp1 = !trade.tp1Taken && (trade.side === 'long'
            ? candle.high >= trade.tp1
            : candle.low <= trade.tp1)
          if (hitTp1) takeLinearTp1(trade, closedAt)
          const hitTp2 = Number.isFinite(trade.tp2) && (trade.side === 'long'
            ? candle.high >= trade.tp2
            : candle.low <= trade.tp2)
          if (hitTp2) {
            settleLinear(trade, trade.tp2, 'take_profit', closedAt)
            settled.push(trade)
            break
          }
          markLinearTrade(trade, candle.close)
        }
      }
      return settled
    },

    markPriceActionOrders: (matrix) => {
      const outcomes = []
      for (const order of store.trades.filter((candidate) => candidate.status === 'open' && candidate.pricingModel === 'linear-usd')) {
        const asset = matrix?.assets?.find((candidate) => candidate.symbol === order.assetSymbol)
        const item = asset?.trends?.[order.timeframeId]
        const candles = item?.chartCandles ?? []
        const candleDuration = (TIMEFRAME_HOURS[order.timeframeId] ?? 1) * HOUR_MS
        for (const candle of candles) {
          if (Number.isFinite(order.lastOrderCheckedCandleTime) && candle.time <= order.lastOrderCheckedCandleTime) continue
          order.lastOrderCheckedCandleTime = candle.time
          const hitEntry = order.side === 'long' ? candle.low <= order.entry : candle.high >= order.entry
          if (!hitEntry) continue
          const at = candle.time + candleDuration
          const result = activateLinearLimitOrder(order, at)
          if (result.activated) {
            // Let the normal position marker inspect this same candle for an
            // immediate protective exit. It resolves an unknowable OHLC order
            // conservatively because its stop check precedes target checks.
            order.lastMarkedCandleTime = candle.time - 1
            outcomes.push({ order, action: 'filled', at })
          } else {
            outcomes.push({ order, action: 'cancelled', reason: result.reason, at })
          }
          break
        }
      }
      return outcomes
    },
  }
}
