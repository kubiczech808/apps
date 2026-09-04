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

import { pnlSats, SATS_PER_BTC } from './risk.mjs'

export const createPaperExecutor = ({ store, feeRate = 0.0006, now = () => Date.now() }) => {
  store.trades ??= []
  store.balanceSats ??= 0
  store.nextId ??= 1

  const running = () => store.trades.filter((trade) => trade.status === 'running')

  const feeFor = (quantityUsd, price) => Math.ceil(((quantityUsd * SATS_PER_BTC) / price) * feeRate)

  const settle = (trade, exitPrice, exitReason, at) => {
    const gross = pnlSats({ side: trade.side, entry: trade.entry, exit: exitPrice, quantityUsd: trade.quantityUsd })
    const closingFee = feeFor(trade.quantityUsd, exitPrice)
    trade.status = 'closed'
    trade.exitPrice = exitPrice
    trade.closingFeeSats = closingFee
    trade.plSats = Math.round(gross - closingFee)
    trade.closedAt = at
    trade.exitReason = exitReason
    store.balanceSats += trade.marginSats + trade.plSats
  }

  return {
    name: 'paper',
    live: false,
    store,

    getAccount: async () => {
      const marginUsedSats = running().reduce((sum, trade) => sum + trade.marginSats, 0)
      return {
        balanceSats: store.balanceSats,
        marginUsedSats,
        equitySats: store.balanceSats + marginUsedSats,
        source: 'paper',
      }
    },

    listTrades: async () => ({
      running: running(),
      open: store.trades.filter((trade) => trade.status === 'open'),
      closed: store.trades.filter((trade) => trade.status === 'closed'),
    }),

    openPosition: async (plan) => {
      if (!(plan.stop > 0) || !(plan.takeProfit > 0)) {
        throw new Error('refusing to open a position without both a stop loss and a take profit')
      }
      if (plan.marginSats > store.balanceSats) {
        throw new Error(`margin ${plan.marginSats} sats exceeds paper balance ${store.balanceSats} sats`)
      }
      const openingFee = feeFor(plan.quantityUsd, plan.entry)
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
        openedAt: now(),
        createdAt: now(),
        closedAt: null,
        source: 'paper',
      }
      store.balanceSats -= trade.marginSats + openingFee
      store.trades.push(trade)
      return trade
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
      settle(trade, price ?? trade.stopLoss, 'manual', now())
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
        for (const trade of running()) {
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
          }
        }
      }
      return settled
    },
  }
}
