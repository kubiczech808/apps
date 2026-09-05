// Carry — the cost of holding a perpetual position.
//
// This is the fee that decides whether a slow strategy is viable at all, and it
// is the one most backtests leave out. A trade held three weeks crosses about
// sixty-three funding settlements; at 0.01% each that is 0.63% of notional,
// which on a 1%-risk position sized at several times equity is not a rounding
// error. Leaving it out makes every long-hold strategy look better than it is,
// and the slower the strategy the bigger the lie.
//
// LN Markets publishes its settlement history openly, so this charges what a
// position would actually have paid rather than a constant someone guessed.
//
// Sign convention: a positive funding rate is paid BY longs TO shorts. So a
// long pays and a short receives, and `carryForSettlement` returns a positive
// number for a cost and a negative one for a credit.

import { SATS_PER_BTC } from './risk.mjs'

/** One settlement's cost, in sats, for one position. */
export const carryForSettlement = ({ side, quantityUsd, settlement, fallbackPrice }) => {
  const price = settlement.fixingPrice || fallbackPrice
  if (!(price > 0) || !(quantityUsd > 0)) return 0
  const notionalSats = (quantityUsd * SATS_PER_BTC) / price
  const cost = notionalSats * settlement.fundingRate
  return side === 'long' ? cost : -cost
}

const byTimeAscending = (a, b) => a.time - b.time

const num = (value) => {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

/**
 * Fetch settlement history, paging back as far as asked.
 *
 * Mirrors the candle fetcher: newest first from the API, sorted ascending here,
 * de-duplicated by time, and a refused page keeps what was already collected
 * rather than losing the lot — with a warning, because a backtest that quietly
 * charged carry for one month of a nine-month window is worse than one that
 * charged none and said so.
 */
export const fetchFundingSettlements = async ({
  client,
  hours = 6000,
  limit = 1000,
  maxPages = 20,
  pauseMs = 250,
  logger = console,
}) => {
  const to = Date.now()
  const from = to - hours * 3600_000
  const collected = new Map()

  const parse = (payload) => {
    const rows = Array.isArray(payload) ? payload : (payload?.data ?? [])
    for (const row of rows) {
      const time = typeof row.time === 'number' ? row.time : Date.parse(row.time)
      const fundingRate = num(row.fundingRate)
      if (!Number.isFinite(time) || fundingRate === null) continue
      collected.set(time, { time, fundingRate, fixingPrice: num(row.fixingPrice) ?? 0 })
    }
    return payload?.nextCursor ?? null
  }

  const page = (cursor) =>
    client.getFundingSettlements({
      from: new Date(from).toISOString(),
      to: new Date(to).toISOString(),
      limit: Math.min(limit, 1000),
      ...(cursor ? { cursor } : {}),
    })

  let cursor = parse(await page(undefined))
  for (let pageNumber = 1; cursor && pageNumber < maxPages; pageNumber += 1) {
    if (pauseMs > 0) await new Promise((resolve) => setTimeout(resolve, pauseMs))
    let next
    try {
      next = parse(await page(cursor))
    } catch (error) {
      logger.warn(
        `Funding history stopped at page ${pageNumber + 1} with ${collected.size} settlements: ${error.message}`
      )
      break
    }
    if (next === cursor) break
    cursor = next
  }

  return [...collected.values()].sort(byTimeAscending)
}

/** What the collected history says, for a log line that can be checked. */
export const describeFunding = (settlements) => {
  if (settlements.length === 0) return 'no funding history'
  const rates = settlements.map((entry) => entry.fundingRate)
  const mean = rates.reduce((sum, rate) => sum + rate, 0) / rates.length
  const positive = rates.filter((rate) => rate > 0).length
  const perDay = mean * 3 // settlements are 8-hourly
  return [
    `${settlements.length} settlements`,
    `${new Date(settlements[0].time).toISOString().slice(0, 10)} → ${new Date(settlements.at(-1).time).toISOString().slice(0, 10)}`,
    `mean ${(mean * 100).toFixed(4)}% per settlement`,
    `${(perDay * 365 * 100).toFixed(1)}% annualised for a long`,
    `${((positive / rates.length) * 100).toFixed(0)}% of settlements positive`,
  ].join(', ')
}
