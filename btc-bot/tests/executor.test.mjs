import assert from 'node:assert/strict'
import test from 'node:test'
import { createLnMarketsExecutor, normaliseTrade } from '../src/executor-lnm.mjs'
import { createPaperExecutor } from '../src/executor-paper.mjs'
import { candle, HOUR, START } from './helpers.mjs'

const silent = { info() {}, warn() {}, error() {} }

const stubClient = (overrides = {}) => ({
  network: 'testnet',
  getUser: async () => ({ balance: 100_000, total_margin: 5_000, username: 'tester' }),
  getTrades: async () => [],
  newTrade: async (data) => ({
    id: 'X1',
    side: data.side,
    type: data.type,
    running: true,
    quantity: data.quantity,
    leverage: data.leverage,
    price: 100_000,
    stoploss: data.stoploss,
    takeprofit: data.takeprofit,
  }),
  updateTrade: async () => ({}),
  closeTrade: async () => ({}),
  cancelTrade: async () => ({}),
  ...overrides,
})

test('LN Markets trade fields map onto the app shape, including side and status', () => {
  const normalised = normaliseTrade({
    id: 7,
    side: 's',
    type: 'l',
    running: false,
    closed: false,
    canceled: false,
    quantity: 50,
    margin: 4321,
    leverage: 8,
    price: 99_000,
    stoploss: 101_000,
    takeprofit: 93_000,
  })
  assert.equal(normalised.id, '7')
  assert.equal(normalised.side, 'short')
  assert.equal(normalised.type, 'limit')
  assert.equal(normalised.status, 'open')
  assert.equal(normalised.stopLoss, 101_000)
})

test('equity counts posted margin, not just the free balance', async () => {
  const executor = createLnMarketsExecutor({ client: stubClient(), logger: silent })
  const account = await executor.getAccount()
  assert.equal(account.equitySats, 105_000)
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
    newTrade: async () => ({ id: 'BAD', side: 'b', running: true, quantity: 10, price: 100_000 }),
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
    newTrade: async () => ({ id: 'STUCK', side: 'b', running: true, quantity: 10, price: 100_000 }),
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
  assert.equal(store.balanceSats, afterOpen + opened.marginSats + opened.plSats)
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
