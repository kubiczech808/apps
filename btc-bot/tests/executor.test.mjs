import assert from 'node:assert/strict'
import test from 'node:test'
import { createLnMarketsExecutor, normaliseTrade } from '../src/executor-lnm.mjs'
import { createPaperExecutor } from '../src/executor-paper.mjs'
import { fetchLnMarketsCandles } from '../src/candles.mjs'
import { pnlSats } from '../src/risk.mjs'
import { candle, HOUR, START } from './helpers.mjs'

const silent = { info() {}, warn() {}, error() {} }

test('paper executor marks an FX trade on its own candles and takes TP1 before TP2', async () => {
  const store = { balanceSats: 1_000_000, trades: [], nextId: 1 }
  const executor = createPaperExecutor({ store, feeRate: 0.0006, now: () => START + 10 * HOUR })
  const trade = await executor.openPosition({
    pricingModel: 'linear-usd',
    strategyId: 'price-action-structure-v1',
    assetSymbol: 'AUDUSD',
    timeframeId: '4h',
    signalKey: 'aud-setup',
    signalCandleTime: START,
    side: 'long',
    entry: 0.71,
    stop: 0.70,
    takeProfit: 0.74,
    tp1: 0.72,
    tp2: 0.74,
    quantityUsd: 100,
    marginSats: 25_000,
    leverage: 4,
    liquidation: 0.5325,
    quoteSatsPerUsd: 1250,
  })
  const openingFeeSats = trade.openingFeeSats
  executor.markPriceActionPositions({
    assets: [{ symbol: 'AUDUSD', trends: { '4h': { chartCandles: [
      candle(START, 0.71, 0.715, 0.708, 0.712),
      candle(START + 4 * HOUR, 0.712, 0.725, 0.711, 0.721),
    ] } } }],
  })
  assert.equal(trade.status, 'running')
  assert.equal(trade.tp1Taken, true)
  assert.equal(trade.remainingQuantityUsd, 50)
  assert.ok(trade.marginSats < trade.initialMarginSats)
  const firstExit = (await executor.listTrades()).closed.find((candidate) => candidate.parentTradeId === trade.id)
  assert.ok(firstExit, 'TP1 must be visible as a closed half-position while its parent remains open')
  assert.equal(firstExit.partialExit, true)
  assert.equal(firstExit.exitReason, 'take_profit_1')
  assert.equal(firstExit.quantityUsd, 50)
  assert.equal(firstExit.exitPrice, 0.72)
  const firstGross = 50 * ((0.72 - 0.71) / 0.71) * 1250
  assert.equal(firstExit.plSats, Math.round(firstGross - firstExit.openingFeeSats - firstExit.closingFeeSats))
  const firstGrossUsd = 50 * ((0.72 - 0.71) / 0.71)
  assert.ok(Math.abs(firstExit.plUsd - (firstGrossUsd - 50 * 0.0006 * 2)) < 1e-12)
  assert.ok(firstExit.openingFeeUsd > 0 && firstExit.closingFeeUsd > 0)
  assert.equal(firstExit.openingFeeSats + trade.openingFeeSats, openingFeeSats)
  assert.equal(trade.realizedPlSats, 0, 'the open half must not carry the already-closed TP1 P/L')

  executor.markPriceActionPositions({
    assets: [{ symbol: 'AUDUSD', trends: { '4h': { chartCandles: [
      candle(START + 8 * HOUR, 0.721, 0.742, 0.720, 0.74),
    ] } } }],
  })
  assert.equal(trade.status, 'closed')
  assert.equal(trade.exitReason, 'take_profit')
  assert.ok(trade.plSats > 0)
  assert.ok(store.balanceSats > 1_000_000)
  const closedLegs = (await executor.listTrades()).closed.filter((candidate) => candidate.id === trade.id || candidate.parentTradeId === trade.id)
  assert.equal(closedLegs.length, 2)
  assert.equal(closedLegs.reduce((sum, candidate) => sum + candidate.plSats, 0), store.balanceSats - 1_000_000)
})

test('a PA position can take TP1 only and leave its second half open for structure management', async () => {
  const store = { balanceSats: 1_000_000, trades: [], nextId: 1 }
  const executor = createPaperExecutor({ store, feeRate: 0.0006, now: () => START })
  const trade = await executor.openPosition({
    pricingModel: 'linear-usd', strategyId: 'price-action-structure-v1', assetSymbol: 'USDJPY', timeframeId: '1h',
    signalKey: 'jpy-tp1-only', signalCandleTime: START, side: 'short', entry: 159.711, stop: 160.426,
    takeProfit: 152.881, tp1: 152.881, tp2: null, quantityUsd: 100, marginSats: 25_000,
    leverage: 4, liquidation: 199.63875, quoteSatsPerUsd: 500,
  })

  executor.markPriceActionPositions({
    assets: [{ symbol: 'USDJPY', trends: { '1h': { chartCandles: [
      candle(START + HOUR, 159, 159.1, 152.8, 153),
      candle(START + 2 * HOUR, 153, 154, 152.5, 153.5),
    ] } } }],
  })

  assert.equal(trade.tp1Taken, true)
  assert.equal(trade.tp2, null)
  assert.equal(trade.remainingQuantityUsd, 50)
  assert.equal(trade.status, 'running')
})

test('paper executor preserves the semantic reason for a strategy-driven close', async () => {
  const store = { balanceSats: 1_000_000, trades: [], nextId: 1 }
  const executor = createPaperExecutor({ store, now: () => START })
  const trade = await executor.openPosition({
    pricingModel: 'linear-usd', strategyId: 'price-action-structure-v1', assetSymbol: 'AUDUSD', timeframeId: '1h',
    signalKey: 'reason-test', signalCandleTime: START, side: 'long', entry: 0.71, stop: 0.70,
    takeProfit: 0.74, tp1: 0.72, tp2: 0.74, quantityUsd: 100, marginSats: 25_000,
    leverage: 4, liquidation: 0.5325, quoteSatsPerUsd: 1250,
  })

  await executor.closePosition(trade.id, 0.71, 'structure_invalidation')
  assert.equal(trade.exitReason, 'structure_invalidation')
})

test('paper executor rejects a duplicate TP2 and leaves the second half to structure', async () => {
  const store = { balanceSats: 1_000_000, trades: [], nextId: 1 }
  const executor = createPaperExecutor({ store, feeRate: 0.0006, now: () => START })
  const trade = await executor.openPosition({
    pricingModel: 'linear-usd', strategyId: 'price-action-structure-v1', assetSymbol: 'AUDUSD', timeframeId: '1h',
    signalKey: 'aud-no-duplicate-tp2', signalCandleTime: START, side: 'short', entry: 0.7124, stop: 0.7145,
    takeProfit: 0.7080, tp1: 0.7080, tp2: 0.7080, quantityUsd: 100, marginSats: 25_000,
    leverage: 4, liquidation: 0.8905, quoteSatsPerUsd: 1250,
  })

  assert.equal(trade.tp1, 0.7080)
  assert.equal(trade.tp2, null)
})

test('paper executor may add a valid distant TP2 to an open PA position', async () => {
  const store = { balanceSats: 1_000_000, trades: [], nextId: 1 }
  const executor = createPaperExecutor({ store, feeRate: 0.0006, now: () => START })
  const trade = await executor.openPosition({
    pricingModel: 'linear-usd', strategyId: 'price-action-structure-v1', assetSymbol: 'AUDUSD', timeframeId: '1h',
    signalKey: 'aud-backfill-tp2', signalCandleTime: START, side: 'short', entry: 0.7124, stop: 0.7145,
    takeProfit: 0.7080, tp1: 0.7080, tp2: null, quantityUsd: 100, marginSats: 25_000,
    leverage: 4, liquidation: 0.8905, quoteSatsPerUsd: 1250,
  })

  const updated = await executor.setPriceActionTp2(trade.id, 0.7012)
  assert.equal(updated.tp2, 0.7012)
  assert.equal(updated.takeProfit, 0.7012)
  assert.equal(await executor.setPriceActionTp2(trade.id, 0.7090), null, 'a nearer target must be refused')
  assert.equal(trade.tp2, 0.7012)
})

test('a live PA position exposes its first take-profit as a half-size paper order', async () => {
  const store = { balanceSats: 1_000_000, trades: [], nextId: 1 }
  const executor = createPaperExecutor({ store, feeRate: 0.0006, now: () => START })
  const trade = await executor.openPosition({
    pricingModel: 'linear-usd', strategyId: 'price-action-structure-v1', assetSymbol: 'AUDUSD', timeframeId: '4h',
    signalKey: 'aud-visible-tp1', signalCandleTime: START, side: 'long', entry: 0.71, stop: 0.70,
    takeProfit: 0.74, tp1: 0.72, tp2: 0.74, quantityUsd: 100, marginSats: 25_000,
    leverage: 4, liquidation: 0.5325, quoteSatsPerUsd: 1250,
  })

  let listed = await executor.listTrades()
  const tpOrder = listed.open.find((order) => order.parentTradeId === trade.id && order.orderRole === 'take-profit')
  assert.equal(tpOrder.quotePrice, 0.72)
  assert.equal(tpOrder.quantityUsd, 50)

  executor.markPriceActionPositions({
    assets: [{ symbol: 'AUDUSD', trends: { '4h': { chartCandles: [
      candle(START + 4 * HOUR, 0.71, 0.721, 0.708, 0.72),
    ] } } }],
  })

  listed = await executor.listTrades()
  assert.equal(listed.open.some((order) => order.parentTradeId === trade.id && order.orderRole === 'take-profit'), false)
})

test('a paper PA limit order keeps capital free until entry, then becomes a protected position', async () => {
  const store = { balanceSats: 1_000_000, trades: [], nextId: 1 }
  const executor = createPaperExecutor({ store, feeRate: 0.0006, now: () => START })
  const order = await executor.placeOrder({
    type: 'limit', pricingModel: 'linear-usd', strategyId: 'price-action-structure-v1',
    assetSymbol: 'AUDUSD', timeframeId: '1h', signalKey: 'aud-pending', signalCandleTime: START,
    side: 'long', entry: 0.71, stop: 0.70, takeProfit: 0.74, tp1: 0.72, tp2: 0.74,
    entryZone: { type: 'demand', low: 0.709, high: 0.711 },
    tp2Zone: { type: 'supply', low: 0.739, high: 0.741 },
    quantityUsd: 100, marginSats: 25_000, leverage: 4, liquidation: 0.5325, quoteSatsPerUsd: 1250,
  })
  assert.equal(order.status, 'open')
  assert.equal(store.balanceSats, 1_000_000)
  assert.deepEqual(order.entryZone, { type: 'demand', low: 0.709, high: 0.711 })
  assert.deepEqual(order.tp2Zone, { type: 'supply', low: 0.739, high: 0.741 })

  executor.markPriceActionOrders({
    assets: [{ symbol: 'AUDUSD', trends: { '1h': { chartCandles: [
      candle(START + HOUR, 0.72, 0.725, 0.715, 0.72),
      candle(START + 2 * HOUR, 0.72, 0.713, 0.709, 0.711),
    ] } } }],
  })
  assert.equal(order.status, 'running')
  assert.equal(order.type, 'limit')
  assert.equal(order.stopLoss, 0.70)
  assert.equal(order.tp1, 0.72)
  assert.equal(order.tp2, 0.74)
  assert.deepEqual(order.entryZone, { type: 'demand', low: 0.709, high: 0.711 })
  assert.deepEqual(order.tp2Zone, { type: 'supply', low: 0.739, high: 0.741 })
  assert.ok(store.balanceSats < 1_000_000)
})

test('a paper PA order records bid/ask-adjusted fills and cannot take profit before the executable bid reaches it', async () => {
  const store = { balanceSats: 1_000_000, trades: [], nextId: 1 }
  const executor = createPaperExecutor({ store, feeRate: 0.0006, now: () => START })
  const order = await executor.placeOrder({
    type: 'limit', pricingModel: 'linear-usd', strategyId: 'price-action-structure-v1',
    assetSymbol: 'AUDUSD', timeframeId: '1h', signalKey: 'aud-spread', signalCandleTime: START,
    side: 'long', entry: 0.71, entryFill: 0.710071, stop: 0.70, takeProfit: 0.74, tp1: 0.72, tp2: 0.74,
    quantityUsd: 1, marginSats: 1_250, leverage: 1, liquidation: 0, quoteSatsPerUsd: 1_250,
    capitalUsd: 1.0006, riskUsd: 0.02, spreadBps: 2,
  })

  executor.markPriceActionOrders({
    assets: [{ symbol: 'AUDUSD', trends: { '1h': { chartCandles: [
      candle(START + HOUR, 0.712, 0.713, 0.7098, 0.711),
    ] } } }],
  })
  assert.equal(order.status, 'running')
  assert.equal(order.requestedEntry, 0.71)
  assert.equal(order.entry, 0.710071)

  executor.markPriceActionPositions({
    assets: [{ symbol: 'AUDUSD', trends: { '1h': { chartCandles: [
      candle(START + 2 * HOUR, 0.711, 0.72005, 0.7105, 0.719),
    ] } } }],
  })
  assert.equal(order.tp1Taken, false, 'the bid remains below the raw target after spread')

  executor.markPriceActionPositions({
    assets: [{ symbol: 'AUDUSD', trends: { '1h': { chartCandles: [
      candle(START + 3 * HOUR, 0.719, 0.7202, 0.718, 0.72),
    ] } } }],
  })
  assert.equal(order.tp1Taken, true)
})

test('a legacy oversized paper PA position is rebased to the spot capital limit without moving its brackets', async () => {
  const store = { balanceSats: 1_000_000, trades: [], nextId: 1 }
  const executor = createPaperExecutor({ store, feeRate: 0.0006, now: () => START })
  const trade = await executor.openPosition({
    pricingModel: 'linear-usd', strategyId: 'price-action-structure-v1', assetSymbol: 'USDJPY', timeframeId: '1h',
    signalKey: 'legacy-size', signalCandleTime: START, side: 'short', entry: 157.425, stop: 157.5975,
    takeProfit: 156.112, tp1: 156.976, tp2: 156.112, quantityUsd: 104.24, marginSats: 125_570,
    leverage: 1, liquidation: 314.85, quoteSatsPerUsd: 1_204.623344,
  })
  executor.markPriceActionPositions({
    assets: [{ symbol: 'USDJPY', trends: { '1h': { chartCandles: [
      candle(START + HOUR, 157.3, 157.4, 156.9, 157.1),
    ] } } }],
  })
  assert.equal(trade.tp1Taken, true)
  assert.equal(trade.remainingQuantityUsd, 52.12)
  // Recreate the old persisted form: TP1 had affected the parent's ledger,
  // but no independently visible closed exit had been stored.
  const legacyTp1 = trade.partialExits[0]
  trade.partialExits = []
  trade.openingFeeSats += legacyTp1.openingFeeSats
  trade.closingFeeSats += legacyTp1.closingFeeSats
  trade.realizedPlSats = legacyTp1.plSats + legacyTp1.openingFeeSats

  const updated = await executor.rebasePriceActionPosition(trade.id, {
    quantityUsd: 1,
    marginSats: 1_205,
    quoteSatsPerUsd: 1_204.623344,
    entry: 157.425,
    entryFill: 157.4092575,
    stop: 157.5975,
    stopFill: 157.61325975,
    takeProfit: 156.112,
    takeProfitFill: 156.1276112,
    capitalUsd: 1.0006,
    riskUsd: 0.002,
    spreadBps: 2,
    leverage: 1,
    liquidation: 314.818515,
  })

  assert.equal(updated.quantityUsd, 1)
  assert.equal(updated.remainingQuantityUsd, 0.5)
  assert.equal(updated.marginSats, 603)
  assert.equal(updated.capitalUsd, 1.0006)
  assert.equal(updated.riskUsd, 0.002)
  assert.equal(updated.spreadBps, 2)
  assert.equal(updated.stopLoss, 157.5975)
  assert.equal(updated.tp1, 156.976)
  assert.equal(updated.tp2, 156.112)
  assert.equal(updated.sizeBeforeRebase.quantityUsd, 104.24)
  assert.ok(Number.isFinite(updated.plSats))
  const exits = await executor.materializePriceActionPartialExits()
  assert.equal(exits.length, 1)
  assert.equal(exits[0].id, `${trade.id}:tp1`)
  assert.equal(exits[0].quantityUsd, 0.5)
  assert.equal(exits[0].exitReason, 'take_profit_1')
  assert.equal(updated.realizedPlSats, 0)
  assert.equal((await executor.listTrades()).closed.filter((candidate) => candidate.parentTradeId === trade.id).length, 1)
  assert.deepEqual(await executor.materializePriceActionPartialExits(), [], 'the legacy repair must remain idempotent')
})

const stubClient = (overrides = {}) => ({
  network: 'testnet4',
  getAccount: async () => ({ balance: 100_000, username: 'tester' }),
  getRunningTrades: async () => [{ id: 'R1', margin: 5_000, running: true, side: 'buy' }],
  getOpenTrades: async () => [],
  getClosedTrades: async () => ({ data: [], nextCursor: null }),
  newTrade: async (data) => ({
    id: 'X1',
    side: data.side,
    type: data.type,
    running: true,
    quantity: data.quantity,
    leverage: data.leverage,
    entryPrice: 100_000,
    price: 100_000,
    stoploss: data.stoploss,
    takeprofit: data.takeprofit,
  }),
  updateStopLoss: async () => ({}),
  updateTakeProfit: async () => ({}),
  closeTrade: async () => ({}),
  cancelTrade: async () => ({}),
  ...overrides,
})

test('v3 trade fields map onto the app shape, including side, status and fill price', () => {
  const normalised = normaliseTrade({
    id: '7',
    side: 'sell',
    type: 'limit',
    running: false,
    closed: false,
    canceled: false,
    quantity: 50,
    margin: 4321,
    leverage: 8,
    price: 99_000,
    entryPrice: 98_950,
    stoploss: 101_000,
    takeprofit: 93_000,
    createdAt: '2026-09-04T10:00:00.000Z',
    filledAt: null,
    closedAt: null,
  })
  assert.equal(normalised.id, '7')
  assert.equal(normalised.side, 'short')
  assert.equal(normalised.type, 'limit')
  assert.equal(normalised.status, 'open')
  assert.equal(normalised.stopLoss, 101_000)
  // The fill price, not the requested one: reporting the request as the entry
  // would misstate the P/L of every trade that slipped.
  assert.equal(normalised.entry, 98_950)
  assert.equal(normalised.requestedPrice, 99_000)
  assert.equal(normalised.createdAt, Date.parse('2026-09-04T10:00:00.000Z'))
})

test('a closed trade keeps its exit price and closing timestamp', () => {
  const normalised = normaliseTrade({
    id: '9',
    side: 'buy',
    type: 'market',
    running: false,
    closed: true,
    canceled: false,
    entryPrice: 100_000,
    exitPrice: 104_000,
    pl: 3846,
    closedAt: '2026-09-04T12:00:00.000Z',
    filledAt: '2026-09-04T10:00:00.000Z',
  })
  assert.equal(normalised.status, 'closed')
  assert.equal(normalised.exitPrice, 104_000)
  assert.equal(normalised.plSats, 3846)
  assert.ok(normalised.closedAt > normalised.openedAt)
})

test('equity counts margin posted by isolated trades, which v3 does not aggregate', async () => {
  const executor = createLnMarketsExecutor({ client: stubClient(), logger: silent })
  const account = await executor.getAccount()
  assert.equal(account.balanceSats, 100_000)
  assert.equal(account.marginUsedSats, 5_000)
  assert.equal(account.equitySats, 105_000)
})

test('closed trades are read out of the paginated envelope', async () => {
  const executor = createLnMarketsExecutor({
    client: stubClient({
      getClosedTrades: async () => ({
        data: [{ id: 'C1', side: 'buy', closed: true, pl: 100, exitPrice: 1, closedAt: '2026-09-04T12:00:00Z' }],
        nextCursor: null,
      }),
    }),
    logger: silent,
  })
  const { closed } = await executor.listTrades()
  assert.equal(closed.length, 1)
  assert.equal(closed[0].id, 'C1')
})

test('a position is never sent without both brackets', async () => {
  const executor = createLnMarketsExecutor({ client: stubClient(), logger: silent })
  await assert.rejects(
    () => executor.openPosition({ side: 'long', quantityUsd: 10, leverage: 5, stop: 0, takeProfit: 110_000 }),
    /without both a stop loss and a take profit/
  )
})

test('a trade the exchange returns unbracketed is closed again immediately', async () => {
  const closed = []
  const client = stubClient({
    newTrade: async () => ({ id: 'BAD', side: 'buy', running: true, quantity: 10, entryPrice: 100_000 }),
    closeTrade: async (id) => {
      closed.push(id)
      return { id, closed: true }
    },
  })
  const executor = createLnMarketsExecutor({ client, logger: silent })

  await assert.rejects(
    () => executor.openPosition({ side: 'long', quantityUsd: 10, leverage: 5, stop: 98_000, takeProfit: 104_000 }),
    /opened without protective orders and has been closed again/
  )
  assert.deepEqual(closed, ['BAD'])
})

test('an unprotected trade that cannot be closed is reported as exactly that', async () => {
  const client = stubClient({
    newTrade: async () => ({ id: 'STUCK', side: 'buy', running: true, quantity: 10, entryPrice: 100_000 }),
    closeTrade: async () => {
      throw new Error('exchange unavailable')
    },
  })
  const executor = createLnMarketsExecutor({ client, logger: silent })
  await assert.rejects(
    () => executor.openPosition({ side: 'long', quantityUsd: 10, leverage: 5, stop: 98_000, takeProfit: 104_000 }),
    /open WITHOUT protective orders and could not be closed/
  )
})

test('paper positions settle at the stop when one candle touches both brackets', async () => {
  const store = { balanceSats: 1_000_000, trades: [], nextId: 1 }
  const executor = createPaperExecutor({ store, now: () => START })
  await executor.openPosition({
    side: 'long',
    entry: 100_000,
    stop: 98_000,
    takeProfit: 104_000,
    quantityUsd: 50,
    marginSats: 5_000,
    leverage: 10,
  })

  executor.mark([candle(START + HOUR, 100_000, 105_000, 97_000, 99_000)])

  const { closed } = await executor.listTrades()
  assert.equal(closed.length, 1)
  assert.equal(closed[0].exitReason, 'stop_loss')
  assert.ok(closed[0].plSats < 0)
})

test('a paper win credits the margin back plus the profit, minus both fees', async () => {
  const store = { balanceSats: 1_000_000, trades: [], nextId: 1 }
  const executor = createPaperExecutor({ store, now: () => START })
  const opened = await executor.openPosition({
    side: 'long',
    entry: 100_000,
    stop: 98_000,
    takeProfit: 104_000,
    quantityUsd: 50,
    marginSats: 5_000,
    leverage: 10,
  })
  const afterOpen = store.balanceSats

  executor.mark([candle(START + HOUR, 100_500, 104_500, 100_100, 104_200)])

  assert.equal(opened.exitReason, 'take_profit')
  assert.ok(opened.plSats > 0)
  assert.equal(store.balanceSats, afterOpen + opened.marginSats + opened.openingFeeSats + opened.plSats)
  // The property that matters, and the one that was broken: a round trip
  // leaves the balance exactly the trade's P/L away from where it started. It
  // did not, because the opening fee was taken from the balance and left out
  // of plSats — so the equity curve fell further than the trades explained.
  assert.equal(store.balanceSats, 1_000_000 + opened.plSats)
})

test('paper refuses a position it cannot fund', async () => {
  const store = { balanceSats: 100, trades: [], nextId: 1 }
  const executor = createPaperExecutor({ store, now: () => START })
  await assert.rejects(
    () =>
      executor.openPosition({
        side: 'long',
        entry: 100_000,
        stop: 98_000,
        takeProfit: 104_000,
        quantityUsd: 50,
        marginSats: 5_000,
        leverage: 10,
      }),
    /exceeds paper balance/
  )
})

test('LN Markets candles are read out of the paginated envelope and sorted', async () => {
  const client = {
    getCandles: async () => ({
      data: [
        { time: '2026-09-04T11:00:00.000Z', open: 3, high: 4, low: 2, close: 3.5, volume: 9 },
        { time: '2026-09-04T10:00:00.000Z', open: 1, high: 2, low: 0.5, close: 1.5, volume: 7 },
      ],
      nextCursor: null,
    }),
  }
  const candles = await fetchLnMarketsCandles({ client, limit: 10 })
  assert.equal(candles.length, 2)
  assert.ok(candles[0].time < candles[1].time)
  assert.equal(candles[0].open, 1)
  assert.equal(candles[1].close, 3.5)
})

test('a rejected date encoding is retried once as epoch milliseconds', async () => {
  const seen = []
  const client = {
    getCandles: async ({ from }) => {
      seen.push(from)
      if (seen.length === 1) {
        const error = new Error('bad request')
        error.status = 400
        throw error
      }
      return { data: [{ time: 1_760_000_000_000, open: 1, high: 2, low: 0.5, close: 1.5, volume: 1 }] }
    },
  }

  const candles = await fetchLnMarketsCandles({ client, limit: 10 })
  assert.equal(seen.length, 2)
  assert.match(seen[0], /^\d{4}-\d{2}-\d{2}T/, 'ISO 8601 is tried first')
  assert.match(seen[1], /^\d+$/, 'then epoch milliseconds')
  assert.equal(candles.length, 1)
})

test('an error that is not about the date encoding is not retried', async () => {
  let calls = 0
  const client = {
    getCandles: async () => {
      calls += 1
      const error = new Error('unauthorized')
      error.status = 401
      throw error
    },
  }
  await assert.rejects(() => fetchLnMarketsCandles({ client, limit: 10 }), /unauthorized/)
  assert.equal(calls, 1)
})

test('carry is charged against a held position, and a long pays positive funding', async () => {
  const store = { balanceSats: 1_000_000, trades: [], nextId: 1 }
  const settlement = { time: START + HOUR / 2, fundingRate: 0.0001, fixingPrice: 100_000 }
  const executor = createPaperExecutor({
    store,
    now: () => START,
    fundingSettlements: [settlement],
  })
  const opened = await executor.openPosition({
    side: 'long',
    entry: 100_000,
    stop: 98_000,
    takeProfit: 104_000,
    quantityUsd: 100,
    marginSats: 10_000,
    leverage: 10,
  })

  executor.mark([candle(START + HOUR, 100_500, 104_500, 100_100, 104_200)])

  // 100 USD at 100k is 100,000 sats of notional; 0.01% of that is 10 sats.
  assert.equal(opened.carryFeesSats, 10)
  assert.equal(opened.exitReason, 'take_profit')

  const gross = pnlSats({ side: 'long', entry: 100_000, exit: 104_000, quantityUsd: 100 })
  assert.equal(opened.plSats, Math.round(gross - opened.openingFeeSats - opened.closingFeeSats - 10))
})

test('a short is paid the same funding a long pays', async () => {
  const settlement = { time: START + HOUR / 2, fundingRate: 0.0001, fixingPrice: 100_000 }
  const store = { balanceSats: 1_000_000, trades: [], nextId: 1 }
  const executor = createPaperExecutor({ store, now: () => START, fundingSettlements: [settlement] })
  const opened = await executor.openPosition({
    side: 'short',
    entry: 100_000,
    stop: 102_000,
    takeProfit: 96_000,
    quantityUsd: 100,
    marginSats: 10_000,
    leverage: 10,
  })

  executor.mark([candle(START + HOUR, 99_500, 99_900, 95_000, 96_000)])
  assert.equal(opened.carryFeesSats, -10, 'a short receives what a long pays')
})

test('a position opened after a settlement is not charged for it', async () => {
  const settlement = { time: START - HOUR, fundingRate: 0.001, fixingPrice: 100_000 }
  const store = { balanceSats: 1_000_000, trades: [], nextId: 1 }
  const executor = createPaperExecutor({ store, now: () => START, fundingSettlements: [settlement] })
  const opened = await executor.openPosition({
    side: 'long',
    entry: 100_000,
    stop: 98_000,
    takeProfit: 104_000,
    quantityUsd: 100,
    marginSats: 10_000,
    leverage: 10,
  })
  executor.mark([candle(START + HOUR, 100_500, 104_500, 100_100, 104_200)])
  assert.equal(opened.carryFeesSats, 0)
})

test('recreating the paper executor does not charge the same funding twice', async () => {
  const first = { time: START + HOUR / 2, fundingRate: 0.0001, fixingPrice: 100_000 }
  const second = { time: START + HOUR * 1.5, fundingRate: 0.0001, fixingPrice: 100_000 }
  const store = { balanceSats: 1_000_000, trades: [], nextId: 1 }
  let executor = createPaperExecutor({ store, now: () => START, fundingSettlements: [first] })
  const opened = await executor.openPosition({
    side: 'long',
    entry: 100_000,
    stop: 90_000,
    takeProfit: 120_000,
    quantityUsd: 100,
    marginSats: 10_000,
    leverage: 5,
  })
  executor.mark([candle(START + HOUR, 100_000, 101_000, 99_000, 100_000)])

  executor = createPaperExecutor({ store, now: () => START + HOUR, fundingSettlements: [first, second] })
  executor.mark([candle(START + 2 * HOUR, 100_000, 101_000, 99_000, 100_000)])

  assert.equal(opened.carryFeesSats, 20)
  assert.equal(store.lastFundingAt, second.time)
})

test('paper equity and open P/L are marked to market with fees and funding', async () => {
  let now = 1_000
  const store = { balanceSats: 100_000, trades: [], nextId: 1 }
  const fundingSettlements = [{ time: 2_000, fundingRate: 0.001, fixingPrice: 100_000 }]
  const executor = createPaperExecutor({ store, feeRate: 0.001, fundingSettlements, now: () => now })
  const trade = await executor.openPosition({
    side: 'long',
    quantityUsd: 100,
    marginSats: 10_000,
    leverage: 10,
    entry: 100_000,
    stop: 90_000,
    takeProfit: 120_000,
    liquidation: 80_000,
  })

  now = 3_000
  executor.mark([{ time: now, open: 100_000, high: 111_000, low: 99_000, close: 110_000 }])
  const account = await executor.getAccount()

  assert.equal(trade.carryFeesSats, 100)
  assert.equal(trade.plSats, 8_800)
  assert.equal(account.equitySats, 108_800)
})
