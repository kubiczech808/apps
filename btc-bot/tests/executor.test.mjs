import assert from 'node:assert/strict'
import test from 'node:test'
import { createLnMarketsExecutor, normaliseTrade } from '../src/executor-lnm.mjs'
import { createPaperExecutor } from '../src/executor-paper.mjs'
import { fetchLnMarketsCandles } from '../src/candles.mjs'
import { pnlSats } from '../src/risk.mjs'
import { candle, HOUR, START } from './helpers.mjs'

const silent = { info() {}, warn() {}, error() {} }

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
