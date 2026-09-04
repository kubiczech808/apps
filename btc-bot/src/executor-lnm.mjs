// LN Markets execution (v3, isolated futures).
//
// Two rules are enforced here rather than left to the caller, because both are
// easy to get right on the happy path and catastrophic to get wrong once:
//
//  1. A position is NEVER opened without both a stop loss and a take profit.
//     They are sent with the order, and the response is checked to confirm the
//     exchange is actually holding them. If it is not, the position is closed
//     immediately — an unprotected position is worse than no position, and this
//     bot runs on a timer, so nothing else would notice for minutes.
//  2. Everything the rest of the app sees goes through `normaliseTrade`. The
//     API speaks 'buy'/'sell' and ISO timestamps; the app speaks long/short and
//     epoch milliseconds, in one place.

const sideToApi = (side) => (side === 'long' ? 'buy' : 'sell')
const sideFromApi = (side) => (side === 'buy' ? 'long' : 'short')

const num = (value) => {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

const millis = (value) => {
  if (value === null || value === undefined) return null
  const parsed = typeof value === 'number' ? value : Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

/** Normalise a v3 futures trade into the one shape the rest of the app knows. */
export const normaliseTrade = (trade = {}) => {
  let status = 'open'
  if (trade.canceled) status = 'cancelled'
  else if (trade.closed) status = 'closed'
  else if (trade.running) status = 'running'

  return {
    id: String(trade.id ?? ''),
    side: sideFromApi(trade.side),
    type: trade.type === 'limit' ? 'limit' : 'market',
    status,
    quantityUsd: num(trade.quantity),
    marginSats: num(trade.margin),
    leverage: num(trade.leverage),
    // `entryPrice` is what the trade actually filled at; `price` is what was
    // asked for. Reporting the requested price as the entry would misstate the
    // P/L of every trade that slipped.
    entry: num(trade.entryPrice) ?? num(trade.price),
    requestedPrice: num(trade.price),
    liquidation: num(trade.liquidation),
    stopLoss: num(trade.stoploss),
    takeProfit: num(trade.takeprofit),
    exitPrice: num(trade.exitPrice),
    plSats: num(trade.pl),
    openingFeeSats: num(trade.openingFee),
    closingFeeSats: num(trade.closingFee),
    carryFeesSats: num(trade.sumFundingFees),
    createdAt: millis(trade.createdAt),
    openedAt: millis(trade.filledAt) ?? millis(trade.createdAt),
    closedAt: millis(trade.closedAt),
    clientId: trade.clientId ?? null,
    source: 'lnmarkets',
  }
}

const asArray = (payload) => {
  if (Array.isArray(payload)) return payload
  if (Array.isArray(payload?.data)) return payload.data
  return []
}

export const createLnMarketsExecutor = ({ client, logger = console, closedLimit = 100 }) => {
  const listTrades = async () => {
    const [running, open, closed] = await Promise.all([
      client.getRunningTrades(),
      client.getOpenTrades(),
      client.getClosedTrades({ limit: closedLimit }),
    ])
    return {
      running: asArray(running).map(normaliseTrade),
      open: asArray(open).map(normaliseTrade),
      closed: asArray(closed).map(normaliseTrade),
    }
  }

  return {
    name: `lnmarkets:${client.network}`,
    live: true,

    getAccount: async () => {
      const [account, running] = await Promise.all([client.getAccount(), client.getRunningTrades()])
      const balanceSats = num(account?.balance) ?? 0
      // v3's account has no aggregate margin field, so it is summed from the
      // isolated trades that are actually holding it.
      const marginUsedSats = asArray(running).reduce((sum, trade) => sum + (num(trade.margin) ?? 0), 0)
      return {
        balanceSats,
        marginUsedSats,
        // Equity is what may be risked: free balance plus margin already posted.
        equitySats: balanceSats + marginUsedSats,
        username: account?.username ?? null,
        source: 'lnmarkets',
      }
    },

    listTrades,
    getTicker: () => client.getTicker(),

    openPosition: async (plan) => {
      if (!(plan.stop > 0) || !(plan.takeProfit > 0)) {
        throw new Error('refusing to open a position without both a stop loss and a take profit')
      }

      const created = await client.newTrade({
        type: 'market',
        side: sideToApi(plan.side),
        quantity: plan.quantityUsd,
        leverage: plan.leverage,
        stoploss: plan.stop,
        takeprofit: plan.takeProfit,
        clientId: `btcbot-${Date.now()}`,
      })

      const position = normaliseTrade(created ?? {})

      // Confirm the exchange is holding both brackets. A trade that came back
      // without them is unprotected, and the next chance to notice would be the
      // next timer tick.
      if (!(position.stopLoss > 0) || !(position.takeProfit > 0)) {
        logger.error(
          `LN Markets accepted trade ${position.id} without brackets (sl=${position.stopLoss}, tp=${position.takeProfit}); closing it immediately`
        )
        try {
          await client.closeTrade(position.id)
        } catch (error) {
          logger.error(`Emergency close of unprotected trade ${position.id} FAILED: ${error.message}`)
          throw new Error(
            `trade ${position.id} is open WITHOUT protective orders and could not be closed: ${error.message}`
          )
        }
        throw new Error(`trade ${position.id} was opened without protective orders and has been closed again`)
      }

      return position
    },

    updateStops: async (id, { stopLoss, takeProfit } = {}) => {
      const updated = []
      if (stopLoss > 0) updated.push(normaliseTrade((await client.updateStopLoss(id, stopLoss)) ?? {}))
      if (takeProfit > 0) updated.push(normaliseTrade((await client.updateTakeProfit(id, takeProfit)) ?? {}))
      return updated
    },

    closePosition: async (id) => normaliseTrade((await client.closeTrade(id)) ?? {}),
    cancelOrder: async (id) => normaliseTrade((await client.cancelTrade(id)) ?? {}),
  }
}
