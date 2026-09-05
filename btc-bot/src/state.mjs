// The published state: the single document the dashboard reads and the only
// memory the bot keeps between passes.
//
// It is a plain JSON file rather than a database because every consumer is a
// reader — the browser, the run log, a diagnosis script — and one file that can
// be curl'd is easier to debug at 2am than a schema. Every list is capped so
// the file cannot grow without bound on a shared hosting.

import { DEFAULT_MANAGEMENT, DEFAULT_STRATEGY } from './strategy.mjs'
import { DEFAULT_RISK_SETTINGS } from './risk.mjs'

export const STATE_VERSION = 1
export const MAX_RUNS = 200
export const MAX_EQUITY_POINTS = 2000
export const MAX_CLOSED_TRADES = 500

export const DEFAULT_SETTINGS = {
  // The master switch. `false` stops new entries; open positions keep their
  // exchange-side stop and take profit, and are still managed and closed.
  enabled: true,
  // 'paper' | 'testnet4' | 'mainnet'.
  //
  // Defaults to paper, and not out of caution alone: LN Markets' public test
  // networks are gone. Both api.testnet.lnmarkets.com and
  // api.testnet4.lnmarkets.com fail DNS from a clean runner, so "start on
  // testnet" is not currently an option, and the honest fallback is a mode that
  // cannot spend anything. Moving to 'mainnet' is a deliberate, separate act
  // and the dashboard asks twice.
  mode: 'paper',
  portfolioName: 'BTC Price Action Swing',
  startingCapitalUsd: 100,
  maxOpenPositions: 1,
  maxTradesPerDay: 3,
  cooldownMinutesAfterLoss: 240,
  timeframes: { htfHours: 4, ltfHours: 1 },
  risk: { ...DEFAULT_RISK_SETTINGS },
  strategy: { ...DEFAULT_STRATEGY, ...DEFAULT_MANAGEMENT },
}

export const emptyState = (overrides = {}) => ({
  version: STATE_VERSION,
  updatedAt: null,
  status: 'starting',
  mode: DEFAULT_SETTINGS.mode,
  settings: structuredClone(DEFAULT_SETTINGS),
  account: { balanceSats: 0, marginUsedSats: 0, equitySats: 0, source: null },
  market: { price: null, bias: null, atrPct: null, candleSource: null, asOf: null },
  positions: { running: [], orders: [], closed: [] },
  lastDecision: null,
  heartbeats: {},
  runs: [],
  equityHistory: [],
  stats: emptyStats(),
  paper: { balanceSats: 0, trades: [], nextId: 1 },
  ...overrides,
})

export function emptyStats() {
  return {
    trades: 0,
    wins: 0,
    losses: 0,
    winRate: null,
    netPnlSats: 0,
    grossWinSats: 0,
    grossLossSats: 0,
    profitFactor: null,
    averageWinSats: null,
    averageLossSats: null,
    maxDrawdownPct: null,
  }
}

/**
 * Statistics over closed trades.
 *
 * Profit factor is null rather than Infinity when nothing has lost yet: a
 * dashboard that prints "∞" after two winning trades is telling the reader
 * something untrue about a sample of two.
 */
export const computeStats = (closedTrades, { startEquitySats = null } = {}) => {
  const trades = closedTrades.filter((trade) => Number.isFinite(trade.plSats))
  if (trades.length === 0) return emptyStats()

  const wins = trades.filter((trade) => trade.plSats > 0)
  const losses = trades.filter((trade) => trade.plSats < 0)
  const grossWinSats = wins.reduce((sum, trade) => sum + trade.plSats, 0)
  const grossLossSats = Math.abs(losses.reduce((sum, trade) => sum + trade.plSats, 0))

  // Drawdown is a property of the ACCOUNT, so it is measured from the starting
  // equity. Measuring the cumulative P/L curve from zero instead reports a 96%
  // drawdown for an account that won 8k sats and then gave back 7.7k — true of
  // the P/L series, wildly untrue of the balance, and alarming for no reason.
  const ordered = [...trades].sort((a, b) => (a.closedAt ?? 0) - (b.closedAt ?? 0))
  const base = startEquitySats && startEquitySats > 0 ? startEquitySats : null
  let equity = base ?? 0
  let peak = equity
  let maxDrawdown = 0
  for (const trade of ordered) {
    equity += trade.plSats
    peak = Math.max(peak, equity)
    if (peak > 0) maxDrawdown = Math.max(maxDrawdown, (peak - equity) / peak)
  }

  return {
    trades: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRate: (wins.length / trades.length) * 100,
    netPnlSats: grossWinSats - grossLossSats,
    grossWinSats,
    grossLossSats,
    profitFactor: grossLossSats > 0 ? grossWinSats / grossLossSats : null,
    averageWinSats: wins.length ? grossWinSats / wins.length : null,
    averageLossSats: losses.length ? grossLossSats / losses.length : null,
    // Without a starting equity the figure would describe the P/L curve rather
    // than the account, which is worse than saying nothing.
    maxDrawdownPct: base && peak > 0 ? maxDrawdown * 100 : null,
  }
}

export const recordRun = (state, run) => {
  state.runs = [{ ...run }, ...(state.runs ?? [])].slice(0, MAX_RUNS)
  return state
}

// Every 15 minutes rather than every hour. The bot passes once a minute, so an
// hourly point meant a chart with two points after two hours of running — which
// renders as an empty box and reads as "nothing is happening". At 15 minutes the
// 2000-point cap still holds three weeks.
export const EQUITY_SAMPLE_MS = 15 * 60_000

export const recordEquity = (state, equitySats, at) => {
  const points = state.equityHistory ?? []
  const previous = points.at(-1)
  if (previous && previous.equitySats === equitySats && at - previous.at < EQUITY_SAMPLE_MS) return state
  state.equityHistory = [...points, { at, equitySats }].slice(-MAX_EQUITY_POINTS)
  return state
}

/** Merge stored settings over the defaults so a new setting gains its default. */
export const mergeSettings = (stored = {}) => ({
  ...DEFAULT_SETTINGS,
  ...stored,
  timeframes: { ...DEFAULT_SETTINGS.timeframes, ...(stored.timeframes ?? {}) },
  risk: { ...DEFAULT_SETTINGS.risk, ...(stored.risk ?? {}) },
  strategy: { ...DEFAULT_SETTINGS.strategy, ...(stored.strategy ?? {}) },
})

export const tradesToday = (closedTrades, runningTrades, nowMs) => {
  const startOfDay = new Date(nowMs)
  startOfDay.setUTCHours(0, 0, 0, 0)
  const cutoff = startOfDay.getTime()
  const opened = (trade) => trade.openedAt ?? trade.createdAt ?? 0
  return [...closedTrades, ...runningTrades].filter((trade) => opened(trade) >= cutoff).length
}

export const lastLossAt = (closedTrades) =>
  closedTrades
    .filter((trade) => trade.plSats < 0 && Number.isFinite(trade.closedAt))
    .reduce((latest, trade) => Math.max(latest, trade.closedAt), 0) || null

export const capClosed = (closedTrades) =>
  [...closedTrades].sort((a, b) => (b.closedAt ?? 0) - (a.closedAt ?? 0)).slice(0, MAX_CLOSED_TRADES)
