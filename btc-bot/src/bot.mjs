// One pass of the bot.
//
// A pass is deliberately short and idempotent: read the market, reconcile what
// the exchange says is open against what this bot believes, manage the open
// position, and — only if every gate agrees — open one new one. It is safe to
// run it every minute, and safe to miss a run, because the protective orders
// live on LN Markets rather than in this process.
//
// Order of work matters and is not arbitrary:
//   lease → market → account → reconcile → manage → enter
// Reconciling before managing means a stop that vanished is restored before the
// position is judged; managing before entering means capital freed by an exit is
// available to the entry in the same pass.

import { aggregate, DEFAULT_SOURCE_ORDER, dropForming, fetchCandlesWithFallback, HOUR_MS } from './candles.mjs'
import { createLnMarketsClient, resolveNetwork } from './lnmarkets.mjs'
import { createLnMarketsExecutor } from './executor-lnm.mjs'
import { createPaperExecutor } from './executor-paper.mjs'
import { atr, lastDefined, marketStructure } from './priceaction.mjs'
import { planPosition, SATS_PER_BTC } from './risk.mjs'
import { evaluateEntry, manageOpen } from './strategy.mjs'
import {
  capClosed,
  computeStats,
  emptyState,
  lastLossAt,
  mergeSettings,
  recordEquity,
  recordRun,
  tradesToday,
} from './state.mjs'

export const roundStop = (side, price) => (side === 'long' ? Math.ceil(price) : Math.floor(price))
export const roundTarget = (side, price) => (side === 'long' ? Math.floor(price) : Math.ceil(price))

export const readConfig = (env = process.env) => ({
  apiUrl: env.BOT_API_URL || '',
  apiKey: env.BOT_API_KEY || '',
  stateFile: env.BOT_STATE_FILE || '',
  runner: env.BOT_RUNNER || 'manual',
  leaseTtlMs: Number(env.BOT_LEASE_TTL_MS || 90_000),
  modeOverride: env.BOT_MODE || '',
  candleLimit: Number(env.BOT_CANDLE_LIMIT || 720),
  // Which LN Markets network to read the chart from when the bot itself is not
  // connected to one (paper mode). Mainnet, because that is the market being
  // simulated.
  marketNetwork: env.BOT_MARKET_NETWORK || 'mainnet',
  dryRun: env.BOT_DRY_RUN === 'true',
})

const isoNow = (ms) => new Date(ms).toISOString()

/**
 * Fetch the two timeframes the strategy reads, from one hourly series so the
 * 4h buckets cannot disagree with the 1h ones they are built from.
 */
export const loadMarket = async ({ settings, candleLimit, fetchImpl, now, client }) => {
  // LN Markets' own candles are only offered when there is a client to fetch
  // them with; in paper mode there is none, and listing the source anyway would
  // spend a guaranteed failure on every pass.
  const { source, candles, failures } = await fetchCandlesWithFallback({
    order: DEFAULT_SOURCE_ORDER,
    limit: candleLimit,
    fetchImpl,
    client,
  })
  const closed = dropForming(candles, HOUR_MS, now)
  const ltf = aggregate(closed, settings.timeframes.ltfHours)
  const htf = aggregate(closed, settings.timeframes.htfHours)
  return { source, failures, hourly: closed, ltf, htf }
}

const bracketFallback = ({ position, ltfCandles }) => {
  const entry = position.entry
  if (!(entry > 0)) return null
  const ltfAtr = lastDefined(atr(ltfCandles, 14)) ?? entry * 0.01
  const risk = ltfAtr * 1.5
  return position.side === 'long'
    ? { stopLoss: roundStop('long', entry - risk), takeProfit: roundTarget('long', entry + risk * 2) }
    : { stopLoss: roundStop('short', entry + risk), takeProfit: roundTarget('short', entry - risk * 2) }
}

/**
 * Guarantee the invariant the whole design rests on: every open position is
 * bracketed on the exchange. A position that cannot be bracketed is closed.
 */
export const reconcileBrackets = async ({ executor, positions, ltfCandles, logger, dryRun }) => {
  const actions = []
  for (const position of positions) {
    const missingStop = !(position.stopLoss > 0)
    const missingTarget = !(position.takeProfit > 0)
    if (!missingStop && !missingTarget) continue

    const fallback = bracketFallback({ position, ltfCandles })
    if (!fallback) {
      // No entry price means no defensible bracket. Closing is the only
      // remaining way to honour "never hold an unprotected position".
      try {
        await executor.closePosition(position.id)
        actions.push({ id: position.id, action: 'closed_unpriceable' })
      } catch (error) {
        actions.push({ id: position.id, action: 'unprotected_and_stuck', error: error.message })
        logger.error(`UNPROTECTED position ${position.id} has no entry price and could not be closed: ${error.message}`)
      }
      continue
    }
    const patch = {}
    if (missingStop) patch.stopLoss = fallback.stopLoss
    if (missingTarget) patch.takeProfit = fallback.takeProfit

    if (dryRun) {
      actions.push({ id: position.id, action: 'would_restore_brackets', patch })
      continue
    }

    try {
      await executor.updateStops(position.id, patch)
      if (missingStop) position.stopLoss = patch.stopLoss
      if (missingTarget) position.takeProfit = patch.takeProfit
      actions.push({ id: position.id, action: 'restored_brackets', patch })
      logger.warn(`Restored missing brackets on ${position.id}: ${JSON.stringify(patch)}`)
    } catch (error) {
      logger.error(`Could not bracket ${position.id} (${error.message}); closing it`)
      try {
        await executor.closePosition(position.id)
        actions.push({ id: position.id, action: 'closed_unprotected', error: error.message })
      } catch (closeError) {
        actions.push({ id: position.id, action: 'unprotected_and_stuck', error: closeError.message })
        logger.error(`UNPROTECTED position ${position.id} could not be closed: ${closeError.message}`)
      }
    }
  }
  return actions
}

/**
 * Carry out what the dashboard asked for.
 *
 * Operator commands are queued on the hosting rather than executed there,
 * because the hosting holds no exchange credentials and should not: the runner
 * that already has them does the work, on its next pass, and reports what
 * happened. The queue is only cleared once the resulting state is published, so
 * a runner that dies mid-command leaves the command for the next one.
 */
export const applyCommands = async ({ executor, commands, positions, logger, dryRun }) => {
  const results = []
  for (const entry of commands) {
    const { command, id } = entry
    try {
      if (dryRun) {
        results.push({ ...entry, outcome: 'skipped_dry_run' })
      } else if (command === 'flatten') {
        for (const position of positions) await executor.closePosition(position.id)
        results.push({ ...entry, outcome: `closed ${positions.length}` })
      } else if (command === 'close' && id) {
        await executor.closePosition(id)
        results.push({ ...entry, outcome: 'closed' })
      } else if (command === 'cancel' && id) {
        await executor.cancelOrder(id)
        results.push({ ...entry, outcome: 'cancelled' })
      } else if (command === 'run-now') {
        // The pass this command arrived in IS the run it asked for.
        results.push({ ...entry, outcome: 'ran' })
      } else {
        results.push({ ...entry, outcome: 'ignored' })
      }
    } catch (error) {
      logger.error(`Command ${command} ${id ?? ''} failed: ${error.message}`)
      results.push({ ...entry, outcome: 'failed', error: error.message })
    }
  }
  return results
}

export const buildExecutor = ({ settings, state, config, logger, fetchImpl }) => {
  const mode = config.modeOverride || settings.mode
  if (mode === 'paper') {
    return { mode, executor: createPaperExecutor({ store: state.paper }), client: null }
  }
  const client = createLnMarketsClient({ network: mode, fetchImpl })
  if (!client.hasCredentials) {
    logger.warn(`Mode is ${mode} but LN Markets credentials are missing — degrading to paper so nothing trades blind`)
    return { mode: 'paper', executor: createPaperExecutor({ store: state.paper }), client: null }
  }
  return { mode, executor: createLnMarketsExecutor({ client, logger }), client }
}

export const runPass = async ({
  env = process.env,
  fetchImpl = globalThis.fetch,
  store,
  logger = console,
  now = Date.now(),
  // Seam for tests: a pass has to be exercisable end to end without an
  // exchange account, and the alternative — mocking fetch deeply enough to
  // impersonate LN Markets — would test the mock rather than the bot.
  makeExecutor = buildExecutor,
} = {}) => {
  const config = readConfig(env)
  const startedAt = Date.now()
  const loaded = await store.load()
  const state = loaded.state ?? emptyState()
  state.settings = mergeSettings(state.settings)
  // A state document published by an older build has no paper store, and the
  // paper executor writes straight into it.
  state.paper ??= { balanceSats: 0, trades: [], nextId: 1 }
  const settings = state.settings

  const run = {
    at: isoNow(now),
    runner: config.runner,
    origin: loaded.origin,
    mode: null,
    action: 'none',
    reason: null,
    error: null,
    durationMs: null,
  }

  state.heartbeats = { ...(state.heartbeats ?? {}), [config.runner]: isoNow(now) }

  try {
    const lease = await store.claimLease({ owner: config.runner, ttlMs: config.leaseTtlMs })
    if (!lease?.granted) {
      run.action = 'skipped'
      run.reason = `another runner holds the lease (${lease?.owner ?? 'unknown'})`
      recordRun(state, { ...run, durationMs: Date.now() - startedAt })
      state.updatedAt = isoNow(now)
      const saved = await store.save(state, { localOnly: true })
      return { state, run, saved }
    }

    const { executor, mode } = makeExecutor({ settings, state, config, logger, fetchImpl })
    run.mode = mode
    state.mode = mode

    // Candles come from a client of their own, with no credentials attached.
    // `futures/candles` is a public route, so paper mode reads the same chart
    // the live mode does — which is the point: paper results are only worth
    // anything if they were decided from the same data.
    const market = await loadMarket({
      settings,
      candleLimit: config.candleLimit,
      fetchImpl,
      now,
      client: createLnMarketsClient({
        network: resolveNetwork(mode === 'paper' ? config.marketNetwork : mode),
        fetchImpl,
        key: '',
        secret: '',
        passphrase: '',
      }),
    })

    // Paper positions only settle when someone walks the candles past them.
    if (!executor.live) {
      if (!(state.paper.balanceSats > 0) && market.ltf.length) {
        state.paper.balanceSats = Math.round(
          (settings.startingCapitalUsd / market.ltf.at(-1).close) * SATS_PER_BTC
        )
      }
      executor.mark(market.ltf)
    }

    const [account, trades] = await Promise.all([executor.getAccount(), executor.listTrades()])
    state.account = account

    const commandResults = await applyCommands({
      executor,
      commands: loaded.commands ?? [],
      positions: trades.running,
      logger,
      dryRun: config.dryRun,
    })
    // Telling the hosting the queue was consumed is what clears it, so it is
    // set only after the commands actually ran.
    state.consumedCommands = commandResults.length
    run.commands = commandResults

    const bracketActions = await reconcileBrackets({
      executor,
      positions: trades.running,
      ltfCandles: market.ltf,
      logger,
      dryRun: config.dryRun,
    })

    const managed = []
    for (const position of trades.running) {
      const decision = manageOpen({
        position: { ...position, initialStop: position.initialStop ?? position.stopLoss },
        ltfCandles: market.ltf,
        htfCandles: market.htf,
        settings: settings.strategy,
      })
      if (decision.action === 'hold') continue
      if (config.dryRun) {
        managed.push({ id: position.id, ...decision, applied: false })
        continue
      }
      try {
        if (decision.action === 'close') {
          await executor.closePosition(position.id, market.ltf.at(-1)?.close)
        } else {
          const stop = roundStop(position.side, decision.stop)
          await executor.updateStops(position.id, { stopLoss: stop })
          position.stopLoss = stop
        }
        managed.push({ id: position.id, ...decision, applied: true })
      } catch (error) {
        managed.push({ id: position.id, ...decision, applied: false, error: error.message })
        logger.error(`Managing ${position.id} failed: ${error.message}`)
      }
    }

    const changed = managed.length > 0 || commandResults.length > 0
    const refreshed = changed && executor.live ? await executor.listTrades() : trades
    const running = refreshed.running
    const closed = capClosed(refreshed.closed)

    const structure = marketStructure(market.htf, { lookback: settings.strategy.htfLookback })
    const ltfAtr = lastDefined(atr(market.ltf, 14))
    const price = market.ltf.at(-1)?.close ?? null
    state.market = {
      price,
      bias: structure.bias,
      event: structure.event,
      atrPct: ltfAtr && price ? (ltfAtr / price) * 100 : null,
      candleSource: market.source,
      candleFailures: market.failures,
      asOf: isoNow(market.ltf.at(-1)?.time ?? now),
    }

    let decision = evaluateEntry({ htfCandles: market.htf, ltfCandles: market.ltf, settings: settings.strategy })

    // Portfolio gates. They sit outside the strategy on purpose: the strategy
    // answers "is this a trade", these answer "may this account take it now".
    const gates = []
    if (!settings.enabled) gates.push('trading is paused in settings')
    if (running.length >= settings.maxOpenPositions) {
      gates.push(`${running.length}/${settings.maxOpenPositions} positions already open`)
    }
    const todayCount = tradesToday(closed, running, now)
    if (todayCount >= settings.maxTradesPerDay) {
      gates.push(`${todayCount}/${settings.maxTradesPerDay} trades already taken today`)
    }
    const lossAt = lastLossAt(closed)
    if (lossAt && now - lossAt < settings.cooldownMinutesAfterLoss * 60_000) {
      const remaining = Math.ceil((settings.cooldownMinutesAfterLoss * 60_000 - (now - lossAt)) / 60_000)
      gates.push(`cooling down after a loss for another ${remaining} min`)
    }

    let plan = null
    if (decision.action === 'open' && gates.length === 0) {
      const entry = Math.round(decision.entry)
      const stop = roundStop(decision.side, decision.stop)
      const takeProfit = roundTarget(decision.side, decision.takeProfit)
      plan = planPosition({
        side: decision.side,
        entry,
        stop,
        takeProfit,
        equitySats: account.equitySats,
        settings: settings.risk,
      })
      if (!plan.ok) {
        gates.push(plan.reason)
      } else if (plan.rr < settings.strategy.minRR) {
        gates.push(`reward/risk fell to ${plan.rr.toFixed(2)} after rounding`)
      }
    }

    if (decision.action === 'open' && gates.length === 0 && plan?.ok) {
      if (config.dryRun) {
        run.action = 'would_open'
        run.reason = decision.reason
      } else {
        const opened = await executor.openPosition({ ...plan, side: decision.side })
        opened.initialStop = plan.stop
        opened.plan = { reason: decision.reason, rr: plan.rr, riskSats: plan.riskSats }
        running.push(opened)
        run.action = 'opened'
        run.reason = `${decision.side} ${plan.quantityUsd} USD @ ${plan.entry} — ${decision.reason}`
        logger.info(`Opened ${run.reason}`)
      }
    } else {
      run.action = managed.length || bracketActions.length || commandResults.length ? 'managed' : 'none'
      run.reason = gates.length ? gates.join('; ') : decision.reason
    }

    state.positions = { running, orders: refreshed.open, closed }
    // Drawdown needs the equity the account started from. The first recorded
    // point is the truthful answer once there is one; before that, back it out
    // of the current equity and the realised P/L so the figure is still about
    // the account rather than about a P/L curve starting at zero.
    const firstEquity = state.equityHistory?.[0]?.equitySats
    const netSoFar = closed.reduce((sum, trade) => sum + (trade.plSats ?? 0), 0)
    state.stats = computeStats(closed, {
      startEquitySats: firstEquity ?? account.equitySats - netSoFar,
    })
    state.lastDecision = {
      at: isoNow(now),
      action: decision.action,
      side: decision.side ?? null,
      reason: decision.reason,
      gates,
      plan: plan?.ok ? plan : null,
      planRejection: plan && !plan.ok ? plan.reason : null,
      context: decision.context ?? null,
    }
    state.status = settings.enabled ? 'running' : 'paused'
    run.managed = managed
    run.brackets = bracketActions
    recordEquity(state, account.equitySats, now)
  } catch (error) {
    run.action = 'error'
    run.error = error.message
    state.status = 'error'
    logger.error(`Pass failed: ${error.stack ?? error.message}`)
  }

  run.durationMs = Date.now() - startedAt
  recordRun(state, run)
  state.updatedAt = isoNow(now)
  state.savedBy = config.runner
  const saved = await store.save(state)
  if (saved.error) logger.warn(`State was not published to hosting: ${saved.error}`)

  return { state, run, saved }
}
