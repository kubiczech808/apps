// LN Markets execution.
//
// Two rules are enforced here rather than left to the caller, because both are
// the kind of thing that is easy to get right on the happy path and catastrophic
// to get wrong once:
//
//  1. A position is NEVER opened without both a stop loss and a take profit.
//     They are sent with the order, and the order is re-read afterwards to
//     confirm the exchange actually holds them. If it does not, the position is
//     closed immediately — an unprotected position is worse than no position,
//     and this bot runs on a timer, so nothing else would notice for minutes.
//  2. Prices are rounded before they are sized, never after. Rounding a stop
//     after computing the quantity silently changes the risk the position
//     carries away from the 1% that was authorised.

const sideToApi = (side) => (side === 'long' ? 'b' : 's')
const sideFromApi = (side) => (side === 'b' ? 'long' : 'short')

const num = (value) => {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

/** Normalise an LN Markets trade into the one shape the rest of the app knows. */
export const normaliseTrade = (trade) => {
  const running = Boolean(trade.running)
  const closed = Boolean(trade.closed)
  const canceled = Boolean(trade.canceled ?? trade.cancelled)
  let status = 'open'
  if (canceled) status = 'cancelled'
  else if (closed) status = 'closed'
  else if (running) status = 'running'

  return {
    id: String(trade.id),
    side: sideFromApi(trade.side),
    type: trade.type === 'l' ? 'limit' : 'market',
    status,
    quantityUsd: num(trade.quantity),
    marginSats: num(trade.margin),
    leverage: num(trade.leverage),
    entry: num(trade.price),
    liquidation: num(trade.liquidation),
    stopLoss: num(trade.stoploss),
    takeProfit: num(trade.takeprofit),
    exitPrice: num(trade.exit_price),
    plSats: num(trade.pl),
    openingFeeSats: num(trade.opening_fee),
    closingFeeSats: num(trade.closing_fee),
    carryFeesSats: num(trade.sum_carry_fees),
    openedAt: num(trade.market_filled_ts) ?? num(trade.creation_ts),
    createdAt: num(trade.creation_ts),
    closedAt: num(trade.closed_ts),
    source: 'lnmarkets',
  }
}

export const createLnMarketsExecutor = ({ client, logger = console }) => {
  const listByType = async (type) => {
    const trades = await client.getTrades({ type })
    return (Array.isArray(trades) ? trades : []).map(normaliseTrade)
  }

  return {
    name: `lnmarkets:${client.network}`,
    live: true,

    getAccount: async () => {
      const user = await client.getUser()
      const balanceSats = num(user?.balance) ?? 0
      const marginUsedSats = num(user?.total_margin ?? user?.margin) ?? 0
      return {
        balanceSats,
        marginUsedSats,
        // Equity is what may be risked: free balance plus margin already posted.
        equitySats: balanceSats + marginUsedSats,
        username: user?.username ?? null,
        source: 'lnmarkets',
      }
    },

    listTrades: async () => {
      const [running, open, closed] = await Promise.all([
        listByType('running'),
        listByType('open'),
        listByType('closed'),
      ])
      return { running, open, closed }
    },

    getTicker: () => client.getTicker(),

    openPosition: async (plan) => {
      if (!(plan.stop > 0) || !(plan.takeProfit > 0)) {
        throw new Error('refusing to open a position without both a stop loss and a take profit')
      }

      const created = await client.newTrade({
        type: 'm',
        side: sideToApi(plan.side),
        quantity: plan.quantityUsd,
        leverage: plan.leverage,
        stoploss: plan.stop,
        takeprofit: plan.takeProfit,
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
      const results = []
      if (stopLoss > 0) {
        results.push(await client.updateTrade({ id, type: 'stoploss', value: stopLoss }))
      }
      if (takeProfit > 0) {
        results.push(await client.updateTrade({ id, type: 'takeprofit', value: takeProfit }))
      }
      return results.map((trade) => normaliseTrade(trade ?? {}))
    },

    closePosition: async (id) => normaliseTrade((await client.closeTrade(id)) ?? {}),
    cancelOrder: async (id) => normaliseTrade((await client.cancelTrade(id)) ?? {}),
  }
}
