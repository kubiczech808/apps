import assert from 'node:assert/strict'
import test from 'node:test'
import { reconcileBrackets, roundStop, roundTarget, runPass } from '../src/bot.mjs'
import { appendCandle, zigzag } from './helpers.mjs'

const HOUR = 3600_000

// An uptrend that has just rejected an old demand zone, at realistic BTC
// prices so margin and quantity read the way they will in production.
const marketCandles = () => {
  const candles = zigzag([100, 112, 106, 124, 116, 138, 128, 152, 140, 168, 152, 180, 164, 196, 166], {
    steps: 32,
    scale: 600,
  })
  appendCandle(candles, { open: 99_000, high: 99_600, low: 97_800, close: 99_300 })
  return candles
}

const quietCandles = () => zigzag([100, 110, 100, 110, 100, 110, 100, 110], { steps: 32, scale: 600 })

const bybitStub = (candles) => async (url) => {
  if (!String(url).includes('bybit')) throw new Error(`unexpected fetch for ${url}`)
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: new Map([['content-type', 'application/json']]),
    json: async () => ({
      result: {
        list: candles.map((candle) => [
          candle.time,
          candle.open,
          candle.high,
          candle.low,
          candle.close,
          candle.volume,
        ]),
      },
    }),
    text: async () => '',
  }
}

const fakeStore = (initial = null) => {
  const box = { saved: null, lease: { granted: true, owner: 'test' } }
  return {
    box,
    load: async () => ({ state: initial, origin: initial ? 'hosting' : 'none' }),
    save: async (state) => {
      box.saved = state
      return { local: false, hosting: true, error: null }
    },
    claimLease: async () => box.lease,
  }
}

const fakeExecutor = ({ equitySats = 200_000, running = [], closed = [], orders = [] } = {}) => {
  const calls = []
  return {
    calls,
    factory: () => ({
      mode: 'testnet',
      executor: {
        name: 'fake',
        live: true,
        getAccount: async () => ({
          balanceSats: equitySats,
          marginUsedSats: 0,
          equitySats,
          source: 'fake',
        }),
        listTrades: async () => ({ running, open: orders, closed }),
        openPosition: async (plan) => {
          calls.push(['open', plan])
          const position = {
            id: 'T1',
            side: plan.side,
            status: 'running',
            entry: plan.entry,
            stopLoss: plan.stop,
            takeProfit: plan.takeProfit,
            quantityUsd: plan.quantityUsd,
            marginSats: plan.marginSats,
            leverage: plan.leverage,
          }
          // Deliberately does NOT push into `running`: a real exchange client
          // does not mutate the array a previous listTrades returned, and a
          // double that did would hide the bot doing the same thing twice.
          return position
        },
        updateStops: async (id, patch) => {
          calls.push(['updateStops', id, patch])
          return []
        },
        closePosition: async (id) => {
          calls.push(['close', id])
          return { id }
        },
        cancelOrder: async (id) => {
          calls.push(['cancel', id])
          return { id }
        },
      },
    }),
  }
}

const baseEnv = { BOT_RUNNER: 'test', BOT_CANDLE_LIMIT: '900' }

// Same reason as in strategy.test.mjs: the synthetic market has no swept
// liquidity and no imbalance, and these tests are about the pass, not the
// filters.
// fakeStore takes a whole STATE, so the flags belong under settings.strategy —
// putting them at the top level left the filters on and the tests failing for
// the new reason rather than their own.
const noQualityFilters = (state = {}) => ({
  ...state,
  settings: {
    ...(state.settings ?? {}),
    strategy: { requireSweep: false, requireImbalance: false, ...(state.settings?.strategy ?? {}) },
  },
  paper: { balanceSats: 0, trades: [], nextId: 1 },
})
const nowAfter = (candles) => candles.at(-1).time + HOUR + 60_000

test('a pass opens exactly one position, with a stop loss and a take profit', async () => {
  const candles = marketCandles()
  const store = fakeStore(noQualityFilters())
  const executor = fakeExecutor()

  const { state, run } = await runPass({
    env: baseEnv,
    fetchImpl: bybitStub(candles),
    store,
    logger: { info() {}, warn() {}, error() {} },
    now: nowAfter(candles),
    makeExecutor: executor.factory,
  })

  const opens = executor.calls.filter(([kind]) => kind === 'open')
  assert.equal(opens.length, 1, `expected one open, got ${JSON.stringify(executor.calls)}`)

  const plan = opens[0][1]
  assert.equal(plan.side, 'long')
  assert.ok(plan.stop > 0 && plan.takeProfit > 0, 'both brackets must be set')
  assert.ok(plan.stop < plan.entry && plan.takeProfit > plan.entry)
  assert.ok(plan.quantityUsd >= 1)
  assert.equal(run.action, 'opened')
  assert.equal(state.positions.running.length, 1)
  assert.equal(store.box.saved.positions.running.length, 1)
})

test('the position it opens risks the configured 1% of equity, not more', async () => {
  const candles = marketCandles()
  const executor = fakeExecutor({ equitySats: 200_000 })

  await runPass({
    env: baseEnv,
    fetchImpl: bybitStub(candles),
    store: fakeStore(noQualityFilters()),
    logger: { info() {}, warn() {}, error() {} },
    now: nowAfter(candles),
    makeExecutor: executor.factory,
  })

  const plan = executor.calls.find(([kind]) => kind === 'open')[1]
  assert.ok(plan.riskSats <= 2000 + 1, `risked ${plan.riskSats} sats of a 200000 sat account`)
  assert.ok(plan.riskSats > 1800, `risked only ${plan.riskSats} sats — sizing collapsed`)
  assert.ok(plan.liquidation < plan.stop, 'liquidation must sit beyond the stop')
})

test('nothing is opened while trading is paused, and the reason says so', async () => {
  const candles = marketCandles()
  const executor = fakeExecutor()
  const paused = noQualityFilters({ settings: { enabled: false } })

  const { run, state } = await runPass({
    env: baseEnv,
    fetchImpl: bybitStub(candles),
    store: fakeStore(paused),
    logger: { info() {}, warn() {}, error() {} },
    now: nowAfter(candles),
    makeExecutor: executor.factory,
  })

  assert.equal(executor.calls.filter(([kind]) => kind === 'open').length, 0)
  assert.match(run.reason, /paused/)
  assert.equal(state.status, 'paused')
})

test('a second position is refused while one is already open', async () => {
  const candles = marketCandles()
  const existing = {
    id: 'EXISTING',
    side: 'long',
    status: 'running',
    entry: 95_000,
    stopLoss: 93_000,
    takeProfit: 101_000,
    quantityUsd: 10,
    marginSats: 1000,
  }
  const executor = fakeExecutor({ running: [existing] })

  const { run } = await runPass({
    env: baseEnv,
    fetchImpl: bybitStub(candles),
    store: fakeStore(noQualityFilters()),
    logger: { info() {}, warn() {}, error() {} },
    now: nowAfter(candles),
    makeExecutor: executor.factory,
  })

  assert.equal(executor.calls.filter(([kind]) => kind === 'open').length, 0)
  assert.match(run.reason, /already open/)
})

test('a pass that loses the lease does nothing and says who holds it', async () => {
  const candles = marketCandles()
  const store = fakeStore()
  store.box.lease = { granted: false, owner: 'rpi' }
  const executor = fakeExecutor()

  const { run } = await runPass({
    env: baseEnv,
    fetchImpl: () => {
      throw new Error('must not reach the network without the lease')
    },
    store,
    logger: { info() {}, warn() {}, error() {} },
    now: nowAfter(candles),
    makeExecutor: executor.factory,
  })

  assert.equal(run.action, 'skipped')
  assert.match(run.reason, /rpi/)
  assert.equal(executor.calls.length, 0)
})

test('a quiet range produces no trade and records why', async () => {
  const candles = quietCandles()
  const executor = fakeExecutor()

  const { state } = await runPass({
    env: baseEnv,
    fetchImpl: bybitStub(candles),
    store: fakeStore(noQualityFilters()),
    logger: { info() {}, warn() {}, error() {} },
    now: nowAfter(candles),
    makeExecutor: executor.factory,
  })

  assert.equal(executor.calls.filter(([kind]) => kind === 'open').length, 0)
  assert.ok(state.lastDecision.reason.length > 0)
})

test('a failing candle source is recorded as an error rather than trading blind', async () => {
  const executor = fakeExecutor()
  const { run, state } = await runPass({
    env: baseEnv,
    fetchImpl: async () => {
      throw new Error('network down')
    },
    store: fakeStore(noQualityFilters()),
    logger: { info() {}, warn() {}, error() {} },
    now: Date.now(),
    makeExecutor: executor.factory,
  })

  assert.equal(run.action, 'error')
  assert.match(run.error, /No candle source answered/)
  assert.equal(executor.calls.filter(([kind]) => kind === 'open').length, 0)
  assert.equal(state.status, 'error')
})

test('an open position missing its stop has one restored', async () => {
  const unprotected = { id: 'U1', side: 'long', status: 'running', entry: 99_000, stopLoss: null, takeProfit: 105_000 }
  const calls = []
  const executor = {
    updateStops: async (id, patch) => calls.push(['updateStops', id, patch]),
    closePosition: async (id) => calls.push(['close', id]),
  }

  const actions = await reconcileBrackets({
    executor,
    positions: [unprotected],
    ltfCandles: marketCandles(),
    logger: { warn() {}, error() {} },
    dryRun: false,
  })

  assert.equal(actions[0].action, 'restored_brackets')
  assert.ok(calls[0][2].stopLoss > 0)
  assert.ok(unprotected.stopLoss > 0)
  assert.ok(unprotected.stopLoss < unprotected.entry)
})

test('a position that cannot be bracketed is closed rather than left running', async () => {
  const unprotected = { id: 'U2', side: 'short', status: 'running', entry: 99_000, stopLoss: null, takeProfit: null }
  const closed = []
  const executor = {
    updateStops: async () => {
      throw new Error('exchange rejected the stop')
    },
    closePosition: async (id) => closed.push(id),
  }

  const actions = await reconcileBrackets({
    executor,
    positions: [unprotected],
    ltfCandles: marketCandles(),
    logger: { warn() {}, error() {} },
    dryRun: false,
  })

  assert.equal(actions[0].action, 'closed_unprotected')
  assert.deepEqual(closed, ['U2'])
})

test('prices round in the direction that cannot enlarge the risk', () => {
  assert.equal(roundStop('long', 98_000.4), 98_001)
  assert.equal(roundStop('short', 102_000.6), 102_000)
  assert.equal(roundTarget('long', 110_000.9), 110_000)
  assert.equal(roundTarget('short', 90_000.1), 90_001)
})

test('mainnet is refused while the dashboard key is one published in the repo', async () => {
  const candles = marketCandles()
  const errors = []
  const { state, run } = await runPass({
    env: { ...baseEnv, BOT_API_KEY: 'ahoj1234567890' },
    fetchImpl: bybitStub(candles),
    store: fakeStore(noQualityFilters({ settings: { mode: 'mainnet' } })),
    logger: { info() {}, warn() {}, error: (message) => errors.push(message) },
    now: nowAfter(candles),
  })

  // Falls back to paper rather than trading, and says why on the state so the
  // dashboard can explain itself instead of looking like it ignored the change.
  assert.equal(run.mode, 'paper')
  assert.equal(state.mode, 'paper')
  assert.match(state.modeRefusal, /public repository/)
  assert.ok(errors.some((message) => /Refusing mainnet/.test(message)))
})

test('mainnet is allowed once the key is not a published one', async () => {
  const candles = marketCandles()
  const { run } = await runPass({
    env: { ...baseEnv, BOT_API_KEY: 'a-real-secret-nobody-published' },
    fetchImpl: bybitStub(candles),
    store: fakeStore(noQualityFilters({ settings: { mode: 'mainnet' } })),
    logger: { info() {}, warn() {}, error() {} },
    now: nowAfter(candles),
  })

  // No LN Markets credentials in this environment, so it still degrades to
  // paper — but for the credential reason, not the key one.
  assert.equal(run.mode, 'paper')
})
