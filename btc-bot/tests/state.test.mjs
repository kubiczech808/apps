import assert from 'node:assert/strict'
import test from 'node:test'

import { compactPersistentState, MAX_CLOSED_TRADES, MAX_RUNS, recordRun } from '../src/state.mjs'
import { createPaperExecutor } from '../src/executor-paper.mjs'

test('run history keeps execution facts without retaining complete order plans', () => {
  const detailedOrder = {
    id: 'paper-42',
    assetSymbol: 'EURUSD',
    timeframeId: '1h',
    side: 'short',
    plan: { zones: Array.from({ length: 100 }, (_, index) => ({ index, low: 1.1, high: 1.2 })) },
  }
  const state = {
    runs: Array.from({ length: MAX_RUNS }, (_, index) => ({
      at: index,
      priceActionExecutions: [{ action: 'placed', order: detailedOrder }],
    })),
  }

  recordRun(state, {
    at: MAX_RUNS + 1,
    priceActionExecutions: [{ action: 'placed', reason: 'validni setup', order: detailedOrder }],
  })

  assert.equal(state.runs.length, MAX_RUNS)
  assert.deepEqual(state.runs[0].priceActionExecutions, [{
    action: 'placed',
    reason: 'validni setup',
    id: 'paper-42',
    assetSymbol: 'EURUSD',
    timeframeId: '1h',
    side: 'short',
  }])
  assert.equal('order' in state.runs[0].priceActionExecutions[0], false)
  assert.equal('order' in state.runs.at(-1).priceActionExecutions[0], false)
})

test('paper state caps terminal history while retaining executable records', () => {
  const closed = Array.from({ length: MAX_CLOSED_TRADES + 25 }, (_, index) => ({
    id: `closed-${index}`,
    status: 'closed',
    closedAt: index,
  }))
  const cancelled = Array.from({ length: MAX_CLOSED_TRADES + 25 }, (_, index) => ({
    id: `cancelled-${index}`,
    status: 'cancelled',
    cancelledAt: MAX_CLOSED_TRADES + 25 + index,
  }))
  const running = { id: 'running', status: 'running' }
  const order = { id: 'order', status: 'open' }
  const store = { balanceSats: 1_000_000, trades: [...closed, ...cancelled, running, order], nextId: 1 }

  createPaperExecutor({ store })

  const terminal = store.trades.filter((trade) => ['closed', 'cancelled'].includes(trade.status))
  assert.equal(terminal.length, MAX_CLOSED_TRADES)
  assert.ok(store.trades.some((trade) => trade.id === 'cancelled-524'))
  assert.equal(store.trades.some((trade) => trade.id === 'closed-0'), false)
  assert.ok(store.trades.includes(running))
  assert.ok(store.trades.includes(order))
})

test('persistent state compacts paper history even without a paper executor', () => {
  const cancelled = Array.from({ length: MAX_CLOSED_TRADES + 1 }, (_, index) => ({
    id: `cancelled-${index}`,
    status: 'cancelled',
    cancelledAt: index,
  }))
  const active = { id: 'open', status: 'open' }
  const state = { paper: { trades: [...cancelled, active] }, runs: [] }

  compactPersistentState(state)

  assert.equal(state.paper.trades.length, MAX_CLOSED_TRADES + 1)
  assert.ok(state.paper.trades.includes(active))
  assert.equal(state.paper.trades.some((trade) => trade.id === 'cancelled-0'), false)
})
