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
import { isPublicKey, PUBLIC_KEY_REFUSAL } from './keys.mjs'
import { createLnMarketsClient, resolveNetwork } from './lnmarkets.mjs'
import { createLnMarketsExecutor } from './executor-lnm.mjs'
import { createPaperExecutor } from './executor-paper.mjs'
import { fetchFundingSettlements } from './funding.mjs'
import { atr, lastDefined, marketStructure } from './priceaction.mjs'
import { planLinearPosition, planPosition, SATS_PER_BTC } from './risk.mjs'
import { ceilPrice, floorPrice, roundPrice } from './price.mjs'
import { LEGACY_PRICE_ACTION_ID, strategyConfig } from './strategy-registry.mjs'
import {
  MIN_PRICE_ACTION_HOURLY_CANDLES,
  PRICE_ACTION_MATRIX_SCHEMA,
  PRICE_ACTION_STRUCTURE_ID,
  buildPriceActionMatrix,
  reviewOpenPositionInMatrix,
} from './strategy-price-action-structure.mjs'
import {
  capClosed,
  computeStats,
  emptyState,
  lastLossAt,
  mergeSettings,
  recordEquity,
  recordPriceActionEvent,
  recordRun,
  tradesToday,
} from './state.mjs'

export const roundStop = (side, price) => (side === 'long' ? floorPrice(price) : ceilPrice(price))
export const roundTarget = (side, price) => (side === 'long' ? ceilPrice(price) : floorPrice(price))

const PRICE_ACTION_TIMEFRAME_PRIORITY = { '1h': 1, '4h': 2, '1d': 3 }
export const PRICE_ACTION_POSITION_PROTOCOL = 1

const priceActionLeverage = (settings) => {
  const candidate = Math.floor(Number(settings?.priceActionStructure?.leverage))
  return Number.isFinite(candidate) ? Math.min(10, Math.max(1, candidate)) : 1
}

const priceActionSignalKey = ({ assetSymbol, timeframeId, profile, settings }) => {
  const zoneIdentity = profile.zone?.firstTime ?? profile.zone?.lastTime ?? profile.zone?.firstIndex ?? 'zone'
  // Sizing is part of an entry instruction. A pending order created for spot
  // must be replaced if the user intentionally changes the leverage setting.
  return [PRICE_ACTION_STRUCTURE_ID, assetSymbol, timeframeId, profile.side, zoneIdentity, profile.entry, `leverage-${priceActionLeverage(settings)}`].join(':')
}

// A limit order may wait for the two gates that only become true at its own
// price: the zone hit and the 50% pullback. Every other gate must already be
// true, otherwise the first touch would consume the FVG without a valid setup.
const isPendingPriceActionOrderProfile = (profile) => {
  // A pending limit must exist before the touch so a late runner cannot
  // invent an entry after price has already left the intended level.
  if (profile?.status !== 'watch' || profile?.mode !== 'screening' || !profile.side || profile.zoneHit || profile.zoneTouched) return false
  if (![profile.entry, profile.stop, profile.tp1, profile.weightedTarget].every(Number.isFinite)) return false
  return (profile.gates ?? [])
    .filter((gate) => !['zone', 'pullback'].includes(gate.id))
    .every((gate) => gate.passed !== false)
}

const validPriceActionTp2 = ({ side, tp1, tp2 }) => {
  if (!Number.isFinite(tp1) || !Number.isFinite(tp2)) return null
  if (side === 'long' && tp2 > tp1) return tp2
  if (side === 'short' && tp2 < tp1) return tp2
  return null
}

// Do not rewrite an open trade merely because the current chart has a new
// target. A missing TP2 can be backfilled only when the live profile still
// describes the same direction and first target as the original instruction.
export const reconcileMissingPriceActionTargets = async ({
  executor,
  positions = [],
  matrix,
  dryRun = false,
} = {}) => {
  if (typeof executor?.setPriceActionTp2 !== 'function') return []
  const outcomes = []
  for (const position of positions.filter((candidate) =>
    candidate.strategyId === PRICE_ACTION_STRUCTURE_ID &&
    candidate.pricingModel === 'linear-usd' &&
    Number.isFinite(candidate.tp1) &&
    !Number.isFinite(candidate.tp2)
  )) {
    const asset = matrix?.assets?.find((candidate) => candidate.symbol === position.assetSymbol)
    const item = asset?.trends?.[position.timeframeId]
    const profile = item?.tradeProfile
    const tp2 = validPriceActionTp2(profile ?? {})
    const sameInstruction = profile?.side === position.side &&
      roundPrice(profile?.tp1) === roundPrice(position.tp1)
    if (!sameInstruction || !Number.isFinite(tp2)) continue
    if (dryRun) {
      outcomes.push({ position, profile, tp2, action: 'would_backfill' })
      continue
    }
    try {
      const updated = await executor.setPriceActionTp2(position.id, tp2)
      if (updated) outcomes.push({ position: updated, profile, tp2, action: 'backfilled' })
    } catch (error) {
      outcomes.push({ position, profile, tp2, action: 'backfill_failed', error: error.message })
    }
  }
  return outcomes
}

const priceActionOrderPlan = ({ assetSymbol, timeframeId, item, profile, equitySats, btcPrice, settings }) => {
  const leverage = priceActionLeverage(settings)
  const plan = planLinearPosition({
    side: profile.side,
    entry: profile.entry,
    stop: profile.stop,
    takeProfit: profile.weightedTarget,
    equitySats,
    btcPrice,
    settings: {
      ...(settings.risk ?? {}),
      // At 1x this is genuine spot: the committed capital cannot exceed the
      // account. Higher values are an explicit user choice; the stop stays
      // structural and the plan limits position size instead of moving it.
      market: leverage === 1 ? 'spot' : 'futures',
      maxLeverage: leverage,
      maxNotionalPct: leverage * 100,
      riskPct: Number(profile.riskPct) || Number(settings.priceActionStructure?.riskPct) || 1,
    },
  })
  if (!plan.ok) return { ok: false, reason: plan.reason }
  const minRewardRisk = Number(profile.minRewardRisk) || 2
  if (!(profile.rewardRisk >= minRewardRisk)) {
    return { ok: false, reason: `R/R ${profile.rewardRisk} is below ${minRewardRisk}:1` }
  }
  const tp2 = validPriceActionTp2(profile)
  return {
    ok: true,
    order: {
      ...plan,
      type: 'limit',
      takeProfit: tp2 ?? profile.tp1,
      tp1: profile.tp1,
      tp2,
      entryZone: profile.zone ? { ...profile.zone } : null,
      tp2Zone: profile.tp2Zone ? { ...profile.tp2Zone } : null,
      assetSymbol,
      timeframeId,
      strategyId: PRICE_ACTION_STRUCTURE_ID,
      priceActionProtocol: PRICE_ACTION_POSITION_PROTOCOL,
      signalKey: priceActionSignalKey({ assetSymbol, timeframeId, profile, settings }),
      signalCandleTime: item.asOf ?? null,
      plan: {
        reason: `${profile.side} ${item.reason ?? ''}`.trim(),
        rr: profile.rewardRisk,
        riskSats: plan.riskSats,
        requestedLeverage: leverage,
      },
    },
  }
}

const priceActionExitPrice = ({ position, review }) => {
  const candidates = review?.invalidated
    ? [review.closeTrigger, review.lowerItem?.lastCandle?.close, review.item?.lastCandle?.close]
    : [review?.lowerItem?.lastCandle?.close, review?.item?.lastCandle?.close]
  return candidates.find(Number.isFinite) ?? position.markPrice ?? position.entry
}

/**
 * A confirmed structure reversal is an exit, not a passive dashboard badge.
 * The protocol marker retires paper positions opened before that behaviour
 * existed, so they cannot be mistaken for current PA-1 signals.
 */
export const reconcilePriceActionInvalidations = async ({
  executor,
  positions = [],
  matrix,
  settings,
  dryRun = false,
} = {}) => {
  const outcomes = []
  for (const position of positions.filter((candidate) => candidate.strategyId === PRICE_ACTION_STRUCTURE_ID)) {
    const review = reviewOpenPositionInMatrix({ position, matrix, settings })
    const legacy = position.priceActionProtocol !== PRICE_ACTION_POSITION_PROTOCOL
    if (!review.invalidated && !legacy) continue

    const reason = review.invalidated
      ? review.reason
      : 'pozice byla otevřena před zavedením aktuálního PA-1 protokolu řízení struktury'
    const exitPrice = priceActionExitPrice({ position, review })
    if (dryRun) {
      outcomes.push({ position, review, legacy, reason, exitPrice, action: 'would_close' })
      continue
    }
    try {
      await executor.closePosition(position.id, exitPrice, 'structure_invalidation')
      outcomes.push({ position, review, legacy, reason, exitPrice, action: 'closed' })
    } catch (error) {
      outcomes.push({ position, review, legacy, reason, exitPrice, action: 'close_failed', error: error.message })
    }
  }
  return outcomes
}

export const executeReadyPriceActionProfiles = async ({
  executor,
  matrix,
  trades = [],
  equitySats,
  btcPrice,
  settings,
  dryRun = false,
} = {}) => {
  if (!matrix?.assets || !settings?.enabled) return []
  const existingSignals = new Set(trades.map((trade) => trade.signalKey).filter(Boolean))
  const openAssets = new Set(
    trades
      .filter((trade) => trade.status === 'running' && trade.strategyId === PRICE_ACTION_STRUCTURE_ID)
      .map((trade) => trade.assetSymbol)
      .filter(Boolean)
  )
  const outcomes = []

  for (const asset of matrix.assets) {
    if (openAssets.has(asset.symbol)) continue
    const candidates = Object.entries(asset.trends ?? {})
      .map(([timeframeId, item]) => ({ timeframeId, item, profile: item?.tradeProfile }))
      .filter(({ profile }) => profile?.status === 'ready')
      .filter(({ profile }) => [profile.entry, profile.stop, profile.tp1, profile.weightedTarget].every(Number.isFinite))
      .sort((left, right) =>
        (PRICE_ACTION_TIMEFRAME_PRIORITY[left.timeframeId] ?? 99) - (PRICE_ACTION_TIMEFRAME_PRIORITY[right.timeframeId] ?? 99)
      )
    const candidate = candidates[0]
    if (!candidate) continue

    const { timeframeId, item, profile } = candidate
    const signalKey = priceActionSignalKey({ assetSymbol: asset.symbol, timeframeId, profile, settings })
    if (existingSignals.has(signalKey)) continue

    const prepared = priceActionOrderPlan({
      assetSymbol: asset.symbol,
      timeframeId,
      item,
      profile,
      equitySats,
      btcPrice,
      settings,
    })
    if (!prepared.ok) {
      outcomes.push({ assetSymbol: asset.symbol, timeframeId, action: 'rejected', reason: prepared.reason })
      continue
    }
    const order = prepared.order
    if (dryRun) {
      outcomes.push({ assetSymbol: asset.symbol, timeframeId, action: 'would_open', plan: order })
      continue
    }
    let opened
    try {
      opened = await executor.openPosition(order)
    } catch (error) {
      outcomes.push({ assetSymbol: asset.symbol, timeframeId, action: 'rejected', reason: error.message })
      continue
    }
    Object.assign(opened, {
      assetSymbol: asset.symbol,
      timeframeId,
      strategyId: PRICE_ACTION_STRUCTURE_ID,
      priceActionProtocol: PRICE_ACTION_POSITION_PROTOCOL,
      signalKey,
      signalCandleTime: item.asOf ?? null,
      tp1: profile.tp1,
      tp2: order.tp2,
      entryZone: profile.zone ? { ...profile.zone } : null,
      tp2Zone: profile.tp2Zone ? { ...profile.tp2Zone } : null,
      plan: {
        reason: `${profile.side} ${item.reason ?? ''}`.trim(),
        rr: profile.rewardRisk,
        riskSats: order.riskSats,
      },
    })
    trades.push(opened)
    existingSignals.add(signalKey)
    openAssets.add(asset.symbol)
    outcomes.push({ assetSymbol: asset.symbol, timeframeId, action: 'opened', position: opened })
  }
  return outcomes
}

export const placePendingPriceActionOrders = async ({
  executor,
  matrix,
  trades = [],
  equitySats,
  btcPrice,
  settings,
  dryRun = false,
} = {}) => {
  if (!matrix?.assets || !settings?.enabled || typeof executor.placeOrder !== 'function') return []
  const existingSignals = new Set(trades.map((trade) => trade.signalKey).filter(Boolean))
  const occupiedAssets = new Set(
    trades
      .filter((trade) => ['running', 'open'].includes(trade.status) && trade.strategyId === PRICE_ACTION_STRUCTURE_ID)
      .map((trade) => trade.assetSymbol)
      .filter(Boolean)
  )
  const outcomes = []

  for (const asset of matrix.assets) {
    if (occupiedAssets.has(asset.symbol)) continue
    const candidate = Object.entries(asset.trends ?? {})
      .map(([timeframeId, item]) => ({ timeframeId, item, profile: item?.tradeProfile }))
      .filter(({ profile }) => isPendingPriceActionOrderProfile(profile))
      .sort((left, right) =>
        (PRICE_ACTION_TIMEFRAME_PRIORITY[left.timeframeId] ?? 99) - (PRICE_ACTION_TIMEFRAME_PRIORITY[right.timeframeId] ?? 99)
      )[0]
    if (!candidate) continue

    const { timeframeId, item, profile } = candidate
    const prepared = priceActionOrderPlan({
      assetSymbol: asset.symbol,
      timeframeId,
      item,
      profile,
      equitySats,
      btcPrice,
      settings,
    })
    if (!prepared.ok) {
      outcomes.push({ assetSymbol: asset.symbol, timeframeId, action: 'rejected', reason: prepared.reason })
      continue
    }
    if (existingSignals.has(prepared.order.signalKey)) continue
    if (dryRun) {
      outcomes.push({ assetSymbol: asset.symbol, timeframeId, action: 'would_place', order: prepared.order })
      continue
    }
    try {
      const order = await executor.placeOrder(prepared.order)
      trades.push(order)
      existingSignals.add(order.signalKey)
      occupiedAssets.add(asset.symbol)
      outcomes.push({ assetSymbol: asset.symbol, timeframeId, action: 'placed', order })
    } catch (error) {
      outcomes.push({ assetSymbol: asset.symbol, timeframeId, action: 'rejected', reason: error.message })
    }
  }
  return outcomes
}

export const reconcilePendingPriceActionOrders = async ({ executor, orders = [], matrix, settings, dryRun = false } = {}) => {
  const outcomes = []
  for (const order of orders.filter((candidate) =>
    candidate.strategyId === PRICE_ACTION_STRUCTURE_ID && candidate.orderRole !== 'take-profit'
  )) {
    const asset = matrix?.assets?.find((candidate) => candidate.symbol === order.assetSymbol)
    const item = asset?.trends?.[order.timeframeId]
    const profile = item?.tradeProfile
    const stillValid = isPendingPriceActionOrderProfile(profile) &&
      priceActionSignalKey({ assetSymbol: order.assetSymbol, timeframeId: order.timeframeId, profile, settings }) === order.signalKey
    if (stillValid) continue
    const reason = profile?.zoneTouched
      ? 'cena už zónu zasáhla; čekající objednávka musí existovat před tímto dotekem'
      : profile?.zoneHit
      ? 'cena dotkla zóny dříve, než došla na připravený entry'
      : isPendingPriceActionOrderProfile(profile)
      ? 'nastavení páky se změnilo; objednávka se přepočítá'
      : 'setup se změnil nebo byl invalidován strukturou'
    if (dryRun) {
      outcomes.push({ order, action: 'would_cancel', reason })
      continue
    }
    try {
      await executor.cancelOrder(order.id)
      outcomes.push({ order, action: 'cancelled', reason })
    } catch (error) {
      outcomes.push({ order, action: 'cancel_failed', reason, error: error.message })
    }
  }
  return outcomes
}

export const readConfig = (env = process.env) => ({
  apiUrl: env.BOT_API_URL || '',
  apiKey: env.BOT_API_KEY || '',
  stateFile: env.BOT_STATE_FILE || '',
  runner: env.BOT_RUNNER || 'manual',
  leaseTtlMs: Number(env.BOT_LEASE_TTL_MS || 90_000),
  modeOverride: env.BOT_MODE || '',
  // A 400-day 1D structure needs the underlying hourly history. The former
  // 3600-hour default exposed only 150 daily candles and could not see the
  // preceding macro swing or a yearly high.
  candleLimit: Number(env.BOT_CANDLE_LIMIT || 10000),
  // Do not publish a partial hourly series as if it could support the 1D PA-1
  // window. Tests can set this to zero when deliberately using tiny fixtures.
  minCandleHistory: Number(env.BOT_MIN_CANDLE_HISTORY || MIN_PRICE_ACTION_HOURLY_CANDLES),
  twelveDataApiKey: env.TWELVE_DATA_API_KEY || '',
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
export const loadMarket = async ({ settings, candleLimit, minCandleHistory = 1, fetchImpl, now, client }) => {
  // LN Markets' own candles are only offered when there is a client to fetch
  // them with; in paper mode there is none, and listing the source anyway would
  // spend a guaranteed failure on every pass.
  const { source, candles, failures } = await fetchCandlesWithFallback({
    order: DEFAULT_SOURCE_ORDER,
    limit: candleLimit,
    minCandles: minCandleHistory,
    fetchImpl,
    client,
  })
  const closed = dropForming(candles, HOUR_MS, now)
  const ltf = aggregate(closed, settings.timeframes.ltfHours)
  const htf = aggregate(closed, settings.timeframes.htfHours)
  return { source, failures, hourly: closed, ltf, htf }
}

const candlesForStrategy = (market, strategy) => ({
  ltf: aggregate(market.hourly, strategy.timeframes.ltfHours),
  htf: aggregate(market.hourly, strategy.timeframes.htfHours),
})

const timestamp = (value) => {
  if (Number.isFinite(value)) return value
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

/**
 * Positions opened before the strategy cutover keep their original manager.
 * Their protective brackets remain exchange-side either way, but changing a
 * trailing rule halfway through a trade would change the trade after entry.
 */
export const strategyIdForPosition = (position, settings) => {
  if (position.strategyId) return position.strategyId
  const openedAt = timestamp(position.openedAt ?? position.createdAt)
  const activatedAt = timestamp(settings.strategyActivatedAt)
  if (openedAt !== null && activatedAt !== null && openedAt >= activatedAt) return settings.strategyId
  return LEGACY_PRICE_ACTION_ID
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
        await executor.closePosition(position.id, null, 'unprotected_position')
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
        await executor.closePosition(position.id, null, 'unprotected_position')
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
      } else if (command === 'run-backtests') {
        // The wrapper starts the research worker after this pass has safely
        // published and cleared the command queue.
        results.push({ ...entry, outcome: 'backtest_started' })
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

export const buildExecutor = ({ settings, state, config, logger, fetchImpl, fundingSettlements = [] }) => {
  const mode = config.modeOverride || settings.mode
  if (mode === 'paper') {
    return { mode, executor: createPaperExecutor({ store: state.paper, fundingSettlements }), client: null }
  }
  // A key anyone can read out of a public repository may guard a simulation. It
  // may not guard an account. This refuses here rather than relying on the
  // dashboard's confirmation dialog, because that dialog is on the far side of
  // whoever has the key.
  if (mode === 'mainnet' && isPublicKey(config.apiKey)) {
    logger.error(`Refusing mainnet: ${PUBLIC_KEY_REFUSAL}`)
    return {
      mode: 'paper',
      executor: createPaperExecutor({ store: state.paper, fundingSettlements }),
      client: null,
      refusal: PUBLIC_KEY_REFUSAL,
    }
  }

  const client = createLnMarketsClient({ network: mode, fetchImpl })
  if (!client.hasCredentials) {
    logger.warn(`Mode is ${mode} but LN Markets credentials are missing — degrading to paper so nothing trades blind`)
    return {
      mode: 'paper',
      executor: createPaperExecutor({ store: state.paper, fundingSettlements }),
      client: null,
    }
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
  loadFunding = fetchFundingSettlements,
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
  const activeStrategy = strategyConfig(settings.strategyId)

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

  let leaseAcquired = false
  try {
    const lease = await store.claimLease({
      owner: config.runner,
      ttlMs: config.leaseTtlMs,
      priceActionSchema: PRICE_ACTION_MATRIX_SCHEMA,
    })
    if (!lease?.granted) {
      run.action = 'skipped'
      run.reason = `another runner holds the lease (${lease?.owner ?? 'unknown'})`
      recordRun(state, { ...run, durationMs: Date.now() - startedAt })
      state.updatedAt = isoNow(now)
      const saved = await store.save(state, { localOnly: true })
      return { state, run, saved }
    }
    leaseAcquired = true

    const requestedMode = config.modeOverride || settings.mode
    let fundingSettlements = []
    if (requestedMode === 'paper' && settings.risk.market === 'futures') {
      const openTimes = (state.paper.trades ?? [])
        .filter((trade) => trade.status === 'running')
        .map((trade) => timestamp(trade.openedAt ?? trade.createdAt))
        .filter((value) => value !== null)
      const from = Math.min(state.paper.lastFundingAt ?? now, ...openTimes, now)
      const hours = Math.max(72, Math.ceil((now - from) / HOUR_MS) + 24)
      const fundingClient = createLnMarketsClient({
        network: resolveNetwork(config.marketNetwork),
        fetchImpl,
        key: '',
        secret: '',
        passphrase: '',
      })
      fundingSettlements = await loadFunding({ client: fundingClient, hours, logger })
      if (fundingSettlements.length === 0) {
        throw new Error('paper futures refused: funding history is unavailable')
      }
    }

    const { executor, mode, refusal } = makeExecutor({
      settings,
      state,
      config,
      logger,
      fetchImpl,
      fundingSettlements,
    })
    run.mode = mode
    state.mode = mode
    // Surfaced on the state so the dashboard can say why it is still on paper
    // after someone asked for mainnet, instead of looking like it ignored them.
    state.modeRefusal = refusal ?? null

    // Candles come from a client of their own, with no credentials attached.
    // `futures/candles` is a public route, so paper mode reads the same chart
    // the live mode does — which is the point: paper results are only worth
    // anything if they were decided from the same data.
    const market = await loadMarket({
      settings,
      candleLimit: config.candleLimit,
      minCandleHistory: config.minCandleHistory,
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

    let [account, trades] = await Promise.all([executor.getAccount(), executor.listTrades()])
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

    if (commandResults.length) {
      ;[account, trades] = await Promise.all([executor.getAccount(), executor.listTrades()])
      state.account = account
    }

    const bracketActions = await reconcileBrackets({
      executor,
      positions: trades.running,
      ltfCandles: market.ltf,
      logger,
      dryRun: config.dryRun,
    })

    const managed = []
    for (const position of trades.running) {
      const managingStrategy = strategyConfig(strategyIdForPosition(position, settings))
      const managingMarket = candlesForStrategy(market, managingStrategy)
      const decision = managingStrategy.module.manageOpen({
        position: { ...position, initialStop: position.initialStop ?? position.stopLoss },
        ltfCandles: managingMarket.ltf,
        htfCandles: managingMarket.htf,
        settings: managingStrategy.id === activeStrategy.id ? settings.strategy : managingStrategy.settings,
      })
      if (decision.action === 'hold') continue
      if (config.dryRun) {
        managed.push({ id: position.id, strategyId: managingStrategy.id, ...decision, applied: false })
        continue
      }
      try {
        if (decision.action === 'close') {
          await executor.closePosition(position.id, market.ltf.at(-1)?.close, 'strategy_exit')
        } else {
          const stop = roundStop(position.side, decision.stop)
          await executor.updateStops(position.id, { stopLoss: stop })
          position.stopLoss = stop
        }
        managed.push({ id: position.id, strategyId: managingStrategy.id, ...decision, applied: true })
      } catch (error) {
        managed.push({ id: position.id, strategyId: managingStrategy.id, ...decision, applied: false, error: error.message })
        logger.error(`Managing ${position.id} failed: ${error.message}`)
      }
    }

    const changed = managed.length > 0 || commandResults.length > 0
    let refreshed = changed ? await executor.listTrades() : trades
    let running = refreshed.running
    let closed = capClosed(refreshed.closed)

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

    let priceActionExecutions = []
    try {
      const previousPriceActionMatrix = state.priceActionMatrix
      state.priceActionMatrix = await buildPriceActionMatrix({
        btcHourly: market.hourly,
        previous: previousPriceActionMatrix,
        fetchImpl,
        now,
        settings: settings.priceActionStructure,
        twelveDataApiKey: config.twelveDataApiKey,
        externalTrendEnabled: true,
        logger,
      })
      state.priceActionMatrixError = null
      state.priceActionEntryCheck = {
        at: isoNow(now),
        matrixGeneratedAt: state.priceActionMatrix?.generatedAt ?? null,
        refreshed: state.priceActionMatrix !== previousPriceActionMatrix,
        refreshMinutes: state.settings.priceActionStructure?.refreshMinutes ?? 15,
        status: 'ok',
      }

      const targetBackfills = await reconcileMissingPriceActionTargets({
        executor,
        positions: running,
        matrix: state.priceActionMatrix,
        dryRun: config.dryRun,
      })
      for (const action of targetBackfills) {
        recordPriceActionEvent(state, {
          at: isoNow(now),
          type: action.action === 'backfilled'
            ? 'open_position_tp2_backfilled'
            : 'open_position_tp2_backfill_failed',
          positionId: action.position.id,
          asset: action.position.assetSymbol,
          timeframeId: action.position.timeframeId,
          side: action.position.side,
          tp1: action.position.tp1,
          tp2: action.tp2,
          reason: action.error ?? 'nalezená nevyplněná FVG zóna za TP1',
          fingerprint: [action.position.id, action.action, action.position.tp1, action.tp2].join('|'),
        })
      }
      if (targetBackfills.some((action) => action.action === 'backfilled')) {
        refreshed = await executor.listTrades()
        trades = refreshed
        running = refreshed.running
        closed = capClosed(refreshed.closed)
      }

      let pendingOrderActions = []
      if (!executor.live && typeof executor.markPriceActionOrders === 'function') {
        pendingOrderActions = executor.markPriceActionOrders(state.priceActionMatrix)
        for (const action of pendingOrderActions) {
          recordPriceActionEvent(state, {
            at: isoNow(now),
            type: action.action === 'filled' ? 'pending_order_filled' : 'pending_order_cancelled_on_fill',
            orderId: action.order.id,
            asset: action.order.assetSymbol,
            timeframeId: action.order.timeframeId,
            side: action.order.side,
            entry: action.order.entry,
            stop: action.order.stopLoss,
            tp1: action.order.tp1,
            tp2: action.order.tp2,
            reason: action.reason ?? null,
            fingerprint: [action.order.id, action.action, action.at].join('|'),
          })
        }
        if (pendingOrderActions.length) {
          refreshed = await executor.listTrades()
          trades = refreshed
          running = refreshed.running
          closed = capClosed(refreshed.closed)
          account = await executor.getAccount()
          state.account = account
        }
      }

      // PA positions use their own asset/timeframe candles. Never walk an FX
      // position through BTCUSD just because both share the paper account.
      if (!executor.live && typeof executor.markPriceActionPositions === 'function') {
        executor.markPriceActionPositions(state.priceActionMatrix)
        refreshed = await executor.listTrades()
        trades = refreshed
        running = refreshed.running
        closed = capClosed(refreshed.closed)
        account = await executor.getAccount()
        state.account = account
      }

      const invalidationActions = await reconcilePriceActionInvalidations({
        executor,
        positions: running,
        matrix: state.priceActionMatrix,
        settings: settings.priceActionStructure,
        dryRun: config.dryRun,
      })
      for (const action of invalidationActions) {
        const { position, review, legacy, reason, exitPrice } = action
        const fingerprint = [
          position.id,
          position.side,
          review.symbol,
          review.timeframeId,
          review.item?.trend,
          review.item?.event,
          review.lowerItem?.trend,
          review.lowerItem?.event,
          action.action,
          exitPrice,
        ].join('|')
        if (action.action === 'close_failed') {
          recordPriceActionEvent(state, {
            at: isoNow(now),
            type: 'open_position_invalidation_close_failed',
            positionId: position.id,
            asset: review.symbol,
            timeframeId: review.timeframeId,
            side: position.side,
            reason,
            fingerprint,
          })
          continue
        }
        recordPriceActionEvent(state, {
          at: isoNow(now),
          type: action.action === 'would_close' ? 'open_position_invalidation_pending' : 'open_position_closed_on_invalidation',
          positionId: position.id,
          asset: review.symbol,
          timeframeId: review.timeframeId,
          invalidatingTimeframeId: review.invalidatingTimeframeId,
          side: position.side,
          currentTrend: review.item?.trend ?? null,
          lowerTrend: review.lowerItem?.trend ?? null,
          closeTrigger: review.closeTrigger,
          exitPrice,
          legacy,
          reason,
          currentProfile: review.currentProfile,
          revisedProfile: review.revisedProfile,
          fingerprint,
        })
      }

      if (invalidationActions.some((action) => action.action === 'closed')) {
        refreshed = await executor.listTrades()
        trades = refreshed
        running = refreshed.running
        closed = capClosed(refreshed.closed)
        account = await executor.getAccount()
        state.account = account
      }

      if (mode === 'paper') {
        const pendingCancellations = await reconcilePendingPriceActionOrders({
          executor,
          orders: refreshed.open ?? [],
          matrix: state.priceActionMatrix,
          settings,
          dryRun: config.dryRun,
        })
        for (const action of pendingCancellations) {
          recordPriceActionEvent(state, {
            at: isoNow(now),
            type: action.action === 'cancelled' ? 'pending_order_cancelled' : 'pending_order_cancellation_pending',
            orderId: action.order.id,
            asset: action.order.assetSymbol,
            timeframeId: action.order.timeframeId,
            side: action.order.side,
            reason: action.reason,
            fingerprint: [action.order.id, action.action, action.reason].join('|'),
          })
        }
        if (pendingCancellations.some((action) => action.action === 'cancelled')) {
          refreshed = await executor.listTrades()
          trades = refreshed
          running = refreshed.running
          closed = capClosed(refreshed.closed)
        }

        const pendingPlacements = await placePendingPriceActionOrders({
          executor,
          matrix: state.priceActionMatrix,
          trades: [...running, ...(refreshed.open ?? []), ...closed],
          equitySats: account.equitySats,
          btcPrice: price,
          settings,
          dryRun: config.dryRun,
        })
        for (const action of pendingPlacements.filter((candidate) => candidate.action === 'placed')) {
          recordPriceActionEvent(state, {
            at: isoNow(now),
            type: 'pending_order_placed',
            orderId: action.order.id,
            asset: action.assetSymbol,
            timeframeId: action.timeframeId,
            side: action.order.side,
            entry: action.order.entry,
            stop: action.order.stopLoss ?? action.order.stop,
            tp1: action.order.tp1,
            tp2: action.order.tp2,
            fingerprint: [action.order.id, 'placed'].join('|'),
          })
        }

        const readyExecutions = await executeReadyPriceActionProfiles({
          executor,
          matrix: state.priceActionMatrix,
          trades: [...running, ...(refreshed.open ?? []), ...closed],
          equitySats: account.equitySats,
          btcPrice: price,
          settings,
          dryRun: config.dryRun,
        })
        priceActionExecutions = [...pendingOrderActions, ...pendingCancellations, ...pendingPlacements, ...readyExecutions]
        if (priceActionExecutions.some((outcome) => ['filled', 'placed', 'opened', 'cancelled'].includes(outcome.action))) {
          refreshed = await executor.listTrades()
          trades = refreshed
          running = refreshed.running
          closed = capClosed(refreshed.closed)
          account = await executor.getAccount()
          state.account = account
        }
      }
    } catch (error) {
      state.priceActionMatrixError = error.message
      state.priceActionEntryCheck = {
        at: isoNow(now),
        matrixGeneratedAt: state.priceActionMatrix?.generatedAt ?? null,
        refreshed: false,
        refreshMinutes: state.settings.priceActionStructure?.refreshMinutes ?? 15,
        status: 'error',
        error: error.message,
      }
      logger.warn(`Price action matrix failed: ${error.message}`)
      }
    let decision = activeStrategy.module.evaluateEntry({
      htfCandles: market.htf,
      ltfCandles: market.ltf,
      settings: settings.strategy,
    })

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
      const entry = roundPrice(decision.entry)
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
      } else {
        const minRR = Number(settings.strategy.minRR)
        if (Number.isFinite(minRR) && plan.rr < minRR) {
          gates.push(`reward/risk fell to ${plan.rr.toFixed(2)} after rounding`)
        }
      }
    }

    if (decision.action === 'open' && gates.length === 0 && plan?.ok) {
      if (config.dryRun) {
        run.action = 'would_open'
        run.reason = decision.reason
      } else {
        const opened = await executor.openPosition({ ...plan, side: decision.side })
        opened.initialStop = plan.stop
        opened.strategyId = activeStrategy.id
        opened.plan = { reason: decision.reason, rr: plan.rr, riskSats: plan.riskSats }
        running.push(opened)
        run.action = 'opened'
        run.reason = `${decision.side} ${plan.quantityUsd} USD @ ${plan.entry} — ${decision.reason}`
        logger.info(`Opened ${run.reason}`)
      }
    } else {
      const paOpened = priceActionExecutions.filter((outcome) => ['opened', 'filled'].includes(outcome.action))
      const paRejected = priceActionExecutions.filter((outcome) => outcome.action === 'rejected')
      if (paOpened.length) {
        run.action = 'opened'
        run.reason = paOpened.map((outcome) => `${outcome.assetSymbol ?? outcome.order?.assetSymbol} ${(outcome.timeframeId ?? outcome.order?.timeframeId)?.toUpperCase() ?? ''}`).join(', ')
      } else {
        const paPlaced = priceActionExecutions.filter((outcome) => outcome.action === 'placed')
        const paCancelled = priceActionExecutions.filter((outcome) => outcome.action === 'cancelled')
        run.action = managed.length || bracketActions.length || commandResults.length || paPlaced.length || paCancelled.length ? 'managed' : 'none'
        run.reason = paRejected.length
          ? paRejected.map((outcome) => `${outcome.assetSymbol} ${outcome.timeframeId.toUpperCase()}: ${outcome.reason}`).join('; ')
          : paPlaced.length
            ? paPlaced.map((outcome) => `čekající ${outcome.assetSymbol} ${outcome.timeframeId.toUpperCase()}`).join(', ')
            : paCancelled.length
              ? paCancelled.map((outcome) => `zrušena ${outcome.order.assetSymbol} ${outcome.order.timeframeId.toUpperCase()}`).join(', ')
              : gates.length ? gates.join('; ') : decision.reason
      }
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
      strategyId: activeStrategy.id,
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
    run.priceActionExecutions = priceActionExecutions
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
  // A runner that could not even acquire a lease may keep a local diagnostic,
  // but it must never publish over the runner that owns the current state.
  const saved = await store.save(state, { localOnly: !leaseAcquired })
  if (saved.error) logger.warn(`State was not published to hosting: ${saved.error}`)

  return { state, run, saved }
}
